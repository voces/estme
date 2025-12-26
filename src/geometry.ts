import { CubicSegment, Group, HandleType, Path, Point, PointReference } from "./types.ts";

// Anchor point with identity info for snap connection tracking
export type AnchorPointWithInfo = {
  point: Point;
  pathId: string;
  segmentIndex: number;
  handleType: HandleType;
};

// ============================================================================
// Point math
// ============================================================================

export function distance(a: Point, b: Point): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

export function addPoints(a: Point, b: Point): Point {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function subtractPoints(a: Point, b: Point): Point {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function scalePoint(p: Point, s: number): Point {
  return { x: p.x * s, y: p.y * s };
}

export function scalePointAround(p: Point, center: Point, scale: number): Point {
  return {
    x: center.x + (p.x - center.x) * scale,
    y: center.y + (p.y - center.y) * scale,
  };
}

export function rotatePoint(p: Point, center: Point, angle: number): Point {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    x: center.x + (p.x - center.x) * cos - (p.y - center.y) * sin,
    y: center.y + (p.x - center.x) * sin + (p.y - center.y) * cos,
  };
}

// ============================================================================
// Color utilities
// ============================================================================

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) return { r: 255, g: 255, b: 255 };
  return {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16),
  };
}

export function hexToRgbNormalized(hex: string): { r: number; g: number; b: number } {
  const rgb = hexToRgb(hex);
  return { r: rgb.r / 255, g: rgb.g / 255, b: rgb.b / 255 };
}

export function rgbToHex(r: number, g: number, b: number): string {
  return "#" + [r, g, b].map((x) => Math.round(x).toString(16).padStart(2, "0")).join("");
}

export function lerpColor(color1: string, color2: string, t: number): string {
  const c1 = hexToRgb(color1);
  const c2 = hexToRgb(color2);
  return rgbToHex(
    c1.r + (c2.r - c1.r) * t,
    c1.g + (c2.g - c1.g) * t,
    c1.b + (c2.b - c1.b) * t
  );
}

export function lerpRgb(
  c1: { r: number; g: number; b: number },
  c2: { r: number; g: number; b: number },
  t: number
): { r: number; g: number; b: number } {
  return {
    r: c1.r + (c2.r - c1.r) * t,
    g: c1.g + (c2.g - c1.g) * t,
    b: c1.b + (c2.b - c1.b) * t,
  };
}

export function averageColors(colors: string[]): string {
  if (colors.length === 0) return "#ffffff";
  if (colors.length === 1) return colors[0];

  let r = 0, g = 0, b = 0;
  for (const color of colors) {
    const rgb = hexToRgb(color);
    r += rgb.r;
    g += rgb.g;
    b += rgb.b;
  }
  return rgbToHex(r / colors.length, g / colors.length, b / colors.length);
}

// ============================================================================
// Bezier utilities
// ============================================================================

// Sample a cubic bezier at parameter t
export function sampleBezier(p0: Point, c0: Point, c1: Point, p1: Point, t: number): Point {
  const mt = 1 - t;
  const mt2 = mt * mt;
  const mt3 = mt2 * mt;
  const t2 = t * t;
  const t3 = t2 * t;
  return {
    x: mt3 * p0.x + 3 * mt2 * t * c0.x + 3 * mt * t2 * c1.x + t3 * p1.x,
    y: mt3 * p0.y + 3 * mt2 * t * c0.y + 3 * mt * t2 * c1.y + t3 * p1.y,
  };
}

