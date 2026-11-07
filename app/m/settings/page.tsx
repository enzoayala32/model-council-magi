"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { MobileNav } from "../../components/mobile/mobile-nav";
import { PushSettings } from "../../components/mobile/push-settings";
import { McpApprovals } from "../../components/mobile/mcp-approvals";

/** Fase 3.2 — ajustes y estado del acceso.
 *
 *  Acá se ve si este dispositivo está autenticado y con qué alcance, y se
 *  linkea la doc de acceso. La gestión de dispositivos llega en la Fase 4;
 *  hasta entonces muestra el estado efectivo y nada más. */

type AccessState = {
  remote: boolean;
  credential: "app-token" | "device" | "none";
};

export default function MobileSettings() {
  const [state, setState] = useState<AccessState | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      try {
        // Un GET real: la respuesta del proxy es la fuente de verdad sobre
        // si este dispositivo está autenticado.
        const res = await fetch("/api/threads");
        if (res.status === 403) {
          const data = (await res.json().catch(() => null)) as { reason?: string } | null;
          setState({
            remote: true,
            credential: data?.reason === "remote-access-disabled" ? "none" : "app-token",
          });
          return;
        }
        setState({ remote: false, credential: res.ok ? "app-token" : "none" });
      } catch {
        setError("No se pudo determinar el estado de acceso.");
      }
    })();
  }, []);

  return (
    <div className="mShell">
      <header className="mHeader">
        <div>
          <span className="mBrand">Consenso IA</span>
          <h1>Ajustes</h1>
        </div>
      </header>

      {error ? <p className="mError">{error}</p> : null}

      <section className="mSection">
        <div className="mSectionHead"><h2>Acceso</h2></div>
        {!state ? <p className="mEmpty">Consultando…</p> : null}
        {state?.credential === "none" ? (
          <p className="mNotice">
            Esta sesión no tiene credencial. Pedile el token en la PC o vinculá el dispositivo desde
            “Emparejar teléfono”.
          </p>
        ) : null}
        {state?.credential === "app-token" ? (
          <p className="mNote">Sesión con token de acceso de la app. El emparejamiento por dispositivo llega en la Fase 4.</p>
        ) : null}
        <ul className="mLinks">
          <li><Link href="/">Abrir la app de escritorio</Link></li>
          <li><a href="/docs/ACCESO-REMOTO.md">Cómo acceder de forma remota</a></li>
        </ul>
      </section>

      <PushSettings />

      <McpApprovals compact />

      <section className="mSection">
        <div className="mSectionHead"><h2>Dispositivos</h2></div>
        <p className="mEmpty">La gestión de dispositivos, permisos y actividad se habilita en la Fase 4.</p>
      </section>

      <MobileNav active="settings" />
    </div>
  );
}
