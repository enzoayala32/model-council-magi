"use client";
import { useRef, useState } from "react";
import {
  Activity,
  ArrowUp,
  Check,
  ChevronDown,
  CirclePlus,
  FileText,
  AlertTriangle,
  Globe,
  Layers3,
  Loader2,
  MessageSquare,
  Mic,
  Search,
  Upload,
  Wrench,
  X,
} from "lucide-react";
import type { ModelHealthInfo, RunModel, UploadedAttachment } from "../../lib/client-types";
import type { AgentSkill } from "@/lib/skills";
import type { ModelPingState } from "../../hooks/useModelPing";
import { FUSION_PANELS } from "@/lib/models";
import { MENU_OPTIONS } from "../../lib/constants";
import { effortLabelEs } from "../../lib/client-helpers";
import { ModelBadge } from "./shared";

export function FollowUpComposer({
  selectedCount, onSubmit,
}: {
  selectedCount: number;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState("");
  function submit() {
    const trimmed = value.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    setValue("");
  }
  return (
    <div className="followUpComposer">
      <div className="followUpHead">
        <MessageSquare size={14} /> Hacer una repregunta
        <span className="followUpHint">Se queda en este hilo · el contexto previo se envía al consenso</span>
      </div>
      <div className="followUpField">
        <textarea
          value={value}
          rows={1}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
          }}
          placeholder="Continuá sobre la respuesta del consenso…"
        />
        <div className="followUpActions">
          <span className="followUpModels">{selectedCount} modelos</span>
          <button
            className="submitButton"
            type="button"
            onClick={submit}
            disabled={!value.trim()}
            aria-label="Enviar repregunta"
          >
            <ArrowUp size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}

/** Maps a model's real run state to the CouncilPanel's NodeState — used to
 * drive both the color/animation (via CSS class) and the label shown. */

/* =========================================================
   Composer
   ========================================================= */

