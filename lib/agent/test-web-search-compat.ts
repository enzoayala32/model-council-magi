/**
 * Fase 6C — prueba de aceptación del gate de compatibilidad de
 * `web_search` (`isWebSearchCompatible` en `tools.ts` + el gate en
 * `runAgentLoop`, `loop.ts`). Todo determinista: cero red real, cero
 * Tavily real (nunca se ejecuta la tool, solo se observa qué tools recibe
 * `generateText`), cero mutación del roster real de `models.ts` (el
 * override de solo-test `webSearchCompatibleOverride` existe exactamente
 * para eso). Las seams de siempre: `generateTextImpl` fake para observar
 * el set de tools, `searchProvider` inyectado para el caso de prioridad.
 *
 * Nota de interpretación (ver el informe de 6C): "provider disponible" en
 * los Casos 1-2 significa "disponible vía `TAVILY_API_KEY` del entorno" —
 * el Caso 5 es el único que inyecta un provider explícito, y es el que
 * prueba que esa inyección gana sobre el gate.
 *
 * Uso: npm run agent:test-web-search-compat
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isWebSearchCompatible } from "./tools";
import { runAgentLoop, __resetProviderPoolsForTests, type RunAgentLoopOptions } from "./loop";
import { getCodingAgentModels, getCouncilModel } from "../models";
import type { SearchProvider } from "./search-provider";

let results: boolean[] = [];

function check(label: string, ok: boolean, detail?: unknown): void {
  results.push(ok);
  console.log(`${ok ? "✅" : "❌"} ${label}${ok ? "" : ` — ${JSON.stringify(detail)}`}`);
}

function setOpenRouterCredentials(...values: string[]): void {
  const prefix = "OPENROUTER_API_KEY";
  delete process.env[prefix];
  for (const key of Object.keys(process.env)) {
    if (key.startsWith(`${prefix}_`)) delete process.env[key];
  }
  values.forEach((value, index) => {
    if (index === 0) process.env[prefix] = value;
    else process.env[`${prefix}_${index + 1}`] = value;
  });
}

async function tempWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "test-web-search-compat-"));
}

/** Corre `runAgentLoop` con un `generateTextImpl` fake que solo anota qué
 * tools recibió — la tool nunca se ejecuta, así que ni siquiera hace
 * falta un `SearchProvider` real (ni de mentira) para el caso de env. */
async function toolNamesSeenByModel(extra: Partial<RunAgentLoopOptions>): Promise<string[]> {
  __resetProviderPoolsForTests();
  setOpenRouterCredentials("secret-test-6c");
  const dir = await tempWorkspace();
  let seen: string[] = [];
  const fake: RunAgentLoopOptions["generateTextImpl"] = async (opts) => {
    seen = Object.keys((opts as { tools: Record<string, unknown> }).tools);
    (opts as { onStepFinish?: (step: unknown) => void }).onStepFinish?.({ text: "listo", content: [] } as never);
    return {};
  };
  await runAgentLoop({ workspaceRoot: dir, repoRoot: dir, task: "tarea de prueba", modelId: "test/modelo-no-registrado", generateTextImpl: fake, ...extra });
  return seen;
}

