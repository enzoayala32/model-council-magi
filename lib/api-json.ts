import { NextResponse } from "next/server";

export type JsonBodyResult<T> =
  | { ok: true; body: T }
  | { ok: false; response: NextResponse };

/**
 * Fase 1 — parseo de JSON centralizado.
 *
 * Antes, varias rutas hacían `request.json()` sin try/catch: un body
 * inválido escapaba como 500. Acá se devuelve siempre 400 con un JSON
 * claro en español, sin exponer el error interno del parser.
 */
export async function readJsonBody<T = unknown>(request: Request): Promise<JsonBodyResult<T>> {
  try {
    return { ok: true, body: (await request.json()) as T };
  } catch {
    return {
      ok: false,
      response: NextResponse.json(
        { ok: false, error: "El cuerpo de la solicitud no es JSON válido." },
        { status: 400 },
      ),
    };
  }
}
