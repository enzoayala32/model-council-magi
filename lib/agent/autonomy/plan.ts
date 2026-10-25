/**
 * Fase 9B — contrato del plan y del task ledger.
 *
 * Este módulo es PURO: no toca DB, filesystem, red ni modelo. Normaliza y
 * valida el plan que propone el modelo (o el fallback determinista), y
 * define las reglas de evidencia y de transición de items.
 *
 * Principios:
 * - Un plan inválido NUNCA se persiste: el resultado es `{ok:false, errors}`
 *   y el controlador decide reintentar o usar el fallback.
 * - La normalización es determinista: mismo input semántico ⇒ mismo hash,
 *   sin importar el orden de constraints/acceptance/dependsOn/paths.
 * - Las rutas pasan por las mismas reglas que el Context Engine
 *   (`sensitive-paths.ts`): relativas, sin `..`, sin absolutas/UNC/URL y
 *   sin archivos sensibles.
 * - El plan debe declarar al menos un criterio de aceptación. Si todos son
 *   `manual`, se acepta pero se marca `manual_only` (el informe final lo
 *   declarará no verificado).
 */

import crypto from "node:crypto";
import { normalizePathForRules, sensitiveRuleOf } from "../context/sensitive-paths";
import {
  DEFAULT_AUTONOMY_LIMITS,
  normalizeAutonomyLimits,
  type AutonomyErrorCode,
  type AutonomyLimits,
} from "./contract";

export const PLAN_STATUSES = Object.freeze(["ACTIVE", "COMPLETED", "ABANDONED"] as const);
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const PLAN_ITEM_STATUSES = Object.freeze([
  "PENDING",
  "IN_PROGRESS",
  "BLOCKED",
  "DONE",
  "FAILED",
  "SKIPPED",
] as const);
export type PlanItemStatus = (typeof PLAN_ITEM_STATUSES)[number];

export const PLAN_SOURCES = Object.freeze(["model", "fallback", "resume"] as const);
export type PlanSource = (typeof PLAN_SOURCES)[number];

export const SCRIPT_NAMES = Object.freeze(["build", "test", "lint"] as const);
export type ScriptName = (typeof SCRIPT_NAMES)[number];

/** Nombres permitidos en evidencia `command`. `typecheck` no es un script de
 * package.json, pero sí una verificación real del controlador. */
export const COMMAND_NAMES = Object.freeze(["typecheck", ...SCRIPT_NAMES] as const);
export type CommandName = (typeof COMMAND_NAMES)[number];

/** Límites propios del formato del plan que no dependen de la corrida. */
export const PLAN_FORMAT_LIMITS = Object.freeze({
  maxObjectiveChars: 2_000,
  maxConstraintChars: 500,
  maxManualDescriptionChars: 500,
  maxReasonChars: 1_000,
  maxPathsPerItem: 20,
  maxPathChars: 500,
  maxToolCallIdChars: 200,
});

export type AcceptanceCriterion =
  | { kind: "typecheck" }
  | { kind: "script"; name: ScriptName }
  | { kind: "file_exists"; path: string }
  | { kind: "file_hash"; path: string; sha256: string }
  | { kind: "manual"; description: string };

export type PlanEvidence =
  | { kind: "tool_result"; toolCallId: string }
  | { kind: "file"; path: string; sha256: string }
  | { kind: "command"; name: CommandName; exitCode: number }
  | { kind: "manual"; description: string };

export type PlanItemInput = {
  id: string;
  title: string;
  description?: string;
  dependsOn?: string[];
  acceptance?: AcceptanceCriterion[];
  paths?: string[];
};

export type PlanInput = {
  objective: string;
  constraints?: string[];
  acceptance?: AcceptanceCriterion[];
  items: PlanItemInput[];
};

export type NormalizedPlanItem = {
  /** Id lógico estable dentro del plan (`t1`, `t2`, ...). */
  logicalId: string;
  seq: number;
  parentId: string | null;
  title: string;
  description: string;
  dependsOn: string[];
  acceptance: AcceptanceCriterion[];
  paths: string[];
};

export type NormalizedPlan = {
  objective: string;
  constraints: string[];
  acceptance: AcceptanceCriterion[];
  items: NormalizedPlanItem[];
  /** SHA-256 canónico de objective + constraints + items. */
  hash: string;
};

