import { NextResponse } from "next/server";
import { getModelCatalog, separateByPricing } from "@/lib/model-catalog";
import { guardRequest } from "@/lib/auth/guard";

/**
 * Catálogo automático de modelos: listado real de OpenRouter y NVIDIA,
 * separado en gratis / pago / precio-desconocido.
 *
 * Es un GET sin body: el proxy lo deja pasar con el Host válido (no
 * aplica Origin ni Content-Type, que son reglas de métodos que mutan).
 *
 * `?refresh=1` fuerza la consulta ignorando el caché de
 * `lib/model-catalog.ts` (media hora por default).
 */
export async function GET(request: Request) {
  const denied = guardRequest(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const force = url.searchParams.get("refresh") === "1";

  const catalog = await getModelCatalog({ force });
  const all = [...catalog.openrouter.models, ...catalog.nvidia.models];
  const groups = separateByPricing(all);

  return NextResponse.json({
    ok: true,
    fetchedAt: {
      openrouter: catalog.openrouter.fetchedAt,
      nvidia: catalog.nvidia.fetchedAt,
    },
    errors: {
      openrouter: catalog.openrouter.error,
      nvidia: catalog.nvidia.error,
    },
    counts: {
      total: all.length,
      free: groups.free.length,
      paid: groups.paid.length,
      unknown: groups.unknown.length,
    },
    free: groups.free,
    paid: groups.paid,
    unknown: groups.unknown,
  });
}
