"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import { MobileNav } from "../../../components/mobile/mobile-nav";
import { StatusPill, statusLabel, timeAgo } from "../../../components/mobile/mobile-shared";
import { useTaskEventStream } from "../../../hooks/useTaskEventStream";
import type { TaskStatus } from "@/lib/agent/task-store";

/**
 * Fase 3.2/3.3 — detalle de una task desde el teléfono.
 *
 * Eventos en vivo vía SSE con reconexión y reanudación (`useTaskEventStream`).
 *
 * REGLA DE LA FASE: las acciones que MODIFICAN el proyecto (aplicar
 * cambios) quedan deshabilitadas hasta la Fase 4. Lo que sí se puede
 * hacer desde el teléfono es lo que no toca el proyecto: cancelar y
 * reanudar. Revisar propuestas es solo lectura.
 */

type Task = {
  id: string;
  projectId: string;
  modelId: string;
  prompt: string;
  status: TaskStatus;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
};

type Proposal = {
  id: string;
  path: string;
  kind: string;
  status: string;
  diff: string;
};

const CANCELLABLE: TaskStatus[] = ["QUEUED", "RUNNING"];
const RESUMABLE: TaskStatus[] = ["FAILED", "INTERRUPTED", "CANCELLED"];

export default function MobileTaskDetail() {
  const params = useParams<{ id: string }>();
  const taskId = params.id;

  const [task, setTask] = useState<Task | null>(null);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [status, setStatus] = useState<TaskStatus | null>(null);
  const [busy, setBusy] = useState<"" | "cancel" | "resume">("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const res = await fetch(`/api/agent/tasks/${encodeURIComponent(taskId)}`);
      if (!res.ok) throw new Error("task");
      const data = (await res.json()) as { task: Task };
      setTask(data.task);
      setStatus(data.task.status);
      const propRes = await fetch(`/api/agent/tasks/${encodeURIComponent(taskId)}/proposals`);
      if (propRes.ok) {
        const propData = (await propRes.json()) as { proposals: Proposal[] };
        setProposals(propData.proposals ?? []);
      }
    } catch {
      setError("No se pudo cargar la tarea.");
    }
  }, [taskId]);

  useEffect(() => {
    load();
  }, [load]);

  const stream = useTaskEventStream({
    taskId,
    onTaskSnapshot: (snapshot) => {
      setStatus(snapshot.status as TaskStatus);
      if (snapshot.conflictedPaths?.length) {
        setNote(`Rutas en conflicto: ${snapshot.conflictedPaths.join(", ")}`);
      }
    },
  });

  async function act(kind: "cancel" | "resume") {
    setBusy(kind);
    setError("");
    setNote("");
    try {
      const res = await fetch(`/api/agent/tasks/${encodeURIComponent(taskId)}/${kind}`, { method: "POST" });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? "No se pudo completar la acción.");
      }
      setNote(kind === "cancel" ? "Cancelación pedida." : "Reanudación pedida.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falló la acción.");
    } finally {
      setBusy("");
    }
  }

  const currentStatus = status ?? task?.status ?? null;

  return (
    <div className="mShell">
      <header className="mHeader">
        <div>
          <Link className="mBack" href="/m/tasks"><ChevronLeft size={16} /> Tareas</Link>
          <h1>Tarea</h1>
        </div>
        {currentStatus ? <StatusPill status={currentStatus} /> : null}
      </header>

      {error ? <p className="mError">{error}</p> : null}
      {note ? <p className="mNote">{note}</p> : null}

      {task ? (
        <section className="mSection">
          <p className="mPrompt">{task.prompt}</p>
          <dl className="mMeta">
            <div><dt>Proyecto</dt><dd>{task.projectId}</dd></div>
            <div><dt>Modelo</dt><dd>{task.modelId}</dd></div>
            <div><dt>Creada</dt><dd>{timeAgo(task.createdAt)}</dd></div>
            {task.finishedAt ? <div><dt>Terminada</dt><dd>{timeAgo(task.finishedAt)}</dd></div> : null}
            {task.error ? <div className="mMetaError"><dt>Error</dt><dd>{task.error}</dd></div> : null}
          </dl>

          <div className="mActions">
            {task && CANCELLABLE.includes(task.status) ? (
              <button type="button" className="mBtn" disabled={busy !== ""} onClick={() => act("cancel")}>
                {busy === "cancel" ? "Cancelando…" : "Cancelar"}
              </button>
            ) : null}
            {task && RESUMABLE.includes(task.status) ? (
              <button type="button" className="mBtn primary" disabled={busy !== ""} onClick={() => act("resume")}>
                {busy === "resume" ? "Reanudando…" : "Reanudar"}
              </button>
            ) : null}
          </div>

          {task.status === "READY_FOR_REVIEW" ? (
            <p className="mNotice">
              Hay propuestas listas para revisar. Aplicarlas requiere aprobación explícita desde la PC o,
              en la Fase 4, desde un dispositivo con scope <code>approve</code>.
            </p>
          ) : null}
        </section>
      ) : null}

      <section className="mSection">
        <div className="mSectionHead"><h2>Propuestas ({proposals.length})</h2></div>
        {proposals.length === 0 ? <p className="mEmpty">Sin propuestas todavía.</p> : null}
        {proposals.map((proposal) => (
          <article key={proposal.id} className="mProposal">
            <div className="mListHead">
              <span className="mPill">{proposal.status}</span>
              <span className="mTime">{proposal.kind}</span>
            </div>
            <p className="mListTitle">{proposal.path}</p>
            <pre>{proposal.diff.slice(0, 4000)}</pre>
          </article>
        ))}
      </section>

      <section className="mSection">
        <div className="mSectionHead">
          <h2>Eventos ({stream.events.length})</h2>
          <span className="mStreamState">
            {stream.status === "open" ? "en vivo" : stream.status === "connecting" ? "reconectando…" : "cerrado"}
          </span>
        </div>
        {currentStatus && !stream.events.length ? (
          <p className="mEmpty">Sin eventos. Último estado: {statusLabel(currentStatus)}</p>
        ) : null}
        <ol className="mTimeline">
          {stream.events.map((event) => (
            <li key={event.seq}>
              <span className="mTime">{new Date(event.ts).toLocaleTimeString("es")}</span>
              <div>
                <b>{event.kind}</b>
                <p>{JSON.stringify(event, (_k, v) => (typeof v === "string" && v.length > 200 ? `${v.slice(0, 200)}…` : v))}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <MobileNav active="tasks" />
    </div>
  );
}
