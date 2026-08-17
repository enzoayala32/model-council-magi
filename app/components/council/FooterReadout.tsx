import type { CouncilStat } from "./types";

/**
 * FooterReadout — bottom stats strip, e.g. "3 MODELS // PHASE 2/3".
 * Purely presentational; all values come from real council state.
 */
export function FooterReadout({ stats }: { stats: CouncilStat[] }) {
  if (!stats.length) return null;

  return (
    <div className="magiReadout">
      {stats.map((stat, index) => (
        <span className="magiReadoutItem" key={stat.label}>
          {index > 0 ? (
            <span className="magiReadoutSep" aria-hidden="true">
              //
            </span>
          ) : null}
          <span className="magiReadoutValue">{stat.value}</span>
          <span className="magiReadoutLabel">{stat.label}</span>
        </span>
      ))}
    </div>
  );
}
