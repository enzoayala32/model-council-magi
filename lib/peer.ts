/**
 * Peer real de la conexión, decidido por el server, no por el cliente.
 *
 * POR QUE NO SE USA `Host`: `Host` es un header que manda el cliente.
 * Cualquiera conectado desde una IP que no es loopback puede poner
 * `Host: localhost:3000` y el server se lo cree. Eso alcanzaba para colar
 * "acceso local implícito" (sin ninguna credencial) desde la LAN o desde
 * internet, incluido generar y canjear códigos de emparejamiento.
 *
 * La dirección del peer, en cambio, la fija el kernel cuando acepta la
 * conexión TCP: no viaja en ningún header y el cliente no puede elegirla.
 * `server.ts` la lee de `req.socket.remoteAddress`, BORRA cualquier
 * `x-magi-peer` que haya mandado el cliente y escribe el valor real.
 *
 * Fail-closed: si el header no está (porque el server no es el nuestro, o
 * porque se llama al handler directo en un test), el peer es `unknown`, que
 * NO es loopback. Se prefiere romper el acceso implícito a dejarlo abierto.
 */

export const PEER_HEADER = "x-magi-peer";

export type PeerKind = "loopback" | "remote" | "unknown";

/** Lee el peer tal como lo dejó `server.ts`. */
export function peerKind(request: { headers: { get(name: string): string | null } }): PeerKind {
  const value = request.headers.get(PEER_HEADER)?.trim().toLowerCase();
  if (value === "loopback") return "loopback";
  if (value === "remote") return "remote";
  return "unknown";
}

/** ¿Es loopback VERIFICADO por el kernel? `Host` no entra en esta cuenta. */
export function isVerifiedLoopback(request: { headers: { get(name: string): string | null } }): boolean {
  return peerKind(request) === "loopback";
}

/**
 * El acceso local implícito (sin ninguna credencial) solo se concede con
 * peer verificado. `MAGI_DISABLE_LOCAL_IMPLICIT=1` lo apaga también en
 * loopback: es el modo `start:lan`, donde tampoco localhost debería poder
 * entrar sin autenticarse.
 */
export function allowsLocalImplicit(request: { headers: { get(name: string): string | null } }): boolean {
  if (process.env.MAGI_DISABLE_LOCAL_IMPLICIT === "1") return false;
  return isVerifiedLoopback(request);
}
