"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
// Solo tipos — no meten código de servidor (better-sqlite3, fs, etc.) al bundle del cliente.
import type { AgentProject } from "@/lib/agent/project-store";
import type { CodingTask, TaskStatus } from "@/lib/agent/task-store";
import type { AgentEvent, AgentEventPayload } from "@/lib/agent/event-log";
import type { FileProposal } from "@/lib/fs-tools";
import "./agent.css";

import { useAgentTaskEvents } from "./useAgentTaskEvents";

type CodingAgentModel = { id: string; label: string; shortName: string; maker: string };
type ProposalView = FileProposal & { applied: boolean; conflict: boolean };

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = await res.json();
  if (!res.ok || body.ok === false) throw new Error(body.error ?? `Error ${res.status} en ${url}`);
  return body as T;
}

/** Espejo liviano y puramente de presentación de `eventsToTranscript`
 * (`lib/agent/event-log.ts`) — no se puede importar esa función acá porque
 * el módulo entero de `event-log.ts` arrastra `lib/db.ts` (better-sqlite3),
 * que es código de servidor y no debe terminar en el bundle del cliente.
 * Es solo formato de texto, sin lógica de negocio, así que la duplicación
 * es aceptable. */
function formatEvent(event: AgentEvent): { text: string; kind: "err" | "ok" | "status" | "text" } {
  const p = event.payload as AgentEventPayload;
  if (p.type === "text") return { text: `💬 ${p.text}`, kind: "text" };
  if (p.type === "tool_call") return { text: `🔧 ${p.toolName}(${JSON.stringify(p.input).slice(0, 200)})`, kind: "text" };
  if (p.type === "tool_result" && !p.ok) return { text: `❌ ${p.toolName} falló: ${p.error ?? "sin detalle"}`, kind: "err" };
  if (p.type === "tool_result" && p.ok) return { text: `✏️  ${p.summary}`, kind: "ok" };
  if (p.type === "typecheck_result") {
    return p.success
      ? { text: "✅ run_typecheck: compila limpio", kind: "ok" }
      : { text: `❌ run_typecheck: hay errores —\n${p.outputExcerpt ?? ""}`, kind: "err" };
  }
  if (p.type === "status_change") return { text: `↻ ${p.from} → ${p.to}${p.reason ? ` (${p.reason})` : ""}`, kind: "status" };
  return { text: JSON.stringify(p), kind: "text" };
}

function DiffBlock({ diff }: { diff: string }) {
  return (
    <pre className="agentProposalDiff">
      {diff.split("\n").map((line, i) => (
        <div key={i} className={line.startsWith("+") ? "agentDiffAdd" : line.startsWith("-") ? "agentDiffDel" : undefined}>
          {line || " "}
        </div>
      ))}
    </pre>
  );
}

