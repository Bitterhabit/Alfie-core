// Alfie Service Worker — cache the static shell only; private API data stays network-only.
const CACHE_NAME = "alfie-core-v2";
const STATIC_ASSETS = [
  "/",
  "/index.html",
  "/styles.css?v=alfie-workspace-0.7.0",
  "/app.js?v=alfie-workspace-0.7.0",
  "/manifest.webmanifest",
  "/icon.svg",
  "/vendor/react.production.min.js",
  "/vendor/react-dom.production.min.js",
  "/vendor/recharts.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(STATIC_ASSETS).catch((error) => {
        console.warn("[Alfie SW] Static precache incomplete:", error);
      }))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys
        .filter((key) => key.startsWith("alfie-core-") && key !== CACHE_NAME)
        .map((key) => caches.delete(key))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // Never cache, synthesize, or alter authenticated API responses.
  // The browser must receive the real server's authentication result.
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  if (request.method !== "GET") return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.status === 200 && response.type === "basic") {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        if (request.mode === "navigate") {
          const indexCached = await caches.match("/index.html") || await caches.match("/");
          if (indexCached) return indexCached;
        }
        return new Response("Offline — Alfie is disconnected from the server.", {
          status: 503,
          statusText: "Service Unavailable",
          headers: { "content-type": "text/plain; charset=utf-8" }
        });
      })
  );
});
