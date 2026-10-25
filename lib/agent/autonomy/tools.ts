/**
 * Fase 9B — tools de plan del Autonomous Loop.
 *
 * Este módulo NO se importa desde `tools.ts` ni desde `loop.ts` todavía:
 * 9C es quien las agrega al set de tools cuando la autonomía está
 * habilitada. Así el camino legacy de producción queda intacto.
 *
 * Las tools son deliberadamente delgadas: validan la forma con Zod,
 * delegan la verdad al ledger y devuelven resúmenes chicos. Un plan
 * inválido no se persiste; un `DONE` sin evidencia/verificación no muta el
 * item.
 */

import { tool } from "ai";
import { z } from "zod";
import { redactSecrets } from "../../provider-resilience/redact";
import { wrapToolExecute } from "../tool-policy";
import {
  isTerminalAutonomyState,
  normalizeAutonomyLimits,
  type AutonomyLimits,
} from "./contract";
import {
  getRun,
  savePlanVersion,
  updatePlanItem,
  type AcceptanceVerifier,
} from "./ledger";
import {
  normalizePlan,
  SCRIPT_NAMES,
  type ScriptName,
} from "./plan";

const acceptanceCriterionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("typecheck") }),
  z.object({ kind: z.literal("script"), name: z.enum(["build", "test", "lint"]) }),
  z.object({ kind: z.literal("file_exists"), path: z.string() }),
  z.object({ kind: z.literal("file_hash"), path: z.string(), sha256: z.string() }),
  z.object({ kind: z.literal("manual"), description: z.string() }),
]);

const planEvidenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("tool_result"), toolCallId: z.string() }),
  z.object({ kind: z.literal("file"), path: z.string(), sha256: z.string() }),
  z.object({
    kind: z.literal("command"),
    name: z.enum(["typecheck", "build", "test", "lint"]),
    exitCode: z.number().int(),
  }),
  z.object({ kind: z.literal("manual"), description: z.string() }),
]);

const planItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  dependsOn: z.array(z.string()).optional(),
  acceptance: z.array(acceptanceCriterionSchema).optional(),
  paths: z.array(z.string()).optional(),
});

export const updatePlanInputSchema = z.object({
  objective: z.string(),
  constraints: z.array(z.string()).optional(),
  acceptance: z.array(acceptanceCriterionSchema).optional(),
  items: z.array(planItemSchema),
});

export const updatePlanItemInputSchema = z.object({
  id: z.string(),
  status: z.enum(["IN_PROGRESS", "DONE", "BLOCKED", "FAILED", "SKIPPED"]),
  reason: z.string().optional(),
  evidence: z.array(planEvidenceSchema).optional(),
});

export type UpdatePlanToolInput = z.infer<typeof updatePlanInputSchema>;
export type UpdatePlanItemToolInput = z.infer<typeof updatePlanItemInputSchema>;

export type AutonomyPlanToolOptions = {
  taskId: string;
  runId: string;
  limits?: AutonomyLimits;
  workspaceRoot: string;
  allowedScripts?: string[];
  verifier?: AcceptanceVerifier;
};

const PLAN_POLICY = { timeoutMs: 30_000, maxOutputChars: 100_000 };
const PLAN_ITEM_POLICY = { timeoutMs: 180_000, maxOutputChars: 100_000 };

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Error inesperado en la tool de plan.";
  return redactSecrets(message).slice(0, 1_000);
}

function normalizeAllowedScripts(scripts: string[] | undefined): ScriptName[] {
  if (!scripts) return [];
  const result: ScriptName[] = [];
  for (const name of scripts) {
    if ((SCRIPT_NAMES as readonly string[]).includes(name) && !result.includes(name as ScriptName)) {
      result.push(name as ScriptName);
    }
  }
  return result;
}

