"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Download } from "lucide-react";
import { MobileNav } from "../../../components/mobile/mobile-nav";
import { RunTimeline } from "../page";
import { formatDurationMs } from "@/lib/council-run-trace";
import { formatUsd } from "@/lib/model-pricing";
import type { CouncilRunDetail } from "@/lib/council-run-trace";

/** Fase 3.2 — detalle de una corrida desde el teléfono (solo lectura).
 *  Mismas funciones de traza que el export de escritorio. */

export default function MobileRunDetail() {
  const params = useParams<{ id: string }>();
  const [detail, setDetail] = useState<CouncilRunDetail | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/council/runs/${encodeURIComponent(params.id)}`);
        if (!res.ok) throw new Error("corrida");
        setDetail((await res.json()) as CouncilRunDetail);
      } catch {
        setError("No se pudo cargar la corrida.");
      }
    })();
  }, [params.id]);

  return (
    <div className="mShell">
      <header className="mHeader">
        <div>
          <Link className="mBack" href="/m/runs">← Corridas</Link>
          <h1>Corrida</h1>
        </div>
        {detail ? (
          <a
            className="mIconBtn"
            href={`/api/council/runs/${encodeURIComponent(params.id)}/export?format=markdown`}
            download
            aria-label="Exportar Markdown"
          >
            <Download size={18} />
          </a>
        ) : null}
      </header>

      {error ? <p className="mError">{error}</p> : null}

      {detail ? (
        <>
          <div className="mStats">
            <div><span>Estado</span><b>{detail.run.status}</b></div>
            <div><span>Tokens</span><b>{detail.run.totalTokens.toLocaleString("es")}</b></div>
            <div><span>Costo</span><b>{formatUsd(detail.run.costUsd)}</b></div>
            <div><span>Duración</span><b>{formatDurationMs(detail.run.trace?.totalMs ?? null)}</b></div>
          </div>

          <section className="mSection">
            <p className="mPrompt">{detail.run.question || "(sin pregunta)"}</p>
          </section>

          {detail.usage.length ? (
            <section className="mSection">
              <div className="mSectionHead"><h2>Uso por modelo</h2></div>
              <ul className="mList">
                {detail.usage.map((row) => (
                  <li key={`${row.modelId}-${row.phase}`}>
                    <div className="mListHead">
                      <span className="mPill">{row.phase}</span>
                      <span className="mTime">{row.totalTokens.toLocaleString("es")} tok</span>
                    </div>
                    <p className="mListTitle">{row.label || row.modelId}</p>
                    <p className="mListMeta">
                      {formatUsd(row.costUsd)} · latencia {formatDurationMs(row.latencyMs)}
                      {row.fallbacks ? ` · ${row.fallbacks} fallback(s)` : ""}
                      {row.retries ? ` · ${row.retries} reintento(s)` : ""}
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className="mSection">
            <div className="mSectionHead"><h2>Timeline</h2></div>
            <RunTimeline detail={detail} />
          </section>

          {detail.run.synthesis ? (
            <section className="mSection">
              <div className="mSectionHead"><h2>Síntesis</h2></div>
              <p className="mPrompt">{detail.run.synthesis}</p>
            </section>
          ) : null}
        </>
      ) : null}

      <MobileNav active="runs" />
    </div>
  );
}
