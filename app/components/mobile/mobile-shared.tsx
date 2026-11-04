import type { TaskStatus } from "@/lib/agent/task-store";

/**
 * Fase 3.2 — piezas compartidas de la PWA.
 *
 * Se mantienen mínimas y sin dependencias nuevas: la paleta y las
 * variables vienen de `globals.css` (que importa `app/layout.tsx`), así
 * que acá solo hay marcado y una que otra clase.
 */

const STATUS_LABELS: Record<TaskStatus, string> = {
  QUEUED: "En cola",
  RUNNING: "Corriendo",
  READY_FOR_REVIEW: "Lista para revisar",
  APPLYING: "Aplicando",
  APPLIED: "Aplicada",
  DISCARDED: "Descartada",
  FAILED: "Falló",
  NO_CHANGES: "Sin cambios",
  CANCELLED: "Cancelada",
  INTERRUPTED: "Interrumpida",
};

/** Estados que requieren atención humana ahora. */
const ATTENTION = new Set<TaskStatus>(["READY_FOR_REVIEW", "FAILED", "INTERRUPTED"]);

export function StatusPill({ status }: { status: TaskStatus }) {
  return (
    <span className={ATTENTION.has(status) ? "mPill attention" : "mPill"}>
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

export function statusLabel(status: TaskStatus): string {
  return STATUS_LABELS[status] ?? status;
}

export function timeAgo(ts: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 60) return "hace instantes";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  return `hace ${Math.round(hours / 24)} d`;
}

export function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}
