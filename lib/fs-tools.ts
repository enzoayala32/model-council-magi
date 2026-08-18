import { promises as fs } from "fs";
import path from "path";
import type { OpenRouterTool, OpenRouterToolCall } from "@/lib/llm-shared";

/**
 * Filesystem tools for the "file agent" — the one council model chosen to
 * read/propose changes to files on the machine this Next.js server runs on.
 * This only makes sense because the app is self-hosted: the API route IS a
 * local Node process with normal OS filesystem access, no separate sandbox.
 *
 * Safety model:
 *  - Every path is resolved against AGENT_FS_ROOT and rejected if it would
 *    escape that root (symlink-aware via realpath where possible).
 *  - Reads execute immediately (list_directory, read_file).
 *  - Writes never touch disk directly. propose_write_file / propose_edit_file
 *    compute a diff, stash the pending change in memory, and return a
 *    proposal id — nothing is written until the user approves it from the UI
 *    (POST /api/council/apply-file-change), which is the only place fs.writeFile
 *    is called from this module's writes.
 */

// Defaults to the project's own folder so a fresh clone is safe out of the
// box; override in .env to point at wherever you want the agent to work.
export const AGENT_FS_ROOT = path.resolve(process.env.AGENT_FS_ROOT || /* turbopackIgnore: true */ process.cwd());

const MAX_READ_BYTES = 200_000; // ~200KB — plenty for source files, keeps context sane
const MAX_LIST_ENTRIES = 400;
const PROPOSAL_TTL_MS = 30 * 60_000; // 30 min — stale proposals just expire, no cleanup job needed

type ToolResult = { name: string; content: string };

export type FileProposal = {
  id: string;
  kind: "write" | "edit";
  relPath: string;
  absPath: string;
  diff: string;
  nextContent: string;
  createdAt: number;
};

// In-memory only — fine for a single-user local dev server. Proposals don't
// need to survive a server restart, and there's only ever one process.
const pendingProposals = new Map<string, FileProposal>();

function pruneExpired() {
  const cutoff = Date.now() - PROPOSAL_TTL_MS;
  for (const [id, proposal] of pendingProposals) {
    if (proposal.createdAt < cutoff) pendingProposals.delete(id);
  }
}

export function getProposal(id: string): FileProposal | undefined {
  pruneExpired();
  return pendingProposals.get(id);
}

export function discardProposal(id: string): boolean {
  return pendingProposals.delete(id);
}

/** Applies a pending proposal to disk and removes it from the pending set. Throws on failure. */
export async function applyProposal(id: string): Promise<FileProposal> {
  const proposal = getProposal(id);
  if (!proposal) throw new Error("This proposal is gone or already applied — ask the model to propose the change again.");
  await fs.mkdir(path.dirname(proposal.absPath), { recursive: true });
  await fs.writeFile(proposal.absPath, proposal.nextContent, "utf8");
  pendingProposals.delete(id);
  return proposal;
}

function resolveSafePath(relPath: string): { relPath: string; absPath: string } {
  if (typeof relPath !== "string" || !relPath.trim()) {
    throw new Error("A file path is required.");
  }
  // Reject absolute paths outright — everything must be relative to the root.
  const cleaned = relPath.replace(/^[/\\]+/, "");
  const absPath = path.resolve(AGENT_FS_ROOT, cleaned);
  const relativeToRoot = path.relative(AGENT_FS_ROOT, absPath);
  if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
    throw new Error(`Path "${relPath}" escapes the allowed root and was refused.`);
  }
  return { relPath: cleaned, absPath };
}

export const FS_TOOLS: OpenRouterTool[] = [
  {
    type: "function",
    function: {
      name: "list_directory",
      description: `List files and folders under a path, relative to the project root (${path.basename(AGENT_FS_ROOT)}). Use "." for the root itself.`,
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: 'Relative path, e.g. "app/components" or "." for the root.' },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the full text content of one file, relative to the project root.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: 'Relative file path, e.g. "app/page.tsx".' },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_write_file",
      description:
        "Propose creating a new file or replacing a whole file's content. Does NOT write to disk — it stages a diff for the user to review and approve in the UI. Use this for a new file or a full rewrite; for a small change to an existing file, prefer propose_edit_file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path to write." },
          content: { type: "string", description: "The full new content of the file." },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_edit_file",
      description:
        "Propose a find-and-replace edit in an existing file. `find` must match the current file content exactly once. Does NOT write to disk — it stages a diff for the user to review and approve in the UI.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path to edit." },
          find: { type: "string", description: "Exact text to find. Must be unique within the file." },
          replace: { type: "string", description: "Text to replace it with." },
        },
        required: ["path", "find", "replace"],
      },
    },
  },
];

export async function executeFsTool(
  toolCall: OpenRouterToolCall,
  onProposal?: (proposal: FileProposal) => void,
): Promise<ToolResult> {
  const name = toolCall.function.name;
  const args = parseArgs(toolCall.function.arguments);

  try {
    if (name === "list_directory") return { name, content: await listDirectory(args) };
    if (name === "read_file") return { name, content: await readFileTool(args) };
    if (name === "propose_write_file") return { name, content: await proposeWriteFile(args, onProposal) };
    if (name === "propose_edit_file") return { name, content: await proposeEditFile(args, onProposal) };
    return { name, content: `Unknown filesystem tool: ${name}` };
  } catch (error) {
    return { name, content: `Filesystem tool failed: ${error instanceof Error ? error.message : "Unknown error"}` };
  }
}

