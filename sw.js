/* 会場の電波が不安定でも開けるように、アプリ本体を端末にためておく */
// ファイルを更新したら、VERSION と index.html の ?v= を同時に上げる（古い app.js と新しい index.html が混ざらないようにするため）
const VERSION = '11';
const CACHE = 'mm-v' + VERSION;
const CORE = ['./', 'index.html', 'matcher.js?v=' + VERSION, 'core.js?v=' + VERSION, 'app.js?v=' + VERSION, 'manifest.webmanifest', 'icon.svg', 'icon-180.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // スプレッドシート（Google Apps Script）との通信には触らない
  if (url.hostname === 'script.google.com' || url.hostname.endsWith('googleusercontent.com')) return;

  // フォント: 一度取れたらずっと使う
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok || res.type === 'opaque') {
          const copy = res.clone();
          e.waitUntil(caches.open(CACHE).then((c) => c.put(req, copy)));
        }
        return res;
      }))
    );
    return;
  }

  if (url.origin !== location.origin) return;

  // 導入の手順書は、アプリとは別。キャッシュに触れず、いつもサーバーから開く（オフラインで手順書を開いたつもりがアプリが出る、を防ぐ）
  if (url.pathname.endsWith('/guide.html')) return;

  // アプリ本体: ネットが速ければ最新、遅い・つながらないときは端末の控えを使う
  // （?v= 付きのファイルは版ごとに別のキャッシュなので、版の違うものが混ざらない）
  e.respondWith(
    new Promise((resolve) => {
      let settled = false;
      const fallback = () => caches.match(req).then((hit) => hit || (req.mode === 'navigate' ? caches.match('index.html') : undefined));
      const give = (res) => { if (!settled && res) { settled = true; resolve(res); } };
      const timer = setTimeout(() => { fallback().then(give); }, 2500);
      // ブラウザの一時保存（GitHub Pagesは約10分）に頼らず、毎回サーバーに「変わっていないか」を確かめる（変わっていなければ速い）
      fetch(req, { cache: 'no-cache' }).then((res) => {
        clearTimeout(timer);
        if (res.ok) {
          const copy = res.clone();
          e.waitUntil(caches.open(CACHE).then((c) => c.put(req, copy)));
          give(res);
        } else {
          // 404 や 5xx は保存せず、控えがあればそちらを使う
          fallback().then((hit) => { give(hit || res); });
        }
      }).catch(() => {
        clearTimeout(timer);
        fallback().then((hit) => { if (!settled) { settled = true; resolve(hit || Response.error()); } });
      });
    })
  );
});
