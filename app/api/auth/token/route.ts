import { NextResponse } from "next/server";
import { readJsonBody } from "@/lib/api-json";
import { APP_ACCESS_TOKEN_COOKIE, buildTokenCookie, constantTimeEqual } from "@/lib/api-security";

/**
 * Fase 1.2 — login del token de acceso.
 *
 * Problema que resuelve: si `APP_ACCESS_TOKEN` está definido, toda `/api/*`
 * lo exige y la UI no tenía forma de obtenerlo, así que la app quedaba
 * inutilizada para un humano. Este endpoint canjea el token por una cookie
 * `HttpOnly` para que el navegador lo mande solo.
 *
 * Esta ruta está EXCEPTUADA del chequeo de token (si no, no se podría
 * usar nunca), pero sigue sujeta a todo lo demás: Host, Origin en métodos
 * que mutan y Content-Type JSON. El emparejamiento por dispositivos de la
 * Fase 4 reemplaza este flujo; mientras tanto, es lo mínimo y funciona.
 *
 * No hay rate limiting propio acá: el proxy y el resto de la app no
 * agregan estado por IP (no hay store para eso). El token se define en
 * el servidor y el ataque de fuerza bruta sobre un valor elegido por el
 * operador no es el modelo de amenaza de esta app single-user. Se anota
 * como deuda.
 */

export async function POST(request: Request) {
  const parsed = await readJsonBody<{ token?: string }>(request);
  if (!parsed.ok) return parsed.response;

  const submitted = parsed.body.token?.trim() ?? "";
  const expected = process.env.APP_ACCESS_TOKEN?.trim() ?? "";

  // Sin token configurado no hay nada que canjear: la app funciona sin
  // cookie. Se responde OK para no filtrar si la app usa token o no
  // (un 403 acá delataría la configuración a cualquiera que pregunte).
  if (!expected) {
    return NextResponse.json({ ok: true, tokenRequired: false });
  }

  // Comparación en tiempo constante: nunca revelar por timing cuánto del
  // token coincide.
  if (!constantTimeEqual(submitted, expected)) {
    return NextResponse.json(
      { ok: false, error: "Token de acceso inválido." },
      { status: 403 },
    );
  }

  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const secure = forwardedProto === "https";
  const response = NextResponse.json({ ok: true, tokenRequired: true });
  response.headers.set("Set-Cookie", buildTokenCookie(expected, { secure }));
  return response;
}

/** Borra la cookie (logout local). No requiere token. */
export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  response.headers.set("Set-Cookie", `${APP_ACCESS_TOKEN_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`);
  return response;
}