export type PlanValidationError = {
  code: AutonomyErrorCode;
  message: string;
  itemId?: string;
};

export type PlanValidationResult =
  | { ok: true; plan: NormalizedPlan; warnings: string[] }
  | { ok: false; errors: PlanValidationError[] };

export type EvidenceValidationResult =
  | { ok: true; evidence: PlanEvidence[]; warnings: string[] }
  | { ok: false; errors: PlanValidationError[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeText(value: string): string {
  return value.replace(/\r\n?/g, "\n").trim();
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function criterionKey(criterion: AcceptanceCriterion): string {
  return JSON.stringify(criterion);
}

function canonicalCriterion(criterion: AcceptanceCriterion): unknown {
  switch (criterion.kind) {
    case "typecheck":
      return { kind: "typecheck" };
    case "script":
      return { kind: "script", name: criterion.name };
    case "file_exists":
      return { kind: "file_exists", path: criterion.path };
    case "file_hash":
      return { kind: "file_hash", path: criterion.path, sha256: criterion.sha256 };
    case "manual":
      return { kind: "manual", description: criterion.description };
  }
}

function sortCriteria(criteria: AcceptanceCriterion[]): unknown[] {
  return criteria
    .map(canonicalCriterion)
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

/** Normaliza una ruta de plan/evidencia. No devuelve la ruta en el mensaje
 * de error para no repetir paths sensibles en logs/eventos. */
function normalizePlanPath(
  raw: unknown,
  errors: PlanValidationError[],
  itemId?: string,
  errorCode: AutonomyErrorCode = "plan_invalid",
): string | null {
  if (typeof raw !== "string") {
    errors.push({ code: errorCode, message: "La ruta debe ser un string.", itemId });
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    errors.push({ code: errorCode, message: "La ruta no puede estar vacía.", itemId });
    return null;
  }
  if (trimmed.length > PLAN_FORMAT_LIMITS.maxPathChars) {
    errors.push({ code: errorCode, message: "La ruta supera el máximo de caracteres.", itemId });
    return null;
  }
  const normalized = normalizePathForRules(trimmed);
  if (!normalized.ok) {
    errors.push({ code: errorCode, message: `Ruta inválida (${normalized.rule}).`, itemId });
    return null;
  }
  if (normalized.segments.includes(".git")) {
    errors.push({ code: errorCode, message: "Ruta de metadatos no permitida (.git).", itemId });
    return null;
  }
  const relPath = normalized.segments.join("/");
  const sensitive = sensitiveRuleOf(relPath);
  if (sensitive) {
    errors.push({ code: errorCode, message: `Ruta sensible no permitida (${sensitive}).`, itemId });
    return null;
  }
  return relPath;
}

function normalizeAcceptanceList(
  raw: unknown,
  limits: AutonomyLimits,
  errors: PlanValidationError[],
  itemId?: string,
): AcceptanceCriterion[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    errors.push({ code: "plan_invalid", message: "acceptance debe ser un array.", itemId });
    return [];
  }
  if (raw.length > limits.maxAcceptancePerItem) {
    errors.push({
      code: "plan_too_large",
      message: `acceptance supera el máximo de ${limits.maxAcceptancePerItem} criterios.`,
      itemId,
    });
    return [];
  }

  const result: AcceptanceCriterion[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!isPlainObject(entry)) {
      errors.push({ code: "plan_invalid", message: "Cada criterio de aceptación debe ser un objeto.", itemId });
      continue;
    }
    const kind = entry.kind;
    let criterion: AcceptanceCriterion | null = null;

    if (kind === "typecheck") {
      criterion = { kind: "typecheck" };
    } else if (kind === "script") {
      const name = typeof entry.name === "string" ? entry.name.trim().toLowerCase() : "";
      if (!(SCRIPT_NAMES as readonly string[]).includes(name)) {
        errors.push({
          code: "plan_invalid",
          message: `Script no permitido: solo ${SCRIPT_NAMES.join(", ")}.`,
          itemId,
        });
        continue;
      }
      criterion = { kind: "script", name: name as ScriptName };
    } else if (kind === "file_exists" || kind === "file_hash") {
      const filePath = normalizePlanPath(entry.path, errors, itemId);
      if (!filePath) continue;
      if (kind === "file_exists") {
        criterion = { kind: "file_exists", path: filePath };
      } else {
        const sha256 = typeof entry.sha256 === "string" ? entry.sha256.trim().toLowerCase() : "";
        if (!/^[a-f0-9]{64}$/.test(sha256)) {
          errors.push({ code: "plan_invalid", message: "sha256 debe ser un hash hexadecimal de 64 caracteres.", itemId });
          continue;
        }
        criterion = { kind: "file_hash", path: filePath, sha256 };
      }
    } else if (kind === "manual") {
      const description = typeof entry.description === "string" ? normalizeText(entry.description) : "";
      if (!description) {
        errors.push({ code: "plan_invalid", message: "La justificación manual no puede estar vacía.", itemId });
        continue;
      }
      if (description.length > PLAN_FORMAT_LIMITS.maxManualDescriptionChars) {
        errors.push({ code: "plan_too_large", message: "La justificación manual supera el máximo de caracteres.", itemId });
        continue;
      }
      criterion = { kind: "manual", description };
    } else {
      errors.push({ code: "plan_invalid", message: "Tipo de criterio de aceptación desconocido.", itemId });
      continue;
    }

    const key = criterionKey(criterion);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(criterion);
    }
  }
  return result;
}

function normalizePathList(raw: unknown, errors: PlanValidationError[], itemId: string): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    errors.push({ code: "plan_invalid", message: "paths debe ser un array.", itemId });
    return [];
  }
  if (raw.length > PLAN_FORMAT_LIMITS.maxPathsPerItem) {
    errors.push({
      code: "plan_too_large",
      message: `paths supera el máximo de ${PLAN_FORMAT_LIMITS.maxPathsPerItem} rutas.`,
      itemId,
    });
    return [];
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const filePath = normalizePlanPath(entry, errors, itemId);
    if (!filePath) continue;
    if (!seen.has(filePath)) {
      seen.add(filePath);
      result.push(filePath);
    }
  }
  return result;
}

