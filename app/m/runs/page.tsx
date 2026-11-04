"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { RefreshCw } from "lucide-react";
import { MobileNav } from "../../components/mobile/mobile-nav";
import { timeAgo } from "../../components/mobile/mobile-shared";
import { formatDurationMs, describeEvent, type CouncilRunDetail } from "@/lib/council-run-trace";
import { formatUsd } from "@/lib/model-pricing";

/** Fase 3.2 — corridas del consejo desde el teléfono, SOLO LECTURA.
 *  Reusa `lib/council-run-trace.ts`: las mismas funciones que arman el
 *  Markdown de export, sin duplicar la lógica. */

export default function MobileRuns() {
  const [runs, setRuns] = useState<Array<{
    id: string; question: string; status: string; totalTokens: number;
    costUsd: number | null; startedAt: number;
  }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const res = await fetch("/api/council/runs?limit=50");
      if (!res.ok) throw new Error("corridas");
      const data = (await res.json()) as { runs: typeof runs };
      setRuns(data.runs ?? []);
    } catch {
      setError("No se pudieron cargar las corridas.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="mShell">
      <header className="mHeader">
        <div>
          <span className="mBrand">Consenso IA</span>
          <h1>Corridas</h1>
        </div>
        <button type="button" className="mIconBtn" onClick={load} aria-label="Refrescar">
          <RefreshCw size={18} />
        </button>
      </header>

      {error ? <p className="mError">{error}</p> : null}
      {loading ? <p className="mEmpty">Cargando…</p> : null}

      <ul className="mList">
        {runs.map((run) => (
          <li key={run.id}>
            <Link href={`/m/runs/${run.id}`}>
              <div className="mListHead">
                <span className="mPill">{run.status}</span>
                <span className="mTime">{timeAgo(run.startedAt)}</span>
              </div>
              <p className="mListTitle">{run.question || "(sin pregunta)"}</p>
              <p className="mListMeta">{run.totalTokens.toLocaleString("es")} tokens · {formatUsd(run.costUsd)}</p>
            </Link>
          </li>
        ))}
      </ul>

      <MobileNav active="runs" />
    </div>
  );
}

export function RunTimeline({ detail }: { detail: CouncilRunDetail }) {
  return (
    <ol className="mTimeline">
      {detail.events.map((event) => (
        <li key={event.seq}>
          <span className="mTime">+{formatDurationMs(event.at - detail.run.startedAt)}</span>
          <div>
            <b>{describeEvent(event)}</b>
          </div>
        </li>
      ))}
    </ol>
  );
}
