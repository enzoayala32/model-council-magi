/**
 * Catálogo automático de modelos disponibles.
 *
 * Por qué existe: hasta ahora la lista de modelos del consejo era una
 * constante escrita a mano en `lib/models.ts`. Cada modelo nuevo, cada
 * baja y cada cambio de precio exigía editar el código. Los dos
 * proveedores que usamos exponen un endpoint público de listado, así que
 * el catálogo se puede descubrir en tiempo real y —lo que importa—
 * separar gratis de pago con un dato real y no con una suposición.
 *
 * Verificado contra las APIs reales (2026-11-04):
 * - `GET https://openrouter.ai/api/v1/models` → 200 sin API key, 455
 *   modelos. Cada uno trae `pricing` con `prompt`/`completion` como
 *   strings en USD POR TOKEN. "0" en ambos = gratis (18 modelos hoy).
 * - `GET https://integrate.api.nvidia.com/v1/models` → 200 sin API key,
 *   85 modelos. **No trae `pricing`**: la forma es
 *   `{id, object, created, owned_by}`. Por eso para NVIDIA no se puede
 *   afirmar gratis o pago — se reporta `free: null`, que la UI muestra
 *   como "—". Marcarlos gratis sería inventar un dato.
 *
 * Regla de honestidad: `free` es `true` solo con precio 0 verificado;
 * `false` con precio > 0 verificado; `null` cuando el proveedor no
 * publica precio. Nunca se infiere del nombre (`:free`, "flash", etc.).
 */

/** Endpoints públicos, sin credencial. */
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const NVIDIA_MODELS_URL = "https://integrate.api.nvidia.com/v1/models";

/** TTL del caché: media hora por default. Un listado no cambia tanto. */
const DEFAULT_TTL_MS = 30 * 60 * 1000;

export type CatalogProvider = "openrouter" | "nvidia";

export type CatalogModel = {
  /** El id que se manda a la API del proveedor. */
  id: string;
  label: string;
  provider: CatalogProvider;
  contextLength: number | null;
  /** true = gratis verificado, false = pago verificado, null = el
   *  proveedor no publica precio. */
  free: boolean | null;
  inputPerMillionUsd: number | null;
  outputPerMillionUsd: number | null;
};

export type CatalogResult = {
  models: CatalogModel[];
  fetchedAt: number;
  /** null si fue OK; mensaje en español si falló (nunca se lanza). */
  error: string | null;
};

/** Para tests: se inyecta el fetch y se evita la red. */
export type CatalogDeps = {
  fetchImpl?: typeof fetch;
  now?: () => number;
};

type CacheEntry = { result: CatalogResult };

const cache = new Map<CatalogProvider, CacheEntry>();

function parsePriceToPerMillion(raw: unknown): number | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return null;
  // El endpoint da USD POR TOKEN; mostramos por millón, que es la unidad
  // que la gente compara.
  return Math.round(value * 1_000_000 * 1e6) / 1e6;
}

/** Gratis solo si AMBOS precios son exactamente 0. */
function isFreePricing(prompt: number | null, completion: number | null): boolean | null {
  if (prompt === null || completion === null) return null;
  return prompt === 0 && completion === 0;
}

/** Normaliza una fila de OpenRouter a nuestro shape. */
function fromOpenRouter(raw: unknown): CatalogModel | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const id = typeof row.id === "string" ? row.id : null;
  if (!id) return null;
  const pricing = (row.pricing ?? null) as Record<string, unknown> | null;
  const input = parsePriceToPerMillion(pricing?.prompt);
  const output = parsePriceToPerMillion(pricing?.completion);
  const contextLength = typeof row.context_length === "number" ? row.context_length : null;
  return {
    id,
    label: typeof row.name === "string" && row.name ? row.name : id,
    provider: "openrouter",
    contextLength,
    free: isFreePricing(input, output),
    inputPerMillionUsd: input,
    outputPerMillionUsd: output,
  };
}

