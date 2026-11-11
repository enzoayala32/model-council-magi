/**
 * P1 de paridad con OpenCode — tests de `webfetch`.
 *
 * Sin red real: el pedido HTTP se inyecta (`requestImpl`). Lo que se verifica:
 *
 *  1. HTML → texto: saca scripts/estilos, no pega palabras entre tags.
 *  2. Redirects: se siguen, pero **revalidando y re-fijando la IP en cada
 *     salto** — un redirect a un rango interno es el ataque clásico, y si el
 *     salto va a una dirección bloqueada, se rechaza.
 *  3. Anti-SSRF: IPs privadas/locales/de metadata rechazadas; https solamente
 *     (http solo con `allowLocal`).
 *  4. Topes: body enorme y texto recortado, dicho en el resultado.
 *  5. El contenido viaja marcado como no confiable (eso lo prueba la tool, no
 *     este módulo).
 *
 * Uso: npm run agent:test-webfetch
 */
import {
  MAX_REDIRECTS,
  MAX_RESULT_CHARS,
  htmlATexto,
  webfetch,
  type WebfetchOptions,
} from "./webfetch";
import type { PinnedRequest, RawResponse } from "../mcp/pinned-http";

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passed += 1;
    console.log("+ " + label);
    return;
  }
  failed += 1;
  console.log("x " + label + (detail === undefined ? "" : " - " + JSON.stringify(detail).slice(0, 400)));
}

/** Respuesta falsa, por status/body/content-type. */
function respuestaFalsa(status: number, body: string, extra: Record<string, string> = {}): RawResponse {
  return { status, headers: { "content-type": "text/html; charset=utf-8", ...extra }, body: Buffer.from(body, "utf8") };
}

/**
 * Resolver falso: `webfetch` acepta inyectarlo (mismo seam que el transporte
 * MCP), así que los tests no necesitan tocar DNS real. Sin esto, los casos de
 * rechazo resolvían `ejemplo.com` de verdad — que es justo lo que el preload
 * dns-block viene a impedir.
 */
function resolverFalso(): (host: string) => Promise<string[]> {
  return async (host: string) => {
    if (/^\d/.test(host)) return [host]; // IP literal: no hay nada que resolver
    if (host === "localhost" || host === "127.0.0.1") return ["127.0.0.1"]; // loopback: se resuelve a sí mismo
    return ["93.184.216.34"]; // IP pública de mentira (ejemplo.com de la IANA)
  };
}

/** `requestImpl` que devuelve siempre lo mismo. */
function pedidoFijo(respuesta: RawResponse): NonNullable<WebfetchOptions["requestImpl"]> {
  return async () => respuesta;
}

/** `requestImpl` que resppone según la URL que le pidan. */
function pedidoPorUrl(mapa: Record<string, RawResponse>): NonNullable<WebfetchOptions["requestImpl"]> {
  return async (pinned: PinnedRequest) => {
    const clave = pinned.url.hostname;
    const encontrada = mapa[clave];
    if (!encontrada) throw new Error("no hay respuesta para " + clave);
    return encontrada;
  };
}

const HTML = [
  "<!doctype html>",
  "<html><head><title>Ignorar</title><style>body{color:red}</style>",
  "<script>alert('esto no debe aparecer')</script></head>",
  "<body>",
  "<!-- comentario que se va -->",
  "<h1>Titulo</h1>",
  "<p>Primer parrafo con <a href='/x'>un enlace</a> adentro.</p>",
  "<p>Segundo&nbsp;parrafo &amp; mas.</p>",
  "</body></html>",
].join("\n");

