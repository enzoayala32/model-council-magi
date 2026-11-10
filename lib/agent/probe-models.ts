/**
 * Etapa 0.7 — sondeo de modelos de agente por el pool de credenciales.
 *
 * ANTES (el bug que corrige): `scripts/probe-agent-models.ts` tomaba
 * `process.env.NVIDIA_API_KEY` directamente, una sola key, sin el pool ni el
 * clasificador. Consecuencias:
 *
 *  1. si esa key estaba en cooldown o era inválida, el sondeo marcaba el MODELO
 *     como caído, cuando el problema era de la credencial;
 *  2. si había dos keys configuradas, la segunda no se usaba nunca;
 *  3. los 401/403/429 no rotaban: se reintentaba con la misma key fallada.
 *
 * AHORA el sondeo pasa por `getProviderPool` (el mismo que usa el loop del
 * agente) y clasifica con `credentialOutcomeForError` (el mismo criterio):
 *
 *  - `invalid` (401/403 de auth) o `cooldown` (429/cuota/5xx/red/timeout) son
 *    problemas de KEY: se rota y se reintenta. **No** degradan el modelo.
 *  - 404 = el modelo no está desplegado para esta cuenta: se informa, no se
 *    reintenta.
 *  - timeout = demasiado lento para un loop: se informa, no se reintenta.
 *  - respuesta sin `tool_calls` = el modelo no sirve para el Coding Agent.
 *
 * `recordModelOutcome` (`lib/model-health.ts`) se pide solo con el resultado
 * final del MODELO, nunca con un problema de key: así el panel de salud degrada
 * un modelo que realmente falla.
 */

import { getProviderPool } from "../provider-resilience/registry";
import type { ProviderName } from "../provider-resilience/config";
import { credentialOutcomeForError } from "../provider-resilience/classify";
import { recordModelOutcome } from "../model-health";

const PROMPT = "Listá los archivos del proyecto. Usá la herramienta list_files.";

/** Cuántas keys probar antes de rendirse. */
const MAX_CREDENTIALES = 4;

export type ProbeVeredicto = "sirve" | "key-problema" | "no-desplegado" | "lento" | "sin-tool-calls" | "sin-configurar";

export type ProbeResultado = {
  modelo: string;
  veredicto: ProbeVeredicto;
  /** Latencia del primer request que respondió. */
  ms: number;
  /** Intentos con keys distintas (1 = sirvió a la primera). */
  intentos: number;
  /** Resumen legible del porqué. */
  detalle: string;
  herramienta?: string;
  argumentos?: string;
};

/** Error con status HTTP, igual que los que arroja la SDK. */
export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpStatusError";
  }
}

/**
 * Respuesta del modelo. OJO: la API de chat devuelve `tool_calls` (snake_case),
 * no `toolCalls`. Leer el nombre camelado daba siempre "vacío" y el sondeo
 * clasificaba modelos que SÍ funcionan como "sin tool_calls".
 */
export type ModelReply = {
  tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
  content?: string | null;
};

export type ProbeOpciones = {
  provider: ProviderName;
  /** Cliente inyectable (tests): devuelve la respuesta "del modelo". */
  completar: (modelo: string, credencial: string) => Promise<ModelReply>;
  timeoutMs?: number;
};

