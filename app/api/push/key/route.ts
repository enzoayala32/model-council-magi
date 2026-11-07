import { NextResponse } from "next/server";
import { guardRequest } from "@/lib/auth/guard";
import { requireScope } from "@/lib/auth/authorize";
import { loadOrCreateVapidKeys } from "@/lib/push/vapid";

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

  // Genera el par si todavía no existe. Antes esta ruta solo LEÍA, así que si
  // nadie había enviado un push, el navegador recibía "no configurado" incluso
  // con MAGI_TOTP_KEY puesta: la clave se creaba recién en el primer envío.
  const keys = loadOrCreateVapidKeys();
  if (!keys) {
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
  return NextResponse.json({ ok: true, publicKey: keys.publicKey });
}

export { requireScope };
