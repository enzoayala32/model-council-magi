/**
 * Etapa 0.3 — pin de IP para el transporte HTTP de MCP (anti DNS-rebinding).
 *
 * La ventana que cierra: `validateHttpTransport()` resuelve el hostname, valida
 * que no sea privado, y DESPUÉS el cliente hace `fetch(url)` — que vuelve a
 * resolver, en otro momento. Un atacante con un nombre bajo su control puede
 * responder con una IP pública en la validación y una privada en la petición
 * real (rebinding). La ventana es chica pero real.
 *
 * El fix es el estándar: **resolver una vez y conectarse a ESA IP**, poniendo a
 * mano el `Host` (capa 7) y, para TLS, el `servername` del SNI (capa 6) con el
 * nombre original. Sin librerías: `node:https` acepta `hostname` + `servername`
 * separados desde siempre.
 *
 * - Si el hostname ya es una IP literal, se usa directo (no hay nada que
 *   resolver).
 * - Si la resolución falla, se devuelve el motivo (nunca se sigue con el
 *   nombre: sería reabrir la ventana).
 * - El resto de las garantías (allowlist, timeout, tope, sin redirects) siguen
 *   intactas.
 */

import https from "node:https";
import http from "node:http";
import dns from "node:dns/promises";
import { validateHttpTransport, resolveHeaderTemplates, anyBlockedAddress, type HttpTransportOptions } from "./http-transport";

/** Respuesta cruda del servidor (para no depender de fetch). */
export type RawResponse = {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
};

export type PinResult = { ok: true; ip: string } | { ok: false; reason: string };

/**
 * Resuelve el hostname y valida las IPs contra el anti-SSRF.
 * Devuelve la IP a la que hay que conectarse (o el motivo del rechazo).
 */
export async function resolveAndPin(rawUrl: string, options: HttpTransportOptions = {}): Promise<PinResult> {
  // 1) Validar lo estático (esquema, credenciales, puerto, allowlist) SIN
  //    resolver. Se pasa `skipDns` para que la validación no toque DNS.
  const check = await validateHttpTransport(rawUrl, { ...options, skipDns: true });
  if (!check.ok) return { ok: false, reason: check.reason };
  const host = check.url.hostname.replace(/^\[/, "").replace(/\]$/, "");

  // IP literal: no hay nada que resolver, y ya fue validada arriba.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return { ok: true, ip: host };
  if (host.includes(":") && /^[0-9a-fA-F:]+$/.test(host)) return { ok: true, ip: host };

  // 2) UNA sola resolución, y se validan esas direcciones. Sin esta separación,
  //    validar y pedir el pin eran dos llamadas al resolvedor: la ventana exacta
  //    del rebinding.
  const resolve = options.resolve;
  let direcciones: string[];
  try {
    direcciones = resolve ? await resolve(host) : await resolverReal(host);
  } catch {
    return { ok: false, reason: "dns" };
  }
  if (direcciones.length === 0) return { ok: false, reason: "dns" };
  if (anyBlockedAddress(direcciones)) return { ok: false, reason: "private-address" };

  // La primera: es la que se validó, y a la que se conecta el pedido.
  return { ok: true, ip: direcciones[0] };
}

async function resolverReal(host: string): Promise<string[]> {
  const out: string[] = [];
  await Promise.allSettled([
    dns.resolve4(host).then((rows) => out.push(...rows)),
    dns.resolve6(host).then((rows) => out.push(...rows)),
  ]);
  return out;
}

export type PinnedRequest = {
  /** IP real a la que conectarse. */
  ip: string;
  /** Nombre original: para el header Host y el SNI. */
  hostname: string;
  /** URL original (para path y query). */
  url: URL;
};

/** Prepara el pedido con la IP fijada. */
export async function preparePinnedRequest(
  rawUrl: string,
  options: HttpTransportOptions = {},
): Promise<{ ok: true; request: PinnedRequest } | { ok: false; reason: string }> {
  const pinned = await resolveAndPin(rawUrl, options);
  if (!pinned.ok) return { ok: false, reason: pinned.reason };
  const url = new URL(rawUrl);
  return {
    ok: true,
    request: {
      ip: pinned.ip,
      hostname: url.hostname,
      url,
    },
  };
}

/**
 * Hace el POST contra la IP fijada, con `Host` y (en TLS) `servername`
 * correctos. `timeoutMs` aborta la conexión.
 */
export function postPinned(
  pinned: PinnedRequest,
  opts: {
    payload: string;
    headers: Record<string, string>;
    timeoutMs: number;
    /** Inyección para tests: reemplaza el cliente HTTP real. */
    requestImpl?: (pinned: PinnedRequest, opts: { payload: string; headers: Record<string, string>; timeoutMs: number; requestImpl?: unknown }) => Promise<RawResponse>;
  },
): Promise<RawResponse> {
  if (opts.requestImpl) return opts.requestImpl(pinned, opts);

  const isHttps = pinned.url.protocol === "https:";
  const port = pinned.url.port ? Number(pinned.url.port) : isHttps ? 443 : 80;

  const headers: Record<string, string> = {
    ...opts.headers,
    // El nombre original, no la IP: muchos servicios de push/MCP enrutan por
    // Host, y sin esto el pedido caería en el default del servidor.
    host: pinned.url.host,
  };

  const body = Buffer.from(opts.payload, "utf8");
  headers["content-length"] = String(body.byteLength);

  return new Promise<RawResponse>((resolve, reject) => {
    const modulo = isHttps ? https : http;
    const opciones = isHttps
      ? { hostname: pinned.ip, port, path: rutaConQuery(pinned.url), method: "POST", headers, servername: pinned.hostname }
      : { hostname: pinned.ip, port, path: rutaConQuery(pinned.url), method: "POST", headers };

    const req = modulo.request(opciones as never, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const cabeceras: Record<string, string> = {};
        for (const [clave, valor] of Object.entries(res.headers)) {
          if (typeof valor === "string") cabeceras[clave] = valor;
        }
        resolve({ status: res.statusCode ?? 0, headers: cabeceras, body: Buffer.concat(chunks) });
      });
    });

    req.setTimeout(opts.timeoutMs, () => {
      req.destroy(new Error("timeout de " + opts.timeoutMs + "ms"));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function rutaConQuery(url: URL): string {
  return url.pathname + url.search;
}

/** Resuelve los headers de la config contra el entorno (mismo criterio). */
export function headersDesdeConfig(config: { httpHeaders?: Record<string, string> }): Record<string, string> {
  return resolveHeaderTemplates(config.httpHeaders ?? {}).headers;
}
