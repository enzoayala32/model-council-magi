/**
 * Tests del reducer del stream de eventos de task.
 *
 * Fijan el bug que se corregió: al reconectar tras un corte de red, el
 * timeline NO se vacía y no se pierden ni se duplican eventos. El reset
 * pasa solo cuando cambia la task.
 *
 * Uso: npm run security:test-task-stream-reducer
 */
import {
  initialTaskStreamState,
  parseTaskStreamEvent,
  taskStreamReducer,
  type TaskStreamAction,
  type TaskStreamState,
} from "./task-stream-reducer";

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passed += 1;
    console.log(`+ ${label}`);
    return;
  }
  failed += 1;
  console.log(`x ${label}${detail === undefined ? "" : ` - ${JSON.stringify(detail)}`}`);
}

/** Aplica una secuencia de acciones desde el estado inicial. */
function run(taskId: string, actions: TaskStreamAction[]): TaskStreamState {
  return actions.reduce(taskStreamReducer, initialTaskStreamState(taskId));
}

function eventPayload(seq: number, text: string): string {
  return JSON.stringify({ seq, ts: 1_000 + seq, type: "text", text });
}

function main(): void {
  console.log("== estado inicial ==\n");
  {
    const state = initialTaskStreamState("t1");
    check("arranca en connecting", state.status === "connecting");
    check("sin eventos", state.events.length === 0);
    check("sin cursor (lastSeq null)", state.lastSeq === null);
    check("recuerda la task", state.taskId === "t1");
  }

  console.log("\n== conexion inicial ==\n");
  {
    const state = run("t1", [
      { type: "opened" },
      { type: "message", raw: eventPayload(0, "uno") },
      { type: "message", raw: eventPayload(1, "dos") },
      { type: "message", raw: eventPayload(2, "tres") },
    ]);
    check("pasa a open", state.status === "open");
    check("entran los 3 eventos", state.events.length === 3, state.events.length);
    check("conserva el orden", state.events.map((e) => e.seq).join(",") === "0,1,2");
    check("lastSeq queda en el ultimo", state.lastSeq === 2, state.lastSeq);
  }

  console.log("\n== corte y reconexion (el bug) ==\n");
  {
    const before = run("t1", [
      { type: "opened" },
      { type: "message", raw: eventPayload(0, "uno") },
      { type: "message", raw: eventPayload(1, "dos") },
    ]);
    // Corte: el servidor reenvía lo que hay desde el cursor pedido.
    const afterDrop = taskStreamReducer(before, { type: "dropped" });
    check("el corte vuelve a connecting", afterDrop.status === "connecting");
    check("el corte NO borra eventos", afterDrop.events.length === 2, afterDrop.events.length);
    check("el corte conserva el cursor", afterDrop.lastSeq === 1, afterDrop.lastSeq);

    // Reconexión: `opened` otra vez. Ací estaba el bug — antes borraba.
    const afterOpen = taskStreamReducer(afterDrop, { type: "opened" });
    check("la reconexion NO borra los eventos", afterOpen.events.length === 2, afterOpen.events.length);
    check("la reconexion NO toca el cursor", afterOpen.lastSeq === 1, afterOpen.lastSeq);

    // Y llega solo lo nuevo (porque se pidió sinceSeq=1).
    const afterNew = taskStreamReducer(afterOpen, { type: "message", raw: eventPayload(2, "tres") });
    check("el evento nuevo entra", afterNew.events.length === 3, afterNew.events.length);
    check("no se duplicó ninguno", afterNew.events.map((e) => e.seq).join(",") === "0,1,2");
  }

  console.log("\n== dedup: reenvio del servidor ==\n");
  {
    // Si el servidor igual reenvía un bloque viejo, se descarta.
    const state = run("t1", [
      { type: "opened" },
      { type: "message", raw: eventPayload(0, "uno") },
      { type: "message", raw: eventPayload(1, "dos") },
      { type: "message", raw: eventPayload(0, "uno-otra-vez") },
      { type: "message", raw: eventPayload(1, "dos-otra-vez") },
    ]);
    check("un reenvio viejo se descarta", state.events.length === 2, state.events.length);
    check("no se pisa el contenido", state.events[0].text === "uno", state.events[0]);
    check("el cursor no retrocede", state.lastSeq === 1, state.lastSeq);
  }

  console.log("\n== cambio de task: si limpia ==\n");
  {
    const before = run("t1", [
      { type: "opened" },
      { type: "message", raw: eventPayload(0, "uno") },
      { type: "message", raw: eventPayload(1, "dos") },
    ]);
    const after = taskStreamReducer(before, { type: "task-changed", taskId: "t2" });
    check("cambia la task", after.taskId === "t2");
    check("vacia los eventos", after.events.length === 0, after.events.length);
    check("vacia el cursor", after.lastSeq === null, after.lastSeq);
    check("vuelve a connecting", after.status === "connecting");

    // Y acepta eventos desde el seq 0 de la task nueva.
    const withNew = taskStreamReducer(after, { type: "message", raw: eventPayload(0, "nuevo") });
    check("acepta el seq 0 de la task nueva", withNew.events.length === 1 && withNew.events[0].seq === 0);
  }

  console.log("\n== heartbeat y eventos partidos ==\n");
  {
    const base = run("t1", [{ type: "opened" }, { type: "message", raw: eventPayload(0, "uno") }]);
    // Un heartbeat llega como mensaje sin datos: el hook ni lo despacha, pero
    // el reducer también lo ignora por si acaso.
    const afterHeartbeat = taskStreamReducer(base, { type: "message", raw: "" });
    check("mensaje vacio (heartbeat) se ignora", afterHeartbeat.events.length === 1 && afterHeartbeat === base);

    const afterComment = taskStreamReducer(base, { type: "message", raw: "   " });
    check("payload no-JSON se ignora", afterComment.events.length === 1 && afterComment === base);

    // Evento partido por el corte: JSON incompleto.
    const afterPartial = taskStreamReducer(base, { type: "message", raw: '{"seq":3,"type":"tex' });
    check("evento partido se descarta", afterPartial.events.length === 1, afterPartial.events.length);
    check("evento partido no mueve el cursor", afterPartial.lastSeq === 0, afterPartial.lastSeq);

    // JSON sin cerrar: inválido por definición, se descarta igual (no existe
    // una "mitad parseable" de JSON).
    const partialButValid = taskStreamReducer(base, { type: "message", raw: '{"seq":3,"type":"text"' });
    check("JSON sin cerrar se descarta", partialButValid.events.length === 1, partialButValid.events.length);
    const cutEarlier = taskStreamReducer(base, { type: "message", raw: '{"seq":3' });
    check("JSON cortado antes del type se descarta", cutEarlier.events.length === 1);
  }

  console.log("\n== snapshot ==\n");
  {
    const withSnapshot = run("t1", [
      { type: "opened" },
      { type: "message", raw: eventPayload(0, "uno") },
      { type: "snapshot", status: "RUNNING", conflictedPaths: null },
    ]);
    check("guarda el snapshot", withSnapshot.snapshot?.status === "RUNNING");
    check("el snapshot no cuenta como evento", withSnapshot.events.length === 1);
    check("el snapshot no mueve el cursor", withSnapshot.lastSeq === 0);

    const changed = taskStreamReducer(withSnapshot, { type: "snapshot", status: "CANCELLED", conflictedPaths: ["a.ts"] });
    check("un snapshot distinto actualiza", changed.snapshot?.status === "CANCELLED");
    check("trae las rutas en conflicto", JSON.stringify(changed.snapshot?.conflictedPaths) === '["a.ts"]');

    const same = taskStreamReducer(withSnapshot, { type: "snapshot", status: "RUNNING", conflictedPaths: null });
    check("un snapshot repetido no cambia la identidad", same.snapshot === withSnapshot.snapshot);
  }

  console.log("\n== parseTaskStreamEvent ==\n");
  {
    check("parsea un evento normal", parseTaskStreamEvent(eventPayload(7, "hola"))?.seq === 7);
    check("marca el kind con el type", parseTaskStreamEvent(eventPayload(0, "x"))?.kind === "text");
    check("descarta string vacio", parseTaskStreamEvent("") === null);
    check("descarta JSON no-objeto", parseTaskStreamEvent('"texto"') === null);
    check("descarta objeto sin seq", parseTaskStreamEvent('{"type":"text"}') === null);
    check("descarta seq no numerico", parseTaskStreamEvent('{"seq":"1","type":"text"}') === null);
    check("descarta objeto sin type", parseTaskStreamEvent('{"seq":1}') === null);
    check("descarta JSON roto", parseTaskStreamEvent("{") === null);
  }

  console.log("\n== idempotencia y recorte ==\n");
  {
    const huge = "x".repeat(900);
    const state = run("t1", [
  
      { type: "opened" },
      { type: "message", raw: JSON.stringify({ seq: 0, ts: 1, type: "text", text: huge }) },
    ]);
    const text = String(state.events[0].text);
    check("un payload enorme se recorta", text.length < 900, text.length);
    check("el recorte marca el corte", text.endsWith("…"), text.slice(-5));

    const dup = taskStreamReducer(state, { type: "opened" });
    check("abrir dos veces no duplica nada", dup.events.length === 1 && dup === state);
  }

  console.log(`\n${passed}/${passed + failed} casos OK`);
  if (failed > 0) process.exit(1);
}

main();
