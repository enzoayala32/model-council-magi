/**
 * Fase 6B — prueba de aceptación de la tool `web_search` (`tools.ts`) y su
 * integración con `runAgentLoop` (`loop.ts`). Usa `SearchProvider` fake
 * inyectado — nunca la implementación real de Tavily ni red real (eso ya
 * lo cubre `test-search-provider.ts`). Mismo patrón de `generateTextImpl`
 * fake + `taskId` real (project+task) que ya usa
 * `test-provider-resilience.ts` para los eventos de Fase 5F.
 *
 * Uso: npm run agent:test-web-search-tool
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAgentTools, webSearchInputSchema } from "./tools";
import { runAgentLoop, __resetProviderPoolsForTests, type RunAgentLoopOptions } from "./loop";
import { createProject } from "./project-store";
import { createTask } from "./task-store";
import { listEvents } from "./event-log";
import type { SearchProvider, SearchResult } from "./search-provider";

let results: boolean[] = [];

function check(label: string, ok: boolean, detail?: unknown): void {
  results.push(ok);
  console.log(`${ok ? "✅" : "❌"} ${label}${ok ? "" : ` — ${JSON.stringify(detail)}`}`);
}

/** Igual que en `test-provider-resilience.ts` (5D/5F) — el loop necesita
 * una credential de OPENROUTER_API_KEY para siquiera empezar (eso pasa
 * ANTES de invocar `generateTextImpl`); estos tests son sobre `web_search`,
 * no sobre provider-resilience, así que alcanza con una credential
 * cualquiera y `__resetProviderPoolsForTests()` antes de cada caso. */
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
  return fs.mkdtemp(path.join(os.tmpdir(), "test-web-search-tool-"));
}

/** Igual que en `test-provider-resilience.ts` (Fase 5F): hace falta un
 * `agent_projects`/`agent_tasks` real porque `agent_events.task_id` tiene
 * una FK activa (better-sqlite3, `foreign_keys=ON` por default). */
async function makeRealTask(workspaceRoot: string): Promise<string> {
  const project = await createProject({ name: `test-6b-${Math.random().toString(36).slice(2, 8)}`, localPath: workspaceRoot });
  const task = createTask({ projectId: project.id, modelId: "test/modelo-no-registrado", prompt: "tarea de prueba, sin agente real" });
  return task.id;
}

function fakeProvider(search: SearchProvider["search"]): SearchProvider {
  return { search };
}

