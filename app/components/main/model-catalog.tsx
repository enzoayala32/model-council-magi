"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { CatalogModel } from "@/lib/model-catalog";

/**
 * Catálogo de modelos descubierto en vivo desde los endpoints públicos de
 * OpenRouter y NVIDIA, separado en gratis / pago / precio-desconocido.
 *
 * Regla que se ve en la UI: "precio desconocido" es su propia categoría.
 * Un modelo de NVIDIA no se muestra como gratis aunque el tier gratuito
 * exista — el endpoint no publica precio y no lo inventamos.
 */

type CatalogResponse = {
  ok?: boolean;
  fetchedAt?: { openrouter: number; nvidia: number };
  errors?: { openrouter: string | null; nvidia: string | null };
  counts?: { total: number; free: number; paid: number; unknown: number };
  free?: CatalogModel[];
  paid?: CatalogModel[];
  unknown?: CatalogModel[];
};

type Bucket = "free" | "paid" | "unknown";

const BUCKETS: Array<{ key: Bucket; label: string; hint: string }> = [
  { key: "free", label: "Gratis", hint: "Precio 0 verificado en OpenRouter." },
  { key: "paid", label: "De pago", hint: "Precio público > 0. Se estima con la tabla de lib/model-pricing.ts." },
  { key: "unknown", label: "Precio desconocido", hint: "El proveedor no publica precio (NVIDIA). No se muestra como gratis." },
];

function priceLabel(model: CatalogModel): string {
  if (model.inputPerMillionUsd === null || model.outputPerMillionUsd === null) return "—";
  if (model.inputPerMillionUsd === 0 && model.outputPerMillionUsd === 0) return "USD 0";
  return `USD ${model.inputPerMillionUsd} in / ${model.outputPerMillionUsd} out por millón`;
}

export function ModelCatalogPane() {
  // `loading` arranca en true a propósito: así el efecto del montaje no
  // necesita un setState sincrónico para mostrar el spinner. El error solo
  // se escribe cuando la respuesta NO es buena — si salió bien, la ausencia
  // de error ya es el estado correcto y no hay que limpiarlo.
  const [data, setData] = useState<CatalogResponse | null>(null);
  const [bucket, setBucket] = useState<Bucket>("free");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async (refresh: boolean) => {
    try {
      const response = await fetch(`/api/models/catalog${refresh ? "?refresh=1" : ""}`);
      const payload = (await response.json()) as CatalogResponse;
      if (!response.ok) throw new Error(payload.errors?.openrouter ?? "No se pudo cargar el catálogo.");
      setData(payload);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar el catálogo.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Idem: el setState queda dentro del callback asincrónico.
    void (async () => {
      await load(false);
    })();
  }, [load]);

  /** Refresco manual: evento de usuario, no efecto, así que acá sí se
   *  puede mostrar el spinner de inmediato. */
  function refresh() {
    setLoading(true);
    void load(true);
  }

  const models = (data?.[bucket] ?? []).filter((model) => {
    const term = query.trim().toLowerCase();
    if (!term) return true;
    return model.id.toLowerCase().includes(term) || model.label.toLowerCase().includes(term);
  });

  return (
    <div className="settingsPane">
      <div className="settingsHeader">
        <strong>Catálogo de modelos</strong>
        <span>{data?.counts?.total ?? 0} modelos listados</span>
      </div>

      <p className="catalogNote">
        Se descubre en vivo desde los endpoints públicos de OpenRouter y NVIDIA. “Gratis” significa precio 0
        verificado; NVIDIA no publica precio, así que sus modelos quedan en “precio desconocido”.
      </p>

      {data?.errors?.openrouter ? <p className="catalogWarn">OpenRouter: {data.errors.openrouter}</p> : null}
      {data?.errors?.nvidia ? <p className="catalogWarn">NVIDIA: {data.errors.nvidia}</p> : null}
      {error ? <p className="catalogError">{error}</p> : null}

      <div className="catalogControls">
        <div className="catalogBuckets">
          {BUCKETS.map((item) => (
            <button
              key={item.key}
              type="button"
              className={bucket === item.key ? "catalogChip active" : "catalogChip"}
              onClick={() => setBucket(item.key)}
            >
              {item.label} <em>{data?.counts?.[item.key] ?? 0}</em>
            </button>
          ))}
        </div>
        <button type="button" className="iconBtn" onClick={refresh} disabled={loading} title="Refrescar el listado">
          <RefreshCw size={16} />
        </button>
      </div>

      <input
        className="catalogSearch"
        type="search"
        placeholder="Filtrar por id o nombre…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />

      {loading ? <p className="catalogEmpty">Cargando catálogo…</p> : null}

      {!loading && models.length === 0 ? (
        <p className="catalogEmpty">No hay modelos en este grupo con ese filtro.</p>
      ) : null}

      <ul className="catalogList">
        {models.map((model) => (
          <li key={`${model.provider}-${model.id}`}>
            <div className="catalogRowHead">
              <b>{model.id}</b>
              <span className="catalogProvider">{model.provider}</span>
            </div>
            <span className="catalogLabel">{model.label}</span>
            <span className="catalogPrice">{priceLabel(model)}</span>
            {model.contextLength ? (
              <span className="catalogContext">ctx {model.contextLength.toLocaleString("es")}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
