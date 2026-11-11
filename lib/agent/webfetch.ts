/**
 * P1 de paridad con OpenCode — `webfetch` para el Coding Agent.
 *
 * QUÉ FALTABA: el agente tenía `web_search` (Tavily) pero ninguna forma de ir a
 * buscar UNA página concreta —la doc de una librería, el changelog de una
 * dependencia, el contenido de un issue—. OpenCode tiene `webfetch`, que pide
 * una URL y devuelve markdown/text/html.
 *
 * SEGURIDAD: no se reescribió la protección anti-SSRF, se REUSA la que ya tiene
 * el transporte HTTP de MCP (`lib/mcp/pinned-http.ts` + `http-transport.ts`),
 * que es exactamente el mismo problema: una URL que da un agente controlado por
 * un modelo. Concretamente, acá se aplica:
 *
 *  - Solo `https:` (y `http:` únicamente si `MAGI_WEBFETCH_ALLOW_LOCAL=1`, para
 *    un servidor local de desarrollo).
 *  - Sin credenciales en la URL, sin fragmento.
 *  - IPs privadas, loopback, link-local y de metadata de nube (169.254.169.254)
 *    RECHAZADAS, tanto si vienen literales como si salen del DNS.
 *  - **La IP se resuelve UNA vez y se conecta a ESA**, con el `Host` y el
 *    `servername` del SNI con el nombre original: sin eso, entre validar y
 *    pedir cabría un DNS-rebinding (la ventana que cerró la Etapa 0.3).
 *  - Redirects: se siguen, pero **revalidando y re-fijando la IP en cada salto**
 *    (un redirect a 169.254.169.254 es el ataque clásico). Topo de 5 saltos.
 *  - La respuesta se trata como DATO NO CONFIABLE, igual que la salida de MCP y
 *    que los resultados de `web_search`: si la página trae texto que parece una
 *    orden, es contenido a ignorar, no algo que obedecer.
 *
 * DEL FORMATO: no hay dependencia nueva (el repo no usa ninguna librería de
 * HTML). `htmlATexto` es un extractor mínimo y honesto: saca `<script>`/`<style>`
 * y el resto de las etiquetas, y colapsa el espacio. NO produce markdown, no
 * conserva los enlaces como URLs y no entiende estructura: eso queda dicho en
 * la descripción de la tool para que el modelo no espere más de lo que hay.
 */

import https from "node:https";
import http from "node:http";
import { preparePinnedRequest, type PinnedRequest, type RawResponse } from "../mcp/pinned-http";

/** Timeout por pedido. Mismo orden que el de web_search: backstop, no la meta. */
export const WEBFETCH_TIMEOUT_MS = 20_000;

/** Tope de saltos de redirect. */
export const MAX_REDIRECTS = 5;

/** Tope del body crudo: una página de 20 MB no es una página. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Tope del texto que se le devuelve al modelo. */
export const MAX_RESULT_CHARS = 60_000;

export type WebfetchResult =
  | {
      ok: true;
      /** Texto final (ya recortado si hizo falta). */
      text: string;
      /** URL final, tras los redirects. */
      finalUrl: string;
      contentType: string;
      truncated: boolean;
      redirects: number;
    }
  | { ok: false; error: string; /** URL final alcanzada, si se llegó a alguna. */ finalUrl?: string };

export type WebfetchOptions = {
  /** `text` (default) extrae texto de HTML; `html` devuelve el cuerpo crudo. */
  format?: "text" | "html";
  /** Inyección para tests. */
  requestImpl?: (pinned: PinnedRequest, opts: { timeoutMs: number }) => Promise<RawResponse>;
  /** Para pruebas: permite http:// y loopback. */
  allowLocal?: boolean;
  /** Resolución inyectable (tests). Mismo seam que el transporte MCP: sin esto,
   *  un test que toca los caminos de rechazo de DNS necesita resolver nombres
   *  reales. */
  resolve?: (host: string) => Promise<string[]>;
};

/** GET contra la IP fijada, con Host y SNI correctos (el mismo truco que
 *  `postPinned`, pero sin body). */