/** True if `toolCall` is one this module can handle — lets the caller route between tool sets by name. */
export function isFsTool(toolCall: OpenRouterToolCall): boolean {
  return FS_TOOLS.some((tool) => tool.function.name === toolCall.function.name);
}

function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.length) throw new Error(`Missing required field: ${field}`);
  return value;
}

async function listDirectory(args: Record<string, unknown>): Promise<string> {
  const rawPath = typeof args.path === "string" ? args.path : ".";
  const { relPath, absPath } = resolveSafePath(rawPath);
  const entries = await fs.readdir(absPath, { withFileTypes: true });
  const lines = entries
    .slice(0, MAX_LIST_ENTRIES)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => `${entry.isDirectory() ? "dir " : "file"}  ${entry.name}`);
  const suffix = entries.length > MAX_LIST_ENTRIES ? `\n… ${entries.length - MAX_LIST_ENTRIES} more entries truncated` : "";
  return `${relPath || "."}/\n${lines.join("\n")}${suffix}`;
}

async function readFileTool(args: Record<string, unknown>): Promise<string> {
  const rawPath = requireString(args.path, "path");
  const { absPath } = resolveSafePath(rawPath);
  const stat = await fs.stat(absPath);
  if (stat.isDirectory()) throw new Error(`"${rawPath}" is a directory, not a file.`);
  const buffer = await fs.readFile(absPath);
  const truncated = buffer.byteLength > MAX_READ_BYTES;
  const text = buffer.subarray(0, MAX_READ_BYTES).toString("utf8");
  return truncated ? `${text}\n\n… truncated (${buffer.byteLength} bytes total, showing first ${MAX_READ_BYTES})` : text;
}

async function proposeWriteFile(args: Record<string, unknown>, onProposal?: (proposal: FileProposal) => void): Promise<string> {
  const rawPath = requireString(args.path, "path");
  const content = requireString(args.content, "content");
  const { relPath, absPath } = resolveSafePath(rawPath);

  const previous = await readIfExists(absPath);
  const diff = buildDiff(previous ?? "", content, relPath, previous === null);

  const proposal: FileProposal = {
    id: newProposalId(),
    kind: "write",
    relPath,
    absPath,
    diff,
    nextContent: content,
    createdAt: Date.now(),
  };
  pendingProposals.set(proposal.id, proposal);
  onProposal?.(proposal);

  return `Proposed ${previous === null ? "creating" : "rewriting"} "${relPath}" (proposal ${proposal.id}). Waiting for the user to approve or discard it in the UI — nothing was written to disk.\n\n${diff}`;
}

async function proposeEditFile(args: Record<string, unknown>, onProposal?: (proposal: FileProposal) => void): Promise<string> {
  const rawPath = requireString(args.path, "path");
  const find = requireString(args.find, "find");
  const replace = typeof args.replace === "string" ? args.replace : "";
  const { relPath, absPath } = resolveSafePath(rawPath);

  const previous = await readIfExists(absPath);
  if (previous === null) throw new Error(`"${relPath}" does not exist — use propose_write_file to create it.`);

  const occurrences = previous.split(find).length - 1;
  if (occurrences === 0) throw new Error(`Could not find the given text in "${relPath}". The edit was not proposed.`);
  if (occurrences > 1) throw new Error(`The given text appears ${occurrences} times in "${relPath}" — it must be unique. Include more surrounding context.`);

  const nextContent = previous.replace(find, replace);
  const diff = buildDiff(previous, nextContent, relPath, false);

  const proposal: FileProposal = {
    id: newProposalId(),
    kind: "edit",
    relPath,
    absPath,
    diff,
    nextContent,
    createdAt: Date.now(),
  };
  pendingProposals.set(proposal.id, proposal);
  onProposal?.(proposal);

  return `Proposed an edit to "${relPath}" (proposal ${proposal.id}). Waiting for the user to approve or discard it in the UI — nothing was written to disk.\n\n${diff}`;
}

async function readIfExists(absPath: string): Promise<string | null> {
  try {
    const buffer = await fs.readFile(absPath);
    return buffer.toString("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function newProposalId(): string {
  return `fp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Minimal unified-diff-style text, line-based, via a plain LCS — no
 * dependency pulled in just for this. Good enough for the file sizes this
 * tool deals with (source files, not huge data dumps); MAX_READ_BYTES
 * already keeps read_file from feeding it anything enormous.
 */
function buildDiff(oldText: string, newText: string, relPath: string, isNew: boolean): string {
  if (isNew) {
    const lines = newText.split("\n");
    const body = lines.map((line) => `+${line}`).join("\n");
    return `--- /dev/null\n+++ ${relPath}\n${body}`;
  }

  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const ops = diffLines(oldLines, newLines);

  const out: string[] = [`--- ${relPath}`, `+++ ${relPath}`];
  for (const op of ops) {
    if (op.type === "equal") out.push(` ${op.line}`);
    else if (op.type === "del") out.push(`-${op.line}`);
    else out.push(`+${op.line}`);
  }
  return out.join("\n");
}

type DiffOp = { type: "equal" | "add" | "del"; line: string };

/** Classic LCS-based line diff. O(n*m) — fine at file-sized line counts. */
function diffLines(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "equal", line: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "del", line: a[i] });
      i++;
    } else {
      ops.push({ type: "add", line: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ type: "del", line: a[i++] });
  while (j < m) ops.push({ type: "add", line: b[j++] });
  return ops;
}
