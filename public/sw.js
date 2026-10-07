/* 輔凰商貿單機版 Service Worker —— App Shell 快取策略
 * 範圍：僅快取「殼層 + 靜態資源」，不快取 /api 與任何訂單/應收資料，
 *       以維持財務資料即時性與一致性（避免離線陳舊資料被誤用）。
 * 安全上下文：本機 http://127.0.0.1:5200 屬 loopback，視為安全上下文，可直接安裝。
 */
const CACHE = 'mj-shell-v1';
const SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/vendor/chart.umd.js',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/apple-touch-icon.png',
  '/icon.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;           // 只處理 GET

  const url = new URL(req.url);
  if (url.pathname.startsWith('/api')) return;          // 不攔截 API
  if (url.origin !== self.location.origin) return;      // 不攔截跨來源（CDN chart.js）

  // 導覽請求（HTML）：network-first，離線回退殼層
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('/index.html', copy));
          return res;
        })
        .catch(() => caches.match('/index.html').then((r) => r || caches.match('/')))
    );
    return;
  }

  // 靜態資源：cache-first，回源後寫入（雜湊資源不可變，最適合）
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      });
    })
  );
});
