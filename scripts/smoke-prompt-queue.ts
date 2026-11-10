/**
 * Smoke EN VIVO de la cola de prompts (pedido de Enzo, 2026-11-10).
 *
 * A diferencia de `lib/agent/test-prompt-queue.ts` (que usa un `loopRunner`
 * falso y prueba la lógica), este script prueba el CAMINO COMPLETO contra un
 * server real: HTTP → API → dispatcher → runner → modelo real → workspace real.
 *
 * Lo que verifica, que es lo que el usuario va a hacer:
 *
 *   1. Se crea una task con un prompt trivial.
 *   2. MIENTRAS corre, se encola un segundo prompt por HTTP.
 *   3. El primer ciclo termina y da su resumen; el runner toma el prompt de la
 *      cola y se lo pasa al agente —sin que el usuario haga nada—.
 *   4. Los dos ciclos corren sobre el MISMO workspace, y el segundo deja su
 *      efecto en el trabajotree.
 *
 * Uso: npx tsx scripts/smoke-prompt-queue.ts
 * (necesita las keys del proveedor en .env, igual que el agente.)
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();

function log(msg: string): void {
  console.log(msg);
}

/** Puerto libre, igual que hace `lib/test-peer-spoof.ts`. */
function puertoLibre(wanted?: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(wanted ?? 0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function esperarServer(base: string, timeoutMs = 120_000): Promise<boolean> {
  const inicio = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    try {
      const res = await fetch(base + "/api/agent/models");
      if (res.status !== 404 && res.status !== 500) return true;
    } catch {
      // todavía no escucha
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return false;
}

async function main(): Promise<void> {
  // --- Cargar .env, igual que el resto de los scripts fuera de Next.
  for (const nombre of [".env.local", ".env"]) {
    try {
      process.loadEnvFile(nombre);
    } catch {
      /* no existe: seguimos */
    }
  }

  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "smoke-cola-db-"));
  const port = await puertoLibre();
  const base = `http://127.0.0.1:${port}`;
  log(`== Smoke de cola de prompts en ${base} ==\n`);

  const child = spawn(process.execPath, ["--import", "tsx", "scripts/dev-server.ts"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      MAGI_DATA_DIR: dataDir,
      PORT: String(port),
      MAGI_DEV: "1",
      APP_ACCESS_TOKEN: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let salida = "";
  child.stdout?.on("data", (d) => (salida += String(d)));
  child.stderr?.on("data", (d) => (salida += String(d)));

  const matar = async () => {
    if (child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill("SIGKILL");
    });
  };

  try {
    if (!(await esperarServer(base))) {
      log("✗ el server no arrancó. Salida:\n" + salida.slice(-2000));
      process.exit(1);
    }
    log("+ server arriba");

    // --- Proyecto real: un repo git temporal con un archivo.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "smoke-cola-proyecto-"));
    await fs.writeFile(path.join(dir, "a.ts"), "export const a = 1;\n", "utf-8");
    await execFileAsync("git", ["init"], { cwd: dir });
    await execFileAsync("git", ["config", "user.email", "smoke@example.com"], { cwd: dir });
    await execFileAsync("git", ["config", "user.name", "Smoke"], { cwd: dir });
    await execFileAsync("git", ["add", "-A"], { cwd: dir });
    await execFileAsync("git", ["commit", "-m", "inicial"], { cwd: dir });

    const proyecto = (await (await fetch(base + "/api/agent/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "smoke-cola", localPath: dir }),
    })).json()) as { ok: boolean; project: { id: string } };
    if (!proyecto.ok) throw new Error("no se pudo crear el proyecto");
    log("+ proyecto creado");

    const modelos = (await (await fetch(base + "/api/agent/models")).json()) as { models: Array<{ id: string }> };
    // El más rápido del bench en vivo (ver docs/bench/modelos-agente.json).
    const preferido = modelos.models.find((m) => m.id === "nvidia/nemotron-3.5-lightning-30b-a3b") ?? modelos.models[0];
    if (!preferido) throw new Error("no hay modelos habilitados");
    log(`+ modelo: ${preferido.id}`);

    // --- La task con el prompt ORIGINAL.
    const creada = (await (await fetch(base + "/api/agent/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: proyecto.project.id,
        modelId: preferido.id,
        prompt: "Creá el archivo hola.txt con el texto 'hola' y nada más. No toques ningún otro archivo.",
      }),
    })).json()) as { ok: boolean; task: { id: string } };
    if (!creada.ok) throw new Error("no se pudo crear la task");
    const taskId = creada.task.id;
    log(`+ task creada: ${taskId}`);

    // --- Encolar MIENTRAS corre. No hay que esperar nada: la cola existe para
    //     eso, y si la task ya terminó el prompt queda esperando igual (que es
    //     el comportamiento esperado, no un error).
    const encolado = (await (await fetch(base + `/api/agent/tasks/${taskId}/prompts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Ahora agregá al final de hola.txt una línea con el texto 'segunda vuelta'." }),
    })).json()) as { ok: boolean; prompt: { id: string; position: number } };
    if (!encolado.ok) throw new Error("no se pudo encolar el prompt");
    log(`+ prompt encolado (posición ${encolado.prompt.position})`);

    // --- Esperar a que la cola se drene: los dos prompts tienen que pasar a
    //     'done' y la task a un estado terminal.
    const plazo = Date.now() + 8 * 60_000;
    let colaFinal: Array<{ state: string; prompt: string }> = [];
    let estadoFinal = "";
    let eventos: Array<{ type: string }> = [];
    while (Date.now() < plazo) {
      const cola = (await (await fetch(base + `/api/agent/tasks/${taskId}/prompts`)).json()) as {
        prompts: Array<{ state: string; prompt: string }>;
      };
      const task = (await (await fetch(base + `/api/agent/tasks/${taskId}`)).json()) as { task: { status: string } };
      colaFinal = cola.prompts;
      estadoFinal = task.task.status;
      if (cola.prompts.every((p) => p.state === "done") && ["READY_FOR_REVIEW", "NO_CHANGES", "FAILED", "CANCELLED"].includes(estadoFinal)) break;
      await new Promise((r) => setTimeout(r, 3_000));
    }
    // `/events` es SSE, no JSON: se lee como texto y se buscan los bloques.
    // `fetch` corta cuando el body se cierra; acá se pide una sola vez y se
    // cancela en cuanto se tiene la respuesta (no se queda colgado).
    const eventosRes = await fetch(base + `/api/agent/tasks/${taskId}/events`, { headers: { accept: "text/event-stream" } });
    // `text()` consume el body: no hay que (ni se puede) cancelarlo después.
    const textoSse = await eventosRes.text();
    eventos = [...textoSse.matchAll(/"type":"([a-z_]+)"/g)].map((m) => ({ type: m[1] }));

    log("");
    const esperando = colaFinal.filter((p) => p.state === "waiting").length;
    const hechos = colaFinal.filter((p) => p.state === "done").length;
    check("el prompt encolado se EJECUTÓ (state done)", hechos === 1, colaFinal.map((p) => p.state));
    check("no quedó nada esperando", esperando === 0, colaFinal.map((p) => p.state));
    check("la task aterrizó en un estado terminal", ["READY_FOR_REVIEW", "NO_CHANGES", "FAILED", "CANCELLED"].includes(estadoFinal), estadoFinal);

    // El efecto del segundo prompt: 'segunda vuelta' tiene que estar en el
    // worktree (en el diff propuesto o en el archivo).
    const propuestas = (await (await fetch(base + `/api/agent/tasks/${taskId}/proposals`)).json()) as {
      proposals?: Array<{ relPath: string; nextContent: string; diff: string }>;
    };
    const texto = (propuestas.proposals ?? []).map((p) => p.nextContent + "\n" + p.diff).join("\n");
    const hiveEnTexto = texto.includes("hola");
    const segundaVuelta = texto.includes("segunda vuelta");
    check("el primer prompt surtió efecto (hola.txt creado)", hiveEnTexto, texto.slice(0, 200));
    check("el SEGUNDO prompt surtió efecto (línea 'segunda vuelta')", segundaVuelta, texto.slice(0, 400));

    log("");
    log(`estado final de la task: ${estadoFinal}`);
    const arrancos = eventos.filter((e) => e.type === "prompt_started").length;
    log(`eventos: ${eventos.length} (prompt_started: ${arrancos})`);
    check("el evento prompt_started se emitió al tomar el prompt de la cola", arrancos >= 1, eventos.map((e) => e.type));
  } catch (error) {
    log("✗ " + (error instanceof Error ? error.message : String(error)));
    log(salida.slice(-1500));
    process.exitCode = 1;
  } finally {
    await matar();
    // Limpieza: la DB temporal y el server van con el proceso.
    if (fsSync.existsSync(dataDir)) void fs.rm(dataDir, { recursive: true, force: true });
  }
}

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passed += 1;
    log("+ " + label);
    return;
  }
  failed += 1;
  log("x " + label + (detail === undefined ? "" : " - " + JSON.stringify(detail).slice(0, 500)));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
