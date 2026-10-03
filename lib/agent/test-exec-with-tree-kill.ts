/**
 * Fase 6D — prueba de aceptación de `execWithTreeKill` (`exec-with-tree-kill.ts`)
 * en aislamiento, sin pasar por `tools.ts`/`wrapToolExecute`. Los casos de
 * "abort real de run_typecheck/run_script de punta a punta" ya quedan
 * cubiertos en `test-tool-policy.ts` (Casos 9-11) — acá se prueban los
 * casos límite del helper en sí, con control total sobre el comando y el
 * `timeoutMs` (nunca 120s reales).
 *
 * Determinismo: cada caso que involucra un proceso real usa un "marker"
 * que un proceso hijo real solo escribe después de un tiempo FIJO y
 * conocido — se aborta/limita bien antes de ese tiempo y se verifica bien
 * después. No hay ninguna carrera "a ver si alcanza": el margen es
 * generoso a propósito en ambos sentidos.
 *
 * Uso: npm run agent:test-exec-with-tree-kill
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { execWithTreeKill, ExecWithTreeKillError } from "./exec-with-tree-kill";

const execFileAsync = promisify(execFile);

let results: boolean[] = [];

function check(label: string, ok: boolean, detail?: unknown): void {
  results.push(ok);
  console.log(`${ok ? "✅" : "❌"} ${label}${ok ? "" : ` — ${JSON.stringify(detail)}`}`);
}

async function tempWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "test-exec-tree-kill-"));
}

/** Un script node que, si sobrevive `delayMs`, escribe `marker.txt`. Se usa
 * en vez de un `sleep`/`touch` de shell para no depender de qué binarios
 * estén instalados. */
async function makeDelayedMarkerScript(dir: string, delayMs: number): Promise<{ scriptPath: string; markerPath: string }> {
  const markerPath = path.join(dir, "marker.txt");
  const scriptPath = path.join(dir, "slow.js");
  await fs.writeFile(scriptPath, `setTimeout(() => { require("fs").writeFileSync(${JSON.stringify(markerPath)}, "done"); }, ${delayMs});`, "utf-8");
  return { scriptPath, markerPath };
}

async function markerExists(markerPath: string): Promise<boolean> {
  return fs
    .access(markerPath)
    .then(() => true)
    .catch(() => false);
}

/** Escribe un script .js temporal y devuelve su ruta — evita pasar código
 * JS inline como argumento de `node -e "..."` bajo `shell:true`, que
 * concatena los argumentos sin escapar comillas/paréntesis (mismo
 * comportamiento que ya tenía `execFileAsync` con `shell:true` — no es
 * algo que este helper cambie). `run_typecheck`/`run_script` nunca pisan
 * este problema porque sus argumentos reales siempre son palabras sueltas
 * (`tsc`, `--noEmit`, `run`, `<nombre-de-script>`), nunca código inline. */
async function makeScript(dir: string, code: string): Promise<string> {
  const scriptPath = path.join(dir, `script-${Math.random().toString(36).slice(2, 8)}.js`);
  await fs.writeFile(scriptPath, code, "utf-8");
  return scriptPath;
}

/** Best-effort: cuenta cuántos procesos "node .../slow.js" siguen vivos.
 * Si `ps` no está disponible en el entorno de test, no rompe la prueba —
 * el marker sigue siendo la prueba principal y determinista. */
