/**
 * Etapa 2.2 (sub-bloque 3) — red de seguridad para `context_too_large`.
 *
 * QUÉ SE ARREGLA: `classifyProviderError` marca el error de contexto como
 * PERMANENT —sin reintentar la misma key, sin rotar, sin fallback de modelo—.
 * Es correcto como regla general (reintentar lo mismo no arregla un contexto
 * demasiado largo), pero dejaba la corrida en un callejón sin salida: la task
 * moría con `error` aunque se podía compactar el historial y reintentar. Esa
 * recuperación es lo que se fija acá.
 *
 * Sin red: el fallo lo simula un `generateTextImpl` que rechaza UNA vez con el
 * mensaje real de un proveedor y después acepta. La workspace es un repo git
 * temporal con un `AGENTS.md` de relleno, y la DB cae en un `MAGI_DATA_DIR`
 * temporal.
 *
 * Uso: npm run agent:test-context-recovery
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ModelMessage } from "ai";
import { runAgentLoop, type RunAgentLoopOptions } from "./loop";
import { listEvents } from "./event-log";
import { createProject } from "./project-store";
import { createTask } from "./task-store";
import { __resetProviderPoolsForTests } from "../provider-resilience/registry";

const execFileAsync = promisify(execFile);

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passed += 1;
    console.log("+ " + label);
    return;
  }
  failed += 1;
  const suffix = detail === undefined ? "" : " - " + JSON.stringify(detail).slice(0, 400);
  console.log("x " + label + suffix);
}

/** El mensaje que devuelve un proveedor cuando el contexto se pasa. */
const CONTEXT_TOO_LARGE = Object.assign(new Error("This model's maximum context length is 262144 tokens"), { statusCode: 400 });

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
      content: [
        {
          type: "tool-result",
          toolCallId: "old-1",
          toolName: "read_file",
          output: { type: "json", value: { ok: false, error: "falló en src/a.ts: boom", content: "SENTINEL_VIEJO" } },
        },
      ],
    },
    { role: "assistant", content: [{ type: "text", text: `viejo dos ${"B".repeat(3_000)}` }] },
    { role: "user", content: "CORRECCIÓN: no toques la DB" },
    { role: "assistant", content: [{ type: "text", text: "reciente uno" }] },
    { role: "assistant", content: [{ type: "text", text: "reciente dos" }] },
  ];
}

