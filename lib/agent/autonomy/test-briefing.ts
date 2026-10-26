/**
 * Fase 9C — tests del briefing phase-scoped.
 *
 * Función pura: verifica contenido, instrucciones por fase, metadatos de
 * plan/pasos, topes duros, determinismo y redacción de secretos. No toca
 * DB, red ni modelo.
 *
 * Uso: npm run agent:test-autonomy-briefing
 */
import type { PersistedPlan, PersistedPlanItem } from "./ledger";
import {
  BRIEFING_MAX_ITEMS,
  BRIEFING_MAX_RECENT_ACTIONS,
  buildAutonomyBriefing,
  type BriefingPhase,
  type BriefingStep,
} from "./briefing";

let total = 0;
let failed = 0;

function check(condition: boolean, message: string, detail?: () => unknown): void {
  total += 1;
  if (condition) {
    console.log(`✅ ${message}`);
    return;
  }
  failed += 1;
  console.error(`❌ ${message}`);
  if (detail) console.error("   ", JSON.stringify(detail()));
}

function checkEq(actual: unknown, expected: unknown, message: string, detail?: () => unknown): void {
  check(JSON.stringify(actual) === JSON.stringify(expected), message, () => ({
    esperado: expected,
    actual,
    ...(detail ? { detalle: detail() } : {}),
  }));
}

const HASH = "a".repeat(64);

