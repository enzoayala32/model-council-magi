"use client";
import { useState } from "react";
import { FolderCog, Globe, Image as ImageIcon, Search, Wrench, X } from "lucide-react";
import type { ConnectorSettings, SettingsTab } from "../../lib/client-types";
import type { AgentSkill } from "@/lib/skills";
import { IMAGE_MODELS } from "@/lib/models";
import { PERSONA_PRESETS } from "@/lib/persona-presets";
import { importSkillFromText } from "@/lib/skills";
import { newId } from "@/lib/threads";

export function SettingsDrawer({
  tab,
  setTab,
  connectors,
  setConnectors,
  fileAgentModelId,
  setFileAgentModelId,
  fileAgentCandidates,
  skills,
  setSkills,
  webGrounding,
  setWebGrounding,
  maxDebateRounds,
  setMaxDebateRounds,
  personaPresetId,
  setPersonaPresetId,
  adaptiveMode,
  setAdaptiveMode,
  selectedCount,
  imageGenerationEnabled,
  setImageGenerationEnabled,
  selectedImageModel,
  setSelectedImageModel,
  onClose,
}: {
  tab: SettingsTab;
  setTab: (tab: SettingsTab) => void;
  connectors: ConnectorSettings;
  setConnectors: React.Dispatch<React.SetStateAction<ConnectorSettings>>;
  fileAgentModelId: string;
  setFileAgentModelId: (id: string) => void;
  fileAgentCandidates: Array<{ id: string; label: string }>;
  skills: AgentSkill[];
  setSkills: React.Dispatch<React.SetStateAction<AgentSkill[]>>;
  webGrounding: boolean;
  setWebGrounding: (value: boolean) => void;
  maxDebateRounds: number;
  setMaxDebateRounds: (value: number) => void;
  personaPresetId: string;
  setPersonaPresetId: (value: string) => void;
  adaptiveMode: boolean;
  setAdaptiveMode: (value: boolean) => void;
  selectedCount: number;
  imageGenerationEnabled: boolean;
  setImageGenerationEnabled: (value: boolean) => void;
  selectedImageModel: string;
  setSelectedImageModel: (value: string) => void;
  onClose: () => void;
}) {
  const [draftName, setDraftName] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [importText, setImportText] = useState("");

  function addSkill() {
    const body = draftBody.trim();
    const name = draftName.trim();
    if (!name || !body) return;
    setSkills((current) => [
      ...current,
      {
        id: newId("skill"),
        name,
        description: draftDescription.trim(),
        body,
        enabled: true,
        createdAt: Date.now(),
      },
    ]);
    setDraftName("");
    setDraftDescription("");
    setDraftBody("");
  }

  function importSkill() {
    const parsed = importSkillFromText(importText);
    if (!parsed.body.trim()) return;
    setSkills((current) => [
      ...current,
      {
        id: newId("skill"),
        name: parsed.name,
        description: parsed.description,
        body: parsed.body,
        enabled: true,
        createdAt: Date.now(),
      },
    ]);
    setImportText("");
  }

  return (
    <div className="settingsBackdrop" role="presentation" onClick={onClose}>
      <aside className="settingsDrawer" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <header className="settingsDrawerHeader">
          <div>
            <span>Espacio de trabajo</span>
            <h2>Ajustes</h2>
          </div>
          <button className="closeButton" type="button" onClick={onClose} aria-label="Cerrar ajustes">
            <X size={18} />
          </button>
        </header>

      <div className="settingsTabs" role="tablist">
        <button className={tab === "connectors" ? "active" : ""} type="button" onClick={() => setTab("connectors")}>
          <Globe size={13} /> Conectores
        </button>
        <button className={tab === "skills" ? "active" : ""} type="button" onClick={() => setTab("skills")}>
          <Wrench size={13} /> Habilidades
        </button>
        <button className={tab === "research" ? "active" : ""} type="button" onClick={() => setTab("research")}>
          <Search size={13} /> Investigación
        </button>
        <button className={tab === "images" ? "active" : ""} type="button" onClick={() => setTab("images")}>
          <ImageIcon size={13} /> Imágenes
        </button>
      </div>

      {tab === "connectors" ? (
        <div className="settingsPane">
          <div className="settingsHeader">
            <strong>Conectores</strong>
            <span>{[connectors.github, connectors.filesystem].filter(Boolean).length} activados</span>
          </div>
          <div className="connectorList">
            <article className="connectorRow">
              <div className="connectorIcon"><Globe size={16} /></div>
              <div>
                <strong>GitHub</strong>
                <span>Busca repositorios, inspecciona archivos, y lista issues o pull requests durante las corridas del agente.</span>
              </div>
              <button
                className={connectors.github ? "switch on" : "switch"}
                type="button"
                onClick={() => setConnectors((current) => ({ ...current, github: !current.github }))}
                aria-label="Activar/desactivar conector de GitHub"
              >
                <span />
              </button>
            </article>
            <article className="connectorRow">
              <div className="connectorIcon"><FolderCog size={16} /></div>
              <div>
                <strong>Sistema de archivos (local)</strong>
                <span>
                  Le da a un modelo del panel acceso de lectura y escritura a los archivos del proyecto en esta PC. Las lecturas
                  (listar carpetas, leer archivos) corren directo; cualquier escritura o edición queda propuesta con un diff y
                  no se aplica hasta que la confirmés vos.
                </span>
              </div>
              <button
                className={connectors.filesystem ? "switch on" : "switch"}
                type="button"
                onClick={() => setConnectors((current) => ({ ...current, filesystem: !current.filesystem }))}
                aria-label="Activar/desactivar conector de sistema de archivos"
              >
                <span />
              </button>
            </article>
            {connectors.filesystem ? (
              <div className="fileAgentPicker">
                <label htmlFor="file-agent-select">Modelo agente de archivos</label>
                <select
                  id="file-agent-select"
                  value={fileAgentModelId}
                  onChange={(event) => setFileAgentModelId(event.target.value)}
                >
                  <option value="">Ninguno seleccionado</option>
                  {fileAgentCandidates.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.label}
                    </option>
                  ))}
                </select>
                <span className="settingsNote" style={{ margin: 0 }}>
                  Solo este modelo, dentro del panel elegido, va a poder leer y proponer cambios de archivos durante drafting y debate.
                </span>
              </div>
            ) : null}
          </div>
          <div className="settingsNote">
            GitHub funciona con repositorios públicos sin configuración. Agregá `GITHUB_TOKEN` en el servidor para repos privados y límites de API más altos.
          </div>
          <div className="settingsNote">
            El agente de archivos opera dentro de la carpeta del proyecto (o la que definas en `AGENT_FS_ROOT` en el servidor) y nunca puede salir de ahí.
          </div>
          <div className="settingsNote">
            Tanto ChatGPT como Claude ponen los conectores en Ajustes, requieren autenticación de terceros por usuario, y dejan que cada chat use selectivamente las fuentes conectadas. Esta app replica eso con toggles de conectores a nivel de espacio de trabajo y uso de herramientas por corrida.
          </div>
        </div>
      ) : tab === "skills" ? (
        <div className="settingsPane">
          <div className="settingsHeader">
            <strong>Habilidades del agente</strong>
            <span>{skills.filter((skill) => skill.enabled).length} activas</span>
          </div>
          <div className="skillList">
            {skills.map((skill) => (
              <div className="skillRow" key={skill.id}>
                <button
                  className={skill.enabled ? "switch on" : "switch"}
                  type="button"
                  onClick={() =>
                    setSkills((current) =>
                      current.map((item) => item.id === skill.id ? { ...item, enabled: !item.enabled } : item),
                    )
                  }
                  aria-label={`Activar/desactivar ${skill.name}`}
                >
                  <span />
                </button>
                <div>
                  <strong>{skill.name}</strong>
                  <span>{skill.description || "Instrucción importada"}</span>
                </div>
                <button
                  className="deleteSkill"
                  type="button"
                  onClick={() => setSkills((current) => current.filter((item) => item.id !== skill.id))}
                  aria-label={`Eliminar ${skill.name}`}
                >
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>

          <div className="skillEditor">
            <input value={draftName} onChange={(event) => setDraftName(event.target.value)} placeholder="Nombre de la nueva habilidad" />
            <input value={draftDescription} onChange={(event) => setDraftDescription(event.target.value)} placeholder="¿Cuándo debería aplicarse esta habilidad?" />
            <textarea value={draftBody} onChange={(event) => setDraftBody(event.target.value)} placeholder="Escribí las instrucciones de la habilidad..." rows={4} />
            <button type="button" onClick={addSkill} disabled={!draftName.trim() || !draftBody.trim()}>
              Crear habilidad
            </button>
          </div>

          <div className="skillEditor">
            <textarea value={importText} onChange={(event) => setImportText(event.target.value)} placeholder="Pegá un SKILL.md o una habilidad en JSON para importar..." rows={4} />
            <button type="button" onClick={importSkill} disabled={!importText.trim()}>
              Importar habilidad
            </button>
          </div>
        </div>
      ) : tab === "research" ? (
        <div className="settingsPane">
          <div className="settingsHeader">
            <strong>Comportamiento de research</strong>
            <span>{webGrounding ? "web activada" : "web desactivada"}</span>
          </div>
          <label className="imageToggle">
            <input
              type="checkbox"
              checked={webGrounding}
              onChange={(event) => setWebGrounding(event.target.checked)}
            />
            Usar búsqueda web de OpenRouter en el chat
          </label>
          <div className="fileAgentPicker">
            <label htmlFor="max-debate-rounds">Rondas de debate (máximo)</label>
            <select
              id="max-debate-rounds"
              value={maxDebateRounds}
              onChange={(event) => setMaxDebateRounds(Number(event.target.value))}
            >
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n} {n === 1 ? "ronda" : "rondas"}
                </option>
              ))}
            </select>
            <span className="settingsNote" style={{ margin: 0 }}>
              El consejo debate hasta este máximo, pero corta antes si las respuestas convergen (medido por
              vocabulario compartido entre los modelos). Al terminar el debate, cada modelo sobreviviente vota por
              la respuesta más fuerte del panel.
            </span>
          </div>
          <div className="fileAgentPicker">
            <div className="magiModeHeader">
              <label htmlFor="adaptive-mode-toggle">Modo adaptativo</label>
              <button
                id="adaptive-mode-toggle"
                className={adaptiveMode ? "switch on" : "switch"}
                type="button"
                onClick={() => setAdaptiveMode(!adaptiveMode)}
                aria-label="Activar/desactivar Modo adaptativo"
              >
                <span />
              </button>
            </div>
            <span className="settingsNote" style={{ margin: 0 }}>
              Antes de debatir, mide cuánto coinciden ya los borradores independientes. Si el acuerdo es alto,
              se salta el debate (y la votación) directo a la síntesis — ahorra llamadas cuando el panel ya está de
              acuerdo desde el principio.
            </span>
          </div>
          <div className="fileAgentPicker">
            <label htmlFor="persona-preset-select">Preset de personas del debate</label>
            <select
              id="persona-preset-select"
              value={personaPresetId}
              onChange={(event) => setPersonaPresetId(event.target.value)}
            >
              <option value="">Ninguno (sin lentes fijas)</option>
              {PERSONA_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.label}
                </option>
              ))}
            </select>
            <span className="settingsNote" style={{ margin: 0 }}>
              {personaPresetId
                ? PERSONA_PRESETS.find((p) => p.id === personaPresetId)?.description
                : "Asigna a cada uno de los 3 modelos una lente analítica fija durante el debate — mismo concepto que el sistema MAGI, con distintos sets intercambiables (revisión de código, investigación, escritura, estrategia)."}
              {" "}Requiere exactamente 3 modelos seleccionados
              {selectedCount !== 3 ? (
                <> — actualmente tenés <strong>{selectedCount}</strong>, así que no tiene efecto todavía</>
              ) : (
                "."
              )}
            </span>
          </div>
          <div className="researchPatternList">
            <article>
              <strong>Apps/conectores estilo ChatGPT</strong>
              <span>Los conectores se pueden usar en el chat para buscar archivos, en deep research para reportes con citas de múltiples fuentes, y en algunos casos vía datos sincronizados/indexados. Los usuarios los activan desde Ajustes y eligen fuentes desde el composer.</span>
            </article>
            <article>
              <strong>Integraciones estilo Claude</strong>
              <span>Claude expone las integraciones en Ajustes &gt; Conectores, con activación a nivel workspace/admin para equipos y autenticación por usuario. La búsqueda web también es un ajuste estilo conector que se puede activar/desactivar.</span>
            </article>
            <article>
              <strong>Comportamiento del consenso de modelos</strong>
              <span>Cuando Web está activa, los modelos que redactan reciben resultados de búsqueda web de OpenRouter. Cuando los conectores están activados, el loop del agente puede usar sus herramientas durante el borrador, el debate, o la síntesis.</span>
            </article>
          </div>
        </div>
      ) : (
        <div className="settingsPane">
          <label className="imageToggle">
            <input
              type="checkbox"
              checked={imageGenerationEnabled}
              onChange={(event) => setImageGenerationEnabled(event.target.checked)}
            />
            Generar imagen después de la respuesta
          </label>
          <div className="imageModelList">
            {IMAGE_MODELS.map((model) => (
              <button
                key={model.id}
                type="button"
                className={selectedImageModel === model.id ? "imageModelRow active" : "imageModelRow"}
                onClick={() => setSelectedImageModel(model.id)}
              >
                <strong>{model.label}</strong>
                <span>{model.maker} · {model.id}</span>
                <p>{model.description}</p>
              </button>
            ))}
          </div>
        </div>
      )}
      </aside>
    </div>
  );
}

/* =========================================================
   Thinking Stage
   ========================================================= */

