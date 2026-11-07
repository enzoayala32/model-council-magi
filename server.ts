/**
 * Server propio: envuelve al de Next y le agrega el dato que no se puede
 * falsificar — la dirección REAL del peer.
 *
 * POR QUE EXISTE (corrección de seguridad, revisión independiente):
 * `Host` es un header que manda el CLIENTE. Cualquiera que se conecte desde
 * una IP que no es loopback puede poner `Host: localhost:3000` y el server lo
 * cree: así se colaba "acceso local implícito" (sin token) desde la LAN o
 * desde internet, incluido generar y canjear códigos de emparejamiento.
 *
 * La dirección del peer, en cambio, la fija el kernel cuando acepta la
 * conexión TCP: no viaja en ningún header. Acá se lee `req.socket.remoteAddress`
 * y se escribe en `x-magi-peer`, BORRANDO antes cualquier valor que haya
 * mandado el cliente (si no, un atacante lo spoofearía igual).
 *
 * `lib/auth/authorize.ts`, la ruta `/api/pairing` y el proxy deciden por ese
 * header, nunca por `Host`.
 *
 * Uso:
 *   npm start          # server de producción (127.0.0.1 por defecto)
 *   npm run start:lan  # opt-in explícito, exige APP_ACCESS_TOKEN
 */
import http from "node:http";
import next from "next";

/** Direcciones que significan "esta misma máquina". */
const LOOPBACK_PEERS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "::ffff:127.0.1"]);

function normalizeAddress(raw: string | undefined): string {
  if (!raw) return "";
  // Node devuelve `::ffff:127.0.0.1` para IPv4 mapeado en IPv6.
  const address = raw.replace(/^::ffff:/, "");
  return address;
}

function isLoopbackAddress(raw: string | undefined): boolean {
  const address = normalizeAddress(raw);
  if (LOOPBACK_PEERS.has(address)) return true;
  if (address === "::1") return true;
  // 127.0.0.0/8 completo, por si el sistema usa otra dirección de loopback.
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(address)) return true;
  return false;
}

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 3000);
  // Loopback por default. Exponerse en la LAN requiere opt-in explícito
  // (`npm run start:lan`), que además valida que haya credencial.
  const hostname = process.env.MAGI_BIND_HOST ?? "127.0.0.1";
  const lanMode = process.env.MAGI_LAN_MODE === "1";

  // Correccion de seguridad #3: si se configuró CUALQUIER host que no sea
  // loopback (un túnel, un dominio público), el tráfico remoto llega al
  // server como loopback — el túnel termina en esta máquina. Sin esto, un
  // request desde internet sin credencial se trataría como "local implícito"
  // y pasaría. Fail-closed: se apaga el acceso implícito.
  const configuredHosts = (process.env.ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  const nonLoopbackHost = configuredHosts.some((host) => {
    const hostname = host.replace(/^https?:\/\//, "").replace(/^\[/, "").replace(/\].*$/, "").split(":")[0];
    return !(hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || /^127\./.test(hostname));
  });
  if (lanMode || nonLoopbackHost) {
    process.env.MAGI_DISABLE_LOCAL_IMPLICIT = "1";
  }

  // Solo el modo LAN (opt-in explícito para escuchar en la red) exige
  // credencial para arrancar. Un ALLOWED_HOSTS no-loopback *desactiva* el
  // acceso implícito, pero no impide arrancar.
  if (lanMode && !process.env.APP_ACCESS_TOKEN?.trim()) {
    console.error(
      "\n[server] Modo LAN rechazado: APP_ACCESS_TOKEN no está configurado.\n" +
        "          El modo LAN expone la app en la red. Sin una credencial,\n" +
        "          cualquiera en esa red tendría acceso sin autenticar.\n" +
        "          Definí APP_ACCESS_TOKEN en .env (o corré `npm start` para\n" +
        "          escuchar solo en loopback) y volvé a intentar.\n",
    );
    process.exit(1);
  }

  // `MAGI_DEV=1` levanta el mismo server en modo desarrollo (con HMR), para
  // que `npm run dev` también tenga el peer verificado. Sin esto, el modo dev
  // quedaría con el agujero que estamos cerrando.
  // `MAGI_DEV_DIST_DIR` (solo lo usan los tests) mueve el directorio de
  // build del modo dev a uno propio. Sin esto, dos servers de prueba —o un
  // server de prueba y un `npm run build`— comparten `.next` y se pisan los
  // manifests: el dev server empieza a devolver 404 por rutas que existen.
  // Es exactamente el fallo intermitente que tenía `security:test-peer-spoof`
  // cuando corría dentro del runner después de un build. En producción la
  // variable no está puesta y no cambia nada.
  const devDistDir = process.env.MAGI_DEV_DIST_DIR?.trim();
  const app = next({
    dev: process.env.MAGI_DEV === "1",
    hostname,
    port,
    ...(devDistDir ? { conf: { distDir: devDistDir } } : {}),
  });
  const handler = app.getRequestHandler();
  await app.prepare();

  const server = http.createServer((req, res) => {
    // Primero se BORRA lo que vino del cliente, después se escribe el valor
    // real. Si solo se sobreescribiera, un header duplicado podría colarse.
    const headers = req.headers;
    delete headers["x-magi-peer"];
    delete headers["x-magi-peer-addr"];
    headers["x-magi-peer"] = isLoopbackAddress(req.socket.remoteAddress) ? "loopback" : "remote";
    // La dirección real, para el rate limiting: rotar un header no la cambia.
    headers["x-magi-peer-addr"] = normalizeAddress(req.socket.remoteAddress) || "desconocido";

    handler(req, res).catch((error: unknown) => {
      res.statusCode = 500;
      res.end("Internal Server Error");
      console.error("[server] fallo al manejar el request:", error);
    });
  });

  server.on("upgrade", (req, socket, head) => {
    const headers = req.headers;
    // Mismo tratamiento que en el handler normal: se borra lo del cliente y
    // se escribe el valor real. Falta el `x-magi-peer-addr`, que es el que
    // se usa para el rate limiting.
    delete headers["x-magi-peer"];
    delete headers["x-magi-peer-addr"];
    headers["x-magi-peer"] = isLoopbackAddress(req.socket.remoteAddress) ? "loopback" : "remote";
    headers["x-magi-peer-addr"] = normalizeAddress(req.socket.remoteAddress) || "desconocido";
    void app.getUpgradeHandler()(req, socket, head).catch(() => socket.destroy());
  });

  server.listen(port, hostname, () => {
    const where = hostname === "127.0.0.1" || hostname === "localhost" ? "loopback" : "todas las interfaces";
    console.log(`[server] escuchando en http://${hostname}:${port} (${where})`);
    if (lanMode) {
      console.log("[server] modo LAN: el acceso local implícito está DESHABILITADO;");
      console.log("          toda request exige token de operador o dispositivo emparejado.");
    }
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      server.close(() => app.close().then(() => process.exit(0)));
    });
  }
}

void main();