function makeItem(overrides: Partial<PersistedPlanItem> & Pick<PersistedPlanItem, "logicalId" | "title" | "status">): PersistedPlanItem {
  return {
    id: `plan-1:${overrides.logicalId}`,
    planId: "plan-1",
    seq: 1,
    parentId: null,
    description: "DESCRIPCION_QUE_NO_DEBE_SALIR",
    dependsOn: [],
    acceptance: [],
    paths: [],
    evidence: [],
    attempts: 0,
    lastError: null,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

function makePlan(overrides: Partial<PersistedPlan> = {}): PersistedPlan {
  return {
    id: "plan-1",
    taskId: "task-1",
    version: 2,
    objective: "Implementar la feature X",
    constraints: ["no agregar dependencias", "no tocar README.md"],
    acceptance: [{ kind: "typecheck" }, { kind: "script", name: "test" }],
    status: "ACTIVE",
    source: "model",
    createdAt: 1_700_000_000_000,
    hash: HASH,
    items: [
      makeItem({
        logicalId: "t1",
        title: "Preparar el terreno",
        status: "DONE",
        acceptance: [{ kind: "manual", description: "revisar" }],
        paths: ["src/a.ts"],
      }),
      makeItem({
        logicalId: "t2",
        title: "Implementar el flujo",
        status: "IN_PROGRESS",
        seq: 2,
        dependsOn: ["t1"],
        acceptance: [{ kind: "file_hash", path: "src/b.ts", sha256: HASH }],
        paths: ["src/b.ts", "src/c.ts"],
      }),
      makeItem({
        logicalId: "t3",
        title: "Correr tests",
        status: "PENDING",
        seq: 3,
        acceptance: [{ kind: "script", name: "test" }],
        lastError: "falló la verificación anterior",
      }),
    ],
    ...overrides,
  };
}

function steps(count: number): BriefingStep[] {
  return Array.from({ length: count }, (_, index) => ({
    stepIndex: index,
    phase: index === 0 ? "EXECUTING" : "EXECUTING",
    actions: [
      {
        toolCallId: `call-${index}`,
        toolName: index % 2 === 0 ? "write_file" : "update_plan_item",
        ok: index % 3 !== 0,
        ...(index % 2 === 0 ? { files: [`src/file-${index}.ts`] } : {}),
      },
    ],
  }));
}

async function main(): Promise<void> {
  console.log("== Fase 9C — briefing autónomo ==\n");

  const { registerSecret } = await import("../../provider-resilience/redact");
  registerSecret("SECRETO_REGISTRADO_9C");

  const plan = makePlan();
  const baseInput = {
    task: "Implementar la feature X con SECRETO_REGISTRADO_9C",
    phase: "EXECUTING" as BriefingPhase,
    plan,
    recentSteps: [
      {
        stepIndex: 0,
        phase: "EXECUTING",
        actions: [{ toolCallId: "call-write", toolName: "write_file", ok: true, files: ["src/a.ts"] }],
      },
      {
        stepIndex: 1,
        phase: "EXECUTING",
        actions: [{ toolCallId: "call-fail", toolName: "update_plan_item", ok: false }],
      },
    ],
    warnings: ["manual_acceptance_unverified", "replan_preserved_1", "manual_acceptance_unverified"],
    lastVerification: { criterion: "file_hash:src/b.ts", status: "failed" },
    budget: {
      stepsUsed: 5,
      maxSteps: 40,
      tokensUsed: 12_000,
      maxTokens: 1_500_000,
      wallTimeMs: 65_000,
      maxWallTimeMs: 900_000,
      replansUsed: 1,
      maxReplans: 3,
    },
  };

  console.log("--- Contenido del plan ---");
  const briefing = buildAutonomyBriefing(baseInput);
  check(briefing.startsWith("## Briefing autónomo (Fase 9C)"), "empieza con el encabezado de 9C");
  check(briefing.includes("Fase: EXECUTING"), "incluye la fase");
  check(briefing.includes("Objetivo de la task:"), "incluye el objetivo de la task");
  check(briefing.includes("Plan v2 (ACTIVE, source=model)"), "incluye versión/estado/fuente del plan");
  check(briefing.includes(`hash ${HASH.slice(0, 12)}`), "incluye el prefijo del hash del plan");
  check(briefing.includes("Objetivo del plan: Implementar la feature X"), "incluye el objetivo del plan");
  check(briefing.includes("Constraints: no agregar dependencias · no tocar README.md"), "incluye constraints");
  check(briefing.includes("Acceptance global: typecheck, script:test"), "incluye la acceptance global");
  check(briefing.includes("Items:"), "incluye la sección de items");
  check(briefing.includes("[DONE] t1 · Preparar el terreno"), "incluye el item DONE");
  check(briefing.includes("[IN_PROGRESS] t2 · Implementar el flujo"), "incluye el item IN_PROGRESS");
  check(briefing.includes("[PENDING] t3 · Correr tests"), "incluye el item PENDING");
  check(briefing.includes("acceptance: file_hash:src/b.ts"), "incluye la acceptance del item");
  check(briefing.includes("depende de: t1"), "incluye dependencias");
  check(briefing.includes("paths: src/b.ts, src/c.ts"), "incluye paths");
  check(briefing.includes("último motivo: falló la verificación anterior"), "incluye el último error del item");
  check(!briefing.includes("DESCRIPCION_QUE_NO_DEBE_SALIR"), "NO incluye la descripción completa del item");
  check(briefing.includes("Presupuesto: 5/40 pasos"), "incluye el presupuesto de pasos");
  check(briefing.includes("replans 1/3"), "incluye el presupuesto de replans");
  check(briefing.includes("Última verificación: file_hash:src/b.ts → failed"), "incluye la última verificación");
  check(briefing.includes("toolCallId=call-write"), "incluye toolCallIds citables");
  check(briefing.includes("toolCallId=call-fail"), "incluye toolCallIds de acciones fallidas");
  check(briefing.includes("archivos: src/a.ts"), "incluye archivos tocados");
  checkEq((briefing.match(/manual_acceptance_unverified/g) ?? []).length, 1, "deduplica warnings idénticos");

  console.log("\n--- Fases ---");
  const phases: BriefingPhase[] = ["PLANNING", "EXECUTING", "REPLANNING", "VERIFYING"];
  for (const phase of phases) {
    const text = buildAutonomyBriefing({ ...baseInput, phase });
    check(text.includes(`Fase: ${phase}`), `${phase}: incluye su nombre`);
    check(text.includes(`Estás en ${phase}`), `${phase}: incluye instrucciones de la fase`);
  }
  check(buildAutonomyBriefing({ ...baseInput, phase: "PLANNING" }).includes("Llamá `update_plan` UNA vez"), "PLANNING pide update_plan");
  check(buildAutonomyBriefing({ ...baseInput, phase: "REPLANNING" }).includes("conservá los items que ya están DONE"), "REPLANNING pide conservar DONE");
  check(buildAutonomyBriefing({ ...baseInput, phase: "VERIFYING" }).includes("No edites archivos"), "VERIFYING prohíbe editar");

  console.log("\n--- Sin plan y determinismo ---");
  const noPlan = buildAutonomyBriefing({ ...baseInput, plan: null });
  check(noPlan.includes("Todavía no hay un plan activo."), "sin plan lo dice explícitamente");
  checkEq(buildAutonomyBriefing(baseInput), briefing, "la misma entrada produce exactamente la misma salida");
  const reorderedWarnings = buildAutonomyBriefing({
    ...baseInput,
    warnings: ["replan_preserved_1", "manual_acceptance_unverified", "manual_acceptance_unverified"],
  });
  check(reorderedWarnings.includes("manual_acceptance_unverified"), "el orden de warnings no pierde información");

  console.log("\n--- Redacción de secretos ---");
  check(!briefing.includes("SECRETO_REGISTRADO_9C"), "el secreto de la task queda redactado");
  check(briefing.includes("[REDACTED]"), "usa el marcador de redacción");
  const secretWarning = buildAutonomyBriefing({ ...baseInput, warnings: ["falló con SECRETO_REGISTRADO_9C"] });
  check(!secretWarning.includes("SECRETO_REGISTRADO_9C"), "el secreto de un warning queda redactado");

  console.log("\n--- Topes duros ---");
  const manySteps = steps(BRIEFING_MAX_RECENT_ACTIONS + 10);
  const cappedSteps = buildAutonomyBriefing({ ...baseInput, recentSteps: manySteps });
  check(cappedSteps.includes(`toolCallId=call-${BRIEFING_MAX_RECENT_ACTIONS + 9}`), "conserva las acciones más recientes");
  check(!cappedSteps.includes("toolCallId=call-0\n"), "descarta las acciones más viejas");

  const manyItems = makePlan({
    items: Array.from({ length: BRIEFING_MAX_ITEMS + 5 }, (_, index) =>
      makeItem({
        logicalId: `t${index + 1}`,
        title: `Item ${index + 1}`,
        status: "PENDING",
        seq: index + 1,
      }),
    ),
  });
  const cappedItems = buildAutonomyBriefing({ ...baseInput, plan: manyItems });
  checkEq((cappedItems.match(/^- \[/gm) ?? []).length, BRIEFING_MAX_ITEMS, "lista como máximo BRIEFING_MAX_ITEMS items");
  check(cappedItems.includes("… y 5 items más (no listados)."), "avisa cuántos items quedaron afuera");

  const manyWarnings = Array.from({ length: 12 }, (_, index) => `warning_${index}`);
  const cappedWarnings = buildAutonomyBriefing({ ...baseInput, warnings: manyWarnings });
  checkEq((cappedWarnings.match(/^- warning_/gm) ?? []).length, 10, "lista como máximo 10 warnings");
  check(cappedWarnings.includes("warning_9"), "conserva los primeros 10 warnings");
  check(!cappedWarnings.includes("warning_10"), "descarta los warnings 11+");

  const bigPlan = makePlan({
    objective: "Objetivo " + "muy largo ".repeat(100),
    items: Array.from({ length: 40 }, (_, index) =>
      makeItem({
        logicalId: `t${index + 1}`,
        title: `Item con un título razonablemente largo ${index + 1}`,
        status: "PENDING",
        seq: index + 1,
        acceptance: [{ kind: "manual", description: "revisar" }],
        paths: ["src/archivo-con-nombre-largo.ts"],
      }),
    ),
  });
  const capped = buildAutonomyBriefing({ ...baseInput, plan: bigPlan, maxChars: 1_200 });
  check(capped.length <= 1_200, "respeta el tope de caracteres", () => ({ length: capped.length }));
  check(capped.includes("## Briefing autónomo (Fase 9C)"), "el tope no se come el encabezado");
  check(capped.includes("Objetivo de la task:"), "el tope no se come el objetivo de la task");

  console.log("\n--- Resultado ---");
  checkEq(total - failed, total, `${total - failed}/${total} aserciones OK`);

  if (failed > 0) {
    console.error(`\n${failed} aserción(es) fallaron.`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("Error inesperado en el test del briefing:", error);
  process.exitCode = 1;
});
