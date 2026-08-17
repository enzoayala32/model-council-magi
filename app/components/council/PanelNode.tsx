import type { CSSProperties } from "react";
import type { CouncilNodeData } from "./types";

export type PanelNodeVariant = "top" | "left" | "right" | "flex" | "radial";

// Display-only translation — `node.state` itself must stay in English since
// it's also used as the CSS class name (.magiNode.thinking, .waiting, etc.)
// that drives the color/animation per state.
const STATE_LABEL_ES: Record<CouncilNodeData["state"], string> = {
  waiting: "en espera",
  thinking: "pensando",
  debating: "debatiendo",
  complete: "completo",
  error: "error",
};

/**
 * PanelNode — a single blue node block in the MAGI layout.
 * The clip-path per variant matches the reference geometry:
 *  - top:    downward-pointing pentagon   (3-node triangle, top-center)
 *  - left:   diagonal chamfer, top-right  (3-node triangle, bottom-left)
 *  - right:  diagonal chamfer, top-left   (3-node triangle, bottom-right)
 *  - radial: point-up shield, rotated per node via `rotationDeg` so the
 *            tip always faces the center — used for 4-5 node star layouts.
 *  - flex:   simple chamfered rectangle, fallback for 1-2 nodes.
 * Fill/glow color reacts to `node.state`, which is real run state passed
 * down from the council (waiting/thinking/debating/complete/error).
 * For the radial variant, the colored/rotated shape is a separate child
 * from the label so the shape can rotate toward the center while the
 * text stays upright and readable.
 */
export function PanelNode({
  node,
  variant,
  style,
  rotationDeg,
}: {
  node: CouncilNodeData;
  variant: PanelNodeVariant;
  style?: CSSProperties;
  rotationDeg?: number;
}) {
  return (
    <div className={`magiNode magiNode-${variant} ${node.state}`} style={style} title={`${node.label} · ${STATE_LABEL_ES[node.state]}`}>
      {variant === "radial" ? (
        <>
          <span className="magiNodeShape" style={{ transform: `rotate(${rotationDeg ?? 0}deg)` }} aria-hidden="true" />
          <span className="magiNodeContent">
            <span className="magiNodeLabel">{node.label}</span>
            <span className="magiNodeState">{STATE_LABEL_ES[node.state]}</span>
          </span>
        </>
      ) : (
        <>
          <span className="magiNodeLabel">{node.label}</span>
          <span className="magiNodeState">{STATE_LABEL_ES[node.state]}</span>
        </>
      )}
    </div>
  );
}
