export type AgentSkill = {
  id: string;
  name: string;
  description: string;
  body: string;
  enabled: boolean;
  createdAt: number;
};

export type SkillImportResult = {
  name: string;
  description: string;
  body: string;
};

export const DEFAULT_SKILLS: AgentSkill[] = [
  {
    id: "skill-github-code-investigator",
    name: "GitHub Code Investigator",
    description: "Use GitHub tools before answering repo, issue, PR, or source-code questions.",
    body: [
      "# GitHub Code Investigator",
      "",
      "When the prompt mentions a GitHub repository, issue, PR, branch, commit, or source path:",
      "- Identify the repo owner/name explicitly before calling tools.",
      "- Use GitHub tools to inspect live repository data instead of relying on memory.",
      "- Cite file paths, issue numbers, PR numbers, branches, and commits when they matter.",
      "- Separate verified repository facts from recommendations or guesses.",
      "- If authentication is missing or a private repo is inaccessible, say exactly which lookup failed.",
    ].join("\n"),
    enabled: true,
    createdAt: 0,
  },
];

export function renderSkillsForPrompt(skills: AgentSkill[]) {
  const enabled = skills.filter((skill) => skill.enabled && skill.name.trim() && skill.body.trim()).slice(0, 12);
  if (!enabled.length) return "";

  return [
    "# Active agent skills",
    "Use these imported skills as operating instructions for this run. Prefer the most specific skill when multiple apply.",
    ...enabled.map((skill, index) =>
      [
        `## Skill ${index + 1}: ${skill.name}`,
        skill.description ? `Description: ${skill.description}` : "",
        skill.body,
      ].filter(Boolean).join("\n"),
    ),
  ].join("\n\n");
}

export function importSkillFromText(input: string): SkillImportResult {
  const trimmed = input.trim();
  if (!trimmed) {
    return {
      name: "Untitled Skill",
      description: "",
      body: "",
    };
  }

  try {
    const parsed = JSON.parse(trimmed) as Partial<AgentSkill> & { title?: string };
    const name = firstNonEmpty(parsed.name, parsed.title, "Imported Skill");
    return {
      name,
      description: firstNonEmpty(parsed.description, ""),
      body: firstNonEmpty(parsed.body, parsed.description, trimmed),
    };
  } catch {
    const title = trimmed.match(/^#\s+(.+)$/m)?.[1]?.trim();
    const description =
      trimmed.match(/^description:\s*(.+)$/im)?.[1]?.trim()
      ?? trimmed.split(/\r?\n/).find((line) => line.trim() && !line.trim().startsWith("#"))?.trim()
      ?? "";
    return {
      name: title || "Imported Skill",
      description,
      body: trimmed,
    };
  }
}

function firstNonEmpty(...values: Array<string | undefined>) {
  return values.find((value) => typeof value === "string" && value.trim().length > 0)?.trim() ?? "";
}
