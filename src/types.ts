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

// Animation transform properties (applied on top of geometry)
export type PathTransform = {
  tx: number; // Translation X
  ty: number; // Translation Y
  rot: number; // Rotation in radians
  scale: number; // Uniform scale
};

export type Path = {
  id: string;
  name: string; // User-editable path name
  parentId: string | null; // Group parent (null = root level)
  segments: CubicSegment[];
  anchorMeta: AnchorMeta[]; // Per-anchor metadata, same length as segments
  closed: boolean;
  fill: string;
  opacity: number; // 0-1 range
  visible: boolean;
  locked: boolean;
  playerMask: boolean; // When true, use accent color instead of vertex colors
  // Animation transform (base pose, keyframes animate relative to this or override)
  transform: PathTransform;
  // Custom transform point (null = use dynamic center)
  transformPoint: Point | null;
  notes?: string;
};

export type Group = {
  id: string;
  name: string;
  parentId: string | null; // Groups can nest
  collapsed: boolean; // UI state for hierarchy expand/collapse
  // Custom transform point (null = use dynamic center of children)
  transformPoint: Point | null;
  notes?: string;
};

// Raster image (not exported in binary, stored in IndexedDB)
export type Raster = {
  id: string;
  name: string;
  parentId: string | null; // For group hierarchy
  imageId: string; // Reference to blob in IndexedDB
  x: number; // Position (center)
  y: number;
  width: number; // Natural image width
  height: number; // Natural image height
  opacity: number; // 0-1
  visible: boolean;
  locked: boolean;
  transform: PathTransform; // translate, rotate, scale
  transformPoint: Point | null; // Custom rotation/scale center
  renderOrder: "front" | "back"; // Render in front of or behind paths
  notes?: string;
};

// Portrait camera viewport
export type Camera = {
  id: string;
  name: string;
  x: number; // Center X in world coordinates
  y: number; // Center Y in world coordinates
  size: number; // Half-width of square viewport
  visible: boolean; // Editor-only visibility (not exported)
  notes?: string;
};

export type Tool = "select" | "line" | "blob";

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

// Default path transform (identity)
export function defaultTransform(): PathTransform {
  return { tx: 0, ty: 0, rot: 0, scale: 1 };
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
