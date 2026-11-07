/**
 * Runner unificado de tests offline.
 *
 * Uso:
 *   npm test                 # suite offline (sin proveedores reales)
 *   npm run test:live        # harness que necesitan LLM/red/API keys
 *   npx tsx scripts/run-tests.ts --filter=council
 *   npx tsx scripts/run-tests.ts --verify   # tests + tope de warnings de lint
 *
 * Descubre los scripts de `package.json` por prefijo, corre uno por vez
 * (varias suites escriben en SQLite y no deben pisarse) y devuelve
 * exit 1 si alguno falla. No usa bash: funciona igual en Windows y Linux.
 *
 * Aislamiento de datos (Fase 1.5): cada script corre con `MAGI_DATA_DIR`
 * apuntando a un directorio temporal propio, que se borra al terminar.
 * Antes, las suites que usan SQLite escribían en el `data/council.db`
 * REAL del usuario y dejaban proyectos y tasks de prueba. Ahora
 * `npm test` no puede tocar la DB del usuario: el hash de
 * `data/council.db` es idéntico antes y después.
 *
 * Se puede desactivar con `--no-isolate` para debuggear contra la DB real
 * (no se usa en CI).
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
  scripts?: Record<string, string>;
};
const scripts = pkg.scripts ?? {};

const cli = process.argv.slice(2);
const live = cli.includes("--live");
const isolate = !cli.includes("--no-isolate");
/** Con --verify se corre además el tope de warnings de ESLint: así el
 *  reporte puede pegar la salida COMPLETA de la verificación de una fase
 *  (tests + lint con tope) en un solo comando. */
const verify = cli.includes("--verify");
const filterArg = cli.find((arg) => arg.startsWith("--filter="));
const filter = filterArg ? filterArg.slice("--filter=".length) : null;
const timeoutArg = cli.find((arg) => arg.startsWith("--timeout="));
const timeoutMs = timeoutArg ? Number(timeoutArg.slice("--timeout=".length)) * 1000 : 15 * 60 * 1000;

/** Harness que necesitan un proveedor real, red o credenciales. */
const LIVE_SCRIPTS = [
  "agent:test",
  "agent:test-runner-real",
  "agent:test-model-registry",
  "agent:stress",
] as const;

/** Harness manuales: piden argumentos y no tienen sentido en CI. */
const MANUAL_SCRIPTS = ["agent:test-project"] as const;

/** Agrupadores: repiten sub-tests que el runner ya ejecuta por separado. */
const AGGREGATOR_SCRIPTS = ["agent:test-phase8", "agent:test-phase9"] as const;

const OFFLINE_PREFIXES = ["agent:test-", "provider-resilience:test-", "council:test-"];
const OFFLINE_EXACT = [
  "test-council-resilience",
  "security:test-proxy",
  "security:test-http-headers",
  "security:test-token-route",
  "security:test-nvidia-rotation",
  "security:test-agent-sse",
  "security:test-task-stream-reducer",
  "security:test-devices",
  "security:test-route-scopes",
  "security:test-step-up",
  "security:test-device-routes",
  "security:test-rate-limit",
  "security:test-peer-spoof",
  "security:test-route-enforcement",
  "security:test-operator-routes",
  "security:test-operator-sessions",
  "security:test-remote-doctor",
  "security:test-sse-proxy",
  "security:test-request-proto",
];

const liveSet = new Set<string>(LIVE_SCRIPTS);
const manualSet = new Set<string>(MANUAL_SCRIPTS);
const aggregatorSet = new Set<string>(AGGREGATOR_SCRIPTS);

function isOfflineTest(name: string): boolean {
  if (liveSet.has(name) || manualSet.has(name) || aggregatorSet.has(name)) return false;
  return OFFLINE_PREFIXES.some((prefix) => name.startsWith(prefix)) || OFFLINE_EXACT.includes(name);
}

const candidates = Object.keys(scripts)
  .filter((name) => (live ? liveSet.has(name) : isOfflineTest(name)))
  .filter((name) => (filter ? name.includes(filter) : true))
  .sort();

if (candidates.length === 0) {
  console.error(filter ? `No hay tests que coincidan con --filter=${filter}.` : "No se encontraron tests para ejecutar.");
  process.exit(1);
}

const npmCommand = "npm";

function killTree(child: ChildProcess) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

/** Directorio temporal por script: `MAGI_DATA_DIR` hace que `lib/db.ts`
 * abra la DB ahí dentro en vez de `<cwd>/data`. Se nombra con el script
 * para que un fallo deje rastro legible. */
