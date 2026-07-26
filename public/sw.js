// Phase 8D — Service worker.
//
// Cache strategy:
//   - HTML / app routes: network-first, fall back to offline-cache.
//   - Static assets (/_next/static/*, /icons/*): cache-first.
//   - API routes: never cached; always network-only.
//
// Push notification handler is wired but does nothing useful without
// VAPID keys — that's the Phase 9 hook.

const CACHE_NAME = "spectre-v1";
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      await cache.add(new Request(OFFLINE_URL, { cache: "reload" }));
    } catch {
      // offline.html not yet present in dev; ignore.
    }
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
    self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET") return;
  if (url.pathname.startsWith("/api/")) return;

  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/")) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(event.request);
      if (cached) return cached;
      const response = await fetch(event.request);
      if (response.ok) cache.put(event.request, response.clone());
      return response;
    })());
    return;
  }

  if (event.request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const response = await fetch(event.request);
        return response;
      } catch {
        const cache = await caches.open(CACHE_NAME);
        const offline = await cache.match(OFFLINE_URL);
        return offline ?? new Response("Offline", { status: 503 });
      }
    })());
  }
});

self.addEventListener("push", (event) => {
  if (!event.data) return;
  let payload = {};
  try { payload = event.data.json(); } catch { /* opaque */ }
  const title = payload.title || "Spectre";
  const body = payload.body || "";
  event.waitUntil(self.registration.showNotification(title, { body, icon: "/icons/icon-192.png", data: payload.data || {} }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data && event.notification.data.url ? event.notification.data.url : "/app";
  event.waitUntil(self.clients.openWindow(url));
});
