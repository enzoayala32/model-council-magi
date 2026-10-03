/**
 * Fase 6D — cierra el hueco real que 6A dejó documentado y que el propio
 * test de 6D confirmó: con `shell:true` (necesario para que `npx`/`npm`
 * resuelvan en Windows), matar solo el proceso que Node conoce (la shell)
 * NUNCA mata a los procesos reales que esa shell lanzó — quedan huérfanos,
 * corriendo en segundo plano, hasta que terminan solos.
 *
 * Verificado empíricamente (no asumido) antes de escribir esto:
 * - `execFile(...,{shell:true, detached:true})` NO agrupa el proceso de
 *   shell en su propio *process group* — su PGID queda igual al del
 *   proceso padre, y `process.kill(-pid, ...)` falla con `ESRCH`.
 * - `spawn(...,{shell:true, detached:true})` SÍ lo hace correctamente
 *   (PGID == PID del proceso de shell) — por eso este helper usa `spawn`,
 *   nunca `execFile`/`execFileAsync`.
 *
 * Por esto, en vez de agrandar la superficie de cancelación de
 * `wrapToolExecute` (que ya hace lo que le corresponde: quedarse esperando
 * como máximo `policy.timeoutMs` y devolver un resultado consistente),
 * este helper vive un nivel más abajo, específico de las 2 tools que
 * ejecutan procesos reales (`run_typecheck`/`run_script` en `tools.ts`) —
 * es el único lugar que sabe cómo matar el árbol de procesos de verdad en
 * cada plataforma.
 */
import { spawn, execFile } from "node:child_process";

export type ExecWithTreeKillOptions = {
  cwd: string;
  /** Tope combinado de stdout+stderr, en bytes — mismo rol que
   * `maxBuffer` de `execFile`, reimplementado a mano acá porque `spawn`
   * no lo da gratis. */
  maxBuffer: number;
  /** Timeout de producción: 120_000 (mismo valor que ya usaba
   * `execFileAsync`). Configurable únicamente para que los tests puedan
   * usar valores chicos y deterministas — nunca se pasa un valor distinto
   * de 120_000 desde `tools.ts` en producción. */
  timeoutMs: number;
  /** El mismo `options.abortSignal` que 6A ya reenvía a cada tool. */
  signal?: AbortSignal;
};

export type ExecWithTreeKillResult = { stdout: string; stderr: string };

/** Shape compatible con lo que `errorOutput()` en `tools.ts` ya sabe leer
 * (`.stdout`/`.stderr`/`.message`) — cero cambios necesarios ahí. */
export class ExecWithTreeKillError extends Error {
  stdout: string;
  stderr: string;
  killed: boolean;
  signal: NodeJS.Signals | null;
  code: number | string | null;
  constructor(message: string, opts: { stdout: string; stderr: string; killed: boolean; signal?: NodeJS.Signals | null; code?: number | string | null }) {
    super(message);
    this.name = "ExecWithTreeKillError";
    this.stdout = opts.stdout;
    this.stderr = opts.stderr;
    this.killed = opts.killed;
    this.signal = opts.signal ?? null;
    this.code = opts.code ?? null;
  }
}

/** Mata el árbol de procesos completo enraizado en `pid` — nunca solo el
 * proceso de shell que Node conoce. Fire-and-forget a propósito: si el
 * proceso (o el árbol) ya había terminado por su cuenta, tanto
 * `process.kill(-pid,...)` (ESRCH) como `taskkill` (código de error, PID
 * no encontrado) simplemente fallan sin efecto — es exactamente el
 * resultado correcto, no hay nada que matar. */
function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    // Argumentos separados, nunca un string armado a mano — `taskkill`
    // corre como comando propio, no interpolado dentro de otra shell.
    execFile("taskkill", ["/PID", String(pid), "/T", "/F"], () => {
      /* se ignora el resultado a propósito — ver comentario de arriba */
    });
  } else {
    try {
      // `-pid`: la sintaxis de `kill(2)` para "todo el process group",
      // no un PID individual. Solo agrupa correctamente porque el
      // proceso se spawneó con `detached:true` en esta misma función.
      process.kill(-pid, "SIGTERM");
    } catch {
      // ESRCH — el grupo ya no existe (el proceso ya había terminado).
    }
  }
}

/**
 * Reemplazo de `execFileAsync(command, args, {cwd, maxBuffer, timeout,
 * shell:true, signal})` que además mata el ÁRBOL real de procesos (no
 * solo la shell) cuando dispara el timeout o el `AbortSignal` —
 * cualquiera de los dos, por cualquier orden, con una única operación de
 * terminación idempotente (si ambos disparan casi juntos, el segundo es
 * un no-op).
 */
export function execWithTreeKill(command: string, args: string[], options: ExecWithTreeKillOptions): Promise<ExecWithTreeKillResult> {
  return new Promise((resolve, reject) => {
    const { cwd, maxBuffer, timeoutMs, signal } = options;

    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let maxBufferExceeded = false;
    let settled = false;
    let terminated = false;
    let terminationReason: "timeout" | "abort" | "maxBuffer" | null = null;

    const child = spawn(command, args, {
      cwd,
      shell: true,
      // Solo hace falta agrupar en POSIX — ahí es donde `-pid` importa.
      // En Windows, `taskkill /T` no depende de esto en absoluto.
      detached: process.platform !== "win32",
    });

    const timer = setTimeout(() => terminate("timeout"), timeoutMs);

    function onAbort(): void {
      terminate("abort");
    }
    if (signal) {
      if (signal.aborted) terminate("abort");
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    /** Única operación de terminación — idempotente por el flag
     * `terminated`, y un no-op si el proceso YA terminó por su cuenta
     * (`settled`): matar un PID viejo que el SO ya reasignó a otro
     * proceso sería matar algo que no corresponde. */
    function terminate(reason: "timeout" | "abort" | "maxBuffer"): void {
      if (terminated || settled) return;
      terminated = true;
      terminationReason = reason;
      if (typeof child.pid === "number") killProcessTree(child.pid);
    }

    function cleanup(): void {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      child.removeAllListeners();
    }

    function appendChunk(target: "stdout" | "stderr", chunk: Buffer): void {
      if (settled || maxBufferExceeded) return;
      const text = chunk.toString("utf-8");
      outputBytes += Buffer.byteLength(text, "utf-8");
      if (target === "stdout") stdout += text;
      else stderr += text;
      if (outputBytes > maxBuffer) {
        maxBufferExceeded = true;
        terminate("maxBuffer");
      }
    }

    child.stdout?.on("data", (chunk: Buffer) => appendChunk("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => appendChunk("stderr", chunk));

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new ExecWithTreeKillError(error.message, { stdout, stderr, killed: terminated, signal: null, code: null }));
    });

    child.on("close", (code, closeSignal) => {
      if (settled) return;
      settled = true;
      cleanup();

      if (terminated) {
        const message =
          terminationReason === "timeout"
            ? `${command} superó el timeout de ${timeoutMs}ms — se terminó el proceso (y sus hijos).`
            : terminationReason === "maxBuffer"
              ? `${command} superó el límite de salida permitido (${maxBuffer} bytes) — se terminó el proceso (y sus hijos).`
              : `${command} fue cancelado (task abortada) — se terminó el proceso (y sus hijos).`;
        reject(new ExecWithTreeKillError(message, { stdout, stderr, killed: true, signal: closeSignal }));
        return;
      }

      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(
        new ExecWithTreeKillError(`Command failed: ${command} ${args.join(" ")}`, {
          stdout,
          stderr,
          killed: false,
          signal: closeSignal,
          code,
        }),
      );
    });
  });
}
