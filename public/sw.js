/**
 * Fase 3.2 — service worker SOLO para el shell estático.
 *
 * Regla que no se negocia: nada de `/api/*` entra al caché, y ninguna
 * respuesta con datos se cachea. Este SW existe para que la app abra
 * rápido y funcione un rato sin red (pantalla de lista vacía), no para
 * servir datos viejos: una lista de tasks desactualizada es peor que un
 * error de red.
 *
 * Estrategia:
 * - Navegaciones (HTML): network-first, con fallback al shell cacheado si
 *   no hay red. Si la red responde, se actualiza el shell.
 * - Assets con hash de Next (`/_next/static/*`): cache-first (son
 *   inmutables, el nombre lleva el hash).
 * - `/api/*`: se deja pasar siempre, sin tocar el caché.
 * - Imágenes/íconos: cache-first.
 */

const VERSION = "magi-shell-v1";
const SHELL_CACHE = `${VERSION}-shell`;
const ASSET_CACHE = `${VERSION}-assets`;
const IMAGE_CACHE = `${VERSION}-images`;

/** Lo mínimo para que la app abra sin red. */
const SHELL_URLS = ["/m", "/offline"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // addAll falla todo si una URL da 404: se agregan una por una y se
      // ignora la que falle, para que un deploy parcial no rompa la
      // instalación.
      await Promise.all(
        SHELL_URLS.map(async (url) => {
          try {
            await cache.add(new Request(url, { cache: "reload" }));
          } catch {
            /* si no existe todavía, no es fatal */
          }
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith("magi-shell-") && !key.startsWith(VERSION))
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

function isApiRequest(url) {
  return url.pathname.startsWith("/api/");
}

function isNextAsset(url) {
  return url.pathname.startsWith("/_next/static/");
}

function isImage(url) {
  return /\.(png|jpg|jpeg|svg|webp|ico|gif)$/i.test(url.pathname);
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // API: jamás al caché, jamás interceptada. Pasa y listo.
  if (isApiRequest(url)) return;

  if (isNextAsset(url)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(ASSET_CACHE);
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok) cache.put(request, response.clone());
        return response;
      })(),
    );
    return;
  }

  if (isImage(url)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(IMAGE_CACHE);
        const cached = await cache.match(request);
        if (cached) return cached;
        try {
          const response = await fetch(request);
          if (response.ok) cache.put(request, response.clone());
          return response;
        } catch {
          return cached ?? Response.error();
        }
      })(),
    );
    return;
  }

  // Navegación: network-first con fallback al shell.
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          if (response.ok) {
            const cache = await caches.open(SHELL_CACHE);
            cache.put("/m", response.clone());
          }
          return response;
        } catch {
          const cache = await caches.open(SHELL_CACHE);
          return (
            (await cache.match("/m")) ??
            (await cache.match("/offline")) ??
            new Response("Sin conexión. Esta pantalla necesita red.", {
              status: 503,
              headers: { "Content-Type": "text/plain; charset=utf-8" },
            })
          );
        }
      })(),
    );
  }
});

/* =========================================================
   Fase 6 — notificaciones push
   ========================================================= */

self.addEventListener("push", (event) => {
  let payload = { title: "Consenso IA", body: "", tag: "magi", url: "/m" };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch {
    // Payload no-JSON: se ignora y se usa el default.
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-maskable-192.png",
      tag: payload.tag,
      // `renotify` en false: si llega otra notificación con el mismo tag
      // (misma tarea que necesita aprobación), reemplaza en silencio en
      // vez de volver a zumbar. Es la coalescencia del lado del SO.
      renotify: false,
      data: { url: payload.url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data?.url ?? "/m";
  event.waitUntil(
    (async () => {
      const clientsList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of clientsList) {
        if (new URL(client.url).origin === self.location.origin) {
          await client.focus();
          if ("navigate" in client) await client.navigate(target);
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});
