/**
 * Fase 9B — tests puros de validación/normalización del plan.
 *
 * Sin DB, sin filesystem, sin modelo. Cubre ids, dependencias, ciclos,
 * profundidad, límites, rutas seguras, acceptance, evidencia y el fallback.
 */
import {
  DEFAULT_AUTONOMY_LIMITS,
  type AutonomyLimits,
} from "./contract";
import {
  PLAN_FORMAT_LIMITS,
  PLAN_ITEM_STATUSES,
  assertPlanItemTransition,
  buildFallbackPlan,
  canTransitionPlanItem,
  computePlanHash,
  describeCriterion,
  isMachineCheckable,
  isManualCriterion,
  isPlanItemStatus,
  isPlanSource,
  isPlanStatus,
  normalizePlan,
  normalizePlanEvidence,
  normalizePlanReason,
  type PlanItemStatus,
} from "./plan";

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

const baseLimits = DEFAULT_AUTONOMY_LIMITS;

function withLimits(partial: Partial<AutonomyLimits>): AutonomyLimits {
  return { ...baseLimits, ...partial };
}

function expectError(input: unknown, code: string, label: string, limits?: AutonomyLimits): void {
  const result = normalizePlan(input, limits);
  check(!result.ok, label);
  if (!result.ok) {
    check(
      result.errors.some((error) => error.code === code),
      `${label} — código ${code}`,
      () => result.errors,
    );
  }
}

