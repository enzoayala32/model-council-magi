/**
 * Fase 9D — tests del detector de no-progreso.
 *
 * Módulo puro: secuencias sintéticas, sin DB, sin red, sin modelo y sin
 * filesystem. Cubre cada detector en el umbral exacto y uno menos, la
 * escalada warning → stalled, los resets por progreso real, el falso
 * positivo de relectura tras cambio de archivo, determinismo y redacción
 * de errores (paths/números/secretos).
 *
 * Uso: npm run agent:test-autonomy-progress
 */
import {
  PLAN_STALL_THRESHOLD,
  canonicalProgressJson,
  createProgressTracker,
  hashProgressAction,
  hashProgressError,
  hashProgressResult,
  normalizeProgressError,
  type ProgressAction,
  type ProgressLimits,
  type ProgressObservation,
  type ProgressVerdict,
} from "./progress";

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

const LIMITS: ProgressLimits = {
  maxIdenticalActions: 3,
  maxSameError: 3,
  maxIdenticalDiffs: 2,
  maxOscillations: 2,
  maxNoProgressSteps: 8,
};

function tracker(overrides: Partial<ProgressLimits> = {}) {
  return createProgressTracker({ ...LIMITS, ...overrides });
}

function obs(overrides: Partial<ProgressObservation> = {}): ProgressObservation {
  return {
    stepIndex: 0,
    actions: [],
    workspaceHash: null,
    diffHash: null,
    ledgerChanged: false,
    doneItem: false,
    planHash: "plan-a",
    planChanged: false,
    ...overrides,
  };
}

function action(toolName: string, input: unknown, outputHash = "out-1", error?: string): ProgressAction {
  return {
    toolName,
    actionHash: hashProgressAction(toolName, input),
    resultHash: hashProgressResult(toolName, !error, error ? "E_TEST" : null, outputHash),
    ok: !error,
    errorHash: error ? hashProgressError(toolName, error) : null,
  };
}

function verdictLevel(verdict: ProgressVerdict): string {
  return verdict.level;
}

function detectorOf(verdict: ProgressVerdict): string | null {
  return verdict.level === "ok" ? null : verdict.detector;
}

