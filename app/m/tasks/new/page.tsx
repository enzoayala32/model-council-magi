"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { MobileNav } from "../../../components/mobile/mobile-nav";

/**
 * Fase 3.2 — crear una task desde el teléfono.
 *
 * `operate` es el scope mínimo para esto; hasta que exista la Fase 4,
 * cualquier host autenticado puede crear (es el mismo nivel que la UI de
 * escritorio). Crear NO ejecuta nada por sí solo: queda en cola y el
 * dispatcher de la PC la toma.
 */

type MobileProject = { id: string; name: string; path: string };
type AgentModel = { id: string; label: string; defaultSelected?: boolean };

export default function MobileNewTask() {
  const router = useRouter();
  const [projects, setProjects] = useState<MobileProject[]>([]);
  const [models, setModels] = useState<AgentModel[]>([]);
  const [projectId, setProjectId] = useState("");
  const [modelId, setModelId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const [projectRes, modelRes] = await Promise.all([
          fetch("/api/agent/projects").then((r) => r.json()),
          fetch("/api/agent/models").then((r) => r.json()),
        ]);
        setProjects(projectRes.projects ?? []);
        setModels(modelRes.models ?? []);
        if (projectRes.projects?.length) setProjectId(projectRes.projects[0].id);
        if (modelRes.models?.length) {
          const preferred = modelRes.models.find((m: AgentModel) => m.defaultSelected) ?? modelRes.models[0];
          setModelId(preferred.id);
        }
      } catch {
        setError("No se pudieron cargar proyectos y modelos.");
      }
    })();
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!prompt.trim() || !projectId || !modelId) {
      setError("Completá proyecto, modelo y prompt.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/agent/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, modelId, prompt: prompt.trim() }),
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; task?: { id: string } } | null;
      if (!res.ok || !data?.task) throw new Error(data?.error ?? "No se pudo crear la tarea.");
      router.push(`/m/tasks/${data.task.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falló la creación.");
      setBusy(false);
    }
  }

  return (
    <div className="mShell">
      <header className="mHeader">
        <div>
          <Link className="mBack" href="/m/tasks">← Tareas</Link>
          <h1>Nueva tarea</h1>
        </div>
      </header>

      <form className="mForm" onSubmit={submit}>
        <label className="mSelect">
          Proyecto
          <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>{project.name}</option>
            ))}
          </select>
        </label>

        <label className="mSelect">
          Modelo
          <select value={modelId} onChange={(event) => setModelId(event.target.value)}>
            {models.map((model) => (
              <option key={model.id} value={model.id}>{model.label}</option>
            ))}
          </select>
        </label>

        <label className="mField">
          Prompt
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={6}
            placeholder="Qué tiene que hacer el agente"
          />
        </label>

        {error ? <p className="mError">{error}</p> : null}

        <button type="submit" className="mBtn primary" disabled={busy}>
          {busy ? "Creando…" : "Crear tarea"}
        </button>
        <p className="mNote">
          Crear la tarea no aplica ningún cambio: queda en cola y se ejecuta en esta PC. Aplicar cambios
          requiere aprobación explícita.
        </p>
      </form>

      <MobileNav active="new" />
    </div>
  );
}
