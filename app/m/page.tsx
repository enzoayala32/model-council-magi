"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Activity, FolderTree, ListChecks, RefreshCw } from "lucide-react";
import { MobileNav } from "../components/mobile/mobile-nav";
import { StatusPill, timeAgo } from "../components/mobile/mobile-shared";
import type { TaskStatus } from "@/lib/agent/task-store";

/**
 * Fase 3.2 — Panel de control móvil.
 *
 * Reusa los endpoints existentes tal cual (`/api/agent/tasks`,
 * `/api/council/runs`, `/api/agent/projects`): la PWA es otra cara de la
 * misma app, no una API paralela. Lo único nuevo es el shell y la
 * maquetación mobile-first.
 *
 * Fase 3.3: el SSE del detalle de task tiene reconexión con backoff y
 * reanudación por `?after=`, así que este listado se puede permitir ser
 * "suficientemente fresco" con refresco manual + revalidación al entrar.
 */

type MobileTask = {
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

type MobileProject = { id: string; name: string; path: string };

/** Estados que le interesan a alguien mirando el teléfono. */
const FILTERS: Array<{ key: string; label: string; match: TaskStatus[] | null }> = [
  { key: "activas", label: "Activas", match: ["QUEUED", "RUNNING", "APPLYING"] },
  { key: "revision", label: "Revisión", match: ["READY_FOR_REVIEW"] },
  { key: "fallidas", label: "Fallidas", match: ["FAILED", "INTERRUPTED"] },
  { key: "todas", label: "Todas", match: null },
];

export default function MobileHome() {
  const [tasks, setTasks] = useState<MobileTask[]>([]);
  const [projects, setProjects] = useState<Record<string, MobileProject>>({});
  const [runs, setRuns] = useState<Array<{ id: string; question: string; totalTokens: number; costUsd: number | null }>>([]);
  const [filter, setFilter] = useState("activas");
  const [projectFilter, setProjectFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const [taskRes, projectRes, runRes] = await Promise.all([
        fetch("/api/agent/tasks").then((r) => (r.ok ? r.json() : Promise.reject(new Error("tareas")))),
        fetch("/api/agent/projects").then((r) => (r.ok ? r.json() : Promise.reject(new Error("proyectos")))),
        fetch("/api/council/runs?limit=5").then((r) => (r.ok ? r.json() : Promise.reject(new Error("corridas")))),
      ]);
      setTasks(taskRes.tasks ?? []);
      const map: Record<string, MobileProject> = {};
      for (const project of projectRes.projects ?? []) map[project.id] = project;
      setProjects(map);
      setRuns(runRes.runs ?? []);
    } catch {
      setError("No se pudieron cargar los datos. ¿Sesión válida?");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const visible = useMemo(() => {
    const active = FILTERS.find((f) => f.key === filter) ?? FILTERS[0];
    return tasks
      .filter((task) => (active.match ? active.match.includes(task.status) : true))
      .filter((task) => (projectFilter ? task.projectId === projectFilter : true))
      .sort((a, b) => b.createdAt - a.createdAt);
  }, [tasks, filter, projectFilter]);

  return (
    <div className="mShell">
      <header className="mHeader">
        <div>
          <span className="mBrand">Consenso IA</span>
          <h1>Control</h1>
        </div>
        <button type="button" className="mIconBtn" onClick={load} aria-label="Refrescar">
          <RefreshCw size={18} />
        </button>
      </header>

      <div className="mStats">
        <div><span>Activas</span><b>{tasks.filter((t) => t.status === "RUNNING" || t.status === "QUEUED").length}</b></div>
        <div><span>Revisión</span><b>{tasks.filter((t) => t.status === "READY_FOR_REVIEW").length}</b></div>
        <div><span>Corridas</span><b>{runs.length}</b></div>
      </div>

      <section className="mSection">
        <div className="mSectionHead">
          <h2><ListChecks size={16} /> Tareas</h2>
          <Link className="mLink" href="/m/tasks/new">Nueva</Link>
        </div>

        <div className="mFilters">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              className={filter === f.key ? "mChip active" : "mChip"}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>

        <label className="mSelect">
          Proyecto
          <select value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)}>
            <option value="">Todos</option>
            {Object.values(projects).map((project) => (
              <option key={project.id} value={project.id}>{project.name}</option>
            ))}
          </select>
        </label>

        {error ? <p className="mError">{error}</p> : null}
        {loading ? <p className="mEmpty">Cargando…</p> : null}

        {!loading && !error && visible.length === 0 ? (
          <p className="mEmpty">No hay tareas con ese filtro.</p>
        ) : null}

        <ul className="mList">
          {visible.map((task) => (
            <li key={task.id}>
              <Link href={`/m/tasks/${task.id}`}>
                <div className="mListHead">
                  <StatusPill status={task.status} />
                  <span className="mTime">{timeAgo(task.createdAt)}</span>
                </div>
                <p className="mListTitle">{task.prompt}</p>
                <p className="mListMeta">
                  <FolderTree size={12} /> {projects[task.projectId]?.name ?? task.projectId}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section className="mSection">
        <div className="mSectionHead"><h2><Activity size={16} /> Últimas corridas del consejo</h2></div>
        {runs.length === 0 ? <p className="mEmpty">Todavía no hay corridas persistidas.</p> : null}
        <ul className="mList">
          {runs.map((run) => (
            <li key={run.id}>
              <Link href={`/m/runs/${run.id}`}>
                <p className="mListTitle">{run.question || "(sin pregunta)"}</p>
                <p className="mListMeta">{run.totalTokens.toLocaleString("es")} tokens</p>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <MobileNav active="home" />
    </div>
  );
}
