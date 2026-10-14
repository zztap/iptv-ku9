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

async function fetchFirst(urls) {
  for (const u of urls) {
    try {
      const r = await fetch(u, { headers: { "user-agent": UA }, redirect: "follow" });
      if (!r.ok) continue;
      const body = await r.arrayBuffer();
      if (body.byteLength < 64) continue;
      return { body, from: u };
    } catch (e) { /* 试下一个 */ }
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
  const got = await fetchFirst([EPG_UPSTREAM, `https://gh-proxy.com/${EPG_UPSTREAM}`, `https://gh-proxy.org/${EPG_UPSTREAM}`]);
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
  const got = await fetchFirst(candidates);
  if (!got) return new Response("", { status: 404, headers: CORS });
  const res = new Response(got.body, {
    headers: { ...CORS, "cache-control": "public, max-age=604800" },
  });
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

function panel(request) {
  const origin = new URL(request.url).origin;
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
  footer{color:#6a7286;font-size:12px;margin-top:22px;line-height:1.8}
</style></head><body>
<h1>山东联通单播 IPTV</h1>
<p class="sub">自动同步 plsy1/iptv 与 sggc/SDU-IPTV-PRO · 上游一变，这里的地址内容自动跟着变</p>
${cards}
<div class="card">
  <div class="head"><b>构建状态</b></div>
  <table id="meta"><tr><td class="warn">加载中…</td></tr></table>
</div>
<footer>
  单播为 RTP over UDP，需山东联通宽带（公网 IPv4 + PPPoE，账号后可加 @e 重拨）或 IPTV 专口。<br>
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

  fetch("/meta.json").then(r => r.json()).then(m => {
    const rows = [
      ["构建时间（北京时间）", m.generated_cst],
      ["BASE_URL", m.base_url],
      ...Object.entries(m.outputs).map(([f, o]) => [f, o.entries + " 条 · " + o.desc]),
      ...m.sources.map(s => [s.label, s.entries + " 条 · 源 " + s.fetched_from.replace(/^https?:\\/\\//, "").slice(0, 60)]),
    ];
    document.getElementById("meta").innerHTML =
      "<tr><th>项目</th><th>值</th></tr>" +
      rows.map(([k, v]) => "<tr><td>" + k + "</td><td class='ok'>" + v + "</td></tr>").join("");
  }).catch(() => {
    document.getElementById("meta").innerHTML = "<tr><td class='warn'>meta.json 读取失败</td></tr>";
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
    if (path === "/" || path === "/index.html") return panel(request);
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
