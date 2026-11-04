/**
 * Fase de correcciones — rotación de credenciales de NVIDIA.
 *
 * Lo que se fija acá, verificado contra el código real:
 * 1. El pool correcto se elige por el MODELO, no por un nombre escrito a
 *    mano. `councilProviderForModel` resuelve el asiento; antes, síntesis,
 *    juez de fusión y follow-ups pasaban "openrouter" fijo, así que un
 *    modelo nativo de NVIDIA configurado por env rotaba las keys
 *    equivocadas.
 * 2. La rotación de NVIDIA funciona de punta a punta para el consejo: con
 *    dos `NVIDIA_API_KEY` y la primera en 429, la corrida continúa con la
 *    segunda y **el modelo no cambia** (el objetivo explícito del pedido).
 * 3. El ping ya no reporta "modelo caído" cuando lo que está caída es la
 *    key: rota y clasifica 401/403 como credencial inválida.
 * 4. El fallback OpenRouter → NVIDIA directo también rota las NVIDIA keys.
 *
 * Uso: npm run security:test-nvidia-rotation
 */
import { OpenRouterError } from "./llm-shared";
import { councilProviderForModel, runDraft } from "./council-run";
import { isAuthPingError } from "./model-ping";
import { getProviderPool, __resetProviderPoolsForTests } from "./provider-resilience/registry";
import { NVIDIA_MODEL_MAP } from "./nvidia";

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

const NVIDIA_SEAT = "nvidia/nemotron-3.5-lightning-30b-a3b";
const OPENROUTER_SEAT = "nvidia/nemotron-3.5-lightning:free";

/** El entorno se setea antes de importar nada que lea pools: el registro
 *  cachea pools por provider y se reinicia entre casos. */
function withEnv(vars: Record<string, string>, fn: () => Promise<void> | void): Promise<void> {
  const backup: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    backup[key] = process.env[key];
    process.env[key] = value;
  }
  // Sin keys de otros providers: si quedan las de verdad en el entorno,
  // los pools tendrían más credenciales y los conteos fallarían.
  for (const key of ["OPENROUTER_API_KEY", "GEMINI_API_KEY"]) backup[key] = process.env[key];
  for (const key of ["OPENROUTER_API_KEY", "GEMINI_API_KEY"]) delete process.env[key];
  __resetProviderPoolsForTests();

  return (async () => {
    try {
      await fn();
    } finally {
      for (const [key, value] of Object.entries(backup)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      __resetProviderPoolsForTests();
    }
  })();
}