function normalizeConstraints(raw: unknown, limits: AutonomyLimits, errors: PlanValidationError[]): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    errors.push({ code: "plan_invalid", message: "constraints debe ser un array." });
    return [];
  }
  if (raw.length > limits.maxConstraints) {
    errors.push({
      code: "plan_too_large",
      message: `constraints supera el máximo de ${limits.maxConstraints}.`,
    });
    return [];
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "string") {
      errors.push({ code: "plan_invalid", message: "Cada restricción debe ser un string." });
      continue;
    }
    const value = normalizeText(entry);
    if (!value) {
      errors.push({ code: "plan_invalid", message: "Una restricción no puede estar vacía." });
      continue;
    }
    if (value.length > PLAN_FORMAT_LIMITS.maxConstraintChars) {
      errors.push({ code: "plan_too_large", message: "Una restricción supera el máximo de caracteres." });
      continue;
    }
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result.sort((a, b) => a.localeCompare(b));
}

/** Devuelve un ciclo como lista de ids, o `null`. Ignora dependencias a ids
 * inexistentes (esas se reportan aparte como `plan_item_unknown`). */
function findDependencyCycle(items: NormalizedPlanItem[]): string[] | null {
  const byId = new Map(items.map((item) => [item.logicalId, item]));
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    const current = state.get(id);
    if (current === "done") return null;
    if (current === "visiting") {
      const start = stack.indexOf(id);
      return [...stack.slice(start), id];
    }
    const item = byId.get(id);
    if (!item) return null;
    state.set(id, "visiting");
    stack.push(id);
    for (const dependency of item.dependsOn) {
      if (!byId.has(dependency)) continue;
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(id, "done");
    return null;
  };

  for (const item of items) {
    const cycle = visit(item.logicalId);
    if (cycle) return cycle;
  }
  return null;
}

/** Profundidad máxima del DAG de dependencias: un item sin dependencias
 * tiene profundidad 1; un item que depende de otro tiene 2; etc. */
function computeDependencyDepth(items: NormalizedPlanItem[]): number {
  const byId = new Map(items.map((item) => [item.logicalId, item]));
  const memo = new Map<string, number>();

  const depthOf = (id: string): number => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    const item = byId.get(id);
    if (!item) return 0;
    let depth = 1;
    for (const dependency of item.dependsOn) {
      if (!byId.has(dependency)) continue;
      depth = Math.max(depth, 1 + depthOf(dependency));
    }
    memo.set(id, depth);
    return depth;
  };

  let max = 0;
  for (const item of items) max = Math.max(max, depthOf(item.logicalId));
  return max;
}

