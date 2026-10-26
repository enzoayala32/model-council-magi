/**
 * Fase 9C — verificador real de acceptance del Autonomous Loop.
 *
 * Convierte un `AcceptanceCriterion` en un hecho verificable:
 * - `typecheck`: corre `npx tsc --noEmit` en el workspace.
 * - `script`: corre `npm run <name>` SOLO si el script está allowlisted
 *   (misma intersección build/test/lint que ya usa `run_script`).
 * - `file_exists` / `file_hash`: resuelven la ruta con `resolveSafePath`
 *   (symlinks y `..` incluidos) y comprueban el archivo real.
 * - `manual`: no es verificable por máquina; el ledger nunca lo manda acá.
 *
 * Seguridad:
 * - Nunca se ejecuta un comando arbitrario declarado por el modelo: el
 *   nombre del script se valida contra la allowlist antes de spawnear.
 * - La evidencia persistida es solo metadatos (exit code, duración,
 *   tamaño y SHA-256 de la salida). El stdout/stderr NUNCA sale de este
 *   módulo, ni siquiera en `detail`.
 * - Un timeout/cancelación/error de spawn se reporta como `unavailable`
 *   (no se asume éxito ni fracaso del código).
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import { resolveSafePath, UnsafePathError } from "../safe-path";
import { execWithTreeKill, ExecWithTreeKillError } from "../exec-with-tree-kill";
import { sensitiveRuleOf } from "../context/sensitive-paths";
import type { AcceptanceVerifier, AcceptanceVerificationResult } from "./ledger";
import type { AcceptanceCriterion, ScriptName } from "./plan";

export const VERIFIER_LIMITS = Object.freeze({
  timeoutMs: 120_000,
  maxBuffer: 16 * 1024 * 1024,
  maxFileBytes: 2_000_000,
  maxEvidenceChars: 2_000,
});

export type VerifierExecOptions = {
  cwd: string;
  maxBuffer: number;
  timeoutMs: number;
  signal?: AbortSignal;
};

export type VerifierExecResult = { stdout: string; stderr: string };

/** Inyectable solo para tests: el default es el mismo `execWithTreeKill`
 * que usan `run_typecheck`/`run_script` (mata el árbol de procesos). */
export type VerifierExec = (command: string, args: string[], options: VerifierExecOptions) => Promise<VerifierExecResult>;

export type AcceptanceVerifierOptions = {
  /** Nombres de scripts declarados por el workspace e intersectados con
   * build/test/lint. Un script fuera de esta lista no se ejecuta. */
  allowedScripts?: string[];
  exec?: VerifierExec;
  timeoutMs?: number;
};

function sha256Text(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function normalizeScripts(scripts: string[] | undefined): Set<ScriptName> {
  const allowed = new Set<ScriptName>();
  for (const name of scripts ?? []) {
    if (name === "build" || name === "test" || name === "lint") allowed.add(name);
  }
  return allowed;
}

function exitCodeOf(error: unknown): number {
  if (error instanceof ExecWithTreeKillError) {
    if (typeof error.code === "number") return error.code;
    if (error.killed || error.signal) return -1;
    return 1;
  }
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "number") return code;
  }
  return 1;
}

function isTimeoutOrAbort(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (error instanceof ExecWithTreeKillError) {
    return error.killed === true || error.signal !== null;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|timed out|abort|cancel/i.test(message);
}

async function verifyFile(
  criterion: Extract<AcceptanceCriterion, { kind: "file_exists" | "file_hash" }>,
  workspaceRoot: string,
): Promise<AcceptanceVerificationResult> {
  const sensitive = sensitiveRuleOf(criterion.path);
  if (sensitive) {
    // `unsafe:*` (traversal, absoluta, NUL, URL) no es una ruta sensible:
    // es una ruta inválida. Se distinguen para que el diagnóstico y los
    // tests no confundan "no permitida por secreta" con "se sale del
    // workspace".
    const reason = sensitive.startsWith("unsafe:") ? "unsafe_path" : "sensitive_path";
    return { status: "failed", evidence: { reason }, detail: `Ruta no permitida (${sensitive}).` };
  }

  let absPath: string;
  try {
    absPath = await resolveSafePath(workspaceRoot, criterion.path);
  } catch (error) {
    const detail = error instanceof UnsafePathError ? error.message : "Ruta inválida.";
    return { status: "failed", evidence: { reason: "unsafe_path" }, detail };
  }

  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(absPath);
  } catch {
    return { status: "failed", evidence: { reason: "not_found" }, detail: "El archivo no existe." };
  }
  if (!stat.isFile()) {
    return { status: "failed", evidence: { reason: "not_a_file" }, detail: "La ruta no es un archivo." };
  }

  if (criterion.kind === "file_exists") {
    return { status: "passed", evidence: { size: stat.size } };
  }

  if (stat.size > VERIFIER_LIMITS.maxFileBytes) {
    return {
      status: "unavailable",
      evidence: { reason: "file_too_large", size: stat.size },
      detail: `El archivo supera el máximo verificable de ${VERIFIER_LIMITS.maxFileBytes} bytes.`,
    };
  }

  let buffer: Buffer;
  try {
    buffer = await fs.readFile(absPath);
  } catch {
    return { status: "unavailable", evidence: { reason: "read_failed" }, detail: "No se pudo leer el archivo." };
  }
  const actual = crypto.createHash("sha256").update(buffer).digest("hex");
  if (actual !== criterion.sha256) {
    return {
      status: "failed",
      evidence: { reason: "hash_mismatch", sha256: actual, size: buffer.length },
      detail: "El hash actual no coincide con el esperado.",
    };
  }
  return { status: "passed", evidence: { sha256: actual, size: buffer.length } };
}