export function CouncilComposer({
  query, setQuery, councilEnabled, setCouncilEnabled, enterSearchMode, enterCouncilMode,
  webGrounding, toggleWebGrounding,
  menuOpen, setMenuOpen,
  selectorOpen, setSelectorOpen,
  selectedCount, selectedFusionPanelId, applyFusionPanel, models, toggleModel, cycleReasoningEffort,
  selectTopThree, attachments, agentSkills,
  imageGenerationEnabled, onOpenSettings,
  onFilesSelected, onRemoveAttachment, runCouncil, modelHealth,
  pingStatus, pinging, onPingModels,
}: {
  query: string;
  setQuery: (value: string) => void;
  councilEnabled: boolean;
  setCouncilEnabled: (value: boolean) => void;
  enterSearchMode: () => void;
  enterCouncilMode: () => void;
  webGrounding: boolean;
  toggleWebGrounding: () => void;
  menuOpen: boolean;
  setMenuOpen: (value: boolean) => void;
  selectorOpen: boolean;
  setSelectorOpen: (value: boolean) => void;
  selectedCount: number;
  selectedFusionPanelId: string;
  applyFusionPanel: (id: string) => void;
  models: RunModel[];
  toggleModel: (id: string) => void;
  cycleReasoningEffort: (id: string) => void;
  selectTopThree: () => void;
  attachments: UploadedAttachment[];
  agentSkills: AgentSkill[];
  imageGenerationEnabled: boolean;
  onOpenSettings: () => void;
  onFilesSelected: (files: FileList) => void | Promise<void>;
  onRemoveAttachment: (id: string) => void;
  runCouncil: () => void;
  modelHealth: Record<string, ModelHealthInfo>;
  pingStatus: Record<string, ModelPingState>;
  pinging: boolean;
  onPingModels: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  return (
    <div className="composerWrap">
      <div className="composer">
        <div className="composerTop">
          <div className="promptField">
            {councilEnabled ? (
              <span className="councilPill">
                <Layers3 size={12} />
                Model council · {selectedCount} models
              </span>
            ) : null}
            <textarea
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Preguntá lo que quieras..."
              rows={1}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  runCouncil();
                }
              }}
            />
            {attachments.length ? (
              <div className="attachmentTray">
                {attachments.map((attachment) => (
                  <span className="attachmentChip" key={attachment.id}>
                    {attachment.kind === "image" ? <Upload size={12} /> : <FileText size={12} />}
                    <span>{attachment.name}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${attachment.name}`}
                      onClick={() => onRemoveAttachment(attachment.id)}
                    >
                      <X size={11} />
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        </div>

        <div className="composerFooter">
          <div className="composerLeft">
            <div className="plusWrap">
              <button
                className="iconBtn"
                type="button"
                onClick={() => setMenuOpen(!menuOpen)}
                aria-label="Open sources and tools"
              >
                <CirclePlus size={20} />
              </button>
              {menuOpen ? (
                <div className="plusMenu">
                  {MENU_OPTIONS.map((item) => {
                    const Icon = item.icon;
                    return (
                      <button
                        key={item.label}
                        className={item.active && councilEnabled ? "plusOption active" : "plusOption"}
                        type="button"
                        onClick={() => {
                          if (item.upload) { fileInputRef.current?.click(); setMenuOpen(false); }
                          else if (item.active) { enterCouncilMode(); setMenuOpen(false); setSelectorOpen(true); }
                        }}
                      >
                        <Icon size={16} />
                        <span>
                          {item.label}
                          {item.note ? <small>{item.note}</small> : null}
                        </span>
                        {item.badge ? <em>{item.badge}</em> : null}
                      </button>
                    );
                  })}
                </div>
              ) : null}
              <input
                ref={fileInputRef}
                className="hiddenFileInput"
                type="file"
                multiple
                accept="image/*,.txt,.md,.csv,.json,.ts,.tsx,.js,.jsx,.css,.html,.xml,.yaml,.yml,.pdf,.docx"
                onChange={(event) => {
                  if (event.target.files) void onFilesSelected(event.target.files);
                  event.currentTarget.value = "";
                }}
              />
            </div>

            <div className="modeTabs">
              <button
                type="button"
                className={!councilEnabled ? "modeTab active" : "modeTab"}
                onClick={() => enterSearchMode()}
              >
                <Search size={14} /> Search
              </button>
              <button
                type="button"
                className={councilEnabled ? "modeTab active" : "modeTab"}
                onClick={() => enterCouncilMode()}
              >
                <Layers3 size={14} /> Council
              </button>
            </div>

            <button
              type="button"
              className={webGrounding ? "modeTab active" : "modeTab"}
              onClick={toggleWebGrounding}
              title={webGrounding ? "Web grounding on — models will use live search" : "Enable web grounding"}
              aria-pressed={webGrounding}
            >
              <Globe size={14} /> Web
            </button>

            <div className="settingsWrap">
              <button
                type="button"
                className={agentSkills.some((skill) => skill.enabled) || imageGenerationEnabled ? "modeTab active" : "modeTab"}
                onClick={onOpenSettings}
                title="Abrir ajustes de conectores, habilidades, research e imágenes"
              >
                <Wrench size={14} /> Ajustes
              </button>
            </div>
          </div>

          <div className="composerRight">
            <div className="modelSelectorWrap">
              <button
                className="modelCountButton"
                type="button"
                onClick={() => setSelectorOpen(!selectorOpen)}
              >
                {councilEnabled ? `${selectedCount} modelos` : "1 modelo"} <ChevronDown size={14} />
              </button>
              {selectorOpen ? (
                <ModelSelector
                  models={models}
                  selectedCount={selectedCount}
                  selectedFusionPanelId={selectedFusionPanelId}
                  applyFusionPanel={applyFusionPanel}
                  toggleModel={toggleModel}
                  cycleReasoningEffort={cycleReasoningEffort}
                  selectTopThree={selectTopThree}
                  councilEnabled={councilEnabled}
                  modelHealth={modelHealth}
                  pingStatus={pingStatus}
                  pinging={pinging}
                  onPingModels={onPingModels}
                />
              ) : null}
            </div>
            <button className="iconBtn" type="button" aria-label="Entrada de voz">
              <Mic size={18} />
            </button>
            <button
              className="submitButton"
              type="button"
              onClick={runCouncil}
              disabled={!query.trim() && false}
              aria-label="Enviar pregunta"
            >
              <ArrowUp size={18} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* =========================================================
   Model Selector
   ========================================================= */

export function ModelSelector({
  models, selectedCount, selectedFusionPanelId, applyFusionPanel, toggleModel, cycleReasoningEffort, selectTopThree, councilEnabled, modelHealth,
  pingStatus, pinging, onPingModels,
}: {
  models: RunModel[];
  selectedCount: number;
  selectedFusionPanelId: string;
  applyFusionPanel: (id: string) => void;
  toggleModel: (id: string) => void;
  cycleReasoningEffort: (id: string) => void;
  selectTopThree: () => void;
  councilEnabled: boolean;
  modelHealth: Record<string, ModelHealthInfo>;
  pingStatus: Record<string, ModelPingState>;
  pinging: boolean;
  onPingModels: () => void;
}) {
  return (
    <aside className="modelSelector">
      <div className="selectorHeader">
        <div>
          <h2>{councilEnabled ? "Miembros del consenso" : "Buscar modelo"}</h2>
          <p>
            {councilEnabled
              ? `${selectedCount} de ${models.length} seleccionados · mínimo 2`
              : `Elegí un modelo para responder · ${models.length} disponibles`}
          </p>
        </div>
        <div className="selectorHeaderActions">
          <button
            className="quickSelect"
            type="button"
            onClick={onPingModels}
            disabled={pinging || selectedCount === 0}
            title="Probar que los modelos seleccionados respondan, antes de correr el consenso completo"
          >
            {pinging ? <Loader2 size={13} className="spin" /> : <Activity size={13} />}
            {pinging ? "Probando…" : "Probar modelos"}
          </button>
          {councilEnabled ? (
            <button className="quickSelect" type="button" onClick={selectTopThree}>
              Volver a 3
            </button>
          ) : null}
        </div>
      </div>
      {councilEnabled ? (
        <div className="fusionPanelList" aria-label="Paneles de fusión predefinidos">
          {FUSION_PANELS.map((panel) => (
            <button
              key={panel.id}
              type="button"
              className={selectedFusionPanelId === panel.id ? "fusionPanel active" : "fusionPanel"}
              onClick={() => applyFusionPanel(panel.id)}
            >
              <span>
                <strong>{panel.shortName}</strong>
                {panel.featured ? <em>Fusión</em> : null}
              </span>
              <small>{panel.scoreLabel} · {panel.costLabel}</small>
            </button>
          ))}
        </div>
      ) : null}
      <div className="modelRows">
        {models.map((model) => {
          const health = modelHealth[model.id];
          const isFlaky = health && health.attempts >= 2 && health.failures / health.attempts >= 0.4;
          const ping = pingStatus[model.id];
          return (
          <div className="modelRow" key={model.id}>
            <ModelBadge model={model} />
            <div className="modelMeta">
              <strong>
                {model.label}
                {isFlaky ? (
                  <span
                    className="modelHealthWarning"
                    title={`Falló ${health.failures} de ${health.attempts} intentos recientes${health.lastFailureReason ? `: ${health.lastFailureReason}` : ""}`}
                  >
                    <AlertTriangle size={12} />
                  </span>
                ) : null}
              </strong>
              <span>{model.maker}</span>
            </div>
            {ping ? (
              <span
                className={`pingBadge ping-${ping.status}`}
                title={
                  ping.status === "fail"
                    ? ping.error ?? "No respondió"
                    : ping.status === "ok"
                      ? `Respondió en ${ping.latencyMs}ms`
                      : "Probando…"
                }
              >
                {ping.status === "pinging" ? <Loader2 size={12} className="spin" /> : null}
                {ping.status === "ok" ? <Check size={12} /> : null}
                {ping.status === "fail" ? <X size={12} /> : null}
              </span>
            ) : null}
            <button
              type="button"
              className={`effortCycler effort-${model.reasoningEffort}`}
              onClick={() => cycleReasoningEffort(model.id)}
              title="Clic para rotar el esfuerzo de razonamiento: bajo → medio → alto"
              aria-label={`Esfuerzo de razonamiento: ${model.reasoningEffort}. Clic para cambiar.`}
            >
              <span className="effortLabel">Esfuerzo</span>
              <span className="effortValue">{effortLabelEs(model.reasoningEffort)}</span>
            </button>
            <button
              className={model.selected ? "switch on" : "switch"}
              type="button"
              onClick={() => toggleModel(model.id)}
              aria-label={`Activar/desactivar ${model.label}`}
            >
              <span />
            </button>
          </div>
          );
        })}
      </div>
      <p className="selectorHint">
        {councilEnabled
          ? "Each model answers independently before synthesis."
          : "Search runs against the selected model only."}
      </p>
    </aside>
  );
}

