"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw, ShieldCheck, ShieldAlert, Smartphone, Trash2, UserCog } from "lucide-react";
import type { DeviceScope } from "@/lib/auth/devices";

/**
 * Fase 4d - pantalla de Dispositivos y Actividad.
 *
 * Todo se restringe a loopback del lado del servidor: estas pantallas son de
 * la PC. Lo que se ve aca es exactamente lo que devuelven las rutas.
 */

type Device = {
  id: string;
  name: string;
  scope: DeviceScope;
  userAgent: string | null;
  createdAt: number;
  lastSeenAt: number | null;
  revokedAt: number | null;
};

type AuditEntry = {
  id: string;
  ts: number;
  deviceId: string | null;
  action: string;
  targetId: string | null;
  result: string;
  detail: string | null;
};

const SCOPES: DeviceScope[] = ["observe", "operate", "approve"];
const SCOPE_LABEL: Record<DeviceScope, string> = {
  observe: "Observador",
  operate: "Operador",
  approve: "Aprobador",
};

function timeAgo(ts: number | null): string {
  if (ts === null) return "nunca";
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 60) return "hace instantes";
  if (seconds < 3600) return `hace ${Math.round(seconds / 60)} min`;
  if (seconds < 86400) return `hace ${Math.round(seconds / 3600)} h`;
  return `hace ${Math.round(seconds / 86400)} d`;
}

