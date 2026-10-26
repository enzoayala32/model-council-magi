/**
 * Fase 9C — briefing por fase del Autonomous Loop.
 *
 * Función PURA: recibe el plan persistido y metadatos de los últimos pasos,
 * y arma un texto acotado para el system prompt de UNA fase. No persiste
 * mensajes ni reenvía el historial completo: el modelo puede releer
 * archivos con las tools normales.
 *
 * Reglas:
 * - Solo metadatos: objetivo, estados, títulos, acceptance, paths no
 *   sensibles, toolCallIds, conteos y warnings. Nunca contenido de
 *   archivos, stdout/stderr ni prompts de tools.
 * - Determinista y con tope duro de caracteres; si hay que recortar, se
 *   conservan primero el objetivo, el plan y los toolCallIds (los necesita
 *   para citar evidencia).
 */

import { redactSecrets } from "../../provider-resilience/redact";
import type { PersistedPlan, PersistedPlanItem } from "./ledger";
import { describeCriterion } from "./plan";

export type BriefingPhase = "PLANNING" | "EXECUTING" | "REPLANNING" | "VERIFYING";

export type BriefingAction = {
  toolCallId: string;
  toolName: string;
  ok: boolean;
  files?: string[];
};

export type BriefingStep = {
  stepIndex: number;
  phase: string;
  actions: BriefingAction[];
};

export type BriefingVerification = {
  criterion: string;
  status: string;
};

export type BriefingBudget = {
  stepsUsed: number;
  maxSteps: number;
  tokensUsed: number;
  maxTokens: number;
  wallTimeMs: number;
  maxWallTimeMs: number;
  replansUsed: number;
  maxReplans: number;
};

export type AutonomyBriefingInput = {
  task: string;
  phase: BriefingPhase;
  plan: PersistedPlan | null;
  recentSteps?: BriefingStep[];
  warnings?: string[];
  lastVerification?: BriefingVerification | null;
  budget?: BriefingBudget;
  /** Fase 9E — presente solo cuando la corrida se reanuda. */
  resume?: {
    ofRunId: string;
    verifiedAt: number;
  };
  maxChars?: number;
};

export const BRIEFING_DEFAULT_MAX_CHARS = 12_000;
export const BRIEFING_MAX_ITEMS = 40;
export const BRIEFING_MAX_RECENT_ACTIONS = 30;

function clean(value: string, max: number): string {
  return redactSecrets(value).replace(/\r\n?/g, "\n").trim().slice(0, max);
}

function itemLine(item: PersistedPlanItem): string {
  const acceptance = item.acceptance.length > 0
    ? ` · acceptance: ${item.acceptance.map(describeCriterion).join(", ")}`
    : " · acceptance: (global del plan)";
  const depends = item.dependsOn.length > 0 ? ` · depende de: ${item.dependsOn.join(", ")}` : "";
  const paths = item.paths.length > 0 ? ` · paths: ${item.paths.slice(0, 6).join(", ")}${item.paths.length > 6 ? "…" : ""}` : "";
  const error = item.lastError ? ` · último motivo: ${clean(item.lastError, 200)}` : "";
  return `- [${item.status}] ${item.logicalId} · ${clean(item.title, 200)}${acceptance}${depends}${paths}${error}`;
}

function phaseInstructions(phase: BriefingPhase): string {
  switch (phase) {
    case "PLANNING":
      return [
        "Estás en PLANNING. Tu única tarea en esta fase es proponer el plan.",
        "Llamá `update_plan` UNA vez con un objetivo, constraints si hace falta, y entre 1 y 30 items.",
        "Cada item necesita id estable (t1, t2, …), título, y al menos un criterio de acceptance verificable cuando sea posible (typecheck, script build/test/lint, file_exists o file_hash). Usá `manual` solo si de verdad no hay forma de verificarlo.",
        "No empieces a editar archivos todavía. Si el plan es inválido, la tool te va a devolver los errores para corregirlo.",
      ].join("\n");
    case "EXECUTING":
      return [
        "Estás en EXECUTING. Trabajá en los items PENDING/IN_PROGRESS del plan, de a uno.",
        "Marcá el item IN_PROGRESS antes de empezar y DONE solo cuando esté realmente terminado.",
        "Para DONE necesitás evidencia real de ESTA corrida: un `toolCallId` que aparezca en «Resultados recientes», un archivo con su hash actual, o un comando typecheck/script que el controlador ya haya verificado. No inventes ids, hashes ni comandos.",
        "Si el item tiene acceptance verificable, el controlador la corre al marcar DONE; si falla, el item no cambia y recibís el motivo.",
        "Si te bloqueás, marcá BLOCKED con un motivo concreto. Si necesitás cambiar el plan, llamá `update_plan` (crea una versión nueva).",
      ].join("\n");
    case "REPLANNING":
      return [
        "Estás en REPLANNING. El plan anterior no alcanzó o una verificación falló.",
        "Llamá `update_plan` con una versión corregida: conservá los items que ya están DONE y cambiá solo lo necesario.",
        "No repitas trabajo ya hecho ni inventes evidencia. Explicá en el objetivo o en los títulos qué cambió.",
      ].join("\n");
    case "VERIFYING":
      return "Estás en VERIFYING. No edites archivos; el controlador está corriendo las verificaciones reales.";
  }
}