async function main(): Promise<void> {
  console.log("== Fase 6C — prueba de aceptación (gate de compatibilidad de web_search) ==\n");

  const previousTavilyKey = process.env.TAVILY_API_KEY;

  // ============================================================
  // Unit: función pura
  // ============================================================
  console.log("--- Unit: isWebSearchCompatible ---");
  check("undefined → true", isWebSearchCompatible(undefined) === true);
  check("{} → true", isWebSearchCompatible({}) === true);
  check("{ webSearchCompatible: true } → true", isWebSearchCompatible({ webSearchCompatible: true }) === true);
  check("{ webSearchCompatible: false } → false", isWebSearchCompatible({ webSearchCompatible: false }) === false);

  // ============================================================
  // Roster real: los 3 modelos actuales no cambiaron de comportamiento
  // ============================================================
  console.log("\n--- Roster real: los modelos actuales conservan exactamente el comportamiento de 6B ---");
  {
    const enabled = getCodingAgentModels();
    check("hay exactamente 3 modelos habilitados para el Coding Agent", enabled.length === 3, enabled.map((m) => m.id));
    check(
      "ninguno declara webSearchCompatible (el default optimista queda representado por la AUSENCIA del campo)",
      enabled.every((m) => m.codingAgent && !("webSearchCompatible" in m.codingAgent)),
      enabled.map((m) => ({ id: m.id, codingAgent: m.codingAgent })),
    );
    check(
      "el gate real (sin override) los considera a los 3 compatibles",
      enabled.every((m) => isWebSearchCompatible(getCouncilModel(m.id)?.codingAgent)),
      enabled.map((m) => m.id),
    );
  }

  // ============================================================
  // Integración con runAgentLoop
  // ============================================================
  console.log("\n--- Caso 1: compatible + provider disponible (vía TAVILY_API_KEY del entorno) → web_search presente ---");
  {
    process.env.TAVILY_API_KEY = "tvly-fake-key-para-test-6c";
    const seen = await toolNamesSeenByModel({ webSearchCompatibleOverride: true });
    check("web_search está entre las tools que recibe el modelo", seen.includes("web_search"), seen);
    check("las 7 tools de siempre siguen presentes junto a web_search", ["list_files", "read_file", "write_file", "edit_file", "delete_file", "search_files", "run_typecheck"].every((t) => seen.includes(t)), seen);
  }

  console.log("\n--- Caso 2: incompatible + provider disponible (vía TAVILY_API_KEY del entorno) → web_search AUSENTE ---");
  {
    process.env.TAVILY_API_KEY = "tvly-fake-key-para-test-6c";
    const seen = await toolNamesSeenByModel({ webSearchCompatibleOverride: false });
    check("web_search NO está, pese a que TAVILY_API_KEY existe", !seen.includes("web_search"), seen);
    check("las 7 tools de siempre siguen intactas (el gate solo afecta a web_search)", ["list_files", "read_file", "write_file", "edit_file", "delete_file", "search_files", "run_typecheck"].every((t) => seen.includes(t)), seen);
  }

  console.log("\n--- Caso 3: incompatible + sin provider → web_search AUSENTE ---");
  {
    delete process.env.TAVILY_API_KEY;
    const seen = await toolNamesSeenByModel({ webSearchCompatibleOverride: false });
    check("web_search NO está", !seen.includes("web_search"), seen);
  }

  console.log("\n--- Caso 4: compatible + sin TAVILY_API_KEY → web_search AUSENTE (exactamente la lógica de 6B) ---");
  {
    delete process.env.TAVILY_API_KEY;
    const seen = await toolNamesSeenByModel({ webSearchCompatibleOverride: true });
    check("web_search NO está", !seen.includes("web_search"), seen);
    check("el set queda exactamente en las 7 tools base (sin web_search, sin run_script porque el workspace no tiene package.json)", seen.length === 7 && seen.includes("run_typecheck"), seen);
  }

  console.log("\n--- Caso 5: searchProvider inyectado explícitamente + override false → el provider explícito gana ---");
  {
    delete process.env.TAVILY_API_KEY;
    const explicitProvider: SearchProvider = { search: async () => [] };
    const seen = await toolNamesSeenByModel({ webSearchCompatibleOverride: false, searchProvider: explicitProvider });
    check("web_search SÍ está — la inyección explícita nunca la bloquea el gate", seen.includes("web_search"), seen);
  }

  console.log("\n--- Extra: sin ningún override (todo caso de producción), un modelo sin webSearchCompatible se comporta como en 6B ---");
  {
    process.env.TAVILY_API_KEY = "tvly-fake-key-para-test-6c";
    // "test/modelo-no-registrado" no está en el roster real → su
    // `codingAgent` es undefined → compatible por default → como 6B.
    const seen = await toolNamesSeenByModel({});
    check("con TAVILY_API_KEY y sin override, web_search está (igual que en 6B)", seen.includes("web_search"), seen);
    delete process.env.TAVILY_API_KEY;
    const seenWithoutKey = await toolNamesSeenByModel({});
    check("sin TAVILY_API_KEY y sin override, web_search no está (igual que en 6B)", !seenWithoutKey.includes("web_search"), seenWithoutKey);
  }

  // Restaurar el entorno como estaba.
  if (previousTavilyKey === undefined) delete process.env.TAVILY_API_KEY;
  else process.env.TAVILY_API_KEY = previousTavilyKey;

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} casos OK.`);
  if (passed !== results.length) process.exit(1);
}

main().catch((error) => {
  console.error("Error inesperado en la prueba:", error);
  process.exit(1);
});