export function DevicesPane() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const response = await fetch("/api/devices", { headers: { Host: window.location.host } });
      const data = (await response.json()) as { ok?: boolean; devices?: Device[]; error?: string };
      if (!response.ok || !data.ok) throw new Error(data.error ?? "No se pudieron cargar los dispositivos.");
      setDevices(data.devices ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar los dispositivos.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  async function patch(id: string, body: { name?: string; scope?: string }) {
    setBusy(id);
    setError("");
    try {
      const response = await fetch(`/api/devices/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Host: window.location.host },
        body: JSON.stringify(body),
      });
      const data = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || !data.ok) throw new Error(data.error ?? "No se pudo aplicar el cambio.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo aplicar el cambio.");
    } finally {
      setBusy("");
    }
  }

  async function revoke(id: string) {
    setBusy(id);
    setError("");
    try {
      const response = await fetch(`/api/devices/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { Host: window.location.host },
      });
      const data = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || !data.ok) throw new Error(data.error ?? "No se pudo revocar.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo revocar.");
    } finally {
      setBusy("");
    }
  }

  async function revokeAll() {
    setBusy("all");
    setError("");
    try {
      const response = await fetch("/api/devices/revoke-all", {
        method: "POST",
        headers: { "Content-Type": "application/json", Host: window.location.host },
        body: JSON.stringify({}),
      });
      const data = (await response.json()) as { ok?: boolean; revoked?: number; error?: string };
      if (!response.ok || !data.ok) throw new Error(data.error ?? "No se pudo revocar.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo revocar.");
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="settingsPane">
      <div className="settingsHeader">
        <strong>Dispositivos</strong>
        <button type="button" className="iconBtn" onClick={() => { setLoading(true); void load(); }} disabled={loading} title="Refrescar">
          <RefreshCw size={16} />
        </button>
      </div>

      <p className="catalogNote">
        Cada teléfono emparejado tiene su propio token, revocable, y un nivel de permiso. Los cambios
        acá solo se pueden hacer desde esta PC.
      </p>

      {error ? <p className="catalogError">{error}</p> : null}
      {loading ? <p className="catalogEmpty">Cargando…</p> : null}

      {!loading && devices.length === 0 ? (
        <p className="catalogEmpty">
          Todavía no hay dispositivos emparejados. Usá “Emparejar teléfono” para generar un código.
        </p>
      ) : null}

      <ul className="deviceList">
        {devices.map((device) => (
          <li key={device.id} className={device.revokedAt === null ? "deviceRow" : "deviceRow revoked"}>
            <div className="deviceHead">
              <Smartphone size={16} />
              <b>{device.name}</b>
              {device.revokedAt !== null ? (
                <span className="mPill attention">Revocado</span>
              ) : (
                <span className="mPill">{SCOPE_LABEL[device.scope]}</span>
              )}
            </div>
            <p className="deviceMeta">
              Creado {timeAgo(device.createdAt)} · visto {timeAgo(device.lastSeenAt)}
              {device.userAgent ? ` · ${device.userAgent}` : ""}
            </p>
            {device.revokedAt === null ? (
              <div className="deviceActions">
                <label>
                  Permiso
                  <select
                    value={device.scope}
                    disabled={busy === device.id}
                    onChange={(event) => patch(device.id, { scope: event.target.value })}
                  >
                    {SCOPES.map((scope) => (
                      <option key={scope} value={scope}>{SCOPE_LABEL[scope]}</option>
                    ))}
                  </select>
                </label>
                <input
                  type="text"
                  defaultValue={device.name}
                  disabled={busy === device.id}
                  aria-label="Nombre del dispositivo"
                  onBlur={(event) => {
                    if (event.target.value.trim() && event.target.value !== device.name) {
                      void patch(device.id, { name: event.target.value.trim() });
                    }
                  }}
                />
                <button type="button" className="traceBtn" disabled={busy === device.id} onClick={() => revoke(device.id)}>
                  <Trash2 size={14} /> Revocar
                </button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>

      {devices.some((d) => d.revokedAt === null) ? (
        <button type="button" className="mBtn" disabled={busy === "all"} onClick={revokeAll}>
          <ShieldAlert size={16} /> {busy === "all" ? "Revocando…" : "Revocar todos"}
        </button>
      ) : null}
    </div>
  );
}

export function ActivityPane() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retention, setRetention] = useState(90);

  const load = useCallback(async () => {
    setError("");
    try {
      const response = await fetch("/api/audit?limit=200", { headers: { Host: window.location.host } });
      const data = (await response.json()) as { ok?: boolean; entries?: AuditEntry[]; retentionDays?: number; error?: string };
      if (!response.ok || !data.ok) throw new Error(data.error ?? "No se pudo cargar la actividad.");
      setEntries(data.entries ?? []);
      if (typeof data.retentionDays === "number") setRetention(data.retentionDays);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar la actividad.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  async function prune() {
    setError("");
    try {
      const response = await fetch("/api/audit", { method: "POST", headers: { Host: window.location.host } });
      const data = (await response.json()) as { ok?: boolean; deleted?: number; error?: string };
      if (!response.ok || !data.ok) throw new Error(data.error ?? "No se pudo podar.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo podar.");
    }
  }

  return (
    <div className="settingsPane">
      <div className="settingsHeader">
        <strong>Actividad</strong>
        <button type="button" className="iconBtn" onClick={() => { setLoading(true); void load(); }} disabled={loading} title="Refrescar">
          <RefreshCw size={16} />
        </button>
      </div>

      <p className="catalogNote">
        Emparejamientos, accesos denegados, aprobaciones y cambios de permisos. Nunca se guardan
        tokens, codigos, prompts ni contenido de archivos. Retencion: {retention} dias.
      </p>

      {error ? <p className="catalogError">{error}</p> : null}
      {loading ? <p className="catalogEmpty">Cargando...</p> : null}
      {!loading && entries.length === 0 ? <p className="catalogEmpty">Todavia no hay actividad.</p> : null}

      <ul className="auditList">
        {entries.map((entry) => (
          <li key={entry.id} className={entry.result === "ok" ? "auditRow" : "auditRow denied"}>
            <div className="deviceHead">
              {entry.result === "ok" ? <ShieldCheck size={14} /> : <ShieldAlert size={14} />}
              <b>{entry.action}</b>
              <span className="mTime">{new Date(entry.ts).toLocaleString("es")}</span>
            </div>
            <p className="deviceMeta">
              {entry.deviceId ? `dispositivo ${entry.deviceId.slice(0, 8)}...` : "sin sesion"}
              {entry.targetId ? ` · ${entry.targetId.slice(0, 24)}` : ""}
              {entry.detail ? ` · ${entry.detail}` : ""}
            </p>
          </li>
        ))}
      </ul>

      <button type="button" className="mBtn" onClick={prune} disabled={loading}>
        <UserCog size={16} /> Podar anteriores a {retention} dias
      </button>
    </div>
  );
}
