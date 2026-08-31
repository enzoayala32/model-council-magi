/**
 * Prueba de aceptación de `GET /api/agent/inspect` (Project Picker): debe
 * detectar correctamente si una carpeta es un repo git, si tiene
 * package.json, si usa TypeScript, y qué scripts conocidos expone.
 *
 * Uso: npm run agent:test-inspect
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GET as inspectRoute } from "../../app/api/agent/inspect/route";

const execFileAsync = promisify(execFile);

async function main() {
  console.log("== Prueba de aceptación: GET /api/agent/inspect ==\n");
  const results: boolean[] = [];

  // --- Caso 1: repo git con package.json, TypeScript y scripts conocidos ---
  {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "consenso-ia-test-inspect-git-"));
    await fs.writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "mi-proyecto", scripts: { build: "tsc", test: "vitest", dev: "next dev", random: "echo hola" }, devDependencies: { typescript: "^5.0.0" } }),
    );
    await fs.writeFile(path.join(dir, "tsconfig.json"), "{}");
    await execFileAsync("git", ["init"], { cwd: dir });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
    await execFileAsync("git", ["add", "-A"], { cwd: dir });
    await execFileAsync("git", ["commit", "-m", "inicial"], { cwd: dir });

    const res = await inspectRoute(new Request(`http://localhost/api/agent/inspect?path=${encodeURIComponent(dir)}`));
    const body = await res.json();
    const ok =
      res.status === 200 &&
      body.ok === true &&
      body.isGitRepo === true &&
      body.workspaceMode === "worktree" &&
      body.hasPackageJson === true &&
      body.packageName === "mi-proyecto" &&
      body.hasTypeScript === true &&
      body.scripts.sort().join(",") === "build,dev,test"; // "random" no es un script conocido, queda afuera
    console.log(ok ? "✅ Repo git + package.json + TypeScript + scripts conocidos detectados correctamente." : `❌ Falló. ${JSON.stringify(body)}`);
    results.push(ok);
  }

  // --- Caso 2: carpeta sin git, sin package.json ---
  {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "consenso-ia-test-inspect-vacia-"));
    const res = await inspectRoute(new Request(`http://localhost/api/agent/inspect?path=${encodeURIComponent(dir)}`));
    const body = await res.json();
    const ok = res.status === 200 && body.isGitRepo === false && body.workspaceMode === "copy" && body.hasPackageJson === false && body.hasTypeScript === false && body.scripts.length === 0;
    console.log(ok ? "✅ Carpeta vacía: sin git → modo copy, sin package.json, sin scripts." : `❌ Falló. ${JSON.stringify(body)}`);
    results.push(ok);
  }

  // --- Caso 3: package.json JavaScript puro (sin TypeScript) ---
  {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "consenso-ia-test-inspect-js-"));
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "proyecto-js", scripts: { start: "node index.js" } }));
    const res = await inspectRoute(new Request(`http://localhost/api/agent/inspect?path=${encodeURIComponent(dir)}`));
    const body = await res.json();
    const ok = body.hasPackageJson === true && body.hasTypeScript === false && body.scripts.join(",") === "start";
    console.log(ok ? "✅ package.json sin TypeScript detectado como JavaScript." : `❌ Falló. ${JSON.stringify(body)}`);
    results.push(ok);
  }

  // --- Caso 4: ruta inexistente / no es carpeta → error controlado ---
  {
    const res = await inspectRoute(new Request(`http://localhost/api/agent/inspect?path=${encodeURIComponent("/no/existe/seguro/12345")}`));
    const body = await res.json();
    const ok = res.status === 400 && body.ok === false;
    console.log(ok ? "✅ Ruta inexistente → 400 con mensaje, no una excepción cruda." : `❌ Falló. status=${res.status}`);
    results.push(ok);
  }

  // --- Caso 5: falta el parámetro path → 400 ---
  {
    const res = await inspectRoute(new Request("http://localhost/api/agent/inspect"));
    const ok = res.status === 400;
    console.log(ok ? "✅ Sin ?path= → 400." : `❌ Falló. status=${res.status}`);
    results.push(ok);
  }

  console.log(`\n${results.filter(Boolean).length}/${results.length} casos OK.`);
  if (results.some((r) => !r)) process.exit(1);
}

main().catch((error) => {
  console.error("Error inesperado en la prueba:", error);
  process.exit(1);
});