function main(): void {
  console.log("== Fase 9B — validación del plan ==\n");

  console.log("--- Plan válido y normalización determinista ---");
  const input = {
    objective: "Implementar la feature X",
    constraints: ["No agregar dependencias", "No romper la API"],
    acceptance: [{ kind: "typecheck" }],
    items: [
      {
        id: "t1",
        title: "  Crear el módulo  ",
        description: "Primera línea\r\nSegunda línea",
        paths: ["src\\a.ts", "src/b.ts"],
        acceptance: [{ kind: "file_exists", path: "src/a.ts" }],
      },
      {
        id: "t2",
        title: "Agregar tests",
        dependsOn: ["t1"],
        acceptance: [{ kind: "script", name: "test" }],
      },
    ],
  };
  const inputSnapshot = JSON.stringify(input);
  const valid = normalizePlan(input);
  check(valid.ok, "el plan válido se acepta");
  if (valid.ok) {
    checkEq(valid.plan.items.length, 2, "dos items");
    checkEq(valid.plan.items[0].logicalId, "t1", "primer id lógico");
    checkEq(valid.plan.items[0].seq, 1, "primer seq");
    checkEq(valid.plan.items[1].seq, 2, "segundo seq");
    checkEq(valid.plan.items[0].title, "Crear el módulo", "título recortado");
    checkEq(valid.plan.items[0].description, "Primera línea\nSegunda línea", "CRLF normalizado");
    checkEq(valid.plan.items[0].paths, ["src/a.ts", "src/b.ts"], "paths normalizados a /");
    checkEq(valid.plan.items[1].dependsOn, ["t1"], "dependencia normalizada");
    checkEq(valid.plan.constraints, ["No agregar dependencias", "No romper la API"], "constraints ordenadas");
    check(/^[a-f0-9]{64}$/.test(valid.plan.hash), "hash SHA-256 de 64 hex");
    checkEq(computePlanHash(valid.plan), valid.plan.hash, "computePlanHash coincide con el plan");
    checkEq(valid.warnings, [], "sin warnings");
  }
  checkEq(JSON.stringify(input), inputSnapshot, "no muta el input");

  const reordered = normalizePlan({
    ...input,
    constraints: ["No romper la API", "No agregar dependencias"],
    items: input.items.map((item) => ({
      ...item,
      paths: item.paths ? [...item.paths].reverse() : undefined,
    })),
  });
  check(reordered.ok, "el plan con orden distinto se acepta");
  if (valid.ok && reordered.ok) {
    checkEq(reordered.plan.hash, valid.plan.hash, "el hash no depende del orden de constraints/paths");
  }

  const differentItemOrder = normalizePlan({
    ...input,
    items: [...input.items].reverse(),
  });
  check(differentItemOrder.ok, "el plan con items en otro orden se acepta");
  if (valid.ok && differentItemOrder.ok) {
    check(differentItemOrder.plan.hash !== valid.plan.hash, "el orden de los items sí cambia el hash");
  }

  console.log("\n--- Plan manual y warnings ---");
  const manualOnly = normalizePlan({
    objective: "Revisar algo",
    items: [
      {
        id: "t1",
        title: "Revisar",
        acceptance: [{ kind: "manual", description: "Revisión humana" }],
      },
    ],
  });
  check(manualOnly.ok, "un plan solo manual se acepta");
  if (manualOnly.ok) checkEq(manualOnly.warnings, ["manual_only"], "warning manual_only");

  const globalManual = normalizePlan({
    objective: "Revisar algo",
    acceptance: [{ kind: "manual", description: "Revisión global" }],
    items: [{ id: "t1", title: "Revisar" }],
  });
  check(globalManual.ok, "acceptance global manual con item sin acceptance se acepta");
  if (globalManual.ok) check(globalManual.warnings.includes("manual_only"), "warning manual_only global");

  const globalVerifiable = normalizePlan({
    objective: "Compilar",
    acceptance: [{ kind: "typecheck" }],
    items: [{ id: "t1", title: "Compilar" }],
  });
  check(globalVerifiable.ok, "acceptance global verificable con item sin acceptance se acepta");
  if (globalVerifiable.ok) {
    check(globalVerifiable.warnings.includes("items_without_acceptance"), "warning items_without_acceptance");
  }

  console.log("\n--- Rechazos estructurales ---");
  expectError({ objective: "", items: [{ id: "t1", title: "x", acceptance: [{ kind: "typecheck" }] }] }, "plan_invalid", "objetivo vacío");
  expectError(
    { objective: "x".repeat(PLAN_FORMAT_LIMITS.maxObjectiveChars + 1), items: [{ id: "t1", title: "x", acceptance: [{ kind: "typecheck" }] }] },
    "plan_too_large",
    "objetivo demasiado largo",
  );
  expectError({ objective: "x", items: [] }, "plan_invalid", "sin items");
  expectError(
    {
      objective: "x",
      items: [
        { id: "t1", title: "a", acceptance: [{ kind: "typecheck" }] },
        { id: "t2", title: "b" },
        { id: "t3", title: "c" },
      ],
    },
    "plan_too_large",
    "demasiados items",
    withLimits({ maxPlanItems: 2 }),
  );
  expectError(
    {
      objective: "x",
      items: [
        { id: "t1", title: "a", acceptance: [{ kind: "typecheck" }] },
        { id: "t1", title: "b" },
      ],
    },
    "plan_invalid",
    "id duplicado",
  );
  expectError(
    { objective: "x", items: [{ id: "a b", title: "a", acceptance: [{ kind: "typecheck" }] }] },
    "plan_invalid",
    "id inválido",
  );
  expectError(
    { objective: "x", items: [{ id: "t1", title: "", acceptance: [{ kind: "typecheck" }] }] },
    "plan_invalid",
    "título vacío",
  );
  expectError(
    { objective: "x", items: [{ id: "t1", title: "título largo", acceptance: [{ kind: "typecheck" }] }] },
    "plan_too_large",
    "título demasiado largo",
    withLimits({ maxPlanItemTitleChars: 5 }),
  );
  expectError(
    { objective: "x", items: [{ id: "t1", title: "a", description: "desc larga", acceptance: [{ kind: "typecheck" }] }] },
    "plan_too_large",
    "descripción demasiado larga",
    withLimits({ maxPlanItemDescriptionChars: 3 }),
  );
  expectError(
    { objective: "x", items: [{ id: "t1", title: "a", dependsOn: "t2", acceptance: [{ kind: "typecheck" }] }] },
    "plan_invalid",
    "dependsOn no es array",
  );
  expectError(
    { objective: "x", items: [{ id: "t1", title: "a", acceptance: "typecheck" }] },
    "plan_invalid",
    "acceptance no es array",
  );
  expectError(
    { objective: "x", items: [{ id: "t1", title: "a", paths: "src/a.ts", acceptance: [{ kind: "typecheck" }] }] },
    "plan_invalid",
    "paths no es array",
  );

  console.log("\n--- Dependencias, ciclos y profundidad ---");
  expectError(
    {
      objective: "x",
      items: [
        { id: "t1", title: "a", acceptance: [{ kind: "typecheck" }] },
        { id: "t2", title: "b", dependsOn: ["t3"] },
      ],
    },
    "plan_item_unknown",
    "dependencia inexistente",
  );
  expectError(
    { objective: "x", items: [{ id: "t1", title: "a", dependsOn: ["t1"], acceptance: [{ kind: "typecheck" }] }] },
    "plan_cycle",
    "autodependencia",
  );
  expectError(
    {
      objective: "x",
      items: [
        { id: "t1", title: "a", dependsOn: ["t2"], acceptance: [{ kind: "typecheck" }] },
        { id: "t2", title: "b", dependsOn: ["t1"] },
      ],
    },
    "plan_cycle",
    "ciclo de dos items",
  );
  expectError(
    {
      objective: "x",
      items: [
        { id: "t1", title: "a", acceptance: [{ kind: "typecheck" }] },
        { id: "t2", title: "b", dependsOn: ["t1"] },
        { id: "t3", title: "c", dependsOn: ["t2"] },
      ],
    },
    "plan_too_large",
    "profundidad 3 > 2",
  );

  console.log("\n--- Rutas seguras ---");
  for (const [label, path] of [
    ["absoluta POSIX", "/etc/passwd"],
    ["absoluta Windows", "C:\\Windows\\win.ini"],
    ["UNC", "\\\\server\\share\\file"],
    ["traversal", "../secreto.txt"],
    ["URL", "https://example.com/x"],
    [".env", ".env"],
    [".ssh", ".ssh/id_rsa"],
    [".git", ".git/config"],
  ] as const) {
    expectError(
      { objective: "x", items: [{ id: "t1", title: "a", paths: [path], acceptance: [{ kind: "typecheck" }] }] },
      "plan_invalid",
      `ruta rechazada: ${label}`,
    );
  }
  expectError(
    {
      objective: "x",
      items: [
        {
          id: "t1",
          title: "a",
          paths: Array.from({ length: PLAN_FORMAT_LIMITS.maxPathsPerItem + 1 }, (_, index) => `src/f${index}.ts`),
          acceptance: [{ kind: "typecheck" }],
        },
      ],
    },
    "plan_too_large",
    "demasiados paths",
  );

  console.log("\n--- Acceptance ---");
  expectError(
    { objective: "x", items: [{ id: "t1", title: "a", acceptance: [{ kind: "deploy" }] }] },
    "plan_invalid",
    "tipo de acceptance desconocido",
  );
  expectError(
    { objective: "x", items: [{ id: "t1", title: "a", acceptance: [{ kind: "script", name: "deploy" }] }] },
    "plan_invalid",
    "script no permitido",
  );
  expectError(
    { objective: "x", items: [{ id: "t1", title: "a", acceptance: [{ kind: "file_hash", path: "src/a.ts", sha256: "abc" }] }] },
    "plan_invalid",
    "hash inválido en acceptance",
  );
  expectError(
    { objective: "x", items: [{ id: "t1", title: "a", acceptance: [{ kind: "manual", description: "" }] }] },
    "plan_invalid",
    "manual sin descripción",
  );
  expectError(
    {
      objective: "x",
      items: [
        {
          id: "t1",
          title: "a",
          acceptance: [{ kind: "typecheck" }, { kind: "script", name: "test" }],
        },
      ],
    },
    "plan_too_large",
    "demasiados acceptance",
    withLimits({ maxAcceptancePerItem: 1 }),
  );
  expectError(
    {
      objective: "x",
      constraints: ["a", "b"],
      items: [{ id: "t1", title: "a", acceptance: [{ kind: "typecheck" }] }],
    },
    "plan_too_large",
    "demasiadas constraints",
    withLimits({ maxConstraints: 1 }),
  );
  expectError(
    {
      objective: "x",
      constraints: [1],
      items: [{ id: "t1", title: "a", acceptance: [{ kind: "typecheck" }] }],
    },
    "plan_invalid",
    "constraint no string",
  );

  console.log("\n--- Fallback ---");
  const fallback = buildFallbackPlan("Implementar algo");
  checkEq(fallback.items.length, 1, "fallback de un item");
  checkEq(fallback.items[0].logicalId, "t1", "fallback usa t1");
  checkEq(fallback.items[0].acceptance[0].kind, "manual", "fallback tiene acceptance manual");
  check(/^[a-f0-9]{64}$/.test(fallback.hash), "fallback tiene hash");
  const fallbackLong = buildFallbackPlan("x".repeat(PLAN_FORMAT_LIMITS.maxObjectiveChars + 100), withLimits({ maxPlanItemTitleChars: 10 }), "motivo");
  check(fallbackLong.objective.length <= PLAN_FORMAT_LIMITS.maxObjectiveChars, "fallback recorta el objetivo");
  check(fallbackLong.items[0].title.length <= 10, "fallback recorta el título");
  const fallbackEmpty = buildFallbackPlan("", baseLimits, "sin plan");
  check(fallbackEmpty.objective.length > 0, "fallback con objetivo vacío usa un texto por defecto");

  console.log("\n--- Transiciones de item ---");
  const validTransitions: Array<[PlanItemStatus, PlanItemStatus]> = [
    ["PENDING", "IN_PROGRESS"],
    ["PENDING", "BLOCKED"],
    ["PENDING", "FAILED"],
    ["PENDING", "SKIPPED"],
    ["IN_PROGRESS", "DONE"],
    ["IN_PROGRESS", "BLOCKED"],
    ["IN_PROGRESS", "FAILED"],
    ["IN_PROGRESS", "SKIPPED"],
    ["IN_PROGRESS", "PENDING"],
    ["BLOCKED", "IN_PROGRESS"],
    ["BLOCKED", "PENDING"],
    ["FAILED", "PENDING"],
    ["SKIPPED", "PENDING"],
    ["DONE", "PENDING"],
  ];
  for (const [from, to] of validTransitions) {
    check(canTransitionPlanItem(from, to), `${from} → ${to} permitida`);
    let threw = false;
    try {
      assertPlanItemTransition(from, to);
    } catch {
      threw = true;
    }
    check(!threw, `${from} → ${to} no lanza`);
  }
  const invalidTransitions: Array<[PlanItemStatus, PlanItemStatus]> = [
    ["PENDING", "DONE"],
    ["PENDING", "PENDING"],
    ["DONE", "IN_PROGRESS"],
    ["DONE", "DONE"],
    ["SKIPPED", "DONE"],
    ["BLOCKED", "DONE"],
  ];
  for (const [from, to] of invalidTransitions) {
    check(!canTransitionPlanItem(from, to), `${from} → ${to} rechazada`);
    let threw = false;
    try {
      assertPlanItemTransition(from, to);
    } catch {
      threw = true;
    }
    check(threw, `${from} → ${to} lanza`);
  }
  for (const status of PLAN_ITEM_STATUSES) {
    check(isPlanItemStatus(status), `isPlanItemStatus(${status})`);
  }
  check(!isPlanItemStatus("PENDING "), "isPlanItemStatus rechaza strings raros");

  console.log("\n--- Evidencia ---");
  const evidence = normalizePlanEvidence([
    { kind: "tool_result", toolCallId: "call-1" },
    { kind: "file", path: "src/a.ts", sha256: "a".repeat(64) },
    { kind: "command", name: "test", exitCode: 0 },
    { kind: "manual", description: "revisado a ojo" },
  ]);
  check(evidence.ok, "evidencia válida");
  if (evidence.ok) checkEq(evidence.evidence.length, 4, "cuatro evidencias");
  const deduped = normalizePlanEvidence([
    { kind: "tool_result", toolCallId: "call-1" },
    { kind: "tool_result", toolCallId: "call-1" },
  ]);
  check(deduped.ok, "evidencia duplicada se acepta");
  if (deduped.ok) checkEq(deduped.evidence.length, 1, "evidencia duplicada se deduplica");
  const manualEvidence = normalizePlanEvidence([{ kind: "manual", description: "ok" }]);
  check(manualEvidence.ok, "evidencia manual sola se acepta");
  if (manualEvidence.ok) checkEq(manualEvidence.warnings, ["manual_evidence_unverified"], "warning de evidencia manual");

  for (const [label, raw] of [
    ["toolCallId vacío", [{ kind: "tool_result", toolCallId: "" }]],
    ["path absoluto", [{ kind: "file", path: "/etc/passwd", sha256: "a".repeat(64) }]],
    ["sha inválido", [{ kind: "file", path: "src/a.ts", sha256: "abc" }]],
    ["comando inválido", [{ kind: "command", name: "deploy", exitCode: 0 }]],
    ["exitCode decimal", [{ kind: "command", name: "test", exitCode: 1.5 }]],
    ["manual vacío", [{ kind: "manual", description: "" }]],
    ["tipo desconocido", [{ kind: "otro" }]],
  ] as const) {
    const result = normalizePlanEvidence(raw);
    check(!result.ok, `evidencia rechazada: ${label}`);
    if (!result.ok) check(result.errors.some((error) => error.code === "evidence_invalid"), `código evidence_invalid: ${label}`);
  }
  const tooManyEvidence = normalizePlanEvidence(
    [
      { kind: "tool_result", toolCallId: "a" },
      { kind: "tool_result", toolCallId: "b" },
    ],
    withLimits({ maxEvidencePerItem: 1 }),
  );
  check(!tooManyEvidence.ok, "demasiadas evidencias se rechazan");
  checkEq(normalizePlanEvidence(undefined), { ok: true, evidence: [], warnings: [] }, "evidencia undefined → vacía");

  console.log("\n--- Reason ---");
  checkEq(normalizePlanReason(undefined, false), { ok: true, reason: null }, "reason opcional ausente");
  check(!normalizePlanReason(undefined, true).ok, "reason requerido ausente");
  checkEq(normalizePlanReason("  motivo  ", true), { ok: true, reason: "motivo" }, "reason recortado");
  check(!normalizePlanReason("   ", true).ok, "reason vacío rechazado");
  check(!normalizePlanReason("x".repeat(PLAN_FORMAT_LIMITS.maxReasonChars + 1), true).ok, "reason demasiado largo");
  check(!normalizePlanReason(1, false).ok, "reason no string rechazado");

  console.log("\n--- Helpers de criterio ---");
  checkEq(describeCriterion({ kind: "typecheck" }), "typecheck", "describe typecheck");
  checkEq(describeCriterion({ kind: "script", name: "test" }), "script:test", "describe script");
  checkEq(describeCriterion({ kind: "file_exists", path: "src/a.ts" }), "file_exists:src/a.ts", "describe file_exists");
  checkEq(describeCriterion({ kind: "file_hash", path: "src/a.ts", sha256: "a".repeat(64) }), "file_hash:src/a.ts", "describe file_hash");
  checkEq(describeCriterion({ kind: "manual", description: "x" }), "manual", "describe manual");
  check(isMachineCheckable({ kind: "typecheck" }), "typecheck es machine-checkable");
  check(!isMachineCheckable({ kind: "manual", description: "x" }), "manual no es machine-checkable");
  check(isManualCriterion({ kind: "manual", description: "x" }), "isManualCriterion manual");
  check(isPlanStatus("ACTIVE"), "isPlanStatus ACTIVE");
  check(!isPlanStatus("active"), "isPlanStatus es case-sensitive");
  check(isPlanSource("fallback"), "isPlanSource fallback");
  check(!isPlanSource("otro"), "isPlanSource rechaza desconocido");

  console.log(`\n${total - failed}/${total} casos OK.`);
  if (failed > 0) process.exit(1);
}

main();
