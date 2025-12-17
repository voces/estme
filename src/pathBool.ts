import paper from "paper";
import { AnchorMeta, CubicSegment, Path, Point, defaultAnchorMeta } from "./types.ts";
import { averageColors, getAnchorColor } from "./geometry.ts";

// Initialize Paper.js without canvas (headless mode)
paper.setup(new paper.Size(1000, 1000));

// Distance threshold for matching vertices (in coordinate units)
const VERTEX_MATCH_THRESHOLD = 0.01;

// Original vertex data for preserving colors and metadata
type OriginalVertex = {
  position: Point;
  meta: AnchorMeta;
  color: string; // Pre-computed color (respects inheritance from path.fill)
};

// Find the closest original vertex to a given position
function findClosestVertex(
  position: Point,
  originalVertices: OriginalVertex[]
): OriginalVertex | null {
  let closest: OriginalVertex | null = null;
  let minDist = VERTEX_MATCH_THRESHOLD;

  for (const vertex of originalVertices) {
    const dx = position.x - vertex.position.x;
    const dy = position.y - vertex.position.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < minDist) {
      minDist = dist;
      closest = vertex;
    }
  }

  return closest;
}

// Collect all original vertices from source paths
function collectOriginalVertices(paths: Path[]): OriginalVertex[] {
  const vertices: OriginalVertex[] = [];

  for (const path of paths) {
    for (let i = 0; i < path.segments.length; i++) {
      vertices.push({
        position: { ...path.segments[i].p0 },
        meta: { ...path.anchorMeta[i] },
        color: getAnchorColor(path, i),
      });
    }
  }

  return vertices;
}

// Find colors from edges that a point lies on (may be on multiple paths for intersection points)
// Returns averaged color from all matching edges
function findColorOnEdge(
  position: Point,
  paths: Path[]
): string | null {
  const colorsFound: string[] = [];

  for (const path of paths) {
    for (let i = 0; i < path.segments.length; i++) {
      const seg = path.segments[i];
      // Check if point is approximately on this bezier curve
      const t = findParameterOnBezier(position, seg);
      if (t !== null) {
        // Interpolate color between the two anchors of this segment
        const startColor = getAnchorColor(path, i);
        const nextIdx = path.closed ? (i + 1) % path.segments.length : i + 1;
        const endColor = nextIdx < path.anchorMeta.length
          ? getAnchorColor(path, nextIdx)
          : startColor;
        colorsFound.push(lerpColorSimple(startColor, endColor, t));
      }
    }
  }

  if (colorsFound.length === 0) return null;
  if (colorsFound.length === 1) return colorsFound[0];

  // Average all colors found (intersection point lies on multiple edges)
  return averageColors(colorsFound);
}

// Simple bezier parameter finder - returns t if point is on curve, null otherwise
function findParameterOnBezier(point: Point, seg: CubicSegment): number | null {
  // Sample the bezier at multiple points and find closest
  const samples = 100; // More samples for better accuracy
  let bestT = 0;
  let bestDist = Infinity;

  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const pt = evaluateBezier(seg, t);
    const dx = point.x - pt.x;
    const dy = point.y - pt.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < bestDist) {
      bestDist = dist;
      bestT = t;
    }
  }

  // Refine with binary search around best sample
  let lo = Math.max(0, bestT - 1 / samples);
  let hi = Math.min(1, bestT + 1 / samples);
  for (let iter = 0; iter < 10; iter++) {
    const mid1 = lo + (hi - lo) / 3;
    const mid2 = hi - (hi - lo) / 3;
    const pt1 = evaluateBezier(seg, mid1);
    const pt2 = evaluateBezier(seg, mid2);
    const dist1 = Math.sqrt((point.x - pt1.x) ** 2 + (point.y - pt1.y) ** 2);
    const dist2 = Math.sqrt((point.x - pt2.x) ** 2 + (point.y - pt2.y) ** 2);
    if (dist1 < dist2) {
      hi = mid2;
      if (dist1 < bestDist) {
        bestDist = dist1;
        bestT = mid1;
      }
    } else {
      lo = mid1;
      if (dist2 < bestDist) {
        bestDist = dist2;
        bestT = mid2;
      }
    }
  }

  // Use a more generous threshold for edge detection
  // Boolean operations can create points slightly off the original curves
  const edgeThreshold = 0.5;
  if (bestDist < edgeThreshold) {
    return bestT;
  }
  return null;
}

