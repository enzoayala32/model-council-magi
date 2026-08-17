export interface ConnectorPoint {
  x: number;
  y: number;
}

/**
 * Connectors — red lines running from the center of each node toward
 * the central focal point (50, 50 by default). Drawn as an SVG overlay
 * in percentage-based viewBox units so the diagram stays correct at any
 * container size, with `vector-effect: non-scaling-stroke` (set in CSS)
 * keeping the 4px stroke width visually constant regardless of how much
 * the viewBox is stretched. Fully generic over the number of points, so
 * the same component draws the 3-node triangle and the 4-5 node radial
 * star — as long as `points` use the exact same percentage coordinates
 * the nodes themselves are positioned with, the lines always land
 * precisely on each node instead of stopping short of it.
 */
export function Connectors({ points, center = { x: 50, y: 50 } }: { points: ConnectorPoint[]; center?: ConnectorPoint }) {
  return (
    <svg className="magiConnectors" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      {points.map((point, index) => (
        <line key={index} className="magiConnectorLine" x1={point.x} y1={point.y} x2={center.x} y2={center.y} />
      ))}
    </svg>
  );
}
