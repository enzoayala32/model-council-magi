/**
 * Prueba de aceptación de la Fase 5A (Credential Pool Core — ver diseño de
 * Fase 5, rondas 1-3). Puros tests unitarios sobre `pool.ts`: sin red, sin
 * providers reales, sin Council, sin Coding Agent, sin `.env`. El tiempo
 * se controla pasando `now` explícito a cada llamada — nunca se espera de
 * verdad ("sleep") para probar expiración de cooldown.
 *
 * Uso: npm run provider-resilience:test-pool
 */
import { CredentialPool, type CredentialEntry } from "./pool";

let results: boolean[] = [];

function check(label: string, ok: boolean, detail?: unknown): void {
  results.push(ok);
  console.log(`${ok ? "✅" : "❌"} ${label}${ok ? "" : ` — ${JSON.stringify(detail)}`}`);
}

function pool(...ids: string[]): CredentialPool {
  const entries: CredentialEntry[] = ids.map((id) => ({ id, value: `secret-${id}` }));
  return new CredentialPool(entries);
}

function main(): void {
  console.log("== Fase 5A — prueba de aceptación (Credential Pool Core) ==\n");

  // --- Caso 1: pool con una sola credential ---
  {
    console.log("--- Caso 1: pool con una sola credential ---");
    const p = pool("A");
    const cursor = p.beginOperation();
    const r1 = cursor.next(0);
    check("1 credential: primer next() da AVAILABLE con id A", r1.status === "AVAILABLE" && r1.lease.id === "A", r1);
    const r2 = cursor.next(0);
    check("1 credential: segundo next() del mismo cursor da NO_CREDENTIALS (A ya usada)", r2.status === "NO_CREDENTIALS", r2);
  }

  // --- Caso 2: pool con varias credentials ---
  {
    console.log("\n--- Caso 2: pool con varias credentials ---");
    const p = pool("A", "B", "C");
    const cursor = p.beginOperation();
    const ids = [cursor.next(0), cursor.next(0), cursor.next(0)].map((r) => (r.status === "AVAILABLE" ? r.lease.id : r.status));
    check("3 credentials: un cursor recorre las 3 sin repetir", JSON.stringify(ids) === JSON.stringify(["A", "B", "C"]), ids);
  }

  // --- Caso 3: no repetición dentro de una operación (incluso si release() ocurre entre medio) ---
  {
    console.log("\n--- Caso 3: no repetición dentro de una operación, ni con release() ni con cooldown expirado entre medio ---");
    const p = pool("A", "B", "C");
    const cursor = p.beginOperation();
    const first = cursor.next(0);
    check("caso 3: primer next() da A", first.status === "AVAILABLE" && first.lease.id === "A", first);
    // Se libera A como éxito (queda AVAILABLE de nuevo a nivel pool) ANTES de seguir pidiendo en el mismo cursor.
    p.release("A", "success", 0);
    const second = cursor.next(0);
    const third = cursor.next(0);
    const fourth = cursor.next(1000); // tiempo avanzado — igual no debería importar para el mismo cursor
    const seenIds = [second, third].map((r) => (r.status === "AVAILABLE" ? r.lease.id : r.status));
    check(
      "caso 3: el mismo cursor jamás vuelve a entregar A, aunque A haya sido liberada como success",
      !seenIds.includes("A") && fourth.status === "NO_CREDENTIALS",
      { seenIds, fourth },
    );
  }

  // --- Caso 4: NO_CREDENTIALS tras agotar las disponibles para ese cursor ---
  {
    console.log("\n--- Caso 4: next() da NO_CREDENTIALS después de agotar las credentials disponibles para ese cursor ---");
    const p = pool("A", "B");
    const cursor = p.beginOperation();
    cursor.next(0);
    cursor.next(0);
    const r = cursor.next(0);
    check("caso 4: NO_CREDENTIALS tras agotar A y B", r.status === "NO_CREDENTIALS", r);
  }

  // --- Caso 5: dos operaciones independientes no comparten su usedIds ---
  {
    console.log("\n--- Caso 5: dos operaciones independientes no comparten su usedIds ---");
    const p = pool("A", "B");
    const cursor1 = p.beginOperation();
    const r1a = cursor1.next(0); // A
    const cursor2 = p.beginOperation();
    // cursor2 arranca desde el puntero global (que ya avanzó a B tras cursor1), pero
    // su propio usedIds está vacío — no hereda nada de cursor1.
    const r2a = cursor2.next(0);
    const r2b = cursor2.next(0);
    const ids2 = [r2a, r2b].map((r) => (r.status === "AVAILABLE" ? r.lease.id : r.status));
    check(
      "caso 5: cursor2 puede recorrer B y (al dar la vuelta) A, sin arrastrar el usedIds de cursor1",
      r1a.status === "AVAILABLE" && r1a.lease.id === "A" && JSON.stringify(ids2) === JSON.stringify(["B", "A"]),
      { r1a, ids2 },
    );
  }

  // --- Caso 6: round-robin determinista entre operaciones ---
  {
    console.log("\n--- Caso 6: round-robin determinista entre operaciones (op1→A, op2→B, op3→C, op4→A) ---");
    const p = pool("A", "B", "C");
    const picks: string[] = [];
    for (let i = 0; i < 4; i++) {
      const cursor = p.beginOperation();
      const r = cursor.next(0);
      picks.push(r.status === "AVAILABLE" ? r.lease.id : r.status);
    }
    check("caso 6: 4 operaciones de 1 pick cada una rotan A,B,C,A", JSON.stringify(picks) === JSON.stringify(["A", "B", "C", "A"]), picks);
  }

  // --- Caso 7: INVALID nunca es seleccionable ---
  {
    console.log("\n--- Caso 7: INVALID nunca es seleccionable, ni por el mismo cursor ni por cursores posteriores ---");
    const p = pool("A", "B");
    p.release("A", "invalid", 0);
    const cursor1 = p.beginOperation();
    const r1 = cursor1.next(0);
    check("caso 7: cursor1 salta A (INVALID) y da B directo", r1.status === "AVAILABLE" && r1.lease.id === "B", r1);
    const r1b = cursor1.next(0);
    check("caso 7: cursor1 no tiene más nada que dar (A sigue INVALID, B ya usada)", r1b.status === "NO_CREDENTIALS", r1b);
    // Un success explícito sobre A no la revive — es permanente.
    p.release("A", "success", 0);
    const cursor2 = p.beginOperation();
    const r2 = cursor2.next(0);
    const r2b = cursor2.next(0);
    check(
      "caso 7: un release(A,\"success\") posterior NO revive a A — sigue INVALID para siempre",
      r2.status === "AVAILABLE" && r2.lease.id === "B" && r2b.status === "NO_CREDENTIALS",
      { r2, r2b, snapshotA: p.snapshot(0).find((s) => s.id === "A") },
    );
  }

  // --- Caso 8: COOLDOWN no es seleccionable mientras está vigente ---
  {
    console.log("\n--- Caso 8: COOLDOWN no es seleccionable mientras está vigente ---");
    const p = pool("A", "B");
    p.release("A", "cooldown", 0); // cooldownUntil = 0 + PLACEHOLDER_COOLDOWN_MS
    const cursor = p.beginOperation();
    const r = cursor.next(100); // muy dentro de la ventana de cooldown todavía
    check("caso 8: con A en cooldown vigente, el cursor la salta y da B", r.status === "AVAILABLE" && r.lease.id === "B", r);
    const r2 = cursor.next(100);
    check(
      "caso 8: agotada B, next() reporta COOLDOWN (no NO_CREDENTIALS) porque A sigue existiendo y podría liberarse",
      r2.status === "COOLDOWN",
      r2,
    );
  }

  // --- Caso 9: COOLDOWN vuelve a ser elegible después de expirar ---
  {
    console.log("\n--- Caso 9: COOLDOWN vuelve a ser elegible después de expirar ---");
    const p = pool("A");
    p.release("A", "cooldown", 0);
    const cursorTooSoon = p.beginOperation();
    const early = cursorTooSoon.next(100);
    check("caso 9: todavía en cooldown a los 100ms, no elegible", early.status !== "AVAILABLE", early);
    const cursorLater = p.beginOperation();
    const late = cursorLater.next(10_000); // bien pasado el placeholder de 5s
    check("caso 9: tras expirar el cooldown, vuelve a ser AVAILABLE", late.status === "AVAILABLE" && late.lease.id === "A", late);
    const snap = p.snapshot(10_000);
    check("caso 9: snapshot() también refleja el estado normalizado (AVAILABLE) sin haber llamado next() antes", snap[0]?.status === "AVAILABLE", snap);
  }

  // --- Caso 10: release() actualiza correctamente el estado global del pool ---
  {
    console.log("\n--- Caso 10: release() actualiza correctamente el estado global del pool (visible vía snapshot) ---");
    const p = pool("A");
    p.release("A", "cooldown", 1000);
    const afterCooldown = p.snapshot(1000);
    check(
      "caso 10: tras release(cooldown), snapshot muestra status COOLDOWN, cooldownUntil seteado y consecutiveFailures=1",
      afterCooldown[0]?.status === "COOLDOWN" && afterCooldown[0]?.cooldownUntil === 1000 + 5000 && afterCooldown[0]?.consecutiveFailures === 1,
      afterCooldown,
    );
    p.release("A", "success", 2000);
    const afterSuccess = p.snapshot(2000);
    check(
      "caso 10: tras release(success), snapshot muestra AVAILABLE, cooldownUntil null y consecutiveFailures reseteado a 0",
      afterSuccess[0]?.status === "AVAILABLE" && afterSuccess[0]?.cooldownUntil === null && afterSuccess[0]?.consecutiveFailures === 0,
      afterSuccess,
    );
  }

  // --- Caso 11: una credential liberada no vuelve a ser seleccionable por un cursor que ya la utilizó ---
  {
    console.log("\n--- Caso 11: una credential liberada no vuelve a ser seleccionable por el cursor que ya la usó ---");
    const p = pool("A", "B");
    const cursor = p.beginOperation();
    const first = cursor.next(0); // A
    p.release("A", "success", 0); // se libera exitosa — vuelve a AVAILABLE a nivel pool
    const second = cursor.next(0); // debería dar B, nunca A de nuevo
    const third = cursor.next(0); // ya no queda nada para ESTE cursor
    check(
      "caso 11: A liberada con éxito no vuelve a aparecer para el mismo cursor",
      first.status === "AVAILABLE" && first.lease.id === "A" && second.status === "AVAILABLE" && second.lease.id === "B" && third.status === "NO_CREDENTIALS",
      { first, second, third },
    );
  }

  // --- Caso 12: un cursor nuevo sí puede usar una credential usada por una operación anterior, si sigue elegible ---
  {
    console.log("\n--- Caso 12: un cursor nuevo SÍ puede usar una credential ya usada por una operación anterior, si sigue elegible ---");
    const p = pool("A");
    const cursor1 = p.beginOperation();
    const r1 = cursor1.next(0);
    p.release("A", "success", 0);
    const cursor2 = p.beginOperation();
    const r2 = cursor2.next(0);
    check(
      "caso 12: cursor2 (operación nueva) SÍ puede volver a obtener A tras liberarse con éxito",
      r1.status === "AVAILABLE" && r1.lease.id === "A" && r2.status === "AVAILABLE" && r2.lease.id === "A",
      { r1, r2 },
    );
  }

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} casos OK.`);
  if (passed !== results.length) process.exit(1);
}

main();
