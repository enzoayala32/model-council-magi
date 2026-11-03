/**
 * Fase 1.2 — tests del login del token de acceso.
 *
 * Se prueban las piezas puras (cookie, comparación en tiempo constante y
 * la política del proxy para la ruta exenta). La ruta HTTP en sí se
 * verifica con el smoke de dev server, igual que el resto de `app/api/*`
 * (el repo no tiene harness de rutas HTTP: los tests son scripts tsx).
 *
 * Uso: npm run security:test-token-route
 */
import {
  APP_ACCESS_TOKEN_COOKIE,
  buildTokenCookie,
  constantTimeEqual,
  evaluateApiRequest,
  type ApiSecurityRequest,
} from "./api-security";

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passed += 1;
    console.log(`✅ ${label}`);
    return;
  }
  failed += 1;
  console.log(`❌ ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

const baseRequest: ApiSecurityRequest = {
  method: "POST",
  host: "localhost:3000",
  origin: "http://localhost:3000",
  secFetchSite: "same-origin",
  contentType: "application/json",
  authorization: null,
  cookie: null,
  hasBody: true,
};

function main(): void {
  console.log("== constantTimeEqual ==\n");

  check("dos cadenas iguales dan true", constantTimeEqual("secreto", "secreto"));
  check("cadenas distintas dan false", !constantTimeEqual("secreto", "secreta"));
  check("distinta longitud da false (sin error)", !constantTimeEqual("secreto", "secreto-largo"));
  check("vacía contra vacía da true", constantTimeEqual("", ""));
  check("vacía contra no vacía da false", !constantTimeEqual("", "x"));
  check("diferencia en el primer carácter da false", !constantTimeEqual("xcretos", "secretos"));
  check("diferencia en el último carácter da false", !constantTimeEqual("secretn", "secreto"));
  check("case sensitive", !constantTimeEqual("Secreto", "secreto"));
  check("distintos caracteres, misma longitud", !constantTimeEqual("aaaaaaaa", "aaaaaaab"));
  check("se ejecuta sin lanzar con unicode", constantTimeEqual("ñ-🎯", "ñ-🎯"));

  console.log("\n== buildTokenCookie ==\n");

  const httpCookie = buildTokenCookie("mi-token", { secure: false });
  check("incluye el nombre de cookie", httpCookie.startsWith(`${APP_ACCESS_TOKEN_COOKIE}=`));
  check("el valor va encodeado", httpCookie.includes("mi-token"));
  check("marca HttpOnly", httpCookie.includes("HttpOnly"));
  check("marca SameSite=Strict", httpCookie.includes("SameSite=Strict"));
  check("marca Path=/", httpCookie.includes("Path=/"));
  check("marca Max-Age", httpCookie.includes("Max-Age="));
  check("sin https no agrega Secure", !httpCookie.includes("Secure"));

  const httpsCookie = buildTokenCookie("mi-token", { secure: true });
  check("con https agrega Secure", httpsCookie.includes("Secure"));
  check("Secure va como atributo suelto", !httpsCookie.includes("Secure;"));

  const encoded = buildTokenCookie("to ken/con=simbolos", { secure: false });
  check("un token con símbolos se encodea", encoded.includes(`${APP_ACCESS_TOKEN_COOKIE}=`));
  check("el valor encodeado no tiene espacios crudos", !/=[^;]*[^;] /.test(encoded.split(";")[0]));
  check(
    "el valor encodeado se puede leer de vuelta",
    decodeURIComponent(encoded.split(";")[0].slice(APP_ACCESS_TOKEN_COOKIE.length + 1)) === "to ken/con=simbolos",
  );

  console.log("\n== ruta exenta en la política del proxy ==\n");

  // El login existe para canjear el token: se salta el chequeo de token.
  check(
    "POST /api/auth/token sin token es permitido (exento)",
    evaluateApiRequest({ ...baseRequest, tokenExempt: true }, { APP_ACCESS_TOKEN: "secreto" }).ok,
  );
  check(
    "POST /api/auth/token sigue exigiendo JSON",
    (() => {
      const decision = evaluateApiRequest(
        { ...baseRequest, tokenExempt: true, contentType: "text/plain" },
        { APP_ACCESS_TOKEN: "secreto" },
      );
      return !decision.ok && decision.reason === "content-type";
    })(),
  );
  check(
    "POST /api/auth/token sigue exigiendo Origin válido",
    (() => {
      const decision = evaluateApiRequest(
        { ...baseRequest, tokenExempt: true, origin: "http://evil.example" },
        { APP_ACCESS_TOKEN: "secreto" },
      );
      return !decision.ok && decision.reason === "origin";
    })(),
  );
  check(
    "POST /api/auth/token sigue exigiendo Host válido",
    (() => {
      const decision = evaluateApiRequest(
        { ...baseRequest, tokenExempt: true, host: "evil.example" },
        { APP_ACCESS_TOKEN: "secreto" },
      );
      return !decision.ok && decision.reason === "host";
    })(),
  );
  check(
    "GET /api/auth/token sin token es permitido (exento)",
    evaluateApiRequest(
      { ...baseRequest, method: "GET", origin: null, secFetchSite: null, contentType: null, hasBody: false, tokenExempt: true },
      { APP_ACCESS_TOKEN: "secreto" },
    ).ok,
  );
  // Sin exención, una ruta cualquiera sigue bloqueada.
  check(
    "otra ruta sin token sigue bloqueada",
    (() => {
      const decision = evaluateApiRequest(baseRequest, { APP_ACCESS_TOKEN: "secreto" });
      return !decision.ok && decision.reason === "token";
    })(),
  );
  // Y la cookie que escribe el login desbloquea el resto.
  check(
    "la cookie que escribe el login desbloquea el resto",
    (() => {
      const cookie = buildTokenCookie("secreto", { secure: false }).split(";")[0];
      return evaluateApiRequest({ ...baseRequest, cookie }, { APP_ACCESS_TOKEN: "secreto" }).ok;
    })(),
  );
  check(
    "la cookie con el token equivocado no desbloquea",
    (() => {
      const cookie = `${APP_ACCESS_TOKEN_COOKIE}=otro`;
      const decision = evaluateApiRequest({ ...baseRequest, cookie }, { APP_ACCESS_TOKEN: "secreto" });
      return !decision.ok && decision.reason === "token";
    })(),
  );

  console.log("\n== decisiones del endpoint ==\n");

  // La política de "sin token configurado, OK" y "token inválido, 403".
  function loginOutcome(bodyToken: string, configured: string): { status: number } {
    const submitted = bodyToken.trim();
    const expected = configured.trim();
    if (!expected) return { status: 200 };
    if (!constantTimeEqual(submitted, expected)) return { status: 403 };
    return { status: 200 };
  }
  check("sin token configurado responde 200 (no filtra configuración)", loginOutcome("cualquiera", "").status === 200);
  check("token correcto responde 200", loginOutcome("secreto", "secreto").status === 200);
  check("token incorrecto responde 403", loginOutcome("otro", "secreto").status === 403);
  check("token vacío responde 403 si hay uno configurado", loginOutcome("", "secreto").status === 403);
  check("se recortan espacios al comparar", loginOutcome("  secreto  ", "secreto").status === 200);

  console.log(`\n${passed}/${passed + failed} casos OK`);
  if (failed > 0) process.exit(1);
}

main();
