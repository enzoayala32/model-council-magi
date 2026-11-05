/**
 * Reducer puro del stream de eventos de una task.
 *
 * Por qué existe como módulo aparte: la lógica de "qué eventos entran al
 * timeline" tenía un bug real. Al mover el reset de eventos a `onopen`
 * (para cumplir `react-hooks/set-state-in-effect`), cada reconexión
 * automática tras un corte de red borraba el timeline, y como el servidor
 * reenvía el historial COMPLETO cuando la reconexión no lleva cursor, el
 * dedup por `seq` descartaba todo: el usuario veía un timeline vacío
 * justo después de un corte.
 *
 * Acá esa lógica es pura y testeable, con dos reglas explícitas:
 * 1. El reset (eventos + último seq visto) pasa SOLO cuando cambia la
 *    task, nunca al (re)conectar.
 * 2. La reconexión pide `?sinceSeq=<último seq visto>`: el servidor
 *    reenvía solo lo nuevo, así que no hay nada que descartar.
 *
 * El dedup por `seq <= lastSeq` es correcto porque `listEvents` ordena
 * por `seq ASC` y el handler envía en ese orden.
 */

export type TaskStreamEvent = {
  seq: number;
  ts: number;
  kind: string;
  [key: string]: unknown;
};

export type TaskStreamStatus = "connecting" | "open";

export type TaskStreamState = {
  status: TaskStreamStatus;
  /** Task a la que pertenece el timeline actual. */
  taskId: string;
  events: TaskStreamEvent[];
  /** Último `seq` incorporado, o null si no llegó ninguno. Es el cursor
   *  que se manda en la reconexión. */
  lastSeq: number | null;
  /** Snapshot más reciente reportado por el servidor. */
  snapshot: { status: string; conflictedPaths: string[] | null } | null;
};

export type TaskStreamAction =
  /** La task cambió: se descarta todo el timeline. */
  | { type: "task-changed"; taskId: string }
  /** Conexión abierta (o reabierta). NO toca los eventos. */
  | { type: "opened" }
  /** Llegó un mensaje del stream con su payload crudo. */
  | { type: "message"; raw: string }
  /** Llegó el snapshot periódico (`event: task`). */
  | { type: "snapshot"; status: string; conflictedPaths: string[] | null }
  /** Corte de red: vuelve a "connecting" sin perder nada. */
  | { type: "dropped" };

export function initialTaskStreamState(taskId: string): TaskStreamState {
  return { status: "connecting", taskId, events: [], lastSeq: null, snapshot: null };
}

/** Payload del snapshot que manda el handler con `event: task`. */
type SnapshotPayload = { status: string; conflictedPaths: string[] | null };

function isSnapshotPayload(value: unknown): value is SnapshotPayload {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.status === "string";
}

/**
 * Convierte el `data` de un mensaje SSE en un evento, o `null` si no sirve.
 * Descarta sin lanzar: JSON roto (evento partido por un corte), objetos sin
 * `seq` numérico y snapshots (esos van por otra acción).
 */
export function parseTaskStreamEvent(raw: string): TaskStreamEvent | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.seq !== "number" || !Number.isFinite(record.seq)) return null;
  if (typeof record.type !== "string") return null;
  return { ...record, seq: record.seq, ts: typeof record.ts === "number" ? record.ts : Date.now(), kind: record.type } as TaskStreamEvent;
}

/** Strings largos se recortan: un payload enorme no puede tildar la UI. */
const MAX_FIELD_CHARS = 400;
function truncate(value: unknown): unknown {
  if (typeof value === "string" && value.length > MAX_FIELD_CHARS) return `${value.slice(0, MAX_FIELD_CHARS)}…`;
  return value;
}

export function taskStreamReducer(state: TaskStreamState, action: TaskStreamAction): TaskStreamState {
  switch (action.type) {
    case "task-changed":
      return initialTaskStreamState(action.taskId);

    case "opened":
      // Solo el estado de la conexión. Los eventos NO se tocan: es la regla
      // que arregla el timeline vacío tras un corte.
      return state.status === "open" ? state : { ...state, status: "open" };

    case "dropped":
      return state.status === "connecting" ? state : { ...state, status: "connecting" };

    case "message": {
      // Un snapshot llega como mensaje normal en algunas versiones del
      // handler: se reconoce y se trata como tal.
      let parsedForSnapshot: unknown = null;
      try {
        parsedForSnapshot = JSON.parse(action.raw);
      } catch {
        parsedForSnapshot = null;
      }
      if (isSnapshotPayload(parsedForSnapshot)) {
        return { ...state, snapshot: { status: parsedForSnapshot.status, conflictedPaths: parsedForSnapshot.conflictedPaths ?? null } };
      }

      const event = parseTaskStreamEvent(action.raw);
      if (!event) return state;
      // Dedup: el servidor manda en orden ascendente, así que todo lo que no
      // sea estrictamente posterior ya está (o es un reenvío del replay).
      if (state.lastSeq !== null && event.seq <= state.lastSeq) return state;

      const truncated = Object.fromEntries(Object.entries(event).map(([key, value]) => [key, truncate(value)])) as TaskStreamEvent;
      return { ...state, events: [...state.events, truncated], lastSeq: event.seq };
    }

    case "snapshot":
      if (state.snapshot && state.snapshot.status === action.status) return state;
      return { ...state, snapshot: { status: action.status, conflictedPaths: action.conflictedPaths } };

    default:
      return state;
  }
}
