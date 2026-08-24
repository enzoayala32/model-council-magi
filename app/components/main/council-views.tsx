import { useMemo, useState } from "react";
import { RefreshCw, Anchor, Trophy, MessageSquareQuote, FileEdit, SlidersHorizontal } from "lucide-react";
import type { DebateRoundInfo, FusionJudgeReport, RunModel, VoteCastInfo, VoteTallyInfo } from "../../lib/client-types";
import { FUSION_PANELS } from "@/lib/models";
import { DEMO_SOURCES } from "../../lib/constants";
import { caseCode, verdictSnippet } from "../../lib/client-helpers";
import { ModelBadge, MarkdownLite } from "./shared";

export function DebateView({
  models,
  debateRounds,
  votes,
  voteTally,
  seatPersonas,
  debateSkipped,
}: {
  models: RunModel[];
  debateRounds: DebateRoundInfo[];
  votes: VoteCastInfo[];
  voteTally: VoteTallyInfo | null;
  seatPersonas: Record<string, { key: string; name: string; title: string }>;
  debateSkipped: { score: number; threshold: number; participantCount: number } | null;
}) {
  const debaters = models.filter((m) => m.critique || m.revisedAnswer);

  // "latest" = comportamiento de siempre (crítica/respuesta más reciente por modelo).
  // Un número = replay: mostrar lo que cada modelo tenía en esa ronda puntual.
  const [selectedRound, setSelectedRound] = useState<number | "latest">("latest");

  const availableRounds = useMemo(() => {
    const rounds = new Set<number>();
    for (const model of debaters) {
      for (const entry of model.debateHistory ?? []) rounds.add(entry.round);
    }
    return Array.from(rounds).sort((a, b) => a - b);
  }, [debaters]);

  const hasDraftStage = debaters.some((m) => m.response);
  const canReplay = availableRounds.length > 1 || (availableRounds.length >= 1 && hasDraftStage);

  if (!debaters.length) {
    return (
      <div className="resultSection">
        <h3>Council debate</h3>
        {debateSkipped ? (
          <p style={{ color: "var(--muted)", margin: 0 }}>
            Modo adaptativo: los {debateSkipped.participantCount} borradores independientes ya coincidían lo
            suficiente ({Math.round(debateSkipped.score * 100)}% de vocabulario compartido, umbral{" "}
            {Math.round(debateSkipped.threshold * 100)}%) — se saltó el debate y la votación para ahorrar tiempo y
            tokens, directo a la síntesis final.
          </p>
        ) : (
          <p style={{ color: "var(--muted)", margin: 0 }}>
            The debate round has not produced critiques yet. It runs after each model finishes its
            independent draft.
          </p>
        )}
      </div>
    );
  }
  return (
    <div className="resultSection">
      <h3>Council debate</h3>
      <p style={{ color: "var(--muted)", margin: "-4px 0 6px", fontSize: 13.5 }}>
        After their independent drafts, each model saw the other answers and pushed back, defended,
        or updated its position.
      </p>

      {debateRounds.length ? (
        <div className="debateRoundsSummary">
          {debateRounds.map((round) => (
            <div className="debateRoundChip" key={round.round}>
              <span className="debateRoundChipLabel">Ronda {round.round}/{round.maxRounds}</span>
              <span className={round.converged ? "debateRoundChipConverged" : "debateRoundChipScore"}>
                {round.converged ? "Convergió" : `${Math.round(round.convergence * 100)}% acuerdo`}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {canReplay ? (
        <div className="debateTimeline" role="group" aria-label="Repasar rondas del debate">
          <span className="debateTimelineLabel">
            <SlidersHorizontal size={13} /> Repasar:
          </span>
          <div className="debateTimelineTrack">
            {hasDraftStage ? (
              <button
                type="button"
                className={selectedRound === 0 ? "debateTimelineStep active" : "debateTimelineStep"}
                onClick={() => setSelectedRound(0)}
              >
                Borrador
              </button>
            ) : null}
            {availableRounds.map((round) => (
              <button
                key={round}
                type="button"
                className={selectedRound === round ? "debateTimelineStep active" : "debateTimelineStep"}
                onClick={() => setSelectedRound(round)}
              >
                Ronda {round}
              </button>
            ))}
            <button
              type="button"
              className={selectedRound === "latest" ? "debateTimelineStep active" : "debateTimelineStep"}
              onClick={() => setSelectedRound("latest")}
            >
              Actual
            </button>
          </div>
        </div>
      ) : null}

      <div className="debateStack">
        {debaters.map((model) => {
          // Resuelve qué contenido mostrar según la ronda seleccionada en el scrubber.
          let critiqueToShow = model.critique;
          let revisedToShow = model.revisedAnswer;
          let roundLabel = model.debateRound && model.debateMaxRounds ? `Ronda ${model.debateRound}/${model.debateMaxRounds}` : "Debate response";
          let showingDraft = false;

          if (selectedRound === 0) {
            showingDraft = true;
            critiqueToShow = undefined;
            revisedToShow = undefined;
          } else if (typeof selectedRound === "number") {
            const entry = model.debateHistory?.find((h) => h.round === selectedRound);
            critiqueToShow = entry?.critique;
            revisedToShow = entry?.revisedAnswer;
            roundLabel = entry ? `Ronda ${entry.round}/${entry.maxRounds}` : `Sin datos en ronda ${selectedRound}`;
          }

          return (
          <article className="debateCard" key={model.id}>
            <header>
              <div className="modelPill">
                <ModelBadge model={model} small />
                <strong>{model.label}</strong>
                {seatPersonas[model.id] ? (
                  <span className="personaBadge" title={seatPersonas[model.id].title}>
                    {seatPersonas[model.id].name}
                  </span>
                ) : null}
              </div>
              <span className="debateBadge">
                {showingDraft ? <FileEdit size={13} /> : <MessageSquareQuote size={13} />}
                {showingDraft ? "Borrador inicial" : roundLabel}
              </span>
              {selectedRound === "latest" && model.mindChanged !== undefined ? (
                <span
                  className={model.mindChanged ? "mindChangeBadge changed" : "mindChangeBadge firm"}
                  title={`Similitud con su borrador inicial: ${Math.round((model.mindChangeSimilarity ?? 0) * 100)}%`}
                >
                  {model.mindChanged ? <RefreshCw size={12} /> : <Anchor size={12} />}
                  {model.mindChanged ? "Cambió de posición" : "Se mantuvo firme"}
                </span>
              ) : null}
            </header>

            {showingDraft ? (
              model.response ? (
                <section>
                  <h4>Borrador independiente</h4>
                  <MarkdownLite content={model.response} />
                </section>
              ) : (
                <p style={{ color: "var(--muted)", margin: 0, fontSize: 13 }}>Sin borrador registrado.</p>
              )
            ) : (
              <>
                {critiqueToShow ? (
                  <section>
                    <h4>Critique of the council</h4>
                    <MarkdownLite content={critiqueToShow} />
                  </section>
                ) : null}

                {revisedToShow ? (
                  <section>
                    <h4>Revised answer</h4>
                    <MarkdownLite content={revisedToShow} />
                  </section>
                ) : null}

                {!critiqueToShow && !revisedToShow ? (
                  <p style={{ color: "var(--muted)", margin: 0, fontSize: 13 }}>
                    Este modelo no participó en esta ronda.
                  </p>
                ) : null}
              </>
            )}
          </article>
          );
        })}
      </div>

      {votes.length ? (
        <div className="voteSection">
          <h4>Votación final del consejo</h4>
          <p style={{ color: "var(--muted)", margin: "-2px 0 8px", fontSize: 13 }}>
            Cada modelo sobreviviente votó por la respuesta final más fuerte del panel (podía votarse a sí mismo).
          </p>
          <div className="voteList">
            {votes.map((vote) => (
              <div className="voteRow" key={vote.modelId}>
                <span className="voteFrom">{vote.label}</span>
                <span className="voteArrow">→</span>
                <span className="voteFor">{vote.votedForLabel ?? "(sin voto válido)"}</span>
                {vote.rationale ? <span className="voteRationale">{vote.rationale}</span> : null}
              </div>
            ))}
          </div>
          {voteTally ? (
            <div className="voteTally">
              {voteTally.tally
                .slice()
                .sort((a, b) => b.votes - a.votes)
                .map((entry) => (
                  <div className={entry.modelId === voteTally.winnerModelId ? "voteTallyBar winner" : "voteTallyBar"} key={entry.modelId}>
                    <span>{entry.label}</span>
                    <div className="voteTallyBarTrack">
                      <div
                        className="voteTallyBarFill"
                        style={{ width: voteTally.totalVotes ? `${(entry.votes / voteTally.totalVotes) * 100}%` : "0%" }}
                      />
                    </div>
                    <span>{entry.votes}</span>
                  </div>
                ))}
              {voteTally.winnerLabel ? (
                <p className="voteWinnerNote">
                  <Trophy size={13} /> El panel favoreció la respuesta de <strong>{voteTally.winnerLabel}</strong>.
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/* =========================================================
   Sources view
   ========================================================= */

export function SourcesView({ models }: { models: RunModel[] }) {
  return (
    <div className="resultSection">
      <h3>Fuentes citadas</h3>
      <div className="sourcesRow">
        {DEMO_SOURCES.map((source, index) => (
          <button className="sourceCard" type="button" key={source.title}>
            <div className="sourceHead">
              <span className="num">{index + 1}</span>
              <span>{source.domain}</span>
            </div>
            <p>{source.title}</p>
          </button>
        ))}
      </div>

      <h3 style={{ marginTop: 20 }}>Por modelo</h3>
      <div className="modelResponseButtons">
        {models.map((model) => (
          <button key={model.id} type="button">
            <ModelBadge model={model} />
            <span>{model.label}</span>
            <em>{model.steps || 0} pasos</em>
            <p>Contexto independiente elaborado para esta pregunta.</p>
          </button>
        ))}
      </div>
    </div>
  );
}

/* =========================================================
   Markdown export — lets the user hand a clean, AI-friendly
   transcript to another model instead of copy/pasting the page.
   ========================================================= */


/* =========================================================
   Tribunal view — MAGI-terminal-inspired alternate rendering
   of the same council data (see globals.css .tribunal*).
   ========================================================= */


export function TribunalView({
  models,
  query,
  fusionJudge,
  fusionPanelId,
}: {
  models: RunModel[];
  query: string;
  fusionJudge: FusionJudgeReport | null;
  fusionPanelId: string | null;
}) {
  const activeModels = models.filter((m) => m.response || m.error || m.status !== "queued");
  const contested = Boolean(fusionJudge?.contradictions?.length);
  const agreeCount = fusionJudge?.consensus?.length ?? 0;
  const disagreeCount = fusionJudge?.contradictions?.length ?? 0;
  const panel = FUSION_PANELS.find((p) => p.id === fusionPanelId);
  const isTriad = activeModels.length === 3;

  return (
    <div className="tribunal" role="region" aria-label="Tribunal view">
      <div className="tribunalCaseStrip">
        <span>CASO №<strong>{caseCode(query || "consenso")}</strong></span>
        <span className="tribunalFile">ARCHIVO: {query || "consulta sin título"}</span>
        <span>MODO: <strong>{panel ? panel.shortName.toUpperCase() : "SELECCIÓN MANUAL"}</strong></span>
        <span>ASIENTOS: <strong>{activeModels.length}</strong></span>
        <span className="tribunalStatus">
          <span className={`tribunalStatusDot${contested ? " contested" : ""}`} />
          {fusionJudge ? (contested ? "EN DISPUTA" : "RESUELTO") : "ABIERTO"}
        </span>
      </div>

      {fusionJudge ? (
        <div className="tribunalHub">
          <div className={`tribunalHubBadge${contested ? " contested" : ""}`}>
            <span className="tribunalHubLabel">Veredicto del panel</span>
            <span className={`tribunalHubVerdict${contested ? " contested" : ""}`}>
              {contested ? "DECISIÓN DIVIDIDA" : "UNÁNIME"}
            </span>
            <span className="tribunalHubTally">{agreeCount} DE ACUERDO · {disagreeCount} EN DISPUTA</span>
          </div>
        </div>
      ) : null}

      <div className={`tribunalSeats${isTriad ? " triad" : ""}`}>
        {activeModels.map((model) => {
          const verdictSource = model.revisedAnswer || model.response;
          const stateClass = model.error ? "error" : model.status;
          return (
            <div key={model.id} className={`tribunalSeat${model.error ? " error" : ""}`}>
              <div className="tribunalSeatHead">
                <div>
                  <div className="tribunalSeatName">{model.label}</div>
                  <div className="tribunalSeatMaker">{model.maker}</div>
                </div>
                <span className={`tribunalSeatDot ${stateClass}`} />
              </div>
              <div className={`tribunalSeatVerdict${model.error ? " error" : !verdictSource ? " pending" : ""}`}>
                {model.error ? model.error : verdictSource ? verdictSnippet(verdictSource) : "ESPERANDO RESPUESTA…"}
              </div>
              <div className="tribunalSeatFoot">{model.critique ? "DEBATIDO" : model.response ? "SOLO BORRADOR" : "PENDIENTE"}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}



