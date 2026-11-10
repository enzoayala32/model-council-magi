/**
 * Etapa 0.7 — tests del sondeo de modelos (proveedor falso, sin red).
 *
 * Lo que fija: un problema de KEY (401/403/429) NO degrade el modelo — rota y
 * reintenta, y solo informa "key-problema". Un problema del modelo (404,
 * timeout, sin tool_calls) no se reintenta con otra key.
 *
 * Con proveedor falso: ninguna de estas pruebas toca la red.
 *
 * Uso: npm run agent:test-probe-models
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HttpStatusError, probeModelo, type ModelReply, type ProbeOpciones } from "./probe-models";
import { __resetProviderPoolsForTests } from "../provider-resilience/registry";
import { getModelHealthSnapshot } from "../model-health";

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passed += 1;
    console.log("+ " + label);
    return;
  }
  failed += 1;
  const suffix = detail === undefined ? "" : " - " + JSON.stringify(detail);
  console.log("x " + label + suffix);
}

if (!process.env.MAGI_DATA_DIR) {
  process.env.MAGI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "magi-probe-test-"));
}

/** Deja el entorno con exactamente estas keys y el pool recién construido. */
function conKeys(...keys: string[]): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("NVIDIA_API_KEY")) delete process.env[key];
  }
  keys.forEach((valor, indice) => {
    process.env[indice === 0 ? "NVIDIA_API_KEY" : "NVIDIA_API_KEY_" + (indice + 1)] = valor;
  });
  __resetProviderPoolsForTests();
}

const TOOL_OK: ModelReply = {
  tool_calls: [{ function: { name: "list_files", arguments: "{}" } }],
  content: "Voy a listar los archivos.",
};
const SIN_TOOLS: ModelReply = { tool_calls: undefined, content: "No hay herramienta para eso." };

/** Cliente que responde según qué key recibe (por valor, no por orden). */
function clientePorKey(porKey: Record<string, ModelReply | Error>, llamadas: string[]): ProbeOpciones["completar"] {
  return async (_modelo: string, credencial: string) => {
    llamadas.push(credencial);
    const respuesta = porKey[credencial];
    if (respuesta === undefined) throw new Error("key inesperada: " + credencial);
    if (respuesta instanceof Error) throw respuesta;
    return respuesta;
  };
}

