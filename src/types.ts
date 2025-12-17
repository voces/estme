export type Point = { x: number; y: number };

// Anchor metadata - stored per anchor (segment p0)
export type AnchorMeta = {
  leftActive: boolean; // Is c1 of previous segment active (not collapsed)?
  rightActive: boolean; // Is c0 of this segment active?
  mirrorAngle: boolean; // Mirror handle angles (opposite directions)?
  mirrorDistance: boolean; // Mirror handle distances (same length)?
  color: string | null; // Vertex color (null = inherit from path)
};

// Cubic bezier segment: start point + two control points + end point
// For a straight line, control points lie on the line
export type CubicSegment = {
  p0: Point; // start
  c0: Point; // control 1
  c1: Point; // control 2
  p1: Point; // end
};

export type Path = {
  id: string;
  name: string; // User-editable path name
  parentId: string | null; // Group parent (null = root level)
  segments: CubicSegment[];
  anchorMeta: AnchorMeta[]; // Per-anchor metadata, same length as segments
  closed: boolean;
  fill: string;
  visible: boolean;
  locked: boolean;
};

export type Group = {
  id: string;
  name: string;
  parentId: string | null; // Groups can nest
  collapsed: boolean; // UI state for hierarchy expand/collapse
};

export type Tool = "select" | "line";

export type HandleType = "anchor" | "c0" | "c1";

// Reference to a specific point on a path
export type PointReference = {
  pathId: string;
  segmentIndex: number;
  handleType: HandleType;
};

// A snap connection links 2+ points that move together
export type SnapConnection = {
  id: string;
  points: PointReference[];
};

// Default anchor metadata
export function defaultAnchorMeta(): AnchorMeta {
  return { leftActive: true, rightActive: true, mirrorAngle: false, mirrorDistance: false, color: null };
}

// Helper to create a line segment as cubic bezier
export function lineSegment(p0: Point, p1: Point): CubicSegment {
  return {
    p0,
    c0: { x: p0.x + (p1.x - p0.x) / 3, y: p0.y + (p1.y - p0.y) / 3 },
    c1: { x: p0.x + (2 * (p1.x - p0.x)) / 3, y: p0.y + (2 * (p1.y - p0.y)) / 3 },
    p1,
  };
}