// Check if a segment is a straight line (control points at 1/3 and 2/3)
export function isSegmentStraight(seg: CubicSegment, tolerance = 0.001): boolean {
  const lineVecX = seg.p1.x - seg.p0.x;
  const lineVecY = seg.p1.y - seg.p0.y;
  const lineLen = Math.sqrt(lineVecX * lineVecX + lineVecY * lineVecY);

  if (lineLen < tolerance) return true; // Degenerate segment

  // Check c0 - should be at 1/3
  const c0VecX = seg.c0.x - seg.p0.x;
  const c0VecY = seg.c0.y - seg.p0.y;
  const expectedC0X = lineVecX / 3;
  const expectedC0Y = lineVecY / 3;
  const c0Diff = Math.sqrt((c0VecX - expectedC0X) ** 2 + (c0VecY - expectedC0Y) ** 2);

  // Check c1 - should be at 2/3
  const c1VecX = seg.c1.x - seg.p0.x;
  const c1VecY = seg.c1.y - seg.p0.y;
  const expectedC1X = (2 * lineVecX) / 3;
  const expectedC1Y = (2 * lineVecY) / 3;
  const c1Diff = Math.sqrt((c1VecX - expectedC1X) ** 2 + (c1VecY - expectedC1Y) ** 2);

  return c0Diff < tolerance && c1Diff < tolerance;
}

// Make a segment straight while keeping endpoints
export function makeStraightControlPoints(p0: Point, p1: Point): { c0: Point; c1: Point } {
  return {
    c0: { x: p0.x + (p1.x - p0.x) / 3, y: p0.y + (p1.y - p0.y) / 3 },
    c1: { x: p0.x + (2 * (p1.x - p0.x)) / 3, y: p0.y + (2 * (p1.y - p0.y)) / 3 },
  };
}

// Find the closest point on a bezier segment to a target point
export function closestPointOnBezier(
  target: Point,
  p0: Point,
  c0: Point,
  c1: Point,
  p1: Point,
  samples: number = 50
): { t: number; point: Point; distance: number } {
  let bestT = 0;
  let bestPoint = p0;
  let bestDist = Infinity;

  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const pt = sampleBezier(p0, c0, c1, p1, t);
    const d = distance(target, pt);
    if (d < bestDist) {
      bestDist = d;
      bestT = t;
      bestPoint = pt;
    }
  }

  return { t: bestT, point: bestPoint, distance: bestDist };
}

// De Casteljau's algorithm to split a bezier at t
export function splitBezierAt(
  seg: CubicSegment,
  t: number
): { first: CubicSegment; second: CubicSegment; splitPoint: Point } {
  // First level
  const p01 = {
    x: seg.p0.x + t * (seg.c0.x - seg.p0.x),
    y: seg.p0.y + t * (seg.c0.y - seg.p0.y),
  };
  const p12 = {
    x: seg.c0.x + t * (seg.c1.x - seg.c0.x),
    y: seg.c0.y + t * (seg.c1.y - seg.c0.y),
  };
  const p23 = {
    x: seg.c1.x + t * (seg.p1.x - seg.c1.x),
    y: seg.c1.y + t * (seg.p1.y - seg.c1.y),
  };
  // Second level
  const p012 = {
    x: p01.x + t * (p12.x - p01.x),
    y: p01.y + t * (p12.y - p01.y),
  };
  const p123 = {
    x: p12.x + t * (p23.x - p12.x),
    y: p12.y + t * (p23.y - p12.y),
  };
  // Third level - the split point
  const splitPoint = {
    x: p012.x + t * (p123.x - p012.x),
    y: p012.y + t * (p123.y - p012.y),
  };

  return {
    first: { p0: seg.p0, c0: p01, c1: p012, p1: splitPoint },
    second: { p0: splitPoint, c0: p123, c1: p23, p1: seg.p1 },
    splitPoint,
  };
}

// ============================================================================
// Path utilities
// ============================================================================

// Bounding box type
export type BoundingBox = { minX: number; minY: number; maxX: number; maxY: number };

// Get path bounding box (including control points)
export function getPathBounds(path: Path): BoundingBox {
  if (path.segments.length === 0) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const seg of path.segments) {
    for (const pt of [seg.p0, seg.c0, seg.c1, seg.p1]) {
      minX = Math.min(minX, pt.x);
      minY = Math.min(minY, pt.y);
      maxX = Math.max(maxX, pt.x);
      maxY = Math.max(maxY, pt.y);
    }
  }
  return { minX, minY, maxX, maxY };
}