async function main(): Promise<void> {
  console.log("== Fase 9D — detección de no-progreso ==\n");

  const { registerSecret } = await import("../../provider-resilience/redact");
  registerSecret("SECRETO_9D_NO_DEBE_SALIR");

  // -----------------------------------------------------------------------
  console.log("--- Fingerprints ---");
  {
    checkEq(
      canonicalProgressJson({ b: 2, a: 1, nested: { z: 1, y: [3, 2, 1] } }),
      canonicalProgressJson({ nested: { y: [3, 2, 1], z: 1 }, a: 1, b: 2 }),
      "el JSON canónico no depende del orden de claves",
    );
    checkEq(canonicalProgressJson(undefined), "null", "undefined se canonicaliza como null");
    checkEq(canonicalProgressJson([1, "x", null]), '[1,"x",null]', "los arrays conservan su orden");

    checkEq(
      hashProgressAction("read_file", { path: "a.ts", range: { start: 1, end: 2 } }),
      hashProgressAction("read_file", { range: { end: 2, start: 1 }, path: "a.ts" }),
      "la misma acción con distinto orden de claves produce el mismo hash",
    );
    check(
      hashProgressAction("read_file", { path: "a.ts" }) !== hashProgressAction("read_file", { path: "b.ts" }),
      "acciones distintas producen hashes distintos",
    );
    check(
      hashProgressResult("read_file", true, null, "hash-a") !== hashProgressResult("read_file", true, null, "hash-b"),
      "resultados distintos producen hashes distintos",
    );
    check(
      hashProgressResult("read_file", true, null, "x") !== hashProgressResult("read_file", false, "E", "x"),
      "ok=false cambia el hash del resultado",
    );
    check(
      hashProgressResult("run_script", false, "timeout", "x") !== hashProgressResult("run_script", false, "exit", "x"),
      "el error code cambia el hash del resultado",
    );
    checkEq(
      hashProgressError("run_typecheck", "Error en lib/a.ts(10,5): TS2322"),
      hashProgressError("run_typecheck", "Error en lib/a.ts(99,2): TS9999"),
      "el mismo error con otros números produce el mismo hash",
    );
    check(
      hashProgressError("run_typecheck", "Error en lib/a.ts(10,5)") !== hashProgressError("run_typecheck", "Error en lib/b.ts(10,5)"),
      "errores en archivos distintos producen hashes distintos",
    );
  }

  // -----------------------------------------------------------------------
  console.log("\n--- Normalización de errores ---");
  {
    const normalized = normalizeProgressError(
      "Falló C:\\Users\\Admin\\proyecto\\src\\a.ts en la línea 42 y en /home/user/proyecto/src/b.ts:99 con SECRETO_9D_NO_DEBE_SALIR",
      { workspaceRoot: "C:\\Users\\Admin\\proyecto" },
    );
    check(!normalized.includes("C:\\Users\\Admin"), "borra la ruta absoluta de Windows");
    check(!normalized.includes("/home/user"), "borra la ruta absoluta POSIX");
    check(!normalized.includes("42") && !normalized.includes("99"), "reemplaza números por <n>");
    check(!normalized.includes("SECRETO_9D_NO_DEBE_SALIR"), "redacta secretos registrados");
    check(normalized.includes("<workspace>"), "conserva el marcador <workspace>");
    check(normalized.includes("<path>"), "conserva el marcador <path>");
    checkEq(normalized.includes("\n"), false, "colapsa saltos de línea");

    checkEq(
      normalizeProgressError("Error en C:\\repo\\src\\a.ts:10"),
      "Error en <path>",
      "una ruta Windows suelta también se borra",
    );
    checkEq(
      normalizeProgressError("no se pudo abrir /var/tmp/x"),
      "no se pudo abrir <path>",
      "una ruta POSIX suelta también se borra",
    );
    checkEq(
      normalizeProgressError("ver https://example.com/api/v1"),
      "ver https://example.com/api/v<n>",
      "no confunde una URL con una ruta absoluta",
    );
    checkEq(normalizeProgressError("x".repeat(600)).length, 500, "recorta a 500 caracteres por defecto");
    checkEq(normalizeProgressError("x".repeat(600), { maxChars: 10 }).length, 10, "respeta maxChars explícito");
    checkEq(normalizeProgressError("  mucho   espacio  "), "mucho espacio", "colapsa espacios");
  }

  // -----------------------------------------------------------------------
  console.log("\n--- repeated_action: umbral exacto y escalada ---");
  {
    const t = tracker();
    const a = action("list_files", { subPath: "." });
    checkEq(verdictLevel(t.observe(obs({ actions: [a] }))), "ok", "1ª acción idéntica: ok");
    checkEq(verdictLevel(t.observe(obs({ actions: [a] }))), "ok", "2ª acción idéntica: ok (umbral 3)");
    const warning = t.observe(obs({ actions: [a] }));
    checkEq(verdictLevel(warning), "warning", "3ª acción idéntica: warning");
    checkEq(detectorOf(warning), "repeated_action", "el warning es de repeated_action");
    checkEq(warning.level === "warning" ? warning.count : null, 3, "el warning reporta count 3");
    const stalled = t.observe(obs({ actions: [a] }));
    checkEq(verdictLevel(stalled), "stalled", "4ª acción idéntica: stalled");
    checkEq(detectorOf(stalled), "repeated_action", "el stall es de repeated_action");

    const t2 = tracker();
    for (let index = 0; index < 3; index += 1) {
      checkEq(
        verdictLevel(t2.observe(obs({ actions: [action("read_file", { path: "a.ts" }, `out-${index}`)] }))),
        "ok",
        `misma acción con resultado distinto (${index + 1}): no cuenta como repetida`,
      );
    }

    const t3 = tracker();
    t3.observe(obs({ actions: [a] }));
    t3.observe(obs({ actions: [a] }));
    t3.observe(obs({ workspaceHash: "w-progress" }));
    t3.observe(obs({ actions: [a] }));
    t3.observe(obs({ actions: [a] }));
    checkEq(verdictLevel(t3.observe(obs({ actions: [a] }))), "warning", "tras progreso real, el contador se reinicia y vuelve a avisar en 3");
  }

  // -----------------------------------------------------------------------
  console.log("\n--- repeated_error: normalización y escalada ---");
  {
    const t = tracker();
    const e1 = action("run_typecheck", {}, "out", "Error en lib/a.ts(10,5): TS2322");
    const e2 = action("run_typecheck", {}, "out", "Error en lib/a.ts(99,2): TS9999");
    checkEq(verdictLevel(t.observe(obs({ actions: [e1] }))), "ok", "1er error: ok");
    checkEq(verdictLevel(t.observe(obs({ actions: [e2] }))), "ok", "2º error equivalente: ok");
    const warning = t.observe(obs({ actions: [e2] }));
    checkEq(verdictLevel(warning), "warning", "3er error equivalente: warning");
    checkEq(detectorOf(warning), "repeated_error", "el warning es de repeated_error");
    checkEq(verdictLevel(t.observe(obs({ actions: [e1] }))), "stalled", "4º error equivalente: stalled");

    const t2 = tracker();
    t2.observe(obs({ actions: [action("run_typecheck", {}, "out", "Error A")] }));
    t2.observe(obs({ actions: [action("run_typecheck", {}, "out", "Error B")] }));
    checkEq(verdictLevel(t2.observe(obs({ actions: [action("run_typecheck", {}, "out", "Error C")] }))), "ok", "errores distintos no disparan");
  }

  // -----------------------------------------------------------------------
  console.log("\n--- identical_diff: umbral, reset por DONE ---");
  {
    const t = tracker();
    const d1 = obs({ workspaceHash: "w-d1", diffHash: "d1" });
    checkEq(verdictLevel(t.observe(d1)), "ok", "1er diff: ok");
    const warning = t.observe(d1);
    checkEq(verdictLevel(warning), "warning", "2º diff idéntico: warning (umbral 2)");
    checkEq(detectorOf(warning), "identical_diff", "el warning es de identical_diff");
    checkEq(verdictLevel(t.observe(d1)), "stalled", "3er diff idéntico: stalled");

    const t2 = tracker();
    t2.observe(obs({ workspaceHash: "w-d1", diffHash: "d1" }));
    t2.observe(obs({ workspaceHash: "w-d2", diffHash: "d2" }));
    checkEq(verdictLevel(t2.observe(obs({ workspaceHash: "w-d3", diffHash: "d3" }))), "ok", "diffs distintos no disparan");

    const t3 = tracker();
    t3.observe(d1);
    t3.observe(d1); // warning
    t3.observe(obs({ workspaceHash: "w-done", diffHash: "d-done", ledgerChanged: true, doneItem: true }));
    checkEq(verdictLevel(t3.observe(d1)), "ok", "un DONE resetea el conteo de diffs");
    checkEq(verdictLevel(t3.observe(d1)), "warning", "tras el DONE vuelve a avisar, no a stallar");
  }

  // -----------------------------------------------------------------------
  console.log("\n--- oscillation: ciclos A→B→A ---");
  {
    const t = tracker({ maxIdenticalDiffs: 10, maxIdenticalActions: 10 });
    const seq = (hash: string) => obs({ workspaceHash: `w-${hash}`, diffHash: hash });
    checkEq(verdictLevel(t.observe(seq("A"))), "ok", "A: ok");
    checkEq(verdictLevel(t.observe(seq("B"))), "ok", "A→B: ok");
    checkEq(verdictLevel(t.observe(seq("A"))), "ok", "A→B→A (1 ciclo): ok");
    checkEq(verdictLevel(t.observe(seq("B"))), "ok", "A→B→A→B: ok");
    const warning = t.observe(seq("A"));
    checkEq(verdictLevel(warning), "warning", "A→B→A→B→A (2 ciclos): warning");
    checkEq(detectorOf(warning), "oscillation", "el warning es de oscillation");
    checkEq(verdictLevel(t.observe(seq("B"))), "ok", "un paso más de la misma oscilación no vuelve a disparar");
    checkEq(verdictLevel(t.observe(seq("A"))), "stalled", "3er ciclo: stalled");

    const t2 = tracker({ maxIdenticalDiffs: 10, maxIdenticalActions: 10 });
    const seq2 = (hash: string) => obs({ workspaceHash: `w-${hash}-${Math.random()}`, diffHash: hash });
    t2.observe(seq2("A"));
    t2.observe(seq2("A"));
    t2.observe(seq2("B"));
    t2.observe(seq2("B"));
    checkEq(verdictLevel(t2.observe(seq2("A"))), "ok", "A,A,B,B,A no es oscilación (duplicados consecutivos colapsados)");
  }

  // -----------------------------------------------------------------------
  console.log("\n--- no_progress: acciones distintas sin cambios ---");
  {
    const t = tracker();
    for (let index = 0; index < 7; index += 1) {
      checkEq(
        verdictLevel(t.observe(obs({ actions: [action("read_file", { path: `f-${index}.ts` }, `out-${index}`)] }))),
        "ok",
        `paso sin progreso ${index + 1}/7: ok`,
      );
    }
    const warning = t.observe(obs({ actions: [action("read_file", { path: "f-7.ts" }, "out-7")] }));
    checkEq(verdictLevel(warning), "warning", "8º paso sin progreso: warning");
    checkEq(detectorOf(warning), "no_progress", "el warning es de no_progress");
    checkEq(verdictLevel(t.observe(obs({ actions: [action("read_file", { path: "f-8.ts" }, "out-8")] }))), "stalled", "9º paso sin progreso: stalled");

    const t2 = tracker();
    for (let index = 0; index < 4; index += 1) {
      t2.observe(obs({ actions: [action("read_file", { path: `g-${index}.ts` }, `out-${index}`)] }));
    }
    t2.observe(obs({ workspaceHash: "w-progress" }));
    for (let index = 0; index < 7; index += 1) {
      checkEq(
        verdictLevel(t2.observe(obs({ actions: [action("read_file", { path: `h-${index}.ts` }, `out-${index}`)] }))),
        "ok",
        `tras progreso, paso ${index + 1}/7: ok`,
      );
    }
    checkEq(
      verdictLevel(t2.observe(obs({ actions: [action("read_file", { path: "h-7.ts" }, "out-7")] }))),
      "warning",
      "tras progreso, el 8º paso sin progreso vuelve a avisar",
    );
  }

  // -----------------------------------------------------------------------
  console.log("\n--- plan_stalled: replanificar al mismo plan ---");
  {
    const t = tracker();
    const planP = obs({ planHash: "P", planChanged: true });
    checkEq(verdictLevel(t.observe(planP)), "ok", "primer plan P: ok");
    const warning = t.observe(planP);
    checkEq(verdictLevel(warning), "warning", "segundo plan P sin avance: warning");
    checkEq(detectorOf(warning), "plan_stalled", "el warning es de plan_stalled");
    checkEq(PLAN_STALL_THRESHOLD, 2, "el umbral de plan_stalled es 2");
    checkEq(verdictLevel(t.observe(planP)), "stalled", "tercer plan P sin avance: stalled");

    const t2 = tracker();
    t2.observe(planP);
    t2.observe(planP); // warning
    t2.observe(obs({ ledgerChanged: true, planHash: "P" }));
    checkEq(verdictLevel(t2.observe(planP)), "ok", "un avance de ledger resetea plan_stalled");
    checkEq(verdictLevel(t2.observe(planP)), "warning", "tras el avance vuelve a avisar, no a stallar");

    const t3 = tracker();
    t3.observe(planP);
    t3.observe(planP); // warning
    checkEq(verdictLevel(t3.observe(obs({ planHash: "Q", planChanged: true }))), "ok", "un plan distinto resetea plan_stalled");
    checkEq(verdictLevel(t3.observe(obs({ planHash: "Q", planChanged: true }))), "warning", "el plan Q repetido avisa");
    checkEq(verdictLevel(t3.observe(obs({ planHash: "Q", planChanged: true }))), "stalled", "el plan Q repetido 3 veces stallea");
  }

  // -----------------------------------------------------------------------
  console.log("\n--- Prioridad y snapshot ---");
  {
    const t = tracker();
    const failing = action("run_script", { name: "test" }, "out", "el mismo error");
    const warning = t.observe(obs({ actions: [failing, failing, failing] }));
    checkEq(verdictLevel(warning), "warning", "tres acciones con el mismo error disparan un warning");
    checkEq(detectorOf(warning), "repeated_error", "repeated_error tiene prioridad sobre repeated_action");

    const snap = t.snapshot();
    checkEq(snap.maxActionCount, 3, "el snapshot reporta 3 acciones repetidas");
    checkEq(snap.maxErrorCount, 3, "el snapshot reporta 3 errores repetidos");
    checkEq(snap.warned, ["repeated_error"], "el snapshot lista el detector ya advertido");

    const t2 = tracker();
    t2.observe(obs({ actions: [action("read_file", { path: "x" }, "o1")] }));
    t2.observe(obs({ actions: [action("read_file", { path: "x" }, "o1")] }));
    checkEq(t2.snapshot().noProgressSteps, 2, "el snapshot cuenta pasos sin progreso");
    checkEq(t2.snapshot().maxActionCount, 2, "el snapshot cuenta acciones repetidas");
  }

  // -----------------------------------------------------------------------
  console.log("\n--- Determinismo ---");
  {
    const runSequence = (): ProgressVerdict[] => {
      const t = tracker({ maxIdenticalDiffs: 10, maxIdenticalActions: 10 });
      const sequence: ProgressObservation[] = [
        obs({ actions: [action("list_files", {})] }),
        obs({ actions: [action("list_files", {})] }),
        obs({ actions: [action("list_files", {})] }),
        obs({ actions: [action("list_files", {})] }),
        obs({ workspaceHash: "w-1", diffHash: "d-1" }),
        obs({ workspaceHash: "w-1", diffHash: "d-1" }),
        obs({ workspaceHash: "w-1", diffHash: "d-1" }),
        obs({ planHash: "P", planChanged: true }),
        obs({ planHash: "P", planChanged: true }),
        obs({ planHash: "P", planChanged: true }),
      ];
      return sequence.map((observation) => t.observe(observation));
    };
    const first = runSequence();
    const second = runSequence();
    checkEq(second, first, "la misma secuencia produce exactamente los mismos veredictos");
    checkEq(
      first.map((verdict) => verdict.level),
      ["ok", "ok", "ok", "ok", "ok", "ok", "ok", "ok", "warning", "stalled"],
      "la secuencia mixta sigue el orden esperado (plan P repetido avisa en el 2.º y stallea en el 3.º)",
    );
  }

  console.log("\n--- Resultado ---");
  checkEq(total - failed, total, `${total - failed}/${total} aserciones OK`);

  if (failed > 0) {
    console.error(`\n${failed} aserción(es) fallaron.`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("Error inesperado en el test de progreso:", error);
  process.exitCode = 1;
});
