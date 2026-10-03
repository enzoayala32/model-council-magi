/**
 * Fase 6B — Search Tool: proveedor de búsqueda web.
 *
 * Un único proveedor (Tavily), sin fallback, sin pool de credentials, sin
 * integración con `provider-resilience` — decisión explícita del usuario,
 * no una omisión. Tavily se eligió por ser la única de las opciones
 * evaluadas diseñada específicamente para consumo por un LLM/agente vía
 * tool-calling: su respuesta ya trae `content` como snippet curado (no
 * HTML crudo), calzando casi textual con `SearchResult` de acá abajo.
 *
 * API real de Tavily (verificada contra su documentación, no asumida):
 * `POST https://api.tavily.com/search`, header `Authorization: Bearer
 * <key>`, body `{query, max_results, search_depth}`, respuesta
 * `{results: [{title, url, content, score, ...}], ...}`. Solo se leen
 * `title`/`url`/`content` — cualquier otro campo (`score`, `favicon`,
 * `raw_content`, `images`, lo que Tavily agregue a futuro) se descarta
 * explícitamente acá, nunca llega al modelo.
 */
import { registerSecret, redactSecrets } from "../provider-resilience/redact";

export type SearchResult = { title: string; url: string; snippet: string };

export interface SearchProvider {
  search(query: string, opts: { maxResults: number; signal?: AbortSignal }): Promise<SearchResult[]>;
}

/** Tope duro de resultados de UNA búsqueda web — deliberadamente MUY por
 * debajo de `MAX_SEARCH_RESULTS=60` de `search_files` (grep local): cada
 * resultado externo pesa mucho más en tokens/contexto que una línea de
 * grep, y el modelo nunca necesita "todo lo que hay en internet" para
 * decidir si una pista sirve o probar otra query — 6 alcanza para eso. El
 * modelo puede pedir MENOS (`maxResults` en el input de la tool), nunca
 * más: `search()` lo capea acá adentro sea cual sea lo que pida. */
export const MAX_WEB_SEARCH_RESULTS = 6;

const TAVILY_ENDPOINT = "https://api.tavily.com/search";

/** Timeout de ESTA llamada de red puntual — independiente del
 * `timeoutMs` de `wrapToolExecute` para `web_search` (ver `tools.ts`),
 * igual que `run_typecheck`/`run_script` ya tienen su propio
 * `timeout:120_000` en `execFileAsync` con la política de 6A como
 * backstop por encima. Acá el `fetch` real se cancela solo (con la request
 * HTTP realmente cortada, algo que `execFileAsync` no permitía sin tocar
 * esas 2 tools) sin depender de que `wrapToolExecute` se dé por vencido
 * desde afuera. */
const TAVILY_REQUEST_TIMEOUT_MS = 15_000;

export class TavilySearchProvider implements SearchProvider {
  constructor(private readonly apiKey: string) {
    // Mismo patrón que `createProviderPool` (5C): se registra ANTES de la
    // primera llamada real, para que cualquier error que la mencione por
    // accidente (de Tavily o de este código) salga siempre redactado.
    registerSecret(apiKey);
  }

  async search(query: string, opts: { maxResults: number; signal?: AbortSignal }): Promise<SearchResult[]> {
    const cappedMax = Math.max(1, Math.min(opts.maxResults, MAX_WEB_SEARCH_RESULTS));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TAVILY_REQUEST_TIMEOUT_MS);
    const onUpstreamAbort = () => controller.abort();
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener("abort", onUpstreamAbort, { once: true });
    }

    try {
      let response: Response;
      try {
        response = await fetch(TAVILY_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify({ query, max_results: cappedMax, search_depth: "basic" }),
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) throw new Error("La búsqueda en Tavily se canceló o superó el tiempo de espera.");
        throw new Error(redactSecrets(`No se pudo contactar a Tavily: ${error instanceof Error ? error.message : String(error)}`));
      }

      if (!response.ok) {
        const bodyText = await response.text().catch(() => "");
        throw new Error(redactSecrets(`Tavily respondió ${response.status}: ${bodyText.slice(0, 300)}`));
      }

      let data: unknown;
      try {
        data = await response.json();
      } catch {
        throw new Error("Tavily devolvió una respuesta que no es JSON válido.");
      }

      const results = (data as { results?: unknown } | null)?.results;
      if (!Array.isArray(results)) {
        throw new Error("Tavily devolvió una respuesta con forma inesperada (sin 'results').");
      }

      // Filtro EXPLÍCITO de campos — solo estos 3 salen de acá, pase lo
      // que pase que Tavily incluya además (score, favicon, raw_content,
      // images, credit usage, etc.).
      return results.slice(0, cappedMax).map((r) => {
        const item = r as { title?: unknown; url?: unknown; content?: unknown };
        return {
          title: typeof item?.title === "string" ? item.title : "",
          url: typeof item?.url === "string" ? item.url : "",
          snippet: typeof item?.content === "string" ? item.content : "",
        };
      });
    } finally {
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener("abort", onUpstreamAbort);
    }
  }
}

/** `undefined` si no hay `TAVILY_API_KEY` configurada — `tools.ts` usa
 * esto para decidir si ofrece `web_search` en absoluto (sección 7 del
 * diseño: sin key, la tool ni existe como opción del modelo, el Agent
 * sigue funcionando exactamente igual que hoy). */
export function createSearchProviderFromEnv(): SearchProvider | undefined {
  const apiKey = process.env.TAVILY_API_KEY?.trim();
  if (!apiKey) return undefined;
  return new TavilySearchProvider(apiKey);
}
