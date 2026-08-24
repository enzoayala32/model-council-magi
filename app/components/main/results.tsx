"use client";
import { useState } from "react";
import {
  ArrowRight,
  Bookmark,
  Check,
  Copy,
  Download,
  Gavel,
  Trophy,
  Plus,
  Share2,
  Sparkles,
  X,
} from "lucide-react";
import type { FusionJudgeReport, RunModel, TokenUsage } from "../../lib/client-types";
import type { StoredGeneratedImage } from "@/lib/threads";
import { FUSION_PANELS } from "@/lib/models";
import { DEFAULT_QUERY, DEMO_SOURCES } from "../../lib/constants";
import { agreeRows, disagreeRows, modelResponses, uniqueRows } from "../../lib/demo-data";
import { buildMarkdownExport, compactQuestion, downloadTextFile, formatTokens, positionForModel, reportNamesModel, slugify } from "../../lib/client-helpers";
import { ModelBadge, MarkdownLite } from "./shared";
import { TribunalView } from "./council-views";

export function ResultsDashboard({
  models, query, synthesis, fusionJudge, fusionPanelId, followUps, generatedImages, imageStatus, onOpenModal, onRunFollowup, tokenUsage, tokenBreakdown,
}: {
  models: RunModel[];
  query: string;
  synthesis: string;
  fusionJudge: FusionJudgeReport | null;
  fusionPanelId: string | null;
  followUps: string[];
  generatedImages: StoredGeneratedImage[];
  imageStatus: string;
  onOpenModal: (id: string) => void;
  onRunFollowup: (query: string) => void;
  tokenUsage: TokenUsage;
  tokenBreakdown: Array<{ phase: string; modelId?: string; label?: string; usage: TokenUsage }>;
}) {
  const useDemoTables = query.trim() === DEFAULT_QUERY;
  const activePanel = FUSION_PANELS.find((panel) => panel.id === fusionPanelId);
  const [copyState, setCopyState] = useState<"idle" | "copied">("idle");
  const [tribunalMode, setTribunalMode] = useState(false);

  async function handleCopyMarkdown() {
    const markdown = buildMarkdownExport({ query, synthesis, fusionJudge, models, followUps, tokenUsage });
    try {
      await navigator.clipboard.writeText(markdown);
      setCopyState("copied");
      setTimeout(() => setCopyState("idle"), 1800);
    } catch {
      // Clipboard access can be blocked (permissions, insecure context) —
      // fall back to a download so the user isn't stuck with nothing.
      downloadTextFile(`${slugify(query)}.md`, markdown);
    }
  }

  function handleDownloadMarkdown() {
    const markdown = buildMarkdownExport({ query, synthesis, fusionJudge, models, followUps, tokenUsage });
    downloadTextFile(`${slugify(query)}.md`, markdown);
  }

  return (
    <div className="resultsDashboard">
      <section className="summaryBlock">
        <div className="summaryHead">
          <h3><Sparkles size={16} /> Respuesta consensuada</h3>
          <div className="summaryActions">
            <button
              className={`tribunalToggle${tribunalMode ? " active" : ""}`}
              type="button"
              aria-pressed={tribunalMode}
              onClick={() => setTribunalMode((v) => !v)}
              title="Toggle tribunal view"
            >
              <Gavel size={14} /> Tribunal
            </button>
            <button className="iconBtn" type="button" aria-label="Copy as Markdown" onClick={handleCopyMarkdown} title="Copy full transcript as Markdown">
              {copyState === "copied" ? <Check size={16} /> : <Copy size={16} />}
            </button>
            <button className="iconBtn" type="button" aria-label="Download as Markdown" onClick={handleDownloadMarkdown} title="Download full transcript as a .md file">
              <Download size={16} />
            </button>
            <button className="iconBtn" type="button" aria-label="Share"><Share2 size={16} /></button>
            <button className="iconBtn" type="button" aria-label="Save"><Bookmark size={16} /></button>
          </div>
        </div>

        {tribunalMode ? (
          <TribunalView models={models} query={query} fusionJudge={fusionJudge} fusionPanelId={fusionPanelId} />
        ) : synthesis ? (
          <MarkdownLite content={synthesis} />
        ) : (
          <p style={{ color: "var(--muted)", margin: 0 }}>
            The council’s strongest consensus appears here once the synthesizer compares all model responses.
          </p>
        )}

        <div className="summaryFoot">
          <span>Elaborado usando {models.map((model) => model.label).join(", ")}</span>
          <b>{activePanel ? `Fusión ${activePanel.shortName}` : useDemoTables ? `${DEMO_SOURCES.length} fuentes` : "Panel personalizado"}</b>
        </div>
      </section>

      {generatedImages.length || imageStatus ? (
        <section className="resultSection">
          <h3>Generated image</h3>
          {generatedImages.length ? (
            <div className="generatedImageGrid">
              {generatedImages.map((image) => (
                <figure className="generatedImageCard" key={image.id}>
                  <img src={image.url} alt="Generated image" />
                  <figcaption>
                    <strong>{image.model}</strong>
                    <span>{compactQuestion(image.prompt)}</span>
                  </figcaption>
                </figure>
              ))}
            </div>
          ) : (
            <p className="imageStatus">{imageStatus}</p>
          )}
        </section>
      ) : null}

      {fusionJudge ? (
        <FusionReportSections report={fusionJudge} models={models} />
      ) : useDemoTables ? (
        <>
          <section className="resultSection">
            <h3>Dónde coinciden los modelos</h3>
            <div className="tableShell">
              <table>
                <thead>
                  <tr>
                    <th>Hallazgo</th>
                    {models.map((model) => (
                      <th className="modelColumn" key={model.id}>
                        <ModelBadge model={model} small />
                      </th>
                    ))}
                    <th>Evidencia</th>
                  </tr>
                </thead>
                <tbody>
                  {agreeRows.map((row) => (
                    <tr key={row.finding}>
                      <td>{row.finding}</td>
                      {models.map((model) => (
                        <td className="checkCell" key={model.id}>
                          {row.models.includes(model.id) ? <Check size={16} /> : <span className="dash">—</span>}
                        </td>
                      ))}
                      <td>
                        <span>{row.evidence}</span>
                        <button className="sourcePill" type="button">{row.source}</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="resultSection">
            <h3>Dónde discrepan los modelos</h3>
            <div className="tableShell">
              <table>
                <thead>
                  <tr>
                    <th>Tema</th>
                    {models.map((model) => (
                      <th key={model.id} className="modelColumn">
                        <ModelBadge model={model} small />
                      </th>
                    ))}
                    <th>Why they differ</th>
                  </tr>
                </thead>
                <tbody>
                  {disagreeRows.map((row) => (
                    <tr key={row.topic}>
                      <td><strong>{row.topic}</strong></td>
                      {models.map((model) => (
                        <td key={model.id}>{row.cells[model.id as keyof typeof row.cells] ?? "—"}</td>
                      ))}
                      <td>{row.why}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="resultSection">
            <h3>Hallazgos únicos</h3>
            <div className="uniqueGrid">
              {models.map((model) => {
                const row = uniqueRows.find((item) => item.id === model.id) ?? uniqueRows[0];
                return (
                  <article className="uniqueCard" key={model.id}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <ModelBadge model={model} small />
                      <span style={{ fontSize: 12, fontWeight: 650, color: "var(--ink)" }}>{model.label}</span>
                    </div>
                    <strong>{row.finding}</strong>
                    <p>{row.matters}</p>
                  </article>
                );
              })}
            </div>
          </section>
        </>
      ) : null}

      {fusionJudge?.contradictions?.length ? (
        <section className="resultSection">
          <h3><Gavel size={14} /> Mapa de desacuerdo</h3>
          <p style={{ color: "var(--muted)", margin: "-4px 0 6px", fontSize: 13 }}>
            Puntos concretos donde el panel no coincidió, con la posición de cada modelo y cómo lo resolvió el juez.
          </p>
          <div className="disagreementMap">
            {fusionJudge.contradictions.map((item, index) => (
              <article className="disagreementCard" key={index}>
                <h4>{item.topic}</h4>
                <div className="disagreementPositions">
                  {Object.entries(item.positions).map(([modelLabel, position]) => (
                    <div className="disagreementPosition" key={modelLabel}>
                      <strong>{modelLabel}</strong>
                      <span>{position}</span>
                    </div>
                  ))}
                </div>
                <p className="disagreementJudgment"><Trophy size={12} /> {item.judgment}</p>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {tokenBreakdown.length ? <TokenBreakdownSection breakdown={tokenBreakdown} /> : null}

      <section className="resultSection">
        <h3>Respuestas individuales</h3>
        <div className="modelResponseButtons">
          {models.map((model) => (
            <button key={model.id} type="button" onClick={() => onOpenModal(model.id)}>
              <ModelBadge model={model} />
              <span>{model.label}</span>
              <em>Abrir →</em>
              <p>{model.response ? compactQuestion(model.response) : model.error ?? "Open the full individual response."}</p>
            </button>
          ))}
        </div>
      </section>

      <section className="followUps">
        <h3><ArrowRight size={14} /> Preguntas relacionadas</h3>
        {followUps.length ? (
          followUps.map((q) => (
            <button key={q} type="button" onClick={() => onRunFollowup(q)}>
              <span>{q}</span>
              <Plus size={16} />
            </button>
          ))
        ) : (
          <p className="followUpsEmpty">No se pudieron generar preguntas relacionadas para esta respuesta.</p>
        )}
      </section>
    </div>
  );
}

/**
 * Groups the run's raw per-event token usage by phase (draft/debate/vote/
 * judge/synthesis/...) so it's obvious which STEP is actually expensive —
 * e.g. the vote step sends every candidate's full answer to every voter, an
 * O(n²)-ish prompt cost that's easy to miss when only a single grand total
 * is shown.
 */
export function TokenBreakdownSection({ breakdown }: { breakdown: Array<{ phase: string; modelId?: string; label?: string; usage: TokenUsage }> }) {
  const byPhase = new Map<string, { prompt: number; completion: number; total: number; calls: number }>();
  for (const entry of breakdown) {
    const current = byPhase.get(entry.phase) ?? { prompt: 0, completion: 0, total: 0, calls: 0 };
    current.prompt += entry.usage.prompt_tokens ?? 0;
    current.completion += entry.usage.completion_tokens ?? 0;
    current.total += entry.usage.total_tokens ?? 0;
    current.calls += 1;
    byPhase.set(entry.phase, current);
  }
  const rows = [...byPhase.entries()].sort((a, b) => b[1].total - a[1].total);
  const grandTotal = rows.reduce((sum, [, v]) => sum + v.total, 0) || 1;

  return (
    <section className="resultSection">
      <h3>Desglose de tokens por paso</h3>
      <p style={{ color: "var(--muted)", margin: "-4px 0 6px", fontSize: 13 }}>
        Qué parte de la corrida consumió más — por ejemplo, el paso de votación manda la respuesta completa de cada
        modelo a cada votante, así que suele pesar más de lo que parece.
      </p>
      <div className="tokenBreakdownList">
        {rows.map(([phase, v]) => (
          <div className="tokenBreakdownRow" key={phase}>
            <span className="tokenBreakdownPhase">{phase}</span>
            <div className="tokenBreakdownBarTrack">
              <div className="tokenBreakdownBarFill" style={{ width: `${(v.total / grandTotal) * 100}%` }} />
            </div>
            <span className="tokenBreakdownValue">
              {formatTokens(v.total)} <em>({v.calls} llamada{v.calls === 1 ? "" : "s"} · {formatTokens(v.prompt)} prompt / {formatTokens(v.completion)} completion)</em>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

export function FusionReportSections({ report, models }: { report: FusionJudgeReport; models: RunModel[] }) {
  return (
    <>
      <section className="fusionVerdict">
        <div>
          <span>Juez de fusión</span>
          <h3>Veredicto del panel</h3>
        </div>
        <p>{report.panelVerdict}</p>
      </section>

      {report.consensus.length ? (
        <section className="resultSection">
          <h3>Dónde coinciden los modelos</h3>
          <div className="tableShell">
            <table>
              <thead>
                <tr>
                  <th>Hallazgo</th>
                  {models.map((model) => (
                    <th className="modelColumn" key={model.id}>
                      <ModelBadge model={model} small />
                    </th>
                  ))}
                  <th>Evidencia</th>
                </tr>
              </thead>
              <tbody>
                {report.consensus.map((row) => (
                  <tr key={row.finding}>
                    <td>{row.finding}</td>
                    {models.map((model) => (
                      <td className="checkCell" key={model.id}>
                        {reportNamesModel(row.models, model) ? <Check size={16} /> : <span className="dash">-</span>}
                      </td>
                    ))}
                    <td>{row.evidence}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {report.contradictions.length ? (
        <section className="resultSection">
          <h3>Dónde discrepan los modelos</h3>
          <div className="tableShell">
            <table>
              <thead>
                <tr>
                  <th>Tema</th>
                  {models.map((model) => (
                    <th key={model.id} className="modelColumn">
                      <ModelBadge model={model} small />
                    </th>
                  ))}
                  <th>Lectura del juez</th>
                </tr>
              </thead>
              <tbody>
                {report.contradictions.map((row) => (
                  <tr key={row.topic}>
                    <td><strong>{row.topic}</strong></td>
                    {models.map((model) => (
                      <td key={model.id}>{positionForModel(row.positions, model) || "-"}</td>
                    ))}
                    <td>{row.judgment}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {report.uniqueInsights.length ? (
        <section className="resultSection">
          <h3>Hallazgos únicos</h3>
          <div className="uniqueGrid">
            {report.uniqueInsights.map((row) => {
              const model = models.find((item) => reportNamesModel([row.model], item)) ?? models[0];
              return (
                <article className="uniqueCard" key={`${row.model}-${row.insight}`}>
                  {model ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <ModelBadge model={model} small />
                      <span style={{ fontSize: 12, fontWeight: 650, color: "var(--ink)" }}>{model.label}</span>
                    </div>
                  ) : null}
                  <strong>{row.insight}</strong>
                  <p>{row.whyItMatters}</p>
                </article>
              );
            })}
          </div>
        </section>
      ) : null}

      {report.coverageGaps.length ? (
        <section className="resultSection">
          <h3>Vacíos de cobertura</h3>
          <div className="coverageGapList">
            {report.coverageGaps.map((gap) => (
              <span key={gap}>{gap}</span>
            ))}
          </div>
        </section>
      ) : null}
    </>
  );
}


/* =========================================================
   Modal
   ========================================================= */

export function ModelResponseModal({ model, onClose }: { model: RunModel; onClose: () => void }) {
  return (
    <div className="modalBackdrop" role="presentation" onClick={onClose}>
      <article className="responseModal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <header>
          <div>
            <ModelBadge model={model} />
            <div>
              <h2>{model.label}</h2>
              <p>{model.maker} · independent council response</p>
            </div>
          </div>
          <div className="modalActions">
            <button className="closeButton" type="button" onClick={onClose} aria-label="Close">
              <X size={18} />
            </button>
          </div>
        </header>
        <div className="modalContent">
          {model.response ? (
            <MarkdownLite content={model.response} />
          ) : (
            <>
              <h3>Main factors driving U.S. inflation in 2025</h3>
              {(modelResponses[model.id] ?? modelResponses["openai/gpt-oss-20b:free"]).map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
              <ul>
                <li>Shelter and services kept the baseline sticky.</li>
                <li>Tariffs and inventory behavior added goods pressure.</li>
                <li>Consumer sentiment lagged headline disinflation because price levels remained high.</li>
              </ul>
            </>
          )}
        </div>
      </article>
    </div>
  );
}

/* =========================================================
   Bits
   ========================================================= */

