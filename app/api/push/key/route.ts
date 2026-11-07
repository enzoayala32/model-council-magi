import { NextResponse } from "next/server";
import { guardRequest } from "@/lib/auth/guard";
import { requireScope } from "@/lib/auth/authorize";
import { readVapidPublicKey } from "@/lib/push/vapid";

/**
 * Fase 6 — clave pública VAPID.
 *
 * El navegador la necesita para suscribirse:
 * `registration.pushManager.subscribe({ applicationServerKey })`.
 *
 * No es un secreto (la ve cualquier servicio de push), pero la ruta pide
 * credencial igual: quien se suscribe ya tiene una —el operador con su cookie
 * o el dispositivo emparejado con su token—, y así no se filga desde afuera
 * si el server tiene push configurado.
 *
 * Si todavía no se generó el par, responde 503 con el motivo: el teléfono
 * muestra "no disponible" en vez de un error opaco.
 */
export async function GET(request: Request) {
  const denied = guardRequest(request);
  if (denied) return denied;

  const publicKey = readVapidPublicKey();
  if (!publicKey) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Las notificaciones no están configuradas. Definí MAGI_TOTP_KEY (o APP_ACCESS_TOKEN) en .env " +
          "para poder guardar la clave del servidor de push.",
      },
      { status: 503 },
    );
  }
  return NextResponse.json({ ok: true, publicKey });
}

export { requireScope };
