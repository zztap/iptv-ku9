# SD-IPTV · 山东联通单播聚合

把 [plsy1/iptv](https://github.com/plsy1/iptv) 与 [sggc/SDU-IPTV-PRO](https://github.com/sggc/SDU-IPTV-PRO) 的**山东联通单播**源自动聚合，产出**一个固定不变的订阅地址**，给酷九（Ku9）/ APTV 等播放器用。

上游改了、换服务器了、代理挂了 —— 你的订阅地址不动，内容自动跟着更新。

## 产出

| 文件 | 说明 |
|---|---|
| `dist/merge.m3u` | **推荐**：A 线（plsy1）+ B 线（SDU）备用，同一频道两条线路 |
| `dist/ku9.m3u` | plsy1/iptv 原版，保留 7 天回看与台标 |
| `dist/sdu.m3u` | SDU-IPTV-PRO 原版，频道顺序本地化 |
| `dist/meta.json` | 构建时间、各源条目数、上游地址、哈希 |

两个上游用的是**两批不同的 RTSP 服务器**（plsy1: `112.245.125.x` / `222.132.188.x`，SDU: `60.212.114.215-220`），所以合并不是重复，而是双保险。

## 自动化

`.github/workflows/sync.yml`：每 10 分钟检查上游，**内容有变化才提交**（无变化不产生 commit）。同一份逻辑也可在本机 `python scripts/build.py` 直接跑。

仓库变量（Settings → Variables）：

| 变量 | 作用 |
|---|---|
| `BASE_URL` | 你的 CF 域名，例如 `https://iptv.example.com`。设置后台标与 EPG 全部改走你的域名 |
| `EPG_URL` | 可选，自定义 EPG 上游，默认用 plsy1 的 7 天节目单 |

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
