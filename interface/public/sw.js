// Alfie Service Worker — Offline Cache & Disconnected Garden Access
const CACHE_NAME = "alfie-core-v1";
const STATIC_ASSETS = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/manifest.webmanifest",
  "/icon.svg",
  "/vendor/react.production.min.js",
  "/vendor/react-dom.production.min.js",
  "/vendor/recharts.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch((err) => {
        console.warn("[Alfie SW] Non-fatal precache notice:", err);
      });
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) return caches.delete(key);
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // 1. Garden Memories API: Network-First with Offline Cache Fallback
  if (url.pathname === "/api/core/memories") {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(async () => {
          const cached = await caches.match(event.request);
          if (cached) {
            const data = await cached.json();
            return new Response(JSON.stringify({ ...data, offline: true, cachedAt: Date.now() }), {
              status: 200,
              headers: { "content-type": "application/json; charset=utf-8", "x-alfie-offline": "true" }
            });
          }
          return new Response(JSON.stringify({ memories: [], offline: true, disconnected: true }), {
            status: 200,
            headers: { "content-type": "application/json; charset=utf-8", "x-alfie-offline": "true" }
          });
        })
    );
    return;
  }

  // 2. Auth & Core Status: Allow offline access to interface when server is disconnected
  if (url.pathname === "/api/auth/me") {
    event.respondWith(
      fetch(event.request).catch(async () => {
        return new Response(JSON.stringify({
          authenticated: true,
          offline: true,
          user: { username: "admin", displayName: "Alfie User" },
          csrfToken: "offline-mode-token"
        }), {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8", "x-alfie-offline": "true" }
        });
      })
    );
    return;
  }

  if (url.pathname === "/api/core/whoami") {
    event.respondWith(
      fetch(event.request).catch(async () => {
        return new Response(JSON.stringify({
          linked: true,
          offline: true,
          userId: "offline-workspace"
        }), {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8", "x-alfie-offline": "true" }
        });
      })
    );
    return;
  }

  if (url.pathname === "/api/core/conversations") {
    event.respondWith(
      fetch(event.request).catch(async () => {
        return new Response(JSON.stringify({
          conversations: [],
          offline: true
        }), {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8", "x-alfie-offline": "true" }
        });
      })
    );
    return;
  }

  if (/^\/api\/core\/conversations\/[a-f0-9-]{36}\/messages\/[a-f0-9-]{36}\/reaction$/.test(url.pathname)) {
    event.respondWith(
      fetch(event.request).catch(async () => {
        return new Response(JSON.stringify({
          success: true,
          offline: true
        }), {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8", "x-alfie-offline": "true" }
        });
      })
    );
    return;
  }

  // 3. Static Assets: Network-first with Cache Fallback
  if (event.request.method === "GET") {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(async () => {
          const cached = await caches.match(event.request);
          if (cached) return cached;
          if (event.request.mode === "navigate") {
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
  }
});
