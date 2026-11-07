import { evaluateApiRequest, type ApiSecurityDecision, type ApiSecurityEnv, type ApiSecurityRequest } from "./api-security";

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

function isOk(decision: ApiSecurityDecision): boolean {
  return decision.ok;
}

function isFailure(decision: ApiSecurityDecision, reason: string, status?: number): boolean {
  return !decision.ok && decision.reason === reason && (status === undefined || decision.status === status);
}

const baseEnv: ApiSecurityEnv = { PORT: "3000" };
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

function decide(
  request: Partial<ApiSecurityRequest> = {},
  env: Partial<ApiSecurityEnv> = {},
): ApiSecurityDecision {
  return evaluateApiRequest({ ...baseRequest, ...request }, { ...baseEnv, ...env });
}

function getRequest(overrides: Partial<ApiSecurityRequest> = {}): Partial<ApiSecurityRequest> {
  return {
    method: "GET",
    origin: null,
    secFetchSite: null,
    contentType: null,
    hasBody: false,
    ...overrides,
  };
}

async function main(): Promise<void> {
  // Host: defaults y allowlist configurable.
  check("GET con Host localhost:3000 permitido", isOk(decide(getRequest())));
  check("GET con Host 127.0.0.1:3000 permitido", isOk(decide(getRequest({ host: "127.0.0.1:3000" }))));
  check("GET con Host [::1]:3000 permitido", isOk(decide(getRequest({ host: "[::1]:3000" }))));
  check("Host en mayúsculas se normaliza", isOk(decide(getRequest({ host: "LOCALHOST:3000" }))));
  check("Host con punto final se normaliza", isOk(decide(getRequest({ host: "localhost.:3000" }))));
  check("Host con esquema accidental se tolera", isOk(decide(getRequest({ host: "http://localhost:3000" }))));
  // 1.3: el default acepta loopback en CUALQUIER puerto (Next puede
  // arrancar con -p, o en 3001 si 3000 está ocupado).
  check("Host localhost:3001 permitido por default", isOk(decide(getRequest({ host: "localhost:3001" }))));
  check("Host localhost:8080 permitido por default", isOk(decide(getRequest({ host: "localhost:8080" }))));
  check("Host 127.0.0.1:4000 permitido por default", isOk(decide(getRequest({ host: "127.0.0.1:4000" }))));
  check("Host [::1]:4000 permitido por default", isOk(decide(getRequest({ host: "[::1]:4000" }))));
  // …pero el Origin por default sigue siendo EXACTO al host:puerto de la
  // request: un origen de otro puerto no se acepta "por las dudas".
  check(
    "Origin http://localhost:8080 con Host localhost:3000 se bloquea",
    isFailure(
      decide({ origin: "http://localhost:8080", host: "localhost:3000" }),
      "origin",
      403,
    ),
  );
  check(
    "Origin del mismo host y puerto se acepta",
    isOk(decide({ origin: "http://localhost:3000", host: "localhost:3000" })),
  );
  check(
    "Origin de OTRO host se bloquea aunque el host sea loopback",
    isFailure(
      decide({ origin: "http://127.0.0.1:3000", host: "localhost:3000" }),
      "origin",
      403,
    ),
  );
  check(
    "mismo host y puerto en https también se acepta",
    isOk(decide({ origin: "https://localhost:3000", host: "localhost:3000" })),
  );
  check("Host ajeno se rechaza", isFailure(decide(getRequest({ host: "evil.example" })), "host", 403));
  check("Host ausente se rechaza", isFailure(decide(getRequest({ host: null })), "host", 403));
  // Fase 3: permitir el Host no alcanza. Un Host que no es loopback exige
  // autenticación siempre, aunque esté en ALLOWED_HOSTS.
  check(
    "ALLOWED_HOSTS sin autenticación se rechaza (fail-closed)",
    isFailure(
      decide(getRequest({ host: "app.local:3000" }), { ALLOWED_HOSTS: "app.local:3000" }),
      "remote-access-disabled",
      403,
    ),
  );
  check(
    "ALLOWED_HOSTS + APP_ACCESS_TOKEN con cookie se permite",
    isOk(
      decide(
        getRequest({ host: "app.local:3000", cookie: "magi_access_token=sec%72eto" }),
        { ALLOWED_HOSTS: "app.local:3000", APP_ACCESS_TOKEN: "secreto" },
      ),
    ),
  );
  check(
    "ALLOWED_HOSTS + cookie de dispositivo se permite",
    isOk(
      decide(
        getRequest({ host: "app.local:3000", cookie: "magi_device_token=abc" }),
        { ALLOWED_HOSTS: "app.local:3000" },
      ),
    ),
  );
  check(
    "ALLOWED_HOSTS sin ninguna credencial sigue rechazado",
    isFailure(
      decide(getRequest({ host: "app.local:3000", cookie: "tema=oscuro" }), { ALLOWED_HOSTS: "app.local:3000" }),
      "remote-access-disabled",
      403,
    ),
  );
  check(
    "IP de LAN sin credencial se rechaza",
    isFailure(decide(getRequest({ host: "192.168.0.50:3000" }), { ALLOWED_HOSTS: "192.168.0.50:3000" }), "remote-access-disabled", 403),
  );
  check(
    "REMOTE_ACCESS=off rechaza incluso con credencial",
    isFailure(
      decide(
        getRequest({ host: "app.local:3000", cookie: "magi_access_token=sec%72eto" }),
        { ALLOWED_HOSTS: "app.local:3000", APP_ACCESS_TOKEN: "secreto", REMOTE_ACCESS: "off" },
      ),
      "remote-access-disabled",
      403,
    ),
  );
  check(
    "REMOTE_ACCESS=off acepta mayúsculas/minúsculas",
    isFailure(
      decide(getRequest({ host: "app.local:3000" }), { ALLOWED_HOSTS: "app.local:3000", REMOTE_ACCESS: "OFF" }),
      "remote-access-disabled",
      403,
    ),
  );
  check(
    "REMOTE_ACCESS=off no afecta a loopback",
    isOk(decide(getRequest(), { REMOTE_ACCESS: "off" })),
  );
  check(
    "loopback sin credencial sigue permitido (uso local)",
    isOk(decide(getRequest())),
  );
  // Correccion de seguridad #4b: los hosts de loopback se SUMAN a los
  // configurados, no los reemplazan. Antes, configurar ALLOWED_HOSTS para un
  // túnel te dejaba sin poder abrir la app en tu propia PC. No es un agujero:
  // el Host ya no autoriza nada (el peer real sí).
  check(
    "ALLOWED_HOSTS se suma a los loopback, no los reemplaza",
    isOk(decide(getRequest(), { ALLOWED_HOSTS: "app.local:3000" })),
  );
  // Con una credencial presente, para que el caso mida solo el allowlist de
  // Host (si no, la regla de "remoto requiere credencial" lo corta antes).
  check(
    "el host configurado sigue permitido",
    isOk(decide(getRequest({ host: "app.local:3000", authorization: "Bearer t" }), { ALLOWED_HOSTS: "app.local:3000", APP_ACCESS_TOKEN: "t" })),
  );
  check(
    "un host no configurado y no loopback sigue rechazado",
    isFailure(decide(getRequest({ host: "otro.example:3000" }), { ALLOWED_HOSTS: "app.local:3000" }), "host", 403),
  );
  check(
    "ALLOWED_HOSTS sin puerto acepta cualquier puerto",
    isOk(decide(getRequest({ host: "localhost:4000" }), { ALLOWED_HOSTS: "localhost" })),
  );
  check(
    "ALLOWED_HOSTS acepta listas separadas por coma",
    isOk(decide(getRequest({ host: "127.0.0.1:3000" }), { ALLOWED_HOSTS: "localhost:3000,127.0.0.1:3000" })),
  );
  // Con loopback siempre permitido, una lista inválida ya no cierra todo:
  // sigue impediendo el acceso remoto, que es lo que importa. El fail-closed
  // para remoto se verifica en el test de enforcement.
  check(
    "ALLOWED_HOSTS inválido: loopback sigue permitido",
    isOk(decide(getRequest(), { ALLOWED_HOSTS: "bad host" })),
  );
  check(
    "ALLOWED_HOSTS inválido: un host remoto no pasa",
    isFailure(decide(getRequest({ host: "remoto.example:3000" }), { ALLOWED_HOSTS: "bad host" }), "host", 403),
  );
  // 1.3: PORT ya NO participa del default de hosts — loopback se acepta en
  // cualquier puerto, así que cambiar PORT no puede romper el acceso.
  check(
    "PORT sigue aceptando localhost en su puerto",
    isOk(decide(getRequest({ host: "localhost:4000" }), { PORT: "4000" })),
  );
  check(
    "PORT distinto sigue aceptando el 3000 (default any-port)",
    isOk(decide(getRequest(), { PORT: "4000" })),
  );
  check(
    "PORT no afloja el Origin por default",
    isFailure(
      decide({ origin: "http://localhost:4000" }, { PORT: "4000" }),
      "origin",
      403,
    ),
  );

  // Origin / Sec-Fetch-Site en métodos que mutan.
  check("POST same-origin permitido", isOk(decide()));
  check("POST con Origin ajeno rechazado", isFailure(decide({ origin: "http://evil.example" }), "origin", 403));
  check("POST con Origin null rechazado", isFailure(decide({ origin: "null" }), "origin", 403));
  check(
    "POST sin Origin con Sec-Fetch-Site same-origin permitido",
    isOk(decide({ origin: null, secFetchSite: "same-origin" })),
  );
  check(
    "POST sin Origin con Sec-Fetch-Site none permitido",
    isOk(decide({ origin: null, secFetchSite: "none" })),
  );
  check(
    "POST sin Origin con Sec-Fetch-Site cross-site rechazado",
    isFailure(decide({ origin: null, secFetchSite: "cross-site" }), "sec-fetch-site", 403),
  );
  check(
    "POST sin Origin con Sec-Fetch-Site same-site permitido",
    isOk(decide({ origin: null, secFetchSite: "same-site" })),
  );
  check(
    "POST sin Origin y sin Sec-Fetch-Site permitido (cliente no navegador)",
    isOk(decide({ origin: null, secFetchSite: null })),
  );
  check(
    "Origin permitido gana sobre Sec-Fetch-Site cross-site",
    isOk(decide({ origin: "http://localhost:3000", secFetchSite: "cross-site" })),
  );
  check("GET cross-origin no se bloquea por Origin", isOk(decide(getRequest({ origin: "http://evil.example" }))));
  check("PUT cross-origin rechazado", isFailure(decide({ method: "PUT", origin: "http://evil.example" }), "origin", 403));
  check(
    "PATCH cross-origin rechazado",
    isFailure(decide({ method: "PATCH", origin: "http://evil.example" }), "origin", 403),
  );
  check(
    "DELETE cross-origin rechazado",
    isFailure(decide({ method: "DELETE", origin: "http://evil.example" }), "origin", 403),
  );
  check(
    "ALLOWED_ORIGINS permite un origen explícito",
    isOk(decide({ origin: "https://trusted.example" }, { ALLOWED_ORIGINS: "https://trusted.example" })),
  );
  check(
    "ALLOWED_ORIGINS reemplaza el mismo-origen default",
    isFailure(
      decide({ origin: "http://localhost:3000" }, { ALLOWED_ORIGINS: "https://trusted.example" }),
      "origin",
      403,
    ),
  );
  check(
    "ALLOWED_ORIGINS inválido falla cerrado",
    isFailure(decide({ origin: "http://localhost:3000" }, { ALLOWED_ORIGINS: "not a url" }), "origin", 403),
  );
  check(
    "ALLOWED_ORIGINS normaliza barra final",
    isOk(decide({ origin: "http://localhost:3000" }, { ALLOWED_ORIGINS: "http://localhost:3000/" })),
  );
  check("Origin con mayúsculas se normaliza", isOk(decide({ origin: "HTTP://LOCALHOST:3000" })));

  // Content-Type: solo para métodos que mutan y con body.
  check(
    "POST con body text/plain rechazado (403)",
    isFailure(decide({ contentType: "text/plain" }), "content-type", 403),
  );
  check(
    "POST con body text/plain + charset rechazado",
    isFailure(decide({ contentType: "text/plain; charset=utf-8" }), "content-type", 403),
  );
  check(
    "POST con body application/json + charset permitido",
    isOk(decide({ contentType: "application/json; charset=utf-8" })),
  );
  check("POST con body application/ld+json permitido", isOk(decide({ contentType: "application/ld+json" })));
  check(
    "POST con body application/json-patch+json permitido",
    isOk(decide({ contentType: "application/json-patch+json" })),
  );
  check(
    "POST con body sin Content-Type rechazado",
    isFailure(decide({ contentType: null }), "content-type", 403),
  );
  check(
    "POST sin body y sin Content-Type permitido",
    isOk(decide({ hasBody: false, contentType: null })),
  );
  check(
    "POST sin body con Content-Type text/plain permitido",
    isOk(decide({ hasBody: false, contentType: "text/plain" })),
  );
  check(
    "GET con body text/plain no se bloquea por Content-Type",
    isOk(decide(getRequest({ hasBody: true, contentType: "text/plain" }))),
  );

  // Token opcional.
  check(
    "APP_ACCESS_TOKEN acepta Bearer correcto",
    isOk(decide({ authorization: "Bearer secreto" }, { APP_ACCESS_TOKEN: "secreto" })),
  );
  check(
    "APP_ACCESS_TOKEN rechaza Bearer ausente",
    isFailure(decide({ authorization: null }, { APP_ACCESS_TOKEN: "secreto" }), "token", 403),
  );
  check(
    "APP_ACCESS_TOKEN rechaza Bearer incorrecto",
    isFailure(decide({ authorization: "Bearer otro" }, { APP_ACCESS_TOKEN: "secreto" }), "token", 403),
  );
  check(
    "APP_ACCESS_TOKEN acepta cookie correcta",
    isOk(decide({ cookie: "magi_access_token=secreto" }, { APP_ACCESS_TOKEN: "secreto" })),
  );
  check(
    "APP_ACCESS_TOKEN acepta cookie URL-encoded",
    isOk(decide({ cookie: "magi_access_token=sec%72eto" }, { APP_ACCESS_TOKEN: "secreto" })),
  );
  // Sesión opaca: el proxy deja pasar CUALQUIER cookie de sesión (no puede
  // consultar la DB) y la validez la decide la ruta. Es el mismo criterio que
  // con la cookie de dispositivo.
  check(
    "APP_ACCESS_TOKEN rechaza una cookie sin valor de sesión",
    isFailure(decide({ cookie: "magi_access_token=" }, { APP_ACCESS_TOKEN: "secreto" }), "token", 403),
  );
  check(
    "cookie de sesión del operador pasa el proxy (la ruta la valida)",
    isOk(decide({ cookie: "magi_access_token=" + "a".repeat(64) }, { APP_ACCESS_TOKEN: "secreto" })),
  );
  check(
    "Bearer correcto sigue siendo la credencial de scripts",
    isOk(decide({ authorization: "Bearer secreto" }, { APP_ACCESS_TOKEN: "secreto" })),
  );
  check(
    "Bearer incorrecto se rechaza en el proxy",
    isFailure(decide({ authorization: "Bearer otro" }, { APP_ACCESS_TOKEN: "secreto" }), "token", 403),
  );
  check(
    "APP_ACCESS_TOKEN acepta esquema bearer en minúsculas",
    isOk(decide({ authorization: "bearer secreto" }, { APP_ACCESS_TOKEN: "secreto" })),
  );
  check(
    "APP_ACCESS_TOKEN también aplica a GET",
    isFailure(decide(getRequest(), { APP_ACCESS_TOKEN: "secreto" }), "token", 403),
  );
  check(
    "sin APP_ACCESS_TOKEN no se exige Authorization",
    isOk(decide({ authorization: null })),
  );
  check(
    "APP_ACCESS_TOKEN rechaza Basic",
    isFailure(decide({ authorization: "Basic secreto" }, { APP_ACCESS_TOKEN: "secreto" }), "token", 403),
  );
  check(
    "APP_ACCESS_TOKEN acepta cookie entre varias",
    isOk(
      decide(
        { cookie: "tema=oscuro; magi_access_token=secreto; idioma=es" },
        { APP_ACCESS_TOKEN: "secreto" },
      ),
    ),
  );

  // Fase 4d: la cookie de dispositivo es credencial por si sola. Antes esto
  // exigia APP_ACCESS_TOKEN siempre, asi que un telefono emparejado no podia
  // autenticarse nunca desde la LAN.
  check(
    "cookie de dispositivo: pasa el proxy sin APP_ACCESS_TOKEN",
    isOk(decide({ cookie: "magi_device_token=abc123" }, { APP_ACCESS_TOKEN: "secreto" })),
  );
  check(
    "cookie de dispositivo basura: pasa el proxy (lo valida la ruta)",
    isOk(decide({ cookie: "magi_device_token=basura" }, { APP_ACCESS_TOKEN: "secreto" })),
  );
  check("con token de la app sigue funcionando igual", isOk(decide({ authorization: "Bearer secreto" }, { APP_ACCESS_TOKEN: "secreto" })));
  check("sin nada, sigue bloqueado", isFailure(decide({}, { APP_ACCESS_TOKEN: "secreto" }), "token", 403));

  console.log(`\n${passed}/${passed + failed} casos OK`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
