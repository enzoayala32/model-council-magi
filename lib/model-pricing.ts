/**
 * Fase 7A — precio estimado por modelo.
 *
 * El consejo corre casi entero con modelos `:free` de OpenRouter, así que el
 * costo real de la mayoría de las corridas es USD 0. Para los modelos que
 * pueden facturarse (Gemini nativo, modelos pagos de OpenRouter) no tenemos
 * el costo exacto que devuelve el proveedor: `usage` solo trae tokens. Acá
 * se estima con una tabla explícita y se marca `estimated: true`.
 *
 * Reglas:
 * - Cualquier id terminado en `:free` cuesta 0, sin importar la tabla.
 * - Un id sin entrada y sin sufijo `:free` devuelve `null` (desconocido),
 *   NO 0: mostrar "USD 0" para un modelo pago sería peor que mostrar "—".
 * - Los valores son USD por millón de tokens, tomados de una tarifa
 *   publicada. Si un proveedor cambia precios, se actualiza la tabla a
 *   mano; no hay fuente automática.
 * - Fuera de la tabla y sin `:free`, `costUsd` es `null` ("—"), nunca 0.
 */

export type ModelPricing = {
  /** USD por millón de tokens de entrada. */
  inputPerMillionUsd: number;
  /** USD por millón de tokens de salida. */
  outputPerMillionUsd: number;
  /** De dónde salió el número (para mostrarlo en la UI como "estimado"). */
  source: string;
};

export type UsageLike = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

export type CostEstimate = {
  costUsd: number | null;
  pricing: ModelPricing | null;
  /** true si el modelo es `:free` o tiene precio 0 explícito. */
  free: boolean;
  /** true si `costUsd` se calculó con una tabla, no con el costo real. */
  estimated: boolean;
};

const FREE_PRICING: ModelPricing = {
  inputPerMillionUsd: 0,
  outputPerMillionUsd: 0,
  source: "modelo :free de OpenRouter / cupo gratuito del proveedor",
};

/**
 * Precios que se pueden verificar contra una tarifa publicada.
 *
 * Regla de esta fase: NADA de "estimado sobre otro modelo". Un precio
 * inventado se muestra como costo real y el usuario terminaría tomando
 * decisiones con un número falso. Si un modelo no tiene precio público
 * verificable, no entra en esta tabla y `estimateCostUsd` devuelve
 * `null`, que la UI muestra como "—".
 *
 * Incluidos: la familia Gemini 2.5, cuya tarifa (tier pago de Google AI
 * Studio) es pública y estable. Gemini 3.x/3.5/3.1 NO tiene precio propio
 * publicado: sus entradas se eliminaron y ahora devuelven "—".
 * El tier gratuito no factura, así que estos números son el techo de lo
 * que podría costar una llamada, no lo que se cobra.
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  "gemini-2.5-flash": { inputPerMillionUsd: 0.3, outputPerMillionUsd: 2.5, source: "tarifa pública de Google AI Studio (tier pago)" },
  "gemini-2.5-flash-lite": { inputPerMillionUsd: 0.1, outputPerMillionUsd: 0.4, source: "tarifa pública de Google AI Studio (tier pago)" },
  "gemini-2.5-pro": { inputPerMillionUsd: 1.25, outputPerMillionUsd: 10, source: "tarifa pública de Google AI Studio (tier pago)" },
};

export function isFreeModelId(modelId: string): boolean {
  return modelId.trim().toLowerCase().endsWith(":free");
}

export function pricingForModel(modelId: string): ModelPricing | null {
  const id = modelId.trim();
  if (!id) return null;
  if (isFreeModelId(id)) return FREE_PRICING;
  return MODEL_PRICING[id] ?? null;
}

function nonNegative(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return value;
}

/**
 * Estima el costo de una llamada. Si el modelo es `:free` o tiene precio 0,
 * devuelve 0 con `free: true`. Si no hay precio conocido, `costUsd: null`.
 */
export function estimateCostUsd(modelId: string, usage: UsageLike | undefined): CostEstimate {
  const pricing = pricingForModel(modelId);
  if (!pricing) return { costUsd: null, pricing: null, free: false, estimated: true };

  const prompt = nonNegative(usage?.prompt_tokens);
  const completion = nonNegative(usage?.completion_tokens);
  const free = pricing.inputPerMillionUsd === 0 && pricing.outputPerMillionUsd === 0;
  const costUsd = (prompt * pricing.inputPerMillionUsd + completion * pricing.outputPerMillionUsd) / 1_000_000;

  return {
    costUsd: Math.round(costUsd * 1e6) / 1e6,
    pricing,
    free,
    estimated: !free,
  };
}

export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (value === 0) return "USD 0";
  if (Math.abs(value) < 0.01) return `USD ${value.toFixed(4)}`;
  return `USD ${value.toFixed(2)}`;
}
