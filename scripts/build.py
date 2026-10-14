#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
山东联通单播 IPTV 聚合构建脚本（仅标准库，可在 GitHub Actions / 本机运行）

上游:
  A  plsy1/iptv        unicast/unicast-ku9.m3u      (酷九版，带 catchup + logo)
  B  sggc/SDU-IPTV-PRO SDU-Unicast.m3u              (联通单播通用版，独立服务器)

输出 dist/:
  ku9.m3u     A 原味（仅重写 logo / EPG 地址）
  sdu.m3u     B 原味
  merge.m3u   A 为主 + B 作为同频道备用线路，另附 B 独有频道
  meta.json   构建元信息（时间、条目数、上游地址、sha256）
"""
import hashlib
import json
import os
import re
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone

BASE_URL = (os.environ.get("BASE_URL") or "").strip().rstrip("/")
EPG_UPSTREAM = os.environ.get("EPG_URL") or "https://raw.githubusercontent.com/plsy1/epg/main/e/seven-days.xml.gz"
FOOTER = os.environ.get("SOURCE_NOTE", "山东联通单播聚合（plsy1/iptv + sggc/SDU-IPTV-PRO）")
UA = "Mozilla/5.0 (compatible; sd-iptv-builder/1.0; +https://github.com)"
CST = timezone(timedelta(hours=8))
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "dist")

# ---------------------------------------------------------------- 上游定义
SOURCES = [
    {
        "id": "ku9",
        "label": "plsy1/iptv · 酷九版",
        "path": "plsy1/iptv/main/unicast/unicast-ku9.m3u",
        "out": "ku9.m3u",
        "page": "https://github.com/plsy1/iptv",
    },
    {
        "id": "sdu",
        "label": "SDU-IPTV-PRO · 联通单播通用",
        "path": "sggc/SDU-IPTV-PRO/main/SDU-Unicast.m3u",
        "out": "sdu.m3u",
        "page": "https://github.com/sggc/SDU-IPTV-PRO",
    },
]

# ---------------------------------------------------------------- 抓取
def mirrors(path):
    owner, repo, branch, rest = path.split("/", 3)
    raw = "https://raw.githubusercontent.com/" + path
    return [
        raw,
        "https://gh-proxy.com/" + raw,
        "https://gh-proxy.org/" + raw,
        "https://ghfast.top/" + raw,
        "https://fastly.jsdelivr.net/gh/%s/%s@%s/%s" % (owner, repo, branch, rest),
        "https://cdn.jsdelivr.net/gh/%s/%s@%s/%s" % (owner, repo, branch, rest),
    ]


def fetch(path, tries=3, timeout=45):
    """多镜像 + 重试抓取，返回 (bytes, 实际地址)"""
    last = ""
    for _ in range(tries):
        for url in mirrors(path):
            try:
                req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    data = resp.read()
                if data and len(data) > 200:
                    return data, url
                last = url + ": 内容为空"
            except Exception as exc:  # noqa: BLE001
                last = "%s: %s %s" % (url, type(exc).__name__, exc)
            time.sleep(0.4)
    raise RuntimeError("拉取失败 %s\n最后错误: %s" % (path, last))


# ---------------------------------------------------------------- 解析
def attr(info, name, default=""):
    m = re.search(r'%s="([^"]*)"' % re.escape(name), info)
    return m.group(1) if m else default


def split_display(info):
    """按最后一个引号外的逗号切出显示名"""
    idx, quote = -1, False
    for i, ch in enumerate(info):
        if ch == '"':
            quote = not quote
        elif ch == "," and not quote:
            idx = i
    if idx < 0:
        return info, ""
    return info[:idx], info[idx + 1:].strip()


def parse_playlist(text):
    entries = []
    lines = text.replace("\r\n", "\n").split("\n")
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        if line.upper().startswith("#EXTINF"):
            urls = []
            j = i + 1
            while j < len(lines):
                s = lines[j].strip()
                if s == "" or s.startswith("#"):
                    break
                urls.append(s)
                j += 1
            entries.append({"info": line, "urls": urls})
            i = j
            continue
        i += 1
    return entries


def entry_key(entry):
    return attr(entry["info"], "tvg-name") or split_display(entry["info"])[1]


def rewrite_assets(info):
    """把 logo 与 EPG 换成本域名的地址，保证国内一条域名全通"""
    if not BASE_URL:
        return info

    def _logo(m):
        return 'tvg-logo="%s/logo/%s"' % (BASE_URL, m.group(1).rsplit("/", 1)[-1])

    return re.sub(r'tvg-logo="([^"]*)"', _logo, info)


# ---------------------------------------------------------------- 合并
def mark_backup(entry, tag="备用"):
    info, name = split_display(entry["info"])
    group = attr(entry["info"], "group-title") or "其他"
    info = re.sub(r'group-title="[^"]*"', 'group-title="%s·%s"' % (group, tag), info)
    if 'group-title="' not in info:
        info = info.rstrip() + ' group-title="%s·%s"' % (group, tag)
    name = "%s(%s)" % (name, tag) if name else name
    return {"info": "%s,%s" % (info.rstrip(), name), "urls": entry["urls"]}


def merge(a_entries, b_entries):
    idx_b = {}
    for e in b_entries:
        idx_b.setdefault(entry_key(e), []).append(e)

    out, seen = [], set()
    for e in a_entries:
        key = entry_key(e)
        if (key, tuple(e["urls"])) in seen:
            continue
        seen.add((key, tuple(e["urls"])))
        out.append(e)
        a_urls = set(e["urls"])
        for e2 in idx_b.get(key, []):
            if set(e2["urls"]) & a_urls:
                continue
            out.append(mark_backup(e2))
    for e in b_entries:  # B 独有频道
        key = entry_key(e)
        if key in idx_b and any(entry_key(x) == key for x in a_entries):
            continue
        if (key, tuple(e["urls"])) in seen:
            continue
        seen.add((key, tuple(e["urls"])))
        out.append(e)
    return out


# ---------------------------------------------------------------- 渲染
def render(entries, url_tvg, stamp):
    lines = ['#EXTM3U url-tvg="%s"' % url_tvg]
    lines.append("# ============================================================")
    lines.append("# %s" % FOOTER)
    lines.append("# 内容更新于: %s (北京时间)  条目数: %d" % (stamp, len(entries)))
    lines.append("# 上游: plsy1/iptv · sggc/SDU-IPTV-PRO （本项目仅做聚合与转发）")
    lines.append("# 单播为 RTP/RTSP over UDP，需山东联通宽带公网 IPv4 + PPPoE，或 IPTV 接口")
    lines.append("# ============================================================")
    for e in entries:
        lines.append(e["info"])
        lines.extend(e["urls"])
    return "\n".join(lines) + "\n"


def sha256(data):
    return hashlib.sha256(data).hexdigest()


# ---------------------------------------------------------------- 主流程
def main():
    os.makedirs(OUT, exist_ok=True)
    stamp = datetime.now(CST).strftime("%Y-%m-%d %H:%M:%S")
    url_tvg = (BASE_URL + "/epg.xml.gz") if BASE_URL else EPG_UPSTREAM

    parsed, meta_sources = {}, []
    for src in SOURCES:
        raw, used = fetch(src["path"])
        entries = parse_playlist(raw.decode("utf-8", "replace"))
        if len(entries) < 50:
            raise SystemExit("!! %s 只解析出 %d 条，疑似上游异常，已中止" % (src["id"], len(entries)))
        parsed[src["id"]] = [dict(e, info=rewrite_assets(e["info"])) for e in entries]
        meta_sources.append({
            "id": src["id"],
            "label": src["label"],
            "page": src["page"],
            "fetched_from": used,
            "entries": len(entries),
            "sha256": sha256(raw),
        })
        print("[ok] %-16s %3d 条  <- %s" % (src["id"], len(entries), used))

    prev_meta = os.path.join(OUT, "meta.json")
    prev = {}
    if os.path.exists(prev_meta):
        try:
            prev = json.load(open(prev_meta, encoding="utf-8"))
        except ValueError:
            prev = {}

    # 上游内容没变就不重新生成：避免每 10 分钟一次的时间戳 commit 把仓库撑大
    prev_hash = {s.get("id"): s.get("sha256") for s in prev.get("sources", [])}
    now_hash = {s["id"]: s["sha256"] for s in meta_sources}
    outputs_exist = all(os.path.exists(os.path.join(OUT, n)) for n, _, _ in [("ku9.m3u", 0, 0), ("sdu.m3u", 0, 0), ("merge.m3u", 0, 0)])
    if prev_hash and prev_hash == now_hash and outputs_exist and os.environ.get("FORCE") != "1":
        print("[skip] 上游内容未变化，产物保持不变（%s）" % ", ".join("%s:%s" % (k, v[:8]) for k, v in now_hash.items()))
        return

    # 防回退：条目数骤降 >35% 直接报错，避免把坏数据推上去
    for s in meta_sources:
        old = next((x["entries"] for x in prev.get("sources", []) if x["id"] == s["id"]), None)
        if old and s["entries"] < old * 0.65:
            raise SystemExit("!! %s 条目由 %d 降到 %d，中止" % (s["id"], old, s["entries"]))

    merged = merge(parsed["ku9"], parsed["sdu"])
    outputs = [
        ("ku9.m3u", parsed["ku9"], "plsy1/iptv 原版（酷九）"),
        ("sdu.m3u", parsed["sdu"], "SDU-IPTV-PRO 原版"),
        ("merge.m3u", merged, "合并版：A 线 + B 线备用"),
    ]
    meta_out = {}
    for name, entries, desc in outputs:
        text = render(entries, url_tvg, stamp)
        with open(os.path.join(OUT, name), "w", encoding="utf-8", newline="\n") as fh:
            fh.write(text)
        meta_out[name] = {"desc": desc, "entries": len(entries), "sha256": sha256(text.encode())}
        print("[out] %-12s %3d 条" % (name, len(entries)))

    meta = {
        "generated_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "generated_cst": stamp,
        "base_url": BASE_URL or "(未设置，logo/EPG 仍指向上游)",
        "sources": meta_sources,
        "outputs": meta_out,
    }
    with open(os.path.join(OUT, "meta.json"), "w", encoding="utf-8", newline="\n") as fh:
        json.dump(meta, fh, ensure_ascii=False, indent=2, sort_keys=True)
        fh.write("\n")
    print("[out] meta.json  base_url=%s" % meta["base_url"])


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as exc:
        print(exc, file=sys.stderr)
        sys.exit(1)
