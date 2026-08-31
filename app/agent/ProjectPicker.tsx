"use client";

import { useEffect, useMemo, useState } from "react";

type BrowseEntry = { name: string; path: string };
type ShortcutEntry = { name: string; path: string };
type InspectResult = {
  path: string;
  isGitRepo: boolean;
  workspaceMode: "worktree" | "copy";
  hasPackageJson: boolean;
  packageName: string | null;
  hasTypeScript: boolean;
  scripts: string[];
};

const PINNED_KEY = "magi.projectPicker.pinned";
const RECENT_KEY = "magi.projectPicker.recent";
const MAX_RECENT = 6;

/** Acceso rápido y recientes viven en `localStorage` del navegador, NO en
 * el server — son un atajo puramente de UI para este usuario en esta
 * máquina, no un dato del Coding Agent que otra parte del sistema
 * necesite (a diferencia de `agent_projects`, que sí es la fuente de
 * verdad de qué proyectos existen). Evita sumar schema nuevo para algo
 * que es, en esencia, una preferencia de navegación. */
function readLocalList(key: string): ShortcutEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLocalList(key: string, list: ShortcutEntry[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(list));
  } catch {
    // localStorage lleno o deshabilitado (ej. modo privado) — se pierde el
    // atajo, no la funcionalidad de elegir la carpeta.
  }
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** Separa una ruta absoluta en breadcrumbs clickeables, cada uno con la
 * ruta acumulada hasta ese punto — permite saltar directo a cualquier
 * nivel en vez de subir de a uno con "..". Soporta rutas Windows
 * (`C:\Users\...`) y POSIX (`/home/...`). */
function toBreadcrumbs(p: string): { label: string; path: string }[] {
  const isWindowsDrive = /^[a-zA-Z]:[\\/]/.test(p);
  const sep = p.includes("\\") ? "\\" : "/";
  const isPosixAbsolute = !isWindowsDrive && p.startsWith("/");
  const parts = p.split(/[\\/]+/).filter(Boolean);
  const crumbs: { label: string; path: string }[] = [];

  let acc = "";
  parts.forEach((part, i) => {
    if (i === 0 && isWindowsDrive) {
      acc = `${part}${sep}`;
      crumbs.push({ label: part, path: acc });
      return;
    }
    if (i === 0 && isPosixAbsolute) {
      acc = `/${part}`;
      crumbs.push({ label: part, path: acc });
      return;
    }
    acc = acc ? `${acc}${sep}${part}` : part;
    crumbs.push({ label: part, path: acc });
  });

  if (isPosixAbsolute && crumbs.length === 0) return [{ label: "/", path: "/" }];
  return crumbs;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok || body.ok === false) throw new Error(body.error ?? `Error ${res.status} en ${url}`);
  return body as T;
}

/**
 * Project Picker: reemplaza el navegador de carpetas simple por un flujo
 * completo — acceso rápido / recientes → navegar o pegar una ruta →
 * elegir carpeta → análisis automático (git, package.json, TypeScript,
 * scripts) → confirmar.
 */
