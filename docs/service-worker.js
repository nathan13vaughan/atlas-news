// Atlas News service worker — keeps the app available offline.
// Strategy:
//   - PWA shell (HTML/CSS/JS/manifest/icon): stale-while-revalidate
//     (serve cached instantly + always update in the background)
//   - data.json + intraday.json: network-first, fall back to cache
//   - On activate: force-reload all open clients so a fresh shell is shown
//     without waiting for a second visit
//   - Bump CACHE_VERSION when shipping new shell assets

const CACHE_VERSION = "atlas-news-v29";
const SHELL = [
  "./",
  "index.html",
  "styles.css",
  "app.js",
  "manifest.webmanifest",
  "icons/icon.svg",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE_VERSION).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
    // Force any pages already loaded under the previous SW to reload with the
    // new shell. Without this, the user has to fully close the PWA before
    // they ever see the new code.
    const clients = await self.clients.matchAll({ type: "window" });
    for (const c of clients) {
      try { c.navigate(c.url); } catch { /* navigate may not be available */ }
    }
  })());
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;

  // network-first for JSON data
  if (url.pathname.endsWith("data.json") || url.pathname.endsWith("intraday.json")) {
    e.respondWith(
      fetch(e.request)
        .then((resp) => {
          const copy = resp.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(e.request, copy));
          return resp;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // stale-while-revalidate for shell — instant from cache, refreshed in bg
  e.respondWith((async () => {
    const cache = await caches.open(CACHE_VERSION);
    const cached = await cache.match(e.request);
    const networkPromise = fetch(e.request)
      .then((resp) => {
        if (resp && resp.status === 200) cache.put(e.request, resp.clone());
        return resp;
      })
      .catch(() => cached);
    return cached || networkPromise;
  })());
});