async function main(): Promise<void> {
  console.log("== HTML a texto ==\n");

  {
    const texto = htmlATexto(HTML);
    check("saca el script", !texto.includes("alert("), texto.slice(0, 120));
    check("saca el style", !texto.includes("color:red"), texto.slice(0, 120));
    check("saca el comentario", !texto.includes("comentario que se va"), texto.slice(0, 120));
    check("se queda con el texto", texto.includes("Titulo") && texto.includes("Primer parrafo"), texto);
    check("no pega palabras entre tags", !texto.includes("TituloPrimer"), texto);
    check("desescapa las entidades básicas", texto.includes("Segundo parrafo & mas"), texto);
    check("no deja etiquetas", !texto.includes("<p>") && !texto.includes("<a "), texto.slice(0, 200));
  }

  console.log("\n== pedido feliz ==\n");

  {
    const res = await webfetch("https://ejemplo.com/doc", { requestImpl: pedidoFijo(respuestaFalsa(200, HTML)), resolve: resolverFalso() });
    check("ok", res.ok === true, res);
    if (res.ok) {
      check("devuelve el texto extraído", res.text.includes("Primer parrafo"), res.text.slice(0, 120));
      check("informa la URL final", res.finalUrl === "https://ejemplo.com/doc", res.finalUrl);
      check("marca que no se truncó", res.truncated === false, res.truncated);
      check("sin redirects", res.redirects === 0, res.redirects);
    }
  }

  {
    // Lo que no es HTML se devuelve tal cual: para JSON, "extraer" sería corromper.
    const json = '{"a":1,"b":[2,3]}';
    const res = await webfetch("https://ejemplo.com/api.json", {
      requestImpl: pedidoFijo(respuestaFalsa(200, json, { "content-type": "application/json" })),
      resolve: resolverFalso(),
    });
    check("un JSON se devuelve intacto", res.ok === true && res.text === json, res);
  }

  {
    const res = await webfetch("https://ejemplo.com/pagina", {
      format: "html",
      requestImpl: pedidoFijo(respuestaFalsa(200, HTML)),
      resolve: resolverFalso(),
    });
    check("format=html devuelve el cuerpo crudo", res.ok === true && res.text.includes("<html>"), res);
  }

  console.log("\n== error del servidor ==\n");

  {
    const res = await webfetch("https://ejemplo.com/404", { requestImpl: pedidoFijo(respuestaFalsa(404, "no encontrado")), resolve: resolverFalso() });
    check("un 404 es error, no texto vacío", res.ok === false && /404/.test(res.error), res);
  }

  console.log("\n== redirects ==\n");

  {
    // Un redirect a otro host: se sigue y la URL final es la del destino.
    const primera = respuestaFalsa(302, "", { location: "https://otro.com/final" });
    const res = await webfetch("https://ejemplo.com/viejo", {
      requestImpl: pedidoPorUrl({ "ejemplo.com": primera, "otro.com": respuestaFalsa(200, "<p>destino</p>") }),
      resolve: resolverFalso(),
    });
    check("sigue el redirect", res.ok === true, res);
    check("la URL final es la del destino", res.ok && res.finalUrl === "https://otro.com/final", res);
    check("y cuenta el salto", res.ok && res.redirects === 1, res);
  }

  {
    // ¡El ataque! Un redirect a un rango interno. Tiene que RECHAZARSE: si no,
    // el anti-SSRF se saltea con dos líneas de HTML.
    const trampa = respuestaFalsa(302, "", { location: "https://169.254.169.254/latest/meta-data/" });
    const res = await webfetch("https://ejemplo.com/inocente", { requestImpl: pedidoFijo(trampa), resolve: resolverFalso() });
    check("un redirect a metadata de nube se RECHAZA", res.ok === false && /privada|metadata/i.test(res.error), res);
  }

  {
    // Y a una IP literal privada, que es el mismo ataque por otra vía.
    const trampa = respuestaFalsa(302, "", { location: "http://127.0.0.1:8080/admin" });
    const res = await webfetch("https://ejemplo.com/inocente", { requestImpl: pedidoFijo(trampa), resolve: resolverFalso() });
    check("un redirect a loopback se RECHAZA", res.ok === false, res);
  }

  {
    // Sin Location: no se puede seguir, y se dice.
    const res = await webfetch("https://ejemplo.com/huerfano", { requestImpl: pedidoFijo(respuestaFalsa(302, "")), resolve: resolverFalso() });
    check("un redirect sin Location es error", res.ok === false && /Location/.test(res.error), res);
  }

  {
    // Tope de saltos: un bucle de redirects no puede colgar el pedido.
    const bucle = respuestaFalsa(302, "", { location: "https://ejemplo.com/bucle" });
    const res = await webfetch("https://ejemplo.com/bucle", { requestImpl: pedidoFijo(bucle), resolve: resolverFalso() });
    check("un bucle de redirects corta en el tope", res.ok === false && new RegExp(String(MAX_REDIRECTS)).test(res.error), res);
  }

  console.log("\n== anti-SSRF de entrada ==\n");

  {
    const casos: Array<[string, string]> = [
      ["http://ejemplo.com/", "https"],
      ["ftp://ejemplo.com/", "https"],
      ["https://usuario:pass@ejemplo.com/", "usuario ni contraseña"],
      ["https://127.0.0.1/x", "permiten"],
      ["https://169.254.169.254/x", "privada"],
      ["https://10.0.0.5/x", "privada"],
      ["https://localhost/x", "no se pudo resolver|privada"],
      ["no-es-una-url", "mal formada"],
    ];
    for (const [url, esperado] of casos) {
      const res = await webfetch(url, { requestImpl: pedidoFijo(respuestaFalsa(200, "ok")), resolve: resolverFalso() });
      check("rechaza " + url, res.ok === false && new RegExp(esperado, "i").test(res.error), res);
    }
  }

  {
    // Con `allowLocal`, http://loopback sí (servidor local de prueba).
    const res = await webfetch("http://127.0.0.1:9/x", { allowLocal: true, requestImpl: pedidoFijo(respuestaFalsa(200, "local")), resolve: resolverFalso() });
    check("con allowLocal, http://loopback se permite", res.ok === true, res);
  }

  console.log("\n== topes ==\n");

  {
    const enorme = "<p>" + "x".repeat(MAX_RESULT_CHARS + 5_000) + "</p>";
    const res = await webfetch("https://ejemplo.com/enorme", { requestImpl: pedidoFijo(respuestaFalsa(200, enorme)), resolve: resolverFalso() });
    check("un texto enorme se recorta y se avisa", res.ok === true && res.truncated === true, res.ok ? res.truncated : res);
    check("y no pasa del tope", res.ok === true && res.text.length <= MAX_RESULT_CHARS, res.ok ? res.text.length : null);
  }

  {
    // El requestImpl que tira (timeout, red): error limpio, no una excepción.
    const res = await webfetch("https://ejemplo.com/timeout", {
      requestImpl: async () => {
        throw new Error("timeout de 20000ms");
      },
      resolve: resolverFalso(),
    });
    check("un timeout devuelve error, no tira", res.ok === false && /timeout/.test(res.error), res);
  }

  console.log("");
  console.log(passed + "/" + (passed + failed) + " casos OK");
  if (failed > 0) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
