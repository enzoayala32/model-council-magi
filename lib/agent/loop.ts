import { execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import path from "node:path";
import { generateText, stepCountIs, type StopCondition, type ToolSet } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createAgentTools, type AgentToolEvent } from "./tools";
import { getCouncilModel } from "../models";
import { appendEvent } from "./event-log";

const execFileAsync = promisify(execFile);

const DEFAULT_MAX_STEPS = 20;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const NO_PROGRESS_STEP_LIMIT = 10;

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
  /** Rutas que las tools reportaron haber escrito/editado con éxito,
   * independientemente de si terminaron en `proposals`. Existe porque
   * `proposals` depende de que `git status` detecte el cambio — un
   * archivo dentro de una carpeta gitignorada (local o global) puede
   * escribirse y compilar perfecto y aun así no aparecer ahí. Este
   * campo es la fuente de verdad de "¿la tool realmente actuó?". */
  touchedFiles: string[];
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
  /** Señal externa de cancelación (ej. desde `lib/agent/runner.ts`, cuando
   * el usuario cancela una task en `RUNNING`) — se combina con el timeout
   * interno, no lo reemplaza: cualquiera de los dos corta el loop. */
  abortSignal?: AbortSignal;
  /** Si se provee (Fase 2E), cada tool_call/tool_result/text/typecheck del
   * loop también se persiste en `agent_events` con este `taskId`, además
   * de seguir armando el `transcript` en memoria de siempre (no se rompe
   * ningún consumidor existente — `test-run.ts`/`stress-test.ts` no pasan
   * `taskId` y siguen funcionando idéntico, sin tocar SQLite). */
  taskId?: string;
};

const DEFAULT_CODING_MODEL = "nvidia/nemotron-3.5-lightning:free";

/** Mismo criterio que usa `runAgentLoop` por default — separado para que
 * quien dispare la corrida (ej. `test-run.ts`) pueda loguear el modelo
 * resuelto ANTES de arrancar, y así confirmar de entrada que el override
 * por `.env` (`OPENROUTER_CODING_MODEL`) surtió efecto o no. */
export function resolveCodingModelId(): { modelId: string; source: "env" | "default" } {
  const fromEnv = process.env.OPENROUTER_CODING_MODEL;
  return fromEnv ? { modelId: fromEnv, source: "env" } : { modelId: DEFAULT_CODING_MODEL, source: "default" };
}

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

/** NVIDIA NIM (build.nvidia.com) es un endpoint OpenAI-compatible — mismo
 * mecanismo que OpenRouter, distinta base URL/key. Mismo endpoint que ya
 * usa `lib/nvidia.ts` para el Council, solo que acá se le pasa el AI SDK
 * en vez de un fetch a mano. */
function buildNvidiaModel(modelId: string) {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) throw new Error("Falta NVIDIA_API_KEY en .env (conseguí una gratis en build.nvidia.com).");
  const provider = createOpenAI({ baseURL: "https://integrate.api.nvidia.com/v1", apiKey });
  return provider.chat(modelId);
}

/** Google AI Studio — usa el provider NATIVO de AI SDK (`@ai-sdk/google`,
 * habla contra generativelanguage.googleapis.com/v1beta directo), no el
 * shim OpenAI-compat que usan NVIDIA/OpenRouter. Motivo (Fase 2E, hallazgo
 * en una corrida real): toda la línea Gemini 3.x son modelos "thinking" que
 * firman su razonamiento con un `thought_signature` y lo devuelven en un
 * campo no estándar (`extra_content.google.thought_signature`, fuera del
 * spec de OpenAI). Cualquier cliente OpenAI-compat GENÉRICO (no es un
 * problema de este proyecto puntual — reportado igual en VS Code Copilot,
 * el propio openai-agents-python de OpenAI, open-webui, etc.) descarta ese
 * campo por no reconocerlo, y en el siguiente tool-call round-trip Google
 * rechaza el request con 400 "Function call is missing a thought_signature"
 * porque no puede verificar el razonamiento previo. El Council nunca lo
 * sufrió porque sus llamadas a Google son de un solo turno (sin
 * tool-calling multi-paso) — recién con el Coding Agent (multi-step) se
 * vuelve un problema real. El provider nativo maneja el signature
 * correctamente sin que el código de acá tenga que tocarlo. */
function buildGoogleModel(modelId: string) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Falta GEMINI_API_KEY en .env (conseguí una gratis en aistudio.google.com/apikey).");
  const google = createGoogleGenerativeAI({ apiKey });
  return google.chat(modelId);
}

