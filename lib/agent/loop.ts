import { execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import path from "node:path";
import { generateText, stepCountIs, type StopCondition, type ToolSet } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAgentTools, type AgentToolEvent } from "./tools";

const execFileAsync = promisify(execFile);

const DEFAULT_MAX_STEPS = 20;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const NO_PROGRESS_STEP_LIMIT = 7;

export type TypeCheckResult = { status: "skipped" | "ok" | "error"; errors?: string[] };

/** Mismo shape que `FileProposal` en `lib/fs-tools.ts` (sin `id`/`groupId`,
 * que asigna quien reciba estas propuestas al integrarlas a la cola real) —
 * así el diff final del Coding Agent se puede volcar directo a
 * `FileProposalsPanel` sin duplicar la UI de revisión. */
export type AgentFileProposal = {
  kind: "write" | "edit";
  relPath: string;
  diff: string;
  nextContent: string;
  baselineHash: string;
  typeCheck: TypeCheckResult;
};

export type AgentLoopResult = {
  stopReason: "completed" | "max_steps" | "timeout" | "no_progress" | "error";
  steps: number;
  transcript: string[]; // resumen legible paso a paso, para debug/logs
  proposals: AgentFileProposal[];
  error?: string;
};

export type RunAgentLoopOptions = {
  task: string;
  workspaceRoot: string;
  repoRoot: string;
  maxSteps?: number;
  timeoutMs?: number;
  /** Model id de OpenRouter. Default: OPENROUTER_CODING_MODEL o un modelo con buen soporte de tool-use. */
  modelId?: string;
};

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text, "utf-8").digest("hex");
}

const SYSTEM_PROMPT = `Sos un agente de programación autónomo que trabaja dentro de un workspace git aislado (un worktree temporal, ya en la raíz del proyecto — todas las rutas que uses son relativas a esa raíz).

Tu ciclo de trabajo es: orientarte → leer/buscar → editar → verificar con run_typecheck → corregir si hace falta → repetir, hasta que la tarea esté resuelta y el proyecto compile limpio.

Herramientas disponibles:
- list_files: lista rutas de archivos (con filtro opcional por extensión o nombre). Usala primero si no sabés qué archivos existen — NO sirve para buscar texto adentro de archivos.
- search_files: busca un texto literal dentro del contenido de los archivos (no es un buscador de nombres de archivo).
- read_file / write_file / edit_file: leer, crear/reescribir, o editar una porción puntual de un archivo.
- run_typecheck: corre tsc sobre todo el proyecto.

Reglas:
- Si no conocés la estructura del proyecto, empezá con list_files antes de adivinar rutas.
- Primero explorá con read_file / search_files antes de editar — no asumas contenido que no leíste.
- Usá edit_file para cambios puntuales a un archivo existente (necesita que oldStr sea único en el archivo); usá write_file solo para archivos nuevos o reescrituras completas.
- Corré run_typecheck después de terminar los cambios de código (no en cada paso individual, es lento) y corregí lo que encuentres.
- No hagas cambios fuera del alcance de la tarea pedida.
- Cuando termines, respondé con un resumen breve en texto de qué cambiaste y por qué — sin volver a llamar ninguna tool.`;

function buildOpenRouterModel(modelId: string) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("Falta OPENROUTER_API_KEY en .env.");
  const provider = createOpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey,
    headers: {
      "HTTP-Referer": process.env.OPENROUTER_SITE_URL ?? "http://localhost:3000",
      "X-Title": process.env.OPENROUTER_APP_NAME ?? "Consenso IA — Coding Agent",
    },
  });
  return provider.chat(modelId);
}

/** Stop condition custom: si pasaron `limit` pasos sin que ninguna tool
 * haya escrito/editado un archivo con éxito, cortamos — el modelo está
 * dando vueltas sin avanzar (o solo leyendo/buscando en loop). */
function noProgressFor(limit: number, lastProgressStepRef: { current: number }): StopCondition<ToolSet> {
  return ({ steps }) => steps.length - lastProgressStepRef.current >= limit;
}

