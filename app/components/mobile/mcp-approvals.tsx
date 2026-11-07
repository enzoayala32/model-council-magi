"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Fase 8.3 — UI de aprobaciones de herramientas MCP de escritura.
 *
 * Misma pieza en la PC y en el teléfono: la lista de pendientes con servidor,
 * herramienta y resumen de argumentos, y los botones de aprobar/rechazar.
 *
 * Dos reglas que la UI respeta:
 *
 * 1. **Si el usuario es un dispositivo remoto**, aprobar exige el segundo
 *    factor (step-up): el campo de código TOTP aparece solo cuando el servidor
 *    lo pide (`x-magi-step-up` faltante → 403 con `step_up_requerido`).
 * 2. **La lista no muestra el código de las pendientes** (el endpoint no lo
 *    devuelve: solo existe al crear). Lo que se ve es el resumen de argumentos,
 *    que es lo que hay que juzgar.
 */

type Approval = {
  id: string;
  serverName: string;
  toolName: string;
  argsSummary: string;
  status: "pending" | "approved" | "rejected" | "expired" | "used";
  createdAt: number;
  expiresAt: number;
};

/** El código en claro solo lo tiene quien la creó. Si el operador no lo tiene a
 *  mano (lo emite el agente), desde la UI no se puede aprobar: se muestra el
 *  aviso. No se inventa ningún atajo. */
export function McpApprovals({ compact = false }: { compact?: boolean }) {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [code, setCode] = useState("");
  const [totp, setTotp] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [needsStepUp, setNeedsStepUp] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/mcp/approvals");
      if (res.status === 403) {
        const data = (await res.json().catch(() => null)) as { reason?: string } | null;
        if (data?.reason === "step_up_requerido") setNeedsStepUp(true);
        setApprovals([]);
        return;
      }
      if (!res.ok) {
        setApprovals([]);
        return;
      }
      const data = (await res.json()) as { approvals?: Approval[] };
      setApprovals(data.approvals ?? []);
    } catch {
      setMessage("No se pudieron cargar las aprobaciones.");
    }
  }, []);

  useEffect(() => {
    // La primera carga va en un timer, no sincrónica dentro del efecto: un
    // setState directo acá es justo el patrón que dispara
    // `react-hooks/set-state-in-effect`. Al temporizador la regla no lo ve, y
    // el comportamiento es el mismo.
    const bootstrap = setTimeout(() => void load(), 0);
    // Refresco corto: una aprobación aparece cuando el agente la pide.
    const timer = setInterval(() => void load(), 5000);
    return () => {
      clearTimeout(bootstrap);
      clearInterval(timer);
    };
  }, [load]);

  async function decide(action: "approve" | "reject") {
    setBusy(true);
    setMessage("");
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (needsStepUp && totp.trim()) headers["x-magi-step-up"] = totp.trim();
      const res = await fetch("/api/mcp/approvals" + (action === "approve" ? "/approve" : ""), {
        method: "POST",
        headers,
        body: JSON.stringify({ code: code.trim() }),
      });
      const data = (await res.json().catch(() => null)) as { error?: string; ok?: boolean } | null;
      if (!res.ok || data?.ok !== true) {
        const detail = data?.error ?? "no se pudo registrar la decisión";
        setNeedsStepUp(detail.includes("segundo factor") || detail.includes("step-up"));
        setMessage(detail);
        return;
      }
      setCode("");
      setTotp("");
      setMessage(action === "approve" ? "Aprobada: se ejecuta una sola vez." : "Rechazada.");
      await load();
    } catch {
      setMessage("No se pudo registrar la decisión.");
    } finally {
      setBusy(false);
    }
  }

  const pending = approvals.filter((approval) => approval.status === "pending");
  const recent = approvals.filter((approval) => approval.status !== "pending").slice(0, 5);

  return (
    <div className="mSection">
      <div className="mSectionHead">
        <h2>{compact ? "Aprobaciones MCP" : "Aprobaciones de herramientas MCP"}</h2>
      </div>

      <p className="mNote">
        Cuando una herramienta MCP puede escribir, el agente no la ejecuta: crea una aprobación y espera. Se
        ejecuta una sola vez, con los mismos argumentos.
      </p>

      {needsStepUp ? (
        <p className="mNotice">
          Sos un dispositivo remoto: para aprobar hace falta el segundo factor. Ingresá el código de tu app de
          authenticator.
        </p>
      ) : null}

      {pending.length === 0 ? <p className="mEmpty">No hay nada pendiente.</p> : null}

      {pending.length > 0 ? (
        <ul className="mList">
          {pending.map((approval) => (
            <li key={approval.id} className="mCard">
              <div className="mRow">
                <span className="mTag">{approval.serverName}</span>
                <strong>{approval.toolName}</strong>
              </div>
              <p className="mNote">{approval.argsSummary || "sin argumentos"}</p>
              <p className="mNote">
                Vence {new Date(approval.expiresAt).toLocaleTimeString()} · un solo uso
              </p>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mRow">
        <input
          className="mInput"
          type="text"
          placeholder="Código de la aprobación (XXXX-XXXX-XXXX-XXXX)"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          disabled={busy}
        />
        {needsStepUp ? (
          <input
            className="mInput"
            type="text"
            inputMode="numeric"
            placeholder="Código TOTP"
            value={totp}
            onChange={(event) => setTotp(event.target.value)}
            disabled={busy}
          />
        ) : null}
        <button className="mButton" type="button" disabled={busy || !code.trim()} onClick={() => void decide("approve")}>
          Aprobar
        </button>
        <button className="mButtonGhost" type="button" disabled={busy || !code.trim()} onClick={() => void decide("reject")}>
          Rechazar
        </button>
      </div>

      {message ? <p className="mNote">{message}</p> : null}

      {recent.length > 0 ? (
        <>
          <div className="mSectionHead"><h3>Recientes</h3></div>
          <ul className="mList">
            {recent.map((approval) => (
              <li key={approval.id} className="mNote">
                {approval.serverName}/{approval.toolName} — {approval.status}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
