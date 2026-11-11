/**
 * Etapa 2.6 (punto 3b) — preload que rompe el DNS para los tests.
 *
 * POR QUÉ: `docs/CONTEXTO-AGENTE.md` decía que "la suite corre con un preload
 * que rompe el DNS no loopback" — y era mentira: el preload NO existía. El
 * síntoma real: `lib/agent/test-webfetch.ts` daba 17/30 sin DNS, porque sus
 * casos resolvían nombres reales para llegar a los caminos de rechazo.
 *
 * QUÉ HACE: rompe TODAS las vías de resolución que Node expone —
 *
 *  - `dns.lookup` (el que usa `fetch`/`http`/`https` por debajo: es el que
 *    importa de verdad, porque romper solo `resolve` no impediría que un test
 *    toque la red);
 *  - `dns.resolve`, `resolve4`, `resolve6`, `resolveAny`, `resolveCname`, ...;
 *  - `dns/promises`: `lookup`, `resolve`, `resolve4`, `resolve6`, `resolveAny`,
 *    `reverse`.
 *
 * Loopback (`127.0.0.0/8`, `::1`, `localhost`) sigue resolviendo: los tests
 * levantan servers locales contra `127.0.0.1` y tienen que poder hacerlo.
 *
 * Cualquier otro nombre falla con un error RUIDOSO que nombra el hostname: un
 * test que resuelve DNS real se ve al instante, no se disfraza de "fallo de red".
 *
 * Se instala desde `scripts/run-tests.ts` vía `NODE_OPTIONS=--require <ruta>`,
 * igual que la guardia de config MCP.
 *
 * NOTA DE IMPLEMENTACIÓN que costó un rato: hay que guardar los originales
 * ANTES de reemplazar, y la función de reemplazo tiene que llamar al ORIGINAL
 * guardado, no a `dns[name]` (que ya es el reemplazo: recursión infinita y
 * `RangeError: Maximum call stack size exceeded`). La primera versión tenía
 * justo ese bug.
 */

"use strict";

const dns = require("node:dns");
const dnsPromises = require("node:dns/promises");

const MENSAJE = (hostname) =>
  "[dns-block] El test intentó resolver DNS real (" + hostname + "). Los tests tienen que ser herméticos: " +
  "usá 127.0.0.1/localhost, o inyectá un resolver falso (ver lib/mcp/http-transport.ts y lib/agent/webfetch.ts).";

/**
 * ¿Es una dirección que no sale de esta máquina? Se permite resolverla.
 *
 * Además del loopback de siempre, `0.0.0.0` (comodín "cualquier interfaz"): el
 * server propio hace `dns.lookup("0.0.0.0")` cuando arranca en modo LAN
 * (`MAGI_BIND_HOST=0.0.0.0`), y bloquearlo hacía que `security:test-peer-spoof`
 * no pudiera levantar su server. No es un host remoto: es la dirección
 * comodín, y resolverla da la propia máquina.
 */
function esLocal(hostname) {
  if (typeof hostname !== "string") return false;
  const limpio = hostname.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (limpio === "localhost" || limpio === "::1" || limpio === "0:0:0:0:0:0:0:1") return true;
  if (limpio === "0.0.0.0" || limpio === "::" || limpio === "0:0:0:0:0:0:0:0") return true;
  if (/^127(\.\d{1,3}){3}$/.test(limpio)) return true;
  return false;
}

// --- dns (callbacks) -------------------------------------------------------
// Guardar TODOS los originales primero: si reemplazás mientras recorrés, un
// reemplazo puede llamar a otro que ya viene reemplazado.
const originales = {};
for (const nombre of Object.keys(dns)) {
  if (typeof dns[nombre] === "function") originales[nombre] = dns[nombre];
}

const NOMBRES = [
  "lookup", "resolve", "resolve4", "resolve6", "resolveAny", "resolveCname",
  "resolveMx", "resolveTxt", "resolveNs", "resolvePtr", "resolveSoa", "resolveSrv", "reverse",
];

for (const nombre of NOMBRES) {
  if (!originales[nombre]) continue;
  dns[nombre] = function (...args) {
    const hostname = args[0];
    if (!esLocal(hostname)) {
      // Los callbacks reciben el error por el primer argumento: así un test que
      // usa `dns.lookup(host, cb)` ve el fallo en su callback, no una excepción
      // que se pierde.
      const callback = typeof args[args.length - 1] === "function" ? args[args.length - 1] : null;
      if (callback) {
        callback(new Error(MENSAJE(String(hostname))));
        return;
      }
      throw new Error(MENSAJE(String(hostname)));
    }
    return originales[nombre].apply(dns, args);
  };
}

// --- dns/promises ----------------------------------------------------------
const originalesPromises = {};
for (const nombre of ["lookup", "resolve", "resolve4", "resolve6", "resolveAny", "reverse"]) {
  if (typeof dnsPromises[nombre] !== "function") continue;
  originalesPromises[nombre] = dnsPromises[nombre];
  dnsPromises[nombre] = async function (...args) {
    const hostname = args[0];
    if (!esLocal(hostname)) throw new Error(MENSAJE(String(hostname)));
    return originalesPromises[nombre].apply(dnsPromises, args);
  };
}

module.exports = { esLocal };
