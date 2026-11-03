"use client";

import { useEffect, useState } from "react";
import { KeyRound, LogOut } from "lucide-react";

/**
 * Fase 1.2 — puerta de acceso por token.
 *
 * Si `APP_ACCESS_TOKEN` está definido, el proxy bloquea toda `/api/*` sin
 * cookie. Sin esta pantalla la app quedaba muerta para un humano (los
 * GET de hilos fallaban y no había forma de.canjes). El emparejamiento
 * por dispositivos (Fase 4) reemplaza este flujo; mientras tanto es lo
 * mínimo que funciona.
 *
 * Detección: al montar se hace un GET real a `/api/threads`. Si responde
 * 403 con `reason: "token"`, se muestra el formulario. No se inventa
 * ningún endpoint de "¿estoy autenticado?": la respuesta del propio
 * proxy es la fuente de verdad.
 */

type ProbeState = "checking" | "ok" | "needs-token";

export function TokenAccessGate() {
  const [state, setState] = useState<ProbeState>("checking");
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/threads");
        if (cancelled) return;
        if (response.status === 403) {
          const data = (await response.json().catch(() => null)) as { reason?: string } | null;
          setState(data?.reason === "token" ? "needs-token" : "ok");
          return;
        }
        setState("ok");
      } catch {
        // Sin server no se puede afirmar nada: se asume OK y la app
        // muestra su propio error de servidor como hasta ahora.
        if (!cancelled) setState("ok");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? "No se pudo validar el token.");
        return;
      }
      // Recarga completa: todas las rutas ya no están bloqueadas y los
      // hooks vuelven a hidratar con la cookie puesta.
      window.location.reload();
    } catch {
      setError("No se pudo conectar con el servidor.");
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    await fetch("/api/auth/token", { method: "DELETE" }).catch(() => undefined);
    window.location.reload();
  }

  if (state === "ok") {
    return (
      <button type="button" className="iconBtn" onClick={logout} title="Cerrar sesión local (borra la cookie del token)">
        <LogOut size={16} />
        <span className="srOnly">Cerrar sesión local</span>
      </button>
    );
  }

  if (state !== "needs-token") return null;

  return (
    <div className="tokenGate" role="dialog" aria-modal="true" aria-label="Acceso con token">
      <form className="tokenGateCard" onSubmit={submit}>
        <h2><KeyRound size={18} /> Acceso restringido</h2>
        <p>
          Este servidor exige un token de acceso. Pegá el valor de <code>APP_ACCESS_TOKEN</code> para
          continuar. Se guarda en una cookie de esta navegador (no se comparte con otros dispositivos).
        </p>
        <label>
          Token de acceso
          <input
            type="password"
            name="token"
            autoComplete="current-password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder=" Pegá el token"
            autoFocus
          />
        </label>
        {error ? <p className="tokenGateError">{error}</p> : null}
        <button type="submit" disabled={busy || token.trim().length === 0}>
          {busy ? "Validando…" : "Entrar"}
        </button>
      </form>
    </div>
  );
}