// Evaluate cubic bezier at parameter t
function evaluateBezier(seg: CubicSegment, t: number): Point {
  const t2 = t * t;
  const t3 = t2 * t;
  const mt = 1 - t;
  const mt2 = mt * mt;
  const mt3 = mt2 * mt;

  return {
    x: mt3 * seg.p0.x + 3 * mt2 * t * seg.c0.x + 3 * mt * t2 * seg.c1.x + t3 * seg.p1.x,
    y: mt3 * seg.p0.y + 3 * mt2 * t * seg.c0.y + 3 * mt * t2 * seg.c1.y + t3 * seg.p1.y,
  };
}

// Simple color interpolation (hex format)
function lerpColorSimple(color1: string, color2: string, t: number): string {
  const c1 = hexToRgb(color1);
  const c2 = hexToRgb(color2);
  if (!c1 || !c2) return color1;

  const r = Math.round(c1.r + (c2.r - c1.r) * t);
  const g = Math.round(c1.g + (c2.g - c1.g) * t);
  const b = Math.round(c1.b + (c2.b - c1.b) * t);

  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16),
      }
    : null;
}

// Convert our Path to a Paper.js Path
function toPaperPath(path: Path): paper.Path {
  const paperPath = new paper.Path();

  if (path.segments.length === 0) return paperPath;

  // Start at the first segment's p0
  paperPath.moveTo(new paper.Point(path.segments[0].p0.x, path.segments[0].p0.y));

  // Add each segment as a cubic bezier curve
  for (const seg of path.segments) {
    paperPath.cubicCurveTo(
      new paper.Point(seg.c0.x, seg.c0.y),
      new paper.Point(seg.c1.x, seg.c1.y),
      new paper.Point(seg.p1.x, seg.p1.y)
    );
  }

  if (path.closed) {
    paperPath.closePath();
  }

  return paperPath;
}

// Convert a Paper.js Path back to our Path format
// Now accepts original vertices and source paths for preserving colors/metadata
function fromPaperPath(
  paperPath: paper.Path,
  fill: string,
  name: string,
  originalVertices?: OriginalVertex[],
  sourcePaths?: Path[]
): Path {
  const segments: CubicSegment[] = [];
  const anchorMeta: AnchorMeta[] = [];
  const curves = paperPath.curves;

  for (const curve of curves) {
    const p0 = { x: curve.point1.x, y: curve.point1.y };

    segments.push({
      p0,
      c0: { x: curve.handle1.x + curve.point1.x, y: curve.handle1.y + curve.point1.y },
      c1: { x: curve.handle2.x + curve.point2.x, y: curve.handle2.y + curve.point2.y },
      p1: { x: curve.point2.x, y: curve.point2.y },
    });

    // Try to preserve metadata from original vertices
    let meta = defaultAnchorMeta();
    let color: string | null = null;

    if (originalVertices) {
      const closestVertex = findClosestVertex(p0, originalVertices);
      if (closestVertex) {
        // Found a matching original vertex - copy its metadata
        meta = { ...closestVertex.meta };
        color = closestVertex.color;
      } else if (sourcePaths) {
        // New vertex (intersection point) - try to find color from edge
        const edgeColor = findColorOnEdge(p0, sourcePaths);
        if (edgeColor) {
          color = edgeColor;
        } else {
          // Fallback: average all vertex colors from source paths
          // This handles cases where edge detection fails
          const allColors = originalVertices.map(v => v.color);
          if (allColors.length > 0) {
            color = averageColors(allColors);
          }
        }
      }
    }

    // Set the color if we found one
    if (color) {
      meta.color = color;
    }

    anchorMeta.push(meta);
  }

  return {
    id: crypto.randomUUID(),
    name,
    parentId: null,
    segments,
    anchorMeta,
    closed: paperPath.closed,
    fill,
    visible: true,
    locked: false,
  };
}

// Check if a Paper.js path is valid (has enough segments and non-trivial area)
function isValidPath(paperPath: paper.Path): boolean {
  // Must have at least 2 curves to form a closed shape
  if (paperPath.curves.length < 2) return false;

  // Must have non-trivial area (filter out degenerate paths)
  const area = paperPath.area;
  if (Math.abs(area) < 0.01) return false;

  return true;
}

