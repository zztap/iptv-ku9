/**
 * 山东联通单播 IPTV —— Cloudflare Worker 反代 + 订阅面板
 *
 * 作用：
 *   1. 给你一个国内可访问的固定地址，转发 GitHub 上的聚合播放列表
 *   2. 附带 logo / EPG 转发，播放器里只认一个域名
 *   3. / 面板页：订阅地址、条目数、上游更新时间、一键复制 + 二维码
 *
 * 部署：Cloudflare Dashboard → Workers & Pages → 新建 → 粘贴本文件
 *      或 wrangler deploy，然后绑定自定义域名（国内可访问的关键）
 */

const DEFAULT_REPO = "zztap/iptv-ku9";
const BRANCH = "main";
const UA = "Mozilla/5.0 (compatible; sd-iptv-worker/1.0)";

const EPG_UPSTREAM =
  "https://raw.githubusercontent.com/plsy1/epg/main/e/seven-days.xml.gz";

const FILES = {
  "/ku9.m3u":   { file: "dist/ku9.m3u",   ttl: 300, type: "audio/x-mpegurl; charset=utf-8" },
  "/sdu.m3u":   { file: "dist/sdu.m3u",   ttl: 300, type: "audio/x-mpegurl; charset=utf-8" },
  "/merge.m3u": { file: "dist/merge.m3u", ttl: 300, type: "audio/x-mpegurl; charset=utf-8" },
  "/meta.json": { file: "dist/meta.json", ttl: 120, type: "application/json; charset=utf-8" },
};

// GitHub 主源 + 备用镜像（Worker 出口在境外，直连 raw 通常没问题，多加几层兜底）
function mirrors(repo, file) {
  const raw = `https://raw.githubusercontent.com/${repo}/${BRANCH}/${file}`;
  return [
    raw,
    `https://gh-proxy.com/${raw}`,
    `https://gh-proxy.org/${raw}`,
    `https://fastly.jsdelivr.net/gh/${repo}@${BRANCH}/${file}`,
    `https://cdn.jsdelivr.net/gh/${repo}@${BRANCH}/${file}`,
  ];
}

// 抓取上游原始列表（GitHub 挂掉时的兜底）
const UPSTREAM_FALLBACK = {
  "/ku9.m3u": ["https://raw.githubusercontent.com/plsy1/iptv/main/unicast/unicast-ku9.m3u"],
  "/sdu.m3u": ["https://raw.githubusercontent.com/sggc/SDU-IPTV-PRO/main/SDU-Unicast.m3u"],
};

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
};

function withCORS(res) {
  const r = new Response(res.body, res);
  Object.entries(CORS).forEach(([k, v]) => r.headers.set(k, v));
  return r;
}

async function fetchFirst(urls, ms = 8000) {
  for (const u of urls) {
    try {
      const r = await fetch(u, {
        headers: { "user-agent": UA },
        redirect: "follow",
        signal: AbortSignal.timeout(ms),
      });
      if (!r.ok) continue;
      const body = await r.arrayBuffer();
      if (body.byteLength < 64) continue;
      return { body, from: u };
    } catch (e) { /* 超时/失败都换下一个镜像 */ }
  }
  return null;
}

