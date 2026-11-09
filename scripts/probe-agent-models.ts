/**
 * Prueba en vivo si un modelo sirve para el Coding Agent.
 *
 * No alcanza con que el modelo responda: el agente necesita TOOL-CALLING
 * multi-paso. Acá se le manda una herramienta real (`list_files`, la misma que
 * usa el agente) y un prompt que la exige. Si devuelve un `tool_calls` con
 * argumentos JSON válidos, sirve; si no, se dice por qué.
 *
 * Uso:
 *   npm run agent:probe-models                      # los candidatos por defecto
 *   npx tsx scripts/probe-agent-models.ts --model=X # uno puntual
 *
 * Sirve para decidir si vale la pena habilitar un modelo en `lib/models.ts`
 * (campo `codingAgent.enabled`). La evidencia queda impresa, con los ms.
 */
import fs from "node:fs";
import path from "node:path";

/** Candidatos: se prueban todos y se informa cuáles sirven. */
const CANDIDATOS = [
  "stepfun-ai/step-5-preview",
  "minimaxai/minimax-m3.1-flash",
  "nvidia/nemotron-3-ultra-550b-a55b",
  "nvidia/nemotron-3.5-lightning-30b-a3b",
  "z-ai/glm-5.3-flash",
  "moonshotai/kimi-k2.6",
  "deepseek-ai/deepseek-v4.1-flash",
  "nvidia/nemotron-3-super-120b-a12b",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
];

/** Igual que `lib/agent/tools.ts` describe `list_files`. */
const HERRAMIENTAS = [
  {
    type: "function",
    function: {
      name: "list_files",
      description: "Lista los archivos del proyecto (rutas relativas), para orientarse antes de buscar o editar.",
      parameters: {
        type: "object",
        properties: { subPath: { type: "string", description: "Subcarpeta relativa donde listar (opcional)." } },
      },
    },
  },
];

type Resultado = {
  modelo: string;
  ok: boolean;
  motivo: string;
  ms: number;
};

/** Carga .env si existe (el script corre fuera de Next). */
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

async function probar(modelo: string, apiKey: string): Promise<Resultado> {
  const inicio = Date.now();
  try {
    const respuesta = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer " + apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        model: modelo,
        messages: [
          { role: "system", content: "Sos un agente de código. Usá las herramientas disponibles cuando hagan falta." },
          { role: "user", content: "Listá los archivos del proyecto. Usá la herramienta list_files." },
        ],
        tools: HERRAMIENTAS,
        tool_choice: "auto",
        max_tokens: 300,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const texto = await respuesta.text();
    if (!respuesta.ok) {
      return { modelo, ok: false, motivo: "HTTP " + respuesta.status + " — " + texto.slice(0, 140), ms: Date.now() - inicio };
    }
    const datos = JSON.parse(texto) as {
      choices?: Array<{ message?: { content?: string; tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> } }>;
    };
    const mensaje = datos.choices?.[0]?.message ?? {};
    const llamadas = mensaje.tool_calls ?? [];
    const primera = llamadas[0];
    let argumentosOk = false;
    if (primera?.function?.arguments !== undefined) {
      try {
        JSON.parse(primera.function.arguments);
        argumentosOk = true;
      } catch {
        argumentosOk = false;
      }
    }
    if (llamadas.length > 0 && argumentosOk) {
      return {
        modelo,
        ok: true,
        motivo: "tool_call " + primera.function.name + "(" + String(primera.function.arguments).slice(0, 50) + ")",
        ms: Date.now() - inicio,
      };
    }
    return {
      modelo,
      ok: false,
      motivo: "sin tool_calls — contenido: " + String(mensaje.content ?? "(vacío)").slice(0, 110),
      ms: Date.now() - inicio,
    };
  } catch (error: unknown) {
    const mensaje = error instanceof Error ? error.message : String(error);
    // Un timeout de 60s no es "no sirve": es "no sirve para un loop", que es lo
    // mismo en la práctica, pero se dice claro.
    const motivo = /abort|timeout/i.test(mensaje) ? "timeout de 60s (demasiado lento para un loop)" : mensaje.slice(0, 140);
    return { modelo, ok: false, motivo, ms: Date.now() - inicio };
  }
}

function main(): void {
  cargarEnv();
  const apiKey = process.env.NVIDIA_API_KEY?.trim() ?? "";
  if (!apiKey) {
    console.error("\nFalta NVIDIA_API_KEY (en .env o en el entorno). Sin ella no se puede probar nada.\n");
    process.exit(1);
  }

  const pedido = process.argv.find((arg) => arg.startsWith("--model="))?.slice("--model=".length);
  const modelos = pedido ? [pedido] : CANDIDATOS;

  void (async () => {
    console.log("\n=== Probando tool-calling contra NVIDIA NIM ===\n");
    const resultados: Resultado[] = [];
    for (const modelo of modelos) {
      const resultado = await probar(modelo, apiKey);
      resultados.push(resultado);
      const marca = resultado.ok ? "SIRVE " : "NO    ";
      console.log(marca + modelo.padEnd(46) + String(resultado.ms).padStart(7) + "ms  " + resultado.motivo.slice(0, 96));
    }
    const sirven = resultados.filter((r) => r.ok);
    console.log("\n" + sirven.length + " de " + resultados.length + " sirven para el Coding Agent.\n");
    if (sirven.length > 0) {
      console.log("Para habilitarlos, agregálos a COUNCIL_MODELS en lib/models.ts con:");
      console.log('  provider: "nvidia",');
      console.log("  codingAgent: { enabled: true, reason: \"validado en vivo <fecha>\" },\n");
    }
    process.exit(0);
  })();
}

main();
