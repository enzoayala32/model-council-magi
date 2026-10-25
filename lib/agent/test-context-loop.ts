/**
 * Fase 8D/8A/8E — integración real en `runAgentLoop` (sin proveedor real).
 *
 * Usa un `generateTextImpl` falso que imita al SDK: llama `prepareStep` en
 * cada paso, ejecuta una tool real y entrega `usage`. Verifica briefing en
 * el system prompt, refresco tras una escritura, telemetría persistida,
 * replay tipo SSE, governor apagado por defecto/encendido explícito y
 * cancelación. La DB se crea en un cwd temporal (nunca la real).
 *
 * Uso: npm run agent:test-context-loop
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ModelMessage } from "ai";
import type { RunAgentLoopOptions } from "./loop";
import type { ContextUsagePayload } from "./context/usage";

const execFileAsync = promisify(execFile);
const results: boolean[] = [];
function check(ok: boolean, message: string, detail?: () => unknown) {
  console.log(ok ? `✅ ${message}` : `❌ ${message}${detail ? `\n   ${JSON.stringify(detail())}` : ""}`);
  results.push(ok);
}
const canon = (value: unknown) => JSON.stringify(value);
function checkEq(actual: unknown, expected: unknown, message: string) {
  check(canon(actual) === canon(expected), message, () => ({ esperado: expected, actual }));
}

type ToolLike = { execute: (input: unknown, options?: { abortSignal?: AbortSignal }) => Promise<unknown> };
const call = (tool: ToolLike, input: unknown, signal?: AbortSignal) => tool.execute(input, { abortSignal: signal });

function longHistory(): ModelMessage[] {
  return [
    { role: "user", content: "OBJETIVO: arreglar facturación" },
    { role: "assistant", content: [{ type: "text", text: `viejo ${"A".repeat(3_000)}` }] },
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "old-1", toolName: "read_file", input: { path: "src/a.ts" } }],
    },
    {
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "old-1", toolName: "read_file", output: { type: "json", value: { ok: false, error: "falló en src/a.ts: boom", content: "TOOL_SENTINEL" } } }],
    },
    { role: "assistant", content: [{ type: "text", text: `viejo dos ${"B".repeat(3_000)}` }] },
    { role: "user", content: "CORRECCIÓN: no toques la DB" },
    { role: "assistant", content: [{ type: "text", text: "reciente uno" }] },
    { role: "assistant", content: [{ type: "text", text: "reciente dos" }] },
  ];
}

async function main() {
  console.log("== Fase 8D/8A/8E — integración en runAgentLoop ==\n");

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "magi-context-loop-"));
  process.chdir(root);
  const workspace = path.join(root, "workspace");
  await fs.mkdir(path.join(workspace, "src"), { recursive: true });
  await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: "tmp", scripts: { test: "node -e \"console.log('ok')\"" } }), "utf-8");
  await fs.writeFile(path.join(workspace, "src/a.ts"), "export const a = 1;\n", "utf-8");
  await fs.writeFile(path.join(workspace, "src/b.ts"), "export const b = 1;\n", "utf-8");
  await execFileAsync("git", ["init"], { cwd: workspace });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: workspace });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: workspace });
  await execFileAsync("git", ["add", "-A"], { cwd: workspace });
  await execFileAsync("git", ["commit", "-m", "inicial"], { cwd: workspace });

  const { runAgentLoop, __resetProviderPoolsForTests } = await import("./loop");
  const { createProject } = await import("./project-store");
  const { createTask } = await import("./task-store");
  const { listEvents } = await import("./event-log");
  const { getDb } = await import("../db");

  __resetProviderPoolsForTests();
  process.env.OPENROUTER_API_KEY = "secret-context-loop";
  const project = await createProject({ name: "context-loop", localPath: workspace });
  const newTask = (prompt: string) => createTask({ projectId: project.id, modelId: "test/modelo-no-registrado", prompt }).id;

  try {
    console.log("--- Motor encendido: briefing, refresco y telemetría ---");
    {
      const taskId = newTask("arreglá src/a.ts");
      const systems: string[] = [];
      const usageSeen: ContextUsagePayload[] = [];
      const fake: RunAgentLoopOptions["generateTextImpl"] = async (opts) => {
        const o = opts as unknown as {
          system: string;
          tools: Record<string, ToolLike>;
          abortSignal?: AbortSignal;
          prepareStep?: (input: { messages: ModelMessage[]; stepNumber: number }) => Promise<{ system?: string; messages?: ModelMessage[] }>;
          onStepFinish?: (step: unknown) => void;
        };
        let messages: ModelMessage[] = [{ role: "user", content: "arreglá src/a.ts" }];
        const prepared0 = await o.prepareStep?.({ messages, stepNumber: 0 });
        systems.push(prepared0?.system ?? o.system);
        messages = prepared0?.messages ?? messages;
        const written = await call(o.tools.write_file, { path: "src/a.ts", content: "export const a = 2;\n" }, o.abortSignal);
        o.onStepFinish?.({
          stepNumber: 0,
          text: "escribí src/a.ts",
          content: [
            { type: "tool-call", toolCallId: "call-0", toolName: "write_file", input: { path: "src/a.ts", content: "export const a = 2;\n" } },
            { type: "tool-result", toolCallId: "call-0", toolName: "write_file", input: { path: "src/a.ts" }, output: written },
            { type: "text", text: "escribí src/a.ts" },
          ],
          toolCalls: [{ toolCallId: "call-0", toolName: "write_file", input: { path: "src/a.ts", content: "export const a = 2;\n" } }],
          toolResults: [{ toolCallId: "call-0", toolName: "write_file", input: { path: "src/a.ts" }, output: written }],
          usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
        } as never);
        messages = [...messages, { role: "assistant", content: [{ type: "text", text: "escribí src/a.ts" }] }];
        const prepared1 = await o.prepareStep?.({ messages, stepNumber: 1 });
        systems.push(prepared1?.system ?? o.system);
        o.onStepFinish?.({
          stepNumber: 1,
          text: "listo",
          content: [{ type: "text", text: "listo" }],
          toolCalls: [],
          toolResults: [],
          usage: { inputTokens: 110, outputTokens: 5, totalTokens: 115 },
        } as never);
        return {};
      };
      const result = await runAgentLoop({
        workspaceRoot: workspace,
        repoRoot: workspace,
        task: "arreglá src/a.ts",
        modelId: "test/modelo-no-registrado",
        taskId,
        generateTextImpl: fake,
        contextEngine: { enabled: true, refreshLimit: 2 },
      });
      check(result.stopReason === "completed" && result.steps === 2, "la task termina completed con 2 pasos", () => ({ stopReason: result.stopReason, steps: result.steps }));
      check(systems[0].includes("Contexto automático del proyecto"), "el system prompt del paso 0 incluye el briefing", () => systems[0].slice(-500));
      check(systems[0].includes("src/a.ts"), "el briefing incluye el archivo pedido", () => systems[0].slice(-500));
      check(systems[1].includes("Archivos ya tocados en esta corrida: src/a.ts"), "el briefing del paso 1 refleja la escritura", () => systems[1].slice(-500));
      usageSeen.push(...(result.contextUsage ?? []));
      checkEq(usageSeen.length, 2, "dos payloads context_usage en el resultado");
      checkEq(usageSeen[0].step, 1, "primer payload: paso 1");
      checkEq(usageSeen[1].step, 2, "segundo payload: paso 2");
      checkEq(usageSeen[0].providerUsage?.inputTokens, 100, "usage real del paso 0");
      checkEq(usageSeen[1].providerUsage?.inputTokens, 110, "usage real del paso 1");
      check(usageSeen[0].selection.enabled && usageSeen[0].selection.available, "selección habilitada y disponible", () => usageSeen[0].selection);
      checkEq(usageSeen[0].selection.generation, 0, "paso 0: snapshot inicial (generación 0)");
      check(usageSeen[1].selection.generation !== null && usageSeen[1].selection.generation > 0, "paso 1: snapshot refrescado a una generación nueva", () => usageSeen[1].selection);
      check(usageSeen[1].selection.refreshes >= 1, "el refresco se contó", () => usageSeen[1].selection);
      checkEq(usageSeen[0].governor.enabled, false, "governor apagado por defecto");
      checkEq(usageSeen[0].budget.usedSource, "provider", "el budget usa usage del proveedor");
      check(usageSeen.every((payload) => payload.estimate.messageCount >= 1), "la estimación local también viaja", () => usageSeen.map((payload) => payload.estimate.messageCount));

      const events = listEvents(taskId);
      const contextEvents = events.filter((event) => event.type === "context_usage");
      checkEq(contextEvents.length, 2, "se persistieron 2 eventos context_usage");
      check(contextEvents[0].seq < contextEvents[1].seq, "los eventos tienen seq creciente", () => contextEvents.map((event) => event.seq));
      const replay = listEvents(taskId, { sinceSeq: contextEvents[0].seq - 1 }).filter((event) => event.type === "context_usage");
      checkEq(replay.length, 2, "replay tipo SSE desde seq incluye ambos context_usage");
      const telemetryJson = canon(contextEvents.map((event) => event.payload));
      check(!telemetryJson.includes("arreglá src/a.ts"), "la telemetría NO contiene el pedido del usuario");
      check(!telemetryJson.includes("export const a = 2"), "la telemetría NO contiene el contenido del archivo");
      check(!telemetryJson.includes("secret-context-loop"), "la telemetría NO contiene la API key");
      check(events.some((event) => event.type === "tool_call" && (event.payload as { toolName?: string }).toolName === "write_file"), "el evento tool_call normal sigue existiendo");
    }

    console.log("\n--- Motor apagado (default): prompt y selección sin cambios ---");
    {
      const taskId = newTask("arreglá src/a.ts");
      let system = "";
      const fake: RunAgentLoopOptions["generateTextImpl"] = async (opts) => {
        const o = opts as { system: string; prepareStep?: (input: { messages: ModelMessage[]; stepNumber: number }) => Promise<{ system?: string }>; onStepFinish?: (step: unknown) => void };
        system = o.system;
        await o.prepareStep?.({ messages: [{ role: "user", content: "arreglá src/a.ts" }], stepNumber: 0 });
        o.onStepFinish?.({ stepNumber: 0, text: "ok", content: [{ type: "text", text: "ok" }], toolCalls: [], toolResults: [], usage: { inputTokens: 10, outputTokens: 2 } } as never);
        return {};
      };
      const result = await runAgentLoop({ workspaceRoot: workspace, repoRoot: workspace, task: "arreglá src/a.ts", modelId: "test/modelo-no-registrado", taskId, generateTextImpl: fake });
      check(!system.includes("Contexto automático del proyecto"), "sin contextEngine no se agrega briefing");
      const payload = result.contextUsage?.[0];
      check(payload !== undefined && payload.selection.enabled === false && payload.selection.generation === null, "la telemetría reporta motor apagado", () => payload?.selection);
      checkEq(payload?.governor.enabled, false, "governor apagado");
      checkEq(listEvents(taskId).filter((event) => event.type === "context_usage").length, 1, "igual se emite telemetría numérica (no altera el prompt)");
    }

    console.log("\n--- Telemetría desactivable ---");
    {
      const taskId = newTask("arreglá src/a.ts");
      const fake: RunAgentLoopOptions["generateTextImpl"] = async (opts) => {
        const o = opts as { onStepFinish?: (step: unknown) => void };
        o.onStepFinish?.({ stepNumber: 0, text: "ok", content: [{ type: "text", text: "ok" }], toolCalls: [], toolResults: [], usage: { inputTokens: 10, outputTokens: 2 } } as never);
        return {};
      };
      const result = await runAgentLoop({ workspaceRoot: workspace, repoRoot: workspace, task: "arreglá src/a.ts", modelId: "test/modelo-no-registrado", taskId, generateTextImpl: fake, contextTelemetry: false });
      checkEq(result.contextUsage, undefined, "contextTelemetry:false no devuelve payloads");
      checkEq(listEvents(taskId).filter((event) => event.type === "context_usage").length, 0, "tampoco persiste eventos");
    }

    console.log("\n--- Governor encendido explícitamente ---");
    {
      const taskId = newTask("arreglá facturación");
      let messagesAfter: ModelMessage[] = [];
      const fake: RunAgentLoopOptions["generateTextImpl"] = async (opts) => {
        const o = opts as { prepareStep?: (input: { messages: ModelMessage[]; stepNumber: number }) => Promise<{ messages?: ModelMessage[] }>; onStepFinish?: (step: unknown) => void };
        const prepared = await o.prepareStep?.({ messages: longHistory(), stepNumber: 0 });
        messagesAfter = prepared?.messages ?? [];
        o.onStepFinish?.({ stepNumber: 0, text: "ok", content: [{ type: "text", text: "ok" }], toolCalls: [], toolResults: [], usage: { inputTokens: 10, outputTokens: 2 } } as never);
        return {};
      };
      const result = await runAgentLoop({
        workspaceRoot: workspace,
        repoRoot: workspace,
        task: "arreglá facturación",
        modelId: "test/modelo-no-registrado",
        taskId,
        generateTextImpl: fake,
        historyGovernor: { enabled: true, triggerRatio: 0, keepRecentUnits: 2, minOldUnits: 2, maxSummaryChars: 2_000 },
      });
      const payload = result.contextUsage?.[0];
      check(payload !== undefined && payload.governor.enabled === true && payload.governor.applied === true, "el payload reporta governor aplicado", () => payload?.governor);
      check((payload?.governor.removedMessages ?? 0) > 0 && payload?.governor.version === 1, "se removieron mensajes y la versión quedó registrada", () => payload?.governor);
      check(messagesAfter.length < longHistory().length, "prepareStep devolvió el historial compactado", () => ({ before: longHistory().length, after: messagesAfter.length }));
      check(messagesAfter.some((message) => canon(message.content).includes("Historial compactado")), "el resumen del governor está en el historial efectivo");
      check(messagesAfter.some((message) => canon(message.content).includes("OBJETIVO: arreglar facturación")), "el objetivo del usuario sigue textual");
      check(!canon(messagesAfter).includes("TOOL_SENTINEL"), "el contenido viejo de tools no se copió");
    }

    console.log("\n--- Cancelación durante el arranque del motor ---");
    {
      const taskId = newTask("arreglá src/a.ts");
      const controller = new AbortController();
      controller.abort();
      const fake: RunAgentLoopOptions["generateTextImpl"] = async (opts) => {
        const o = opts as { abortSignal?: AbortSignal };
        if (o.abortSignal?.aborted) throw new Error("aborted");
        return {};
      };
      const result = await runAgentLoop({
        workspaceRoot: workspace,
        repoRoot: workspace,
        task: "arreglá src/a.ts",
        modelId: "test/modelo-no-registrado",
        taskId,
        generateTextImpl: fake,
        abortSignal: controller.signal,
        contextEngine: { enabled: true },
      });
      checkEq(result.stopReason, "timeout", "señal abortada → stopReason timeout, sin excepción");
      checkEq(result.contextUsage, undefined, "no hay pasos completados, no hay telemetría");
    }
  } finally {
    try {
      getDb().close();
    } catch {
      // best-effort
    }
    process.chdir(os.tmpdir());
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} casos OK.`);
  if (passed !== results.length) process.exit(1);
}

main().catch((error) => {
  console.error("Error inesperado en la prueba:", error);
  process.exit(1);
});
