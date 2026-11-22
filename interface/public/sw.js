// Alfie Service Worker — Static Shell Cache Only
// Never caches or synthesizes authenticated /api/* responses.
const CACHE_NAME = "alfie-core-v7";
const STATIC_ASSETS = [
  "/",
  "/index.html",
  "/styles.css?v=alfie-workspace-0.10.1",
  "/markdown-export.mjs?v=alfie-workspace-0.10.1",
  "/shortcuts.mjs?v=alfie-workspace-0.10.1",
  "/voice-waveform.mjs?v=alfie-workspace-0.10.1",
  "/knowledge-graph.mjs?v=alfie-workspace-0.10.1",
  "/virtual-room.mjs?v=alfie-workspace-0.10.1",
  "/app.js?v=alfie-workspace-0.10.1",
  "/manifest.webmanifest",
  "/icon.svg",
  "/vendor/react.production.min.js",
  "/vendor/react-dom.production.min.js",
  "/vendor/prop-types.min.js",
  "/vendor/recharts.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(STATIC_ASSETS).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.map((key) => (key !== CACHE_NAME ? caches.delete(key) : undefined))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  // Never intercept, cache, or fabricate authenticated API responses.
  if (url.pathname.startsWith("/api/") || url.pathname === "/health") {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.status === 200 && response.type === "basic") {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone)).catch(() => {});
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        if (event.request.mode === "navigate") {
          const indexCached = (await caches.match("/index.html")) || (await caches.match("/"));
          if (indexCached) return indexCached;
        }
        return new Response("Offline — Alfie is currently unreachable.", {
          status: 503,
          statusText: "Service Unavailable",
          headers: { "content-type": "text/plain; charset=utf-8" }
        });
      })
  );
});
