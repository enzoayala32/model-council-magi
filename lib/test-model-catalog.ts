/**
 * Tests del catálogo automático de modelos.
 *
 * Sin red: se inyecta un `fetch` falso con la MISMA forma que devuelven
 * los endpoints reales (verificada el 2026-11-04 contra
 * openrouter.ai/api/v1/models e integrate.api.nvidia.com/v1/models).
 *
 * Uso: npm run council:test-catalog
 */
import {
  __clearCatalogCacheForTests,
  getCatalog,
  getModelCatalog,
  separateByPricing,
  type CatalogModel,
  type CatalogDeps,
} from "./model-catalog";

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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Réplica literal de dos filas reales de OpenRouter (una gratis, una paga). */
const OPENROUTER_FIXTURE = {
  data: [
    {
      id: "nvidia/nemotron-3.5-super-vl:free",
      name: "NVIDIA: Nemotron 3.5 Super VL (free)",
      context_length: 131072,
      pricing: { prompt: "0", completion: "0", input_cache_read: "0" },
    },
    {
      id: "openai/gpt-4o",
      name: "OpenAI: GPT-4o",
      context_length: 128000,
      pricing: { prompt: "0.0000025", completion: "0.00001", input_cache_read: "0.00000125" },
    },
    {
      id: "tencent/hy4",
      name: "Tencent: Hy4",
      context_length: 262144,
      pricing: { prompt: "0.000000417", completion: "0.0000012505", input_cache_read: "0.000000021" },
    },
    // Sin pricing: no se puede afirmar nada.
    { id: "misterio/sin-precio", name: "Misterio", context_length: 8192 },
    // Fila rota: se descarta sin romper el resto.
    { name: "sin id" },
    null,
  ],
};

/** Réplica literal de dos filas de NVIDIA: sin pricing. */
const NVIDIA_FIXTURE = {
  data: [
    { id: "01-ai/yi-large", object: "model", created: 735790403, owned_by: "01-ai" },
    { id: "nvidia/nemotron-3.5-lightning-30b-a3b", object: "model", created: 735790403, owned_by: "nvidia" },
  ],
};