/**
 * Arma el briefing. El resultado siempre empieza con el objetivo y el plan;
 * si supera `maxChars`, se recortan las secciones menos críticas (primero
 * pasos recientes, después items) y nunca se corta a mitad de una línea
 * dejando texto engañoso.
 */
export function buildAutonomyBriefing(input: AutonomyBriefingInput): string {
  const maxChars = Math.max(1_000, input.maxChars ?? BRIEFING_DEFAULT_MAX_CHARS);
  const header: string[] = [
    "## Briefing autónomo (Fase 9C)",
    `Fase: ${input.phase}`,
    `Objetivo de la task: ${clean(input.task, 2_000)}`,
    phaseInstructions(input.phase),
  ];

  if (input.budget) {
    const b = input.budget;
    header.push(
      `Presupuesto: ${b.stepsUsed}/${b.maxSteps} pasos · ${b.tokensUsed}/${b.maxTokens} tokens · ${Math.round(b.wallTimeMs / 1000)}s/${Math.round(b.maxWallTimeMs / 1000)}s · replans ${b.replansUsed}/${b.maxReplans}`,
    );
  }

  if (input.resume) {
    const verifiedAt = new Date(input.resume.verifiedAt).toISOString();
    header.push(
      `Reanudación: corrida ${input.resume.ofRunId.slice(0, 8)}. El workspace fue verificado a las ${verifiedAt}; no asumas que el estado es el del resumen: releé lo que necesites.`,
    );
  }

  const planLines: string[] = [];
  if (input.plan) {
    planLines.push(
      `Plan v${input.plan.version} (${input.plan.status}, source=${input.plan.source}) · hash ${input.plan.hash.slice(0, 12)}`,
      `Objetivo del plan: ${clean(input.plan.objective, 1_000)}`,
    );
    if (input.plan.constraints.length > 0) {
      planLines.push(`Constraints: ${input.plan.constraints.slice(0, 10).map((value) => clean(value, 200)).join(" · ")}`);
    }
    if (input.plan.acceptance.length > 0) {
      planLines.push(`Acceptance global: ${input.plan.acceptance.map(describeCriterion).join(", ")}`);
    }
    planLines.push("Items:");
    for (const item of input.plan.items.slice(0, BRIEFING_MAX_ITEMS)) planLines.push(itemLine(item));
    if (input.plan.items.length > BRIEFING_MAX_ITEMS) {
      planLines.push(`… y ${input.plan.items.length - BRIEFING_MAX_ITEMS} items más (no listados).`);
    }
  } else {
    planLines.push("Todavía no hay un plan activo.");
  }

  const recentLines: string[] = [];
  const steps = input.recentSteps ?? [];
  if (steps.length > 0) {
    recentLines.push("Resultados recientes (metadatos; los toolCallId son citables como evidencia):");
    const actions = steps.flatMap((step) =>
      step.actions.map((action) => ({ ...action, stepIndex: step.stepIndex, phase: step.phase })),
    );
    for (const action of actions.slice(-BRIEFING_MAX_RECENT_ACTIONS)) {
      const files = action.files && action.files.length > 0 ? ` · archivos: ${action.files.slice(0, 4).join(", ")}` : "";
      recentLines.push(
        `- paso ${action.stepIndex + 1} (${action.phase}) · ${action.toolName} · ${action.ok ? "ok" : "falló"} · toolCallId=${action.toolCallId}${files}`,
      );
    }
  }

  const warningLines: string[] = [];
  if (input.warnings && input.warnings.length > 0) {
    warningLines.push("Advertencias:");
    for (const warning of [...new Set(input.warnings)].slice(0, 10)) warningLines.push(`- ${clean(warning, 300)}`);
  }
  if (input.lastVerification) {
    warningLines.push(`Última verificación: ${clean(input.lastVerification.criterion, 200)} → ${clean(input.lastVerification.status, 50)}`);
  }

  // Orden de recorte: primero resultados recientes, después items del plan.
  let planText = planLines.join("\n");
  let recentText = recentLines.join("\n");
  const fixed = [...header, ...warningLines].join("\n");
  const separator = "\n\n";
  const total = () => fixed.length + separator.length + planText.length + (recentText ? separator.length + recentText.length : 0);

  if (total() > maxChars && recentText) {
    const available = maxChars - fixed.length - separator.length - planText.length - separator.length;
    recentText = available > 200 ? `${recentText.slice(0, available)}\n… (resultados recortados)` : "";
  }
  if (total() > maxChars) {
    const available = maxChars - fixed.length - separator.length;
    planText = available > 300 ? `${planText.slice(0, available)}\n… (plan recortado)` : planText.slice(0, Math.max(0, available));
  }

  const parts = [fixed, planText];
  if (recentText) parts.push(recentText);
  const result = parts.join(separator);
  return result.length <= maxChars ? result : result.slice(0, maxChars);
}
