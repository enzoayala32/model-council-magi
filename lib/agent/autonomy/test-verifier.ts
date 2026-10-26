/**
 * Fase 9C — tests del verificador real de acceptance.
 *
 * Cubre los 5 tipos de criterio, la allowlist de scripts, la resolución
 * segura de paths (traversal, absolutos, sensibles), el manejo de
 * exit codes/timeouts/cancelación y la garantía de que stdout/stderr
 * NUNCA salen del verificador (solo hashes y metadatos).
 *
 * No corre `tsc` ni `npm run` de verdad: inyecta `VerifierExec` y verifica
 * los argumentos exactos que recibiría el proceso real.
 *
 * Uso: npm run agent:test-autonomy-verifier
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ExecWithTreeKillError } from "../exec-with-tree-kill";

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

const sha256 = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

async function main(): Promise<void> {
  console.log("== Fase 9C — verificador de acceptance ==\n");

  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "magi-autonomy-verifier-"));
  const workspace = path.join(temp, "workspace");
  await fs.mkdir(path.join(workspace, "src"), { recursive: true });
  const content = "export const feature = 9;\n";
  await fs.writeFile(path.join(workspace, "src", "a.ts"), content, "utf8");
  await fs.writeFile(path.join(workspace, ".env"), "SECRET=no-debe-salir\n", "utf8");
  await fs.writeFile(path.join(temp, "outside.txt"), "afuera\n", "utf8");
  const fileHash = sha256(content);

  try {
    const { createAcceptanceVerifier, VERIFIER_LIMITS } = await import("./verifier");

    type ExecCall = { command: string; args: string[]; cwd: string; timeoutMs: number; signal?: AbortSignal };
    const execCalls: ExecCall[] = [];
    const okExec = async (command: string, args: string[], options: { cwd: string; timeoutMs: number; signal?: AbortSignal }) => {
      execCalls.push({ command, args, cwd: options.cwd, timeoutMs: options.timeoutMs, signal: options.signal });
      return { stdout: "SALIDA_SECRETA_OK", stderr: "STDERR_SECRETO_OK" };
    };

    const verifier = createAcceptanceVerifier({ allowedScripts: ["test", "build"], exec: okExec });
    const run = (criterion: Parameters<typeof verifier>[0]["criterion"], signal?: AbortSignal) =>
      verifier({ criterion, workspaceRoot: workspace, allowedScripts: ["test", "build"], signal });

    console.log("--- Criterios de archivo ---");
    const manual = await run({ kind: "manual", description: "revisar a mano" });
    checkEq(manual.status, "unavailable", "manual → unavailable");
    checkEq(manual.evidence?.reason, "manual", "manual conserva el motivo");

    const exists = await run({ kind: "file_exists", path: "src/a.ts" });
    checkEq(exists.status, "passed", "file_exists de un archivo real → passed");
    checkEq(exists.evidence?.size, Buffer.byteLength(content), "file_exists reporta el tamaño");

    const missing = await run({ kind: "file_exists", path: "src/no-existe.ts" });
    checkEq(missing.status, "failed", "file_exists inexistente → failed");
    checkEq(missing.evidence?.reason, "not_found", "file_exists inexistente reporta not_found");

    const notFile = await run({ kind: "file_exists", path: "src" });
    checkEq(notFile.status, "failed", "file_exists de un directorio → failed");
    checkEq(notFile.evidence?.reason, "not_a_file", "directorio reporta not_a_file");

    const hashOk = await run({ kind: "file_hash", path: "src/a.ts", sha256: fileHash });
    checkEq(hashOk.status, "passed", "file_hash correcto → passed");
    checkEq(hashOk.evidence?.sha256, fileHash, "file_hash reporta el hash real");
    checkEq(hashOk.evidence?.size, Buffer.byteLength(content), "file_hash reporta el tamaño");

    const wrongHash = "0".repeat(64);
    const hashBad = await run({ kind: "file_hash", path: "src/a.ts", sha256: wrongHash });
    checkEq(hashBad.status, "failed", "file_hash incorrecto → failed");
    checkEq(hashBad.evidence?.reason, "hash_mismatch", "hash incorrecto reporta hash_mismatch");
    checkEq(hashBad.evidence?.sha256, fileHash, "hash incorrecto reporta el hash actual, no el esperado");

    console.log("\n--- Seguridad de paths ---");
    const traversal = await run({ kind: "file_exists", path: "../outside.txt" });
    checkEq(traversal.status, "failed", "path con .. → failed");
    checkEq(traversal.evidence?.reason, "unsafe_path", "traversal reporta unsafe_path");

    const absolute = await run({ kind: "file_exists", path: path.join(temp, "outside.txt") });
    checkEq(absolute.status, "failed", "path absoluto → failed");
    checkEq(absolute.evidence?.reason, "unsafe_path", "absoluto reporta unsafe_path");

    const sensitive = await run({ kind: "file_exists", path: ".env" });
    checkEq(sensitive.status, "failed", "path sensible (.env) → failed");
    checkEq(sensitive.evidence?.reason, "sensitive_path", ".env reporta sensitive_path");

    console.log("\n--- Scripts allowlisted ---");
    execCalls.length = 0;
    const scriptOk = await run({ kind: "script", name: "test" });
    checkEq(scriptOk.status, "passed", "script permitido → passed");
    checkEq(execCalls.length, 1, "el script permitido ejecuta exactamente un proceso");
    checkEq(execCalls[0]?.command, "npm", "script se ejecuta con npm");
    checkEq(execCalls[0]?.args, ["run", "test"], "script se ejecuta como npm run test");
    checkEq(execCalls[0]?.cwd, workspace, "el script corre en el workspace");
    checkEq(execCalls[0]?.timeoutMs, VERIFIER_LIMITS.timeoutMs, "el script usa el timeout del verificador");
    checkEq(scriptOk.evidence?.exitCode, 0, "script OK reporta exitCode 0");
    checkEq(typeof scriptOk.evidence?.outputSha256, "string", "script OK reporta hash de salida");
    checkEq((scriptOk.evidence?.outputSha256 as string).length, 64, "el hash de salida es SHA-256");
    check(!JSON.stringify(scriptOk).includes("SALIDA_SECRETA_OK"), "la salida stdout NO sale en el resultado");
    check(!JSON.stringify(scriptOk).includes("STDERR_SECRETO_OK"), "la salida stderr NO sale en el resultado");

    execCalls.length = 0;
    const scriptNotAllowed = await run({ kind: "script", name: "lint" });
    checkEq(scriptNotAllowed.status, "unavailable", "script no allowlisted → unavailable");
    checkEq(scriptNotAllowed.evidence?.reason, "script_not_allowed", "script no allowlisted reporta el motivo");
    checkEq(execCalls.length, 0, "un script no allowlisted NUNCA se ejecuta");

    console.log("\n--- Fallos de comando ---");
    const failingExec = async () => {
      throw new ExecWithTreeKillError("exit 2", {
        stdout: "SALIDA_SECRETA_FALLO",
        stderr: "STDERR_SECRETO_FALLO",
        killed: false,
        signal: null,
        code: 2,
      });
    };
    const failingVerifier = createAcceptanceVerifier({ allowedScripts: ["test"], exec: failingExec });
    const scriptFailed = await failingVerifier({
      criterion: { kind: "script", name: "test" },
      workspaceRoot: workspace,
      allowedScripts: ["test"],
    });
    checkEq(scriptFailed.status, "failed", "script con exit != 0 → failed");
    checkEq(scriptFailed.evidence?.exitCode, 2, "script fallido conserva el exit code real");
    checkEq(typeof scriptFailed.evidence?.outputSha256, "string", "script fallido reporta hash de salida");
    check(!JSON.stringify(scriptFailed).includes("SALIDA_SECRETA_FALLO"), "stdout de un fallo NO se filtra");
    check(!JSON.stringify(scriptFailed).includes("STDERR_SECRETO_FALLO"), "stderr de un fallo NO se filtra");
    checkEq(scriptFailed.detail, "script:test terminó con exit code 2.", "el detalle no incluye la salida");

    const typecheckCalls: string[][] = [];
    const typecheckVerifier = createAcceptanceVerifier({
      exec: async (command, args) => {
        typecheckCalls.push([command, ...args]);
        throw Object.assign(new Error("tsc falló"), { code: 1 });
      },
    });
    const typecheck = await typecheckVerifier({
      criterion: { kind: "typecheck" },
      workspaceRoot: workspace,
      allowedScripts: [],
    });
    checkEq(typecheck.status, "failed", "typecheck con exit != 0 → failed");
    checkEq(typecheck.evidence?.exitCode, 1, "typecheck conserva el exit code");
    checkEq(typecheckCalls[0], ["npx", "tsc", "--noEmit"], "typecheck ejecuta npx tsc --noEmit");

    console.log("\n--- Timeout y cancelación ---");
    const timeoutVerifier = createAcceptanceVerifier({
      exec: async () => {
        throw new Error("timed out after 120000ms");
      },
    });
    const timedOut = await timeoutVerifier({
      criterion: { kind: "typecheck" },
      workspaceRoot: workspace,
      allowedScripts: [],
    });
    checkEq(timedOut.status, "unavailable", "timeout → unavailable (no se asume fallo del código)");
    checkEq(timedOut.evidence?.reason, "timeout_or_abort", "timeout reporta timeout_or_abort");

    const controller = new AbortController();
    controller.abort();
    const abortVerifier = createAcceptanceVerifier({
      allowedScripts: ["test"],
      exec: async () => {
        throw new Error("aborted");
      },
    });
    const aborted = await abortVerifier({
      criterion: { kind: "script", name: "test" },
      workspaceRoot: workspace,
      allowedScripts: ["test"],
      signal: controller.signal,
    });
    checkEq(aborted.status, "unavailable", "cancelación → unavailable");
    checkEq(aborted.evidence?.reason, "timeout_or_abort", "cancelación reporta timeout_or_abort");

    console.log("\n--- Resultado ---");
    checkEq(total - failed, total, `${total - failed}/${total} aserciones OK`);
  } finally {
    await fs.rm(temp, { recursive: true, force: true }).catch(() => undefined);
  }

  if (failed > 0) {
    console.error(`\n${failed} aserción(es) fallaron.`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("Error inesperado en el test del verificador:", error);
  process.exitCode = 1;
});
