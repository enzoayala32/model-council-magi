import type { NodeState } from "@/app/components/council/types";
import type { AgentSkill } from "@/lib/skills";
import { DEFAULT_SKILLS } from "@/lib/skills";
import type { ReasoningEffort } from "@/lib/models";
import type {
  ConnectorSettings,
  CouncilStreamEvent,
  FusionJudgeReport,
  RunModel,
  RunPhase,
  TokenUsage,
  UploadedAttachment,
} from "./client-types";
import { CONNECTORS_STORAGE_KEY, SKILLS_STORAGE_KEY } from "./constants";

/**
 * Pure, side-effect-light client helpers — formatting, localStorage
 * persistence, file reading, and the markdown export builder. Split out of
 * app/page.tsx so components can import just what they need without pulling
 * in the whole page component.
 */

export function nodeStateFor(model: RunModel, runPhase: RunPhase): NodeState {
  if (model.error) return "error";
  if (runPhase === "drafting") {
    if (model.status === "thinking") return "thinking";
    if (model.status === "complete") return "complete";
    return "waiting";
  }
  if (model.debateStatus === "thinking") return "debating";
  if (model.debateStatus === "complete") return "complete";
  return "waiting";
}

export function formatElapsed(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/** Compact token count for the MAGI panel readout — "842", "12.4K", "1.2M". */
export function formatTokens(value: number | undefined) {
  const n = value ?? 0;
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Display-only translation — the underlying value ("low"/"medium"/"high")
 * must stay in English since it's sent as-is to the OpenRouter/NVIDIA APIs. */
export function effortLabelEs(effort: ReasoningEffort): string {
  return effort === "low" ? "bajo" : effort === "high" ? "alto" : "medio";
}

export function timeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

export function appendUnique(items: string[], next: string) {
  if (items.includes(next)) return items;
  return [...items, next].slice(-6);
}

export function latestActivity(model: RunModel) {
  return model.activityLog.at(-1) ?? "I will analyze the prompt and prepare an independent response.";
}

export function currentHeadline(models: RunModel[]) {
  const active = models.find((model) => model.status === "thinking") ?? models[0];
  if (!active) return "Preparing council…";
  return latestActivity(active);
}

/* =========================================================
   localStorage persistence — agent skills + connector settings
   ========================================================= */

export function loadAgentSkills(): AgentSkill[] {
  if (typeof window === "undefined") return DEFAULT_SKILLS;
  try {
    const raw = window.localStorage.getItem(SKILLS_STORAGE_KEY);
    if (!raw) return DEFAULT_SKILLS;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_SKILLS;
    const custom = parsed.filter((skill): skill is AgentSkill =>
      typeof skill?.id === "string" && typeof skill.name === "string" && typeof skill.body === "string",
    );
    return custom.length ? custom : DEFAULT_SKILLS;
  } catch {
    return DEFAULT_SKILLS;
  }
}

export function saveAgentSkills(skills: AgentSkill[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SKILLS_STORAGE_KEY, JSON.stringify(skills.slice(0, 50)));
  } catch {
    /* localStorage may be full or disabled */
  }
}

export function loadConnectorSettings(): ConnectorSettings {
  if (typeof window === "undefined") return { github: true, filesystem: false };
  try {
    const raw = window.localStorage.getItem(CONNECTORS_STORAGE_KEY);
    if (!raw) return { github: true, filesystem: false };
    const parsed = JSON.parse(raw) as Partial<ConnectorSettings>;
    return { github: parsed.github !== false, filesystem: parsed.filesystem === true };
  } catch {
    return { github: true, filesystem: false };
  }
}

export function saveConnectorSettings(settings: ConnectorSettings) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CONNECTORS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* localStorage may be full or disabled */
  }
}

export function compactQuestion(content: string) {
  const normalized = content.replace(/\s+/g, " ").trim();
  return normalized.length > 220 ? `${normalized.slice(0, 220)}…` : normalized;
}

/* =========================================================
   Markdown export
   ========================================================= */

export function slugify(text: string, maxLength = 60) {
  const slug = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (slug || "council-thread").slice(0, maxLength);
}

