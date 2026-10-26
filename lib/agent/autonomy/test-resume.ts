/**
 * Fase 9E — tests puros de `resume.ts`.
 *
 * No tocan DB ni filesystem real: `evaluateResume` recibe un probe y
 * `inspectWorkspaceForResume` recibe un `ResumeIo` falso. Verifican los
 * veredictos del diseño §7.3/§7.6 (hash correcto, drift, archivo ausente,
 * base commit distinto, workspace ausente/ajeno) y que nunca se devuelva
 * contenido de archivos.
 *
 * Uso: npm run agent:test-autonomy-resume
 */
import crypto from "node:crypto";
import {
  evaluateResume,
  inspectWorkspaceForResume,
  resumeAffectedPaths,
  type ResumeIo,
  type ResumeProbe,
} from "./resume";

const sha256 = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

let total = 0;
let failed = 0;

function check(condition: boolean, message: string, detail?: () => unknown): void {
  total += 1;
  if (condition) {
    console.log(`✅ ${message}`);
    return;
  }
  failed += 1;
  console.error(`❌ ${message}`);
  if (detail) console.error("   ", JSON.stringify(detail()));
}

function checkEq(actual: unknown, expected: unknown, message: string, detail?: () => unknown): void {
  check(JSON.stringify(actual) === JSON.stringify(expected), message, () => ({
    esperado: expected,
    actual,
    ...(detail ? { detalle: detail() } : {}),
  }));
}

const WORKTREE = process.platform === "win32" ? "C:\\tmp\\magi-resume\\worktree" : "/tmp/magi-resume/worktree";
const REPO = process.platform === "win32" ? "C:\\tmp\\magi-resume\\repo" : "/tmp/magi-resume/repo";
const CONTENT = "export const feature = true;\n";
const HASH = sha256(CONTENT);
const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);

function probe(overrides: Partial<ResumeProbe> = {}): ResumeProbe {
  return {
    worktreeExists: true,
    worktreeIsDirectory: true,
    worktreeToplevel: WORKTREE,
    repoExists: true,
    repoIsDirectory: true,
    repoToplevel: REPO,
    head: HEAD,
    baseIsAncestor: true,
    files: [{ path: "src/feature.ts", exists: true, isFile: true, sha256: HASH, size: Buffer.byteLength(CONTENT) }],
    ...overrides,
  };
}

function evaluate(overrides: {
  probe?: Partial<ResumeProbe>;
  baseCommit?: string | null;
  checkpointHead?: string | null;
  checkpoints?: Array<{ path: string; sha256: string; size: number }>;
} = {}) {
  return evaluateResume({
    worktreePath: WORKTREE,
    repoRoot: REPO,
    baseCommit: overrides.baseCommit === undefined ? BASE : overrides.baseCommit,
    checkpointHead: overrides.checkpointHead === undefined ? HEAD : overrides.checkpointHead,
    checkpoints: overrides.checkpoints ?? [{ path: "src/feature.ts", sha256: HASH, size: Buffer.byteLength(CONTENT) }],
    probe: probe(overrides.probe),
    now: () => 1_000,
  });
}

