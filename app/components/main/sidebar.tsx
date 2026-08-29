import { useMemo, useState } from "react";
import Link from "next/link";
import { ChevronDown, Plus, Search, Sparkles, Star, Trash2, Wrench, Code2 } from "lucide-react";
import type { RunModel } from "../../lib/client-types";
import type { StoredThread, StoredTurn } from "@/lib/threads";
import { INITIAL_MODELS } from "../../lib/constants";
import { compactQuestion, timeAgo } from "../../lib/client-helpers";
import { ModelBadge, MarkdownLite } from "./shared";

export function Sidebar({
  threads, activeThreadId, onNewThread, onSelectThread, onDeleteThread, onToggleFavorite, onOpenSettings,
}: {
  threads: StoredThread[];
  activeThreadId: string | null;
  onNewThread: () => void;
  onSelectThread: (id: string) => void;
  onDeleteThread: (id: string) => void;
  onToggleFavorite: (id: string) => void;
  onOpenSettings: () => void;
}) {
  const [search, setSearch] = useState("");
  const [favoritesOnly, setFavoritesOnly] = useState(false);

  const sorted = useMemo(() => {
    const term = search.trim().toLowerCase();
    return [...threads]
      .filter((thread) => (favoritesOnly ? thread.favorite : true))
      .filter((thread) => {
        if (!term) return true;
        if (thread.title.toLowerCase().includes(term)) return true;
        return thread.turns.some(
          (turn) => turn.question.toLowerCase().includes(term) || turn.synthesis.toLowerCase().includes(term),
        );
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [threads, search, favoritesOnly]);

  return (
    <aside className="sidebar">
      <div className="sidebarBrand">
        <span>Consenso IA</span>
      </div>

      <button className="newThread" type="button" onClick={onNewThread}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <Plus size={16} /> Nuevo hilo
        </span>
        <kbd>⌘K</kbd>
      </button>

      <div className="sidebarSearch">
        <Search size={14} />
        <input
          type="text"
          placeholder="Buscar en el historial…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <button
          type="button"
          className={favoritesOnly ? "sidebarFavToggle active" : "sidebarFavToggle"}
          aria-label="Mostrar solo favoritos"
          title="Mostrar solo favoritos"
          onClick={() => setFavoritesOnly((v) => !v)}
        >
          <Star size={14} fill={favoritesOnly ? "currentColor" : "none"} />
        </button>
      </div>

      <div className="sidebarSection">Hilos</div>
      <div className="sidebarThreads">
        {sorted.length === 0 ? (
          <p className="sidebarEmpty">
            {threads.length === 0
              ? "Todavía no hay hilos. Hacele una pregunta al consenso para empezar."
              : "Ningún hilo coincide con la búsqueda."}
          </p>
        ) : (
          sorted.map((thread) => {
            const turnCount = thread.turns.length;
            const isActive = thread.id === activeThreadId;
            return (
              <div
                key={thread.id}
                className={isActive ? "sidebarThreadRow active" : "sidebarThreadRow"}
              >
                <button
                  className="sidebarThread"
                  type="button"
                  onClick={() => onSelectThread(thread.id)}
                  title={thread.title}
                >
                  <span className="sidebarThreadTitle">{thread.title}</span>
                  <span className="sidebarThreadMeta">
                    {turnCount} {turnCount === 1 ? "turno" : "turnos"} · {timeAgo(thread.updatedAt)}
                  </span>
                </button>
                <button
                  className={thread.favorite ? "sidebarThreadFav active" : "sidebarThreadFav"}
                  type="button"
                  aria-label={thread.favorite ? `Quitar ${thread.title} de favoritos` : `Marcar ${thread.title} como favorito`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onToggleFavorite(thread.id);
                  }}
                >
                  <Star size={13} fill={thread.favorite ? "currentColor" : "none"} />
                </button>
                <button
                  className="sidebarThreadDelete"
                  type="button"
                  aria-label={`Eliminar ${thread.title}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (window.confirm(`¿Eliminar el hilo "${thread.title}"?`)) onDeleteThread(thread.id);
                  }}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            );
          })
        )}
      </div>

      <div className="sidebarFoot">
        <Link href="/agent" className="sidebarSettings" style={{ textDecoration: "none" }}>
          <Code2 size={15} />
          <span>Coding Agent</span>
        </Link>
        <button className="sidebarSettings" type="button" onClick={onOpenSettings}>
          <Wrench size={15} />
          <span>Ajustes</span>
        </button>
        <button className="sidebarUser" type="button">
          <div className="avatar">T</div>
          <div className="userMeta">
            <strong>Tú</strong>
            <span>Consenso IA · {threads.length} {threads.length === 1 ? "hilo" : "hilos"}</span>
          </div>
          <ChevronDown size={14} />
        </button>
      </div>
    </aside>
  );
}

export function PastTurnsFeed({
  turns, models, onOpenModel,
}: {
  turns: StoredTurn[];
  models: RunModel[];
  onOpenModel: (id: string) => void;
}) {
  return (
    <div className="pastTurns">
      {turns.map((turn, index) => (
        <article className="pastTurn" key={turn.id}>
          <header className="pastTurnHeader">
            <span className="pastTurnLabel">Turno {index + 1}</span>
            <h2>{compactQuestion(turn.question)}</h2>
          </header>
          {turn.synthesis ? (
            <details className="pastTurnAnswer">
              <summary>
                <Sparkles size={13} /> Synthesized answer
                <span className="pastTurnHint">click to expand</span>
              </summary>
              <MarkdownLite content={turn.synthesis} />
            </details>
          ) : (
            <p className="pastTurnEmpty">
              {turn.status === "stopped" ? "Generation stopped." : "No synthesis was produced for this turn."}
            </p>
          )}
          {turn.models.length ? (
            <div className="pastTurnModels">
              {turn.models.map((m) => {
                const live = models.find((x) => x.id === m.id);
                return (
                  <button
                    key={m.id}
                    type="button"
                    className="pastTurnModel"
                    onClick={() => {
                      // Hydrate this model's stored response into live state for the modal preview.
                      if (live) {
                        // Snapshot the stored content into live model list for the modal to read.
                        live.response = m.response;
                        live.critique = m.critique;
                        live.revisedAnswer = m.revisedAnswer;
                      }
                      onOpenModel(m.id);
                    }}
                  >
                    <ModelBadge
                      model={{ ...(live ?? INITIAL_MODELS.find((x) => x.id === m.id)!), ...m }}
                      small
                    />
                    {m.label}
                  </button>
                );
              })}
            </div>
          ) : null}
        </article>
      ))}
    </div>
  );
}

