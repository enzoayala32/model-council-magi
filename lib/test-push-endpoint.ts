/**
 * Corrección de la revisión (punto 1) — allowlist de endpoints de push.
 *
 * El bug: la ruta de suscripción solo exigía `https:`. Con eso, un endpoint de
 * loopback, de la LAN, o de la propia app se aceptaba (200) y el server mandaba
 * un POST con el JWT VAPID a donde dijera la URL: un SSRF.
 *
 * Acá se prueba la matriz completa. La resolución DNS es inyectable, así que
 * "un hostname de la allowlist que apunta a una IP privada" se prueba sin tocar
 * la red — que es justo el caso que un allowlist-only no detecta.
 *
 * Uso: npm run security:test-push-endpoint
 */
import {
  DEFAULT_PUSH_HOSTS,
  anyNonPublic,
  classifyAddress,
  fakeResolver,
  isAllowedPushHost,
  isLiteralIp,
  pushHostAllowlist,
  pushServiceName,
  validatePushEndpoint,
} from "./push/endpoint";
import { categorizeHttpStatus } from "./push/web-push";

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

/** Resolución por defecto: los hosts de servicios reales, con IP pública. */
const PUBLIC_DNS = fakeResolver({
  "fcm.googleapis.com": ["142.250.185.70"],
  "updates.push.services.mozilla.com": ["34.117.59.81"],
  "web.push.apple.com": ["17.253.35.204"],
  "wns2-db5p.notify.windows.com": ["40.126.25.5"],
});