async function countLiveSlowJsProcesses(): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("sh", ["-c", "ps -eo cmd | grep '[s]low.js' | wc -l"]);
    return Number(stdout.trim());
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  console.log("== Fase 6D — prueba de aceptación (execWithTreeKill) ==\n");

  // --- Caso 1: proceso termina normalmente ---
  console.log("--- Caso 1: ejecución normal, exit code 0 ---");
  {
    const dir = await tempWorkspace();
    const script = await makeScript(dir, `console.log("hola");`);
    const result = await execWithTreeKill("node", [script], { cwd: dir, maxBuffer: 1024 * 1024, timeoutMs: 5000 });
    check("resuelve con el stdout real", result.stdout.includes("hola"), result);
  }

  // --- Caso 7: stdout Y stderr ---
  console.log("\n--- Caso 7: captura stdout y stderr por separado ---");
  {
    const dir = await tempWorkspace();
    const script = await makeScript(dir, `console.log("por-stdout"); console.error("por-stderr");`);
    const result = await execWithTreeKill("node", [script], { cwd: dir, maxBuffer: 1024 * 1024, timeoutMs: 5000 });
    check("stdout tiene lo suyo", result.stdout.includes("por-stdout"), result);
    check("stderr tiene lo suyo, sin mezclarse con stdout", result.stderr.includes("por-stderr") && !result.stdout.includes("por-stderr"), result);
  }

  // --- Exit code distinto de 0 ---
  console.log("\n--- Extra: exit code != 0 rechaza con stdout/stderr utilizables por errorOutput() ---");
  {
    const dir = await tempWorkspace();
    const script = await makeScript(dir, `console.error("fallo real"); process.exit(3);`);
    const error = await execWithTreeKill("node", [script], { cwd: dir, maxBuffer: 1024 * 1024, timeoutMs: 5000 }).catch((e) => e as ExecWithTreeKillError);
    check("rechaza con un ExecWithTreeKillError con stderr capturado", error instanceof ExecWithTreeKillError && error.stderr.includes("fallo real"), error);
    check("code refleja el exit code real (3)", error instanceof ExecWithTreeKillError && error.code === 3, error);
  }

  // --- Caso 2: abort ANTES de que el proceso termine — mata el árbol real ---
  console.log("\n--- Caso 2: abort mientras el proceso está en curso — el árbol muere de verdad ---");
  {
    const dir = await tempWorkspace();
    const { scriptPath, markerPath } = await makeDelayedMarkerScript(dir, 2000);
    const controller = new AbortController();
    const promise = execWithTreeKill("node", [scriptPath], { cwd: dir, maxBuffer: 1024 * 1024, timeoutMs: 10_000, signal: controller.signal });
    await new Promise((r) => setTimeout(r, 200));
    const liveBeforeAbort = await countLiveSlowJsProcesses();
    controller.abort();
    const error = await promise.catch((e) => e as ExecWithTreeKillError);
    check("rechaza (no resuelve como éxito)", error instanceof ExecWithTreeKillError, error);
    await new Promise((r) => setTimeout(r, 2300));
    check("el marker (solo a los 2s) nunca apareció", !(await markerExists(markerPath)), { markerPath });
    if (liveBeforeAbort !== null) {
      const liveAfter = await countLiveSlowJsProcesses();
      check(`no quedó ningún proceso descendiente vivo (había ${liveBeforeAbort} antes del abort, quedan ${liveAfter})`, liveAfter === 0, { liveBeforeAbort, liveAfter });
    }
  }

  // --- Caso 3: timeout ANTES de que el proceso termine — mismo mecanismo, timeoutMs chico ---
  console.log("\n--- Caso 3: timeout (sin abort) — mismo camino de terminación, sin esperar 120s reales ---");
  {
    const dir = await tempWorkspace();
    const { scriptPath, markerPath } = await makeDelayedMarkerScript(dir, 2000);
    const error = await execWithTreeKill("node", [scriptPath], { cwd: dir, maxBuffer: 1024 * 1024, timeoutMs: 150 }).catch((e) => e as ExecWithTreeKillError);
    check("rechaza mencionando el timeout", error instanceof ExecWithTreeKillError && error.message.includes("timeout"), error);
    await new Promise((r) => setTimeout(r, 2300));
    check("el marker (solo a los 2s) nunca apareció — el timeout mató el árbol real, no solo dejó de esperar", !(await markerExists(markerPath)), { markerPath });
  }

  // --- Caso 4/5: abort DESPUÉS de que el proceso ya terminó — no rompe nada, no mata un PID ajeno ---
  console.log("\n--- Caso 4/5: abort/terminación después de que el proceso YA terminó — no-op seguro ---");
  {
    const dir = await tempWorkspace();
    const script = await makeScript(dir, `console.log("listo");`);
    const controller = new AbortController();
    const result = await execWithTreeKill("node", [script], { cwd: dir, maxBuffer: 1024 * 1024, timeoutMs: 5000, signal: controller.signal });
    check("resuelve normalmente (el proceso ya había terminado)", result.stdout.includes("listo"), result);
    // Abortar DESPUÉS de que la promesa ya resolvió — no debe tirar, no
    // debe tener ningún efecto (el helper ya limpió sus listeners).
    let threw = false;
    try {
      controller.abort();
    } catch {
      threw = true;
    }
    check("abortar un signal ya terminado no tira ninguna excepción", !threw);
  }

  // --- Caso 6: abort y timeout prácticamente simultáneos — una sola terminación, sin doble-reject ---
  console.log("\n--- Caso 6: abort y timeout casi al mismo tiempo — terminación única e idempotente ---");
  {
    const dir = await tempWorkspace();
    const { scriptPath, markerPath } = await makeDelayedMarkerScript(dir, 2000);
    const controller = new AbortController();
    const promise = execWithTreeKill("node", [scriptPath], { cwd: dir, maxBuffer: 1024 * 1024, timeoutMs: 150, signal: controller.signal });
    // Dispara el abort prácticamente en el mismo instante en que el
    // timeout de 150ms también va a disparar — ninguno de los dos debe
    // producir un segundo reject ni una excepción no manejada.
    setTimeout(() => controller.abort(), 150);
    let rejectedOnce = false;
    let unhandledExtra = false;
    promise.catch(() => {
      if (rejectedOnce) unhandledExtra = true;
      rejectedOnce = true;
    });
    await promise.catch(() => {});
    await new Promise((r) => setTimeout(r, 2300));
    check("rechazó exactamente una vez (sin doble terminación)", rejectedOnce && !unhandledExtra, { rejectedOnce, unhandledExtra });
    check("el marker nunca apareció", !(await markerExists(markerPath)), { markerPath });
  }

  // --- Extra: maxBuffer excedido produce un error utilizable, no un truncamiento silencioso exitoso ---
  console.log("\n--- Extra: maxBuffer excedido ---");
  {
    const dir = await tempWorkspace();
    const script = await makeScript(dir, `for (let i = 0; i < 100000; i++) console.log("x".repeat(100));`);
    const error = await execWithTreeKill("node", [script], { cwd: dir, maxBuffer: 1000, timeoutMs: 5000 }).catch((e) => e as ExecWithTreeKillError);
    check("rechaza (nunca resuelve como si nada) cuando se pasa el límite de salida", error instanceof ExecWithTreeKillError, error);
    check("el mensaje menciona el límite de salida", error instanceof ExecWithTreeKillError && error.message.includes("límite de salida"), error instanceof Error ? error.message : error);
  }

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} casos OK.`);
  if (passed !== results.length) process.exit(1);
}

main().catch((error) => {
  console.error("Error inesperado en la prueba:", error);
  process.exit(1);
});
