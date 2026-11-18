/**
 * 离线缓存（Service Worker）
 * -----------------------------------------------------------
 * 策略：先请求网络，网络通了就用最新文件并顺手更新缓存；
 *      断网时回落到缓存，页面照样能打开。
 * 这样开发时改代码仍然是最新的（不会卡在旧版本），离线也能用。
 */

'use strict';

const CACHE_NAME = 'notes-shell-v4';

const SHELL = [
  './',
  './index.html',
  './style.css',
  './main.js',
  './sync.js',
  './sync-config.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

// 安装：把页面骨架先存一份
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch((err) => console.warn('[SW] 预缓存失败', err))
  );
});

// 激活：清掉旧版本的缓存
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 不接管外部资源

  event.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(req, fresh.clone());
    }
    return fresh;
  } catch (err) {
    const cached = await caches.match(req);
    if (cached) return cached;

    // 页面导航断网时，回落到首页
    if (req.mode === 'navigate') {
      const shell = await caches.match('./index.html');
      if (shell) return shell;
    }
    throw err;
  }
}
