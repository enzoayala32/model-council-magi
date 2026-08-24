import {
  ArrowRight,
  Check,
  FolderCog,
  Gavel,
  AlertTriangle,
  Loader2,
  Layers3,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type {
  DebateRoundInfo,
  FileProposalState,
  RunModel,
  RunPhase,
  TokenUsage,
  TypeCheckResult,
} from "../../lib/client-types";
import { currentHeadline, formatElapsed, formatTokens, latestActivity, nodeStateFor } from "../../lib/client-helpers";
import CouncilPanel from "../council/CouncilPanel";
import type { CouncilStatus } from "../council/types";
import { ModelBadge } from "./shared";

export function ThinkingStage({
  models, synthesisActivity, streamError, runPhase, elapsedMs, onOpenModelResponse, onStop, fileProposals, onApplyProposal, onRejectProposal, onApplyProposalGroup, onRejectProposalGroup, tokenUsage, debateRounds, seatPersonas,
}: {
  models: RunModel[];
  synthesisActivity: string;
  streamError: string;
  runPhase: RunPhase;
  elapsedMs: number;
  onOpenModelResponse: (id: string) => void;
  onStop?: () => void;
  fileProposals: FileProposalState[];
  onApplyProposal: (id: string) => void;
  onRejectProposal: (id: string) => void;
  onApplyProposalGroup: (groupId: string) => void;
  onRejectProposalGroup: (groupId: string) => void;
  tokenUsage: TokenUsage;
  debateRounds: DebateRoundInfo[];
  seatPersonas: Record<string, { key: string; name: string; title: string }>;
}) {
  const isStreaming = runPhase !== "done";
  const timelineMessage = streamError
    || (isStreaming ? synthesisActivity || currentHeadline(models) : "Síntesis final completa.");
  const synthesisBarMessage =
    runPhase === "done"
      ? "Síntesis final completa."
      : runPhase === "synthesizing" || synthesisActivity
        ? "Sintetizando borradores y críticas del debate…"
        : runPhase === "debating"
          ? "Los modelos están debatiendo entre sí…"
          : "Esperando los borradores independientes…";

  const councilStatus: CouncilStatus = streamError ? "error" : runPhase === "done" ? "complete" : "processing";
  const councilEyebrow = streamError
    ? "ALERTA DEL SISTEMA"
    : runPhase === "done"
      ? "DELIBERACIÓN COMPLETA"
      : "DELIBERACIÓN EN CURSO";
  const councilHeadline = streamError
    ? "ERROR"
    : runPhase === "synthesizing"
      ? "SINTETIZANDO"
      : runPhase === "done"
        ? "DECISIÓN DEL CONSENSO"
        : "DELIBERANDO";
  const councilDetail = streamError || (runPhase === "done" ? "RESPUESTA FINAL LISTA" : timelineMessage);
  const phaseIndex = runPhase === "drafting" ? 1 : runPhase === "debating" ? 2 : 3;
  const completedCount = models.filter((m) =>
    runPhase === "drafting" ? m.status === "complete" : m.debateStatus === "complete",
  ).length;

  return (
    <div className="thinkingPanel">
      <CouncilPanel
        status={councilStatus}
        phaseId={runPhase}
        eyebrow={councilEyebrow}
        headline={councilHeadline}
        detail={councilDetail}
        stats={[
          { label: "MODELOS", value: String(models.length) },
          { label: "FASE", value: `${Math.min(phaseIndex, 3)}/3` },
          { label: "RESPUESTAS", value: `${completedCount}/${models.length}` },
          ...(debateRounds.length
            ? [{ label: "RONDA", value: `${debateRounds[debateRounds.length - 1].round}/${debateRounds[debateRounds.length - 1].maxRounds}` }]
            : []),
          { label: "TRANSCURRIDO", value: formatElapsed(elapsedMs) },
          { label: "TOKENS", value: formatTokens(tokenUsage.total_tokens) },
        ]}
        nodes={models.map((model) => ({
          id: model.id,
          label: seatPersonas[model.id]?.name.toUpperCase() ?? model.label,
          badge: model.badge,
          state: nodeStateFor(model, runPhase),
        }))}
      />

      {fileProposals.length ? (
        <FileProposalsPanel
          proposals={fileProposals}
          onApply={onApplyProposal}
          onReject={onRejectProposal}
          onApplyGroup={onApplyProposalGroup}
          onRejectGroup={onRejectProposalGroup}
        />
      ) : null}

      <div className="timelineHead">
        <h2 className="timelineTitle">Consenso en sesión</h2>
        {isStreaming && onStop ? (
          <button type="button" className="stopButton" onClick={onStop}>
            <Square size={13} fill="currentColor" /> Detener
          </button>
        ) : null}
      </div>

      <PhaseTracker runPhase={runPhase} />

      <div className="timelineStatus">
        <p>{timelineMessage}</p>
      </div>

      <div className="thinkingStack">
        {models.map((model) => {
          const phaseStatus =
            runPhase === "debating" || runPhase === "synthesizing" || runPhase === "done"
              ? model.debateStatus
              : model.status;
          const phaseLabel =
            runPhase === "drafting"
              ? "Redactando"
              : runPhase === "debating"
                ? "Debatiendo"
                : runPhase === "synthesizing"
                  ? "Sintetizando"
                  : "Listo";

          return (
            <article className={`thinkingCard ${phaseStatus}`} key={model.id}>
              <div className="thinkingBody">
                <div className="thinkingCardHeader">
                  <div className="modelPill">
                    <ModelBadge model={model} small />
                    <strong>{model.label}</strong>
                  </div>
                  <span className="phaseLabel">{phaseLabel}</span>
                  {model.steps ? <span className="inlineSteps">{model.steps} pasos</span> : null}
                </div>
                <p className="currentActivity">
                  {model.error
                    ? `Error: ${model.error}`
                    : phaseStatus === "complete"
                      ? runPhase === "drafting"
                        ? "Borrador independiente completado"
                        : "Debate completo — crítica enviada"
                      : latestActivity(model)}
                </p>
              </div>
              <div className="thinkingCardAction">
                {model.status === "complete" ? (
                  <button type="button" onClick={() => onOpenModelResponse(model.id)}>
                    Ver borrador <ArrowRight size={14} />
                  </button>
                ) : phaseStatus === "thinking" ? (
                  <span className="writingPill"><i /> {runPhase === "debating" ? "Debatiendo…" : "Escribiendo…"}</span>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>

      <div className="synthesisBar">
        <span>{synthesisBarMessage}</span>
        {isStreaming ? <div className="dotWave"><i /><i /><i /></div> : null}
      </div>
    </div>
  );
}

export function FileProposalsPanel({
  proposals,
  onApply,
  onReject,
  onApplyGroup,
  onRejectGroup,
}: {
  proposals: FileProposalState[];
  onApply: (id: string) => void;
  onReject: (id: string) => void;
  onApplyGroup: (groupId: string) => void;
  onRejectGroup: (groupId: string) => void;
}) {
  const groups = new Map<string, FileProposalState[]>();
  for (const proposal of proposals) {
    const list = groups.get(proposal.groupId) ?? [];
    list.push(proposal);
    groups.set(proposal.groupId, list);
  }

  return (
    <div className="fileProposalsPanel">
      <div className="fileProposalsHeader">
        <FolderCog size={15} />
        <strong>Cambios de archivos propuestos</strong>
        <span>{proposals.filter((p) => p.status === "pending").length} esperando revisión</span>
      </div>
      {[...groups.entries()].map(([groupId, group]) => {
        const pendingInGroup = group.filter((p) => p.status === "pending");
        const isMultiFile = group.length > 1;
        return (
          <div className="fileProposalGroup" key={groupId}>
            {isMultiFile ? (
              <div className="fileProposalGroupHeader">
                <span>{group.length} archivos relacionados (mismo turno)</span>
                {pendingInGroup.length ? (
                  <div className="fileProposalActions">
                    <button type="button" className="applyButton" onClick={() => onApplyGroup(groupId)}>
                      <Check size={13} /> Aplicar todo
                    </button>
                    <button type="button" className="rejectButton" onClick={() => onRejectGroup(groupId)}>
                      <X size={13} /> Descartar todo
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
            {group.map((proposal) => (
              <article key={proposal.id} className={`fileProposalCard status-${proposal.status}`}>
                <header>
                  <span className="fileProposalKind">{proposal.kind === "write" ? "Escribir" : "Editar"}</span>
                  <code className="fileProposalPath">{proposal.path}</code>
                  <TypeCheckBadge typeCheck={proposal.typeCheck} />
                  <span className="fileProposalStatus">
                    {proposal.status === "pending" && "Pendiente"}
                    {proposal.status === "applying" && "Aplicando…"}
                    {proposal.status === "applied" && "Aplicado"}
                    {proposal.status === "rejected" && "Descartado"}
                    {proposal.status === "error" && `Error: ${proposal.error}`}
                  </span>
                </header>
                <DiffView diff={proposal.diff} />
                {proposal.typeCheck.status === "error" && proposal.typeCheck.errors?.length ? (
                  <pre className="typeCheckErrors">{proposal.typeCheck.errors.join("\n")}</pre>
                ) : null}
                {proposal.status === "pending" ? (
                  <div className="fileProposalActions">
                    <button type="button" className="applyButton" onClick={() => onApply(proposal.id)}>
                      <Check size={13} /> Aplicar
                    </button>
                    <button type="button" className="rejectButton" onClick={() => onReject(proposal.id)}>
                      <X size={13} /> Descartar
                    </button>
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        );
      })}
    </div>
  );
}

export function TypeCheckBadge({ typeCheck }: { typeCheck: TypeCheckResult }) {
  if (typeCheck.status === "skipped") return null;
  if (typeCheck.status === "checking") {
    return (
      <span className="typeCheckBadge checking" title="Verificando tipos con tsc…">
        <Loader2 size={11} className="spin" /> Verificando
      </span>
    );
  }
  if (typeCheck.status === "ok") {
    return (
      <span className="typeCheckBadge ok" title="tsc --noEmit no encontró errores">
        <Check size={11} /> Compila
      </span>
    );
  }
  return (
    <span className="typeCheckBadge error" title={typeCheck.errors?.join("\n") || "tsc encontró errores"}>
      <AlertTriangle size={11} /> {typeCheck.errors?.length ?? 0} error{(typeCheck.errors?.length ?? 0) === 1 ? "" : "es"}
    </span>
  );
}

export function DiffView({ diff }: { diff: string }) {
  const lines = diff.split("\n");
  return (
    <pre className="diffView">
      {lines.map((line, index) => {
        const kind = line.startsWith("+++") || line.startsWith("---")
          ? "meta"
          : line.startsWith("+")
            ? "add"
            : line.startsWith("-")
              ? "del"
              : "context";
        return (
          <div key={index} className={`diffLine diff-${kind}`}>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}

export function PhaseTracker({ runPhase }: { runPhase: RunPhase }) {
  const phases: Array<{ id: Exclude<RunPhase, "done">; label: string; icon: LucideIcon }> = [
    { id: "drafting", label: "Borradores independientes", icon: Sparkles },
    { id: "debating", label: "Debate del consenso", icon: Gavel },
    { id: "synthesizing", label: "Síntesis final", icon: Layers3 },
  ];
  const order: RunPhase[] = ["drafting", "debating", "synthesizing", "done"];
  const activeIndex = order.indexOf(runPhase);

  return (
    <ol className="phaseTracker" aria-label="Fases del consenso">
      {phases.map((p, index) => {
        const Icon = p.icon;
        const state = index < activeIndex ? "complete" : index === activeIndex ? "active" : "queued";
        return (
          <li key={p.id} className={`phaseStep ${state}`}>
            <span className="phaseDot"><Icon size={14} /></span>
            <span className="phaseStepLabel">{p.label}</span>
          </li>
        );
      })}
    </ol>
  );
}

