/**
 * Fase 9A — tests puros del contrato del Autonomous Loop.
 *
 * Sin DB, sin filesystem, sin modelo. Verifica estados, transiciones,
 * límites, normalización y mapeo a `CodingTask`.
 */
import {
  AUTONOMY_CONTRACT_VERSION,
  AUTONOMY_ERROR_CODES,
  AUTONOMY_LIMIT_BOUNDS,
  AUTONOMY_MAX_COST_USD,
  AUTONOMY_STATE_TRANSITIONS,
  AUTONOMY_STATES,
  AUTONOMY_STOP_REASONS,
  AUTONOMY_TERMINAL_STATES,
  DEFAULT_AUTONOMY_LIMITS,
  InvalidAutonomyOutcomeError,
  InvalidAutonomyTransitionError,
  assertAutonomyTransition,
  canTransitionAutonomyState,
  isTerminalAutonomyState,
  normalizeAutonomyLimits,
  resolveTaskOutcome,
  type AutonomyState,
  type AutonomyTerminalState,
} from "./contract";

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
  check(JSON.stringify(actual) === JSON.stringify(expected), message, () => ({ esperado: expected, actual, ...(detail ? { detalle: detail() } : {}) }));
}

function main(): void {
  console.log("== Fase 9A — contrato del Autonomous Loop ==\n");

  console.log("--- Versión y estados ---");
  checkEq(AUTONOMY_CONTRACT_VERSION, 1, "versión del contrato");
  checkEq(AUTONOMY_STATES.length, 11, "11 estados internos");
  checkEq(new Set(AUTONOMY_STATES).size, AUTONOMY_STATES.length, "estados únicos");
  checkEq(AUTONOMY_TERMINAL_STATES.length, 6, "6 estados terminales");
  check(
    AUTONOMY_TERMINAL_STATES.every((state) => AUTONOMY_STATES.includes(state)),
    "todo terminal es un estado válido",
  );
  for (const state of AUTONOMY_STATES) {
    checkEq(
      isTerminalAutonomyState(state),
      (AUTONOMY_TERMINAL_STATES as readonly AutonomyState[]).includes(state),
      `isTerminal(${state})`,
    );
  }

  console.log("\n--- Tabla cerrada de transiciones ---");
  checkEq(Object.keys(AUTONOMY_STATE_TRANSITIONS).length, AUTONOMY_STATES.length, "la tabla cubre todos los estados");
  check(Object.isFrozen(AUTONOMY_STATE_TRANSITIONS), "la tabla está congelada");
  for (const state of AUTONOMY_STATES) {
    const targets = AUTONOMY_STATE_TRANSITIONS[state];
    check(Object.isFrozen(targets), `transiciones de ${state} congeladas`);
    check(
      targets.every((target) => AUTONOMY_STATES.includes(target)),
      `todos los destinos de ${state} son estados válidos`,
      () => targets,
    );
    check(
      new Set(targets).size === targets.length,
      `sin destinos duplicados desde ${state}`,
      () => targets,
    );
    if (isTerminalAutonomyState(state)) {
      checkEq(targets.length, 0, `el terminal ${state} no tiene salida`);
    } else {
      check(targets.length > 0, `el estado no terminal ${state} tiene al menos una salida`);
    }
  }

  const validPairs: Array<[AutonomyState, AutonomyState]> = [
    ["PLANNING", "EXECUTING"],
    ["EXECUTING", "VERIFYING"],
    ["EXECUTING", "REPLANNING"],
    ["VERIFYING", "DONE"],
    ["VERIFYING", "REPLANNING"],
    ["REPLANNING", "EXECUTING"],
    ["RESUMING", "EXECUTING"],
    ["EXECUTING", "CANCELLED"],
  ];
  for (const [from, to] of validPairs) {
    check(canTransitionAutonomyState(from, to), `${from} → ${to} permitida`);
    let threw = false;
    try {
      assertAutonomyTransition(from, to);
    } catch {
      threw = true;
    }
    check(!threw, `${from} → ${to} no lanza`);
  }

  const invalidPairs: Array<[AutonomyState, AutonomyState]> = [
    ["PLANNING", "VERIFYING"],
    ["PLANNING", "DONE"],
    ["EXECUTING", "PLANNING"],
    ["VERIFYING", "EXECUTING"],
    ["REPLANNING", "VERIFYING"],
    ["RESUMING", "PLANNING"],
    ["DONE", "EXECUTING"],
    ["BLOCKED", "EXECUTING"],
    ["STALLED", "EXECUTING"],
    ["BUDGET_EXHAUSTED", "EXECUTING"],
    ["FAILED", "EXECUTING"],
    ["CANCELLED", "EXECUTING"],
  ];
  for (const [from, to] of invalidPairs) {
    check(!canTransitionAutonomyState(from, to), `${from} → ${to} rechazada`);
    let error: unknown;
    try {
      assertAutonomyTransition(from, to);
    } catch (caught) {
      error = caught;
    }
    check(error instanceof InvalidAutonomyTransitionError, `${from} → ${to} lanza el error tipado`, () => error);
    if (error instanceof InvalidAutonomyTransitionError) {
      checkEq([error.from, error.to], [from, to], `el error conserva from/to de ${from} → ${to}`);
      check(error.message.includes(from) && error.message.includes(to), "el mensaje nombra ambos estados", () => error.message);
    }
  }

  console.log("\n--- Límites por defecto y normalización ---");
  check(Object.isFrozen(DEFAULT_AUTONOMY_LIMITS), "defaults congelados");
  checkEq(DEFAULT_AUTONOMY_LIMITS.maxSteps, 40, "maxSteps default");
  checkEq(DEFAULT_AUTONOMY_LIMITS.maxStepsPerPhase, 20, "maxStepsPerPhase default");
  checkEq(DEFAULT_AUTONOMY_LIMITS.maxWallTimeMs, 900_000, "maxWallTimeMs default");
  checkEq(DEFAULT_AUTONOMY_LIMITS.maxCostUsd, null, "sin pricing conocido no se inventa costo");
  check(DEFAULT_AUTONOMY_LIMITS.maxStepsPerPhase <= DEFAULT_AUTONOMY_LIMITS.maxSteps, "la fase no supera la corrida");
  check(DEFAULT_AUTONOMY_LIMITS.maxInputTokens <= DEFAULT_AUTONOMY_LIMITS.maxTokens, "input no supera el total");
  check(DEFAULT_AUTONOMY_LIMITS.maxOutputTokens <= DEFAULT_AUTONOMY_LIMITS.maxTokens, "output no supera el total");

  const numericKeys = (Object.keys(DEFAULT_AUTONOMY_LIMITS) as Array<keyof typeof DEFAULT_AUTONOMY_LIMITS>).filter(
    (key) => key !== "maxCostUsd",
  );
  checkEq(numericKeys.length, Object.keys(AUTONOMY_LIMIT_BOUNDS).length, "bounds cubre todos los límites numéricos");
  for (const key of numericKeys) {
    const limitBounds = AUTONOMY_LIMIT_BOUNDS[key];
    check(limitBounds.min <= limitBounds.max, `${key}: min <= max`);
    const value = DEFAULT_AUTONOMY_LIMITS[key] as number;
    check(
      value >= limitBounds.min && value <= limitBounds.max,
      `${key}: default dentro de bounds`,
      () => ({ value, ...limitBounds }),
    );
  }

  checkEq(normalizeAutonomyLimits(), DEFAULT_AUTONOMY_LIMITS, "normalizar vacío devuelve los defaults");
  checkEq(normalizeAutonomyLimits({ maxSteps: 10, maxStepsPerPhase: 50 }), {
    ...DEFAULT_AUTONOMY_LIMITS,
    maxSteps: 10,
    maxStepsPerPhase: 10,
  }, "maxStepsPerPhase se acota a maxSteps");
  checkEq(normalizeAutonomyLimits({ maxSteps: 12.6 }).maxSteps, 13, "los enteros se redondean");
  checkEq(normalizeAutonomyLimits({ maxSteps: Number.NaN }).maxSteps, DEFAULT_AUTONOMY_LIMITS.maxSteps, "NaN cae al default");
  checkEq(
    normalizeAutonomyLimits({ maxWallTimeMs: Number.POSITIVE_INFINITY }).maxWallTimeMs,
    DEFAULT_AUTONOMY_LIMITS.maxWallTimeMs,
    "Infinity cae al default",
  );
  checkEq(normalizeAutonomyLimits({ maxReplans: -1 }).maxReplans, 0, "un límite negativo se recorta al mínimo");
  checkEq(normalizeAutonomyLimits({ maxPlanItems: 0 }).maxPlanItems, 1, "maxPlanItems mínimo 1");
  checkEq(normalizeAutonomyLimits({ maxSteps: 9_999 }).maxSteps, 200, "maxSteps se recorta al máximo duro");
  checkEq(normalizeAutonomyLimits({ maxCostUsd: -1 }).maxCostUsd, null, "costo negativo → null");
  checkEq(normalizeAutonomyLimits({ maxCostUsd: Number.NaN }).maxCostUsd, null, "costo NaN → null");
  checkEq(normalizeAutonomyLimits({ maxCostUsd: 2_000_000 }).maxCostUsd, AUTONOMY_MAX_COST_USD, "costo se recorta al máximo");
  checkEq(normalizeAutonomyLimits({ maxCostUsd: 12.5 }).maxCostUsd, 12.5, "costo decimal se conserva");
  checkEq(
    normalizeAutonomyLimits({ maxTokens: 1_000, maxInputTokens: 5_000, maxOutputTokens: 5_000 }),
    { ...DEFAULT_AUTONOMY_LIMITS, maxTokens: 1_000, maxInputTokens: 1_000, maxOutputTokens: 1_000 },
    "input/output se acotan al total de tokens",
  );

  const partial = { maxSteps: 10 };
  const normalized = normalizeAutonomyLimits(partial);
  checkEq(partial, { maxSteps: 10 }, "no muta el objeto de entrada");
  check(Object.isFrozen(normalized), "el resultado está congelado");
  const before = normalized.maxSteps;
  try {
    (normalized as unknown as { maxSteps: number }).maxSteps = 1;
  } catch {
    // En strict mode, asignar a una propiedad congelada lanza.
  }
  checkEq(normalized.maxSteps, before, "no se puede mutar el resultado");
  checkEq(
    JSON.stringify(normalizeAutonomyLimits({ maxSteps: 10 })),
    JSON.stringify(normalizeAutonomyLimits({ maxSteps: 10 })),
    "normalización determinista",
  );
  const withUnknown = { ...DEFAULT_AUTONOMY_LIMITS, foo: 1 } as unknown as Partial<typeof DEFAULT_AUTONOMY_LIMITS>;
  check(!("foo" in normalizeAutonomyLimits(withUnknown)), "claves desconocidas se ignoran");

  console.log("\n--- Códigos y razones ---");
  checkEq(new Set(AUTONOMY_ERROR_CODES).size, AUTONOMY_ERROR_CODES.length, "códigos de error únicos");
  checkEq(new Set(AUTONOMY_STOP_REASONS).size, AUTONOMY_STOP_REASONS.length, "razones de parada únicas");
  for (const code of ["plan_invalid", "workspace_drift", "no_progress", "budget_tokens", "cancelled"] as const) {
    check(AUTONOMY_ERROR_CODES.includes(code), `incluye el código ${code}`);
  }
  for (const reason of ["completed", "stalled", "budget_exhausted", "resume_exhausted"] as const) {
    check(AUTONOMY_STOP_REASONS.includes(reason), `incluye la razón ${reason}`);
  }

  console.log("\n--- Mapeo a la task ---");
  const outcomes: Array<{
    state: AutonomyTerminalState;
    proposals: boolean;
    stopReason?: (typeof AUTONOMY_STOP_REASONS)[number];
    expected: { status: string; stopReason: string };
  }> = [
    { state: "DONE", proposals: true, expected: { status: "READY_FOR_REVIEW", stopReason: "completed" } },
    { state: "DONE", proposals: false, expected: { status: "NO_CHANGES", stopReason: "completed" } },
    { state: "BLOCKED", proposals: true, expected: { status: "READY_FOR_REVIEW", stopReason: "blocked" } },
    { state: "BLOCKED", proposals: false, expected: { status: "FAILED", stopReason: "blocked" } },
    { state: "STALLED", proposals: true, expected: { status: "READY_FOR_REVIEW", stopReason: "stalled" } },
    { state: "STALLED", proposals: false, expected: { status: "FAILED", stopReason: "stalled" } },
    { state: "BUDGET_EXHAUSTED", proposals: true, expected: { status: "READY_FOR_REVIEW", stopReason: "budget_exhausted" } },
    { state: "BUDGET_EXHAUSTED", proposals: false, expected: { status: "FAILED", stopReason: "budget_exhausted" } },
    { state: "FAILED", proposals: true, stopReason: "timeout", expected: { status: "FAILED", stopReason: "timeout" } },
    { state: "FAILED", proposals: false, stopReason: "provider_error", expected: { status: "FAILED", stopReason: "provider_error" } },
    { state: "FAILED", proposals: false, expected: { status: "FAILED", stopReason: "error" } },
    { state: "CANCELLED", proposals: true, expected: { status: "CANCELLED", stopReason: "cancelled" } },
  ];
  for (const item of outcomes) {
    const outcome = resolveTaskOutcome(item.state, item.proposals, item.stopReason);
    checkEq(outcome, item.expected, `${item.state} con proposals=${item.proposals}${item.stopReason ? ` y reason=${item.stopReason}` : ""}`);
  }
  let outcomeError: unknown;
  try {
    resolveTaskOutcome("EXECUTING" as AutonomyTerminalState, true);
  } catch (caught) {
    outcomeError = caught;
  }
  check(outcomeError instanceof InvalidAutonomyOutcomeError, "un estado no terminal no se puede finalizar", () => outcomeError);
  if (outcomeError instanceof InvalidAutonomyOutcomeError) {
    checkEq(outcomeError.state, "EXECUTING", "el error conserva el estado inválido");
  }

  console.log(`\n${total - failed}/${total} casos OK.`);
  if (failed > 0) process.exit(1);
}

main();
