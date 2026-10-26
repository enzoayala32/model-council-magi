/**
 * Fase 9F — informe final determinista y metadata-only.
 *
 * Se construye exclusivamente desde el ledger (plan, steps, verificaciones)
 * y desde las proposals reales del workspace. La prosa del modelo NO es
 * fuente de verdad: el informe separa hechos verificados (verificaciones
 * passed/failed) de afirmaciones (items DONE con evidencia manual).
 *
 * Invariantes:
 * - Nunca incluye prompts, mensajes, contenido de archivos, stdout/stderr
 *   ni API keys. Solo rutas relativas, hashes, conteos, exit codes y
 *   estados.
 * - Las rutas sensibles o unsafe se omiten y se cuentan en `limitations`.
 * - Todo string pasa por `redactSecrets` y por el reemplazo del workspace
 *   absoluto por `<workspace>`.
 * - Es determinista: mismo estado del ledger + mismas proposals ⇒ mismo
 *   JSON (salvo el recorte por tamaño, que también es determinista).
 * - Si supera `maxBytes`, se recortan listas (nunca los hechos centrales:
 *   status, stopReason, plan, budget) y se marca `truncated: true`.
 */

import crypto from "node:crypto";
import { redactSecrets } from "../../provider-resilience/redact";
import { normalizePathForRules, sensitiveRuleOf } from "../context/sensitive-paths";
import { describeCriterion } from "./plan";
import type { AutonomyBudget, AutonomyState, AutonomyTaskOutcome } from "./contract";
import type { AgentStep, PersistedPlan, VerificationRecord } from "./ledger";

export const FINAL_REPORT_VERSION = 1;

export const FINAL_REPORT_TEXT_LIMITS = Object.freeze({
  objective: 500,
  text: 300,
  evidence: 500,
  path: 300,
});

export type FinalReportStatus =
  | "done"
  | "blocked"
  | "stalled"
  | "budget_exhausted"
  | "failed"
  | "cancelled";

export type FinalReportChange = {
  path: string;
  kind: "write" | "edit" | "delete";
  additions: number;
  deletions: number;
  sha256: string;
};

export type FinalReportCommand = {
  name: string;
  exitCode: number | null;
  durationMs: number | null;
  ok: boolean;
  outputSha256: string | null;
};

export type FinalReportTest = {
  name: string;
  ok: boolean;
  exitCode: number | null;
  durationMs: number | null;
};

export type FinalReportVerification = {
  itemId: string | null;
  criterion: string;
  status: "passed" | "failed" | "skipped" | "unverified";
  evidence: string;
};

export type FinalReportUnresolved = {
  itemId: string;
  reason: string;
};

export type FinalReportBudget = {
  steps: number;
  wallTimeMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostUsd: number | null;
};

export type FinalReport = {
  version: typeof FINAL_REPORT_VERSION;
  taskId: string;
  runId: string;
  status: FinalReportStatus;
  stopReason: string;
  objective: string;
  plan: {
    version: number;
    done: number;
    total: number;
    blocked: number;
    skipped: number;
  };
  changes: FinalReportChange[];
  commands: FinalReportCommand[];
  tests: FinalReportTest[];
  verification: FinalReportVerification[];
  limitations: string[];
  unresolved: FinalReportUnresolved[];
  budget: FinalReportBudget;
  nextSteps: string[];
  truncated?: boolean;
};

export type FinalReportProposal = {
  kind: "write" | "edit" | "delete";
  relPath: string;
  diff: string;
  nextContent: string;
};

