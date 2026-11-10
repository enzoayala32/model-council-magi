/**
 * Etapa 2.2 (sub-bloque 4) — el governor del historial, PRENDIDO por defecto.
 *
 * Hasta acá el governor existía pero nadie lo prendía: `runAgentLoop` lo
 * tomaba de `options.historyGovernor`, y el runner de producción
 * (`lib/agent/runner.ts`) no lo pasaba, así que en una task real quedaba
 * apagado siempre. Con la tabla de ventanas del roster completa (2.2.1) y el
 * gate de ventana conocida (2.2.2), se prende.
 *
 * Este test fija TRES cosas, con `loopRunner` inyectado (no corre ningún
 * modelo ni toca la red):
 *
 *   1. `runTask` le pasa `historyGovernor: { enabled: true }` al loop.
 *   2. `MAGI_HISTORY_GOVERNOR_DISABLED=1` lo apaga sin recompilar — para poder
 *      medir el antes y el después en la misma máquina, y como salida de
 *      emergencia si la compactación empeorara algún modelo.
 *   3. El valor del entorno se lee por llamada, no una sola vez al importar.
 *
 * Uso: npm run agent:test-governor-default
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createProject } from "./project-store";
import { createTask } from "./task-store";
import { runTask } from "./runner";
import type { AgentLoopResult, RunAgentLoopOptions } from "./loop";

const execFileAsync = promisify(execFile);

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passed += 1;
    console.log("+ " + label);
    return;
  }
  failed += 1;
  console.log("x " + label + (detail === undefined ? "" : " - " + JSON.stringify(detail).slice(0, 300)));
}

async function makeGitProject(name: string): Promise<{ id: string; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `governor-default-${name}-`));
  await fs.writeFile(path.join(dir, "a.ts"), "export const a = 1;\n", "utf-8");
  await execFileAsync("git", ["init"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
  await execFileAsync("git", ["add", "-A"], { cwd: dir });
  await execFileAsync("git", ["commit", "-m", "inicial"], { cwd: dir });
  const project = await createProject({ name, localPath: dir });
  return { id: project.id, dir };
}

const fakeResult: AgentLoopResult = {
  stopReason: "completed",
  steps: 1,
  transcript: ["(simulado)"],
  proposals: [],
  touchedFiles: [],
};

/** Corre una task real y devuelve las opciones que `runTask` le pasó al loop. */
async function opcionesDelLoop(modelId: string): Promise<RunAgentLoopOptions> {
  const project = await makeGitProject("proyecto");
  const task = createTask({ projectId: project.id, modelId, prompt: "revisá a.ts" });
  let vistas: RunAgentLoopOptions | null = null;
  await runTask(task.id, {
    loopRunner: async (opciones) => {
      vistas = opciones;
      return fakeResult;
    },
  });
  return vistas as unknown as RunAgentLoopOptions;
}

async function main(): Promise<void> {
  if (!process.env.MAGI_DATA_DIR) {
    process.env.MAGI_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "governor-default-db-"));
  }
  // Un modelo del roster real: con ventana CONOCIDA (262.144, tabla con fuente).
  // El gate de 2.2.2 deja el governor apagado con ventana desconocida, así que
  // con un modelo inventado este test no mediría nada.
  const MODEL_ID = "nvidia/nemotron-3.5-lightning-30b-a3b";

  console.log("== el runner de producción prende el governor ==\n");

  const porDefecto = await opcionesDelLoop(MODEL_ID);
  check("runTask pasa historyGovernor.enabled = true", porDefecto.historyGovernor?.enabled === true, porDefecto.historyGovernor);
  check("y sigue pasando el context engine como antes", porDefecto.contextEngine?.enabled === true, porDefecto.contextEngine);

  console.log("\n== MAGI_HISTORY_GOVERNOR_DISABLED lo apaga sin recompilar ==\n");

  process.env.MAGI_HISTORY_GOVERNOR_DISABLED = "1";
  const apagado = await opcionesDelLoop(MODEL_ID);
  check("con la variable en 1, no pasa historyGovernor", apagado.historyGovernor === undefined, apagado.historyGovernor);
  check("y el context engine sigue prendido (es otra variable)", apagado.contextEngine?.enabled === true, apagado.contextEngine);

  process.env.MAGI_HISTORY_GOVERNOR_DISABLED = "true";
  const apagadoTrue = await opcionesDelLoop(MODEL_ID);
  check("el valor true también apaga", apagadoTrue.historyGovernor === undefined, apagadoTrue.historyGovernor);

  process.env.MAGI_HISTORY_GOVERNOR_DISABLED = "0";
  const encendidoOtraVez = await opcionesDelLoop(MODEL_ID);
  check("con un valor que no es de apagado, vuelve a prender", encendidoOtraVez.historyGovernor?.enabled === true, encendidoOtraVez.historyGovernor);

  delete process.env.MAGI_HISTORY_GOVERNOR_DISABLED;
  const sinVariable = await opcionesDelLoop(MODEL_ID);
  check("sin la variable, prendido por defecto", sinVariable.historyGovernor?.enabled === true, sinVariable.historyGovernor);

  console.log("");
  console.log(passed + "/" + (passed + failed) + " casos OK");
  if (failed > 0) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