/** Normaliza una fila de NVIDIA: no hay precio que leer. */
function fromNvidia(raw: unknown): CatalogModel | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const id = typeof row.id === "string" ? row.id : null;
  if (!id) return null;
  return {
    id,
    label: id,
    provider: "nvidia",
    contextLength: null,
    // El endpoint no publica precio: no inventamos.
    free: null,
    inputPerMillionUsd: null,
    outputPerMillionUsd: null,
  };
}

async function fetchCatalog(
  provider: CatalogProvider,
  deps: CatalogDeps,
  apiKey?: string,
): Promise<CatalogResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const url = provider === "openrouter" ? OPENROUTER_MODELS_URL : NVIDIA_MODELS_URL;
  const normalize = provider === "openrouter" ? fromOpenRouter : fromNvidia;

  // La key es OPCIONAL y solo para evitar rate limits: se manda como
  // header, nunca se loguea. Sin key el endpoint responde igual (verificado).
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  try {
    const response = await fetchImpl(url, { headers });
    if (!response.ok) {
      return { models: [], fetchedAt: deps.now?.() ?? Date.now(), error: `El listado de ${provider} respondió ${response.status}.` };
    }
    const payload = (await response.json()) as { data?: unknown };
    const rows = Array.isArray(payload?.data) ? payload.data : [];
    const models = rows.map(normalize).filter((model): model is CatalogModel => model !== null);
    // Orden estable: por nombre, para que la UI no baile entre refetchs.
    models.sort((a, b) => a.label.localeCompare(b.label));
    return { models, fetchedAt: deps.now?.() ?? Date.now(), error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : "error de red";
    return { models: [], fetchedAt: deps.now?.() ?? Date.now(), error: `No se pudo listar ${provider}: ${message}` };
  }
}

/** Exportado para los tests: consulta UN proveedor con caché propio.
 * `getModelCatalog` es la fachada que usa la app. */
export async function getCatalog(
  provider: CatalogProvider,
  opts: { force?: boolean; ttlMs?: number; env?: { OPENROUTER_API_KEY?: string }; deps?: CatalogDeps } = {},
): Promise<CatalogResult> {
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts.deps?.now?.() ?? Date.now();
  const cached = cache.get(provider);

  if (!opts.force && cached && now - cached.result.fetchedAt < ttl && cached.result.error === null) {
    return cached.result;
  }

  const deps = opts.deps ?? {};
  const result = await fetchCatalog(provider, deps, opts.env?.OPENROUTER_API_KEY);
  // Si falla y hay algo en caché, se devuelve lo viejo con la data intacta
  // y el error a parte: es mejor mostrar el último listado conocido que una
  // pantalla vacía por un corte de red.
  if (result.error && cached && cached.result.models.length) {
    return { ...cached.result, error: result.error };
  }
  cache.set(provider, { result });
  return result;
}

/** Lista los dos proveedores en paralelo y devuelve el resumen. */
export async function getModelCatalog(
  opts: { force?: boolean; ttlMs?: number; deps?: CatalogDeps } = {},
): Promise<Record<CatalogProvider, CatalogResult>> {
  // Se leen solo las dos variables que el catálogo necesita: pasar
  // `process.env` entero a un tipo de props concretas no compila (tiene
  // index signature), y leer campo a campo deja claro qué se usa.
  const env = { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY };
  return {
    openrouter: await getCatalog("openrouter", { ...opts, env, deps: opts.deps }),
    nvidia: await getCatalog("nvidia", { ...opts, deps: opts.deps }),
  };
}

/** Separa gratis de pago. Lo "desconocido" va aparte, nunca a un lado. */
export function separateByPricing(models: CatalogModel[]): {
  free: CatalogModel[];
  paid: CatalogModel[];
  unknown: CatalogModel[];
} {
  const free: CatalogModel[] = [];
  const paid: CatalogModel[] = [];
  const unknown: CatalogModel[] = [];
  for (const model of models) {
    if (model.free === true) free.push(model);
    else if (model.free === false) paid.push(model);
    else unknown.push(model);
  }
  return { free, paid, unknown };
}

/** Solo para tests: limpia el caché entre casos. */
export function __clearCatalogCacheForTests(): void {
  cache.clear();
}