function getPinned(
  pinned: PinnedRequest,
  opts: {
    headers: Record<string, string>;
    timeoutMs: number;
    requestImpl?: (pinned: PinnedRequest, opts: { timeoutMs: number }) => Promise<RawResponse>;
  },
): Promise<RawResponse> {
  if (opts.requestImpl) return opts.requestImpl(pinned, opts);

  const isHttps = pinned.url.protocol === "https:";
  const port = pinned.url.port ? Number(pinned.url.port) : isHttps ? 443 : 80;
  const headers: Record<string, string> = {
    ...opts.headers,
    host: pinned.url.host,
    accept: "text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.7",
    "user-agent": "consenso-ia-coding-agent/webfetch",
  };

  return new Promise<RawResponse>((resolve, reject) => {
    const modulo = isHttps ? https : http;
    const opciones = isHttps
      ? { hostname: pinned.ip, port, path: pinned.url.pathname + pinned.url.search, method: "GET", headers, servername: pinned.hostname }
      : { hostname: pinned.ip, port, path: pinned.url.pathname + pinned.url.search, method: "GET", headers };

    const req = modulo.request(opciones as never, (res) => {
      const chunks: Buffer[] = [];
      let total = 0;
      res.on("data", (chunk: Buffer) => {
        total += chunk.byteLength;
        if (total > MAX_BODY_BYTES) {
          req.destroy(new Error(`la respuesta pasa de ${MAX_BODY_BYTES} bytes`));
          return;
        }
        chunks.push(chunk);
      });
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
    req.end();
  });
}

/** ¿Es un status de redirect? */
function esRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * Baja UNA url y devuelve su texto. Sigue los redirects revalidando y re-fijando
 * la IP en cada salto (ver el comentario de arriba: un redirect es la vía clásica
 * para llegar a un rango interno).
 */
export async function webfetch(rawUrl: string, options: WebfetchOptions = {}): Promise<WebfetchResult> {
  let urlActual = rawUrl;
  let saltos = 0;

  for (;;) {
    const pinned = await preparePinnedRequest(urlActual, {
      // El DNS ya lo resolvió `resolveAndPin`: revalidar acá volvería a abrir la
      // ventana de rebinding (misma razón que en el transporte de MCP).
      skipDns: true,
      ...(options.allowLocal ? { allowInsecureLocal: true } : {}),
      ...(options.resolve ? { resolve: options.resolve } : {}),
    });
    if (!pinned.ok) return { ok: false, error: reasonAEspanol(pinned.reason) };

    let respuesta: RawResponse;
    try {
      respuesta = await getPinned(pinned.request, {
        headers: {},
        timeoutMs: WEBFETCH_TIMEOUT_MS,
        ...(options.requestImpl ? { requestImpl: options.requestImpl } : {}),
      });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error), finalUrl: urlActual };
    }

    if (esRedirect(respuesta.status)) {
      const destino = respuesta.headers.location;
      if (!destino) return { ok: false, error: `Redirect ${respuesta.status} sin header Location.`, finalUrl: urlActual };
      if (saltos >= MAX_REDIRECTS) return { ok: false, error: `Demasiados redirects (tope ${MAX_REDIRECTS}).`, finalUrl: urlActual };
      saltos += 1;
      try {
        // Un Location relativo se resuelve contra la URL actual: es lo normal y
        // no hay razón para rechazarlo.
        urlActual = new URL(destino, urlActual).toString();
      } catch {
        return { ok: false, error: "El destino del redirect no es una URL válida.", finalUrl: urlActual };
      }
      continue;
    }

    const contentType = respuesta.headers["content-type"] ?? "";
    const crudo = respuesta.body.toString("utf8");

    if (respuesta.status >= 400) {
      return { ok: false, error: `El servidor respondió ${respuesta.status}.`, finalUrl: urlActual };
    }

    let texto: string;
    if (options.format === "html" || contentType.includes("text/html") === false) {
      // Lo que no es HTML se devuelve tal cual: para JSON o texto plano, cualquier
      // "extracción" sería corrupción.
      texto = crudo;
    } else {
      texto = htmlATexto(crudo);
    }

    const truncado = texto.length > MAX_RESULT_CHARS;
    if (truncado) texto = texto.slice(0, MAX_RESULT_CHARS);
    return { ok: true, text: texto, finalUrl: urlActual, contentType, truncated: truncado, redirects: saltos };
  }
}

/** Motivos de `validateHttpTransport` en español, para que el modelo sepa qué
 *  pasó y no reintente lo mismo. */
function reasonAEspanol(reason: string): string {
  switch (reason) {
    case "protocol":
      return "Solo se permiten URLs https (o http con MAGI_WEBFETCH_ALLOW_LOCAL=1 para un servidor local).";
    case "credentials":
      return "La URL no puede llevar usuario ni contraseña.";
    case "private-address":
      return "La dirección es privada, de loopback, link-local o de metadata de nube: no se baja (anti-SSRF).";
    case "malformed":
      return "La URL está mal formada.";
    case "dns":
      return "No se pudo resolver el hostname.";
    default:
      return "URL rechazada: " + reason;
  }
}

/**
 * Extractor mínimo de HTML → texto. Sin dependencias, y a cambio de eso:
 *   - saca `<script>`, `<style>`, `<head>` y los comentarios;
 *   - el resto de las etiquetas se reemplazan por salto de línea (así no se pegan
 *     palabras de un tag con el texto siguiente);
 *   - colapsa espacios y limpia líneas vacías de más.
 * No produce markdown ni conserva los `href` como URLs: la descripción de la
 * tool lo dice, para que el modelo no espere más.
 */
export function htmlATexto(html: string): string {
  const sinBasura = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, "");
  const conSaltos = sinBasura
    .replace(/<\/(p|div|section|article|header|footer|li|ul|ol|tr|h[1-6]|blockquote|pre|br)\s*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "\n");
  return conSaltos
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .split("\n")
    .map((linea) => linea.replace(/[ \t]+/g, " ").trim())
    .filter((linea, indice, todas) => linea.length > 0 || (indice > 0 && todas[indice - 1].length > 0))
    .join("\n")
    .trim();
}