export function buildMarkdownExport({
  query,
  synthesis,
  fusionJudge,
  models,
  followUps,
  tokenUsage,
}: {
  query: string;
  synthesis: string;
  fusionJudge: FusionJudgeReport | null;
  models: RunModel[];
  followUps: string[];
  tokenUsage?: TokenUsage;
}) {
  const lines: string[] = [];
  const usedModels = models.filter((model) => model.response || model.error);
  const timestamp = new Date().toISOString();

  lines.push(`# Council question`, "", query.trim(), "");
  const tokenNote = tokenUsage?.total_tokens
    ? ` — Tokens: ${tokenUsage.total_tokens} (${tokenUsage.prompt_tokens ?? 0} prompt / ${tokenUsage.completion_tokens ?? 0} completion)`
    : "";
  lines.push(
    `_Generated by Open Model Council — ${timestamp} — Models: ${usedModels.map((m) => m.label).join(", ") || "none"}${tokenNote}_`,
    "",
  );

  if (synthesis) {
    lines.push("## Synthesized answer", "", synthesis.trim(), "");
  }

  if (fusionJudge) {
    lines.push("## Fusion judge report", "");
    if (fusionJudge.panelVerdict) {
      lines.push("### Panel verdict", "", fusionJudge.panelVerdict.trim(), "");
    }
    if (fusionJudge.consensus?.length) {
      lines.push("### Where the council agreed", "");
      fusionJudge.consensus.forEach((item) => {
        lines.push(`- **${item.finding}** (agreed by: ${item.models.join(", ")}) — ${item.evidence}`);
      });
      lines.push("");
    }
    if (fusionJudge.contradictions?.length) {
      lines.push("### Where the council disagreed", "");
      fusionJudge.contradictions.forEach((item) => {
        lines.push(`#### ${item.topic}`, "");
        Object.entries(item.positions).forEach(([modelName, position]) => {
          lines.push(`- **${modelName}:** ${position}`);
        });
        lines.push("", `**Judgment:** ${item.judgment}`, "");
      });
    }
    if (fusionJudge.uniqueInsights?.length) {
      lines.push("### Unique insights", "");
      fusionJudge.uniqueInsights.forEach((item) => {
        lines.push(`- **${item.model}:** ${item.insight} — _Why it matters:_ ${item.whyItMatters}`);
      });
      lines.push("");
    }
    if (fusionJudge.coverageGaps?.length) {
      lines.push("### Coverage gaps", "");
      fusionJudge.coverageGaps.forEach((gap) => lines.push(`- ${gap}`));
      lines.push("");
    }
  }

  if (usedModels.length) {
    lines.push("## Individual model responses", "");
    usedModels.forEach((model) => {
      lines.push(`### ${model.label} (${model.maker})`, "");
      if (model.error) {
        lines.push(`**Error:** ${model.error}`, "");
        return;
      }
      if (model.response) {
        lines.push("**Independent draft:**", "", model.response.trim(), "");
      }
      if (model.critique) {
        lines.push("**Debate critique:**", "", model.critique.trim(), "");
      }
      if (model.revisedAnswer) {
        lines.push("**Revised answer:**", "", model.revisedAnswer.trim(), "");
      }
      lines.push("---", "");
    });
  }

  if (followUps.length) {
    lines.push("## Suggested follow-up questions", "");
    followUps.forEach((question, index) => lines.push(`${index + 1}. ${question}`));
    lines.push("");
  }

  return lines.join("\n").trim() + "\n";
}

export function downloadTextFile(filename: string, content: string, mimeType = "text/markdown;charset=utf-8") {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

/* =========================================================
   Tribunal view helpers — short case code + verdict snippet
   ========================================================= */

/** Short, deterministic, non-cryptographic hash — just needs to look like
 * a stable case code for the same query, not to be secure. */
export function caseCode(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(16).toUpperCase().padStart(6, "0").slice(0, 6);
}

/** Pulls a short verdict line out of a draft/revised answer for the seat
 * card — prefers the "Direct Answer" section if the model followed the
 * expected format, otherwise just the first stretch of prose. */
export function verdictSnippet(content: string, maxLen = 150): string {
  const match = content.match(/##\s+Direct Answer\s*\n([\s\S]*?)(?=\n##\s+|$)/i);
  const text = (match ? match[1] : content).replace(/[#*_`]/g, "").trim();
  return text.length > maxLen ? `${text.slice(0, maxLen).trim()}…` : text;
}

/* =========================================================
   Fusion report name-matching helpers
   ========================================================= */

export function normalizeName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9.]+/g, " ").trim();
}

export function reportNamesModel(names: string[], model: RunModel) {
  const normalized = names.map(normalizeName).filter(Boolean);
  return normalized.some((name) =>
    name === normalizeName(model.label)
    || name === normalizeName(model.id)
    || name === normalizeName(model.maker)
    || name.includes(normalizeName(model.badge))
    || normalizeName(model.label).includes(name),
  );
}

export function positionForModel(positions: Record<string, string>, model: RunModel) {
  const match = Object.entries(positions).find(([name]) => reportNamesModel([name], model));
  return match?.[1];
}

/* =========================================================
   SSE stream reading + file upload reading
   ========================================================= */

export async function readCouncilStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: CouncilStreamEvent) => void,
  signal?: AbortSignal,
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const onAbort = () => {
    reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort);

  try {
    while (true) {
      if (signal?.aborted) break;
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";

      for (const chunk of chunks) {
        const line = chunk.split("\n").find((item) => item.startsWith("data: "));
        if (!line) continue;
        onEvent(JSON.parse(line.replace(/^data: /, "")) as CouncilStreamEvent);
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

export async function readUploads(files: FileList): Promise<UploadedAttachment[]> {
  const selected = Array.from(files).slice(0, 8);
  const attachments = await Promise.all(
    selected.map(async (file) => {
      const base = {
        id: `${file.name}-${file.size}-${file.lastModified}-${crypto.randomUUID()}`,
        name: file.name,
        type: file.type || "application/octet-stream",
        size: file.size,
      };

      if (file.type.startsWith("image/")) {
        return { ...base, kind: "image" as const, dataUrl: await readFileAsDataUrl(file) };
      }
      if (isPdfFile(file)) {
        return { ...base, kind: "pdf" as const, dataUrl: await readFileAsDataUrl(file) };
      }
      if (isDocxFile(file)) {
        return { ...base, kind: "docx" as const, dataUrl: await readFileAsDataUrl(file) };
      }
      if (isTextLikeFile(file)) {
        return { ...base, kind: "text" as const, text: await readFileAsText(file) };
      }
      return { ...base, kind: "file" as const };
    }),
  );

  return attachments;
}

export function isPdfFile(file: File) {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
}

export function isDocxFile(file: File) {
  return (
    file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || /\.docx$/i.test(file.name)
  );
}

export function isTextLikeFile(file: File) {
  const textTypes = ["text/", "application/json", "application/xml", "application/yaml"];
  const textExtensions = /\.(txt|md|csv|json|ts|tsx|js|jsx|css|html|xml|yaml|yml)$/i;
  return textTypes.some((type) => file.type.startsWith(type)) || textExtensions.test(file.name);
}

export function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

export function readFileAsText(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}`));
    reader.readAsText(file);
  });
}
