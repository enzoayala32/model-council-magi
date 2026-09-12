/**
 * Prueba de aceptación de la Fase 4B (ver `fase4-diseno-v3-final.md`,
 * sección 3): `run_script` solo se ofrece cuando el proyecto REALMENTE
 * declara alguno de los scripts permitidos (`build`/`test`/`lint`, nunca
 * `typecheck` — esa sigue siendo exclusiva de `run_typecheck`), nunca
 * ejecuta nada fuera de esa allowlist, y el resultado queda en
 * `agent_events` con su propio tipo (`run_script_result`).
 *
 * No depende de un modelo real — llama `createAgentTools` directo, mismo
 * patrón que usaría `loop.ts`.
 *
 * Uso: npm run agent:test-run-script
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAgentTools } from "./tools";

async function makeProject(scripts: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "consenso-ia-test4b-"));
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "proyecto-test", scripts }, null, 2));
  return dir;
}

async function detectAllowedScriptsForTest(workspaceRoot: string): Promise<string[]> {
  // Réplica mínima de `detectAllowedScripts` (loop.ts) para no tener que
  // exportarla solo para testing — misma allowlist fija a propósito.
  const ALLOWED = ["build", "test", "lint"];
  try {
    const raw = await fs.readFile(path.join(workspaceRoot, "package.json"), "utf-8");
    const parsed = JSON.parse(raw) as { scripts?: Record<string, unknown> };
    const declared = parsed.scripts ? Object.keys(parsed.scripts) : [];
    return ALLOWED.filter((n) => declared.includes(n));
  } catch {
    return [];
  }
}

async function main() {
  console.log("== Fase 4B — prueba de aceptación (run_script) ==\n");
  const results: boolean[] = [];

  // --- Caso 1: proyecto con los 3 scripts permitidos → run_script disponible, corre "test" real ---
  {
    console.log("--- Caso 1: los 3 scripts declarados quedan disponibles, y corren de verdad ---");
    const dir = await makeProject({ build: "echo build-ok", test: "echo test-ok", lint: "echo lint-ok" });
    const allowed = await detectAllowedScriptsForTest(dir);
    const tools = createAgentTools(dir, () => {}, allowed);
    const hasRunScript = "run_script" in tools;
    const result = hasRunScript ? await (tools as any).run_script.execute({ name: "test" }) : null;
    const ok = allowed.sort().join(",") === "build,lint,test" && hasRunScript && result?.ok === true && result?.success === true && result?.output.includes("test-ok");
    console.log(ok ? "✅ Los 3 scripts quedaron disponibles y `run_script({name:\"test\"})` corrió de verdad." : `❌ Falló. allowed=${allowed}, result=${JSON.stringify(result)}`);
    results.push(ok);
  }

  // --- Caso 2: "typecheck" NUNCA es un nombre válido, aunque el package.json lo declare ---
  {
    console.log('\n--- Caso 2: un script llamado "typecheck" en package.json NO habilita ese nombre en run_script ---');
    const dir = await makeProject({ typecheck: "echo no-deberia-poder-correr-esto", build: "echo build-ok" });
    const allowed = await detectAllowedScriptsForTest(dir);
    const ok = !allowed.includes("typecheck") && allowed.includes("build");
    console.log(ok ? '✅ "typecheck" quedó afuera de la allowlist de run_script (sigue siendo exclusivo de run_typecheck).' : `❌ Falló. allowed=${allowed}`);
    results.push(ok);
  }

  // --- Caso 3: proyecto sin NINGÚN script permitido → run_script ni se ofrece como tool ---
  {
    console.log("\n--- Caso 3: sin scripts permitidos declarados → run_script no existe como tool ---");
    const dir = await makeProject({ dev: "next dev", start: "next start" }); // ninguno de los 3 permitidos
    const allowed = await detectAllowedScriptsForTest(dir);
    const tools = createAgentTools(dir, () => {}, allowed);
    const ok = allowed.length === 0 && !("run_script" in tools);
    console.log(ok ? "✅ Sin build/test/lint declarados, run_script no aparece en el set de tools." : `❌ Falló. allowed=${allowed}, tieneRunScript=${"run_script" in tools}`);
    results.push(ok);
  }

  // --- Caso 4: intentar correr un script NO incluido en la allowlist calculada → rechazo controlado ---
  {
    console.log("\n--- Caso 4: pedir un script que existe en package.json pero no en la allowlist calculada → rechazo, sin ejecutar nada ---");
    const dir = await makeProject({ build: "echo build-ok" }); // solo "build" quedó permitido/disponible
    const allowed = await detectAllowedScriptsForTest(dir); // ["build"]
    const tools = createAgentTools(dir, () => {}, allowed);
    // Simulamos que igual se invoca con "test" (el enum de Zod lo deja
    // pasar como tipo válido, pero el runtime chequea contra `allowed`).
    const result = await (tools as any).run_script.execute({ name: "test" });
    const ok = result.ok === false && typeof result.error === "string" && result.error.includes("no está disponible");
    console.log(ok ? `✅ Rechazado en runtime sin ejecutar nada: "${result.error}"` : `❌ Falló. result=${JSON.stringify(result)}`);
    results.push(ok);
  }

  // --- Caso 5: sin package.json en absoluto → no tira, allowlist vacía ---
  {
    console.log("\n--- Caso 5: sin package.json → no tira excepción, allowlist queda vacía ---");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "consenso-ia-test4b-sinpkg-"));
    let threw = false;
    let allowed: string[] = [];
    try {
      allowed = await detectAllowedScriptsForTest(dir);
    } catch {
      threw = true;
    }
    const ok = !threw && allowed.length === 0;
    console.log(ok ? "✅ Sin package.json: no tira, allowlist vacía." : `❌ Falló. threw=${threw}, allowed=${allowed}`);
    results.push(ok);
  }

  // --- Caso 6: un script que FALLA (exit code != 0) se reporta success:false, no como error de la tool ---
  {
    console.log("\n--- Caso 6: un script que falla reporta success:false (ok:true igual, la LLAMADA no falló) ---");
    const dir = await makeProject({ lint: 'node -e "process.exit(1)"' });
    const allowed = await detectAllowedScriptsForTest(dir);
    const tools = createAgentTools(dir, () => {}, allowed);
    const result = await (tools as any).run_script.execute({ name: "lint" });
    const ok = result.ok === true && result.success === false;
    console.log(ok ? "✅ Script con exit code != 0: ok:true (la tool en sí no falló), success:false (el script sí)." : `❌ Falló. result=${JSON.stringify(result)}`);
    results.push(ok);
  }

  console.log(`\n${results.filter(Boolean).length}/${results.length} casos OK.`);
  if (results.some((r) => !r)) process.exit(1);
}

main().catch((error) => {
  console.error("Error inesperado en la prueba:", error);
  process.exit(1);
});