function fakeFetch(body: unknown, opts: { status?: number; failWith?: string } = {}) {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    if (opts.failWith) throw new Error(opts.failWith);
    return jsonResponse(body, opts.status);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

async function main(): Promise<void> {
  __clearCatalogCacheForTests();
  const clock = { now: () => 1_000_000 };
  const noEnv: CatalogDeps = { fetchImpl: (async () => jsonResponse({ data: [] })) as unknown as typeof fetch, now: clock.now };

  console.log("== normalización de OpenRouter ==\n");
  {
    const { impl, calls } = fakeFetch(OPENROUTER_FIXTURE);
    const result = await getCatalog("openrouter", { env: {}, deps: { fetchImpl: impl, now: clock.now } });

    check("no lanza y devuelve modelos", result.error === null, result.error);
    check("llama al endpoint público de OpenRouter", calls[0] === "https://openrouter.ai/api/v1/models", calls[0]);
    check("descarta filas sin id y nulls", result.models.length === 4, result.models.map((m) => m.id));

    const free = result.models.find((m) => m.id.endsWith(":free"));
    check("modelo :free con precio 0 queda free=true", free?.free === true, free);
    check("convierte precio por token a por millón", free?.inputPerMillionUsd === 0, free);

    const gpt = result.models.find((m) => m.id === "openai/gpt-4o");
    check("gpt-4o queda free=false", gpt?.free === false, gpt);
    check("gpt-4o input = 2.5 USD/M", gpt?.inputPerMillionUsd === 2.5, gpt);
    check("gpt-4o output = 10 USD/M", gpt?.outputPerMillionUsd === 10, gpt);
    check("conserva el context_length", gpt?.contextLength === 128000, gpt);

    const hy4 = result.models.find((m) => m.id === "tencent/hy4");
    check("precio chico se convierte sin perder precisión", hy4?.inputPerMillionUsd === 0.417, hy4);
    check("precio chico output", hy4?.outputPerMillionUsd === 1.2505, hy4);

    const mystery = result.models.find((m) => m.id === "misterio/sin-precio");
    check("sin pricing queda free=null (no se inventa)", mystery?.free === null, mystery);
    check("sin pricing queda inputPerMillionUsd=null", mystery?.inputPerMillionUsd === null, mystery);
    check("usa el name como label", gpt?.label === "OpenAI: GPT-4o", gpt?.label);

    const labels = result.models.map((m) => m.label);
    check("ordena por label de forma estable", JSON.stringify(labels) === JSON.stringify([...labels].sort()), labels);
  }

  console.log("\n== normalización de NVIDIA ==\n");
  {
    const { impl, calls } = fakeFetch(NVIDIA_FIXTURE);
    const result = await getCatalog("nvidia", { deps: { fetchImpl: impl, now: clock.now } });
    check("llama al endpoint público de NVIDIA", calls[0] === "https://integrate.api.nvidia.com/v1/models", calls[0]);
    check("devuelve los 2 modelos", result.models.length === 2, result.models.map((m) => m.id));
    check("NVIDIA no tiene precio: free=null", result.models.every((m) => m.free === null), result.models);
    check("NVIDIA no tiene precio por millón", result.models.every((m) => m.inputPerMillionUsd === null));
    check("NVIDIA no publica context_length", result.models.every((m) => m.contextLength === null));
    check("el label cae al id (no hay name)", result.models[0].label === result.models[0].id, result.models[0]);
  }

  console.log("\n== separación gratis/pago ==\n");
  {
    const models: CatalogModel[] = [
      { id: "a:free", label: "A", provider: "openrouter", contextLength: null, free: true, inputPerMillionUsd: 0, outputPerMillionUsd: 0 },
      { id: "b", label: "B", provider: "openrouter", contextLength: null, free: false, inputPerMillionUsd: 2.5, outputPerMillionUsd: 10 },
      { id: "c", label: "C", provider: "nvidia", contextLength: null, free: null, inputPerMillionUsd: null, outputPerMillionUsd: null },
      { id: "d", label: "D", provider: "nvidia", contextLength: null, free: null, inputPerMillionUsd: null, outputPerMillionUsd: null },
    ];
    const { free, paid, unknown } = separateByPricing(models);
    check("separa los gratis", free.map((m) => m.id).join(",") === "a:free", free);
    check("separa los pagos", paid.map((m) => m.id).join(",") === "b", paid);
    check("lo desconocido va a su propio grupo", unknown.map((m) => m.id).join(",") === "c,d", unknown);
    check("nada se pierde: 2+1+2 = 4", free.length + paid.length + unknown.length === models.length);
    check("lista vacía no rompe", JSON.stringify(separateByPricing([])) === JSON.stringify({ free: [], paid: [], unknown: [] }));
  }

  console.log("\n== caché, TTL y refresh ==\n");
  {
    __clearCatalogCacheForTests();
    let calls = 0;
    const impl = (async () => {
      calls += 1;
      return jsonResponse(OPENROUTER_FIXTURE);
    }) as unknown as typeof fetch;

    const first = await getCatalog("openrouter", { deps: { fetchImpl: impl, now: clock.now } });
    check("la primera consulta pega a la red", calls === 1, calls);
    const second = await getCatalog("openrouter", { deps: { fetchImpl: impl, now: clock.now } });
    check("la segunda usa caché (no vuelve a la red)", calls === 1, calls);
    check("el caché devuelve los mismos datos", second.models.length === first.models.length);

    const later = await getCatalog("openrouter", { ttlMs: 1, deps: { fetchImpl: impl, now: () => clock.now() + 5000 } });
    check("TTL vencido vuelve a consultar", calls === 2, calls);

    const forced = await getCatalog("openrouter", { force: true, deps: { fetchImpl: impl, now: clock.now } });
    check("force=true ignora el caché", calls === 3, calls);
    check("force devuelve datos frescos", forced.models.length === 4);

    __clearCatalogCacheForTests();
    const perProvider = (await getModelCatalog({ deps: { fetchImpl: impl, now: clock.now } })) as Record<string, { models: unknown[] }>;
    check("getModelCatalog cubre los dos proveedores", Object.keys(perProvider).sort().join(",") === "nvidia,openrouter", Object.keys(perProvider));
  }

  console.log("\n== fallos: nunca se lanza ==\n");
  {
    __clearCatalogCacheForTests();
    const { impl } = fakeFetch(OPENROUTER_FIXTURE, { failWith: "fetch failed" });
    const result = await getCatalog("openrouter", { deps: { fetchImpl: impl, now: clock.now } });
    check("error de red devuelve error, no lanza", typeof result.error === "string", result.error);
    check("con error no hay modelos", result.models.length === 0);
    check("el error está en español", /No se pudo listar/.test(result.error ?? ""), result.error);

    const { impl: impl500 } = fakeFetch({}, { status: 500 });
    const r500 = await getCatalog("nvidia", { deps: { fetchImpl: impl500, now: clock.now } });
    check("HTTP 500 se reporta como error", /500/.test(r500.error ?? ""), r500.error);

    // Sin dato.previo, un fallo deja el caché vacío: la UI muestra el aviso.
    __clearCatalogCacheForTests();
    const { impl: impl2 } = fakeFetch({ data: [] });
    await getCatalog("nvidia", { deps: { fetchImpl: impl2, now: clock.now } });
    const { impl: implFail } = fakeFetch(OPENROUTER_FIXTURE, { failWith: "se cayó" });
    const afterFail = await getCatalog("nvidia", { force: true, deps: { fetchImpl: implFail, now: clock.now } });
    check("fallo sobre caché vacío devuelve error", afterFail.error !== null && afterFail.models.length === 0);

    // Con caché previo bueno, un fallo devuelve lo viejo más el error: mejor
    // que una pantalla vacía por un corte de red.
    __clearCatalogCacheForTests();
    const { impl: good } = fakeFetch(OPENROUTER_FIXTURE);
    await getCatalog("openrouter", { deps: { fetchImpl: good, now: clock.now } });
    const { impl: bad } = fakeFetch(OPENROUTER_FIXTURE, { failWith: "se cayó" });
    const stale = await getCatalog("openrouter", { force: true, deps: { fetchImpl: bad, now: clock.now } });
    check("fallo sobre caché bueno devuelve el último conocido", stale.models.length === 4, stale.models.length);
    check("y además avisa del fallo", stale.error !== null, stale.error);

    // Payload inesperado: no rompe.
    __clearCatalogCacheForTests();
    const { impl: impl3 } = fakeFetch({ inesperado: true });
    const weird = await getCatalog("openrouter", { deps: { fetchImpl: impl3, now: clock.now } });
    check("payload sin data no rompe", weird.error === null && weird.models.length === 0, weird);

    const { impl: impl4 } = fakeFetch({ data: "no es un array" });
    const weird2 = await getCatalog("openrouter", { deps: { fetchImpl: impl4, now: clock.now } });
    check("data que no es array no rompe", weird2.error === null && weird2.models.length === 0, weird2);
  }

  console.log("\n== la key es opcional y nunca se loguea ==\n");
  {
    __clearCatalogCacheForTests();
    let seenHeaders: Record<string, string> = {};
    const impl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenHeaders = (init?.headers ?? {}) as Record<string, string>;
      return jsonResponse(OPENROUTER_FIXTURE);
    }) as unknown as typeof fetch;
    await getCatalog("openrouter", { env: { OPENROUTER_API_KEY: "sk-or-test" }, deps: { fetchImpl: impl, now: clock.now } });
    check("con key configurada se manda Authorization", seenHeaders.Authorization === "Bearer sk-or-test", seenHeaders);
    check("con key se manda Content-Type json", seenHeaders["Content-Type"] === "application/json");

    let seen2: Record<string, string> = {};
    const impl2 = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen2 = (init?.headers ?? {}) as Record<string, string>;
      return jsonResponse(NVIDIA_FIXTURE);
    }) as unknown as typeof fetch;
    await getCatalog("nvidia", { deps: { fetchImpl: impl2, now: clock.now } });
    check("sin key no se manda Authorization", seen2.Authorization === undefined, seen2);
  }

  void noEnv;
  console.log(`\n${passed}/${passed + failed} casos OK`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