async function main(): Promise<void> {
  console.log("== el modelo sirve: tool_calls bien formados ==\n");
  conKeys("buena");
  const ok = await probeModelo("modelo-ok", {
    provider: "nvidia",
    completar: async () => TOOL_OK,
    timeoutMs: 500,
  });
  check("veredicto sirve", ok.veredicto === "sirve", ok);
  check("reporta la herramienta", ok.herramienta === "list_files", ok);
  check("un solo intento (la primera key anduvo)", ok.intentos === 1, ok);

  console.log("\n== problema de KEY: rota y reintenta, NO degrada el modelo ==\n");
  const fallosDeKey: Array<[string, Error]> = [
    ["401 (auth)", new HttpStatusError(401, "unauthorized")],
    ["403 de auth", new HttpStatusError(403, "permission denied")],
    ["429 (cuota)", new HttpStatusError(429, "rate limited")],
  ];
  for (const [label, error] of fallosDeKey) {
    // La primera key falla, la segunda responde bien: debe rotar y servir.
    const llamadas: string[] = [];
    conKeys("mala", "buena");
    const resultado = await probeModelo("modelo-rotado", {
      provider: "nvidia",
      completar: clientePorKey({ mala: error, buena: TOOL_OK }, llamadas),
      timeoutMs: 500,
    });
    check(label + ": rota a la segunda key y sirve", resultado.veredicto === "sirve", resultado);
    check(label + ": hizo 2 intentos", resultado.intentos === 2, resultado.intentos);
    check(label + ": usó las dos keys", llamadas.length === 2, llamadas);
  }

  console.log("\n== problema del MODELO: no se reintenta con otra key ==\n");
  const fallosDeModelo: Array<[string, Error, string]> = [
    ["404 (no desplegado)", new HttpStatusError(404, "not found"), "no-desplegado"],
    ["timeout", new Error("timeout de 500ms"), "lento"],
  ];
  for (const [label, error, esperado] of fallosDeModelo) {
    const llamadas: string[] = [];
    conKeys("key-a", "key-b");
    const resultado = await probeModelo("modelo-caido", {
      provider: "nvidia",
      completar: clientePorKey({ "key-a": error, "key-b": TOOL_OK }, llamadas),
      timeoutMs: 500,
    });
    check(label + ": veredicto " + esperado, resultado.veredicto === esperado, resultado);
    check(label + ": NO rota (un solo intento)", resultado.intentos === 1, resultado.intentos);
    check(label + ": no tocó la segunda key", llamadas.length === 1, llamadas);
  }

  // Sin tool_calls: responde pero no sirve para el agente.
  const llamadasSinTools: string[] = [];
  conKeys("key-a", "key-b");
  const sinTool = await probeModelo("modelo-sin-tools", {
    provider: "nvidia",
    completar: clientePorKey({ "key-a": SIN_TOOLS, "key-b": TOOL_OK }, llamadasSinTools),
    timeoutMs: 500,
  });
  check("sin tool_calls: veredicto sin-tool-calls", sinTool.veredicto === "sin-tool-calls", sinTool);
  check("sin tool_calls: NO rota (un solo intento)", sinTool.intentos === 1, sinTool.intentos);
  check("sin tool_calls: informa que respondió", /no llamó herramientas/i.test(sinTool.detalle), sinTool.detalle);

  console.log("\n== límites del pool ==\n");
  // Todas las keys fallan: el veredicto es de key, no del modelo.
  const todasLlamadas: string[] = [];
  conKeys("mala-1", "mala-2");
  const todasMalas = await probeModelo("modelo-keys-malas", {
    provider: "nvidia",
    completar: async (_modelo: string, credencial: string) => {
      todasLlamadas.push(credencial);
      throw new HttpStatusError(429, "rate limited");
    },
    timeoutMs: 500,
  });
  check("con todas las keys fallando: veredicto key-problema", todasMalas.veredicto === "key-problema", todasMalas);
  check("probó las 2 keys antes de rendirse", todasMalas.intentos === 2, todasMalas.intentos);

  // Sin keys: no es un fallo del modelo.
  conKeys();
  const sinKeys = await probeModelo("modelo-sin-keys", {
    provider: "nvidia",
    completar: async () => TOOL_OK,
    timeoutMs: 500,
  });
  check("sin credenciales: veredicto sin-configurar", sinKeys.veredicto === "sin-configurar", sinKeys);
  check("sin credenciales: ningún intento", sinKeys.intentos === 0, sinKeys.intentos);

  console.log("\n== model-health: distingue modelo de key ==\n");
  conKeys("key-a", "key-b");
  await probeModelo("modelo-sano", { provider: "nvidia", completar: async () => TOOL_OK, timeoutMs: 500 });
  await probeModelo("modelo-con-fallo-real", { provider: "nvidia", completar: async () => SIN_TOOLS, timeoutMs: 500 });
  await probeModelo("modelo-timeout-real", {
    provider: "nvidia",
    completar: async () => {
      throw new Error("timeout de 500ms");
    },
    timeoutMs: 500,
  });
  const snapshot = getModelHealthSnapshot();
  const sano = snapshot.find((s) => s.modelId === "modelo-sano");
  const fallido = snapshot.find((s) => s.modelId === "modelo-con-fallo-real");
  const lento = snapshot.find((s) => s.modelId === "modelo-timeout-real");
  check("un modelo que sirve queda sano", sano !== undefined && sano.lastOk === true, sano);
  check("un modelo sin tool_calls queda marcado como fallido", fallido !== undefined && fallido.lastOk === false, fallido);
  check("el fallo real tiene motivo", fallido?.lastFailureReason === "sin tool_calls", fallido);
  check("un timeout queda marcado como fallido del modelo", lento !== undefined && lento.lastOk === false, lento);

  // Un problema de key NUNCA deja rastro en model-health.
  const antes = getModelHealthSnapshot().map((s) => s.modelId).sort();
  conKeys("mala-1", "mala-2");
  await probeModelo("modelo-key-mala", {
    provider: "nvidia",
    completar: async () => {
      throw new HttpStatusError(403, "forbidden");
    },
    timeoutMs: 500,
  });
  const despues = getModelHealthSnapshot().map((s) => s.modelId).sort();
  check("un problema de key no degrada el modelo en model-health", !despues.includes("modelo-key-mala"), despues);
  check("un problema de key no ensucia el historial", JSON.stringify(despues) === JSON.stringify(antes), { antes, despues });

  console.log("");
  console.log(passed + "/" + (passed + failed) + " casos OK");
  if (failed > 0) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