function makeIsolatedDataDir(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  return fs.mkdtempSync(path.join(os.tmpdir(), `magi-test-${safe}-`));
}

function runOne(
  name: string,
  opts: { isolate: boolean },
): Promise<{ name: string; ok: boolean; seconds: number; timedOut: boolean }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const env = { ...process.env };
    // Evita que una suite herede un loop autónomo de una corrida manual.
    delete env.MAGI_AUTONOMOUS_LOOP;

    let dataDir: string | null = null;
    if (opts.isolate) {
      dataDir = makeIsolatedDataDir(name);
      env.MAGI_DATA_DIR = dataDir;
    }

    const child = spawn(npmCommand, ["run", name], {
      cwd: root,
      env,
      stdio: "inherit",
      shell: process.platform === "win32",
      windowsHide: true,
      detached: process.platform !== "win32",
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);

    const finish = (ok: boolean) => {
      clearTimeout(timer);
      // La limpieza va en un catch: si el proceso dejó archivos abiertos,
      // no borrar el directorio no debe tumbar el runner.
      if (dataDir) {
        try {
          fs.rmSync(dataDir, { recursive: true, force: true });
        } catch {
          /* el SO lo limpiará; no es un fallo del test */
        }
      }
      resolve({ name, ok, seconds: Math.round((Date.now() - started) / 1000), timedOut });
    };

    child.on("error", (error) => {
      console.error(`No se pudo lanzar ${name}: ${error.message}`);
      finish(false);
    });
    child.on("close", (code, signal) => {
      const ok = !timedOut && code === 0;
      if (timedOut) console.error(`\n⏱️  ${name} superó ${Math.round(timeoutMs / 1000)}s y se canceló.`);
      else if (!ok) console.error(`\n❌ ${name} terminó con ${signal ? `signal ${signal}` : `exit ${code}`}.`);
      finish(ok);
    });
  });
}

(async () => {
  const mode = live ? "live" : "offline";
  console.log(`\n=== Tests ${mode} — ${candidates.length} script(s) ===`);
  if (live) console.log("Requieren proveedor/red/API keys. No se ejecutan en CI.");
  if (!live && isolate) console.log("Cada script corre con MAGI_DATA_DIR propio (data/council.db del usuario no se toca).");
  if (!live && manualSet.size > 0) {
    console.log(`Omitidos por manuales: ${[...manualSet].join(", ")}`);
  }
  if (!live && aggregatorSet.size > 0) {
    console.log(`Omitidos por agrupadores (sus sub-tests ya corren): ${[...aggregatorSet].join(", ")}`);
  }
  console.log("");

  const results: Array<{ name: string; ok: boolean; seconds: number; timedOut: boolean }> = [];
  for (let i = 0; i < candidates.length; i++) {
    const name = candidates[i];
    console.log(`\n[${i + 1}/${candidates.length}] ${name}`);
    const result = await runOne(name, { isolate: !live && isolate });
    results.push(result);
    console.log(`${result.ok ? "✅" : "❌"} ${name} (${result.seconds}s)`);
  }

  const failed = results.filter((result) => !result.ok);
  console.log(`\n=== Resumen: ${results.length - failed.length}/${results.length} OK ===`);
  if (failed.length > 0) {
    console.error(`Fallaron: ${failed.map((result) => `${result.name}${result.timedOut ? " (timeout)" : ""}`).join(", ")}`);
    process.exit(1);
  }

  if (!verify) return;

  // Tope de warnings: si la deuda de lint crece, esto falla. El número sale
  // del tope real de hoy; se baja a medida que se limpia cada regla.
  const maxWarnings = process.env.MAX_WARNINGS ?? "37";
  console.log(`
=== Lint (--max-warnings=${maxWarnings}) ===`);
  const lint = await new Promise<{ code: number | null }>((resolve) => {
    const child = spawn("npm", ["run", "lint", "--", "--max-warnings", maxWarnings], {
      cwd: root,
      env: { ...process.env },
      stdio: "inherit",
      shell: process.platform === "win32",
      windowsHide: true,
    });
    child.on("exit", (code) => resolve({ code }));
    child.on("error", () => resolve({ code: null }));
  });
  if (lint.code !== 0) {
    console.error(`
❌ El lint superó los ${maxWarnings} warnings permitidos.`);
    process.exit(1);
  }
  console.log(`
✅ Lint dentro del tope (${maxWarnings} warnings).`);
})();