/** Hash canónico: el orden de constraints, acceptance, dependsOn y paths no
 * cambia el resultado; el orden de los items SÍ importa (es el orden de
 * ejecución). */
export function computePlanHash(plan: Pick<NormalizedPlan, "objective" | "constraints" | "acceptance" | "items">): string {
  const canonical = {
    objective: plan.objective,
    constraints: [...plan.constraints].sort((a, b) => a.localeCompare(b)),
    acceptance: sortCriteria(plan.acceptance),
    items: plan.items.map((item) => ({
      id: item.logicalId,
      title: item.title,
      description: item.description,
      dependsOn: [...item.dependsOn].sort((a, b) => a.localeCompare(b)),
      acceptance: sortCriteria(item.acceptance),
      paths: [...item.paths].sort((a, b) => a.localeCompare(b)),
    })),
  };
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/**
 * Normaliza y valida un plan. No lanza por input inválido: devuelve
 * `{ok:false, errors}`. Los errores usan códigos estables del contrato y no
 * incluyen contenido de archivos ni prompts.
 */
export function normalizePlan(
  input: unknown,
  limits: AutonomyLimits = DEFAULT_AUTONOMY_LIMITS,
): PlanValidationResult {
  const effectiveLimits = normalizeAutonomyLimits(limits);
  const errors: PlanValidationError[] = [];
  const warnings: string[] = [];

  if (!isPlainObject(input)) {
    return { ok: false, errors: [{ code: "plan_invalid", message: "El plan debe ser un objeto." }] };
  }

  const objective = typeof input.objective === "string" ? normalizeText(input.objective) : "";
  if (!objective) {
    errors.push({ code: "plan_invalid", message: "El objetivo no puede estar vacío." });
  } else if (objective.length > PLAN_FORMAT_LIMITS.maxObjectiveChars) {
    errors.push({
      code: "plan_too_large",
      message: `El objetivo supera el máximo de ${PLAN_FORMAT_LIMITS.maxObjectiveChars} caracteres.`,
    });
  }

  const constraints = normalizeConstraints(input.constraints, effectiveLimits, errors);
  const globalAcceptance = normalizeAcceptanceList(input.acceptance, effectiveLimits, errors);

  const rawItems = input.items;
  const items: NormalizedPlanItem[] = [];
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    errors.push({ code: "plan_invalid", message: "El plan debe tener al menos un item." });
  } else {
    if (rawItems.length > effectiveLimits.maxPlanItems) {
      errors.push({
        code: "plan_too_large",
        message: `El plan supera el máximo de ${effectiveLimits.maxPlanItems} items.`,
      });
      // No se recorren planes arbitrariamente grandes: el límite es duro y
      // ya hay un error que impide persistirlos.
      return { ok: false, errors };
    }

    const seenIds = new Set<string>();
    for (let index = 0; index < rawItems.length; index += 1) {
      const raw = rawItems[index];
      if (!isPlainObject(raw)) {
        errors.push({ code: "plan_invalid", message: `El item ${index + 1} debe ser un objeto.` });
        continue;
      }

      const id = typeof raw.id === "string" ? raw.id.trim() : "";
      if (!/^[a-zA-Z0-9_-]{1,32}$/.test(id)) {
        errors.push({
          code: "plan_invalid",
          message: `El item ${index + 1} tiene un id inválido (debe cumplir ^[a-zA-Z0-9_-]{1,32}$).`,
        });
        continue;
      }
      if (seenIds.has(id)) {
        errors.push({ code: "plan_invalid", message: `Id de item duplicado: ${id}.` });
        continue;
      }
      seenIds.add(id);

      const title = typeof raw.title === "string" ? normalizeText(raw.title) : "";
      if (!title) {
        errors.push({ code: "plan_invalid", message: `El item ${id} no tiene título.`, itemId: id });
      } else if (title.length > effectiveLimits.maxPlanItemTitleChars) {
        errors.push({
          code: "plan_too_large",
          message: `El título del item ${id} supera el máximo de ${effectiveLimits.maxPlanItemTitleChars} caracteres.`,
          itemId: id,
        });
      }

      const description = typeof raw.description === "string" ? normalizeText(raw.description) : "";
      if (description.length > effectiveLimits.maxPlanItemDescriptionChars) {
        errors.push({
          code: "plan_too_large",
          message: `La descripción del item ${id} supera el máximo de ${effectiveLimits.maxPlanItemDescriptionChars} caracteres.`,
          itemId: id,
        });
      }

      const dependsOn: string[] = [];
      if (raw.dependsOn !== undefined) {
        if (!Array.isArray(raw.dependsOn)) {
          errors.push({ code: "plan_invalid", message: `dependsOn del item ${id} debe ser un array.`, itemId: id });
        } else {
          for (const dependency of raw.dependsOn) {
            if (typeof dependency !== "string" || !/^[a-zA-Z0-9_-]{1,32}$/.test(dependency)) {
              errors.push({ code: "plan_invalid", message: `El item ${id} tiene una dependencia con id inválido.`, itemId: id });
              continue;
            }
            if (dependency === id) {
              errors.push({ code: "plan_cycle", message: `El item ${id} no puede depender de sí mismo.`, itemId: id });
              continue;
            }
            dependsOn.push(dependency);
          }
        }
      }

      const acceptance = normalizeAcceptanceList(raw.acceptance, effectiveLimits, errors, id);
      const paths = normalizePathList(raw.paths, errors, id);

      items.push({
        logicalId: id,
        seq: index + 1,
        parentId: null,
        title,
        description,
        dependsOn: [...new Set(dependsOn)].sort((a, b) => a.localeCompare(b)),
        acceptance,
        paths,
      });
    }
  }

  const knownIds = new Set(items.map((item) => item.logicalId));
  for (const item of items) {
    for (const dependency of item.dependsOn) {
      if (!knownIds.has(dependency)) {
        errors.push({
          code: "plan_item_unknown",
          message: `El item ${item.logicalId} depende de ${dependency}, que no existe en el plan.`,
          itemId: item.logicalId,
        });
      }
    }
  }

  const cycle = findDependencyCycle(items);
  if (cycle) {
    errors.push({ code: "plan_cycle", message: `Ciclo de dependencias: ${cycle.join(" → ")}.` });
  } else if (items.length > 0) {
    const depth = computeDependencyDepth(items);
    if (depth > effectiveLimits.maxPlanDepth) {
      errors.push({
        code: "plan_too_large",
        message: `Profundidad de dependencias ${depth} > máximo ${effectiveLimits.maxPlanDepth}.`,
      });
    }
  }

  const allCriteria = [...globalAcceptance, ...items.flatMap((item) => item.acceptance)];
  if (allCriteria.length === 0) {
    errors.push({
      code: "plan_invalid",
      message: "El plan debe declarar al menos un criterio de aceptación (verificable o manual).",
    });
  } else if (allCriteria.every((criterion) => criterion.kind === "manual")) {
    warnings.push("manual_only");
  }

  const itemsWithoutAcceptance = items.filter((item) => item.acceptance.length === 0).length;
  if (itemsWithoutAcceptance > 0) {
    warnings.push("items_without_acceptance");
  }

  if (errors.length > 0) return { ok: false, errors };

  const plan: NormalizedPlan = {
    objective,
    constraints,
    acceptance: globalAcceptance,
    items,
    hash: "",
  };
  plan.hash = computePlanHash(plan);
  return { ok: true, plan, warnings };
}