export function ProjectPicker({ onChoose, onClose }: { onChoose: (path: string, suggestedName: string) => void; onClose: () => void }) {
  const [pinned, setPinned] = useState<ShortcutEntry[]>([]);
  const [recent, setRecent] = useState<ShortcutEntry[]>([]);
  const [queryInput, setQueryInput] = useState("");

  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<BrowseEntry[]>([]);
  const [drives, setDrives] = useState<string[]>([]);
  const [browseError, setBrowseError] = useState("");
  const [loading, setLoading] = useState(true);

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [inspect, setInspect] = useState<InspectResult | null>(null);
  const [inspectLoading, setInspectLoading] = useState(false);
  const [inspectError, setInspectError] = useState("");

  useEffect(() => {
    setPinned(readLocalList(PINNED_KEY));
    setRecent(readLocalList(RECENT_KEY));
  }, []);

  function browseTo(targetPath?: string) {
    setLoading(true);
    setBrowseError("");
    setSelectedPath(null);
    setInspect(null);
    setInspectError("");
    const url = targetPath ? `/api/agent/browse?path=${encodeURIComponent(targetPath)}` : "/api/agent/browse";
    fetchJson<{ path: string; parent: string | null; entries: BrowseEntry[]; drives: string[] }>(url)
      .then((r) => {
        setCurrentPath(r.path);
        setParent(r.parent);
        setEntries(r.entries);
        setDrives(r.drives);
        setQueryInput(r.path);
      })
      .catch((e) => setBrowseError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    browseTo();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function selectFolder(p: string) {
    setSelectedPath(p);
    setInspectError("");
    setInspectLoading(true);
    setInspect(null);
    fetchJson<InspectResult>(`/api/agent/inspect?path=${encodeURIComponent(p)}`)
      .then((r) => setInspect(r))
      .catch((e) => setInspectError(e instanceof Error ? e.message : String(e)))
      .finally(() => setInspectLoading(false));
  }

  function jumpToQuery(e: React.FormEvent) {
    e.preventDefault();
    if (!queryInput.trim()) return;
    browseTo(queryInput.trim());
  }

  function togglePin(entry: ShortcutEntry) {
    setPinned((current) => {
      const exists = current.some((p) => p.path === entry.path);
      const next = exists ? current.filter((p) => p.path !== entry.path) : [...current, entry];
      writeLocalList(PINNED_KEY, next);
      return next;
    });
  }

  function isPinned(p: string): boolean {
    return pinned.some((entry) => entry.path === p);
  }

  function pickAndClose(p: string) {
    const suggestedName = baseName(p);
    setRecent((current) => {
      const withoutDup = current.filter((entry) => entry.path !== p);
      const next = [{ name: suggestedName, path: p }, ...withoutDup].slice(0, MAX_RECENT);
      writeLocalList(RECENT_KEY, next);
      return next;
    });
    onChoose(p, suggestedName);
  }

  const breadcrumbs = useMemo(() => (currentPath ? toBreadcrumbs(currentPath) : []), [currentPath]);

  return (
    <div className="agentModalOverlay" onClick={onClose}>
      <div className="agentModal agentProjectPicker" onClick={(e) => e.stopPropagation()}>
        <div className="agentSectionTitle">Seleccionar proyecto</div>

        <form className="agentPickerSearch" onSubmit={jumpToQuery}>
          <input placeholder="Buscar carpeta o pegar una ruta completa…" value={queryInput} onChange={(e) => setQueryInput(e.target.value)} />
          <button type="submit" className="agentButton secondary">
            Ir
          </button>
        </form>

        {pinned.length > 0 && (
          <div className="agentPickerSection">
            <div className="agentPickerSectionTitle">📌 Acceso rápido</div>
            <div className="agentPickerShortcutList">
              {pinned.map((entry) => (
                <button key={entry.path} type="button" className="agentPickerShortcut" title={entry.path} onClick={() => selectFolder(entry.path)}>
                  📁 {entry.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {recent.length > 0 && (
          <div className="agentPickerSection">
            <div className="agentPickerSectionTitle">🕒 Recientes</div>
            <div className="agentPickerShortcutList">
              {recent.map((entry) => (
                <button key={entry.path} type="button" className="agentPickerShortcut" title={entry.path} onClick={() => selectFolder(entry.path)}>
                  📁 {entry.name}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="agentPickerSection">
          <div className="agentPickerSectionTitle">📂 Navegar</div>
          <div className="agentBreadcrumbs">
            {breadcrumbs.map((crumb, i) => (
              <span key={crumb.path}>
                <button type="button" className="agentBreadcrumbBtn" onClick={() => browseTo(crumb.path)}>
                  {crumb.label}
                </button>
                {i < breadcrumbs.length - 1 && <span className="agentBreadcrumbSep">›</span>}
              </span>
            ))}
          </div>
          {browseError && <div className="agentError">{browseError}</div>}
          <div className="agentBrowseList">
            {loading && <div className="agentEmpty">Cargando…</div>}
            {!loading && parent !== null && (
              <button type="button" className="agentListItem" onClick={() => browseTo(parent!)}>
                .. (subir)
              </button>
            )}
            {!loading &&
              drives.map((drive) => (
                <button key={drive} type="button" className="agentListItem" onClick={() => browseTo(drive)}>
                  💽 {drive}
                </button>
              ))}
            {!loading &&
              entries.map((entry) => (
                <div key={entry.path} className={`agentBrowseRow${selectedPath === entry.path ? " selected" : ""}`}>
                  <button
                    type="button"
                    className="agentBrowseRowMain"
                    title="Un click para seleccionar, doble click para entrar"
                    onClick={() => selectFolder(entry.path)}
                    onDoubleClick={() => browseTo(entry.path)}
                  >
                    📁 {entry.name}
                  </button>
                  <button
                    type="button"
                    className="agentPinToggle"
                    title={isPinned(entry.path) ? "Quitar de acceso rápido" : "Fijar en acceso rápido"}
                    onClick={() => togglePin({ name: entry.name, path: entry.path })}
                  >
                    {isPinned(entry.path) ? "📌" : "📍"}
                  </button>
                </div>
              ))}
            {!loading && entries.length === 0 && drives.length === 0 && parent === null && <div className="agentEmpty">Sin subcarpetas acá.</div>}
          </div>
        </div>

        {selectedPath && (
          <div className="agentPickerAnalysis">
            <div className="agentPickerSectionTitle">Carpeta elegida</div>
            <div className="agentBrowsePath">{selectedPath}</div>
            {inspectLoading && <div className="agentEmpty">Analizando…</div>}
            {inspectError && <div className="agentError">{inspectError}</div>}
            {inspect && (
              <div className="agentInspectGrid">
                <span className={`agentInspectBadge ${inspect.isGitRepo ? "yes" : "no"}`}>{inspect.isGitRepo ? "✅ Repo git" : "⚠️ No es un repo git"}</span>
                <span className="agentInspectBadge neutral">{inspect.workspaceMode === "worktree" ? "Usará git worktree" : "Usará copia temporal aislada"}</span>
                <span className={`agentInspectBadge ${inspect.hasPackageJson ? "yes" : "no"}`}>
                  {inspect.hasPackageJson ? `✅ package.json${inspect.packageName ? ` (${inspect.packageName})` : ""}` : "Sin package.json"}
                </span>
                {inspect.hasPackageJson && <span className={`agentInspectBadge ${inspect.hasTypeScript ? "yes" : "neutral"}`}>{inspect.hasTypeScript ? "✅ TypeScript" : "JavaScript"}</span>}
                {inspect.scripts.length > 0 && <span className="agentInspectBadge neutral">Scripts: {inspect.scripts.join(", ")}</span>}
              </div>
            )}
            <button type="button" className="agentButton secondary agentPinCurrentBtn" onClick={() => togglePin({ name: baseName(selectedPath), path: selectedPath })}>
              {isPinned(selectedPath) ? "📌 Quitar de acceso rápido" : "📌 Fijar en acceso rápido"}
            </button>
          </div>
        )}

        <div className="agentActions">
          <button className="agentButton" type="button" disabled={!selectedPath} onClick={() => selectedPath && pickAndClose(selectedPath)}>
            Seleccionar
          </button>
          <button className="agentButton secondary" type="button" onClick={onClose}>
            Cancelar
          </button>
        </div>
      </div>
    </div>
  );
}
