/**
 * Prueba EN VIVO de una task del agente contra un modelo real.
 *
 * Arma un repo git de mentira en un temporal, crea la task con el modelo que le
 * pases, y la corre de punta a punta: estado final, eventos, pasos y propuestas.
 *
 * Uso:
 *   npx tsx scripts/test-agent-live.ts --model=stepfun-ai/step-5-preview --prompt="..."
 *
 * Necesita la API key del proveedor en .env o en el entorno.
 */
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createProject } from "../lib/agent/project-store";
import { createTask, getTask } from "../lib/agent/task-store";
import { runTask } from "../lib/agent/runner";
import { listEvents } from "../lib/agent/event-log";
import { getCodingAgentModels } from "../lib/models";

const execFileAsync = promisify(execFile);

/** Carga .env para poder correr fuera de Next (el server de Next ya lo haría). */
function cargarEnv(): void {
  for (const nombre of [".env", ".env.local"]) {
    const archivo = path.join(process.cwd(), nombre);
    if (!fsSync.existsSync(archivo)) continue;
    for (const linea of fsSync.readFileSync(archivo, "utf8").split(String.fromCharCode(13, 10))) {
      const eq = linea.indexOf("=");
      if (eq <= 0 || linea.trim().startsWith("#")) continue;
      const clave = linea.slice(0, eq).trim();
      if (process.env[clave] === undefined) process.env[clave] = linea.slice(eq + 1).trim();
    }
  }
}

async function makeGitProject(nombre: string): Promise<{ id: string; localPath: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `consenso-ia-live-${nombre}-`));
  await fs.writeFile(
    path.join(dir, "README.md"),
    "# Proyecto de prueba\n\nUn README de mentira para probar el agente.\n",
  );
  await fs.writeFile(
    path.join(dir, "suma.ts"),
    "export function suma(a: number, b: number): number {\n  return a + b;\n}\n",
  );
  await execFileAsync("git", ["init"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
  await execFileAsync("git", ["add", "-A"], { cwd: dir });
  await execFileAsync("git", ["commit", "-m", "inicial"], { cwd: dir });
  const project = await createProject({ name: nombre, localPath: dir });
  return { id: project.id, localPath: dir };
}

function leerArg(nombre: string, porDefecto: string): string {
  const arg = process.argv.find((a) => a.startsWith("--" + nombre + "="));
  return arg ? arg.slice(nombre.length + 3) : porDefecto;
}

async function main(): Promise<void> {
  cargarEnv();
  const modelo = leerArg("model", "stepfun-ai/step-5-preview");
  const prompt = leerArg(
    "prompt",
    "Leé suma.ts y creá un archivo test-suma.ts con un test que verifique que suma(2,3) da 5. No uses dependencias externas.",
  );

  const habilitados = getCodingAgentModels().map((m) => m.id);
  if (!habilitados.includes(modelo)) {
    console.error("\nEl modelo " + modelo + " no está habilitado para el agente.");
    console.error("Habilitados: " + habilitados.join(", ") + "\n");
    process.exit(1);
  }

  if (!process.env.MAGI_DATA_DIR) {
    process.env.MAGI_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "consenso-ia-live-db-"));
  }

  console.log("\n=== Task en vivo con " + modelo + " ===\n");
  const proyecto = await makeGitProject("live-" + Date.now());
  console.log("proyecto:", proyecto.localPath);

  const task = createTask({
    projectId: proyecto.id,
    modelId: modelo,
    prompt,
  });
  console.log("task:", task.id, "| estado:", task.status);

  const inicio = Date.now();
  const ok = await runTask(task.id, { autonomyRunner: false });
  const ms = Date.now() - inicio;

  const final = getTask(task.id);
  const eventos = listEvents(task.id);
  console.log("\n--- resultado ---");
  console.log("runTask:", ok ? "OK" : "FALLÓ");
  console.log("estado final:", final?.status, "| pasos:", final?.restartRetryCount ?? 0);
  console.log("duración:", Math.round(ms / 1000) + "s");
  console.log("eventos:", eventos.length);
  // El payload real está bajo `.payload` (AgentEventPayload): leerlo del evento
  // directo daba toolName vacío.
  const resumen = eventos.slice(0, 24).map((evento) => {
    const p = (evento as unknown as { payload?: Record<string, unknown> }).payload ?? {};
    const tipo = String(p.type ?? "?");
    if (tipo === "tool_call") {
      return "  → tool_call " + String(p.toolName ?? "") + " " + JSON.stringify(p.input ?? {}).slice(0, 70);
    }
    if (tipo === "tool_result") {
      const extra = p.ok ? "" : " error=" + String(p.error ?? "").slice(0, 60);
      return "  ← tool_result " + String(p.toolName ?? "") + " ok=" + String(p.ok) + extra;
    }
    if (tipo === "text") return "  · texto: " + String(p.text ?? "").slice(0, 100);
    if (tipo === "status_change") return "  ● estado " + String(p.from ?? "") + " → " + String(p.to ?? "");
    if (tipo === "final_report") return "  ★ informe final";
    if (tipo === "git_commit_result") return "  ★ commit";
    return "  · " + tipo;
  });
  console.log(resumen.join("\n"));
  if (eventos.length > 24) console.log("  … y " + (eventos.length - 24) + " eventos más");

  if (final?.error) console.log("\nerror:", final.error.slice(0, 300));
  process.exit(ok && final?.status === "APPLIED" ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error("\nFALLÓ LA PRUEBA:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
