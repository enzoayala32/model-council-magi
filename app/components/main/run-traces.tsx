"use client";

import { useEffect, useMemo, useState } from "react";
import { Activity, ChevronLeft, ChevronRight, Clock3, Download, GitCompareArrows, Pause, Play } from "lucide-react";
import {
  describeEvent,
  formatDurationMs,
  type CouncilRunDetail,
  type CouncilRunEvent,
  type CouncilRunRecord,
  type RunComparison,
} from "@/lib/council-run-trace";
import { formatUsd } from "@/lib/model-pricing";

type CompareResponse = {
  a: CouncilRunRecord;
  b: CouncilRunRecord;
  comparison: RunComparison;
};

const DEBATE_EVENT_TYPES = new Set([
  "model_debate_complete",
  "debate_round_complete",
  "debate_skipped",
  "model_mind_change",
  "vote_cast",
  "vote_tally_complete",
]);

function text(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === "string" ? value : "";
}

function number(payload: Record<string, unknown>, key: string): number {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function statusLabel(status: CouncilRunRecord["status"]): string {
  if (status === "complete") return "Completa";
  if (status === "running") return "En curso";
  if (status === "stopped") return "Detenida";
  return "Error";
}

function shortQuestion(question: string): string {
  const clean = question.replace(/\s+/g, " ").trim();
  return clean.length > 54 ? `${clean.slice(0, 54)}…` : clean || "(sin pregunta)";
}

export function RunTraces({ runId, threadId, question }: { runId: string | null; threadId: string | null; question: string }) {
  const [runs, setRuns] = useState<CouncilRunRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(runId);
  const [detail, setDetail] = useState<CouncilRunDetail | null>(null);
  const [error, setError] = useState("");
  const [compareA, setCompareA] = useState("");
  const [compareB, setCompareB] = useState("");
  const [comparison, setComparison] = useState<CompareResponse | null>(null);
  const [comparing, setComparing] = useState(false);
  const [replayIndex, setReplayIndex] = useState(0);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const params = threadId ? `?threadId=${encodeURIComponent(threadId)}` : "";
    fetch(`/api/council/runs${params}`)
      .then(async (response) => {
        if (!response.ok) throw new Error("No se pudieron cargar las corridas.");
        return (await response.json()) as { runs: CouncilRunRecord[] };
      })
      .then((data) => {
        if (cancelled) return;
        setRuns(data.runs);
        setSelectedId((current) => {
          if (runId && (data.runs.some((run) => run.id === runId) || !current)) return runId;
          if (current && data.runs.some((run) => run.id === current)) return current;
          return data.runs[0]?.id ?? runId ?? null;
        });
        if (data.runs.length >= 2) {
          setCompareA((current) => current || data.runs[1].id);
          setCompareB((current) => current || data.runs[0].id);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "No se pudieron cargar las corridas.");
      });
    return () => {
      cancelled = true;
    };
  }, [threadId, runId]);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    fetch(`/api/council/runs/${encodeURIComponent(selectedId)}`)
      .then(async (response) => {
        if (!response.ok) throw new Error("No se pudo cargar la corrida.");
        return (await response.json()) as CouncilRunDetail;
      })
      .then((data) => {
        if (cancelled) return;
        setDetail(data);
        setReplayIndex(0);
        setPlaying(false);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "No se pudo cargar la corrida.");
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  // Derivado, no estado: hay carga mientras la corrida seleccionada todavía
  // no es la que está en `detail`. Evita un setState sincrónico en el effect.
  const loading = Boolean(selectedId) && !error && detail?.run.id !== selectedId;

  const debateEvents = useMemo(
    () => (detail?.events ?? []).filter((event) => DEBATE_EVENT_TYPES.has(event.type)),
    [detail],
  );

  useEffect(() => {
    if (!playing) return;
    const timer = setTimeout(() => {
      if (replayIndex >= debateEvents.length - 1) {
        setPlaying(false);
        return;
      }
      setReplayIndex(replayIndex + 1);
    }, 1600);
    return () => clearTimeout(timer);
  }, [playing, replayIndex, debateEvents.length]);

  async function runComparison() {
    if (!compareA || !compareB || compareA === compareB) return;
    setComparing(true);
    setComparison(null);
    setError("");
    try {
      const response = await fetch(
        `/api/council/runs/compare?a=${encodeURIComponent(compareA)}&b=${encodeURIComponent(compareB)}`,
      );
      const data = (await response.json()) as CompareResponse & { error?: string };
      if (!response.ok) throw new Error(data.error || "No se pudieron comparar las corridas.");
      setComparison(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron comparar las corridas.");
    } finally {
      setComparing(false);
    }
  }

  if (error && !detail) {
    return (
      <section className="resultSection">
        <h3><Activity size={16} /> Trazas de la corrida</h3>
        <p className="traceEmpty">{error}</p>
      </section>
    );
  }

  if (!runs.length && !runId) {
    return (
      <section className="resultSection">
        <h3><Activity size={16} /> Trazas de la corrida</h3>
        <p className="traceEmpty">
          Todavía no hay corridas persistidas. Hacé una pregunta al consejo y acá vas a ver el timeline,
          los tokens por modelo, el replay del debate y la comparación con otra corrida.
        </p>
      </section>
    );
  }

  const currentReplay: CouncilRunEvent | undefined = debateEvents[replayIndex];
  const replayPayload = currentReplay?.payload ?? {};
  const critique = text(replayPayload, "critique");
  const revisedAnswer = text(replayPayload, "revisedAnswer");
  const rationale = text(replayPayload, "rationale");

  return (
    <div className="runTraces">
      <section className="resultSection">
        <div className="traceHead">
          <h3><Activity size={16} /> Trazas de la corrida</h3>
          <div className="traceActions">
            {selectedId ? (
              <>
                <a className="traceBtn" href={`/api/council/runs/${encodeURIComponent(selectedId)}/export?format=markdown`} download>
                  <Download size={14} /> Markdown
                </a>
                <a className="traceBtn" href={`/api/council/runs/${encodeURIComponent(selectedId)}/export?format=json`} download>
                  <Download size={14} /> JSON
                </a>
              </>
            ) : null}
            {runs.length ? (
              <select
                className="traceSelect"
                value={selectedId ?? ""}
                onChange={(event) => {
                  setError("");
                  setSelectedId(event.target.value || null);
                  if (!event.target.value) setDetail(null);
                }}
                aria-label="Elegir corrida"
              >
                {runs.map((run) => (
                  <option key={run.id} value={run.id}>
                    {new Date(run.startedAt).toLocaleString("es")} · {statusLabel(run.status)} · {shortQuestion(run.question)}
                  </option>
                ))}
              </select>
            ) : null}
          </div>
        </div>

        {loading ? <p className="traceEmpty">Cargando corrida…</p> : null}

        {detail ? (
          <>
            <div className="traceStats">
              <div><span>Estado</span><b>{statusLabel(detail.run.status)}</b></div>
              <div><span>Duración</span><b>{formatDurationMs(detail.run.trace?.totalMs ?? (detail.run.finishedAt ? detail.run.finishedAt - detail.run.startedAt : null))}</b></div>
              <div><span>Tokens</span><b>{detail.run.totalTokens.toLocaleString("es")}</b></div>
              <div><span>Costo estimado</span><b>{formatUsd(detail.run.costUsd)}</b></div>
              <div><span>Eventos</span><b>{detail.run.trace?.eventCount ?? detail.events.length}</b></div>
            </div>

            <p className="traceQuestion"><strong>Pregunta:</strong> {detail.run.question || question || "(vacía)"}</p>

            {detail.usage.length ? (
              <div className="tableShell">
                <table>
                  <thead>
                    <tr>
                      <th>Modelo</th>
                      <th>Fase</th>
                      <th>Llamadas</th>
                      <th>Prompt</th>
                      <th>Completion</th>
                      <th>Total</th>
                      <th>Costo</th>
                      <th>Latencia</th>
                      <th>Fallbacks</th>
                      <th>Reintentos</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.usage.map((row) => (
                      <tr key={`${row.modelId}-${row.phase}`}>
                        <td>{row.label || row.modelId}</td>
                        <td>{row.phase}</td>
                        <td>{row.calls}</td>
                        <td>{row.promptTokens.toLocaleString("es")}</td>
                        <td>{row.completionTokens.toLocaleString("es")}</td>
                        <td>{row.totalTokens.toLocaleString("es")}</td>
                        <td>{formatUsd(row.costUsd)}</td>
                        <td>{formatDurationMs(row.latencyMs)}</td>
                        <td>{row.fallbacks}</td>
                        <td>{row.retries}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="traceEmpty">La corrida no registró usage por modelo (puede haber fallado antes de la primera llamada).</p>
            )}
          </>
        ) : null}
      </section>

      {detail?.events.length ? (
        <section className="resultSection">
          <h3><Clock3 size={16} /> Timeline</h3>
          <ol className="traceTimeline">
            {detail.events.map((event) => (
              <li key={event.seq} className={DEBATE_EVENT_TYPES.has(event.type) ? "traceEvent debate" : "traceEvent"}>
                <span className="traceOffset">+{formatDurationMs(event.at - detail.run.startedAt)}</span>
                <div>
                  <b>{event.type}</b>
                  <p>{describeEvent(event)}</p>
                  <details>
                    <summary>Ver payload</summary>
                    <pre>{JSON.stringify(event.payload, null, 2)}</pre>
                  </details>
                </div>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {debateEvents.length ? (
        <section className="resultSection">
          <h3><Play size={16} /> Replay del debate</h3>
          <div className="replayCard">
            <div className="replayMeta">
              <span>Evento {replayIndex + 1} de {debateEvents.length}</span>
              <span>{currentReplay ? `+${formatDurationMs(currentReplay.at - detail!.run.startedAt)}` : ""}</span>
            </div>
            {currentReplay ? (
              <>
                <b>{describeEvent(currentReplay)}</b>
                {critique ? (
                  <div className="replayBlock">
                    <span>Crítica</span>
                    <p>{critique}</p>
                  </div>
                ) : null}
                {revisedAnswer ? (
                  <div className="replayBlock">
                    <span>Respuesta revisada</span>
                    <p>{revisedAnswer}</p>
                  </div>
                ) : null}
                {rationale ? (
                  <div className="replayBlock">
                    <span>Rationale del voto</span>
                    <p>{rationale}</p>
                  </div>
                ) : null}
                {number(replayPayload, "convergence") ? (
                  <p className="traceEmpty">Convergencia: {(number(replayPayload, "convergence") * 100).toFixed(0)}%</p>
                ) : null}
              </>
            ) : null}
            <div className="replayControls">
              <button type="button" className="traceBtn" onClick={() => setReplayIndex((current) => Math.max(0, current - 1))} disabled={replayIndex === 0}>
                <ChevronLeft size={14} /> Anterior
              </button>
              <button type="button" className="traceBtn" onClick={() => setPlaying((current) => !current)}>
                {playing ? <Pause size={14} /> : <Play size={14} />} {playing ? "Pausar" : "Reproducir"}
              </button>
              <button
                type="button"
                className="traceBtn"
                onClick={() => setReplayIndex((current) => Math.min(debateEvents.length - 1, current + 1))}
                disabled={replayIndex >= debateEvents.length - 1}
              >
                Siguiente <ChevronRight size={14} />
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {runs.length >= 2 ? (
        <section className="resultSection">
          <h3><GitCompareArrows size={16} /> Comparar dos corridas</h3>
          <div className="compareControls">
            <label>
              Corrida A
              <select className="traceSelect" value={compareA} onChange={(event) => setCompareA(event.target.value)}>
                <option value="">Elegir…</option>
                {runs.map((run) => (
                  <option key={run.id} value={run.id}>
                    {new Date(run.startedAt).toLocaleString("es")} · {shortQuestion(run.question)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Corrida B
              <select className="traceSelect" value={compareB} onChange={(event) => setCompareB(event.target.value)}>
                <option value="">Elegir…</option>
                {runs.map((run) => (
                  <option key={run.id} value={run.id}>
                    {new Date(run.startedAt).toLocaleString("es")} · {shortQuestion(run.question)}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="traceBtn primary"
              onClick={runComparison}
              disabled={comparing || !compareA || !compareB || compareA === compareB}
            >
              <GitCompareArrows size={14} /> {comparing ? "Comparando…" : "Comparar"}
            </button>
          </div>

          {comparison ? (
            <div className="compareResult">
              {comparison.comparison.sameQuestion ? null : (
                <p className="traceWarning">Las corridas no tienen exactamente la misma pregunta; la comparación es solo de métricas.</p>
              )}
              <div className="traceStats">
                <div><span>Tokens A</span><b>{comparison.comparison.a.totalTokens.toLocaleString("es")}</b></div>
                <div><span>Tokens B</span><b>{comparison.comparison.b.totalTokens.toLocaleString("es")}</b></div>
                <div><span>Δ tokens</span><b>{comparison.comparison.deltas.totalTokens >= 0 ? "+" : ""}{comparison.comparison.deltas.totalTokens.toLocaleString("es")}</b></div>
                <div><span>Δ duración</span><b>{comparison.comparison.deltas.durationMs >= 0 ? "+" : ""}{formatDurationMs(Math.abs(comparison.comparison.deltas.durationMs))}</b></div>
                <div><span>Δ costo</span><b>{formatUsd(comparison.comparison.deltas.costUsd)}</b></div>
              </div>
              <div className="compareModels">
                <p><strong>Solo en A:</strong> {comparison.comparison.onlyInA.join(", ") || "—"}</p>
                <p><strong>Solo en B:</strong> {comparison.comparison.onlyInB.join(", ") || "—"}</p>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      {error && detail ? <p className="traceWarning">{error}</p> : null}
    </div>
  );
}