/** Sondea UN modelo. Rota credenciales cuando el problema es de key. */
export async function probeModelo(modelo: string, opciones: ProbeOpciones): Promise<ProbeResultado> {
  const pool = getProviderPool(opciones.provider);
  const cursor = pool.beginOperation();
  const timeoutMs = opciones.timeoutMs ?? 60_000;
  const inicio = Date.now();
  let intentos = 0;
  let ultimoDetalle = "no se pudo completar";

  for (let i = 0; i < MAX_CREDENTIALES; i += 1) {
    const lease = cursor.next();
    if (lease.status !== "AVAILABLE") {
      // Sin credencial disponible: no es un fallo del modelo. OJO con el
      // detalle: si ya se usó alguna key en ESTA operación, el pool responde
      // NO_CREDENTIALS aunque sí haya credenciales (todas quedaron excluidas
      // por el cursor) — esas están en cooldown, así que es problema de key.
      const nuncaSeUso = intentos === 0;
      return {
        modelo,
        veredicto: nuncaSeUso && lease.status === "NO_CREDENTIALS" ? "sin-configurar" : "key-problema",
        ms: Date.now() - inicio,
        intentos,
        detalle: nuncaSeUso && lease.status === "NO_CREDENTIALS"
          ? "sin credenciales configuradas"
          : "se agotaron las credenciales: " + ultimoDetalle,
      };
    }
    intentos += 1;

    let reply: ModelReply;
    let timedOut = false;
    try {
      reply = await conTimeout(opciones.completar(modelo, lease.lease.value), timeoutMs);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      timedOut = /timeout|abort/i.test(message);

      // Timeout: es problema del MODELO (demasiado lento para un loop), no de
      // la key. No se reintenta con otra credencial y la key queda sana.
      if (timedOut) {
        pool.release(lease.lease.id, "success");
        recordModelOutcome(modelo, false, "timeout");
        return { modelo, veredicto: "lento", ms: Date.now() - inicio, intentos, detalle: message.slice(0, 140) };
      }

      // 404: el modelo no está desplegado para esta cuenta. Es del MODELO, y
      // el clasificador lo devolvería como `cooldown` (su default): se mira
      // ANTES para no rotar keys ni degradar una key sana.
      if (error instanceof HttpStatusError && error.status === 404) {
        pool.release(lease.lease.id, "success");
        recordModelOutcome(modelo, false, "no desplegado (404)");
        return { modelo, veredicto: "no-desplegado", ms: Date.now() - inicio, intentos, detalle: message.slice(0, 140) };
      }

      const outcome = credentialOutcomeForError(error);
      // Problema de KEY: rotar y reintentar, no degradar el modelo.
      if (outcome === "invalid" || outcome === "cooldown") {
        pool.release(lease.lease.id, outcome);
        ultimoDetalle = message.slice(0, 140);
        continue;
      }

      // Cualquier otro fallo del modelo: no se reintenta con otra key.
      pool.release(lease.lease.id, "success");
      recordModelOutcome(modelo, false, "error del probe");
      return { modelo, veredicto: "key-problema", ms: Date.now() - inicio, intentos, detalle: message.slice(0, 140) };
    }

    // Respondió: esta key queda sana.
    pool.release(lease.lease.id, "success", Date.now(), undefined, lease.lease.healthGeneration);

    const toolCall = reply.tool_calls?.[0];
    if (!toolCall) {
      recordModelOutcome(modelo, false, "sin tool_calls");
      return {
        modelo,
        veredicto: "sin-tool-calls",
        ms: Date.now() - inicio,
        intentos,
        detalle: "respondió pero no llamó herramientas: " + String(reply.content ?? "(vacío)").slice(0, 100),
      };
    }
    recordModelOutcome(modelo, true);
    return {
      modelo,
      veredicto: "sirve",
      ms: Date.now() - inicio,
      intentos,
      detalle: "tool_call " + (toolCall.function?.name ?? "?"),
      herramienta: toolCall.function?.name,
      argumentos: (toolCall.function?.arguments ?? "").slice(0, 80),
    };
  }

  // Se agotaron las credenciales: el problema es de keys, no del modelo.
  return { modelo, veredicto: "key-problema", ms: Date.now() - inicio, intentos, detalle: "se agotaron las credenciales: " + ultimoDetalle };
}

function conTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout de " + ms + "ms")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Cliente real contra NVIDIA NIM (para el script). */
export function clienteNvidia(herramientas: unknown, timeoutMs: number) {
  return async (modelo: string, credencial: string): Promise<ModelReply> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const respuesta = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + credencial, "content-type": "application/json" },
        body: JSON.stringify({
          model: modelo,
          messages: [
            { role: "system", content: "Sos un agente de código. Usá las herramientas disponibles cuando hagan falta." },
            { role: "user", content: PROMPT },
          ],
          tools: herramientas,
          tool_choice: "auto",
          max_tokens: 300,
        }),
        signal: controller.signal,
      });
      const texto = await respuesta.text();
      // El timer del abort se limpia DESPUÉS de haber leído el body: si se
      // hacía en el `finally`, la promesa del `text()` quedaba colgada y el
      // resultado llegaba vacío (que parecía "sin tool_calls").
      clearTimeout(timer);
      if (!respuesta.ok) throw new HttpStatusError(respuesta.status, texto.slice(0, 140));
      const datos = JSON.parse(texto) as { choices?: Array<{ message?: ModelReply }> };
      return datos.choices?.[0]?.message ?? {};
    } catch (error: unknown) {
      clearTimeout(timer);
      throw error;
    }
  };
}
