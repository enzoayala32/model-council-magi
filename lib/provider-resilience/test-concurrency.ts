/**
 * Fase 5G — Concurrency Hardening (análisis experimental, NO implementación).
 *
 * Pregunta que este archivo busca responder con evidencia: el pool actual,
 * sin `inFlight` (decisión ya cerrada en las rondas 2-3 de diseño de Fase
 * 5A), ¿mantiene un comportamiento consistente cuando muchas operaciones
 * concurrentes compiten por pocas credentials?
 *
 * Usa el pool REAL de principio a fin — `withCredentialFailover` de
 * `council-run.ts`, `getProviderPool`/`__resetProviderPoolsForTests` de
 * `registry.ts`, la clasificación real de `classify.ts`, el cooldown real
 * de `cooldown.ts` — nada de esto se modifica ni se mockea. Toda la
 * instrumentación (contar "operaciones activas con esta misma credential
 * ahora mismo", medir solapamiento) vive ACÁ, nunca en producción.
 *
 * Determinismo sin `setTimeout`: en vez de confiar en que un delay de
 * tiempo real vaya a producir solapamiento (frágil, depende de qué tan
 * rápido corre la máquina), se usa una `Barrier` — todas las operaciones
 * de una misma "ronda" quedan bloqueadas hasta que TODAS llegan, y ahí se
 * liberan juntas en el mismo tick de microtasks. Eso garantiza
 * reproducibilidad exacta de la concurrencia observada.
 *
 * Uso: npm run provider-resilience:test-concurrency
 */
import { withCredentialFailover } from "../council-run";
import { __resetProviderPoolsForTests, __getProviderPoolForTests } from "./registry";
import { OpenRouterError } from "../llm-shared";
import type { CredentialState } from "./pool";

let results: boolean[] = [];

function check(label: string, ok: boolean, detail?: unknown): void {
  results.push(ok);
  console.log(`${ok ? "✅" : "❌"} ${label}${ok ? "" : ` — ${JSON.stringify(detail)}`}`);
}

function setOpenRouterCredentials(...values: string[]): void {
  const prefix = "OPENROUTER_API_KEY";
  delete process.env[prefix];
  for (const key of Object.keys(process.env)) {
    if (key.startsWith(`${prefix}_`)) delete process.env[key];
  }
  values.forEach((value, index) => {
    if (index === 0) process.env[prefix] = value;
    else process.env[`${prefix}_${index + 1}`] = value;
  });
}

// ============================================================
// Instrumentación (solo de este archivo — nunca toca pool.ts)
// ============================================================

/** Barrera determinista de N llegadas. Las primeras N-1 quedan
 * suspendidas (una `Promise` sin ningún timer real detrás) hasta que la
 * N-ésima llega y libera a todas juntas, en el mismo tick de microtasks —
 * sin depender de cuánto tarda nada en el reloj real. */