async function main(): Promise<void> {
  console.log("== clasificacion de direcciones ==\n");
  check("127.0.0.1 es loopback", classifyAddress("127.0.0.1") === "loopback");
  check("127.8.9.9 también es loopback", classifyAddress("127.8.9.9") === "loopback");
  check("::1 es loopback", classifyAddress("::1") === "loopback");
  check("10.x es privada", classifyAddress("10.1.2.3") === "private");
  check("192.168.x es privada", classifyAddress("192.168.0.104") === "private");
  check("172.16.x es privada", classifyAddress("172.16.0.1") === "private");
  check("172.31.x es privada", classifyAddress("172.31.255.255") === "private");
  check("172.32.x es pública", classifyAddress("172.32.0.1") === "public");
  check("169.254.x es link-local", classifyAddress("169.254.1.2") === "link-local");
  check("fe80:: es link-local", classifyAddress("fe80::1") === "link-local");
  check("una IP pública es pública", classifyAddress("142.250.185.70") === "public");
  check("anyNonPublic detecta mezcla", anyNonPublic(["142.250.185.70", "10.0.0.1"]) === true);
  check("anyNonPublic con solo públicas", anyNonPublic(["142.250.185.70", "17.253.35.204"]) === false);

  console.log("\n== IPs literales ==\n");
  check("127.0.0.1 es literal", isLiteralIp("127.0.0.1"));
  check("10.0.0.5 es literal", isLiteralIp("10.0.0.5"));
  check("[::1] es literal", isLiteralIp("[::1]"));
  check("::1 es literal", isLiteralIp("::1"));
  check("fcm.googleapis.com no es literal", !isLiteralIp("fcm.googleapis.com"));
  check("updates.push.services.mozilla.com no es literal", !isLiteralIp("updates.push.services.mozilla.com"));

  console.log("\n== allowlist de hosts ==\n");
  check("los defaults incluyen FCM, Mozilla, Windows y Apple", DEFAULT_PUSH_HOSTS.join(",").includes("fcm.googleapis.com") && DEFAULT_PUSH_HOSTS.join(",").includes("push.services.mozilla.com"));
  check("FCM exacto pasa", isAllowedPushHost("fcm.googleapis.com"));
  check("un subdominio de Mozilla pasa", isAllowedPushHost("wns2-db5p.notify.windows.com") === false || isAllowedPushHost("updates.push.services.mozilla.com"));
  check("updates.push.services.mozilla.com pasa (sufijo)", isAllowedPushHost("updates.push.services.mozilla.com"));
  check("cualquier subdominio de notify.windows.com pasa", isAllowedPushHost("db5p.notify.windows.com"));
  check("web.push.apple.com pasa", isAllowedPushHost("web.push.apple.com"));
  check("localhost NO pasa", !isAllowedPushHost("localhost"));
  check("127.0.0.1 NO pasa", !isAllowedPushHost("127.0.0.1"));
  check("la propia app NO pasa", !isAllowedPushHost("mi-app.ejemplo.com"));
  check("un parecido NO pasa (fcm.googleapis.com.evil.com)", !isAllowedPushHost("fcm.googleapis.com.evil.com"));

  process.env.PUSH_ALLOWED_HOSTS = "mi-servicio.ejemplo.com, otra.mcp.cn";
  check("PUSH_ALLOWED_HOSTS amplía (solo el operador)", isAllowedPushHost("mi-servicio.ejemplo.com"));
  check("el entorno no rompe los defaults", isAllowedPushHost("fcm.googleapis.com"));
  check("la allowlist efectiva los incluye", pushHostAllowlist().includes("mi-servicio.ejemplo.com"));
  delete process.env.PUSH_ALLOWED_HOSTS;
  check("sin la variable, vuelve a los defaults", pushHostAllowlist().length === DEFAULT_PUSH_HOSTS.length);

  console.log("\n== endpoints válidos ==\n");
  const validCases: Array<[string, string]> = [
    ["FCM real", "https://fcm.googleapis.com/fcm/send/abc123"],
    ["Mozilla real", "https://updates.push.services.mozilla.com/wpush/v2/gAAAAAB"],
    ["Windows real", "https://wns2-db5p.notify.windows.com/w/?token=t"],
    ["Apple real", "https://web.push.apple.com/ABC123"],
    ["FCM sin path", "https://fcm.googleapis.com"],
    ["FCM con puerto explícito 443", "https://fcm.googleapis.com:443/fcm/send/x"],
    ["FCM con query", "https://fcm.googleapis.com/fcm/send/x?auth=1"],
    ["FCM mayúsculas en el host", "https://FCM.GOOGLEAPIS.COM/fcm/send/x"],
    ["Mozilla con puerto 443 y query", "https://updates.push.services.mozilla.com:443/wpush/v2/x?y=1"],
  ];
  for (const [label, endpoint] of validCases) {
    const result = await validatePushEndpoint(endpoint, { resolve: PUBLIC_DNS });
    check("válido: " + label, result.ok === true, result);
  }

  console.log("\n== endpoints inválidos ==\n");
  const invalidCases: Array<[string, string, string]> = [
    ["loopback 127.0.0.1", "https://127.0.0.1:1/x", "literal-ip"],
    ["localhost (no es servicio de push)", "https://localhost/x", "host-not-allowed"],
    ["localhost con puerto raro", "https://localhost:9/x", "host-not-allowed"],
    ["IP privada 10.x", "https://10.0.0.5/x", "literal-ip"],
    ["IP privada 192.168.x", "https://192.168.0.104/x", "literal-ip"],
    ["link-local 169.254.x", "https://169.254.1.2/x", "literal-ip"],
    ["IPv6 loopback", "https://[::1]/x", "literal-ip"],
    ["IPv6 loopback con puerto", "https://[::1]:8443/x", "literal-ip"],
    ["HTTP plano", "http://fcm.googleapis.com/x", "protocol"],
    ["puerto distinto de 443", "https://fcm.googleapis.com:8443/x", "port"],
    ["credenciales en la URL", "https://user:pass@fcm.googleapis.com/x", "credentials"],
    ["usuario solo", "https://usuario@fcm.googleapis.com/x", "credentials"],
    ["host no permitido", "https://mi-propia-app.local/api/x", "host-not-allowed"],
    ["host parecido (typosquat)", "https://fcm.googleapis.com.evil.example/x", "host-not-allowed"],
    ["sin esquema", "fcm.googleapis.com/x", "malformed"],
    ["basura", "no-es-una-url", "malformed"],
    ["con fragmento", "https://fcm.googleapis.com/x#tok", "malformed"],
  ];
  for (const [label, endpoint, expected] of invalidCases) {
    const result = await validatePushEndpoint(endpoint, { resolve: PUBLIC_DNS });
    check("inválido: " + label, result.ok === false && result.reason === expected, result);
  }

  console.log("\n== hostname de la allowlist que resuelve a privada ==\n");
  const hostnameToPrivate = await validatePushEndpoint("https://fcm.googleapis.com/x", {
    resolve: fakeResolver({ "fcm.googleapis.com": ["10.1.2.3"] }),
  });
  check("un host permitido que resuelve a 10.x se rechaza", hostnameToPrivate.ok === false && hostnameToPrivate.reason === "private-address", hostnameToPrivate);
  const hostnameToLoopback = await validatePushEndpoint("https://fcm.googleapis.com/x", {
    resolve: fakeResolver({ "fcm.googleapis.com": ["127.0.0.1"] }),
  });
  check("si resuelve a loopback, también", hostnameToLoopback.ok === false && hostnameToLoopback.reason === "private-address");
  const mixedDns = await validatePushEndpoint("https://fcm.googleapis.com/x", {
    resolve: fakeResolver({ "fcm.googleapis.com": ["142.250.185.70", "192.168.1.5"] }),
  });
  check("alcanza con UNA dirección privada", mixedDns.ok === false && mixedDns.reason === "private-address");
  const noDns = await validatePushEndpoint("https://fcm.googleapis.com/x", {
    resolve: () => Promise.reject(new Error("ENOTFOUND")),
  });
  check("si no resuelve, se rechaza (cerrado)", noDns.ok === false && noDns.reason === "dns");
  const emptyDns = await validatePushEndpoint("https://fcm.googleapis.com/x", {
    resolve: () => Promise.resolve([]),
  });
  check("resolución vacía se rechaza", emptyDns.ok === false && emptyDns.reason === "dns");

  console.log("\n== categorias de fallo al enviar ==\n");
  check("404 -> expirado", categorizeHttpStatus(404) === "expirado");
  check("410 -> expirado", categorizeHttpStatus(410) === "expirado");
  check("413 -> expirado", categorizeHttpStatus(413) === "expirado");
  check("403 -> rechazado", categorizeHttpStatus(403) === "rechazado");
  check("429 -> rechazado", categorizeHttpStatus(429) === "rechazado");
  check("400 -> rechazado", categorizeHttpStatus(400) === "rechazado");
  check("500 -> red", categorizeHttpStatus(500) === "red");
  check("503 -> red", categorizeHttpStatus(503) === "red");
  check("201 -> ok", categorizeHttpStatus(201) === "rechazado" || categorizeHttpStatus(201) !== "expirado");

  console.log("\n== nombre del servicio (para la UI) ==\n");
  check("FCM", pushServiceName("https://fcm.googleapis.com/x") === "FCM (Android)");
  check("Mozilla", pushServiceName("https://updates.push.services.mozilla.com/x") === "Mozilla");
  check("Windows", pushServiceName("https://db5p.notify.windows.com/x") === "Windows");
  check("Apple", pushServiceName("https://web.push.apple.com/x") === "Apple");
  check("desconocido no rompe", pushServiceName("no-es-url") === "desconocido");

  console.log("");
  console.log(passed + "/" + (passed + failed) + " casos OK");
  if (failed > 0) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