/** Dispatcher multi-proveedor del Coding Agent Model Registry (ver diseño
 * de Fase 2, sección 15) — mismo criterio de ruteo por `provider` que ya
 * usa `runCouncilCompletion` en `lib/council-run.ts` para el Council, pero
 * devolviendo un `LanguageModel` de AI SDK en vez de una completion cruda.
 * Reemplaza el `buildOpenRouterModel` fijo que tenía el loop hasta Fase 2D
 * — todo modelo sigue siendo OpenRouter por default (el campo `provider`
 * solo está seteado en los entries NVIDIA/Google nativos de `models.ts`). */
function buildModelForId(modelId: string) {
  const councilModel = getCouncilModel(modelId);
  if (councilModel?.provider === "nvidia") return buildNvidiaModel(modelId);
  if (councilModel?.provider === "google") return buildGoogleModel(modelId);
  return buildOpenRouterModel(modelId);
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
    maxSteps = DEFAULT_MAX_STEPS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    modelId = resolveCodingModelId().modelId,
  } = options;

  const transcript: string[] = [];
  const lastProgressStepRef = { current: 0 };
  let lastTypeCheckOk: boolean | null = null;
  const touchedFiles = new Set<string>();

  const onEvent = (event: AgentToolEvent) => {
    lastProgressStepRef.current = currentStepIndex.current;
    touchedFiles.add(event.relPath);
    transcript.push(event.type === "file_written" ? `✏️  Escribió ${event.relPath}` : `✏️  Editó ${event.relPath}`);
  };
  const currentStepIndex = { current: 0 };

  const tools = createAgentTools(workspaceRoot, onEvent);
  const model = buildModelForId(modelId);

  const controller = new AbortController();
  const timeoutTimer = setTimeout(() => controller.abort(), timeoutMs);
  // La cancelación externa (usuario cancela la task) se combina con el
  // timeout interno — el que dispare primero corta el loop igual.
  if (options.abortSignal) {
    if (options.abortSignal.aborted) controller.abort();
    else options.abortSignal.addEventListener("abort", () => controller.abort(), { once: true });
  }

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
        if (step.text) {
          transcript.push(`💬 ${step.text.slice(0, 300)}`);
          if (options.taskId) appendEvent(options.taskId, { type: "text", text: step.text.slice(0, 300) });
        }
        for (const part of step.content) {
          if (part.type === "tool-call") {
            transcript.push(`🔧 ${part.toolName}(${JSON.stringify(part.input).slice(0, 200)})`);
            if (options.taskId) appendEvent(options.taskId, { type: "tool_call", toolName: part.toolName, input: part.input });
          }
          if (part.type === "tool-result") {
            const output = part.output as { ok?: boolean; error?: string; success?: boolean; output?: string } | undefined;
            if (part.toolName === "run_typecheck" && output && typeof output.success === "boolean") {
              lastTypeCheckOk = output.success;
              // `run_typecheck` siempre devuelve ok:true (la llamada en sí no
              // "falla"), así que sin esto nunca se ve SI tsc pasó o no, ni
              // por qué — quedaba igual de invisible que el bug de edit_file
              // que motivó el logueo de errores de más arriba.
              const excerpt = (output.output ?? "").split("\n").slice(0, 15).join("\n");
              transcript.push(output.success ? "✅ run_typecheck: compila limpio" : `❌ run_typecheck: hay errores —\n${excerpt}`);
              if (options.taskId) {
                appendEvent(options.taskId, { type: "typecheck_result", success: output.success, outputExcerpt: output.success ? undefined : excerpt });
              }
            }
            // Sin esto, una tool que falla de forma "prolija" (ok: false, con
            // error legible) queda invisible en el transcript — solo se ve
            // la llamada, nunca por qué no funcionó. Esto es justamente lo
            // que hacía imposible diagnosticar un edit_file fallido a
            // distancia con solo el log del usuario.
            if (output && output.ok === false) {
              transcript.push(`❌ ${part.toolName} falló: ${output.error ?? "sin detalle"}`);
              if (options.taskId) {
                appendEvent(options.taskId, { type: "tool_result", toolName: part.toolName, ok: false, error: output.error, summary: output.error ?? "sin detalle" });
              }
            } else if (output && output.ok === true && part.toolName !== "run_typecheck" && options.taskId) {
              appendEvent(options.taskId, { type: "tool_result", toolName: part.toolName, ok: true, summary: `${part.toolName} OK` });
            }
          }
        }
      },
    });
  } catch (error) {
    if (controller.signal.aborted) {
      stopReason = "timeout";
    } else {
      stopReason = "error";
      // Un `APICallError` de AI SDK (fetch a un proveedor real fallido) trae
      // `.message` == solo el texto HTTP genérico ("Bad Request") — el
      // motivo real está en `.responseBody`, que el proveedor sí manda
      // (ej. Google explica ahí por qué exactamente rechazó el request).
      // Sin esto, un 400/404/403 real queda indistinguible de cualquier
      // otro error, y depurar un proveedor nuevo (NVIDIA/Google nativos,
      // Fase 2E) a ciegas es prácticamente imposible.
      const responseBody = error && typeof error === "object" && "responseBody" in error ? String((error as { responseBody?: unknown }).responseBody ?? "").slice(0, 2000) : null;
      const baseMessage = error instanceof Error ? error.message : "Error desconocido en el loop del agente.";
      errorMessage = responseBody ? `${baseMessage} — respuesta del proveedor: ${responseBody}` : baseMessage;
    }
  } finally {
    clearTimeout(timeoutTimer);
  }

  if (stopReason === "completed" && currentStepIndex.current >= maxSteps) stopReason = "max_steps";
  if (stopReason === "completed" && currentStepIndex.current - lastProgressStepRef.current >= NO_PROGRESS_STEP_LIMIT) {
    stopReason = "no_progress";
  }

  const { stdout: rawGitStatus } = await execFileAsync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: workspaceRoot, maxBuffer: 8 * 1024 * 1024 }).catch(
    (err) => ({ stdout: `<git status falló: ${err instanceof Error ? err.message : String(err)}>` }),
  );
  const proposals = errorMessage ? [] : await buildProposals(rawGitStatus, workspaceRoot, lastTypeCheckOk);

  // Si una tool reportó haber escrito/editado un archivo pero git no lo ve
  // como cambio (típicamente: la ruta cae dentro de un .gitignore local o
  // GLOBAL del usuario — aunque ya se confirmó que NO es siempre el caso),
  // la propuesta final nunca lo va a incluir aunque el trabajo se haya
  // hecho bien. Avisamos explícito, con la salida cruda de git y una
  // verificación física de existencia, en vez de adivinar la causa otra
  // vez — así el próximo reporte trae evidencia, no una hipótesis más.
  const missingFromGit = Array.from(touchedFiles).filter((f) => !proposals.some((p) => p.relPath === f));
  if (missingFromGit.length) {
    const fsCheck = await import("node:fs/promises");
    const existsChecks = await Promise.all(
      missingFromGit.map(async (f) => {
        const exists = await fsCheck.stat(path.join(workspaceRoot, f)).then(() => true).catch(() => false);
        return `${f} (¿existe en disco ahora?: ${exists})`;
      }),
    );
    transcript.push(
      `⚠️ Estos archivos se escribieron/editaron con éxito pero no aparecen en la propuesta final: ${existsChecks.join(", ")}. ` +
        `Salida cruda de "git status --porcelain" en el worktree: ${JSON.stringify(rawGitStatus)}`,
    );
  }

  return { stopReason, steps: currentStepIndex.current, transcript, proposals, touchedFiles: Array.from(touchedFiles), error: errorMessage };
}