export function createAutonomyPlanTools(options: AutonomyPlanToolOptions) {
  const limits = normalizeAutonomyLimits(options.limits);
  const allowedScripts = normalizeAllowedScripts(options.allowedScripts);

  const requireLiveRun = () => {
    const run = getRun(options.runId);
    if (!run || run.taskId !== options.taskId) {
      return { ok: false as const, error: "La corrida autónoma no existe o no pertenece a esta task." };
    }
    if (isTerminalAutonomyState(run.state)) {
      return { ok: false as const, error: `La corrida ya terminó (${run.state}); no se puede modificar el plan.` };
    }
    return { ok: true as const, run };
  };

  return {
    update_plan: tool({
      description:
        "Crea una versión nueva del plan de trabajo. Usalo al empezar y cuando necesites replanificar. Cada item debe tener un id estable, un título y, si es posible, criterios de aceptación verificables. Un plan inválido no se guarda.",
      inputSchema: updatePlanInputSchema,
      execute: wrapToolExecute(
        "update_plan",
        async (input: UpdatePlanToolInput, toolOptions?: { abortSignal?: AbortSignal }) => {
          const live = requireLiveRun();
          if (!live.ok) return { ok: false, error: live.error };
          if (toolOptions?.abortSignal?.aborted) return { ok: false, error: "La task fue cancelada." };

          const validation = normalizePlan(input, limits);
          if (!validation.ok) {
            return {
              ok: false,
              error: "Plan inválido; no se guardó. Corregí los errores y volvé a intentar.",
              errors: validation.errors,
            };
          }

          try {
            const persisted = savePlanVersion({
              taskId: options.taskId,
              runId: options.runId,
              plan: validation.plan,
              source: "model",
              maxVersions: limits.maxPlanVersions,
            });
            return {
              ok: true,
              version: persisted.version,
              hash: persisted.hash,
              warnings: validation.warnings,
              items: persisted.items.map((item) => ({
                id: item.logicalId,
                seq: item.seq,
                title: item.title,
                status: item.status,
              })),
            };
          } catch (error) {
            return { ok: false, error: safeErrorMessage(error) };
          }
        },
        PLAN_POLICY,
      ),
    }),

    update_plan_item: tool({
      description:
        "Actualiza el estado de un item del plan activo. Para DONE necesitás evidencia real de esta corrida (toolCallId, archivo con hash actual, comando verificado o justificación manual) y, si el item tiene acceptance verificable, el controlador debe poder verificarla. No inventes evidencia.",
      inputSchema: updatePlanItemInputSchema,
      execute: wrapToolExecute(
        "update_plan_item",
        async (input: UpdatePlanItemToolInput, toolOptions?: { abortSignal?: AbortSignal }) => {
          const live = requireLiveRun();
          if (!live.ok) return { ok: false, error: live.error };
          if (toolOptions?.abortSignal?.aborted) return { ok: false, error: "La task fue cancelada." };

          try {
            const result = await updatePlanItem({
              runId: options.runId,
              itemId: input.id,
              status: input.status,
              reason: input.reason,
              evidence: input.evidence,
              limits,
              workspaceRoot: options.workspaceRoot,
              allowedScripts,
              verifier: options.verifier,
              signal: toolOptions?.abortSignal,
            });
            if (!result.ok) {
              return { ok: false, code: result.code, error: result.error };
            }
            return {
              ok: true,
              item: {
                id: result.item.logicalId,
                status: result.item.status,
                attempts: result.item.attempts,
                evidenceCount: result.item.evidence.length,
              },
              warnings: result.warnings,
            };
          } catch (error) {
            return { ok: false, error: safeErrorMessage(error) };
          }
        },
        PLAN_ITEM_POLICY,
      ),
    }),
  };
}

export const AUTONOMY_PLAN_TOOL_NAMES = ["update_plan", "update_plan_item"] as const;

// Políticas exportadas para que los tests verifiquen que el timeout de la
// tool que puede correr verificaciones es mayor que el de las tools
// normales (mismo criterio que EXEC_POLICY en tools.ts).
export const AUTONOMY_PLAN_POLICIES = {
  update_plan: PLAN_POLICY,
  update_plan_item: PLAN_ITEM_POLICY,
} as const;
