"use client";

import { useState } from "react";
import Image from "next/image";
import { QrCode } from "lucide-react";

/**
 * Fase 4a/4d - dialogo de emparejamiento.
 *
 * Genera un codigo de un solo uso (la ruta solo acepta loopback) y muestra
 * el QR con la URL. El codigo va en el FRAGMENTO de la URL (#code=...), no
 * en la query: los fragments no se mandan al servidor ni quedan en logs.
 */

const SCOPES = [
  { value: "observe", label: "Observador — solo lectura" },
  { value: "operate", label: "Operador — crear/cancelar tareas" },
  { value: "approve", label: "Aprobador — aplicar cambios (con segundo factor)" },
] as const;

export function PairingDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [scope, setScope] = useState<string>("observe");
  const [pairing, setPairing] = useState<{ code: string; url: string; qr: string | null } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  if (!open) return null;

  async function generate() {
    setBusy(true);
    setError("");
    setPairing(null);
    try {
      const response = await fetch("/api/pairing", {
        method: "POST",
        headers: { "Content-Type": "application/json", Host: window.location.host },
        body: JSON.stringify({ scope }),
      });
      const data = (await response.json()) as { ok?: boolean; code?: string; url?: string; qr?: string | null; error?: string };
      if (!response.ok || !data.ok) throw new Error(data.error ?? "No se pudo generar el codigo.");
      setPairing({ code: data.code ?? "", url: data.url ?? "", qr: data.qr ?? null });
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo generar el codigo.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="tokenGate" role="dialog" aria-modal="true" aria-label="Emparejar telefono">
      <form className="tokenGateCard" onSubmit={(event) => { event.preventDefault(); void generate(); }}>
        <h2><QrCode size={18} /> Emparejar teléfono</h2>
        <p>
          Se genera un código de un solo uso, válido 5 minutos. Escanealo con la cámara (o abrilo a mano
          en el teléfono) y canjealo en la pantalla de acceso.
        </p>

        <label className="mSelect">
          Permiso del dispositivo
          <select value={scope} onChange={(event) => setScope(event.target.value)}>
            {SCOPES.map((item) => (
              <option key={item.value} value={item.value}>{item.label}</option>
            ))}
          </select>
        </label>

        {error ? <p className="tokenGateError">{error}</p> : null}

        {pairing ? (
          <>
            {/* `unoptimized`: es un data URL de ~3KB, no hay nada que
                optimizar, y forzar el loader solo agregaria latencia. */}
            {pairing.qr ? (
              <Image className="pairingQr" src={pairing.qr} alt="QR de emparejamiento" width={220} height={220} unoptimized />
            ) : (
              <p className="tokenGateError">No se pudo dibujar el QR, pero el código de abajo sirve igual.</p>
            )}
            <p className="pairingCode">{pairing.code}</p>
            <p className="pairingUrl">{pairing.url}</p>
            <p className="tokenGateError" style={{ border: "none", background: "none", color: "var(--muted)" }}>
              El código se muestra una sola vez y caduca a los 5 minutos.
            </p>
          </>
        ) : null}

        <div className="pairingActions">
          <button type="submit" className="primary" disabled={busy}>
            {busy ? "Generando…" : pairing ? "Generar otro" : "Generar código"}
          </button>
          <button type="button" onClick={onClose} disabled={busy}>
            {pairing ? "Listo" : "Cancelar"}
          </button>
        </div>
      </form>
    </div>
  );
}