// Convert a Paper.js CompoundPath or Path to our Path format(s)
// For exclude operation, we want all valid paths (including those with negative area)
// For other operations, we filter out holes (negative area = counter-clockwise winding)
function fromPaperItem(
  item: paper.PathItem,
  fill: string,
  nameGenerator: () => string,
  includeHoles: boolean = false,
  originalVertices?: OriginalVertex[],
  sourcePaths?: Path[]
): Path[] {
  const filterPath = (child: paper.Path): boolean => {
    if (!isValidPath(child)) return false;
    // For exclude, include all valid paths
    // For other operations, only include paths with positive area (clockwise = outer)
    if (includeHoles) return true;
    return child.area > 0;
  };

  const normalizePath = (child: paper.Path): paper.Path => {
    // If the path has negative area, reverse it to make it clockwise
    if (child.area < 0) {
      child.reverse();
    }
    return child;
  };

  if (item instanceof paper.CompoundPath) {
    // CompoundPath has multiple child paths
    return (item.children as paper.Path[])
      .filter(filterPath)
      .map(child => fromPaperPath(normalizePath(child), fill, nameGenerator(), originalVertices, sourcePaths));
  } else if (item instanceof paper.Path) {
    if (!filterPath(item)) return [];
    return [fromPaperPath(normalizePath(item), fill, nameGenerator(), originalVertices, sourcePaths)];
  }
  return [];
}

export type BooleanOperation = "unite" | "intersect" | "subtract" | "exclude";

// Check if two paths intersect or overlap
function pathsIntersect(paper1: paper.Path, paper2: paper.Path): boolean {
  // Check if paths have any intersection points
  const intersections = paper1.getIntersections(paper2);
  if (intersections.length > 0) return true;

  // Also check if one path contains points of the other (fully overlapping)
  if (paper1.contains(paper2.firstSegment.point)) return true;
  if (paper2.contains(paper1.firstSegment.point)) return true;

  return false;
}

// Check if a boolean operation would produce a meaningful result
export function canBooleanOp(paths: Path[], operation: BooleanOperation): boolean {
  if (paths.length < 2) return false;

  // For unite, we need at least 2 paths that intersect/overlap
  // For other operations, we need exactly 2 paths that intersect
  if (operation !== "unite" && paths.length !== 2) return false;

  // Convert to Paper.js paths
  const paperPaths = paths.map(p => toPaperPath(p));

  let hasIntersection = false;

  // Check if any pair of paths intersect
  for (let i = 0; i < paperPaths.length && !hasIntersection; i++) {
    for (let j = i + 1; j < paperPaths.length && !hasIntersection; j++) {
      if (pathsIntersect(paperPaths[i], paperPaths[j])) {
        hasIntersection = true;
      }
    }
  }

  // Clean up
  paperPaths.forEach(p => p.remove());

  return hasIntersection;
}

// Perform a boolean operation on two paths
export function booleanOperation(
  path1: Path,
  path2: Path,
  operation: BooleanOperation,
  nameGenerator: () => string
): Path[] {
  const paper1 = toPaperPath(path1);
  const paper2 = toPaperPath(path2);

  // Collect original vertices for color/metadata preservation
  const sourcePaths = [path1, path2];
  const originalVertices = collectOriginalVertices(sourcePaths);

  let result: paper.PathItem;

  switch (operation) {
    case "unite":
      result = paper1.unite(paper2);
      break;
    case "intersect":
      result = paper1.intersect(paper2);
      break;
    case "subtract":
      result = paper1.subtract(paper2);
      break;
    case "exclude":
      result = paper1.exclude(paper2);
      break;
  }

  // Use the first path's fill color
  // For exclude, include all paths (the XOR result has multiple disjoint regions)
  const includeHoles = operation === "exclude";
  const paths = fromPaperItem(result, path1.fill, nameGenerator, includeHoles, originalVertices, sourcePaths);

  // Clean up Paper.js objects
  paper1.remove();
  paper2.remove();
  result.remove();

  return paths;
}

// Unite multiple paths into one (or more, if result is compound)
export function uniteMultiplePaths(inputPaths: Path[], nameGenerator: () => string): Path[] {
  if (inputPaths.length === 0) return [];
  if (inputPaths.length === 1) {
    // Single path - copy with preserved metadata
    const p = inputPaths[0];
    return [{
      ...p,
      id: crypto.randomUUID(),
      name: nameGenerator(),
      parentId: null,
      anchorMeta: p.anchorMeta.map(m => ({ ...m })),
      segments: p.segments.map(s => ({ ...s })),
    }];
  }

  // Collect original vertices for color/metadata preservation
  const originalVertices = collectOriginalVertices(inputPaths);

  let result = toPaperPath(inputPaths[0]);
  const fill = inputPaths[0].fill;

  for (let i = 1; i < inputPaths.length; i++) {
    const next = toPaperPath(inputPaths[i]);
    const newResult = result.unite(next);
    result.remove();
    next.remove();
    result = newResult as paper.Path;
  }

  const resultPaths = fromPaperItem(result, fill, nameGenerator, false, originalVertices, inputPaths);
  result.remove();

  return resultPaths;
}
