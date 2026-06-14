import type { OpenRouterTool, OpenRouterToolCall } from "@/lib/openrouter";

type ToolResult = {
  name: string;
  content: string;
};

const GITHUB_API = "https://api.github.com";

export const AGENT_TOOLS: OpenRouterTool[] = [
  {
    type: "function",
    function: {
      name: "github_search_repositories",
      description: "Search GitHub repositories by keywords, owner, topic, language, or project name.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "GitHub repository search query." },
          limit: { type: "number", description: "Maximum repositories to return, up to 10." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "github_get_file",
      description: "Read a text file from a GitHub repository using owner, repo, path, and optional ref.",
      parameters: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          path: { type: "string" },
          ref: { type: "string", description: "Branch, tag, or commit SHA." },
        },
        required: ["owner", "repo", "path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "github_list_issues",
      description: "List recent GitHub issues or pull requests for a repository.",
      parameters: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          state: { type: "string", enum: ["open", "closed", "all"] },
          limit: { type: "number", description: "Maximum items to return, up to 20." },
        },
        required: ["owner", "repo"],
      },
    },
  },
];

export async function executeAgentTool(toolCall: OpenRouterToolCall, signal?: AbortSignal): Promise<ToolResult> {
  const name = toolCall.function.name;
  const args = parseToolArgs(toolCall.function.arguments);

  try {
    if (name === "github_search_repositories") {
      return { name, content: await searchRepositories(args, signal) };
    }
    if (name === "github_get_file") {
      return { name, content: await getRepositoryFile(args, signal) };
    }
    if (name === "github_list_issues") {
      return { name, content: await listIssues(args, signal) };
    }
    return { name, content: `Unknown tool: ${name}` };
  } catch (error) {
    return {
      name,
      content: `Tool failed: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}

function parseToolArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

async function searchRepositories(args: Record<string, unknown>, signal?: AbortSignal) {
  const query = requireString(args.query, "query");
  const limit = clampNumber(args.limit, 5, 1, 10);
  const payload = await githubFetch<{ items?: Array<Record<string, unknown>> }>(
    `/search/repositories?q=${encodeURIComponent(query)}&per_page=${limit}`,
    signal,
  );

  const items = payload.items ?? [];
  if (!items.length) return `No repositories found for query: ${query}`;
  return JSON.stringify(
    items.map((item) => ({
      full_name: item.full_name,
      description: item.description,
      stars: item.stargazers_count,
      language: item.language,
      default_branch: item.default_branch,
      url: item.html_url,
      updated_at: item.updated_at,
    })),
    null,
    2,
  );
}

async function getRepositoryFile(args: Record<string, unknown>, signal?: AbortSignal) {
  const owner = requireString(args.owner, "owner");
  const repo = requireString(args.repo, "repo");
  const path = requireString(args.path, "path");
  const ref = typeof args.ref === "string" && args.ref.trim() ? `?ref=${encodeURIComponent(args.ref.trim())}` : "";
  const payload = await githubFetch<Record<string, unknown>>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path.split("/").map(encodeURIComponent).join("/")}${ref}`,
    signal,
  );

  if (payload.type !== "file" || typeof payload.content !== "string") {
    return `GitHub path is not a readable file: ${owner}/${repo}/${path}`;
  }

  const decoded = Buffer.from(payload.content.replace(/\n/g, ""), "base64").toString("utf8");
  return [
    `Repository: ${owner}/${repo}`,
    `Path: ${path}`,
    typeof payload.sha === "string" ? `SHA: ${payload.sha}` : "",
    "",
    decoded.slice(0, 50000),
  ].filter(Boolean).join("\n");
}

async function listIssues(args: Record<string, unknown>, signal?: AbortSignal) {
  const owner = requireString(args.owner, "owner");
  const repo = requireString(args.repo, "repo");
  const state = typeof args.state === "string" ? args.state : "open";
  const limit = clampNumber(args.limit, 10, 1, 20);
  const payload = await githubFetch<Array<Record<string, unknown>>>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?state=${encodeURIComponent(state)}&per_page=${limit}`,
    signal,
  );

  if (!payload.length) return `No ${state} issues found for ${owner}/${repo}.`;
  return JSON.stringify(
    payload.map((item) => ({
      number: item.number,
      title: item.title,
      state: item.state,
      is_pull_request: Boolean(item.pull_request),
      user: typeof item.user === "object" && item.user ? (item.user as { login?: string }).login : undefined,
      comments: item.comments,
      updated_at: item.updated_at,
      url: item.html_url,
    })),
    null,
    2,
  );
}

async function githubFetch<T>(path: string, signal?: AbortSignal): Promise<T> {
  const token = process.env.GITHUB_TOKEN?.trim();
  const response = await fetch(`${GITHUB_API}${path}`, {
    signal,
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "open-model-council-agent",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof payload?.message === "string" ? payload.message : `GitHub request failed with ${response.status}`;
    throw new Error(message);
  }
  return payload as T;
}

function requireString(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing required argument: ${field}`);
  }
  return value.trim();
}

function clampNumber(value: unknown, fallback: number, min: number, max: number) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}
