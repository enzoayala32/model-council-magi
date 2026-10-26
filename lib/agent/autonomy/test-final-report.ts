/**
 * Fase 9F — tests puros del informe final.
 *
 * No toca DB, red, modelo ni filesystem: construye el informe desde objetos
 * del ledger/proposals y verifica determinismo, redacción, omisión de rutas
 * sensibles, metadata de comandos y truncamiento.
 *
 * Uso: npm run agent:test-autonomy-final-report
 */
import crypto from "node:crypto";
import { registerSecret } from "../../provider-resilience/redact";
import {
  buildFinalReport,
  FINAL_REPORT_VERSION,
  mapFinalStatus,
  type BuildFinalReportInput,
  type FinalReport,
} from "./final-report";
import type { AgentStep, PersistedPlan, PersistedPlanItem, VerificationRecord } from "./ledger";
import type { AutonomyState } from "./contract";

const sha256 = (value: string) => crypto.createHash("sha256").update(value, "utf8").digest("hex");

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

function item(id: string, status: PersistedPlanItem["status"], overrides: Partial<PersistedPlanItem> = {}): PersistedPlanItem {
  return {
    id: `p-${id}`,
    logicalId: id,
    planId: "plan-1",
    seq: Number(id.replace(/\D/g, "")) || 1,
    parentId: null,
    title: `Item ${id}`,
    description: "",
    status,
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

function plan(items: PersistedPlanItem[], overrides: Partial<PersistedPlan> = {}): PersistedPlan {
  return {
    id: "plan-1",
    taskId: "task-9f",
    version: 1,
    objective: "Objetivo de prueba",
    constraints: [],
    acceptance: [],
    status: "ACTIVE",
    source: "model",
    createdAt: 1,
    hash: "plan-hash",
    items,
    ...overrides,
  };
}

function step(
  stepIndex: number,
  phase: string,
  actions: AgentStep["actions"],
  results: unknown[] = [],
): AgentStep {
  return {
    id: `step-${stepIndex}`,
    runId: "run-9f",
    stepIndex,
    phase,
    ts: 1_000 + stepIndex,
    actions,
    results,
    progress: {},
    inputTokens: null,
    outputTokens: null,
  };
}

function verification(
  criterion: VerificationRecord["criterion"],
  status: VerificationRecord["status"],
  evidence: Record<string, unknown> = {},
): VerificationRecord {
  return {
    id: `v-${Math.random()}`,
    runId: "run-9f",
    itemId: null,
    criterion,
    status,
    evidence,
    ts: 1,
  };
}

function baseInput(overrides: Partial<BuildFinalReportInput> = {}): BuildFinalReportInput {
  return {
    taskId: "task-9f",
    runId: "run-9f",
    state: "DONE",
    outcome: { status: "READY_FOR_REVIEW", stopReason: "completed" },
    budget: { steps: 3, wallTimeMs: 1_000, inputTokens: 100, outputTokens: 10, estimatedCostUsd: null },
    plan: plan([item("t1", "DONE", { evidence: [{ kind: "manual", description: "revisado" }] })]),
    steps: [],
    verifications: [],
    proposals: [],
    warnings: [],
    resumeWarnings: [],
    workspaceRoot: "C:\\ws\\proyecto",
    maxBytes: 32_768,
    ...overrides,
  };
}

function main(): void {
  console.log("== Fase 9F — informe final ==\n");

  console.log("--- Determinismo y mapeo de estados ---");
  {
    const a = buildFinalReport(baseInput());
    const b = buildFinalReport(baseInput());
    checkEq(JSON.stringify(a), JSON.stringify(b), "el mismo estado produce el mismo JSON");
    checkEq(a.version, FINAL_REPORT_VERSION, "versión del informe");
    checkEq(a.taskId, "task-9f", "taskId");
    checkEq(a.runId, "run-9f", "runId");

    const states: Array<[AutonomyState, FinalReport["status"]]> = [
      ["DONE", "done"],
      ["BLOCKED", "blocked"],
      ["STALLED", "stalled"],
      ["BUDGET_EXHAUSTED", "budget_exhausted"],
      ["FAILED", "failed"],
      ["CANCELLED", "cancelled"],
    ];
    for (const [state, expected] of states) {
      checkEq(mapFinalStatus(state), expected, `mapFinalStatus(${state})`);
    }
    let threw = false;
    try {
      mapFinalStatus("EXECUTING");
    } catch {
      threw = true;
    }
    check(threw, "un estado no terminal no se puede mapear");
  }

  console.log("\n--- Plan: conteos y no resueltos ---");
  {
    const input = baseInput({
      plan: plan([
        item("t1", "DONE", { evidence: [{ kind: "manual", description: "revisado" }] }),
        item("t2", "BLOCKED", { lastError: "Faltó una dependencia." }),
        item("t3", "SKIPPED"),
        item("t4", "PENDING"),
      ], { acceptance: [{ kind: "manual", description: "revisar todo" }] }),
    });
    const report = buildFinalReport(input);
    checkEq(report.plan, { version: 1, done: 1, total: 4, blocked: 1, skipped: 1 }, "conteos del plan");
    checkEq(report.unresolved.map((entry) => entry.itemId), ["t2", "t4"], "solo los no terminados quedan sin resolver");
    checkEq(report.unresolved[0]?.reason, "Faltó una dependencia.", "el motivo real del BLOCKED se conserva");
    check(
      report.limitations.some((line) => line.includes("criterio(s) manual(es)")),
      "declara acceptance manual global",
    );
    check(
      report.limitations.some((line) => line.includes("evidencia manual")),
      "declara DONE con evidencia manual",
    );
  }

  console.log("\n--- Cambios reales, rutas sensibles y unsafe ---");
  {
    const report = buildFinalReport(
      baseInput({
        proposals: [
          { kind: "write", relPath: "src/b.ts", diff: "+b\n", nextContent: "b" },
          { kind: "edit", relPath: "src/a.ts", diff: "+a1\n+a2\n-old\n", nextContent: "a" },
          { kind: "write", relPath: "src/a.ts", diff: "+duplicado\n", nextContent: "duplicado" },
          { kind: "write", relPath: ".env", diff: "+API_KEY=supersecreto\n", nextContent: "API_KEY=supersecreto" },
          { kind: "write", relPath: "../evil.ts", diff: "+evil\n", nextContent: "evil" },
          { kind: "write", relPath: "C:\\Windows\\evil.ts", diff: "+evil\n", nextContent: "evil" },
        ],
      }),
    );

    checkEq(report.changes.map((change) => change.path), ["src/a.ts", "src/b.ts"], "rutas ordenadas y sin duplicados");
    checkEq(report.changes[0]?.kind, "edit", "conserva el kind real");
    checkEq(report.changes[0]?.additions, 2, "cuenta additions del diff");
    checkEq(report.changes[0]?.deletions, 1, "cuenta deletions del diff");
    checkEq(report.changes[0]?.sha256, sha256("a"), "hash del contenido final");
    checkEq(report.changes[1]?.sha256, sha256("b"), "hash del segundo archivo");
    check(
      report.limitations.some((line) => line.includes("1 ruta(s) sensible(s)")),
      "cuenta la ruta sensible omitida",
    );
    check(
      report.limitations.some((line) => line.includes("2 ruta(s) no segura(s)")),
      "cuenta las rutas unsafe omitidas",
    );
    const json = JSON.stringify(report);
    check(!json.includes("supersecreto"), "no filtra el contenido de .env");
    check(!json.includes("evil"), "no filtra rutas unsafe ni su contenido");
  }

  console.log("\n--- Comandos y tests: solo metadata ---");
  {
    const outputHash = sha256("salida completa del comando");
    const report = buildFinalReport(
      baseInput({
        steps: [
          step(0, "PLANNING", [{ toolCallId: "c-plan", toolName: "update_plan", inputHash: "h", ok: true }], [
            { ok: true, toolCallId: "c-plan" },
          ]),
          step(
            1,
            "EXECUTING",
            [
              { toolCallId: "c-typecheck", toolName: "run_typecheck", inputHash: "h1", ok: true },
              { toolCallId: "c-test", toolName: "run_script", inputHash: "h2", ok: true },
            ],
            [
              { ok: true, toolCallId: "c-typecheck", success: true, exitCode: 0, durationMs: 12, outputSha256: sha256("tsc ok") },
              { ok: true, toolCallId: "c-test", name: "test", success: false, exitCode: 1, durationMs: 34, outputSha256: outputHash },
            ],
          ),
        ],
        verifications: [
          verification({ kind: "typecheck" }, "passed", { exitCode: 0, durationMs: 12 }),
          verification({ kind: "script", name: "test" }, "passed", { exitCode: 0, durationMs: 20 }),
          verification({ kind: "script", name: "build" }, "failed", { exitCode: 1, durationMs: 30 }),
          verification({ kind: "file_hash", path: "src/a.ts", sha256: sha256("a") }, "unverified", { reason: "not_found" }),
        ],
      }),
    );

    checkEq(report.commands.length, 2, "dos comandos registrados");
    checkEq(report.commands[0], {
      name: "typecheck",
      exitCode: 0,
      durationMs: 12,
      ok: true,
      outputSha256: sha256("tsc ok"),
    }, "metadata de run_typecheck");
    checkEq(report.commands[1], {
      name: "test",
      exitCode: 1,
      durationMs: 34,
      ok: false,
      outputSha256: outputHash,
    }, "metadata de run_script");

    checkEq(report.tests, [{ name: "test", ok: true, exitCode: 0, durationMs: 20 }], "solo el script test entra en tests");
    checkEq(report.verification.length, 4, "todas las verificaciones quedan listadas");
    checkEq(report.verification[3]?.status, "unverified", "conserva unverified");
    check(
      report.limitations.some((line) => line.includes("1 verificación(es) no pudieron ejecutarse")),
      "declara verificaciones no ejecutadas",
    );
    check(
      report.limitations.some((line) => line.includes("1 verificación(es) fallaron")),
      "declara verificaciones fallidas",
    );
    const json = JSON.stringify(report);
    check(!json.includes("salida completa del comando"), "no filtra el output del comando");
    check(!json.includes("stdout"), "no incluye stdout");
    check(!json.includes("stderr"), "no incluye stderr");
  }

  console.log("\n--- Limitaciones y próximos pasos ---");
  {
    const report = buildFinalReport(
      baseInput({
        state: "BUDGET_EXHAUSTED",
        outcome: { status: "FAILED", stopReason: "timeout" },
        plan: null,
        budget: { steps: 2, wallTimeMs: 1_000, inputTokens: 0, outputTokens: 0, estimatedCostUsd: null },
        steps: [step(0, "PLANNING", [])],
        warnings: ["warning repetido", "warning repetido"],
      }),
    );
    checkEq(report.status, "budget_exhausted", "status budget_exhausted");
    checkEq(report.stopReason, "timeout", "conserva stopReason timeout");
    checkEq(report.budget.inputTokens, null, "provider sin usage ⇒ tokens null");
    check(report.limitations.some((line) => line.includes("presupuesto agotado")), "declara presupuesto agotado");
    check(report.limitations.some((line) => line.includes("No hay un plan persistido")), "declara plan ausente");
    check(report.limitations.some((line) => line.includes("pricing conocido")), "declara costo no estimado");
    check(report.limitations.some((line) => line.includes("no informó usage")), "declara provider sin usage");
    checkEq(report.limitations.filter((line) => line === "warning repetido").length, 1, "deduplica warnings");
    check(report.nextSteps.includes("Aumentar el presupuesto o dividir la tarea."), "sugiere aumentar presupuesto");

    const doneNoChanges = buildFinalReport(baseInput({ state: "DONE", outcome: { status: "NO_CHANGES", stopReason: "completed" } }));
    check(doneNoChanges.limitations.some((line) => line.includes("sin cambios detectados")), "declara DONE sin cambios");
    check(doneNoChanges.nextSteps.includes("No hay cambios para aplicar."), "next step sin cambios");

    const cancelled = buildFinalReport(baseInput({ state: "CANCELLED", outcome: { status: "CANCELLED", stopReason: "cancelled" } }));
    check(cancelled.limitations.some((line) => line.includes("se canceló")), "declara cancelación");
    check(cancelled.nextSteps.includes("Reanudar la tarea o descartarla."), "sugiere reanudar/descartar");
  }

  console.log("\n--- Redacción y workspace absoluto ---");
  {
    const secret = "SECRET-9F-ABC-123";
    registerSecret(secret);
    const workspaceRoot = "C:\\Users\\Admin\\proyecto secreto";
    const report = buildFinalReport(
      baseInput({
        workspaceRoot,
        plan: plan([
          item("t1", "DONE", {
            lastError: `Falló en ${workspaceRoot}\\src\\a.ts con ${secret}`,
            evidence: [{ kind: "manual", description: "revisado" }],
          }),
        ], { objective: `Objetivo ${secret} en ${workspaceRoot}` }),
        steps: [
          step(1, "EXECUTING", [{ toolCallId: "c-test", toolName: "run_script", inputHash: "h", ok: true }], [
            { ok: true, toolCallId: "c-test", name: secret, success: true, exitCode: 0, durationMs: 1, outputSha256: sha256("x") },
          ]),
        ],
      }),
    );
    const json = JSON.stringify(report);
    check(!json.includes(secret), "no filtra secretos registrados");
    check(report.objective.includes("[REDACTED]"), "redacta el secreto del objetivo");
    check(report.objective.includes("<workspace>"), "reemplaza el workspace absoluto");
    check(!json.includes(workspaceRoot.replace(/\\/g, "\\\\")), "no filtra la ruta absoluta del workspace");
    checkEq(report.commands[0]?.name, "[REDACTED]", "redacta el nombre del comando");
  }

  console.log("\n--- Truncamiento determinista ---");
  {
    const proposals = Array.from({ length: 40 }, (_, index) => ({
      kind: "write" as const,
      relPath: `src/generated/file-${String(index).padStart(3, "0")}.ts`,
      diff: "+line\n",
      nextContent: `content-${index}`,
    }));
    const input = baseInput({
      proposals,
      warnings: Array.from({ length: 20 }, (_, index) => `warning ${index} con texto suficiente para ocupar espacio`),
      maxBytes: 2_000,
    });
    const a = buildFinalReport(input);
    const b = buildFinalReport(input);
    checkEq(JSON.stringify(a), JSON.stringify(b), "el truncamiento también es determinista");
    check(a.truncated === true, "marca truncated");
    check(Buffer.byteLength(JSON.stringify(a), "utf8") <= 2_000, "respeta maxBytes", () => Buffer.byteLength(JSON.stringify(a), "utf8"));
    checkEq(a.status, "done", "conserva status");
    checkEq(a.stopReason, "completed", "conserva stopReason");
    checkEq(a.plan.total, 1, "conserva el plan");
    checkEq(a.budget.steps, 3, "conserva el presupuesto");
    check(a.changes.length < 40, "recorta la lista de cambios");
    check(a.limitations.some((line) => line.includes("truncó")), "declara el truncamiento");
  }

  console.log(`\n${total - failed}/${total} aserciones OK.`);
  if (failed > 0) process.exit(1);
}

main();
