import type { CouncilStat } from "./types";

/**
 * HeaderMetadataLeft — top-left technical readout block.
 * First line renders larger (the "code" line), the rest as
 * compact KEY : VALUE rows. All values are derived from real
 * council state by the caller — nothing here is decorative-only.
 */
export function HeaderMetadataLeft({ lines }: { lines: CouncilStat[] }) {
  if (!lines.length) return null;
  const [first, ...rest] = lines;

  return (
    <div className="magiHeaderLeft">
      <div className="magiHeaderLeftRow magiHeaderLeftCode">
        <span className="magiHeaderLeftLabel">{first.label}</span>
        <span className="magiHeaderLeftSep">:</span>
        <span className="magiHeaderLeftValue">{first.value}</span>
      </div>
      {rest.map((line) => (
        <div className="magiHeaderLeftRow" key={line.label}>
          <span className="magiHeaderLeftLabel">{line.label}</span>
          <span className="magiHeaderLeftSep">:</span>
          <span className="magiHeaderLeftValue">{line.value}</span>
        </div>
      ))}
    </div>
  );
}