// Get path center (bounding box center including control points)
export function getPathCenter(path: Path): Point {
  const bounds = getPathBounds(path);
  return { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
}

// Get path bounding box with animation transforms applied (tx, ty, rot, scale)
export function getAnimatedPathBounds(
  path: Path,
  tx: number,
  ty: number,
  rot: number,
  scale: number,
  transformPoint: Point
): BoundingBox {
  if (path.segments.length === 0) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  for (const seg of path.segments) {
    for (const pt of [seg.p0, seg.c0, seg.c1, seg.p1]) {
      // Apply transforms in order: scale, rotate, translate
      // First scale around transform point
      let x = transformPoint.x + (pt.x - transformPoint.x) * scale;
      let y = transformPoint.y + (pt.y - transformPoint.y) * scale;

      // Then rotate around transform point
      if (rot !== 0) {
        const cos = Math.cos(rot);
        const sin = Math.sin(rot);
        const dx = x - transformPoint.x;
        const dy = y - transformPoint.y;
        x = transformPoint.x + dx * cos - dy * sin;
        y = transformPoint.y + dx * sin + dy * cos;
      }

      // Then translate
      x += tx;
      y += ty;

      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  return { minX, minY, maxX, maxY };
}

// Get effective transform point for a path (custom if set, otherwise dynamic center)
export function getPathTransformPoint(path: Path): Point {
  if (path.transformPoint) {
    return path.transformPoint;
  }
  return getPathCenter(path);
}

// Get effective transform point for a group (custom if set, otherwise center of children)
export function getGroupTransformPoint(
  group: Group,
  paths: Path[],
  groups: Group[]
): Point {
  if (group.transformPoint) {
    return group.transformPoint;
  }
  return getGroupCenter(group, paths, groups);
}

// Get center of a group (bounding box center of all descendant paths)
export function getGroupCenter(
  group: Group,
  paths: Path[],
  groups: Group[]
): Point {
  // Find all paths that are descendants
  const descendantPaths: Path[] = [];

  function collectDescendants(parentId: string) {
    // Add direct child paths
    for (const path of paths) {
      if (path.parentId === parentId) {
        descendantPaths.push(path);
      }
    }
    // Recurse into child groups
    for (const g of groups) {
      if (g.parentId === parentId) {
        collectDescendants(g.id);
      }
    }
  }

  collectDescendants(group.id);

  if (descendantPaths.length === 0) {
    return { x: 0, y: 0 };
  }

  // Compute bounding box of all descendant paths
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const path of descendantPaths) {
    for (const seg of path.segments) {
      for (const pt of [seg.p0, seg.c0, seg.c1, seg.p1]) {
        minX = Math.min(minX, pt.x);
        minY = Math.min(minY, pt.y);
        maxX = Math.max(maxX, pt.x);
        maxY = Math.max(maxY, pt.y);
      }
    }
  }
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

// Get all anchor points from a path
export function getPathPoints(path: Path): Point[] {
  const points = path.segments.map((seg) => seg.p0);
  // For open paths, also include the final endpoint
  if (!path.closed && path.segments.length > 0) {
    points.push(path.segments[path.segments.length - 1].p1);
  }
  return points;
}

// Check if a path has any vertex colors
export function hasVertexColors(path: Path): boolean {
  return path.anchorMeta?.some((meta) => meta.color !== null) ?? false;
}

// Get center of multiple paths (bounding box center)
export function getSelectionCenter(paths: Path[], pathIds: string[]): Point {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let hasPoints = false;

  for (const pathId of pathIds) {
    const path = paths.find((p) => p.id === pathId);
    if (path) {
      for (const seg of path.segments) {
        for (const pt of [seg.p0, seg.c0, seg.c1, seg.p1]) {
          minX = Math.min(minX, pt.x);
          minY = Math.min(minY, pt.y);
          maxX = Math.max(maxX, pt.x);
          maxY = Math.max(maxY, pt.y);
          hasPoints = true;
        }
      }
    }
  }

  if (!hasPoints) return { x: 0, y: 0 };
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

// Get transform point of multiple paths
// If any path has a custom transform point, use bounding center of custom transform points
// Otherwise, use bounding center of geometry
export function getSelectionTransformPoint(paths: Path[], pathIds: string[]): Point {
  // Collect paths and check for custom transform points
  const selectedPaths: Path[] = [];
  const customTransformPoints: Point[] = [];

  for (const pathId of pathIds) {
    const path = paths.find((p) => p.id === pathId);
    if (path) {
      selectedPaths.push(path);
      if (path.transformPoint) {
        customTransformPoints.push(path.transformPoint);
      }
    }
  }

  if (selectedPaths.length === 0) return { x: 0, y: 0 };

  // If any path has a custom transform point, use bounding center of those points
  if (customTransformPoints.length > 0) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const pt of customTransformPoints) {
      minX = Math.min(minX, pt.x);
      minY = Math.min(minY, pt.y);
      maxX = Math.max(maxX, pt.x);
      maxY = Math.max(maxY, pt.y);
    }
    return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  }

  // Otherwise, use bounding center of geometry
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const path of selectedPaths) {
    for (const seg of path.segments) {
      for (const pt of [seg.p0, seg.c0, seg.c1, seg.p1]) {
        minX = Math.min(minX, pt.x);
        minY = Math.min(minY, pt.y);
        maxX = Math.max(maxX, pt.x);
        maxY = Math.max(maxY, pt.y);
      }
    }
  }
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

// Get bounding box center of multiple paths (for dynamic transform point of multi-selection)
export function getSelectionBoundingCenter(paths: Path[], pathIds: string[]): Point {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let hasPoints = false;

  for (const pathId of pathIds) {
    const path = paths.find((p) => p.id === pathId);
    if (path) {
      for (const seg of path.segments) {
        for (const pt of [seg.p0, seg.c0, seg.c1, seg.p1]) {
          minX = Math.min(minX, pt.x);
          minY = Math.min(minY, pt.y);
          maxX = Math.max(maxX, pt.x);
          maxY = Math.max(maxY, pt.y);
          hasPoints = true;
        }
      }
    }
  }

  if (!hasPoints) return { x: 0, y: 0 };
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

// Get path angle using PCA (Principal Component Analysis)
// Returns the angle of the major axis in degrees, with "down" determined by the lowest point
export function getPathAngle(path: Path): number {
  if (path.segments.length === 0) return 0;

  // Collect all anchor points
  const points: Point[] = path.segments.map(seg => seg.p0);

  if (points.length < 2) return 0;

  // Compute centroid
  let cx = 0, cy = 0;
  for (const p of points) {
    cx += p.x;
    cy += p.y;
  }
  cx /= points.length;
  cy /= points.length;

  // Compute covariance matrix elements
  // Cov = | cxx  cxy |
  //       | cxy  cyy |
  let cxx = 0, cyy = 0, cxy = 0;
  for (const p of points) {
    const dx = p.x - cx;
    const dy = p.y - cy;
    cxx += dx * dx;
    cyy += dy * dy;
    cxy += dx * dy;
  }

  // Find the angle of the major eigenvector
  // For a 2x2 symmetric matrix, the eigenvector angle is:
  // theta = 0.5 * atan2(2 * cxy, cxx - cyy)
  const majorAxisAngle = 0.5 * Math.atan2(2 * cxy, cxx - cyy);

  // Major axis direction vector
  const majorX = Math.cos(majorAxisAngle);
  const majorY = Math.sin(majorAxisAngle);

  // Minor axis is perpendicular to major axis
  const minorX = -majorY;
  const minorY = majorX;

  // Project all points onto the minor axis to find the "lowest" point
  // (most extreme in the minor axis direction)
  let minProj = Infinity;
  let maxProj = -Infinity;
  for (const p of points) {
    const dx = p.x - cx;
    const dy = p.y - cy;
    const proj = dx * minorX + dy * minorY;
    minProj = Math.min(minProj, proj);
    maxProj = Math.max(maxProj, proj);
  }

  // The "down" direction should be where the most extreme point is
  // If the max projection is larger in magnitude, flip the axis
  // This makes the minor axis point "down" toward the lowest point
  let angle = majorAxisAngle;
  if (Math.abs(maxProj) > Math.abs(minProj)) {
    // The positive minor axis direction has the extreme point, flip by 180°
    angle += Math.PI;
  }

  // Convert to degrees and normalize to -180 to 180
  let degrees = angle * (180 / Math.PI);
  while (degrees > 180) degrees -= 360;
  while (degrees <= -180) degrees += 360;

  return degrees;
}

// Get anchor position handling open paths correctly
export function getAnchorPosition(path: Path, segmentIndex: number): Point {
  // For open paths, the final anchor (segmentIndex === segments.length) is at the last segment's p1
  if (!path.closed && segmentIndex === path.segments.length) {
    return path.segments[path.segments.length - 1].p1;
  }
  return path.segments[segmentIndex].p0;
}

// Get vertex color for an anchor (use vertex color if set, otherwise path fill)
export function getAnchorColor(path: Path, anchorIndex: number): string {
  return path.anchorMeta[anchorIndex]?.color || path.fill;
}

// ============================================================================
// Point finding utilities
// ============================================================================

export function findNearestPoint(target: Point, points: Point[]): Point | null {
  let nearest: Point | null = null;
  let nearestDist = Infinity;
  for (const p of points) {
    const d = distance(target, p);
    if (d < nearestDist) {
      nearest = p;
      nearestDist = d;
    }
  }
  return nearest;
}

export function findNearestPointIndex(target: Point, points: Point[], threshold: number): number {
  let nearestIdx = -1;
  let nearestDist = threshold;
  for (let i = 0; i < points.length; i++) {
    const d = distance(target, points[i]);
    if (d < nearestDist) {
      nearestIdx = i;
      nearestDist = d;
    }
  }
  return nearestIdx;
}

// Get all anchor points from paths (optionally including current path being drawn)
export function getAllAnchorPoints(
  paths: Path[],
  currentPath: Point[] | null,
  excludeLastN: number = 0
): Point[] {
  const points: Point[] = [];
  for (const path of paths) {
    for (const seg of path.segments) {
      points.push(seg.p0);
    }
  }
  if (currentPath) {
    const endIndex = Math.max(0, currentPath.length - excludeLastN);
    for (let i = 0; i < endIndex; i++) {
      points.push(currentPath[i]);
    }
  }
  return points;
}

// Get all anchor points with identity info (for snap connection tracking)
export function getAllAnchorPointsWithInfo(
  paths: Path[],
  excludePathId?: string
): AnchorPointWithInfo[] {
  const points: AnchorPointWithInfo[] = [];
  for (const path of paths) {
    if (path.id === excludePathId) continue;
    for (let i = 0; i < path.segments.length; i++) {
      points.push({
        point: path.segments[i].p0,
        pathId: path.id,
        segmentIndex: i,
        handleType: "anchor",
      });
    }
  }
  return points;
}

// Find nearest point with identity info
export function findNearestPointWithInfo(
  target: Point,
  points: AnchorPointWithInfo[],
  threshold: number = Infinity
): AnchorPointWithInfo | null {
  let nearest: AnchorPointWithInfo | null = null;
  let nearestDist = threshold;
  for (const p of points) {
    const d = distance(target, p.point);
    if (d < nearestDist) {
      nearest = p;
      nearestDist = d;
    }
  }
  return nearest;
}