async function main(): Promise<void> {
  if (!process.env.MAGI_DATA_DIR) {
    process.env.MAGI_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "magi-recovery-"));
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "magi-recovery-test-"));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(path.join(workspace, "src"), { recursive: true });
  await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: "tmp", scripts: {} }), "utf-8");
  await fs.writeFile(path.join(workspace, "src/a.ts"), "export const a = 1;\n", "utf-8");
  await execFileAsync("git", ["init"], { cwd: workspace });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: workspace });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: workspace });
  await execFileAsync("git", ["add", "-A"], { cwd: workspace });
  await execFileAsync("git", ["commit", "-m", "inicial"], { cwd: workspace });

  const project = await createProject({ name: "context-recovery", localPath: workspace });

  // Modelo del roster real: con ventana CONOCIDA (262.144, tabla con fuente).
  // Con `modelId` desconocido el presupuesto blando caería a 32k y el test no
  // estaría midiendo lo que dice medir.
  const MODEL_ID = "nvidia/nemotron-3.5-lightning-30b-a3b";
  __resetProviderPoolsForTests();
  process.env.NVIDIA_API_KEY = "fake-key-solo-para-el-pool";

  console.log("== context_too_large: compacta UNA vez y reintenta la misma credential ==\n");

  {
    const taskId = createTask({ projectId: project.id, modelId: MODEL_ID, prompt: "arreglá src/a.ts" }).id;
    const sistemas: string[] = [];
    const mensajesVistos: ModelMessage[][] = [];
    let llamada = 0;
    const fake: RunAgentLoopOptions["generateTextImpl"] = async (opts) => {
      const o = opts as unknown as {
        system: string;
        prepareStep?: (input: { messages: ModelMessage[]; stepNumber: number }) => Promise<{ system?: string; messages?: ModelMessage[] }>;
        onStepFinish?: (step: unknown) => void;
      };
      llamada += 1;
      if (llamada === 1) throw CONTEXT_TOO_LARGE;
      const prepared = await o.prepareStep?.({ messages: longHistory(), stepNumber: 0 });
      sistemas.push(String(prepared?.system ?? o.system));
      mensajesVistos.push(prepared?.messages ?? []);
      o.onStepFinish?.({ stepNumber: 0, text: "ok", content: [], toolCalls: [], toolResults: [], usage: { inputTokens: 10, outputTokens: 2 } } as never);
      return { text: "ok", steps: [{ text: "ok" }], usage: { inputTokens: 10, outputTokens: 2 } };
    };

    const resultado = await runAgentLoop({
      task: "arreglá src/a.ts",
      workspaceRoot: workspace,
      repoRoot: workspace,
      modelId: MODEL_ID,
      taskId,
      // maxSteps 3, no 1: el reintento tras `context_too_large` consume
      // presupuesto de pasos (el step que falló también cuenta), así que con 1
      // la corrida terminaba en `max_steps` aunque la recuperación hubiera
      // funcionado.
      maxSteps: 3,
      timeoutMs: 20_000,
      generateTextImpl: fake,
    });

    check("la corrida NO muere: termina completed", resultado.stopReason === "completed", { stopReason: resultado.stopReason, error: resultado.error });
    check("el modelo se llamó 2 veces (falló una, reintentó otra)", llamada === 2, llamada);

    // El reintento tiene que haber mandado MENOS mensajes que el original.
    const mensajesReintento = mensajesVistos[0] ?? [];
    check("el reintento mandó el historial compactado", mensajesReintento.length > 0 && mensajesReintento.length < longHistory().length, {
      original: longHistory().length,
      reintento: mensajesReintento.length,
    });
    check("el resumen del governor viaja en el reintento", JSON.stringify(mensajesReintento).includes("Historial compactado"), JSON.stringify(mensajesReintento).slice(0, 200));
    check("el objetivo del usuario sobrevivió a la compactación", JSON.stringify(mensajesReintento).includes("OBJETIVO: arreglar facturación"));
    check("el contenido viejo de tools NO se copió al resumen", !JSON.stringify(mensajesReintento).includes("SENTINEL_VIEJO"));

    // Telemetría: la compactación forzada queda registrada como forzada.
    const governor = resultado.contextUsage?.[0]?.governor;
    check("el payload marca la compactación como forzada", governor?.forced === true, governor);
    check("y registra que removió mensajes", (governor?.removedMessages ?? 0) > 0, governor);
    const eventos = listEvents(taskId).filter((e) => e.type === "context_compaction_forced");
    check("queda un evento context_compaction_forced", eventos.length === 1, eventos.length);
    const payloadEvento = (eventos[0] as { payload?: { credentialId?: string; reason?: string } } | undefined)?.payload;
    check("el evento nombra la credential del pool (nunca la key)", typeof payloadEvento?.credentialId === "string" && payloadEvento.credentialId.startsWith("nvidia-"), payloadEvento);
    check("el evento lleva el motivo del clasificador", payloadEvento?.reason === "context_too_large", payloadEvento);
  }

  console.log("");
  console.log("== el reintento es UNO: aunque todas las llamadas fallen, no hay bucle ==");
  console.log("");

  {
    // La garantía que importa de la red de seguridad: reintenta UNA vez. Si el
    // proveedor sigue rechazando, la task termina en error en vez de quedarse
    // compactando y reintentando para siempre (que vaciaría el historial y
    // gastaría tokens sin servir de nada).
    const taskId = createTask({ projectId: project.id, modelId: MODEL_ID, prompt: "siempre falla" }).id;
    let llamada = 0;
    const fake: RunAgentLoopOptions["generateTextImpl"] = async () => {
      llamada += 1;
      throw CONTEXT_TOO_LARGE;
    };

    const resultado = await runAgentLoop({
      task: "siempre falla",
      workspaceRoot: workspace,
      repoRoot: workspace,
      modelId: MODEL_ID,
      taskId,
      maxSteps: 3,
      timeoutMs: 20_000,
      generateTextImpl: fake,
    });

    check("aunque falle siempre, el modelo se llamo solo 2 veces (un reintento)", llamada === 2, llamada);
    check("y la task termina en error, sin bucle", resultado.stopReason === "error", { stopReason: resultado.stopReason, error: resultado.error });
    check("el error final es el del proveedor, no de la compactacion", String(resultado.error ?? "").includes("maximum context length"), resultado.error);
    const eventos = listEvents(taskId).filter((e) => e.type === "context_compaction_forced");
    check("se emite UN solo evento de compactacion forzada", eventos.length === 1, eventos.length);
  }

  await fs.rm(root, { recursive: true, force: true });
  console.log("");
  console.log(passed + "/" + (passed + failed) + " casos OK");
  if (failed > 0) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
