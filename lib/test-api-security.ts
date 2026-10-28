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
  check("Host con otro puerto se rechaza", isFailure(decide(getRequest({ host: "localhost:4000" })), "host", 403));
  check("Host ajeno se rechaza", isFailure(decide(getRequest({ host: "evil.example" })), "host", 403));
  check("Host ausente se rechaza", isFailure(decide(getRequest({ host: null })), "host", 403));
  check(
    "ALLOWED_HOSTS permite un host explícito",
    isOk(decide(getRequest({ host: "app.local:3000" }), { ALLOWED_HOSTS: "app.local:3000" })),
  );
  check(
    "ALLOWED_HOSTS reemplaza los defaults",
    isFailure(decide(getRequest(), { ALLOWED_HOSTS: "app.local:3000" }), "host", 403),
  );
  check(
    "ALLOWED_HOSTS sin puerto acepta cualquier puerto",
    isOk(decide(getRequest({ host: "localhost:4000" }), { ALLOWED_HOSTS: "localhost" })),
  );
  check(
    "ALLOWED_HOSTS acepta listas separadas por coma",
    isOk(decide(getRequest({ host: "127.0.0.1:3000" }), { ALLOWED_HOSTS: "localhost:3000,127.0.0.1:3000" })),
  );
  check(
    "ALLOWED_HOSTS inválido falla cerrado",
    isFailure(decide(getRequest(), { ALLOWED_HOSTS: "bad host" }), "host", 403),
  );
  check("PORT cambia el puerto default", isOk(decide(getRequest({ host: "localhost:4000" }), { PORT: "4000" })));
  check(
    "PORT distinto rechaza el puerto 3000",
    isFailure(decide(getRequest(), { PORT: "4000" }), "host", 403),
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
  check(
    "APP_ACCESS_TOKEN rechaza cookie incorrecta",
    isFailure(decide({ cookie: "magi_access_token=otro" }, { APP_ACCESS_TOKEN: "secreto" }), "token", 403),
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

  console.log(`\n${passed}/${passed + failed} casos OK`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
