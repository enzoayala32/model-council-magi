/**
 * Fase 6B — prueba de aceptación de `TavilySearchProvider`
 * (`search-provider.ts`). `fetch` se reemplaza temporalmente por un fake
 * en cada caso (se restaura siempre en el `finally`) — cero red real,
 * cero SDK de Tavily (no existe, es `fetch` directo). El caso de
 * timeout/abort usa un `AbortController` propio del test + un fake fetch
 * que solo rechaza cuando SU signal se aborta — nunca un `setTimeout`
 * real esperando a que "alcance".
 *
 * Uso: npm run agent:test-search-provider
 */
import { TavilySearchProvider, createSearchProviderFromEnv, MAX_WEB_SEARCH_RESULTS } from "./search-provider";

let results: boolean[] = [];

function check(label: string, ok: boolean, detail?: unknown): void {
  results.push(ok);
  console.log(`${ok ? "✅" : "❌"} ${label}${ok ? "" : ` — ${JSON.stringify(detail)}`}`);
}

const originalFetch = globalThis.fetch;

function withFakeFetch<T>(fake: typeof fetch, run: () => Promise<T>): Promise<T> {
  globalThis.fetch = fake;
  return run().finally(() => {
    globalThis.fetch = originalFetch;
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function main(): Promise<void> {
  console.log("== Fase 6B — prueba de aceptación (TavilySearchProvider) ==\n");

  // --- Caso 1: búsqueda exitosa ---
  console.log("--- Caso 1: búsqueda exitosa, un resultado ---");
  await withFakeFetch(
    (async () => jsonResponse(200, { results: [{ title: "Resultado A", url: "https://a.example.com", content: "snippet A", score: 0.9 }] })) as typeof fetch,
    async () => {
      const provider = new TavilySearchProvider("tvly-secret-1");
      const out = await provider.search("react hooks", { maxResults: 6 });
      check("devuelve 1 resultado con title/url/snippet correctos", out.length === 1 && out[0].title === "Resultado A" && out[0].url === "https://a.example.com" && out[0].snippet === "snippet A", out);
    },
  );

  // --- Caso 2: múltiples resultados ---
  console.log("\n--- Caso 2: múltiples resultados ---");
  await withFakeFetch(
    (async () => jsonResponse(200, { results: [1, 2, 3].map((i) => ({ title: `T${i}`, url: `https://x.com/${i}`, content: `c${i}` })) })) as typeof fetch,
    async () => {
      const provider = new TavilySearchProvider("tvly-secret-2");
      const out = await provider.search("algo", { maxResults: 6 });
      check("devuelve los 3 resultados en orden", out.length === 3 && out.map((r) => r.title).join(",") === "T1,T2,T3", out);
    },
  );

  // --- Caso 3: el proveedor devuelve MÁS resultados que el máximo permitido ---
  console.log("\n--- Caso 3: Tavily devuelve más resultados que maxResults ---");
  await withFakeFetch(
    (async () => jsonResponse(200, { results: Array.from({ length: 20 }, (_, i) => ({ title: `T${i}`, url: `https://x.com/${i}`, content: `c${i}` })) })) as typeof fetch,
    async () => {
      const provider = new TavilySearchProvider("tvly-secret-3");
      const out = await provider.search("algo", { maxResults: 3 });
      check("se recorta a maxResults (3), pese a que el proveedor mandó 20", out.length === 3, out.length);
    },
  );
  console.log("--- Caso 3b: el modelo pide más que MAX_WEB_SEARCH_RESULTS — el proveedor lo capea igual ---");
  await withFakeFetch(
    (async (_url, init) => {
      const body = JSON.parse((init as { body: string }).body);
      check(`el proveedor nunca le pide a Tavily más de ${MAX_WEB_SEARCH_RESULTS} (pidió ${body.max_results})`, body.max_results <= MAX_WEB_SEARCH_RESULTS, body);
      return jsonResponse(200, { results: Array.from({ length: 20 }, (_, i) => ({ title: `T${i}`, url: `https://x.com/${i}`, content: `c${i}` })) });
    }) as typeof fetch,
    async () => {
      const provider = new TavilySearchProvider("tvly-secret-3b");
      const out = await provider.search("algo", { maxResults: 999 });
      check(`el resultado final nunca supera MAX_WEB_SEARCH_RESULTS=${MAX_WEB_SEARCH_RESULTS} pese a pedir 999`, out.length <= MAX_WEB_SEARCH_RESULTS, out.length);
    },
  );

  // --- Caso 4: respuesta inválida (sin 'results') ---
  console.log("\n--- Caso 4: respuesta 200 pero con forma inesperada (sin 'results') ---");
  await withFakeFetch(
    (async () => jsonResponse(200, { answer: "esto no tiene 'results'" })) as typeof fetch,
    async () => {
      const provider = new TavilySearchProvider("tvly-secret-4");
      const error = await provider.search("algo", { maxResults: 6 }).catch((e) => e as Error);
      check("rechaza con un error legible sobre la forma inesperada", error instanceof Error && error.message.includes("forma inesperada"), error);
    },
  );

  // --- Caso 5: error de red (fetch rechaza) ---
  console.log("\n--- Caso 5: error de red (DNS/conexión) ---");
  await withFakeFetch(
    (async () => {
      throw new TypeError("fetch failed: ENOTFOUND api.tavily.com");
    }) as typeof fetch,
    async () => {
      const provider = new TavilySearchProvider("tvly-secret-5");
      const error = await provider.search("algo", { maxResults: 6 }).catch((e) => e as Error);
      check("rechaza con un error legible que menciona a Tavily", error instanceof Error && error.message.includes("Tavily"), error);
    },
  );

  // --- Caso 6: error HTTP (429 rate limit) ---
  console.log("\n--- Caso 6: error HTTP (429) ---");
  await withFakeFetch(
    (async () => new Response(JSON.stringify({ detail: "rate limit exceeded" }), { status: 429 })) as typeof fetch,
    async () => {
      const provider = new TavilySearchProvider("tvly-secret-6");
      const error = await provider.search("algo", { maxResults: 6 }).catch((e) => e as Error);
      check("rechaza mencionando el status 429", error instanceof Error && error.message.includes("429"), error);
    },
  );

  // --- Caso 7: timeout/abort — determinista, sin ningún timer real ---
  console.log("\n--- Caso 7: abort externo mientras la request está en curso ---");
  await withFakeFetch(
    (async (_url, init) => {
      const signal = init?.signal as AbortSignal | undefined;
      return new Promise<Response>((_, reject) => {
        if (!signal) return;
        if (signal.aborted) {
          reject(new DOMException("aborted", "AbortError"));
          return;
        }
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    }) as typeof fetch,
    async () => {
      const provider = new TavilySearchProvider("tvly-secret-7");
      const controller = new AbortController();
      const promise = provider.search("algo", { maxResults: 6, signal: controller.signal });
      controller.abort();
      const error = await promise.catch((e) => e as Error);
      check("rechaza con un mensaje de cancelación/timeout, no un error crudo de red", error instanceof Error && error.message.includes("canceló") && error.message.includes("Tavily"), error);
    },
  );

  // --- Caso 8: ausencia de configuración ---
  console.log("\n--- Caso 8: sin TAVILY_API_KEY configurada ---");
  {
    const previous = process.env.TAVILY_API_KEY;
    delete process.env.TAVILY_API_KEY;
    const provider = createSearchProviderFromEnv();
    check("createSearchProviderFromEnv() devuelve undefined sin key", provider === undefined, provider);
    if (previous !== undefined) process.env.TAVILY_API_KEY = previous;
  }

  // --- Extra: filtrado explícito de campos no permitidos ---
  console.log("\n--- Extra: campos no permitidos (score, raw_content, favicon) nunca sobreviven ---");
  await withFakeFetch(
    (async () => jsonResponse(200, { results: [{ title: "T", url: "https://x.com", content: "c", score: 0.5, raw_content: "<html>full page</html>", favicon: "https://x.com/favicon.ico", images: ["a.png"] }] })) as typeof fetch,
    async () => {
      const provider = new TavilySearchProvider("tvly-secret-extra");
      const out = await provider.search("algo", { maxResults: 6 });
      check("el resultado SOLO tiene title/url/snippet — nada más", Object.keys(out[0]).sort().join(",") === "snippet,title,url", out[0]);
    },
  );

  // --- Extra: la API key nunca aparece en un error, ni siquiera si el mensaje de red la menciona ---
  console.log("\n--- Extra: la API key nunca aparece en un error ---");
  await withFakeFetch(
    (async () => {
      throw new TypeError("request failed for Authorization: Bearer tvly-super-secreta-123");
    }) as typeof fetch,
    async () => {
      const provider = new TavilySearchProvider("tvly-super-secreta-123");
      const error = await provider.search("algo", { maxResults: 6 }).catch((e) => e as Error);
      check("el error nunca contiene la key real, aunque el mensaje de red original la mencionara", error instanceof Error && !error.message.includes("tvly-super-secreta-123") && error.message.includes("REDACTED"), error instanceof Error ? error.message : error);
    },
  );

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} casos OK.`);
  if (passed !== results.length) process.exit(1);
}

main().catch((error) => {
  console.error("Error inesperado en la prueba:", error);
  process.exit(1);
});