export default function AgentPage() {
  const [projects, setProjects] = useState<AgentProject[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [projectsError, setProjectsError] = useState("");
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectPath, setNewProjectPath] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);

  const [models, setModels] = useState<CodingAgentModel[]>([]);
  const [tasks, setTasks] = useState<CodingTask[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [newTaskPrompt, setNewTaskPrompt] = useState("");
  const [newTaskModelId, setNewTaskModelId] = useState("");
  const [creatingTask, setCreatingTask] = useState(false);
  const [taskFormError, setTaskFormError] = useState("");

  const [proposals, setProposals] = useState<ProposalView[]>([]);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState("");

  const selectedTask = useMemo(() => tasks.find((t) => t.id === selectedTaskId) ?? null, [tasks, selectedTaskId]);
  const { events, status: liveStatus, conflictedPaths: liveConflictedPaths } = useAgentTaskEvents(selectedTaskId);

  // --- Cargar proyectos y modelos habilitados una vez ---
  useEffect(() => {
    fetchJson<{ projects: AgentProject[] }>("/api/agent/projects")
      .then((r) => setProjects(r.projects))
      .catch((e) => setProjectsError(e.message));
    fetchJson<{ models: CodingAgentModel[] }>("/api/agent/models")
      .then((r) => {
        setModels(r.models);
        if (r.models.length > 0) setNewTaskModelId(r.models[0].id);
      })
      .catch(() => {});
  }, []);

  // --- Cargar/refrescar tasks del proyecto seleccionado ---
  useEffect(() => {
    if (!selectedProjectId) {
      setTasks([]);
      return;
    }
    let cancelled = false;
    const load = () =>
      fetchJson<{ tasks: CodingTask[] }>(`/api/agent/tasks?projectId=${selectedProjectId}`)
        .then((r) => {
          if (!cancelled) setTasks(r.tasks);
        })
        .catch(() => {});
    load();
    const interval = setInterval(load, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [selectedProjectId]);

  // --- El status más fresco es el que viene del SSE mientras hay conexión viva ---
  const effectiveStatus: TaskStatus | null = liveStatus ?? selectedTask?.status ?? null;
  const effectiveConflictedPaths = liveConflictedPaths ?? selectedTask?.conflictedPaths ?? null;

  // --- Cargar proposals cuando la task queda lista para revisar ---
  useEffect(() => {
    setProposals([]);
    setActionError("");
    if (!selectedTaskId || effectiveStatus !== "READY_FOR_REVIEW") return;
    fetchJson<{ proposals: ProposalView[] }>(`/api/agent/tasks/${selectedTaskId}/proposals`)
      .then((r) => setProposals(r.proposals))
      .catch((e) => setActionError(e.message));
  }, [selectedTaskId, effectiveStatus]);

  async function handleCreateProject(e: React.FormEvent) {
    e.preventDefault();
    setCreatingProject(true);
    setProjectsError("");
    try {
      const r = await fetchJson<{ project: AgentProject }>("/api/agent/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newProjectName, localPath: newProjectPath }),
      });
      setProjects((current) => [r.project, ...current]);
      setSelectedProjectId(r.project.id);
      setNewProjectName("");
      setNewProjectPath("");
    } catch (e) {
      setProjectsError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreatingProject(false);
    }
  }

  async function handleCreateTask(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedProjectId) return;
    setCreatingTask(true);
    setTaskFormError("");
    try {
      const r = await fetchJson<{ task: CodingTask }>("/api/agent/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: selectedProjectId, modelId: newTaskModelId, prompt: newTaskPrompt }),
      });
      setTasks((current) => [r.task, ...current]);
      setSelectedTaskId(r.task.id);
      setNewTaskPrompt("");
    } catch (e) {
      setTaskFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreatingTask(false);
    }
  }

  async function refreshSelectedTask() {
    if (!selectedTaskId) return;
    try {
      const r = await fetchJson<{ task: CodingTask }>(`/api/agent/tasks/${selectedTaskId}`);
      setTasks((current) => current.map((t) => (t.id === r.task.id ? r.task : t)));
    } catch {
      // best-effort — el SSE ya cubre el caso normal.
    }
  }

  async function handleApply() {
    if (!selectedTaskId) return;
    setActionBusy(true);
    setActionError("");
    try {
      await fetchJson(`/api/agent/tasks/${selectedTaskId}/apply`, { method: "POST" });
      await refreshSelectedTask();
      const r = await fetchJson<{ proposals: ProposalView[] }>(`/api/agent/tasks/${selectedTaskId}/proposals`);
      setProposals(r.proposals);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setActionBusy(false);
    }
  }

  async function handleDiscard() {
    if (!selectedTaskId) return;
    setActionBusy(true);
    setActionError("");
    try {
      await fetchJson(`/api/agent/tasks/${selectedTaskId}/discard`, { method: "POST" });
      await refreshSelectedTask();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setActionBusy(false);
    }
  }

  async function handleCancel() {
    if (!selectedTaskId) return;
    setActionBusy(true);
    setActionError("");
    try {
      await fetchJson(`/api/agent/tasks/${selectedTaskId}/cancel`, { method: "POST" });
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setActionBusy(false);
    }
  }

  return (
    <div className="agentPage">
      <aside className="agentSidebar">
        <Link href="/" className="agentBackLink">
          ← Volver a Consenso IA
        </Link>

        <div>
          <div className="agentSectionTitle">Proyectos</div>
          <div className="agentList">
            {projects.map((project) => (
              <button
                key={project.id}
                type="button"
                className={`agentListItem${project.id === selectedProjectId ? " active" : ""}`}
                onClick={() => {
                  setSelectedProjectId(project.id);
                  setSelectedTaskId(null);
                }}
              >
                {project.name}
                <small>
                  {project.localPath} · {project.isGitRepo ? "git" : "sin git"}
                </small>
              </button>
            ))}
            {projects.length === 0 && <div className="agentEmpty">Todavía no hay proyectos.</div>}
          </div>
        </div>

        <form className="agentForm" onSubmit={handleCreateProject}>
          <div className="agentSectionTitle">Agregar proyecto</div>
          <input placeholder="Nombre" value={newProjectName} onChange={(e) => setNewProjectName(e.target.value)} required />
          <input placeholder="Ruta local (ej. C:\\proyectos\\mi-app)" value={newProjectPath} onChange={(e) => setNewProjectPath(e.target.value)} required />
          <button className="agentButton" type="submit" disabled={creatingProject}>
            {creatingProject ? "Agregando…" : "Agregar"}
          </button>
          {projectsError && <div className="agentError">{projectsError}</div>}
        </form>

        {selectedProjectId && (
          <div>
            <div className="agentSectionTitle">Tasks</div>
            <div className="agentList">
              {tasks.map((task) => (
                <button
                  key={task.id}
                  type="button"
                  className={`agentListItem${task.id === selectedTaskId ? " active" : ""}`}
                  onClick={() => setSelectedTaskId(task.id)}
                >
                  {task.prompt.slice(0, 40)}
                  {task.prompt.length > 40 ? "…" : ""}
                  <small>
                    {task.status} · {new Date(task.createdAt).toLocaleString()}
                  </small>
                </button>
              ))}
              {tasks.length === 0 && <div className="agentEmpty">Sin tasks todavía.</div>}
            </div>
          </div>
        )}

        {selectedProjectId && (
          <form className="agentForm" onSubmit={handleCreateTask}>
            <div className="agentSectionTitle">Nueva Coding Task</div>
            <select value={newTaskModelId} onChange={(e) => setNewTaskModelId(e.target.value)} required>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            <textarea placeholder="¿Qué querés que haga el agente?" value={newTaskPrompt} onChange={(e) => setNewTaskPrompt(e.target.value)} required />
            <button className="agentButton" type="submit" disabled={creatingTask || models.length === 0}>
              {creatingTask ? "Creando…" : "Crear task"}
            </button>
            {models.length === 0 && <div className="agentError">No hay modelos habilitados para el Coding Agent.</div>}
            {taskFormError && <div className="agentError">{taskFormError}</div>}
          </form>
        )}
      </aside>

      <main className="agentMain">
        {!selectedTask ? (
          <div className="agentEmpty">Elegí o creá una Coding Task para ver su progreso acá.</div>
        ) : (
          <>
            <div className="agentTaskHeader">
              <span className={`agentBadge ${effectiveStatus ?? ""}`}>{effectiveStatus}</span>
              {(effectiveStatus === "QUEUED" || effectiveStatus === "RUNNING") && (
                <button className="agentButton danger" onClick={handleCancel} disabled={actionBusy}>
                  Cancelar
                </button>
              )}
              {effectiveStatus === "READY_FOR_REVIEW" && (
                <div className="agentActions">
                  <button className="agentButton" onClick={handleApply} disabled={actionBusy}>
                    Aplicar
                  </button>
                  <button className="agentButton secondary" onClick={handleDiscard} disabled={actionBusy}>
                    Descartar
                  </button>
                </div>
              )}
            </div>
            <div className="agentPrompt">{selectedTask.prompt}</div>
            {actionError && <div className="agentError">{actionError}</div>}
            {effectiveConflictedPaths && effectiveConflictedPaths.length > 0 && (
              <div className="agentError">Conflicto al aplicar en: {effectiveConflictedPaths.join(", ")}</div>
            )}

            <div className="agentEventLog">
              {events.map((event) => {
                const { text, kind } = formatEvent(event);
                return (
                  <div key={event.id} className={`agentEventLine ${kind}`}>
                    {text}
                  </div>
                );
              })}
              {events.length === 0 && <div className="agentEmpty">Sin eventos todavía.</div>}
            </div>

            {effectiveStatus === "READY_FOR_REVIEW" && (
              <div className="agentProposalList">
                {proposals.map((proposal) => (
                  <div key={proposal.id} className={`agentProposal${proposal.conflict ? " conflict" : ""}`}>
                    <div className="agentProposalHead">
                      <strong>{proposal.relPath}</strong>
                      <span>{proposal.kind}</span>
                      <span>typecheck: {proposal.typeCheck.status}</span>
                      {proposal.applied && <span>✅ aplicado</span>}
                      {proposal.conflict && <span>⚠️ conflicto (no se sobrescribió)</span>}
                    </div>
                    <DiffBlock diff={proposal.diff} />
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