/** Arma un `AgentFileProposal` por cada archivo tocado en el worktree,
 * comparando contra HEAD (la raíz desde la que se creó el worktree) vía
 * git — no hace falta snapshotear contenido "antes" a mano. `rawGitStatus`
 * se recibe ya calculado (no se vuelve a pedir acá) para que quien llama
 * pueda loguear la salida cruda si hace falta diagnosticar una discrepancia. */
async function buildProposals(rawGitStatus: string, workspaceRoot: string, lastTypeCheckOk: boolean | null): Promise<AgentFileProposal[]> {
  const lines = rawGitStatus.split("\n").filter(Boolean);

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
  // `git show HEAD:path` devuelve el blob crudo (LF), pero en Windows el
  // checkout real del worktree suele tener CRLF (core.autocrlf) — sin
  // normalizar acá, CADA línea se ve "distinta" (un \r de más) y el diff
  // muestra el archivo entero como borrado+reescrito. Esto es solo para
  // la comparación/visualización: `nextContent` en la propuesta sigue
  // siendo el contenido real tal cual quedó en el worktree.
  const normalize = (text: string) => text.replace(/\r\n/g, "\n");
  const normalizedOld = normalize(oldText);
  const normalizedNew = normalize(newText);

  if (isNew) {
    const body = normalizedNew.split("\n").map((line) => `+${line}`).join("\n");
    return `--- /dev/null\n+++ ${relPath}\n${body}`;
  }
  const oldLines = normalizedOld.split("\n");
  const newLines = normalizedNew.split("\n");
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
