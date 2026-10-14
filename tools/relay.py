#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
山东联通单播 · 本地中转（NAT 穿透）

问题：单播是 RTSP + RTP over UDP。服务器把 RTP 发到它看到的公网 IP:client_port，
     而 PC 在路由器 NAT 后面、且本机防火墙只放行"已出站过"的回程 → RTP 一个包都收不到
     （现象：DESCRIBE/SETUP/PLAY 全 200 OK，VLC 就是不出画面）。
做法：本机按需反向打洞（先往服务器的 RTP 端口发一个 UDP 包建立 NAT/防火墙映射，
     已验证可立即收到 1300+ 字节/包的 MP2T 流），再把 RTP 剥头转成 HTTP MPEG-TS 吐给播放器。

用法：
    python relay.py                                  # 订阅 gitiptv.iizc.de/merge.m3u
    python relay.py --list <url-or-file>             # 自定义列表
    python relay.py --port 8899 --bind 0.0.0.0
然后播放器/酷九填：  http://<本机IP>:8899/list.m3u
"""
import argparse
import re
import socket
import sys
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

UA = "VLC/3.0.20 LibVLC/3.0.20"
DEFAULT_LIST = "https://gitiptv.iizc.de/merge.m3u"
RAW_PROXIES = ["https://gh-proxy.com/", "https://gh-proxy.org/"]
RTP_TIMEOUT = 12.0
STATS = {"sessions": 0, "bytes": 0, "errors": 0}


# ------------------------------------------------------------------ RTSP 客户端
def recv_rtsp(sock, timeout=10):
    sock.settimeout(timeout)
    buf = b""
    while b"\r\n\r\n" not in buf:
        try:
            c = sock.recv(4096)
        except (socket.timeout, TimeoutError):
            break
        if not c:
            break
        buf += c
    head, _, rest = buf.partition(b"\r\n\r\n")
    m = re.search(rb"Content-Length:\s*(\d+)", head, re.I)
    n = int(m.group(1)) if m else 0
    body = rest
    while len(body) < n:
        try:
            c = sock.recv(65536)
        except (socket.timeout, TimeoutError):
            break
        if not c:
            break
        body += c
    return head.decode("utf-8", "replace"), body[:n]


def rtsp_do(sock, method, url, cseq, extra=""):
    sock.sendall(("%s %s RTSP/1.0\r\nCSeq: %d\r\nUser-Agent: %s\r\n%s\r\n"
                  % (method, url, cseq, UA, extra)).encode())
    return recv_rtsp(sock)


def hdr(head, name):
    m = re.search(r"^%s:\s*(.*)$" % re.escape(name), head, re.I | re.M)
    return m.group(1).strip() if m else ""


def strip_rtp(pkt):
    """剥掉 RTP 头，返回 MPEG-TS 负载（可能是多个 188 字节 TS 包）"""
    if len(pkt) < 12 or (pkt[0] >> 6) != 2:
        return b""
    cc = pkt[0] & 0x0F
    ext = (pkt[0] >> 4) & 1
    pad = (pkt[0] >> 5) & 1
    off = 12 + 4 * cc
    if ext:
        if len(pkt) < off + 4:
            return b""
        elen = int.from_bytes(pkt[off + 2:off + 4], "big")
        off += 4 + 4 * elen
    if off >= len(pkt):
        return b""
    payload = pkt[off:]
    if pad and payload:
        payload = payload[:-payload[-1]] if payload[-1] else payload
    return payload


class RtspPull:
    """一次单播会话：建流 + 打洞 + 持续产出 TS 字节"""

    def __init__(self, url):
        self.url = url
        self.sock = None
        self.udp = None
        self.session = ""
        self.src = None
        self.server_port = None
        self.pkts = 0

    def open(self):
        m = re.match(r"rtsp://([^/:]+)(?::(\d+))?(/.*)?$", self.url)
        if not m:
            raise RuntimeError("非法 RTSP 地址: %s" % self.url)
        ip, port, path = m.group(1), int(m.group(2) or 554), m.group(3) or "/"

        self.udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.udp.bind(("0.0.0.0", 0))
        cport = self.udp.getsockname()[1]

        self.sock = socket.create_connection((ip, port), timeout=10)
        h, _ = rtsp_do(self.sock, "DESCRIBE", self.url, 1, "Accept: application/sdp\r\n")
        if "200" not in h.split("\r\n")[0]:
            raise RuntimeError("DESCRIBE 失败: %s" % h.split("\r\n")[0])

        h, _ = rtsp_do(self.sock, "SETUP", self.url, 2,
                       "Transport: RTP/AVP;unicast;client_port=%d-%d\r\n" % (cport, cport + 1))
        line = h.split("\r\n")[0]
        if "200" not in line:
            raise RuntimeError("SETUP 失败: %s（401 多为平台鉴权/白名单，本机网络段无权限）" % line)
        tr = hdr(h, "Transport")
        self.session = hdr(h, "Session").split(";")[0]
        ms = re.search(r"source=([\d.]+)", tr)
        mp = re.search(r"server_port=(\d+)", tr)
        self.src = ms.group(1) if ms else ip
        self.server_port = int(mp.group(1)) if mp else 0

        h, _ = rtsp_do(self.sock, "PLAY", self.url, 3,
                       "Range: npt=0.000-\r\nSession: %s\r\n" % self.session)
        if "200" not in h.split("\r\n")[0]:
            raise RuntimeError("PLAY 失败: %s" % h.split("\r\n")[0])

        self.udp.settimeout(RTP_TIMEOUT)
        return self

    def punch(self):
        """反向打洞：建立 NAT/防火墙的 UDP 回程映射（关键一步）"""
        if not self.server_port:
            return 0
        sent = 0
        for _ in range(5):
            try:
                self.udp.sendto(b"\x00\x00\x00\x00", (self.src, self.server_port))
                sent += 1
            except OSError:
                break
            time.sleep(0.15)
        return sent

    def packets(self):
        """生成 TS 数据块；连续 RTP_TIMEOUT 秒无包则结束"""
        idle = 0
        while idle < RTP_TIMEOUT:
            try:
                pkt, _ = self.udp.recvfrom(4096)
            except (socket.timeout, TimeoutError):
                if self.pkts == 0:      # 还没收到过任何包 → 再打一次洞
                    self.punch()
                    idle += 3
                else:
                    idle += 3
                continue
            idle = 0
            self.pkts += 1
            ts = strip_rtp(pkt)
            if ts:
                yield ts

    def close(self):
        try:
            if self.sock and self.session:
                rtsp_do(self.sock, "TEARDOWN", self.url, 9,
                        "Session: %s\r\n" % self.session)
        except Exception:
            pass
        for s in (self.sock, self.udp):
            try:
                s and s.close()
            except Exception:
                pass


# ------------------------------------------------------------------ m3u 处理
def fetch_text(src):
    if re.match(r"^https?://", src):
        last = None
        for u in [src] + [p + src for p in RAW_PROXIES]:
            try:
                req = urllib.request.Request(u, headers={"User-Agent": UA})
                with urllib.request.urlopen(req, timeout=30) as r:
                    return r.read().decode("utf-8", "replace")
            except Exception as e:
                last = e
        raise RuntimeError("列表拉取失败: %s" % last)
    with open(src, encoding="utf-8") as fh:
        return fh.read()


def rewrite_list(text, base):
    out, n = [], 0
    for line in text.splitlines():
        s = line.strip()
        if s and not s.startswith("#"):
            out.append("%s/ts?u=%s" % (base, urllib.parse.quote(s, safe="")))
            n += 1
        elif s.startswith("#EXTINF"):
            out.append(re.sub(r'\s*catchup(-source)?="[^"]*"', "", line))
        elif s.startswith("#EXTM3U"):
            out.append(line)
        elif s.startswith("#"):
            continue
    return "\n".join(out) + "\n", n


# ------------------------------------------------------------------ HTTP 服务
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "sd-iptv-relay"
    list_src = DEFAULT_LIST

    def log_message(self, fmt, *args):
        sys.stderr.write("[relay] %s - %s\n" % (self.address_string(), fmt % args))

    def _text(self, code, body, ctype="text/plain; charset=utf-8"):
        data = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        u = urllib.parse.urlsplit(self.path)
        if u.path in ("/", "/index.html"):
            return self._text(200, self.status_page(), "text/html; charset=utf-8")
        if u.path == "/health":
            return self._text(200, "ok")
        if u.path in ("/list.m3u", "/ku9.m3u", "/merge.m3u"):
            base = "http://%s" % (self.headers.get("Host") or "%s:%d" % self.server.server_address)
            try:
                text = fetch_text(self.list_src)
            except Exception as e:
                return self._text(502, "列表拉取失败: %s\n" % e)
            body, n = rewrite_list(text, base)
            self.log_message("生成播放列表 %d 条 -> %s", n, self.list_src)
            return self._text(200, body, "audio/x-mpegurl; charset=utf-8")
        if u.path == "/ts":
            q = urllib.parse.parse_qs(u.query)
            target = (q.get("u") or [""])[0]
            if not target:
                return self._text(400, "缺少参数 u=\n")
            return self.stream(target)
        return self._text(404, "可访问: / /list.m3u /ts?u=<rtsp地址> /health\n")

    def status_page(self):
        return ("<meta charset=utf-8><body style='font:14px sans-serif;padding:20px'>"
                "<h2>山东联通单播 · 本地中转</h2>"
                "<p>播放器订阅地址：<code>http://%s/list.m3u</code></p>"
                "<p>列表来源：%s</p>"
                "<p>会话 %d · 已转发 %.1f MB · 错误 %d</p>"
                "<p>打不开的频道：多为 plsy1 那批 112.245.125.x / 222.132.188.x，"
                "平台在 SETUP 阶段返回 401，需要机顶盒鉴权或 IPTV 专网。</p></body>"
                % (self.headers.get("Host") or "", self.list_src,
                   STATS["sessions"], STATS["bytes"] / 1048576.0, STATS["errors"]))

    def stream(self, url):
        try:
            pull = RtspPull(url).open()
        except Exception as e:
            STATS["errors"] += 1
            self.log_message("打开失败 %s -> %s", url[:70], e)
            return self._text(502, "打开失败: %s\n" % e)
        sent = pull.punch()
        self.log_message("会话建立 %s | client_port=%d | 打洞发包 %d | 服务器 RTP %s:%s",
                         url[-40:], pull.udp.getsockname()[1], sent, pull.src, pull.server_port)
        STATS["sessions"] += 1
        self.send_response(200)
        self.send_header("Content-Type", "video/mp2t")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        try:
            for ts in pull.packets():
                self.wfile.write(b"%X\r\n" % len(ts) + ts + b"\r\n")
                STATS["bytes"] += len(ts)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            self.log_message("播放端断开")
        except Exception as e:
            self.log_message("转发中断: %r", e)
        finally:
            pull.close()
            self.log_message("会话结束，收到 RTP %d 包", pull.pkts)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", default=DEFAULT_LIST, help="播放列表来源（URL 或本地文件）")
    ap.add_argument("--port", type=int, default=8899)
    ap.add_argument("--bind", default="0.0.0.0")
    a = ap.parse_args()
    Handler.list_src = a.list
    srv = ThreadingHTTPServer((a.bind, a.port), Handler)
    srv.daemon_threads = True
    print("[relay] listening on http://%s:%d/  list=%s" % (a.bind, a.port, a.list))
    print("[relay] 播放器订阅:  http://<本机IP>:%d/list.m3u" % a.port)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n[relay] bye")


if __name__ == "__main__":
    main()