async function serveFile(env, ctx, path) {
  const spec = FILES[path];
  const repo = env.GITHUB_REPO || DEFAULT_REPO;
  const cache = caches.default;
  const key = new Request(`https://cache.internal${path}?repo=${repo}`);

  const hit = await cache.match(key);
  if (hit) return withCORS(hit);

  const urls = mirrors(repo, spec.file).concat(UPSTREAM_FALLBACK[path] || []);
  const got = await fetchFirst(urls);
  if (!got) {
    return new Response("上游暂不可用，请稍后重试\n", {
      status: 502,
      headers: { ...CORS, "content-type": "text/plain; charset=utf-8" },
    });
  }

  const res = new Response(got.body, {
    headers: {
      ...CORS,
      "content-type": spec.type,
      "cache-control": `public, max-age=${spec.ttl}`,
      "x-source": got.from,
    },
  });
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

async function serveEPG(env, ctx) {
  const cache = caches.default;
  const key = new Request("https://cache.internal/epg.xml.gz");
  const hit = await cache.match(key);
  if (hit) return withCORS(hit);
  const got = await fetchFirst([EPG_UPSTREAM, `https://gh-proxy.com/${EPG_UPSTREAM}`, `https://gh-proxy.org/${EPG_UPSTREAM}`], 20000);
  if (!got) return new Response("EPG 暂不可用\n", { status: 502, headers: CORS });
  const res = new Response(got.body, {
    headers: {
      ...CORS,
      "content-type": "application/gzip",
      "cache-control": "public, max-age=3600",
    },
  });
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

async function serveLogo(env, ctx, name) {
  if (!/^[\w\u4e00-\u9fa5+\-.]+\.(png|jpg|jpeg|gif|webp|svg)$/i.test(name)) {
    return new Response("bad logo name", { status: 400, headers: CORS });
  }
  const cache = caches.default;
  const key = new Request(`https://cache.internal/logo/${encodeURIComponent(name)}`);
  const hit = await cache.match(key);
  if (hit) return withCORS(hit);

  const candidates = [
    `https://fastly.jsdelivr.net/gh/plsy1/iptv@master/logo/${encodeURIComponent(name)}`,
    `https://raw.githubusercontent.com/plsy1/iptv/master/logo/${encodeURIComponent(name)}`,
    `https://gh-proxy.org/https://raw.githubusercontent.com/sggc/SDU-IPTV-PRO/main/logo/${encodeURIComponent(name)}`,
    `https://raw.githubusercontent.com/sggc/SDU-IPTV-PRO/main/logo/${encodeURIComponent(name)}`,
  ];
  const got = await fetchFirst(candidates, 6000);
  if (!got) return new Response("", { status: 404, headers: CORS });
  const res = new Response(got.body, {
    headers: { ...CORS, "cache-control": "public, max-age=604800" },
  });
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

async function metaRows(env) {
  const repo = env.GITHUB_REPO || DEFAULT_REPO;
  const got = await fetchFirst(mirrors(repo, "dist/meta.json"));
  if (!got) return "<tr><td class='warn'>构建信息暂不可用（GitHub 未同步或网络异常）</td></tr>";
  let m;
  try {
    m = JSON.parse(new TextDecoder().decode(got.body));
  } catch (e) {
    return "<tr><td class='warn'>meta.json 解析失败</td></tr>";
  }
  const rows = [
    ["内容更新时间（北京时间）", m.generated_cst || "-"],
    ["数据来源", (m.sources || []).map((s) => `${s.label}`).join(" + ")],
    ...Object.entries(m.outputs || {}).map(([f, o]) => [f, `${o.entries} 条 · ${o.desc}`]),
    ...(m.sources || []).map((s) => [s.label, `${s.entries} 条 · 取自 ${String(s.fetched_from || "").replace(/^https?:\/\//, "").slice(0, 48)}`]),
  ];
  return "<tr><th>项目</th><th>值</th></tr>" +
    rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="ok">${esc(v)}</td></tr>`).join("");
}

async function panel(request, env, ctx) {
  const origin = new URL(request.url).origin;
  const rows = await metaRows(env);
  const links = [
    { path: "/merge.m3u", name: "合并版（推荐）", desc: "A 线 + B 线备用，同一个频道两条线路" },
    { path: "/ku9.m3u",   name: "酷九版",        desc: "plsy1/iptv 原版，含 7 天回看" },
    { path: "/sdu.m3u",   name: "SDU 通用版",     desc: "SDU-IPTV-PRO 原版，频道顺序本地化" },
  ];
  const cards = links.map((l) => {
    const url = origin + l.path;
    return `
    <div class="card">
      <div class="head"><b>${l.name}</b><span class="badge">${l.desc}</span></div>
      <code id="u${l.path.replace(/[^a-z0-9]/gi, "")}">${url}</code>
      <div class="row">
        <button data-copy="${url}">复制订阅地址</button>
        <a class="btn" href="${l.path}" target="_blank">查看</a>
        <img class="qr" alt="二维码"
             src="https://api.pwmqr.com/qrcode/create/?url=${encodeURIComponent(url)}"
             onerror="this.style.display='none'">
      </div>
    </div>`;
  }).join("");

  const html = `<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>山东联通单播 · IPTV 订阅面板</title>
<style>
  :root{color-scheme:light dark}
  *{box-sizing:border-box}
  body{margin:0;padding:24px;font:15px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
       background:#0f1115;color:#e6e8ee}
  h1{font-size:20px;margin:0 0 4px}
  .sub{color:#8b93a7;font-size:13px;margin:0 0 22px}
  .card{background:#171a21;border:1px solid #262b36;border-radius:12px;padding:16px;margin-bottom:14px}
  .head{display:flex;flex-wrap:wrap;gap:10px;align-items:baseline;margin-bottom:10px}
  .badge{color:#8b93a7;font-size:12px}
  code{display:block;background:#0b0d11;border:1px solid #262b36;border-radius:8px;
       padding:10px 12px;font-family:ui-monospace,Consolas,monospace;font-size:13px;
       word-break:break-all;color:#7ee0a8}
  .row{display:flex;gap:10px;align-items:center;margin-top:10px;flex-wrap:wrap}
  button,.btn{font:inherit;font-size:13px;padding:7px 14px;border-radius:8px;cursor:pointer;
       text-decoration:none}
  button{background:#2b6cff;border-color:#2b6cff;color:#fff}
  .btn{background:transparent;border:1px solid #333a49;color:#c9cfdd}
  .qr{width:96px;height:96px;background:#fff;border-radius:6px;margin-left:auto}
  table{border-collapse:collapse;width:100%;font-size:13px}
  td,th{border-bottom:1px solid #22262f;padding:8px 6px;text-align:left}
  th{color:#8b93a7;font-weight:500}
  .ok{color:#7ee0a8}.warn{color:#ffcf6b}
  footer{color:#6a7286;font-size:12px;margin-top:22px;line-height:1.9}
  footer code{display:inline;background:none;border:0;padding:0;color:#7ee0a8;font-size:12px}
</style></head><body>
<h1>山东联通单播 IPTV</h1>
<p class="sub">自动同步 plsy1/iptv 与 sggc/SDU-IPTV-PRO · 上游一变，这里的地址内容自动跟着变</p>
${cards}
<div class="card">
  <div class="head"><b>构建状态</b></div>
  <table>${rows}</table>
</div>
<footer>
  <b>怎么用</b><br>
  ① 本机跑中转：<code>python tools/relay.py</code> → 播放器订阅 <code>http://本机IP:8899/list.m3u</code><br>
  ② 这里的 m3u 只是播放列表。视频流是山东联通内网的 RTP over UDP，
     Cloudflare 到不了你的内网、也不能代理流，所以播流必须靠本机中转（自动打洞解决 NAT 回程）。<br>
  ③ plsy1 那批 <code>112.245.125.x</code> / <code>222.132.188.x</code> 在多数宽线上 SETUP 直接 401（平台鉴权），
     能播的是 SDU 那批 <code>60.212.114.x</code>；列表里另一批已标为「·备用」。<br>
  本项目仅做播放列表聚合与转发，不存储、不产生任何音视频内容，请勿用于商业用途。
</footer>
<script>
  document.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-copy]");
    if (!btn) return;
    const text = btn.dataset.copy;
    try { await navigator.clipboard.writeText(text); }
    catch (_) {
      const t = document.createElement("textarea");
      t.value = text; document.body.appendChild(t); t.select();
      document.execCommand("copy"); t.remove();
    }
    const old = btn.textContent; btn.textContent = "已复制 ✓";
    setTimeout(() => (btn.textContent = old), 1500);
  });
</script>
</body></html>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", ...CORS },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (path === "/" || path === "/index.html") return panel(request, env, ctx);
    if (path === "/health") return new Response("ok", { headers: CORS });
    if (FILES[path]) return serveFile(env, ctx, path);
    if (path === "/epg.xml.gz" || path === "/epg.xml") return serveEPG(env, ctx);
    if (path.startsWith("/logo/")) return serveLogo(env, ctx, decodeURIComponent(path.slice(6)));
    return new Response("404\n可访问: / /ku9.m3u /sdu.m3u /merge.m3u /meta.json /epg.xml.gz /logo/<名称>.png\n", {
      status: 404,
      headers: { ...CORS, "content-type": "text/plain; charset=utf-8" },
    });
  },
};
