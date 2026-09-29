// Service worker: precache app shell, cache-first with background refresh. Paths are relative to scope,
// so it works from a GitHub Pages subpath.
const VERSION = 'ddb994c071';
const CACHE = 'webdaw-' + VERSION;
const ASSETS = ["./","./css/style.css","./icons/apple-touch-icon.png","./icons/icon-192.png","./icons/icon-32.png","./icons/icon-512.png","./icons/icon-maskable-512.png","./index.html","./js/audio/adaptive.js","./js/audio/detect.js","./js/audio/effects.js","./js/audio/engine.js","./js/audio/instruments.js","./js/audio/ir.js","./js/audio/keydetect.js","./js/audio/keyfollow.js","./js/audio/pitchdsp.js","./js/audio/presets.js","./js/audio/synths.js","./js/audio/tempo.js","./js/audio/timecorrect.js","./js/audio/worklets.js","./js/history.js","./js/main.js","./js/midi.js","./js/project.js","./js/security.js","./js/tiers.js","./js/ui/controls.js","./js/ui/dom.js","./js/ui/phone.js","./js/ui/pianoroll.js","./js/ui/tutorial.js","./js/ui/viz.js","./js/ui/waveform.js","./js/validate.js","./manifest.webmanifest"];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS.map((a) => new URL(a, self.registration.scope).href))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('webdaw-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => {
    const net = fetch(req).then((res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); } return res; }).catch(() => hit || (req.mode === 'navigate' ? caches.match(new URL('./index.html', self.registration.scope).href) : undefined));
    return hit || net;
  }));
});
