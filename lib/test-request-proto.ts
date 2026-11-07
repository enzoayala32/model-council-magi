/**
 * Fase 5.5 — tests del atributo `Secure` de las cookies detrás de un túnel.
 *
 * Cubre las dos piezas y las dos rutas que la usan:
 *
 *  - `isHttpsRequest` (lógica pura): `X-Forwarded-Proto`, `Forwarded`
 *    (RFC 7239) y `X-Forwarded-Ssl`, con listas, mayúsculas y basura.
 *  - `POST /api/auth/token`: la cookie de sesión del operador lleva `Secure`
 *    solo cuando la request vino por HTTPS.
 *  - `POST /api/pairing/redeem`: la cookie de dispositivo, igual.
 *
 * La regla que se fija: en HTTP plano NUNCA se marca `Secure` (el navegador
 * descartaría la cookie y el login fallaría sin explicación), y con HTTPS
 * SIEMPRE se marca (si no, la cookie viajaría sin cifrar por el túnel).
 *
 * Corre contra una DB aislada. Uso: npm run security:test-request-proto
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { httpsSignal, isHttpsRequest } from "./auth/request-proto";
import { APP_ACCESS_TOKEN_COOKIE } from "./api-security";
import { OPERATOR_COOKIE_NAME } from "./auth/operator-session";
import { createPairingCode } from "./auth/pairing";
import { DEVICE_COOKIE } from "./auth/devices";

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passed += 1;
    console.log("+ " + label);
    return;
  }
  failed += 1;
  const suffix = detail === undefined ? "" : " - " + JSON.stringify(detail);
  console.log("x " + label + suffix);
}

function reqWith(headers: Record<string, string>): { headers: { get(name: string): string | null } } {
  const lower: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) lower[key.toLowerCase()] = value;
  return { headers: { get: (name: string) => lower[name.toLowerCase()] ?? null } };
}

if (!process.env.MAGI_DATA_DIR) {
  process.env.MAGI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "magi-proto-test-"));
}

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const OP_TOKEN = "token-maestro-proto";

function setCookieOf(response: Response): string {
  // `Headers.getSetCookie` si existe (Node 18.14+/undici), si no el campo único.
  const multiple = (response.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
  const values = typeof multiple === "function" ? multiple.call(response.headers) : null;
  if (values && values.length > 0) return values.join(" | ");
  return response.headers.get("set-cookie") ?? "";
}

async function main(): Promise<void> {
  const saved = process.env.APP_ACCESS_TOKEN;
  process.env.APP_ACCESS_TOKEN = OP_TOKEN;

  console.log("== isHttpsRequest: que header cuenta ==\n");
  check("sin headers no es https", !isHttpsRequest(reqWith({})));
  check("http plano no es https", !isHttpsRequest(reqWith({ "x-forwarded-proto": "http" })));
  check("x-forwarded-proto: https sí", isHttpsRequest(reqWith({ "x-forwarded-proto": "https" })));
  check("HTTPS en mayúsculas también", isHttpsRequest(reqWith({ "X-Forwarded-Proto": "HTTPS" })));
  check("lista: manda el primero (https, http)", isHttpsRequest(reqWith({ "x-forwarded-proto": "https, http" })));
  check("lista: el primero http no es https", !isHttpsRequest(reqWith({ "x-forwarded-proto": "http, https" })));
  check("con espacios alrededor", isHttpsRequest(reqWith({ "x-forwarded-proto": "  https  " })));
  check("basura no es https", !isHttpsRequest(reqWith({ "x-forwarded-proto": "httpts" })));
  check("Forwarded RFC 7239 proto=https", isHttpsRequest(reqWith({ forwarded: "proto=https;for=1.2.3.4" })));
  check("Forwarded con proto=http no", !isHttpsRequest(reqWith({ forwarded: "proto=http;for=1.2.3.4" })));
  check("Forwarded entre varios elementos", isHttpsRequest(reqWith({ forwarded: "for=1.2.3.4;host=x;proto=https" })));
  check("x-forwarded-ssl: on", isHttpsRequest(reqWith({ "x-forwarded-ssl": "on" })));
  check("x-forwarded-ssl: off no", !isHttpsRequest(reqWith({ "x-forwarded-ssl": "off" })));
  check("httpsSignal informa cuál fue", httpsSignal(reqWith({ "x-forwarded-proto": "https" })) === "x-forwarded-proto");
  check("httpsSignal para RFC 7239", httpsSignal(reqWith({ forwarded: "proto=https" })) === "forwarded");
  check("httpsSignal sin señal", httpsSignal(reqWith({})) === "ninguno");
  check(
    "x-forwarded-for NO inventa https (no se usa para nada de esto)",
    !isHttpsRequest(reqWith({ "x-forwarded-for": "9.9.9.9" })),
  );

  console.log("\n== POST /api/auth/token: cookie de sesion del operador ==\n");
  const loginModule = (await import(
    pathToFileURL(path.join(REPO_ROOT, "app", "api", "auth", "token", "route.ts")).href
  )) as unknown as { POST(request: Request): Promise<Response> };

  const loginRequest = (headers: Record<string, string>) =>
    new Request("http://localhost/api/auth/token", {
      method: "POST",
      headers: {
        host: "localhost:3000",
        "x-magi-peer": "remote",
        "x-magi-peer-addr": "192.168.0.50",
        "content-type": "application/json",
        origin: "http://localhost:3000",
        ...headers,
      },
      body: JSON.stringify({ token: OP_TOKEN }),
    });

  const overHttp = await loginModule.POST(loginRequest({}));
  const httpCookie = setCookieOf(overHttp);
  check("el login por HTTP funciona", overHttp.status === 200, overHttp.status);
  check("setea la cookie de sesión", httpCookie.startsWith(OPERATOR_COOKIE_NAME + "="), httpCookie.slice(0, 60));
  check("por HTTP NO marca Secure", !httpCookie.includes("Secure"), httpCookie.slice(0, 120));
  check("por HTTP sigue siendo HttpOnly", httpCookie.includes("HttpOnly"));

  const overHttps = await loginModule.POST(loginRequest({ "x-forwarded-proto": "https" }));
  const httpsCookie = setCookieOf(overHttps);
  check("el login por HTTPS funciona", overHttps.status === 200, overHttps.status);
  check("por HTTPS marca Secure", httpsCookie.includes("Secure"), httpsCookie.slice(0, 160));
  check(
    "el valor de la cookie sigue siendo opaco (no el token maestro)",
    !httpsCookie.includes(OP_TOKEN),
    httpsCookie.slice(0, 80),
  );
  check("el nombre de cookie es el esperado", httpsCookie.startsWith(OPERATOR_COOKIE_NAME + "="));

  console.log("\n== POST /api/pairing/redeem: cookie de dispositivo ==\n");
  const redeemModule = (await import(
    pathToFileURL(path.join(REPO_ROOT, "app", "api", "pairing", "redeem", "route.ts")).href
  )) as unknown as { POST(request: Request): Promise<Response> };

  const redeemRequest = (headers: Record<string, string>, code: string) =>
    new Request("http://localhost/api/pairing/redeem", {
      method: "POST",
      headers: {
        host: "localhost:3000",
        "x-magi-peer": "remote",
        "x-magi-peer-addr": "192.168.0.50",
        "content-type": "application/json",
        origin: "http://localhost:3000",
        ...headers,
      },
      body: JSON.stringify({ code, deviceName: "Teléfono de prueba" }),
    });

  const plainCode = createPairingCode("observe");
  const plainRedeem = await redeemModule.POST(redeemRequest({}, plainCode.code));
  const plainDeviceCookie = setCookieOf(plainRedeem);
  check("el canje por HTTP funciona", plainRedeem.status === 200, { status: plainRedeem.status, body: await plainRedeem.clone().text().catch(() => "") });
  check("setea la cookie de dispositivo", plainDeviceCookie.startsWith(DEVICE_COOKIE + "="), plainDeviceCookie.slice(0, 60));
  check("por HTTP NO marca Secure", !plainDeviceCookie.includes("Secure"), plainDeviceCookie.slice(0, 120));
  check("por HTTP sigue siendo HttpOnly y SameSite=Strict", plainDeviceCookie.includes("HttpOnly") && plainDeviceCookie.includes("SameSite=Strict"));

  const httpsCode = createPairingCode("observe");
  const httpsRedeem = await redeemModule.POST(redeemRequest({ "x-forwarded-proto": "https" }, httpsCode.code));
  const httpsDeviceCookie = setCookieOf(httpsRedeem);
  check("el canje por HTTPS funciona", httpsRedeem.status === 200, httpsRedeem.status);
  check("por HTTPS marca Secure", httpsDeviceCookie.includes("Secure"), httpsDeviceCookie.slice(0, 160));
  check("el token de dispositivo no se filtra en el cuerpo", !(await httpsRedeem.text()).includes(httpsCode.code));

  console.log("\n== las cookies opacas no se confunden ==\n");
  check(
    "la cookie de operador y la de dispositivo son nombres distintos",
    String(OPERATOR_COOKIE_NAME) !== String(DEVICE_COOKIE),
    { operador: OPERATOR_COOKIE_NAME, dispositivo: DEVICE_COOKIE },
  );
  check(
    "el nombre de cookie del operador es el histórico",
    OPERATOR_COOKIE_NAME === APP_ACCESS_TOKEN_COOKIE,
    { operador: OPERATOR_COOKIE_NAME },
  );

  if (saved === undefined) delete process.env.APP_ACCESS_TOKEN;
  else process.env.APP_ACCESS_TOKEN = saved;

  console.log("");
  console.log(passed + "/" + (passed + failed) + " casos OK");
  if (failed > 0) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