export async function runAgentLoop(options: RunAgentLoopOptions): Promise<AgentLoopResult> {
  const {
    task,
    workspaceRoot,
    repoRoot,
    maxSteps = DEFAULT_MAX_STEPS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    modelId = process.env.OPENROUTER_CODING_MODEL ?? "nvidia/nemotron-3.5-lightning:free",
  } = options;

  const transcript: string[] = [];
  const lastProgressStepRef = { current: 0 };
  let lastTypeCheckOk: boolean | null = null;

  const onEvent = (event: AgentToolEvent) => {
    lastProgressStepRef.current = currentStepIndex.current;
    transcript.push(event.type === "file_written" ? `✏️  Escribió ${event.relPath}` : `✏️  Editó ${event.relPath}`);
  };
  const currentStepIndex = { current: 0 };

  const tools = createAgentTools(workspaceRoot, onEvent);
  const model = buildOpenRouterModel(modelId);

  const controller = new AbortController();
  const timeoutTimer = setTimeout(() => controller.abort(), timeoutMs);

  let stopReason: AgentLoopResult["stopReason"] = "completed";
  let errorMessage: string | undefined;

  try {
    await generateText({
      model,
      system: SYSTEM_PROMPT,
      prompt: task,
      tools,
      abortSignal: controller.signal,
      stopWhen: [stepCountIs(maxSteps), noProgressFor(NO_PROGRESS_STEP_LIMIT, lastProgressStepRef)],
      onStepFinish: (step) => {
        currentStepIndex.current += 1;
        if (step.text) transcript.push(`💬 ${step.text.slice(0, 300)}`);
        for (const part of step.content) {
          if (part.type === "tool-call") transcript.push(`🔧 ${part.toolName}(${JSON.stringify(part.input).slice(0, 200)})`);
          if (part.type === "tool-result" && part.toolName === "run_typecheck") {
            const output = part.output as { success?: boolean } | undefined;
            if (output && typeof output.success === "boolean") lastTypeCheckOk = output.success;
          }
        }
      },
    });
  } catch (error) {
    if (controller.signal.aborted) {
      stopReason = "timeout";
    } else {
      stopReason = "error";
      errorMessage = error instanceof Error ? error.message : "Error desconocido en el loop del agente.";
    }
  } finally {
    clearTimeout(timeoutTimer);
  }

  if (stopReason === "completed" && currentStepIndex.current >= maxSteps) stopReason = "max_steps";
  if (stopReason === "completed" && currentStepIndex.current - lastProgressStepRef.current >= NO_PROGRESS_STEP_LIMIT) {
    stopReason = "no_progress";
  }

  const proposals = errorMessage ? [] : await buildProposals(repoRoot, workspaceRoot, lastTypeCheckOk);

  return { stopReason, steps: currentStepIndex.current, transcript, proposals, error: errorMessage };
}

/** Arma un `AgentFileProposal` por cada archivo tocado en el worktree,
 * comparando contra HEAD (la raíz desde la que se creó el worktree) vía
 * git — no hace falta snapshotear contenido "antes" a mano. */
async function buildProposals(repoRoot: string, workspaceRoot: string, lastTypeCheckOk: boolean | null): Promise<AgentFileProposal[]> {
  const { stdout } = await execFileAsync("git", ["status", "--porcelain"], { cwd: workspaceRoot, maxBuffer: 8 * 1024 * 1024 });
  const lines = stdout.split("\n").filter(Boolean);

  const typeCheck: TypeCheckResult =
    lastTypeCheckOk === null ? { status: "skipped" } : lastTypeCheckOk ? { status: "ok" } : { status: "error", errors: ["Ver output de run_typecheck en el transcript."] };

  const proposals: AgentFileProposal[] = [];
  for (const line of lines) {
    const status = line.slice(0, 2).trim();
    const relPath = line.slice(3).trim();
    if (status === "D") continue; // Fase 1: no proponemos borrados, solo write/edit.

    const isNew = status === "??" || status === "A";
    let oldContent = "";
    if (!isNew) {
      try {
        const { stdout: headContent } = await execFileAsync("git", ["show", `HEAD:${relPath}`], { cwd: workspaceRoot, maxBuffer: 8 * 1024 * 1024 });
        oldContent = headContent;
      } catch {
        // No estaba en HEAD por algún motivo raro (ej. renombre) — tratamos como nuevo.
      }
    }

    let nextContent = "";
    try {
      const fs = await import("node:fs/promises");
      nextContent = await fs.readFile(path.join(workspaceRoot, relPath), "utf-8");
    } catch {
      continue; // el archivo ya no existe (pudo haber sido creado y borrado en el mismo loop)
    }

    proposals.push({
      kind: isNew ? "write" : "edit",
      relPath,
      diff: buildDiff(oldContent, nextContent, relPath, isNew),
      nextContent,
      baselineHash: sha256(oldContent),
      typeCheck,
    });
  }
  return proposals;
}

/* Diff LCS simple, mismo formato que `lib/fs-tools.ts` (sin hunk headers,
 * línea por línea con prefijo +/-/espacio) para que un futuro `DiffView`
 * lo renderice igual sin cambios. Copia self-contained a propósito — el
 * Coding Agent no importa nada de fs-tools.ts. */
function buildDiff(oldText: string, newText: string, relPath: string, isNew: boolean): string {
  if (isNew) {
    const body = newText.split("\n").map((line) => `+${line}`).join("\n");
    return `--- /dev/null\n+++ ${relPath}\n${body}`;
  }
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const ops = diffLines(oldLines, newLines);
  const out: string[] = [`--- ${relPath}`, `+++ ${relPath}`];
  for (const op of ops) {
    if (op.type === "equal") out.push(` ${op.line}`);
    else if (op.type === "del") out.push(`-${op.line}`);
    else out.push(`+${op.line}`);
  }
  return out.join("\n");
}

type DiffOp = { type: "equal" | "add" | "del"; line: string };

function diffLines(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "equal", line: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "del", line: a[i] });
      i++;
    } else {
      ops.push({ type: "add", line: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ type: "del", line: a[i++] });
  while (j < m) ops.push({ type: "add", line: b[j++] });
  return ops;
}
