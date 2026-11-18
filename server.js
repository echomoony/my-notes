/**
 * 本地静态预览服务器（零依赖，只用 Node 自带模块）
 * -----------------------------------------------------------
 * 作用：
 *   1. 把当前目录当作网站根目录提供访问（index.html / style.css / main.js ...）
 *   2. 监听文件变化，改动保存后让浏览器自动刷新（热刷新）
 *
 * 使用：node server.js   或   npm run dev
 * 访问：http://localhost:5173
 */

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');
const os = require('node:os');

// ---------- 配置 ----------
const PORT = Number(process.env.PORT) || 5173;
// 0.0.0.0 = 本机 + 同一 WiFi 下的手机都能访问
// 只想自己电脑看时：$env:HOST="127.0.0.1"; node server.js
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname; // 以本文件所在目录作为网站根目录

// 常见文件类型 -> Content-Type
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp4': 'video/mp4',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

// 需要自动刷新的文件后缀
const WATCH_EXT = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.json', '.svg']);

// 注入到每个 HTML 页面末尾的客户端脚本（负责接收刷新通知）
const LIVE_CLIENT = `
<script>
(function () {
  window.__DEV_SERVER__ = true;
  var root = document.documentElement;

  function mark(state) {
    root.setAttribute('data-live', state);
    document.dispatchEvent(new CustomEvent('devserver:status', { detail: state }));
  }

  if (!window.EventSource) { mark('off'); return; }

  var source = new EventSource('/__live');
  source.addEventListener('open', function () { mark('on'); });
  source.addEventListener('error', function () { mark('off'); });
  source.addEventListener('reload', function () { location.reload(); });
})();
</script>
`;

// ---------- 热刷新通道：用 SSE 保持长连接 ----------
const clients = new Set();

function broadcastReload(changedPath) {
  const payload = `event: reload\ndata: ${JSON.stringify({ file: changedPath })}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }
}

// ---------- 静态文件 ----------

/** 把 URL 路径解析成磁盘上的绝对路径，并挡掉越界访问 */
function resolveFile(urlPath) {
  const decoded = decodeURIComponent(urlPath);
  const rel = decoded === '/' ? '/index.html' : decoded;
  const abs = path.join(ROOT, rel);

  // 安全校验：不能跑到项目目录之外
  const inside = path.resolve(abs).startsWith(path.resolve(ROOT) + path.sep);
  if (!inside) return null;

  return abs;
}

function serveFile(req, res, absPath) {
  fs.stat(absPath, (err, stat) => {
    if (err || !stat.isFile()) {
      send404(res, absPath);
      return;
    }

    const ext = path.extname(absPath).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';

    // HTML 页面需要注入热刷新脚本，走文本读取 + 替换
    if (ext === '.html' || ext === '.htm') {
      fs.readFile(absPath, 'utf8', (readErr, html) => {
        if (readErr) {
          send404(res, absPath);
          return;
        }
        const injected = html.includes('</body>')
          ? html.replace('</body>', `${LIVE_CLIENT}</body>`)
          : html + LIVE_CLIENT;

        res.writeHead(200, {
          'Content-Type': type,
          'Content-Length': Buffer.byteLength(injected),
          'Cache-Control': 'no-store',
        });
        res.end(req.method === 'HEAD' ? '' : injected);
      });
      return;
    }

    // 其他文件直接流式返回
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Cache-Control': 'no-store',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    const stream = fs.createReadStream(absPath);
    stream.on('error', () => res.end());
    stream.pipe(res);
  });
}

function send404(res, absPath) {
  const rel = path.relative(ROOT, absPath) || absPath;
  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`<!DOCTYPE html><html lang="zh-CN"><meta charset="utf-8">
<title>404 找不到页面</title>
<body style="font-family:system-ui,'Microsoft YaHei';padding:40px;line-height:1.7">
<h1 style="font-size:20px">404 找不到：${rel}</h1>
<p style="color:#555">检查文件名是否拼对了，或者回到 <a href="/">首页</a>。</p>
</body></html>`);
}

// ---------- 服务器 ----------
const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('只支持 GET / HEAD');
    return;
  }

  const { pathname } = url.parse(req.url);

  // 热刷新长连接端点
  if (pathname === '/__live') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write('retry: 1000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  // 不暴露隐藏文件和本服务器脚本
  if (pathname.includes('/.') || /^\/server\.js$/.test(pathname) || /^\/package(-lock)?\.json$/.test(pathname)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return;
  }

  const absPath = resolveFile(pathname);
  if (!absPath) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 禁止访问');
    return;
  }

  serveFile(req, res, absPath);
});

// ---------- 文件监听 ----------
let timer = null;
let pending = '';

function watchDir() {
  try {
    fs.watch(ROOT, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      const ext = path.extname(filename).toLowerCase();
      if (!WATCH_EXT.has(ext)) return; // 只关心页面相关文件
      if (filename.split(path.sep).some((seg) => seg.startsWith('.') || seg === 'node_modules')) return;

      pending = filename;
      clearTimeout(timer);
      // 防抖：一次保存常常触发多次事件
      timer = setTimeout(() => {
        console.log(`  ↻ 检测到改动：${pending}  ->  通知浏览器刷新`);
        broadcastReload(pending);
      }, 120);
    });
    console.log('  · 已开启文件监听（保存后自动刷新）');
  } catch (err) {
    console.warn('  ! 无法开启文件监听：', err.message);
  }
}

// ---------- 启动 ----------
server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  本地预览服务器已启动');
  console.log(`  电脑访问：http://localhost:${PORT}`);

  // 列出局域网地址，手机连同一个 WiFi 时用这个
  const lanAddrs = listLanAddresses();
  if (HOST === '0.0.0.0' && lanAddrs.length) {
    console.log('  手机访问（需连同一个 WiFi）：');
    lanAddrs.forEach((addr) => console.log(`    http://${addr}:${PORT}`));
  } else if (HOST !== '0.0.0.0') {
    console.log('  当前只允许本机访问（HOST 未设为 0.0.0.0）');
  }

  console.log(`  网站根目录：${ROOT}`);
  console.log('  按 Ctrl + C 停止');
  console.log('');
  watchDir();
});

/** 取本机的局域网 IPv4 地址 */
function listLanAddresses() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  端口 ${PORT} 已被占用，可以换端口启动：\n  $env:PORT=5174; node server.js\n`);
  } else {
    console.error('\n  服务器启动失败：', err.message, '\n');
  }
  process.exit(1);
});