async function verifyCommand(
  command: string,
  args: string[],
  label: string,
  workspaceRoot: string,
  exec: VerifierExec,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<AcceptanceVerificationResult> {
  const started = Date.now();
  try {
    const { stdout, stderr } = await exec(command, args, {
      cwd: workspaceRoot,
      maxBuffer: VERIFIER_LIMITS.maxBuffer,
      timeoutMs,
      signal,
    });
    const output = `${stdout}\n${stderr}`;
    return {
      status: "passed",
      evidence: {
        exitCode: 0,
        durationMs: Date.now() - started,
        outputSha256: sha256Text(output),
        outputBytes: Buffer.byteLength(output, "utf8"),
      },
    };
  } catch (error) {
    if (isTimeoutOrAbort(error, signal)) {
      return {
        status: "unavailable",
        evidence: { reason: "timeout_or_abort", durationMs: Date.now() - started },
        detail: `${label} no terminó dentro del límite.`,
      };
    }
    const exitCode = exitCodeOf(error);
    const stdout = error instanceof ExecWithTreeKillError ? error.stdout : "";
    const stderr = error instanceof ExecWithTreeKillError ? error.stderr : "";
    const output = `${stdout}\n${stderr}`;
    return {
      status: "failed",
      evidence: {
        exitCode,
        durationMs: Date.now() - started,
        outputSha256: sha256Text(output),
        outputBytes: Buffer.byteLength(output, "utf8"),
      },
      detail: `${label} terminó con exit code ${exitCode}.`,
    };
  }
}

/**
 * Crea el verificador que el ledger inyecta en `update_plan_item` y que
 * el dispatcher usa para la acceptance global. No lanza: todo error se
 * traduce a `unavailable`/`failed`.
 */
export function createAcceptanceVerifier(options: AcceptanceVerifierOptions = {}): AcceptanceVerifier {
  const allowedScripts = normalizeScripts(options.allowedScripts);
  const exec = options.exec ?? execWithTreeKill;
  const timeoutMs = options.timeoutMs ?? VERIFIER_LIMITS.timeoutMs;

  return async ({ criterion, workspaceRoot, signal }) => {
    switch (criterion.kind) {
      case "manual":
        return { status: "unavailable", evidence: { reason: "manual" }, detail: "Un criterio manual no se verifica por máquina." };
      case "file_exists":
      case "file_hash":
        return verifyFile(criterion, workspaceRoot);
      case "script": {
        if (!allowedScripts.has(criterion.name)) {
          return {
            status: "unavailable",
            evidence: { reason: "script_not_allowed", name: criterion.name },
            detail: `El script ${criterion.name} no está allowlisted en este workspace.`,
          };
        }
        return verifyCommand("npm", ["run", criterion.name], `script:${criterion.name}`, workspaceRoot, exec, timeoutMs, signal);
      }
      case "typecheck":
        return verifyCommand("npx", ["tsc", "--noEmit"], "typecheck", workspaceRoot, exec, timeoutMs, signal);
    }
  };
}

/** Descripción corta para eventos/informes, sin contenido de salida. */
export function describeVerificationResult(result: AcceptanceVerificationResult): string {
  if (result.status === "passed") return "passed";
  if (result.status === "failed") return "failed";
  return "unavailable";
}