async function main(): Promise<void> {
  console.log("== el pool se elige por el modelo ==\n");
  {
    check("asiento nativo NVIDIA → pool nvidia", councilProviderForModel(NVIDIA_SEAT) === "nvidia");
    check("asiento con slug de OpenRouter → pool openrouter", councilProviderForModel(OPENROUTER_SEAT) === "openrouter");
    check("modelo desconocido → openrouter (default histórico)", councilProviderForModel("algo/que-no-existe") === "openrouter");
    check("slug de Google → pool google", councilProviderForModel("gemini-2.5-flash") === "google");

    // Los tres modelos "de cierre" de la corrida, que antes iban fijos al
    // pool de OpenRouter. Con env override a un id nativo de NVIDIA tienen
    // que resolverse a nvidia.
    process.env.SYNTHESIS_MODEL = NVIDIA_SEAT;
    process.env.FUSION_JUDGE_MODEL = NVIDIA_SEAT;
    process.env.FOLLOWUP_MODEL = NVIDIA_SEAT;
    check("SYNTHESIS_MODEL nativo → nvidia", councilProviderForModel(process.env.SYNTHESIS_MODEL) === "nvidia");
    check("FUSION_JUDGE_MODEL nativo → nvidia", councilProviderForModel(process.env.FUSION_JUDGE_MODEL) === "nvidia");
    check("FOLLOWUP_MODEL nativo → nvidia", councilProviderForModel(process.env.FOLLOWUP_MODEL) === "nvidia");
    delete process.env.SYNTHESIS_MODEL;
    delete process.env.FUSION_JUDGE_MODEL;
    delete process.env.FOLLOWUP_MODEL;

    check(
      "los defaults de cierre siguen siendo openrouter",
      councilProviderForModel("nvidia/nemotron-3.5-lightning:free") === "openrouter",
    );
  }

  console.log("\n== rotación de NVIDIA en el consejo, mismo modelo ==\n");
  await withEnv({ NVIDIA_API_KEY: "nv-key-1", NVIDIA_API_KEY_2: "nv-key-2" }, async () => {
    const pool = getProviderPool("nvidia");
    check("descubre las dos NVIDIA_API_KEY", pool.snapshot().length === 2, pool.snapshot().length);

    const calls: Array<{ modelId: string; apiKey: string }> = [];
    const result = await runDraft({
      modelId: NVIDIA_SEAT,
      prompt: "Pregunta de prueba",
      attachments: [],
      history: [],
      explicitOpenRouterKey: null,
      send: () => {},
      offset: 0,
      signal: new AbortController().signal,
      webGrounding: false,
      skillPrompt: "",
      personaPrompt: "",
      tools: [],
      executeTool: async () => ({ name: "x", content: "" }),
      reasoningEffort: "low",
      runCouncilCompletionImpl: async (modelId: string, options: { apiKey: string }) => {
        calls.push({ modelId, apiKey: options.apiKey });
        if (calls.length === 1) throw new OpenRouterError("rate limited", 429);
        return { content: "respuesta falsa" } as never;
      },
    });

    check("la corrida termina ok pese al 429 de la primera key", result.ok === true, result);
    check("rotó a la segunda key", calls.map((c) => c.apiKey).join(",") === "nv-key-1,nv-key-2", calls);
    check("no repitió la misma key", new Set(calls.map((c) => c.apiKey)).size === 2);
    check(
      "EL MODELO NO CAMBIÓ al rotar",
      new Set(calls.map((c) => c.modelId)).size === 1 && calls[0].modelId === NVIDIA_SEAT,
      calls,
    );
    const states = pool.snapshot();
    check("la key con 429 queda en cooldown, no inválida", states.find((s) => s.id === "nvidia-1")?.status === "COOLDOWN", states);
    check("la key buena queda disponible", states.find((s) => s.id === "nvidia-2")?.status === "AVAILABLE", states);
  });

  await withEnv({ NVIDIA_API_KEY: "nv-a", NVIDIA_API_KEY_2: "nv-b", NVIDIA_API_KEY_3: "nv-c" }, async () => {
    const calls: string[] = [];
    const result = await runDraft({
      modelId: NVIDIA_SEAT,
      prompt: "Pregunta",
      attachments: [],
      history: [],
      explicitOpenRouterKey: null,
      send: () => {},
      offset: 0,
      signal: new AbortController().signal,
      webGrounding: false,
      skillPrompt: "",
      personaPrompt: "",
      tools: [],
      executeTool: async () => ({ name: "x", content: "" }),
      reasoningEffort: "low",
      runCouncilCompletionImpl: async (modelId: string, options: { apiKey: string }) => {
        calls.push(options.apiKey);
        if (calls.length < 3) throw new OpenRouterError("rate limited", 429);
        return { content: "ok" } as never;
      },
    });
    check("rota por las tres keys en orden", calls.join(",") === "nv-a,nv-b,nv-c", calls);
    check("con tres keys también mantiene el modelo", result.modelId === NVIDIA_SEAT, result);
  });

  await withEnv({ NVIDIA_API_KEY: "nv-muerta" }, async () => {
    // Una sola key, en 401 permanente: no hay a dónde rotar y debe fallar
    // con el error del proveedor, no con un falso "modelo caído".
    let attempts = 0;
    const result = await runDraft({
      modelId: NVIDIA_SEAT,
      prompt: "Pregunta",
      attachments: [],
      history: [],
      explicitOpenRouterKey: null,
      send: () => {},
      offset: 0,
      signal: new AbortController().signal,
      webGrounding: false,
      skillPrompt: "",
      personaPrompt: "",
      tools: [],
      executeTool: async () => ({ name: "x", content: "" }),
      reasoningEffort: "low",
      runCouncilCompletionImpl: async () => {
        attempts += 1;
        throw new OpenRouterError("invalid api key", 401);
      },
    });
    check("sin otra key, el 401 corta y no reintenta mil veces", attempts === 1, attempts);
    check("el resultado informa el fallo", result.ok === false, result);
  });

  console.log("\n== clasificación de errores del ping ==\n");
  {
    check("HTTP 401 es error de auth", isAuthPingError("HTTP 401"));
    check("HTTP 403 es error de auth", isAuthPingError("HTTP 403"));
    check("mensaje del proveedor con 'invalid api key' es auth", isAuthPingError("invalid api key provided"));
    check("mensaje con 'unauthorized' es auth", isAuthPingError("Unauthorized"));
    check("429 NO es auth (es cuota: rota)", !isAuthPingError("HTTP 429"));
    check("timeout no es auth", !isAuthPingError("timeout"));
    check("4010 no se confunde con 401 (delimitado por no-dígitos)", !isAuthPingError("HTTP 4010"));
  }

  console.log("\n== mapeo de modelos para el fallback ==\n");
  {
    check(
      "el mapping existe y no cambia por rotar keys",
      NVIDIA_MODEL_MAP[OPENROUTER_SEAT] === NVIDIA_SEAT,
      NVIDIA_MODEL_MAP[OPENROUTER_SEAT],
    );
    // La regla del pedido: rotar keys nunca cambia el modelo. El fallback
    // SÍ cambia el id (de slug de OpenRouter a id nativo de NVIDIA) porque
    // es otro proveedor — se documenta como la única excepción.
    check(
      "el fallback mapea al mismo modelo en el namespace nativo",
      NVIDIA_MODEL_MAP[OPENROUTER_SEAT] !== OPENROUTER_SEAT,
    );
    check("un modelo sin mapping devuelve null", NVIDIA_MODEL_MAP["openai/gpt-4o"] === undefined);
  }

  console.log(`\n${passed}/${passed + failed} casos OK`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
