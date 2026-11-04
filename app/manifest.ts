import type { MetadataRoute } from "next";

/**
 * Fase 3.2 — manifest de la PWA.
 *
 * La app móvil es la MISMA app servida por el mismo server, así que el
 * manifest vive en la raíz (`/manifest.webmanifest`) y aplica a `/`.
 * `start_url` es `/m`, que muestra el panel de control del agente.
 *
 * `display: "standalone"` y la paleta oscura: en el teléfono se abre como
 * app, sin la barra del navegador.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Consenso IA — Control del agente",
    short_name: "Consenso IA",
    description: "Control del consejo y del Coding Agent desde el teléfono.",
    lang: "es",
    dir: "ltr",
    start_url: "/m",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#171717",
    theme_color: "#171717",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/icon-maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Tareas", url: "/m/tasks" },
      { name: "Nueva tarea", url: "/m/tasks/new" },
    ],
  };
}
