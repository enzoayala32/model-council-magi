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

/**
 * Los servers de prueba compilan en `.next/dev/types`, y `tsconfig.json` incluye
 * esos archivos. Si un test se cancela a mitad de una compilacion, los `.d.ts`
 * quedan truncados y `npm run typecheck` empieza a fallar con errores de sintaxis
 * que no son de nadie. Se borran al arrancar, antes de que corra nada.
 */
function limpiarTiposDev(): void {
  const target = path.join(root, ".next", "dev", "types");
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    /* si esta en uso (otro server vivo), no se puede: no es fatal */
  }
}
/**
 * Etapa 0.2: copia la guardia de config MCP a una ruta absoluta sin espacios y
 * devuelve esa ruta. Necesario porque `--require` con una ruta que tiene
 * espacios se rompe al pasar por `cmd` en Windows, y una ruta relativa se
 * resuelve contra el cwd del proceso hijo (que en los tests de subprocesos no
 * es el repo).
 */
let guardiaCache: string | null = null;
/** Igual que `asegurarGuardia`, para el preload de DNS (Etapa 2.6, 3b). */
function asegurarDnsBlock(): string {
  if (dnsBlockCache && fs.existsSync(dnsBlockCache)) return dnsBlockCache;
  const origen = path.join(root, "lib", "test", "fixtures", "dns-block.js");
  const destino = path.join(os.tmpdir(), "magi-dns-block.js");
  try {
    fs.copyFileSync(origen, destino);
    dnsBlockCache = destino;
  } catch {
    dnsBlockCache = origen;
  }
  return dnsBlockCache;
}

let dnsBlockCache: string | null = null;

function asegurarGuardia(): string {
  if (guardiaCache && fs.existsSync(guardiaCache)) return guardiaCache;
  const origen = path.join(root, "lib", "test", "fixtures", "guard-mcp-config.js");
  const destino = path.join(os.tmpdir(), "magi-guard-mcp-config.js");
  try {
    fs.copyFileSync(origen, destino);
    guardiaCache = destino;
  } catch {
    // Si no se puede copiar, se usa el origen: funciona salvo en Windows con
    // espacios, que es peor que no tener guardia.
    guardiaCache = origen;
  }
  return guardiaCache;
}



/**
 * Timeout propio por script, para los que levantan servers de verdad.
 *
 * Estos arrancan 2 o 3 servers (modo dev: Next compila cada ruta en el primer
 * pedido) y esperan a que estén listos. Con la máquina cargada —la suite
 * completa, o la suite completa sin red— la compilación tarda mucho más, y el
 * timeout global de 15 min no alcanzaba: el test se cancelaba a mitad y sus
 * últimos checks daban 404 (rutas todavía compilando), no un fallo real.
 */
const PER_SCRIPT_TIMEOUT_MS: Record<string, number> = {
  "security:test-peer-spoof": 25 * 60 * 1000,
  "security:test-route-enforcement": 25 * 60 * 1000,
};

/** Harness que necesitan un proveedor real, red o credenciales. */
const LIVE_SCRIPTS = [
  "agent:test",
  "agent:test-runner-real",
  "agent:test-model-registry",
  "agent:stress",
  "agent:smoke-prompt-queue",
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
  "security:test-push-endpoint",
  "security:test-web-push",
  "security:test-mcp-loop",
  "security:test-mcp-admin",
  "security:test-mcp-admin-lockdown",
  "security:test-mcp-failclosed",
  "security:test-mcp-guard",
  "security:test-mcp-http",
  "security:test-mcp-client",
  "security:test-mcp-server",
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

    // Etapa 0.2: la guardia de config MCP real. Se propaga por NODE_OPTIONS
    // (npm pasa el entorno al hijo) y hace que cualquier test que toque la
    // config del usuario falle con un error explícito en vez de leerla o,
    // peor, escribirla.
    //
    // La ruta tiene que ser ABSOLUTA y SIN ESPACIOS: los tests que spawnan
    // subprocesos node (run_script, abort...) heredan NODE_OPTIONS con otro
    // cwd, y una ruta relativa se resuelve contra ESE. `root` tiene espacios
    // ("model council") y cmd los destroza, así que se copia a un temporal.
    const guardiaAbsoluta = asegurarGuardia();
    const previo = env.NODE_OPTIONS ?? "";
    // Etapa 2.6 (3b): el preload de DNS. Rompe dns.lookup (el que usa fetch por
    // debajo, que es el que importa) y dns.resolve*/dns/promises, salvo loopback.
    // ANTES estaba documentado pero no existía: el síntoma era
    // `lib/agent/test-webfetch.ts` dando 17/30 y "funcionando" solo en redes con DNS.
    const dnsBloqueado = asegurarDnsBlock();
    const conGuardia = (previo ? previo + " " : "") + "--require " + guardiaAbsoluta;
    env.NODE_OPTIONS = conGuardia + " --require " + dnsBloqueado;

    let dataDir: string | null = null;
    if (opts.isolate) {
      dataDir = makeIsolatedDataDir(name);
      env.MAGI_DATA_DIR = dataDir;
      // Etapa 0.2: la config de MCP también se aísla. Sin esto, cualquier test
      // que arme tools del agente (`createAgentTools` → `createMcpTools` →
      // `loadMcpConfig()`) lee la config MCP del USUARIO. Se apunta a un archivo
      // que no existe: mismo efecto que "no hay servidores", sin tocar la real.
      env.MAGI_MCP_CONFIG = path.join(dataDir, "mcp.json");
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
    // El timeout del script manda si existe; si no, el global.
    const effectiveTimeout = PER_SCRIPT_TIMEOUT_MS[name] ?? timeoutMs;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, effectiveTimeout);

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
      if (timedOut) console.error(`\n⏱️  ${name} superó ${Math.round(effectiveTimeout / 1000)}s y se canceló.`);
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

  limpiarTiposDev();

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
  const maxWarnings = process.env.MAX_WARNINGS ?? "10";
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