async function main(): Promise<void> {
  console.log("== Fase 9E — veredictos de reanudación ==\n");

  console.log("--- Workspace válido ---");
  {
    const verdict = evaluate();
    checkEq(verdict.resumable, true, "un workspace íntegro es reanudable");
    checkEq(verdict.reason, "ok", "el motivo es ok");
    checkEq(verdict.warnings, [], "no hay warnings");
    checkEq(verdict.files, [
      { path: "src/feature.ts", status: "ok", expectedSha256: HASH, actualSha256: HASH },
    ], "el archivo coincide con el checkpoint");
    checkEq(verdict.verifiedAt, 1_000, "verifiedAt usa el reloj inyectado");
    check(!JSON.stringify(verdict).includes(CONTENT), "el veredicto no incluye contenido del archivo");
  }

  console.log("\n--- Drift de hash/tamaño ---");
  {
    const other = "export const feature = false;\n";
    const verdict = evaluate({
      probe: {
        files: [{ path: "src/feature.ts", exists: true, isFile: true, sha256: sha256(other), size: Buffer.byteLength(other) }],
      },
    });
    checkEq(verdict.resumable, true, "el drift no impide reanudar (se inspecciona/replanifica)");
    checkEq(verdict.files[0]?.status, "drift", "el archivo queda marcado drift");
    checkEq(verdict.warnings.length, 1, "hay un warning");
    checkEq(verdict.warnings[0]?.code, "workspace_drift", "el warning es workspace_drift");
    check(verdict.warnings[0]?.path === "src/feature.ts", "el warning nombra la ruta relativa");
    check(!JSON.stringify(verdict).includes(other), "el warning no filtra el contenido actual");
  }

  console.log("\n--- Archivo ausente ---");
  {
    const verdict = evaluate({
      probe: { files: [{ path: "src/feature.ts", exists: false, isFile: false, sha256: null, size: null }] },
    });
    checkEq(verdict.resumable, true, "un archivo ausente no impide reanudar");
    checkEq(verdict.files[0]?.status, "missing", "el archivo queda missing");
    checkEq(verdict.warnings[0]?.code, "file_missing", "el warning es file_missing");
    const affected = resumeAffectedPaths(verdict);
    checkEq(affected.missing, ["src/feature.ts"], "resumeAffectedPaths lista el archivo ausente");
    checkEq(affected.drifted, [], "no hay drift");
  }

  console.log("\n--- Base commit / workspace ---");
  {
    const verdict = evaluate({ probe: { baseIsAncestor: false } });
    checkEq(verdict.resumable, false, "base commit no ancestro ⇒ no reanudable");
    checkEq(verdict.reason, "base_commit_mismatch", "el motivo es base_commit_mismatch");

    const missing = evaluate({ probe: { worktreeExists: false, worktreeIsDirectory: false, worktreeToplevel: null } });
    checkEq(missing.resumable, false, "workspace inexistente ⇒ no reanudable");
    checkEq(missing.reason, "workspace_missing", "el motivo es workspace_missing");

    const wrongTop = evaluate({ probe: { worktreeToplevel: `${WORKTREE}-otro` } });
    checkEq(wrongTop.resumable, false, "worktree con otro toplevel ⇒ no reanudable");
    checkEq(wrongTop.reason, "workspace_mismatch", "el motivo es workspace_mismatch");

    const wrongRepo = evaluate({ probe: { repoToplevel: `${REPO}-otro` } });
    checkEq(wrongRepo.resumable, false, "repo base distinto ⇒ no reanudable");
    checkEq(wrongRepo.reason, "workspace_mismatch", "el repo ajeno usa workspace_mismatch");

    const noHead = evaluate({ probe: { head: null } });
    checkEq(noHead.resumable, false, "sin HEAD ⇒ no reanudable");
  }

  console.log("\n--- HEAD distinto (cambio externo) ---");
  {
    const verdict = evaluate({ checkpointHead: "c".repeat(40) });
    checkEq(verdict.resumable, true, "un HEAD distinto no bloquea: se avisa para inspeccionar");
    checkEq(verdict.warnings[0]?.code, "head_commit_mismatch", "el warning es head_commit_mismatch");
    check(verdict.warnings[0]?.message.includes("cccccccccccc"), "el warning incluye el hash corto del checkpoint");
  }

  console.log("\n--- Inspect con IO falso ---");
  {
    const files = new Map<string, string>([
      ["src/feature.ts", CONTENT],
    ]);
    const calls: Array<{ cwd: string; args: string[] }> = [];
    const normalized = (target: string) => target.replace(/\\/g, "/");
    const io: Partial<ResumeIo> = {
      async stat(target) {
        if (target === WORKTREE || target === REPO) return { isDirectory: true, isFile: false, size: 0 };
        if (normalized(target).endsWith("src/feature.ts") && files.has("src/feature.ts")) {
          return { isDirectory: false, isFile: true, size: Buffer.byteLength(files.get("src/feature.ts")!) };
        }
        return null;
      },
      async readFile(target) {
        if (normalized(target).endsWith("src/feature.ts")) return Buffer.from(files.get("src/feature.ts")!);
        throw new Error("no existe");
      },
      async git(cwd, args) {
        calls.push({ cwd, args });
        if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
          return { ok: true, stdout: cwd === WORKTREE ? WORKTREE : REPO, code: 0 };
        }
        if (args[0] === "rev-parse" && args[1] === "HEAD") return { ok: true, stdout: HEAD, code: 0 };
        if (args[0] === "merge-base") return { ok: true, stdout: "", code: 0 };
        return { ok: false, stdout: "", code: null };
      },
      now: () => 2_000,
    };

    const verdict = await inspectWorkspaceForResume({
      worktreePath: WORKTREE,
      repoRoot: REPO,
      baseCommit: BASE,
      checkpointHead: HEAD,
      checkpoints: [{ path: "src/feature.ts", sha256: HASH, size: Buffer.byteLength(CONTENT) }],
      io,
    });
    checkEq(verdict.resumable, true, "inspect con IO falso: reanudable");
    checkEq(verdict.files[0]?.status, "ok", "inspect con IO falso: hash correcto");
    checkEq(verdict.verifiedAt, 2_000, "inspect usa el reloj inyectado");
    check(calls.some((call) => call.cwd === WORKTREE && call.args.join(" ") === "rev-parse --show-toplevel"), "verifica el toplevel del worktree");
    check(calls.some((call) => call.cwd === REPO && call.args.join(" ") === "rev-parse --show-toplevel"), "verifica el toplevel del repo");
    check(calls.some((call) => call.args.join(" ") === `merge-base --is-ancestor ${BASE} ${HEAD}`), "verifica que base sea ancestro de HEAD");

    files.set("src/feature.ts", "otro contenido\n");
    const drift = await inspectWorkspaceForResume({
      worktreePath: WORKTREE,
      repoRoot: REPO,
      baseCommit: BASE,
      checkpointHead: HEAD,
      checkpoints: [{ path: "src/feature.ts", sha256: HASH, size: Buffer.byteLength(CONTENT) }],
      io,
    });
    checkEq(drift.files[0]?.status, "drift", "inspect detecta el hash cambiado");
    check(!JSON.stringify(drift).includes("otro contenido"), "inspect no filtra el contenido cambiado");
  }

  console.log("\n--- Path traversal en checkpoint ---");
  {
    const verdict = await inspectWorkspaceForResume({
      worktreePath: WORKTREE,
      repoRoot: REPO,
      baseCommit: BASE,
      checkpointHead: HEAD,
      checkpoints: [{ path: "../fuera.ts", sha256: HASH, size: 1 }],
      io: {
        async stat(target) {
          if (target === WORKTREE || target === REPO) return { isDirectory: true, isFile: false, size: 0 };
          return null;
        },
        async readFile() {
          throw new Error("no debería leer");
        },
        async git(cwd, args) {
          if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
            return { ok: true, stdout: cwd === WORKTREE ? WORKTREE : REPO, code: 0 };
          }
          if (args[0] === "rev-parse" && args[1] === "HEAD") return { ok: true, stdout: HEAD, code: 0 };
          if (args[0] === "merge-base") return { ok: true, stdout: "", code: 0 };
          return { ok: false, stdout: "", code: null };
        },
      },
    });
    checkEq(verdict.files[0]?.status, "missing", "un checkpoint fuera del workspace se trata como ausente");
  }

  console.log("\n--- Resultado ---");
  checkEq(total - failed, total, `${total - failed}/${total} aserciones OK`);

  if (failed > 0) {
    console.error(`\n${failed} aserción(es) fallaron.`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("Error inesperado en el test de resume:", error);
  process.exitCode = 1;
});
