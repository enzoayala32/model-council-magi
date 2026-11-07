"use client";

import { useCallback, useEffect, useState } from "react";

/** Fase 6 —notificaciones push en los ajustes del teléfono.
 *
 *  Tres estados que hay que saber distinguir, porque el usuario los confunde:
 *
 *  1. **El navegador no soporta push / no hay service worker**: pasa en
 *     navegadores viejos o en iOS antes de 16.4 (solo si la PWA está
 *     instalada). Se dice claro, no se insiste.
 *  2. **Permiso denegado**: el usuario toca "no" y el navegador ya no vuelve a
 *     preguntar. Hay que explicar que se cambia en los ajustes del sitio.
 *  3. **El server no tiene push configurado**: falta la clave VAPID
 *     (`MAGI_TOTP_KEY`/`APP_ACCESS_TOKEN` en la PC). Se muestra el motivo que
 *     da la ruta, no un error genérico.
 */

const EVENTS = [
  { id: "task.finished", label: "Tarea terminada" },
  { id: "task.failed", label: "Tarea con error" },
  { id: "approval.required", label: "Esperando mi aprobación" },
  { id: "council.finished", label: "Consejo terminado" },
] as const;

type SubscriptionView = {
  id: string;
  endpoint: string;
  userAgent: string | null;
  events: string[];
  enabled: boolean;
  lastError: string | null;
};

type Status =
  | { kind: "loading" }
  | { kind: "unsupported" }
  | { kind: "ready"; key: string }
  | { kind: "unconfigured"; message: string }
  | { kind: "error"; message: string };

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(normalized);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