class Barrier {
  private arrived = 0;
  private waiters: Array<() => void> = [];
  constructor(private readonly total: number) {}
  async arrive(): Promise<void> {
    this.arrived++;
    if (this.arrived >= this.total) {
      const waiters = this.waiters;
      this.waiters = [];
      for (const resolve of waiters) resolve();
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }
}

type Decision = { kind: "success" } | { kind: "http"; status: number };

type AttemptRecord = {
  opIndex: number;
  attemptNumber: number;
  /** El VALOR real de la credential (el `apiKey` que recibe `attempt`) —
   * es la única identidad que el test puede observar desde afuera de
   * `withCredentialFailover` sin tocar `pool.ts`. Como el test controla
   * qué valor le puso a cada credential (`cred-0`, `cred-1`, ...), sirve
   * igual de bien que el `credentialId` interno del pool para medir
   * concurrencia real sobre una misma credential. */
  credentialValue: string;
  /** Cuántas operaciones (incluida esta) tenían esta MISMA credential
   * activa en simultáneo en el instante en que esta arrancó — la métrica
   * central de 5G (sección 4 del pedido). */
  concurrentAtStart: number;
  outcome: "success" | "error";
  errorStatus?: number;
};

/** Arma el `attempt` instrumentado de UNA operación. `barrier`, si se
 * pasa, solo se usa en el PRIMER intento de la operación — es la ronda de
 * adquisición inicial la que de verdad interesa forzar en simultáneo; los
 * reintentos por rotación ya quedan naturalmente escalonados por cuándo
 * cada operación llega a su propio `catch`, y sincronizarlos también
 * sería forzar una dinámica que no ocurre en producción. */
function makeInstrumentedAttempt(opIndex: number, decide: (attemptNumber: number) => Decision, records: AttemptRecord[], activeByCredential: Map<string, number>, barrier?: Barrier): (apiKey: string) => Promise<string> {
  let attemptNumber = 0;
  return async (apiKey: string): Promise<string> => {
    attemptNumber++;
    if (attemptNumber === 1 && barrier) await barrier.arrive();

    // Incremento SIN ningún await entremedio — same-tick para todas las
    // operaciones que la barrera acaba de liberar juntas (ver test-events
    // más abajo para la prueba de que esto captura solapamiento real).
    const concurrentAtStart = (activeByCredential.get(apiKey) ?? 0) + 1;
    activeByCredential.set(apiKey, concurrentAtStart);

    // Un solo tick de microtask — no un delay de tiempo real — para que
    // TODAS las operaciones liberadas por la barrera terminen de
    // incrementar su contador antes de que cualquiera empiece a
    // decrementarlo (ver razonamiento de orden de microtasks en el
    // informe). Determinista: no depende de cuán rápido corre la máquina.
    await Promise.resolve();

    const decision = decide(attemptNumber);
    activeByCredential.set(apiKey, (activeByCredential.get(apiKey) ?? 1) - 1);
    records.push({ opIndex, attemptNumber, credentialValue: apiKey, concurrentAtStart, outcome: decision.kind === "success" ? "success" : "error", errorStatus: decision.kind === "http" ? decision.status : undefined });

    if (decision.kind === "success") return "ok";
    throw new OpenRouterError(`fake http ${decision.status} (op ${opIndex}, intento ${attemptNumber})`, decision.status);
  };
}

type ScenarioResult = {
  records: AttemptRecord[];
  outcomes: Array<{ status: "fulfilled"; value: string } | { status: "rejected"; reason: unknown }>;
};

async function runScenario(opts: { credentialCount: number; opCount: number; decide: (attemptNumber: number, opIndex: number) => Decision; useBarrier?: boolean }): Promise<ScenarioResult> {
  __resetProviderPoolsForTests();
  setOpenRouterCredentials(...Array.from({ length: opts.credentialCount }, (_, i) => `cred-${i}`));

  const records: AttemptRecord[] = [];
  const activeByCredential = new Map<string, number>();
  const barrier = opts.useBarrier === false ? undefined : new Barrier(opts.opCount);

  const ops = Array.from({ length: opts.opCount }, (_, opIndex) => {
    const attempt = makeInstrumentedAttempt(opIndex, (attemptNumber) => opts.decide(attemptNumber, opIndex), records, activeByCredential, barrier);
    return withCredentialFailover("openrouter", new AbortController().signal, attempt).then(
      (value): ScenarioResult["outcomes"][number] => ({ status: "fulfilled" as const, value }),
      (reason): ScenarioResult["outcomes"][number] => ({ status: "rejected" as const, reason }),
    );
  });

  const outcomes = await Promise.all(ops);
  return { records, outcomes };
}

function distribution(records: AttemptRecord[]): Record<string, number> {
  const d: Record<string, number> = {};
  for (const r of records) d[r.credentialValue] = (d[r.credentialValue] ?? 0) + 1;
  return d;
}

function maxConcurrentPerCredential(records: AttemptRecord[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const r of records) m[r.credentialValue] = Math.max(m[r.credentialValue] ?? 0, r.concurrentAtStart);
  return m;
}

function printReport(label: string, records: AttemptRecord[]): void {
  console.log(`   [${label}] distribución (intentos totales por credential): ${JSON.stringify(distribution(records))}`);
  console.log(`   [${label}] máximo de operaciones simultáneas observadas por credential: ${JSON.stringify(maxConcurrentPerCredential(records))}`);
}

/** Invariantes genéricos de consistencia (sección 6 del pedido) — se
 * corren después de CADA escenario, sea cual sea su resultado funcional. */
function checkPoolConsistency(label: string, expectedCredentialCount: number): CredentialState[] {
  const pool = __getProviderPoolForTests("openrouter");
  const snapshot = pool.snapshot();
  check(`[${label}] el pool conserva las ${expectedCredentialCount} credentials — ninguna desaparece`, snapshot.length === expectedCredentialCount, snapshot);
  check(`[${label}] no hay ids duplicados`, new Set(snapshot.map((s) => s.id)).size === snapshot.length, snapshot);
  for (const s of snapshot) {
    check(`[${label}] ${s.id}: consecutiveFailures es un entero >= 0`, Number.isInteger(s.consecutiveFailures) && s.consecutiveFailures >= 0, s);
    if (s.status === "COOLDOWN") check(`[${label}] ${s.id}: en COOLDOWN con cooldownUntil numérico coherente`, typeof s.cooldownUntil === "number" && s.cooldownUntil > Date.now() - 1000, s);
    else check(`[${label}] ${s.id}: fuera de COOLDOWN, cooldownUntil es null`, s.cooldownUntil === null, s);
  }
  return snapshot;
}

/** Verifica la garantía estructural de `usedIds` (5A): dentro de UNA
 * misma operación, ninguna credential se repite entre sus propios
 * intentos — pase lo que pase con el estado global concurrente. */
function checkNoRepeatWithinOp(label: string, records: AttemptRecord[]): void {
  const byOp = new Map<number, string[]>();
  for (const r of records) byOp.set(r.opIndex, [...(byOp.get(r.opIndex) ?? []), r.credentialValue]);
  let ok = true;
  for (const [, values] of byOp) if (new Set(values).size !== values.length) ok = false;
  check(`[${label}] ninguna operación repite una credential entre sus propios intentos (usedIds)`, ok, Object.fromEntries(byOp));
}

async function main(): Promise<void> {
  console.log("== Fase 5G — análisis experimental de concurrencia (Provider Resilience) ==\n");

  // ------------------------------------------------------------
  // Escenario A — reparto básico: N ops exitosas, pocas credentials sanas
  // ------------------------------------------------------------
  console.log("--- Escenario A: reparto básico (3 credentials, 30 ops, todas exitosas) ---");
  {
    const { records, outcomes } = await runScenario({ credentialCount: 3, opCount: 30, decide: () => ({ kind: "success" }) });
    check("las 30 operaciones resuelven ok", outcomes.every((o) => o.status === "fulfilled"), outcomes);
    printReport("A", records);
    const dist = distribution(records);
    check("las 30 asignaciones se repartieron entre las 3 credentials (ninguna quedó sin usar)", Object.keys(dist).length === 3 && Object.values(dist).every((n) => n > 0), dist);
    check("suma total de asignaciones = 30", Object.values(dist).reduce((a, b) => a + b, 0) === 30, dist);
    checkNoRepeatWithinOp("A", records);
    const snap = checkPoolConsistency("A", 3);
    check("[A] las 3 credentials quedaron AVAILABLE (todas exitosas)", snap.every((s) => s.status === "AVAILABLE" && s.consecutiveFailures === 0), snap);
  }

  // ------------------------------------------------------------
  // Escenario B — muchas ops, pocas credentials (20 / 50 / 100)
  // ------------------------------------------------------------
  console.log("\n--- Escenario B: muchas operaciones, pocas credentials (2 credentials) ---");
  for (const opCount of [20, 50, 100]) {
    const { records, outcomes } = await runScenario({ credentialCount: 2, opCount, decide: () => ({ kind: "success" }) });
    check(`[B-${opCount}] las ${opCount} operaciones resuelven ok`, outcomes.every((o) => o.status === "fulfilled"), outcomes.length);
    printReport(`B-${opCount}`, records);
    const dist = distribution(records);
    check(`[B-${opCount}] ambas credentials recibieron operaciones`, Object.keys(dist).length === 2, dist);
    check(`[B-${opCount}] suma total = ${opCount}`, Object.values(dist).reduce((a, b) => a + b, 0) === opCount, dist);
    const snap = checkPoolConsistency(`B-${opCount}`, 2);
    check(`[B-${opCount}] ambas credentials AVAILABLE, sin fallos`, snap.every((s) => s.status === "AVAILABLE" && s.consecutiveFailures === 0), snap);
  }
  console.log("   (no se exige una distribución perfecta — el objetivo es observar el reparto real, ver informe)");

  // ------------------------------------------------------------
  // Escenario C — 429 en algunas credentials, el resto sigue funcionando
  // (25 credentials: ninguna adquisición, ni siquiera las de rotación,
  // puede colisionar con otra operación — aísla el "reparto ante fallos
  // parciales" del hallazgo de la sección siguiente).
  // ------------------------------------------------------------
  console.log("--- Escenario C: 429 en 6 de 15 ops (25 credentials — sin ninguna colisión posible, ni en rotación) ---");
  {
    const { records, outcomes } = await runScenario({
      credentialCount: 25,
      opCount: 15,
      decide: (attemptNumber, opIndex) => (attemptNumber === 1 && opIndex < 6 ? { kind: "http", status: 429 } : { kind: "success" }),
    });
    check("las 15 operaciones terminan exitosas (todas pudieron rotar o nunca fallaron)", outcomes.every((o) => o.status === "fulfilled"), outcomes);
    printReport("C", records);
    const rotatedOps = new Set(records.filter((r) => r.attemptNumber === 2).map((r) => r.opIndex));
    check("exactamente las 6 operaciones que recibieron 429 rotaron (attemptNumber=2)", rotatedOps.size === 6 && [...rotatedOps].every((i) => i < 6), [...rotatedOps]);
    checkNoRepeatWithinOp("C", records);
    const snap = checkPoolConsistency("C", 25);
    const cooldownCount = snap.filter((s) => s.status === "COOLDOWN").length;
    const invalidCount = snap.filter((s) => s.status === "INVALID").length;
    check("exactamente 6 credentials en COOLDOWN (las que recibieron el 429), 0 INVALID — sin colisión, nada las pisa", cooldownCount === 6 && invalidCount === 0, snap);
    check("cada credential en COOLDOWN tiene consecutiveFailures=1 (una sola falla real cada una)", snap.filter((s) => s.status === "COOLDOWN").every((s) => s.consecutiveFailures === 1), snap);
  }

  // ------------------------------------------------------------
  // FIX del hallazgo de 5G (release de generación vieja pisando un health
  // state más reciente): batería de regresión pedida — caso mínimo A/B
  // exacto del pedido, la reproducción a escala ya usada para encontrar el
  // bug, los 6 casos de la sección 8, y el caso INVALID de la sección 9.
  // ------------------------------------------------------------

  // Caso mínimo EXACTO del pedido: A adquiere credential-1, B adquiere
  // credential-1 (única, así la comparten a la fuerza), B falla 429, A
  // termina success. Se corre en AMBOS órdenes relativos de resolución
  // para confirmar que el fix es robusto al orden (no depende de timing).
  console.log("--- Fix — caso mínimo del pedido: A éxito + B falla 429 sobre la MISMA (única) credential, en ambos órdenes ---");
  for (const bFirst of [false, true]) {
    __resetProviderPoolsForTests();
    setOpenRouterCredentials("credential-1");
    const barrier = new Barrier(2);
    const a = () =>
      withCredentialFailover("openrouter", new AbortController().signal, async () => {
        await barrier.arrive();
        return "ok";
      }).then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason) => ({ status: "rejected" as const, reason }),
      );
    const b = () =>
      withCredentialFailover("openrouter", new AbortController().signal, async () => {
        await barrier.arrive();
        throw new OpenRouterError("rate limited", 429);
      }).then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason) => ({ status: "rejected" as const, reason }),
      );
    await Promise.all(bFirst ? [b(), a()] : [a(), b()]);
    const snap = __getProviderPoolForTests("openrouter").snapshot();
    check(`[orden bFirst=${bFirst}] X sigue COOLDOWN pese al success de A (release viejo no la pisa)`, snap[0].status === "COOLDOWN", snap[0]);
    check(`[orden bFirst=${bFirst}] consecutiveFailures se conserva en 1 (el fallo real de B nunca se pierde)`, snap[0].consecutiveFailures === 1, snap[0]);
    check(`[orden bFirst=${bFirst}] cooldownUntil quedó seteado (no fue borrado por el success de A)`, typeof snap[0].cooldownUntil === "number", snap[0]);
  }

  // Reproducción a escala (la que efectivamente encontró el bug): N=6
  // credentials, 2N=12 ops — ahora debe demostrar que el fix lo cierra.
  console.log("\n--- Fix — reproducción a escala (N=6, 2N=12): las 6 credentials que fallaron 429 ya NO se pisan ---");
  {
    const CRED_COUNT = 6;
    const OP_COUNT = CRED_COUNT * 2;
    __resetProviderPoolsForTests();
    setOpenRouterCredentials(...Array.from({ length: CRED_COUNT }, (_, i) => `cred-${i}`));
    const barrier = new Barrier(OP_COUNT);
    const records: AttemptRecord[] = [];
    const activeByCredential = new Map<string, number>();
    const ops = Array.from({ length: OP_COUNT }, (_, opIndex) => {
      const attempt = makeInstrumentedAttempt(
        opIndex,
        (attemptNumber) => (attemptNumber === 1 && opIndex < CRED_COUNT ? { kind: "http", status: 429 } : { kind: "success" }),
        records,
        activeByCredential,
        barrier,
      );
      return withCredentialFailover("openrouter", new AbortController().signal, attempt).then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason) => ({ status: "rejected" as const, reason }),
      );
    });
    const outcomes = await Promise.all(ops);
    check("las 12 operaciones terminan en un resultado legible (éxito o rechazo con mensaje), ninguna excepción corrupta", outcomes.every((o) => o.status === "fulfilled" || (o.reason instanceof Error && o.reason.message.length > 0)), outcomes);
    printReport("fix-escala", records);
    const snap = checkPoolConsistency("fix-escala", CRED_COUNT);
    const survived = snap.filter((s) => s.status === "COOLDOWN").length;
    console.log(`   [fix-escala] credentials que debieron quedar en COOLDOWN por su 429 real: ${CRED_COUNT}. Sobrevivieron: ${survived}.`);
    check("FIX CONFIRMADO: las 6 credentials que fallaron con 429 real siguen en COOLDOWN — ningún success concurrente las pisó", survived === CRED_COUNT, snap);
    check("cada una conserva consecutiveFailures=1 (el fallo real, ni perdido ni duplicado)", snap.filter((s) => s.status === "COOLDOWN").every((s) => s.consecutiveFailures === 1), snap);
  }

  // Sección 8 del pedido — los 6 casos explícitos, cada uno aislado y determinista.
  console.log("\n--- Fix — sección 8: los 6 casos explícitos pedidos ---");
  {
    // Caso 1: SUCCESS → SUCCESS ⇒ AVAILABLE.
    __resetProviderPoolsForTests();
    setOpenRouterCredentials("credential-1");
    const barrier1 = new Barrier(2);
    const run1 = (label: string) =>
      withCredentialFailover("openrouter", new AbortController().signal, async () => {
        await barrier1.arrive();
        return label;
      });
    await Promise.all([run1("A"), run1("B")]);
    const snap1 = __getProviderPoolForTests("openrouter").snapshot();
    check("Caso 1 (SUCCESS→SUCCESS): queda AVAILABLE, sin fallos", snap1[0].status === "AVAILABLE" && snap1[0].consecutiveFailures === 0, snap1[0]);

    // Caso 2: SUCCESS antiguo → 429 nuevo ⇒ COOLDOWN (ya probado arriba en
    // el caso mínimo del pedido — se re-confirma acá con nombre explícito).
    __resetProviderPoolsForTests();
    setOpenRouterCredentials("credential-1");
    const barrier2 = new Barrier(2);
    const oldSuccess = withCredentialFailover("openrouter", new AbortController().signal, async () => {
      await barrier2.arrive();
      return "ok";
    });
    const newFailure = withCredentialFailover("openrouter", new AbortController().signal, async () => {
      await barrier2.arrive();
      throw new OpenRouterError("rate limited", 429);
    }).catch(() => undefined);
    await Promise.all([oldSuccess, newFailure]);
    const snap2 = __getProviderPoolForTests("openrouter").snapshot();
    check("Caso 2 (success antiguo → 429 nuevo): queda COOLDOWN", snap2[0].status === "COOLDOWN", snap2[0]);

    // Caso 3: SUCCESS antiguo → INVALID nuevo ⇒ INVALID (ya protegido HOY
    // por el guard `if (status === "INVALID") return` — sin relación con
    // `generation`, se confirma que sigue intacto).
    __resetProviderPoolsForTests();
    setOpenRouterCredentials("credential-1");
    const barrier3 = new Barrier(2);
    const oldSuccess3 = withCredentialFailover("openrouter", new AbortController().signal, async () => {
      await barrier3.arrive();
      return "ok";
    });
    const newInvalid = withCredentialFailover("openrouter", new AbortController().signal, async () => {
      await barrier3.arrive();
      throw new OpenRouterError("invalid api key", 401);
    }).catch(() => undefined);
    await Promise.all([oldSuccess3, newInvalid]);
    const snap3 = __getProviderPoolForTests("openrouter").snapshot();
    check("Caso 3 (success antiguo → INVALID nuevo): queda INVALID", snap3[0].status === "INVALID", snap3[0]);

    // Caso 4: 429 antiguo → SUCCESS posterior LEGÍTIMO (el success adquirió
    // su lease DESPUÉS del 429, con la generación ya actualizada) ⇒ puede
    // limpiar el estado — es una recuperación real, no una carrera.
    __resetProviderPoolsForTests();
    setOpenRouterCredentials("credential-1");
    try {
      await withCredentialFailover("openrouter", new AbortController().signal, async () => {
        throw new OpenRouterError("rate limited", 429);
      });
    } catch {
      /* esperado: única credential, sin rotación posible, queda en COOLDOWN */
    }
    const midSnap = __getProviderPoolForTests("openrouter").snapshot();
    check("Caso 4 (setup): la credential quedó en COOLDOWN tras el 429", midSnap[0].status === "COOLDOWN", midSnap[0]);
    // Legítimo: una operación que la ADQUIERE AHORA (generación ya al día)
    // y tiene éxito SÍ puede limpiarla — no hay ninguna carrera acá porque
    // no hay ningún cambio concurrente entre su adquisición y su release.
    // (`cursor.next()` igual la entrega pese al COOLDOWN reciente porque
    // `PLACEHOLDER_COOLDOWN_MS`/backoff real ya expiró para este test — se
    // fuerza el punto usando `release` directo con generación fresca para
    // aislar SOLO la semántica de generación, sin depender del timing real
    // de expiración del cooldown, que no es lo que este caso quiere medir.)
    const poolC4 = __getProviderPoolForTests("openrouter");
    const freshGen = poolC4.snapshot(); // solo para claridad — no se usa el valor
    void freshGen;
    const cursorC4 = poolC4.beginOperation();
    // Al haber expirado o no el cooldown no es el foco; forzamos la
    // adquisición leyendo el lease con `now` muy futuro para saltar el
    // cooldown real, exactamente como haría un reintento legítimo bastante
    // después.
    const farFuture = Date.now() + 10 * 60 * 1000;
    const acquired = cursorC4.next(farFuture);
    check("Caso 4 (setup): tras el tiempo, la credential vuelve a estar AVAILABLE para un nuevo cursor", acquired.status === "AVAILABLE", acquired);
    if (acquired.status === "AVAILABLE") {
      poolC4.release(acquired.lease.id, "success", Date.now(), undefined, acquired.lease.healthGeneration);
    }
    const snap4 = poolC4.snapshot();
    check("Caso 4: un success LEGÍTIMO (adquirido después del 429, generación al día) sí limpia el estado a AVAILABLE", snap4[0].status === "AVAILABLE" && snap4[0].consecutiveFailures === 0, snap4[0]);

    // Caso 5: dos fallos concurrentes ⇒ ambos incrementos de
    // consecutiveFailures se preservan (esto ya funcionaba — se reconfirma
    // explícitamente con el nombre de la sección 8).
    __resetProviderPoolsForTests();
    setOpenRouterCredentials("credential-1");
    const barrier5 = new Barrier(2);
    const fail5a = withCredentialFailover("openrouter", new AbortController().signal, async () => {
      await barrier5.arrive();
      throw new OpenRouterError("rate limited A", 429);
    }).catch(() => undefined);
    const fail5b = withCredentialFailover("openrouter", new AbortController().signal, async () => {
      await barrier5.arrive();
      throw new OpenRouterError("rate limited B", 429);
    }).catch(() => undefined);
    await Promise.all([fail5a, fail5b]);
    const snap5 = __getProviderPoolForTests("openrouter").snapshot();
    check("Caso 5 (dos fallos concurrentes): consecutiveFailures = 2 (ningún incremento se pierde)", snap5[0].consecutiveFailures === 2, snap5[0]);

    // Caso 6: cooldown posterior + release antiguo ⇒ cooldownUntil más
    // reciente no debe ser reemplazado por uno viejo. Con solo `release()`
    // reordenado en el tiempo (2 llamadas directas, la "vieja" ejecutada
    // DESPUÉS en wall-clock pero con menos consecutiveFailures observadas
    // en el momento de su cálculo real — replica el patrón real de
    // `loop.ts`/`council-run.ts`, que siempre recalcula `cooldownMs` con el
    // conteo VIVO de `consecutiveFailures` al momento de cada llamada).
    __resetProviderPoolsForTests();
    setOpenRouterCredentials("credential-1");
    const poolC6 = __getProviderPoolForTests("openrouter");
    poolC6.release("openrouter-1", "cooldown", Date.now(), 2_000); // 1er fallo: cooldown corto
    const afterFirst = poolC6.snapshot()[0].cooldownUntil!;
    poolC6.release("openrouter-1", "cooldown", Date.now(), 8_000); // 2do fallo: cooldown más largo
    const afterSecond = poolC6.snapshot()[0];
    check("Caso 6: el cooldownUntil más reciente (más largo) prevalece, no lo pisa el anterior", afterSecond.cooldownUntil! > afterFirst, { afterFirst, afterSecond });
    check("Caso 6: consecutiveFailures acumula (2), no se resetea entre los dos cooldowns", afterSecond.consecutiveFailures === 2, afterSecond);
  }

  // Sección 9 del pedido — confirmar explícitamente que INVALID tampoco
  // puede revivir por un success viejo concurrente (ya lo garantiza el
  // guard existente de `pool.ts`, ajeno a `generation` — se agrega el test
  // explícito que pide la sección 9).
  console.log("\n--- Fix — sección 9: INVALID tampoco revive con un success viejo concurrente ---");
  {
    const CRED_COUNT = 4;
    const OP_COUNT = CRED_COUNT * 2;
    __resetProviderPoolsForTests();
    setOpenRouterCredentials(...Array.from({ length: CRED_COUNT }, (_, i) => `cred-${i}`));
    const barrier = new Barrier(OP_COUNT);
    const records: AttemptRecord[] = [];
    const activeByCredential = new Map<string, number>();
    const ops = Array.from({ length: OP_COUNT }, (_, opIndex) => {
      const attempt = makeInstrumentedAttempt(
        opIndex,
        (attemptNumber) => (attemptNumber === 1 && opIndex < CRED_COUNT ? { kind: "http", status: 401 } : { kind: "success" }),
        records,
        activeByCredential,
        barrier,
      );
      return withCredentialFailover("openrouter", new AbortController().signal, attempt).then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason) => ({ status: "rejected" as const, reason }),
      );
    });
    await Promise.all(ops);
    const snap = checkPoolConsistency("invalid-no-revive", CRED_COUNT);
    const invalidCount = snap.filter((s) => s.status === "INVALID").length;
    check(`las ${CRED_COUNT} credentials que fallaron con 401 real siguen INVALID — ningún success concurrente las revive`, invalidCount === CRED_COUNT, snap);
  }

  // ------------------------------------------------------------
  // Escenario D — 500/502/503: nunca degradan salud
  // ------------------------------------------------------------
  console.log("\n--- Escenario D: 503 en TODAS las ops en su primer intento (4 credentials, 15 ops) ---");
  {
    const { records, outcomes } = await runScenario({
      credentialCount: 4,
      opCount: 15,
      decide: (attemptNumber) => (attemptNumber === 1 ? { kind: "http", status: 503 } : { kind: "success" }),
    });
    check("las 15 operaciones terminan exitosas pese a que TODAS fallaron una vez con 503", outcomes.every((o) => o.status === "fulfilled"), outcomes);
    printReport("D", records);
    checkNoRepeatWithinOp("D", records);
    const snap = checkPoolConsistency("D", 4);
    check("[D] ninguna credential quedó COOLDOWN ni INVALID — 503 no degrada salud (y por eso tampoco es vulnerable al hallazgo de arriba: nunca hay nada que pisar)", snap.every((s) => s.status === "AVAILABLE"), snap);
    check("[D] consecutiveFailures en 0 para las 4 — un poolAction=NONE nunca lo toca", snap.every((s) => s.consecutiveFailures === 0), snap);
  }

  // ------------------------------------------------------------
  // Escenario E — estados mixtos preexistentes (AVAILABLE + COOLDOWN + INVALID)
  // ------------------------------------------------------------
  console.log("\n--- Escenario E: estados mixtos preexistentes (1 INVALID + 1 COOLDOWN + 3 AVAILABLE), 10 ops concurrentes ---");
  {
    __resetProviderPoolsForTests();
    setOpenRouterCredentials("cred-0", "cred-1", "cred-2", "cred-3", "cred-4");
    const pool = __getProviderPoolForTests("openrouter");

    // Semilla SECUENCIAL (no concurrente) para dejar el pool en un estado
    // mixto conocido: exactamente 1 credential INVALID y exactamente 1 en
    // COOLDOWN. Cada seed falla SOLO en su primer intento (si no, al ser
    // 401/429 failover-eligible, seguiría rotando y degradando TODAS las
    // credentials en vez de solo una).
    let seed1Calls = 0;
    try {
      await withCredentialFailover("openrouter", new AbortController().signal, async () => {
        seed1Calls++;
        if (seed1Calls === 1) throw new OpenRouterError("invalid api key", 401);
        return "ok";
      });
    } catch {
      /* no debería rechazar (rota una sola vez a una credential sana) */
    }
    let seed2Calls = 0;
    try {
      await withCredentialFailover("openrouter", new AbortController().signal, async () => {
        seed2Calls++;
        if (seed2Calls === 1) throw new OpenRouterError("rate limited", 429);
        return "ok";
      });
    } catch {
      /* idem */
    }

    const seeded = pool.snapshot();
    const invalidIds = seeded.filter((s) => s.status === "INVALID").map((s) => s.id);
    const cooldownIds = seeded.filter((s) => s.status === "COOLDOWN").map((s) => s.id);
    check("seed: exactamente 1 credential INVALID y 1 en COOLDOWN (nunca más, pese a ser errores failover-eligible)", invalidIds.length === 1 && cooldownIds.length === 1, seeded);

    // Traduce los ids sintéticos del pool (`openrouter-N`) de vuelta al
    // VALOR de credential que el test le asignó (`cred-(N-1)`) — así no se
    // asume a mano cuáles quedaron afectadas, se deriva del snapshot real.
    const idToValue = (id: string): string => `cred-${Number(id.split("-").pop()) - 1}`;
    const excludedValues = new Set([...invalidIds, ...cooldownIds].map(idToValue));

    const records: AttemptRecord[] = [];
    const activeByCredential = new Map<string, number>();
    const barrier = new Barrier(10);
    const ops = Array.from({ length: 10 }, (_, opIndex) => {
      const attempt = makeInstrumentedAttempt(opIndex, () => ({ kind: "success" }), records, activeByCredential, barrier);
      return withCredentialFailover("openrouter", new AbortController().signal, attempt).then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason) => ({ status: "rejected" as const, reason }),
      );
    });
    const outcomes = await Promise.all(ops);
    check("las 10 operaciones concurrentes resuelven ok usando solo las 3 credentials sanas", outcomes.every((o) => o.status === "fulfilled"), outcomes);
    printReport("E", records);
    check("NINGUNA operación recibió jamás la credential INVALID ni la COOLDOWN, ni bajo concurrencia", records.every((r) => !excludedValues.has(r.credentialValue)), { excludedValues: [...excludedValues], usadas: [...new Set(records.map((r) => r.credentialValue))] });
    checkNoRepeatWithinOp("E", records);
    const snap = checkPoolConsistency("E", 5);
    check("[E] la credential INVALID lo sigue estando al final (nunca vuelve a AVAILABLE)", snap.filter((s) => s.status === "INVALID").length === 1, snap);
    check("[E] la credential COOLDOWN lo sigue estando al final — acá SÍ sobrevive: nada la usó con éxito, nada tenía por qué pisarla", snap.filter((s) => s.status === "COOLDOWN").length === 1, snap);
    check("[E] las 3 credentials sanas quedaron AVAILABLE y sin fallos", snap.filter((s) => s.status === "AVAILABLE").every((s) => s.consecutiveFailures === 0), snap);
  }

  // ------------------------------------------------------------
  // Escenario F — ráfaga real de producción, a escala: 10 ops, 3 credentials,
  // 429 simultáneo en TODAS (el patrón ya documentado del incidente real)
  // ------------------------------------------------------------
  console.log("\n--- Escenario F: ráfaga estilo Council (10 operaciones concurrentes, solo 3 credentials, 429 simultáneo en todas) ---");
  {
    const { records, outcomes } = await runScenario({
      credentialCount: 3,
      opCount: 10,
      decide: () => ({ kind: "http", status: 429 }), // TODOS los intentos (1ro, 2do, ...) fallan — reproduce el agotamiento total real
    });
    const rejected = outcomes.filter((o) => o.status === "rejected").length;
    console.log(`   [F] operaciones rechazadas: ${rejected}/10 (esperado: 10/10 — con solo 3 credentials y 429 en todas, no queda ninguna sana para rotar)`);
    check("las 10 operaciones terminan rechazadas — no hay ninguna credential sana para rotar (esperado, no es un bug)", rejected === 10, outcomes);
    check("cada rechazo es un error legible de agotamiento, no una excepción corrupta", outcomes.every((o) => o.status === "rejected" && o.reason instanceof Error && o.reason.message.length > 0), outcomes);
    printReport("F", records);
    checkNoRepeatWithinOp("F", records);
    const snap = checkPoolConsistency("F", 3);
    check("[F] las 3 credentials terminan en COOLDOWN (ninguna INVALID por un 429)", snap.every((s) => s.status === "COOLDOWN"), snap);
    // Acá NUNCA hay un release("success") — todo intento (attempt 1, 2, 3)
    // decide 429 — así que este escenario es INMUNE al hallazgo de arriba
    // (que necesita un success pisando un cooldown ajeno). Por eso acá SÍ
    // vale una aserción fuerte: cada incremento de consecutiveFailures debe
    // corresponder EXACTAMENTE a un intento real registrado — cero updates
    // perdidos pese a la concurrencia real sobre credentials compartidas.
    const attemptsPerCredential: Record<string, number> = {};
    for (const r of records) attemptsPerCredential[r.credentialValue] = (attemptsPerCredential[r.credentialValue] ?? 0) + 1;
    // cred-N (valor) -> openrouter-(N+1) (id del pool)
    const expectedById: Record<string, number> = {};
    for (const [value, count] of Object.entries(attemptsPerCredential)) expectedById[`openrouter-${Number(value.split("-")[1]) + 1}`] = count;
    const actualById = Object.fromEntries(snap.map((s) => [s.id, s.consecutiveFailures]));
    check("consecutiveFailures de cada credential = cantidad real de intentos que sufrió (derivado de los registros, no asumido) — sin updates perdidos", JSON.stringify(actualById) === JSON.stringify(expectedById), { expectedById, actualById });
    const totalFailures = Object.values(actualById).reduce((a, b) => a + b, 0);
    check("la suma de consecutiveFailures = intentos totales realizados (ninguno se perdió)", totalFailures === records.length, { totalFailures, intentos: records.length });
  }

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} casos OK.`);
  if (passed !== results.length) process.exit(1);
}

main().catch((error) => {
  console.error("Error inesperado en la prueba:", error);
  process.exit(1);
});