/** Plan de respaldo determinista: un item con una justificación manual
 * explícita. Se usa cuando el modelo no produjo un plan válido tras los
 * reintentos permitidos. */
export function buildFallbackPlan(
  objective: string,
  limits: AutonomyLimits = DEFAULT_AUTONOMY_LIMITS,
  reason?: string,
): NormalizedPlan {
  const effectiveLimits = normalizeAutonomyLimits(limits);
  const cleanObjective = truncate(
    normalizeText(objective) || "Cumplir el objetivo de la task",
    PLAN_FORMAT_LIMITS.maxObjectiveChars,
  );
  const title = truncate(cleanObjective, effectiveLimits.maxPlanItemTitleChars) || "Ejecutar la task";
  const description = truncate(cleanObjective, effectiveLimits.maxPlanItemDescriptionChars);
  const manualDescription = truncate(
    normalizeText(
      reason ?? "Plan de respaldo: el modelo no produjo un plan válido; revisar el resultado manualmente.",
    ) || "Plan de respaldo: revisar el resultado manualmente.",
    PLAN_FORMAT_LIMITS.maxManualDescriptionChars,
  );

  const result = normalizePlan(
    {
      objective: cleanObjective,
      acceptance: [{ kind: "manual", description: manualDescription }],
      items: [
        {
          id: "t1",
          title,
          description,
          acceptance: [{ kind: "manual", description: manualDescription }],
          paths: [],
        },
      ],
    },
    effectiveLimits,
  );

  if (!result.ok) {
    throw new Error(`Plan de respaldo inválido: ${result.errors.map((error) => error.message).join("; ")}`);
  }
  return result.plan;
}