async function main(): Promise<void> {
  console.log("== Fase 6B — prueba de aceptación (tool web_search + loop) ==\n");

  // ============================================================
  // Tool: schema
  // ============================================================
  console.log("--- Caso 9: schema — input válido ---");
  {
    const r1 = webSearchInputSchema.safeParse({ query: "cómo usar zod" });
    const r2 = webSearchInputSchema.safeParse({ query: "cómo usar zod", maxResults: 3 });
    check("query sola es válida", r1.success, r1);
    check("query + maxResults dentro del rango es válido", r2.success, r2);
  }

  console.log("\n--- Caso 10: schema — input inválido ---");
  {
    const empty = webSearchInputSchema.safeParse({ query: "" });
    const missing = webSearchInputSchema.safeParse({});
    const tooMany = webSearchInputSchema.safeParse({ query: "algo", maxResults: 999 });
    const zero = webSearchInputSchema.safeParse({ query: "algo", maxResults: 0 });
    check("query vacía se rechaza", !empty.success, empty);
    check("sin query se rechaza", !missing.success, missing);
    check("maxResults por sobre el máximo permitido se rechaza", !tooMany.success, tooMany);
    check("maxResults=0 se rechaza (mínimo 1)", !zero.success, zero);
  }

  // ============================================================
  // Tool: ejecución con proveedor fake
  // ============================================================
  console.log("\n--- Caso 11: resultados correctamente normalizados ---");
  {
    const dir = await tempWorkspace();
    const provider = fakeProvider(async () => [{ title: "T", url: "https://x.com", snippet: "s" }]);
    const tools = createAgentTools(dir, () => {}, [], provider);
    const out = await (tools as any).web_search.execute({ query: "algo" }, undefined);
    check("ok:true, results con el shape exacto {title,url,snippet}", out.ok === true && out.results.length === 1 && Object.keys(out.results[0]).sort().join(",") === "snippet,title,url", out);
  }

  console.log("\n--- Caso 12: resultados limitados al máximo (aunque el proveedor mande más) ---");
  {
    const dir = await tempWorkspace();
    const provider = fakeProvider(async () => Array.from({ length: 20 }, (_, i) => ({ title: `T${i}`, url: `https://x.com/${i}`, snippet: `s${i}` })));
    const tools = createAgentTools(dir, () => {}, [], provider);
    const out = await (tools as any).web_search.execute({ query: "algo", maxResults: 2 }, undefined);
    check("la tool recorta a 2 pese a que el proveedor fake devolvió 20 (defensa en profundidad, no confía ciegamente en el proveedor)", out.ok === true && out.results.length === 2, out);
  }

  console.log("\n--- Caso 13: campos no permitidos se eliminan aunque el proveedor los incluya ---");
  {
    const dir = await tempWorkspace();
    // Un proveedor "mal portado" (viola su propio tipo a propósito, cast
    // para simular una implementación futura descuidada) que agrega
    // campos de más.
    const provider = fakeProvider(async () => [{ title: "T", url: "https://x.com", snippet: "s", score: 0.9, raw_content: "<html>" } as unknown as SearchResult]);
    const tools = createAgentTools(dir, () => {}, [], provider);
    const out = await (tools as any).web_search.execute({ query: "algo" }, undefined);
    check("el resultado que llega al modelo SOLO tiene title/url/snippet", Object.keys(out.results[0]).sort().join(",") === "snippet,title,url", out.results[0]);
  }

  console.log("\n--- Caso 14: un error del proveedor se convierte en {ok:false, error} — nunca tira la excepción ---");
  {
    const dir = await tempWorkspace();
    const provider = fakeProvider(async () => {
      throw new Error("Tavily respondió 503: servicio caído");
    });
    const tools = createAgentTools(dir, () => {}, [], provider);
    const out = await (tools as any).web_search.execute({ query: "algo" }, undefined);
    check("ok:false con el mensaje del proveedor", out.ok === false && out.error.includes("503"), out);
  }

  console.log("\n--- Caso 15: sin proveedor configurado, web_search directamente no existe como tool ---");
  {
    const dir = await tempWorkspace();
    const tools = createAgentTools(dir, () => {}, []); // sin 4to argumento, sin TAVILY_API_KEY en el entorno de test
    check("web_search no está en el set de tools", !("web_search" in tools), Object.keys(tools));
  }

  // ============================================================
  // Loop: integración real con runAgentLoop
  // ============================================================
  console.log("\n--- Caso 16/17: web_search se ejecuta desde el Agent real, tool_call y tool_result quedan en agent_events ---");
  {
    const dir = await tempWorkspace();
    __resetProviderPoolsForTests();
    setOpenRouterCredentials("secret-test-6b");
    const taskId = await makeRealTask(dir);
    const provider = fakeProvider(async (query) => [{ title: "Resultado", url: "https://x.com", snippet: `sobre ${query}` }]);
    const fake: RunAgentLoopOptions["generateTextImpl"] = async (opts) => {
      const toolsArg = (opts as { tools: Record<string, { execute: (input: unknown, options: unknown) => Promise<unknown> }> }).tools;
      const input = { query: "cómo usar zod" };
      const output = await toolsArg.web_search.execute(input, { abortSignal: (opts as { abortSignal?: AbortSignal }).abortSignal });
      (opts as { onStepFinish?: (step: unknown) => void }).onStepFinish?.({
        text: "",
        content: [
          { type: "tool-call", toolName: "web_search", input },
          { type: "tool-result", toolName: "web_search", input, output },
        ],
      } as never);
      return {};
    };
    const result = await runAgentLoop({ workspaceRoot: dir, repoRoot: dir, task: "buscá algo", modelId: "test/modelo-no-registrado", taskId, generateTextImpl: fake, searchProvider: provider });
    check("stopReason completed", result.stopReason === "completed", result);
    const events = listEvents(taskId);
    const toolCall = events.find((e) => e.type === "tool_call" && (e.payload as { toolName?: string }).toolName === "web_search");
    const toolResult = events.find((e) => e.type === "tool_result" && (e.payload as { toolName?: string }).toolName === "web_search");
    check("quedó un evento tool_call para web_search con la query real", !!toolCall && (toolCall.payload as { input?: { query?: string } }).input?.query === "cómo usar zod", toolCall);
    check("quedó un evento tool_result ok:true para web_search", !!toolResult && (toolResult.payload as { ok?: boolean }).ok === true, toolResult);
  }

  console.log("\n--- Caso 18: un fallo de búsqueda no rompe el loop — la task sigue, no se cae ---");
  {
    const dir = await tempWorkspace();
    __resetProviderPoolsForTests();
    setOpenRouterCredentials("secret-test-6b");
    const taskId = await makeRealTask(dir);
    const provider = fakeProvider(async () => {
      throw new Error("Tavily respondió 500");
    });
    const fake: RunAgentLoopOptions["generateTextImpl"] = async (opts) => {
      const toolsArg = (opts as { tools: Record<string, { execute: (input: unknown, options: unknown) => Promise<unknown> }> }).tools;
      const input = { query: "algo" };
      const output = await toolsArg.web_search.execute(input, undefined);
      (opts as { onStepFinish?: (step: unknown) => void }).onStepFinish?.({ text: "vi que la búsqueda falló, sigo sin ella", content: [{ type: "tool-result", toolName: "web_search", input, output }] } as never);
      return {};
    };
    const result = await runAgentLoop({ workspaceRoot: dir, repoRoot: dir, task: "buscá algo", modelId: "test/modelo-no-registrado", taskId, generateTextImpl: fake, searchProvider: provider });
    check("el loop igual termina completed — un ok:false de una tool no es un error del loop", result.stopReason === "completed", result);
    const toolResult = listEvents(taskId).find((e) => e.type === "tool_result");
    check("el evento tool_result quedó registrado con ok:false y el error real", !!toolResult && (toolResult.payload as { ok?: boolean; error?: string }).ok === false && !!(toolResult.payload as { error?: string }).error?.includes("500"), toolResult);
  }

  console.log("\n--- Caso 19: el Agent sigue funcionando sin Search configurado (sin key, sin provider inyectado) ---");
  {
    const dir = await tempWorkspace();
    __resetProviderPoolsForTests();
    setOpenRouterCredentials("secret-test-6b");
    const taskId = await makeRealTask(dir);
    delete process.env.TAVILY_API_KEY;
    let sawWebSearchTool = false;
    const fake: RunAgentLoopOptions["generateTextImpl"] = async (opts) => {
      const toolsArg = (opts as { tools: Record<string, unknown> }).tools;
      sawWebSearchTool = "web_search" in toolsArg;
      (opts as { onStepFinish?: (step: unknown) => void }).onStepFinish?.({ text: "listo, sin buscar nada", content: [] } as never);
      return {};
    };
    const result = await runAgentLoop({ workspaceRoot: dir, repoRoot: dir, task: "tarea sin búsqueda", modelId: "test/modelo-no-registrado", taskId, generateTextImpl: fake });
    check("stopReason completed — el Agent funciona idéntico a antes de 6B", result.stopReason === "completed", result);
    check("web_search NUNCA apareció entre las tools ofrecidas al modelo", !sawWebSearchTool, sawWebSearchTool);
  }

  console.log("\n--- Caso 20: cancelación no deja la ejecución esperando indefinidamente ---");
  {
    const dir = await tempWorkspace();
    __resetProviderPoolsForTests();
    setOpenRouterCredentials("secret-test-6b");
    const taskId = await makeRealTask(dir);
    // El proveedor NUNCA resuelve por sí solo — la única forma de que esto
    // termine es que el abort/timeout de 6A (wrapToolExecute) realmente
    // llegue hasta acá. Se usa `timeoutMs: 50` en el loop (en vez de
    // esperar los 20_000ms reales de SEARCH_POLICY en producción) para que
    // el test sea rápido — el resultado es igual de determinista: sin
    // abort, esto colgaría para siempre; con abort, SIEMPRE termina rápido,
    // sea cual sea la velocidad de la máquina.
    const provider = fakeProvider(() => new Promise<SearchResult[]>(() => {}));
    const fake: RunAgentLoopOptions["generateTextImpl"] = async (opts) => {
      const toolsArg = (opts as { tools: Record<string, { execute: (input: unknown, options: unknown) => Promise<unknown> }> }).tools;
      const output = await toolsArg.web_search.execute({ query: "algo" }, { abortSignal: (opts as { abortSignal?: AbortSignal }).abortSignal });
      (opts as { onStepFinish?: (step: unknown) => void }).onStepFinish?.({ text: "", content: [{ type: "tool-result", toolName: "web_search", input: { query: "algo" }, output }] } as never);
      return {};
    };
    const start = Date.now();
    const result = await runAgentLoop({ workspaceRoot: dir, repoRoot: dir, task: "buscá algo que nunca vuelve", modelId: "test/modelo-no-registrado", taskId, timeoutMs: 50, generateTextImpl: fake, searchProvider: provider });
    const elapsedMs = Date.now() - start;
    check("el loop termina en un tiempo acotado (no cuelga) pese a que la tool nunca iba a resolver por sí sola", elapsedMs < 5_000, { stopReason: result.stopReason, elapsedMs });
  }

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} casos OK.`);
  if (passed !== results.length) process.exit(1);
}

main().catch((error) => {
  console.error("Error inesperado en la prueba:", error);
  process.exit(1);
});