export function PushSettings() {
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [permission, setPermission] = useState<NotificationPermission>("default");
  const [subscriptions, setSubscriptions] = useState<SubscriptionView[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const loadSubscriptions = useCallback(async () => {
    const res = await fetch("/api/push/subscriptions");
    if (!res.ok) {
      setSubscriptions([]);
      return;
    }
    const data = (await res.json()) as { subscriptions?: SubscriptionView[] };
    setSubscriptions(data.subscriptions ?? []);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
          setStatus({ kind: "unsupported" });
          return;
        }
        setPermission(Notification.permission);
        // El service worker se registra solo para tener el PushManager: no
        // interfiere con el que ya instaló la PWA.
        await navigator.serviceWorker.register("/sw.js");
        const keyRes = await fetch("/api/push/key");
        if (!keyRes.ok) {
          const data = (await keyRes.json().catch(() => null)) as { error?: string } | null;
          setStatus({
            kind: "unconfigured",
            message: data?.error ?? "El servidor no tiene las notificaciones configuradas.",
          });
          return;
        }
        const keyData = (await keyRes.json()) as { publicKey?: string };
        if (!keyData.publicKey) {
          setStatus({ kind: "unconfigured", message: "El servidor no devolvió la clave pública." });
          return;
        }
        setStatus({ kind: "ready", key: keyData.publicKey });
        await loadSubscriptions();
      } catch {
        setStatus({ kind: "error", message: "No se pudo consultar el estado de las notificaciones." });
      }
    })();
  }, [loadSubscriptions]);

  async function subscribe() {
    setBusy(true);
    setMessage("");
    try {
      if (status.kind !== "ready") return;
      const registration = await navigator.serviceWorker.ready;
      const existing = await registration.pushManager.getSubscription();
      const push = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(status.key) as BufferSource,
      });
      const json = push.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
      const res = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          endpoint: existing?.endpoint ?? json.endpoint,
          keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth },
          events: EVENTS.map((event) => event.id),
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setMessage(data?.error ?? "No se pudo activar.");
        return;
      }
      setPermission(Notification.permission);
      await loadSubscriptions();
      setMessage("Notificaciones activadas.");
    } catch {
      setMessage("El navegador rechazó la suscripción (revisá el permiso de notificaciones).");
    } finally {
      setBusy(false);
    }
  }

  async function toggle(subscription: SubscriptionView) {
    setBusy(true);
    setMessage("");
    try {
      await fetch("/api/push/subscriptions", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: subscription.id, enabled: !subscription.enabled }),
      });
      await loadSubscriptions();
    } catch {
      setMessage("No se pudo actualizar la suscripción.");
    } finally {
      setBusy(false);
    }
  }

  async function setEvents(subscription: SubscriptionView, events: string[]) {
    setBusy(true);
    setMessage("");
    try {
      await fetch("/api/push/subscriptions", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: subscription.id, events }),
      });
      await loadSubscriptions();
    } catch {
      setMessage("No se pudieron guardar las preferencias.");
    } finally {
      setBusy(false);
    }
  }

  async function unsubscribe(subscription: SubscriptionView) {
    setBusy(true);
    setMessage("");
    try {
      await fetch("/api/push/unsubscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      });
      await loadSubscriptions();
      setMessage("Suscripción eliminada.");
    } catch {
      setMessage("No se pudo eliminar la suscripción.");
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    setBusy(true);
    setMessage("");
    try {
      const res = await fetch("/api/push/test", { method: "POST" });
      const data = (await res.json().catch(() => null)) as { error?: string; sent?: number } | null;
      setMessage(res.ok ? `Enviada (${data?.sent ?? 0}).` : (data?.error ?? "No se pudo enviar."));
    } catch {
      setMessage("No se pudo enviar la prueba.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mSection">
      <div className="mSectionHead"><h2>Notificaciones</h2></div>

      {status.kind === "loading" ? <p className="mEmpty">Consultando…</p> : null}

      {status.kind === "unsupported" ? (
        <p className="mNote">
          Este navegador no permite notificaciones push. En iPhone hace falta iOS 16.4 o posterior y la app
          instalada en la pantalla de inicio.
        </p>
      ) : null}

      {status.kind === "unconfigured" ? (
        <p className="mNotice">{status.message}</p>
      ) : null}

      {status.kind === "error" ? <p className="mError">{status.message}</p> : null}

      {status.kind === "ready" ? (
        <>
          <p className="mNote">
            Recibís un aviso cuando una tarea termina, falla, o espera tu aprobación. Se agrupan por tarea para
            no llenarte la pantalla.
          </p>
          {permission === "denied" ? (
            <p className="mNotice">
              El navegador tiene las notificaciones bloqueadas para este sitio. Hay que habilitarlas en los
              ajustes del sitio y recargar.
            </p>
          ) : (
            <button className="mButton" type="button" disabled={busy} onClick={() => void subscribe()}>
              {busy ? "Activando…" : subscriptions.length === 0 ? "Activar notificaciones" : "Volver a activar"}
            </button>
          )}

          {subscriptions.length > 0 ? (
            <ul className="mList">
              {subscriptions.map((subscription) => (
                <li key={subscription.id} className="mCard">
                  <div className="mRow">
                    <span className={subscription.enabled ? "mTag mTagOk" : "mTag"}>
                      {subscription.enabled ? "activa" : "pausada"}
                    </span>
                    <span className="mNote">{subscription.userAgent ?? "sin user-agent"}</span>
                  </div>
                  <fieldset className="mFieldset">
                    <legend>Qué me avisa</legend>
                    {EVENTS.map((event) => {
                      const checked = subscription.events.includes(event.id);
                      return (
                        <label key={event.id} className="mCheck">
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={busy}
                            onChange={() => {
                              const next = checked
                                ? subscription.events.filter((id) => id !== event.id)
                                : [...subscription.events, event.id];
                              void setEvents(subscription, next);
                            }}
                          />
                          {event.label}
                        </label>
                      );
                    })}
                  </fieldset>
                  {subscription.lastError ? (
                    <p className="mNotice">Último error del servicio: {subscription.lastError}</p>
                  ) : null}
                  <div className="mRow">
                    <button className="mButtonGhost" type="button" disabled={busy} onClick={() => void toggle(subscription)}>
                      {subscription.enabled ? "Pausar" : "Reanudar"}
                    </button>
                    <button className="mButtonGhost" type="button" disabled={busy} onClick={() => void sendTest()}>
                      Enviar prueba
                    </button>
                    <button className="mButtonDanger" type="button" disabled={busy} onClick={() => void unsubscribe(subscription)}>
                      Eliminar
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}

          {message ? <p className="mNote">{message}</p> : null}
        </>
      ) : null}
    </div>
  );
}