/** Normaliza evidencia. La validación contra la DB/filesystem (toolCallId
 * real, hash actual, verificación registrada) vive en `ledger.ts`; acá solo
 * se valida la forma y se aplican los mismos límites de rutas. */
export function normalizePlanEvidence(
  raw: unknown,
  limits: AutonomyLimits = DEFAULT_AUTONOMY_LIMITS,
): EvidenceValidationResult {
  const effectiveLimits = normalizeAutonomyLimits(limits);
  if (raw === undefined) return { ok: true, evidence: [], warnings: [] };
  if (!Array.isArray(raw)) {
    return { ok: false, errors: [{ code: "evidence_invalid", message: "evidence debe ser un array." }] };
  }
  if (raw.length > effectiveLimits.maxEvidencePerItem) {
    return {
      ok: false,
      errors: [
        {
          code: "evidence_invalid",
          message: `evidence supera el máximo de ${effectiveLimits.maxEvidencePerItem} entradas.`,
        },
      ],
    };
  }

  const errors: PlanValidationError[] = [];
  const evidence: PlanEvidence[] = [];
  const seen = new Set<string>();

  for (const entry of raw) {
    if (!isPlainObject(entry)) {
      errors.push({ code: "evidence_invalid", message: "Cada evidencia debe ser un objeto." });
      continue;
    }
    const kind = entry.kind;
    let normalized: PlanEvidence | null = null;

    if (kind === "tool_result") {
      const toolCallId = typeof entry.toolCallId === "string" ? entry.toolCallId.trim() : "";
      if (!toolCallId) {
        errors.push({ code: "evidence_invalid", message: "toolCallId no puede estar vacío." });
        continue;
      }
      if (toolCallId.length > PLAN_FORMAT_LIMITS.maxToolCallIdChars) {
        errors.push({ code: "evidence_invalid", message: "toolCallId supera el máximo de caracteres." });
        continue;
      }
      normalized = { kind: "tool_result", toolCallId };
    } else if (kind === "file") {
      const filePath = normalizePlanPath(entry.path, errors, undefined, "evidence_invalid");
      if (!filePath) continue;
      const sha256 = typeof entry.sha256 === "string" ? entry.sha256.trim().toLowerCase() : "";
      if (!/^[a-f0-9]{64}$/.test(sha256)) {
        errors.push({ code: "evidence_invalid", message: "sha256 de la evidencia no es un hash hexadecimal de 64 caracteres." });
        continue;
      }
      normalized = { kind: "file", path: filePath, sha256 };
    } else if (kind === "command") {
      const name = typeof entry.name === "string" ? entry.name.trim().toLowerCase() : "";
      if (!(COMMAND_NAMES as readonly string[]).includes(name)) {
        errors.push({
          code: "evidence_invalid",
          message: `Comando no permitido: solo ${COMMAND_NAMES.join(", ")}.`,
        });
        continue;
      }
      const exitCode = entry.exitCode;
      if (typeof exitCode !== "number" || !Number.isInteger(exitCode) || exitCode < -1 || exitCode > 255) {
        errors.push({ code: "evidence_invalid", message: "exitCode debe ser un entero entre -1 y 255." });
        continue;
      }
      normalized = { kind: "command", name: name as CommandName, exitCode };
    } else if (kind === "manual") {
      const description = typeof entry.description === "string" ? normalizeText(entry.description) : "";
      if (!description) {
        errors.push({ code: "evidence_invalid", message: "La evidencia manual no puede estar vacía." });
        continue;
      }
      if (description.length > PLAN_FORMAT_LIMITS.maxManualDescriptionChars) {
        errors.push({ code: "evidence_invalid", message: "La evidencia manual supera el máximo de caracteres." });
        continue;
      }
      normalized = { kind: "manual", description };
    } else {
      errors.push({ code: "evidence_invalid", message: "Tipo de evidencia desconocido." });
      continue;
    }

    const key = JSON.stringify(normalized);
    if (!seen.has(key)) {
      seen.add(key);
      evidence.push(normalized);
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  const warnings = evidence.length > 0 && evidence.every((item) => item.kind === "manual")
    ? ["manual_evidence_unverified"]
    : [];
  return { ok: true, evidence, warnings };
}

export function normalizePlanReason(
  raw: unknown,
  required: boolean,
): { ok: true; reason: string | null } | { ok: false; error: PlanValidationError } {
  if (raw === undefined || raw === null) {
    return required
      ? { ok: false, error: { code: "plan_invalid", message: "Esta transición requiere un motivo (reason)." } }
      : { ok: true, reason: null };
  }
  if (typeof raw !== "string") {
    return { ok: false, error: { code: "plan_invalid", message: "reason debe ser un string." } };
  }
  const reason = normalizeText(raw);
  if (!reason) {
    return required
      ? { ok: false, error: { code: "plan_invalid", message: "El motivo no puede estar vacío." } }
      : { ok: true, reason: null };
  }
  if (reason.length > PLAN_FORMAT_LIMITS.maxReasonChars) {
    return { ok: false, error: { code: "plan_too_large", message: "El motivo supera el máximo de caracteres." } };
  }
  return { ok: true, reason };
}

export function isMachineCheckable(criterion: AcceptanceCriterion): boolean {
  return criterion.kind !== "manual";
}

export function isManualCriterion(criterion: AcceptanceCriterion): boolean {
  return criterion.kind === "manual";
}

/** Descripción estable y sin contenido de archivo, para informes/eventos. */
export function describeCriterion(criterion: AcceptanceCriterion): string {
  switch (criterion.kind) {
    case "typecheck":
      return "typecheck";
    case "script":
      return `script:${criterion.name}`;
    case "file_exists":
      return `file_exists:${criterion.path}`;
    case "file_hash":
      return `file_hash:${criterion.path}`;
    case "manual":
      return "manual";
  }
}

/** Transiciones permitidas de un item. `DONE → PENDING` existe solo para
 * invalidar evidencia stale en una replanificación; no es un camino normal
 * del modelo (la tool no acepta PENDING como destino). */
export const PLAN_ITEM_STATUS_TRANSITIONS: Readonly<Record<PlanItemStatus, readonly PlanItemStatus[]>> = Object.freeze({
  PENDING: Object.freeze(["IN_PROGRESS", "BLOCKED", "FAILED", "SKIPPED"] as const),
  IN_PROGRESS: Object.freeze(["DONE", "BLOCKED", "FAILED", "SKIPPED", "PENDING"] as const),
  BLOCKED: Object.freeze(["PENDING", "IN_PROGRESS", "FAILED", "SKIPPED"] as const),
  FAILED: Object.freeze(["PENDING", "IN_PROGRESS", "BLOCKED", "SKIPPED"] as const),
  DONE: Object.freeze(["PENDING"] as const),
  SKIPPED: Object.freeze(["PENDING"] as const),
});

export function canTransitionPlanItem(from: PlanItemStatus, to: PlanItemStatus): boolean {
  return PLAN_ITEM_STATUS_TRANSITIONS[from].includes(to);
}

export function assertPlanItemTransition(from: PlanItemStatus, to: PlanItemStatus): void {
  if (!canTransitionPlanItem(from, to)) {
    throw new Error(`Transición de item inválida: ${from} → ${to}.`);
  }
}

export function isPlanStatus(value: unknown): value is PlanStatus {
  return typeof value === "string" && (PLAN_STATUSES as readonly string[]).includes(value);
}

export function isPlanItemStatus(value: unknown): value is PlanItemStatus {
  return typeof value === "string" && (PLAN_ITEM_STATUSES as readonly string[]).includes(value);
}

export function isPlanSource(value: unknown): value is PlanSource {
  return typeof value === "string" && (PLAN_SOURCES as readonly string[]).includes(value);
}