export type BuildFinalReportInput = {
  taskId: string;
  runId: string;
  state: AutonomyState;
  outcome: AutonomyTaskOutcome;
  /** Stop reason real de la corrida. Puede diferir del `outcome.stopReason`
   * (ej. `BUDGET_EXHAUSTED` por timeout: el outcome de task usa
   * `budget_exhausted`, pero el informe debe explicar `timeout`). */
  stopReason?: string;
  budget: AutonomyBudget;
  plan: PersistedPlan | null;
  steps: AgentStep[];
  verifications: VerificationRecord[];
  proposals: FinalReportProposal[];
  warnings?: string[];
  resumeWarnings?: string[];
  workspaceRoot?: string;
  maxBytes: number;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Redacción + reemplazo del workspace absoluto + colapso de espacios. */
function cleanText(value: unknown, max: number, workspaceRoot?: string): string {
  if (typeof value !== "string") return "";
  let text = redactSecrets(value);
  if (workspaceRoot) {
    const variants = new Set([workspaceRoot, workspaceRoot.replace(/\\/g, "/"), workspaceRoot.replace(/\//g, "\\")]);
    for (const variant of variants) {
      if (variant) text = text.split(variant).join("<workspace>");
    }
  }
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

function sha256Text(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function countDiff(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

export function mapFinalStatus(state: AutonomyState): FinalReportStatus {
  switch (state) {
    case "DONE":
      return "done";
    case "BLOCKED":
      return "blocked";
    case "STALLED":
      return "stalled";
    case "BUDGET_EXHAUSTED":
      return "budget_exhausted";
    case "FAILED":
      return "failed";
    case "CANCELLED":
      return "cancelled";
    default:
      throw new Error(`Estado no terminal para el informe final: ${String(state)}.`);
  }
}

function commandName(toolName: string, meta: Record<string, unknown> | undefined, workspaceRoot?: string): string {
  if (toolName === "run_typecheck") return "typecheck";
  const raw = meta && typeof meta.name === "string" ? meta.name : "";
  return cleanText(raw, 40, workspaceRoot) || "script";
}

function commandExitCode(meta: Record<string, unknown> | undefined, ok: boolean): number | null {
  if (meta && typeof meta.exitCode === "number" && Number.isFinite(meta.exitCode)) return meta.exitCode;
  return ok ? 0 : null;
}

function commandDuration(meta: Record<string, unknown> | undefined): number | null {
  if (meta && typeof meta.durationMs === "number" && Number.isFinite(meta.durationMs)) {
    return Math.max(0, Math.round(meta.durationMs));
  }
  return null;
}

function commandOutputHash(meta: Record<string, unknown> | undefined): string | null {
  if (meta && typeof meta.outputSha256 === "string" && /^[a-f0-9]{64}$/i.test(meta.outputSha256)) {
    return meta.outputSha256.toLowerCase();
  }
  return null;
}

function verificationStatus(status: VerificationRecord["status"]): FinalReportVerification["status"] {
  return status;
}

function itemReason(item: PersistedPlan["items"][number], workspaceRoot?: string): string {
  const lastError = cleanText(item.lastError ?? "", FINAL_REPORT_TEXT_LIMITS.text, workspaceRoot);
  if (lastError) return lastError;
  switch (item.status) {
    case "BLOCKED":
      return "Bloqueado sin detalle.";
    case "FAILED":
      return "Falló sin detalle.";
    case "PENDING":
      return "No completado.";
    case "IN_PROGRESS":
      return "Quedó en progreso.";
    default:
      return `Estado ${item.status}.`;
  }
}

export function buildFinalReport(input: BuildFinalReportInput): FinalReport {
  const workspaceRoot = input.workspaceRoot;
  const status = mapFinalStatus(input.state);
  const items = input.plan?.items ?? [];

  let done = 0;
  let blocked = 0;
  let skipped = 0;
  for (const item of items) {
    if (item.status === "DONE") done += 1;
    else if (item.status === "BLOCKED") blocked += 1;
    else if (item.status === "SKIPPED") skipped += 1;
  }

  // --- changes: proposals reales, sin contenido ni rutas sensibles -------
  let sensitiveOmitted = 0;
  let unsafeOmitted = 0;
  const seenPaths = new Set<string>();
  const changes: FinalReportChange[] = [];
  for (const proposal of input.proposals) {
    const path = proposal.relPath.replace(/\\/g, "/");
    if (seenPaths.has(path)) continue;
    seenPaths.add(path);
    if (!normalizePathForRules(path).ok) {
      unsafeOmitted += 1;
      continue;
    }
    if (sensitiveRuleOf(path)) {
      sensitiveOmitted += 1;
      continue;
    }
    const counts = countDiff(proposal.diff);
    changes.push({
      path: cleanText(path, FINAL_REPORT_TEXT_LIMITS.path, workspaceRoot),
      kind: proposal.kind,
      additions: counts.additions,
      deletions: counts.deletions,
      sha256: sha256Text(proposal.nextContent),
    });
  }
  changes.sort((a, b) => a.path.localeCompare(b.path));

  // --- commands/tests: solo metadatos allowlisted del ledger -------------
  const metaByCallId = new Map<string, Record<string, unknown>>();
  for (const step of input.steps) {
    for (const result of step.results) {
      if (!isPlainObject(result)) continue;
      const callId = typeof result.toolCallId === "string" ? result.toolCallId : "";
      if (callId) metaByCallId.set(callId, result);
    }
  }

  const commands: FinalReportCommand[] = [];
  for (const step of input.steps) {
    for (const action of step.actions) {
      if (action.toolName !== "run_script" && action.toolName !== "run_typecheck") continue;
      const meta = metaByCallId.get(action.toolCallId);
      const success = meta && typeof meta.success === "boolean" ? meta.success : undefined;
      const ok = success ?? action.ok;
      commands.push({
        name: commandName(action.toolName, meta, workspaceRoot),
        exitCode: commandExitCode(meta, ok),
        durationMs: commandDuration(meta),
        ok,
        outputSha256: commandOutputHash(meta),
      });
    }
  }

  const tests: FinalReportTest[] = [];
  for (const verification of input.verifications) {
    if (verification.criterion.kind !== "script" || verification.criterion.name !== "test") continue;
    tests.push({
      name: "test",
      ok: verification.status === "passed",
      exitCode:
        typeof verification.evidence.exitCode === "number" && Number.isFinite(verification.evidence.exitCode)
          ? verification.evidence.exitCode
          : null,
      durationMs:
        typeof verification.evidence.durationMs === "number" && Number.isFinite(verification.evidence.durationMs)
          ? Math.max(0, Math.round(verification.evidence.durationMs))
          : null,
    });
  }

  // --- verification: hechos verificados vs. afirmaciones -----------------
  const verification: FinalReportVerification[] = input.verifications.map((record) => ({
    itemId: record.itemId,
    criterion: cleanText(describeCriterion(record.criterion), FINAL_REPORT_TEXT_LIMITS.text, workspaceRoot),
    status: verificationStatus(record.status),
    evidence: cleanText(
      JSON.stringify(record.evidence ?? {}),
      FINAL_REPORT_TEXT_LIMITS.evidence,
      workspaceRoot,
    ),
  }));

  const unresolved: FinalReportUnresolved[] = items
    .filter((item) => item.status !== "DONE" && item.status !== "SKIPPED")
    .map((item) => ({
      itemId: item.logicalId,
      reason: itemReason(item, workspaceRoot),
    }));

  // --- limitations --------------------------------------------------------
  const limitations: string[] = [];
  const manualGlobal = (input.plan?.acceptance ?? []).filter((criterion) => criterion.kind === "manual").length;
  if (manualGlobal > 0) {
    limitations.push(`${manualGlobal} criterio(s) manual(es) de acceptance global no se verifican por máquina.`);
  }
  const manualDone = items.filter(
    (item) => item.status === "DONE" && item.evidence.some((evidence) => evidence.kind === "manual"),
  ).length;
  if (manualDone > 0) {
    limitations.push(`${manualDone} item(s) se marcaron DONE con evidencia manual, no verificada por máquina.`);
  }
  const unverified = verification.filter((entry) => entry.status === "unverified").length;
  if (unverified > 0) {
    limitations.push(`${unverified} verificación(es) no pudieron ejecutarse.`);
  }
  const failedVerifications = verification.filter((entry) => entry.status === "failed").length;
  if (failedVerifications > 0) {
    limitations.push(`${failedVerifications} verificación(es) fallaron.`);
  }
  if (status === "budget_exhausted") limitations.push("La corrida se detuvo por presupuesto agotado.");
  if (status === "stalled") limitations.push("La corrida se detuvo por falta de progreso.");
  if (status === "cancelled") limitations.push("La corrida se canceló antes de completar el plan.");
  if (!input.plan) limitations.push("No hay un plan persistido para esta corrida.");
  if (sensitiveOmitted > 0) {
    limitations.push(`${sensitiveOmitted} ruta(s) sensible(s) se omitieron del informe.`);
  }
  if (unsafeOmitted > 0) {
    limitations.push(`${unsafeOmitted} ruta(s) no segura(s) se omitieron del informe.`);
  }
  if (input.budget.estimatedCostUsd === null) {
    limitations.push("El modelo no tiene pricing conocido; el costo no se estimó.");
  }
  const providerWithoutUsage =
    input.steps.length > 0 && input.budget.inputTokens === 0 && input.budget.outputTokens === 0;
  if (providerWithoutUsage) {
    limitations.push("El proveedor no informó usage de tokens; se registra 0 y el informe lo declara.");
  }
  if (status === "done" && changes.length === 0) {
    limitations.push("La corrida terminó sin cambios detectados en el workspace.");
  }
  for (const warning of [...(input.warnings ?? []), ...(input.resumeWarnings ?? [])]) {
    const text = cleanText(warning, FINAL_REPORT_TEXT_LIMITS.text, workspaceRoot);
    if (text && !limitations.includes(text)) limitations.push(text);
  }

  // --- next steps: sugerencias deterministas -----------------------------
  const nextSteps: string[] = [];
  if (status === "done") {
    nextSteps.push(changes.length > 0 ? "Revisar y aplicar los cambios." : "No hay cambios para aplicar.");
  }
  if (status === "cancelled") nextSteps.push("Reanudar la tarea o descartarla.");
  if (status === "stalled") nextSteps.push("Revisar la causa del estancamiento y replantear el plan.");
  if (status === "budget_exhausted") nextSteps.push("Aumentar el presupuesto o dividir la tarea.");
  if (status === "blocked") nextSteps.push("Resolver los items bloqueados.");
  if (status === "failed") nextSteps.push("Revisar el error y reintentar.");
  if (unresolved.length > 0) nextSteps.push("Completar o replantear los items no resueltos.");
  if (failedVerifications > 0) nextSteps.push("Corregir las verificaciones fallidas.");
  if (unverified > 0) nextSteps.push("Ejecutar las verificaciones que no pudieron correr.");
  const uniqueNextSteps = Array.from(new Set(nextSteps)).slice(0, 5);

  const report: FinalReport = {
    version: FINAL_REPORT_VERSION,
    taskId: input.taskId,
    runId: input.runId,
    status,
    stopReason: cleanText(input.stopReason ?? input.outcome.stopReason, 80, workspaceRoot) || "error",
    objective: cleanText(input.plan?.objective ?? "", FINAL_REPORT_TEXT_LIMITS.objective, workspaceRoot),
    plan: {
      version: input.plan?.version ?? 0,
      done,
      total: items.length,
      blocked,
      skipped,
    },
    changes,
    commands,
    tests,
    verification,
    limitations,
    unresolved,
    budget: {
      steps: input.budget.steps,
      wallTimeMs: input.budget.wallTimeMs,
      inputTokens: providerWithoutUsage ? null : input.budget.inputTokens,
      outputTokens: providerWithoutUsage ? null : input.budget.outputTokens,
      estimatedCostUsd: input.budget.estimatedCostUsd,
    },
    nextSteps: uniqueNextSteps,
  };

  // --- truncamiento determinista -----------------------------------------
  const byteLength = (): number => Buffer.byteLength(JSON.stringify(report), "utf8");
  const listKeys = [
    "nextSteps",
    "limitations",
    "tests",
    "commands",
    "verification",
    "unresolved",
    "changes",
  ] as const;
  let truncated = false;
  while (byteLength() > input.maxBytes) {
    let removed = false;
    for (const key of listKeys) {
      const list = report[key] as unknown[];
      if (list.length === 0) continue;
      list.pop();
      truncated = true;
      removed = true;
      break;
    }
    if (!removed) break;
  }
  if (truncated) {
    report.truncated = true;
    const notice = "El informe se truncó para respetar el tamaño máximo.";
    if (!report.limitations.includes(notice)) report.limitations.push(notice);
    // El aviso de truncamiento no se recorta: si hace falta más espacio se
    // siguen quitando elementos de las listas y, último recurso, se acorta
    // el objetivo.
    while (byteLength() > input.maxBytes) {
      let removed = false;
      for (const key of listKeys) {
        const list = report[key] as unknown[];
        const index = key === "limitations" ? list.findIndex((entry) => entry !== notice) : list.length - 1;
        if (index < 0) continue;
        list.splice(index, 1);
        removed = true;
        break;
      }
      if (removed) continue;
      if (report.objective.length > 0) {
        report.objective = report.objective.slice(0, Math.floor(report.objective.length / 2));
        continue;
      }
      break;
    }
  }

  return report;
}
