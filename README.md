# SD-IPTV · 山东联通单播聚合

把 [plsy1/iptv](https://github.com/plsy1/iptv) 与 [sggc/SDU-IPTV-PRO](https://github.com/sggc/SDU-IPTV-PRO) 的**山东联通单播**源自动聚合，产出**一个固定不变的订阅地址**，给酷九（Ku9）/ APTV 等播放器用。

上游改了、换服务器了、代理挂了 —— 你的订阅地址不动，内容自动跟着更新。

## 产出

| 文件 | 说明 |
|---|---|
| `dist/merge.m3u` | **推荐**：主线路 + 同频道备用线路合在一张表里 |
| `dist/ku9.m3u` | plsy1/iptv 原版，保留 7 天回看与台标 |
| `dist/sdu.m3u` | SDU-IPTV-PRO 原版，频道顺序本地化 |
| `dist/meta.json` | 构建时间、各源条目数、上游地址、哈希 |

两个上游用的是**两批不同的 RTSP 服务器**（plsy1: `112.245.125.x` / `222.132.188.x`，SDU: `60.212.114.215-220`），所以合并不是重复，而是双保险。

### 实测结论（2026-10，山东联通 · 滨州）

| 平台 | 服务器 | DESCRIBE | SETUP | 能否播放 |
|---|---|---|---|---|
| SDU-IPTV-PRO | `60.212.114.215/219/220` | 200 | **200 OK** | ✅ 可以（需本地中转解决 RTP 回程） |
| plsy1/iptv | `112.245.125.x` / `222.132.188.x` | 200 | **401 Unauthorized** | ❌ 平台鉴权/白名单，需机顶盒鉴权或 IPTV 专口 |

因此 `PRIMARY` 默认设为 `sdu`：SDU 作主线路，plsy1 只作为备用线路（分组后缀 `·备用`，频道名后缀 `[酷九]`）。

## 自动化

`.github/workflows/sync.yml`：每 10 分钟检查上游，**内容有变化才提交**（无变化不产生 commit）。同一份逻辑也可在本机 `python scripts/build.py` 直接跑。

仓库变量（Settings → Variables）：

| 变量 | 作用 |
|---|---|
| `BASE_URL` | 你的 CF 域名，例如 `https://iptv.example.com`。设置后台标与 EPG 全部改走你的域名 |
| `EPG_URL` | 可选，自定义 EPG 上游，默认用 plsy1 的 7 天节目单 |
| `PRIMARY` | `sdu`（默认）或 `ku9`，决定合并版里谁当主线路 |

## 本地中转（NAT 穿透）—— 让单播真正能播

单播是 RTSP + RTP over UDP。服务器把 RTP 发到它看到的公网 `IP:client_port`，而 PC 在路由器 NAT 后面、本机防火墙也只放行"已出站过"的回程，于是：DESCRIBE / SETUP / PLAY 全 200 OK，**RTP 一个包都收不到**，播放器就是不出画面（服务器还不支持 RTSP over TCP 交错，`461 Unsupported Transport`，所以 VLC 的"用 TCP"开关也没用）。

`tools/relay.py` 解决这件事：按需**反向打洞**（先往服务器的 RTP 端口发一个 UDP 包建立映射），再把 RTP 剥头转成 HTTP MPEG-TS 流。

```bash
python tools/relay.py                 # 默认订阅 https://gitiptv.iizc.de/merge.m3u
python tools/relay.py --port 8899 --list <url-or-file>
```

播放器/酷九订阅：`http://<本机IP>:8899/list.m3u`（打开 `http://<本机IP>:8899/` 看状态）。

实测：打洞前 0 包，打洞后约 1.04 MB/s（≈8.4 Mbps），TS 188 字节对齐 100% 同步，视频 PID `0x1011` 正常出流。

## Cloudflare Worker 面板

`worker/worker.js` 是零依赖单文件 Worker：

| 路由 | 内容 |
|---|---|
| `/` | 面板：订阅地址、一键复制、二维码、构建状态 |
| `/ku9.m3u` `/sdu.m3u` `/merge.m3u` | 转发 GitHub 上的聚合结果（5 分钟缓存） |
| `/epg.xml.gz` | 转发 EPG（1 小时缓存） |
| `/logo/<名称>.png` | 转发台标（7 天缓存） |
| `/meta.json` | 构建元信息 |

GitHub 全部镜像不可用时，会直接回源到 plsy1 / SDU 的上游地址兜底。

### 部署

1. Cloudflare Dashboard → Workers & Pages → Create → Worker，把 `worker.js` 粘进去部署
   （或本地 `npx wrangler deploy`，配置见 `worker/wrangler.toml`）
2. Settings → Variables 设置 `GITHUB_REPO = zztap/iptv-ku9`
3. Settings → Domains & Routes → Add → Custom Domain，绑定 `iptv.你的域名.com`
   **必须绑自定义域名**：`*.workers.dev` 在国内基本被污染
4. 若国内访问仍不稳，用 CloudflareSpeedTest 选优选 IP，把域名解析指过去

## 免责声明

本项目不生产、不存储任何音视频内容，仅对公开的播放列表做格式整理与转发。内容版权归各电视台所有，仅供个人学习测试，请勿用于商业用途。
