/**
 * Etapa 0.7 — sondeo de modelos de agente (por el pool de credenciales).
 *
 * Ya NO toma `process.env.NVIDIA_API_KEY` a mano: pasa por
 * `lib/agent/probe-models.ts`, que usa el mismo pool y el mismo clasificador
 * que el loop del agente. Un 401/403/429 rota la key y reintenta; no degrade el
 * modelo. 404 = no desplegado. Timeout = demasiado lento. Sin `tool_calls` = no
 * sirve para el Coding Agent.
 *
 * Escribe `docs/bench/modelos-agente.json` con fecha, veredicto y latencia por
 * modelo, para no tener que editar `lib/models.ts` a mano.
 *
 * Uso:
 *   npm run agent:probe-models
 *   npx tsx scripts/probe-agent-models.ts --model=stepfun-ai/step-5-preview
 */
import fs from "node:fs";
import path from "node:path";
import { __resetProviderPoolsForTests } from "../lib/provider-resilience/registry";
import { clienteNvidia, probeModelo, type ProbeResultado } from "../lib/agent/probe-models";
import { getCodingAgentModels } from "../lib/models";

const CANDIDATOS = [
  "stepfun-ai/step-5-preview",
  "minimaxai/minimax-m3.1-flash",
  "nvidia/nemotron-3-ultra-550b-a55b",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
  "nvidia/nemotron-3.5-lightning-30b-a3b",
  "z-ai/glm-5.3-flash",
  "moonshotai/kimi-k2.6",
  "deepseek-ai/deepseek-v4.1-flash",
  "nvidia/nemotron-3-super-120b-a12b",
];

const HERRAMIENTAS = [
  {
    type: "function",
    function: {
      name: "list_files",
      description: "Lista los archivos del proyecto (rutas relativas).",
      parameters: {
        type: "object",
        properties: { subPath: { type: "string", description: "Subcarpeta relativa." } },
      },
    },
  },
];

const TIMEOUT_MS = 60_000;

/** Carga .env para poder correr fuera de Next. */
function cargarEnv(): void {
  for (const nombre of [".env", ".env.local"]) {
    const archivo = path.join(process.cwd(), nombre);
    if (!fs.existsSync(archivo)) continue;
    for (const linea of fs.readFileSync(archivo, "utf8").split(/\r?\n/)) {
      const eq = linea.indexOf("=");
      if (eq <= 0 || linea.trim().startsWith("#")) continue;
      const clave = linea.slice(0, eq).trim();
      if (process.env[clave] === undefined) process.env[clave] = linea.slice(eq + 1).trim();
    }
  }
}

function leerArg(nombre: string): string | null {
  const arg = process.argv.find((a) => a.startsWith("--" + nombre + "="));
  return arg ? arg.slice(nombre.length + 3) : null;
}

function etiqueta(veredicto: ProbeResultado["veredicto"]): string {
  switch (veredicto) {
    case "sirve":
      return "SIRVE";
    case "no-desplegado":
      return "NO DESPLEGADO";
    case "lento":
      return "LENTO";
    case "sin-tool-calls":
      return "SIN TOOL_CALLS";
    case "sin-configurar":
      return "SIN CONFIGURAR";
    default:
      return "PROBLEMA DE KEY";
  }
}

async function main(): Promise<void> {
  cargarEnv();
  // El pool lee las credenciales del entorno AL CONSTRUIRSE: si ya existía de
  // una corrida anterior en el mismo proceso, habría que resetearlo.
  __resetProviderPoolsForTests();

  const pedido = leerArg("model");
  const habilitados = getCodingAgentModels().map((m) => m.id);
  const modelos = pedido ? [pedido] : CANDIDATOS;

  const sinKey = !process.env.NVIDIA_API_KEY?.trim();
  console.log("");
  console.log("=== Sondeo de modelos de agente (por pool de credenciales) ===");
  console.log("");
  if (sinKey) {
    console.log("No hay NVIDIA_API_KEY en el entorno: no se puede sondear nada.");
    console.log("Definila en .env (o en el entorno) y volvé a intentar.");
    console.log("");
    process.exit(1);
  }

  const completar = clienteNvidia(HERRAMIENTAS, TIMEOUT_MS);
  const resultados: ProbeResultado[] = [];

  for (const modelo of modelos) {
    const resultado = await probeModelo(modelo, { provider: "nvidia", completar, timeoutMs: TIMEOUT_MS });
    resultados.push(resultado);
    const marca =
      resultado.veredicto === "sirve"
        ? "SIRVE "
        : resultado.veredicto === "key-problema"
          ? "KEY   "
          : "NO    ";
    console.log(
      marca +
        modelo.padEnd(44) +
        String(resultado.ms).padStart(7) +
        "ms  " +
        (resultado.intentos > 1 ? resultado.intentos + " keys  " : "") +
        etiqueta(resultado.veredicto) +
        "  " +
        resultado.detalle.slice(0, 60),
    );
  }

  const sirven = resultados.filter((r) => r.veredicto === "sirve");
  console.log("");
  console.log(sirven.length + " de " + resultados.length + " sirven para el Coding Agent.");

  const salida = {
    fecha: new Date().toISOString(),
    proveedor: "nvidia",
    nota:
      "Veredicto por modelo. 'key-problema' NO degrade el modelo: es de la credencial (401/403/429), " +
      "y el pool rota y reintenta. 'no-desplegado' = 404 de la cuenta. 'lento' = timeout. " +
      "'sin-tool-calls' = respondió pero no llamó herramientas.",
    habilitadosEnElCatalogo: habilitados,
    modelos: resultados.map((r) => ({
      modelo: r.modelo,
      veredicto: r.veredicto,
      ms: r.ms,
      intentos: r.intentos,
      detalle: r.detalle,
      herramienta: r.herramienta ?? null,
    })),
  };
  const destino = path.join(process.cwd(), "docs", "bench", "modelos-agente.json");
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.writeFileSync(destino, JSON.stringify(salida, null, 2) + "\n");
  console.log("");
  console.log("Escrito: " + destino);
  console.log("Para habilitar un modelo que SIRVE, agregalo a COUNCIL_MODELS en lib/models.ts con");
  console.log('  provider: "nvidia", codingAgent: { enabled: true, reason: "validado con agent:probe-models" },');
  console.log("");
}

main().catch((error: unknown) => {
  console.error("");
  console.error("Falló el sondeo:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
