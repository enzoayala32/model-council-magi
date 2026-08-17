import "./council-panel.css";
import { Connectors, type ConnectorPoint } from "./Connectors";
import { FooterReadout } from "./FooterReadout";
import { HeaderMetadataLeft } from "./HeaderMetadataLeft";
import { HeaderStatusRight } from "./HeaderStatusRight";
import { PanelNode, type PanelNodeVariant } from "./PanelNode";
import type { CouncilNodeData, CouncilStat, CouncilStatus } from "./types";

interface CouncilPanelProps {
  status: CouncilStatus;
  /** Real runPhase, passed through only to let CSS nudge intensity for the debate phase. */
  phaseId?: string;
  eyebrow: string;
  headline: string;
  detail: string;
  stats?: CouncilStat[];
  nodes?: CouncilNodeData[];
}

/** A node's position around the circle, clockwise from top (0deg = top). */
interface RadialPoint extends ConnectorPoint {
  angleDeg: number;
}

const RADIAL_RADIUS = 36;

/** Evenly distributes `total` points clockwise from the top, `radius` percentage-units from center (50, 50). */
function radialPoint(index: number, total: number, radius = RADIAL_RADIUS): RadialPoint {
  const angleDeg = (index * 360) / total;
  const angleRad = (angleDeg * Math.PI) / 180;
  return {
    angleDeg,
    x: 50 + radius * Math.sin(angleRad),
    y: 50 - radius * Math.cos(angleRad),
  };
}

/**
 * Fixed triangle layout, one entry per node (top, bottom-left, bottom-right).
 * Nodes are positioned with these exact percentages (via inline style) AND
 * the connector lines are drawn to these exact same percentages, so the
 * lines always land precisely on each node — no independent guesswork
 * between "where the node renders" and "where the line thinks it is".
 */
const TRIANGLE_LAYOUT: Array<{ x: number; y: number; variant: PanelNodeVariant }> = [
  { x: 50, y: 20, variant: "top" },
  { x: 24, y: 68, variant: "left" },
  { x: 76, y: 68, variant: "right" },
];
const TRIANGLE_CENTER: ConnectorPoint = { x: 50, y: 48 };

/**
 * CouncilPanel — the central deliberation display.
 * Dark chassis, red grid, model nodes converging on a focal point via
 * red connectors, framed by two header readouts and a footer stats
 * strip. Layout adapts to the real number of active models:
 *  - 3 models  -> literal triangle (NodeTop/Left/Right), matching the
 *                 reference geometry exactly.
 *  - 4-5 models -> radial star, evenly spaced clockwise from the top,
 *                 each node's chamfer rotated to face the center.
 *  - 1-2 models -> flat row of chamfered blocks (no convergence point
 *                 makes sense for that few).
 *  - 6+ models  -> same flat row, since a clean single-ring star loses
 *                 legibility past five nodes.
 * Both the triangle and the radial star position every node with an
 * inline left/top percentage, and feed those same percentages to
 * Connectors — so the lines are guaranteed to reach every node exactly,
 * at any panel width, instead of relying on separately-guessed numbers.
 */
export default function CouncilPanel({ status, phaseId, eyebrow, headline, detail, stats = [], nodes = [] }: CouncilPanelProps) {
  const count = nodes.length;
  const isTriangle = count === 3;
  const isRadial = count === 4 || count === 5;
  const isFlex = count > 0 && !isTriangle && !isRadial;

  const STATUS_LABEL_ES: Record<CouncilStatus, string> = {
    standby: "EN ESPERA",
    active: "ACTIVO",
    processing: "PROCESANDO",
    complete: "COMPLETO",
    error: "ERROR",
  };
  const PHASE_LABEL_ES: Record<string, string> = {
    drafting: "BORRADORES",
    debating: "DEBATE",
    synthesizing: "SÍNTESIS",
    done: "LISTO",
  };
  const metadataLines: CouncilStat[] = [
    { label: "SISTEMA", value: STATUS_LABEL_ES[status] },
    { label: "FASE", value: phaseId ? (PHASE_LABEL_ES[phaseId] ?? phaseId.toUpperCase()) : "INACTIVO" },
    { label: "PRIORIDAD", value: status === "error" ? "ERR" : status === "active" || status === "processing" ? "AAA" : "STD" },
  ];

  return (
    <div className="magiPanel" data-status={status} data-phase={phaseId ?? undefined} role="status" aria-live="polite">
      <div className="magiFrame">
        <div className="magiGrid" aria-hidden="true" />

        <div className="magiHeaderRow">
          <HeaderMetadataLeft lines={metadataLines} />
          <HeaderStatusRight title={headline} lines={[eyebrow, detail]} />
        </div>

        {isTriangle ? (
          <div className="magiTriangle">
            {nodes.map((node, index) => {
              const layout = TRIANGLE_LAYOUT[index];
              return (
                <PanelNode
                  key={node.id}
                  node={node}
                  variant={layout.variant}
                  style={{ left: `${layout.x}%`, top: `${layout.y}%` }}
                />
              );
            })}
            <Connectors points={TRIANGLE_LAYOUT.map(({ x, y }) => ({ x, y }))} center={TRIANGLE_CENTER} />
          </div>
        ) : isRadial ? (
          <div className="magiRadial">
            {nodes.map((node, index) => {
              const point = radialPoint(index, count);
              return (
                <PanelNode
                  key={node.id}
                  node={node}
                  variant="radial"
                  rotationDeg={point.angleDeg + 180}
                  style={{ left: `${point.x}%`, top: `${point.y}%` }}
                />
              );
            })}
            <Connectors points={nodes.map((_, index) => radialPoint(index, count))} />
          </div>
        ) : isFlex ? (
          <div className="magiNodeRowFlex">
            {nodes.map((node) => (
              <PanelNode key={node.id} node={node} variant="flex" />
            ))}
          </div>
        ) : null}

        <FooterReadout stats={stats} />
      </div>
    </div>
  );
}
