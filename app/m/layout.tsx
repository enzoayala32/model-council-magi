import type { Metadata, Viewport } from "next";
import "./mobile.css";

/**
 * Fase 3.2 — shell de la PWA móvil.
 *
 * La vista de escritorio sigue en `/`. Acá manda el teléfono: layout
 * mobile-first, sin sidebar, con navegación inferior. No se reescriben
 * estilos: se reusa la paleta y las variables de `globals.css` (mismo
 * fichero se importa desde `app/layout.tsx`, así que las variables ya
 * están) y este CSS solo agrega lo específico de móvil.
 */

export const metadata: Metadata = {
  title: "Consenso IA — Control",
  description: "Control del consejo y del agente desde el teléfono.",
};

/** `viewport-fit=cover` para que el fondo llegue hasta el notch. */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#171717",
};

/**
 * Registro del service worker. Se hace en el cliente (no en el server)
 * para no bloquear el primer render. Solo cachea el shell: el contrato
 * está en `public/sw.js`.
 */
export default function MobileLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <script
        dangerouslySetInnerHTML={{
          __html: `if('serviceWorker' in navigator){window.addEventListener('load',function(){navigator.serviceWorker.register('/sw.js').catch(function(){});});}`,
        }}
      />
    </>
  );
}
