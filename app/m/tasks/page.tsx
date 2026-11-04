"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { RefreshCw } from "lucide-react";
import { MobileNav } from "../../components/mobile/mobile-nav";
import { StatusPill, timeAgo } from "../../components/mobile/mobile-shared";
import type { TaskStatus } from "@/lib/agent/task-store";

/** Fase 3.2 — lista de tareas con filtros por estado y proyecto.
 *  Misma ruta que la vista del panel, con maquetación de teléfono. */

type MobileTask = {
  id: string;
  projectId: string;
  modelId: string;
  prompt: string;
  status: TaskStatus;
  createdAt: number;
  error: string | null;
};

type MobileProject = { id: string; name: string; path: string };

const STATUSES: TaskStatus[] = [
  "QUEUED", "RUNNING", "READY_FOR_REVIEW", "APPLYING", "APPLIED",
  "FAILED", "NO_CHANGES", "CANCELLED", "INTERRUPTED", "DISCARDED",
];

export default function MobileTasks() {
  const [tasks, setTasks] = useState<MobileTask[]>([]);
  const [projects, setProjects] = useState<Record<string, MobileProject>>({});
  const [statusFilter, setStatusFilter] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set("status", statusFilter);
      if (projectFilter) params.set("projectId", projectFilter);
      const qs = params.toString();
      const [taskRes, projectRes] = await Promise.all([
        fetch(`/api/agent/tasks${qs ? `?${qs}` : ""}`).then((r) => (r.ok ? r.json() : Promise.reject(new Error("tareas")))),
        fetch("/api/agent/projects").then((r) => (r.ok ? r.json() : Promise.reject(new Error("proyectos")))),
      ]);
      setTasks(taskRes.tasks ?? []);
      const map: Record<string, MobileProject> = {};
      for (const project of projectRes.projects ?? []) map[project.id] = project;
      setProjects(map);
    } catch {
      setError("No se pudieron cargar las tareas.");
    } finally {
      setLoading(false);
    }
  }, [statusFilter, projectFilter]);

  useEffect(() => {
    load();
  }, [load]);

  const grouped = useMemo(() => {
    const map = new Map<string, MobileTask[]>();
    for (const task of tasks) {
      const key = projects[task.projectId]?.name ?? task.projectId;
      map.set(key, [...(map.get(key) ?? []), task]);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [tasks, projects]);

  return (
    <div className="mShell">
      <header className="mHeader">
        <div>
          <span className="mBrand">Consenso IA</span>
          <h1>Tareas</h1>
        </div>
        <div className="mHeaderActions">
          <button type="button" className="mIconBtn" onClick={load} aria-label="Refrescar">
            <RefreshCw size={18} />
          </button>
          <Link className="mBtn small primary" href="/m/tasks/new">Nueva</Link>
        </div>
      </header>

      <div className="mFilters">
        <label className="mSelect">
          Estado
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
            <option value="">Todos</option>
            {STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}
          </select>
        </label>
        <label className="mSelect">
          Proyecto
          <select value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)}>
            <option value="">Todos</option>
            {Object.values(projects).map((project) => (
              <option key={project.id} value={project.id}>{project.name}</option>
            ))}
          </select>
        </label>
      </div>

      {error ? <p className="mError">{error}</p> : null}
      {loading ? <p className="mEmpty">Cargando…</p> : null}

      {grouped.map(([projectName, list]) => (
        <section className="mSection" key={projectName}>
          <div className="mSectionHead"><h2>{projectName}</h2><span className="mTime">{list.length}</span></div>
          <ul className="mList">
            {list.map((task) => (
              <li key={task.id}>
                <Link href={`/m/tasks/${task.id}`}>
                  <div className="mListHead">
                    <StatusPill status={task.status} />
                    <span className="mTime">{timeAgo(task.createdAt)}</span>
                  </div>
                  <p className="mListTitle">{task.prompt}</p>
                  <p className="mListMeta">{task.modelId}</p>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}

      <MobileNav active="tasks" />
    </div>
  );
}
