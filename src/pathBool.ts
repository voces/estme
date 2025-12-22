import paper from "paper";
import { AnchorMeta, CubicSegment, defaultTransform, Path, Point, defaultAnchorMeta } from "./types.ts";
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
// defaultMirrorAngle: if true, all anchors will have mirrorAngle set (for smoothed blob paths)
function fromPaperPath(
  paperPath: paper.Path,
  fill: string,
  opacity: number,
  name: string,
  originalVertices?: OriginalVertex[],
  sourcePaths?: Path[],
  defaultMirrorAngle: boolean = false
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

    // Set mirrorAngle if requested (for blob paths with smoothed handles)
    if (defaultMirrorAngle) {
      meta.mirrorAngle = true;
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
    opacity,
    visible: true,
    locked: false,
    playerMask: false,
    transform: defaultTransform(),
    transformPoint: null,
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
  opacity: number,
  nameGenerator: () => string,
  includeHoles: boolean = false,
  originalVertices?: OriginalVertex[],
  sourcePaths?: Path[],
  defaultMirrorAngle: boolean = false
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
      .map(child => fromPaperPath(normalizePath(child), fill, opacity, nameGenerator(), originalVertices, sourcePaths, defaultMirrorAngle));
  } else if (item instanceof paper.Path) {
    if (!filterPath(item)) return [];
    return [fromPaperPath(normalizePath(item), fill, opacity, nameGenerator(), originalVertices, sourcePaths, defaultMirrorAngle)];
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

  // Use the first path's fill color and opacity
  // For exclude, include all paths (the XOR result has multiple disjoint regions)
  const includeHoles = operation === "exclude";
  const paths = fromPaperItem(result, path1.fill, path1.opacity, nameGenerator, includeHoles, originalVertices, sourcePaths);

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
  const opacity = inputPaths[0].opacity;

  for (let i = 1; i < inputPaths.length; i++) {
    const next = toPaperPath(inputPaths[i]);
    const newResult = result.unite(next);
    result.remove();
    next.remove();
    result = newResult as paper.Path;
  }

  const resultPaths = fromPaperItem(result, fill, opacity, nameGenerator, false, originalVertices, inputPaths);
  result.remove();

  return resultPaths;
}

// Create a blob path from a series of points with a given radius
// The blob is created by uniting circles along the stroke path

// Create a capsule (stadium shape) between two points with given radius
// Uses 3 points per semicircle with proper bezier handles for accurate circular arcs
function createCapsule(p1: Point, p2: Point, radius: number): paper.Path {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const len = Math.sqrt(dx * dx + dy * dy);

  if (len < 0.0001) {
    // Points are the same, just return a circle
    return new paper.Path.Circle(new paper.Point(p1.x, p1.y), radius);
  }

  // Normalized direction along the capsule
  const dirX = dx / len;
  const dirY = dy / len;

  // Perpendicular direction (normalized)
  const perpX = -dirY;
  const perpY = dirX;

  // Bezier control point factor for approximating a quarter circle
  // k ≈ 0.5523 gives a good circular arc approximation
  const k = 0.5523 * radius;

  const path = new paper.Path();

  // The capsule has 6 anchor points:
  // - 3 for each semicircular end (top, tip, bottom)
  // The straight edges are actual straight lines (no handles needed)

  // First semicircle around p1:
  // A: p1 + perp * radius (top)
  // B: p1 - dir * radius (back tip)
  // C: p1 - perp * radius (bottom)

  // Second semicircle around p2:
  // D: p2 - perp * radius (bottom)
  // E: p2 + dir * radius (front tip)
  // F: p2 + perp * radius (top)

  // A: top of first semicircle - no handleIn (straight from F), handleOut toward B
  path.add(new paper.Segment(
    new paper.Point(p1.x + perpX * radius, p1.y + perpY * radius),
    undefined,  // handleIn: straight line from F
    new paper.Point(-dirX * k, -dirY * k)  // handleOut: curve toward B
  ));

  // B: back tip of first semicircle
  path.add(new paper.Segment(
    new paper.Point(p1.x - dirX * radius, p1.y - dirY * radius),
    new paper.Point(perpX * k, perpY * k),   // handleIn: from A
    new paper.Point(-perpX * k, -perpY * k)  // handleOut: toward C
  ));

  // C: bottom of first semicircle - handleIn from B, no handleOut (straight to D)
  path.add(new paper.Segment(
    new paper.Point(p1.x - perpX * radius, p1.y - perpY * radius),
    new paper.Point(-dirX * k, -dirY * k),  // handleIn: curve from B
    undefined  // handleOut: straight line to D
  ));

  // D: bottom of second semicircle - no handleIn (straight from C), handleOut toward E
  path.add(new paper.Segment(
    new paper.Point(p2.x - perpX * radius, p2.y - perpY * radius),
    undefined,  // handleIn: straight line from C
    new paper.Point(dirX * k, dirY * k)  // handleOut: curve toward E
  ));

  // E: front tip of second semicircle
  path.add(new paper.Segment(
    new paper.Point(p2.x + dirX * radius, p2.y + dirY * radius),
    new paper.Point(-perpX * k, -perpY * k),  // handleIn: from D
    new paper.Point(perpX * k, perpY * k)     // handleOut: toward F
  ));

  // F: top of second semicircle - handleIn from E, no handleOut (straight to A)
  path.add(new paper.Segment(
    new paper.Point(p2.x + perpX * radius, p2.y + perpY * radius),
    new paper.Point(dirX * k, dirY * k),  // handleIn: curve from E
    undefined  // handleOut: straight line to A
  ));

  path.closed = true;
  return path;
}

// =============================================================================
// Curvature-aware path simplification (replaces Paper.js simplify)
// =============================================================================

// Calculate curvature at a point given three consecutive points
function calculateCurvature(p0: Point, p1: Point, p2: Point): number {
  // Using Menger curvature: 4 * area / (|p0-p1| * |p1-p2| * |p0-p2|)
  const d01 = Math.sqrt((p1.x - p0.x) ** 2 + (p1.y - p0.y) ** 2);
  const d12 = Math.sqrt((p2.x - p1.x) ** 2 + (p2.y - p1.y) ** 2);
  const d02 = Math.sqrt((p2.x - p0.x) ** 2 + (p2.y - p0.y) ** 2);

  if (d01 < 0.0001 || d12 < 0.0001 || d02 < 0.0001) return 0;

  // Signed area of triangle * 2
  const area2 = (p1.x - p0.x) * (p2.y - p0.y) - (p2.x - p0.x) * (p1.y - p0.y);

  return Math.abs(2 * area2) / (d01 * d12 * d02);
}

// Sample a paper.js path to points with curvature info
type SampledPoint = { point: Point; curvature: number; offset: number };

function samplePathWithCurvature(path: paper.Path, samplesPerUnit: number = 4): SampledPoint[] {
  const samples: SampledPoint[] = [];
  const length = path.length;
  if (length === 0) return samples;

  const numSamples = Math.max(20, Math.floor(length * samplesPerUnit));

  // First pass: sample points
  const rawPoints: { point: Point; offset: number }[] = [];
  for (let i = 0; i <= numSamples; i++) {
    const offset = (i / numSamples) * length;
    const pt = path.getPointAt(offset);
    if (pt) {
      rawPoints.push({ point: { x: pt.x, y: pt.y }, offset });
    }
  }

  // Second pass: calculate curvature at each point
  for (let i = 0; i < rawPoints.length; i++) {
    let curvature = 0;
    if (i > 0 && i < rawPoints.length - 1) {
      curvature = calculateCurvature(
        rawPoints[i - 1].point,
        rawPoints[i].point,
        rawPoints[i + 1].point
      );
    } else if (path.closed) {
      // Handle closed path wrap-around
      const prev = i === 0 ? rawPoints[rawPoints.length - 2] : rawPoints[i - 1];
      const next = i === rawPoints.length - 1 ? rawPoints[1] : rawPoints[i + 1];
      curvature = calculateCurvature(prev.point, rawPoints[i].point, next.point);
    }
    samples.push({
      point: rawPoints[i].point,
      curvature,
      offset: rawPoints[i].offset
    });
  }

  return samples;
}

// Find high-curvature regions (endcaps, tight turns)
function findHighCurvatureRegions(
  samples: SampledPoint[],
  curvatureThreshold: number
): { start: number; end: number }[] {
  const regions: { start: number; end: number }[] = [];
  let inRegion = false;
  let regionStart = 0;

  for (let i = 0; i < samples.length; i++) {
    const isHigh = samples[i].curvature > curvatureThreshold;

    if (isHigh && !inRegion) {
      inRegion = true;
      regionStart = i;
    } else if (!isHigh && inRegion) {
      inRegion = false;
      regions.push({ start: regionStart, end: i - 1 });
    }
  }

  // Close final region if still open
  if (inRegion) {
    regions.push({ start: regionStart, end: samples.length - 1 });
  }

  return regions;
}

// Perpendicular distance from point to line segment
function perpendicularDistance(
  point: Point,
  lineStart: Point,
  lineEnd: Point
): number {
  const dx = lineEnd.x - lineStart.x;
  const dy = lineEnd.y - lineStart.y;
  const lenSq = dx * dx + dy * dy;

  if (lenSq === 0) {
    return Math.sqrt((point.x - lineStart.x) ** 2 + (point.y - lineStart.y) ** 2);
  }

  const t = Math.max(0, Math.min(1,
    ((point.x - lineStart.x) * dx + (point.y - lineStart.y) * dy) / lenSq
  ));

  const projX = lineStart.x + t * dx;
  const projY = lineStart.y + t * dy;

  return Math.sqrt((point.x - projX) ** 2 + (point.y - projY) ** 2);
}

// Ramer-Douglas-Peucker algorithm for polyline simplification
function rdpSimplify(points: Point[], epsilon: number): Point[] {
  if (points.length <= 2) return points;

  let maxDist = 0;
  let maxIndex = 0;
  const first = points[0];
  const last = points[points.length - 1];

  for (let i = 1; i < points.length - 1; i++) {
    const dist = perpendicularDistance(points[i], first, last);
    if (dist > maxDist) {
      maxDist = dist;
      maxIndex = i;
    }
  }

  if (maxDist > epsilon) {
    const left = rdpSimplify(points.slice(0, maxIndex + 1), epsilon);
    const right = rdpSimplify(points.slice(maxIndex), epsilon);
    return [...left.slice(0, -1), ...right];
  } else {
    return [first, last];
  }
}

// Fit a cubic bezier to a set of points, returns control points
// Uses least-squares fitting for the control points given fixed endpoints
function fitCubicBezier(points: Point[]): { c0: Point; c1: Point } | null {
  if (points.length < 2) return null;

  const p0 = points[0];
  const p3 = points[points.length - 1];

  if (points.length === 2) {
    // Just a line - control points at 1/3 and 2/3
    return {
      c0: { x: p0.x + (p3.x - p0.x) / 3, y: p0.y + (p3.y - p0.y) / 3 },
      c1: { x: p0.x + 2 * (p3.x - p0.x) / 3, y: p0.y + 2 * (p3.y - p0.y) / 3 }
    };
  }

  // Parameterize points by chord length
  const chordLengths: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    chordLengths.push(chordLengths[i - 1] + Math.sqrt(dx * dx + dy * dy));
  }
  const totalLength = chordLengths[chordLengths.length - 1];
  if (totalLength === 0) return null;

  const t: number[] = chordLengths.map(l => l / totalLength);

  // Compute A matrix and b vector for least squares: A * [c0, c1]^T = b
  // B(t) = (1-t)^3*P0 + 3*(1-t)^2*t*C0 + 3*(1-t)*t^2*C1 + t^3*P3
  // We want to minimize sum of |B(ti) - Pi|^2

  let a00 = 0, a01 = 0, a11 = 0;
  let bx0 = 0, by0 = 0, bx1 = 0, by1 = 0;

  for (let i = 1; i < points.length - 1; i++) {
    const ti = t[i];
    const ti2 = ti * ti;
    const ti3 = ti2 * ti;
    const mt = 1 - ti;
    const mt2 = mt * mt;
    const mt3 = mt2 * mt;

    // Basis functions for C0 and C1
    const b1 = 3 * mt2 * ti;  // coefficient for C0
    const b2 = 3 * mt * ti2;  // coefficient for C1

    a00 += b1 * b1;
    a01 += b1 * b2;
    a11 += b2 * b2;

    // Target minus contribution from P0 and P3
    const targetX = points[i].x - mt3 * p0.x - ti3 * p3.x;
    const targetY = points[i].y - mt3 * p0.y - ti3 * p3.y;

    bx0 += b1 * targetX;
    by0 += b1 * targetY;
    bx1 += b2 * targetX;
    by1 += b2 * targetY;
  }

  // Solve 2x2 system
  const det = a00 * a11 - a01 * a01;
  if (Math.abs(det) < 1e-10) {
    // Degenerate - fall back to simple 1/3, 2/3 rule
    return {
      c0: { x: p0.x + (p3.x - p0.x) / 3, y: p0.y + (p3.y - p0.y) / 3 },
      c1: { x: p0.x + 2 * (p3.x - p0.x) / 3, y: p0.y + 2 * (p3.y - p0.y) / 3 }
    };
  }

  const c0x = (a11 * bx0 - a01 * bx1) / det;
  const c0y = (a11 * by0 - a01 * by1) / det;
  const c1x = (a00 * bx1 - a01 * bx0) / det;
  const c1y = (a00 * by1 - a01 * by0) / det;

  return {
    c0: { x: c0x, y: c0y },
    c1: { x: c1x, y: c1y }
  };
}

// Calculate max error between a bezier and sample points
function bezierFitError(
  p0: Point, c0: Point, c1: Point, p3: Point,
  points: Point[], tValues: number[]
): number {
  let maxError = 0;

  for (let i = 0; i < points.length; i++) {
    const t = tValues[i];
    const mt = 1 - t;

    // Evaluate bezier at t
    const bx = mt * mt * mt * p0.x + 3 * mt * mt * t * c0.x +
               3 * mt * t * t * c1.x + t * t * t * p3.x;
    const by = mt * mt * mt * p0.y + 3 * mt * mt * t * c0.y +
               3 * mt * t * t * c1.y + t * t * t * p3.y;

    const dx = bx - points[i].x;
    const dy = by - points[i].y;
    const error = Math.sqrt(dx * dx + dy * dy);

    if (error > maxError) maxError = error;
  }

  return maxError;
}

// Recursively fit bezier curves to points with error threshold
function fitBeziersRecursive(
  points: Point[],
  tolerance: number,
  results: { anchor: Point; handleIn: Point | null; handleOut: Point | null }[],
  isFirst: boolean
): void {
  if (points.length < 2) return;

  const p0 = points[0];
  const p3 = points[points.length - 1];

  // For very short segments (2-3 points), use 1/3 rule for handle lengths
  if (points.length <= 3) {
    // Always use ~1/3 segment length for handles to ensure smooth curves
    const handleOut = { x: (p3.x - p0.x) / 3, y: (p3.y - p0.y) / 3 };
    const handleIn = { x: (p0.x - p3.x) / 3, y: (p0.y - p3.y) / 3 };

    if (isFirst) {
      results.push({
        anchor: p0,
        handleIn: null,
        handleOut: handleOut
      });
    } else if (results.length > 0) {
      const lastResult = results[results.length - 1];
      lastResult.handleOut = handleOut;
    }

    results.push({
      anchor: p3,
      handleIn: handleIn,
      handleOut: null
    });
    return;
  }

  // Try fitting single bezier
  const fit = fitCubicBezier(points);
  if (!fit) return;

  // Calculate t values for error checking
  const chordLengths: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    chordLengths.push(chordLengths[i - 1] + Math.sqrt(dx * dx + dy * dy));
  }
  const totalLength = chordLengths[chordLengths.length - 1] || 1;
  const tValues = chordLengths.map(l => l / totalLength);

  const error = bezierFitError(p0, fit.c0, fit.c1, p3, points, tValues);

  if (error <= tolerance) {
    // Good fit - add this bezier segment
    if (isFirst) {
      results.push({
        anchor: p0,
        handleIn: null,
        handleOut: { x: fit.c0.x - p0.x, y: fit.c0.y - p0.y }
      });
    } else if (results.length > 0) {
      // Update previous point's handleOut
      const lastResult = results[results.length - 1];
      lastResult.handleOut = { x: fit.c0.x - p0.x, y: fit.c0.y - p0.y };
    }

    results.push({
      anchor: p3,
      handleIn: { x: fit.c1.x - p3.x, y: fit.c1.y - p3.y },
      handleOut: null
    });
  } else {
    // Split at point of max error and recurse
    let maxErrorIdx = 0;
    let maxErr = 0;
    for (let i = 1; i < points.length - 1; i++) {
      const t = tValues[i];
      const mt = 1 - t;
      const bx = mt * mt * mt * p0.x + 3 * mt * mt * t * fit.c0.x +
                 3 * mt * t * t * fit.c1.x + t * t * t * p3.x;
      const by = mt * mt * mt * p0.y + 3 * mt * mt * t * fit.c0.y +
                 3 * mt * t * t * fit.c1.y + t * t * t * p3.y;
      const dx = bx - points[i].x;
      const dy = by - points[i].y;
      const err = dx * dx + dy * dy;
      if (err > maxErr) {
        maxErr = err;
        maxErrorIdx = i;
      }
    }

    // Ensure we're splitting somewhere reasonable (not at ends)
    if (maxErrorIdx <= 1) maxErrorIdx = Math.max(2, Math.floor(points.length / 3));
    if (maxErrorIdx >= points.length - 2) maxErrorIdx = Math.min(points.length - 3, Math.floor(2 * points.length / 3));

    // Prevent infinite recursion
    if (maxErrorIdx <= 1 || maxErrorIdx >= points.length - 2) {
      // Force accept the fit even if error is high
      if (isFirst) {
        results.push({
          anchor: p0,
          handleIn: null,
          handleOut: { x: fit.c0.x - p0.x, y: fit.c0.y - p0.y }
        });
      } else if (results.length > 0) {
        const lastResult = results[results.length - 1];
        lastResult.handleOut = { x: fit.c0.x - p0.x, y: fit.c0.y - p0.y };
      }
      results.push({
        anchor: p3,
        handleIn: { x: fit.c1.x - p3.x, y: fit.c1.y - p3.y },
        handleOut: null
      });
      return;
    }

    const left = points.slice(0, maxErrorIdx + 1);
    const right = points.slice(maxErrorIdx);

    fitBeziersRecursive(left, tolerance, results, isFirst);
    fitBeziersRecursive(right, tolerance, results, false);
  }
}

// Simplify a single paper.js path using bezier fitting
function simplifyPath(path: paper.Path, tolerance: number): paper.Path {
  const length = path.length;
  if (length === 0) return path.clone() as paper.Path;

  // Sample the path densely
  const numSamples = Math.max(30, Math.floor(length * 8));
  const points: Point[] = [];

  for (let i = 0; i <= numSamples; i++) {
    const offset = (i / numSamples) * length;
    const pt = path.getPointAt(offset);
    if (pt) {
      points.push({ x: pt.x, y: pt.y });
    }
  }

  if (points.length < 3) return path.clone() as paper.Path;

  // For closed paths, we need to handle the seam carefully
  // Duplicate some points to avoid seam artifacts
  let workingPoints = points;
  if (path.closed && points.length > 5) {
    // Remove the duplicate end point and work with circular data
    if (Math.abs(points[0].x - points[points.length - 1].x) < 0.001 &&
        Math.abs(points[0].y - points[points.length - 1].y) < 0.001) {
      workingPoints = points.slice(0, -1);
    }
  }

  // Fit beziers to the points
  const results: { anchor: Point; handleIn: Point | null; handleOut: Point | null }[] = [];
  fitBeziersRecursive(workingPoints, tolerance, results, true);

  // Smooth handles to be 180° aligned when they're roughly aligned already
  // Skip smoothing for corners (L-shapes, cleavages) where handles are significantly different
  const SMOOTH_THRESHOLD = 0.5; // cos(60°) - only smooth if handles are within ~60° of aligned
  for (const r of results) {
    if (r.handleIn && r.handleOut) {
      // Get handle lengths
      const inLen = Math.sqrt(r.handleIn.x * r.handleIn.x + r.handleIn.y * r.handleIn.y);
      const outLen = Math.sqrt(r.handleOut.x * r.handleOut.x + r.handleOut.y * r.handleOut.y);

      if (inLen > 0.001 && outLen > 0.001) {
        // Compute tangent directions
        // handleIn points towards anchor, handleOut points away from anchor
        // For alignment check, we compare outDir with -inDir (both pointing "forward")
        const inDir = { x: -r.handleIn.x / inLen, y: -r.handleIn.y / inLen };
        const outDir = { x: r.handleOut.x / outLen, y: r.handleOut.y / outLen };

        // Check alignment via dot product (1 = perfectly aligned, 0 = perpendicular, -1 = opposite)
        const dot = inDir.x * outDir.x + inDir.y * outDir.y;

        // Only smooth if handles are roughly aligned (not a corner)
        if (dot > SMOOTH_THRESHOLD) {
          // Average the directions
          let avgX = (inDir.x + outDir.x) / 2;
          let avgY = (inDir.y + outDir.y) / 2;
          const avgLen = Math.sqrt(avgX * avgX + avgY * avgY);

          if (avgLen > 0.001) {
            // Normalize the average direction
            avgX /= avgLen;
            avgY /= avgLen;

            // Set handles to point along this direction with original lengths
            r.handleIn = { x: -avgX * inLen, y: -avgY * inLen };
            r.handleOut = { x: avgX * outLen, y: avgY * outLen };
          }
        }
      }
    }
  }

  // Handle closed path - connect end to start
  if (path.closed && results.length > 1) {
    const first = results[0];
    const last = results[results.length - 1];

    // Check if last point is close to first
    if (Math.abs(first.anchor.x - last.anchor.x) < tolerance &&
        Math.abs(first.anchor.y - last.anchor.y) < tolerance) {
      // Transfer last's handleIn to first
      first.handleIn = last.handleIn;
      results.pop();

      // Smooth the first point's handles now that it has both (if roughly aligned)
      if (first.handleIn && first.handleOut) {
        const inLen = Math.sqrt(first.handleIn.x * first.handleIn.x + first.handleIn.y * first.handleIn.y);
        const outLen = Math.sqrt(first.handleOut.x * first.handleOut.x + first.handleOut.y * first.handleOut.y);

        if (inLen > 0.001 && outLen > 0.001) {
          const inDir = { x: -first.handleIn.x / inLen, y: -first.handleIn.y / inLen };
          const outDir = { x: first.handleOut.x / outLen, y: first.handleOut.y / outLen };

          const dot = inDir.x * outDir.x + inDir.y * outDir.y;

          if (dot > SMOOTH_THRESHOLD) {
            let avgX = (inDir.x + outDir.x) / 2;
            let avgY = (inDir.y + outDir.y) / 2;
            const avgLen = Math.sqrt(avgX * avgX + avgY * avgY);

            if (avgLen > 0.001) {
              avgX /= avgLen;
              avgY /= avgLen;
              first.handleIn = { x: -avgX * inLen, y: -avgY * inLen };
              first.handleOut = { x: avgX * outLen, y: avgY * outLen };
            }
          }
        }
      }
    }
  }

  // Build the paper.js path
  const newPath = new paper.Path();
  newPath.closed = path.closed;

  for (const r of results) {
    const seg = new paper.Segment(
      new paper.Point(r.anchor.x, r.anchor.y),
      r.handleIn ? new paper.Point(r.handleIn.x, r.handleIn.y) : undefined,
      r.handleOut ? new paper.Point(r.handleOut.x, r.handleOut.y) : undefined
    );
    newPath.add(seg);
  }

  return newPath;
}

// Simplify all paths in a PathItem
function simplifyPathItem(item: paper.PathItem, tolerance: number): void {
  if (item instanceof paper.Path) {
    const simplified = simplifyPath(item, tolerance);
    item.removeSegments();
    for (const seg of simplified.segments) {
      item.add(seg.clone());
    }
    simplified.remove();
  } else if (item instanceof paper.CompoundPath) {
    for (const child of item.children) {
      if (child instanceof paper.Path) {
        const simplified = simplifyPath(child as paper.Path, tolerance);
        (child as paper.Path).removeSegments();
        for (const seg of simplified.segments) {
          (child as paper.Path).add(seg.clone());
        }
        simplified.remove();
      }
    }
  }
}

// Create a blob shape from points using capsules between consecutive points
function createBlobShape(points: Point[], radius: number, simplifyTolerance: number): paper.PathItem | null {
  if (points.length === 0) return null;

  if (points.length === 1) {
    // Single point, just a circle
    return new paper.Path.Circle(new paper.Point(points[0].x, points[0].y), radius);
  }

  // Create capsules between consecutive points and unite them
  let result: paper.PathItem | null = null;

  for (let i = 0; i < points.length - 1; i++) {
    const capsule = createCapsule(points[i], points[i + 1], radius);

    if (result === null) {
      result = capsule;
    } else {
      const newResult: paper.PathItem = result.unite(capsule);
      result.remove();
      capsule.remove();
      result = newResult;
    }
  }

  // Use Paper.js simplify to reduce anchor count
  // Tolerance is proportional to radius for scale-independent simplification
  if (result && simplifyTolerance > 0) {
    simplifyPathItem(result, radius * simplifyTolerance);
  }

  return result;
}

// Get outline points for blob preview (returns array of point arrays for each path/hole)
export function getBlobPreviewOutline(points: Point[], radius: number): Point[][] {
  if (points.length === 0) return [];

  // Create shape without simplification for preview
  const result = createBlobShape(points, radius, 0);
  if (!result) return [];

  const outlines: Point[][] = [];
  const samplesPerSegment = 8;

  const samplePath = (path: paper.Path) => {
    const outline: Point[] = [];
    for (const segment of path.segments) {
      // Sample the curve from this segment to the next
      const curve = segment.curve;
      if (curve) {
        for (let i = 0; i < samplesPerSegment; i++) {
          const t = i / samplesPerSegment;
          const pt = curve.getPointAtTime(t);
          outline.push({ x: pt.x, y: pt.y });
        }
      }
    }
    return outline;
  };

  if (result instanceof paper.Path) {
    outlines.push(samplePath(result));
  } else if (result instanceof paper.CompoundPath) {
    for (const child of result.children) {
      if (child instanceof paper.Path) {
        outlines.push(samplePath(child));
      }
    }
  }

  result.remove();
  return outlines;
}

export function createBlobPath(
  points: Point[],
  radius: number,
  simplifyTolerance: number,
  fill: string,
  opacity: number,
  nameGenerator: () => string
): Path[] {
  if (points.length === 0) return [];

  const result = createBlobShape(points, radius, simplifyTolerance);
  if (!result) return [];

  // Pass defaultMirrorAngle: true since blob paths have smoothed handles
  const resultPaths = fromPaperItem(result, fill, opacity, nameGenerator, false, undefined, undefined, true);
  result.remove();

  return resultPaths;
}

// Add a blob to existing paths (union)
export function addBlobToPaths(
  targetPaths: Path[],
  blobPoints: Point[],
  radius: number,
  simplifyTolerance: number,
  nameGenerator: () => string
): Path[] {
  if (targetPaths.length === 0 || blobPoints.length === 0) return [];

  // Create the blob shape using capsules
  const blob = createBlobShape(blobPoints, radius, simplifyTolerance);
  if (!blob) return [];

  // Convert target paths and unite with blob
  const paperTargets = targetPaths.map(p => toPaperPath(p));

  // First unite all target paths together
  let combined = paperTargets[0];
  for (let i = 1; i < paperTargets.length; i++) {
    const newCombined = combined.unite(paperTargets[i]);
    combined.remove();
    paperTargets[i].remove();
    combined = newCombined as paper.Path;
  }

  // Then unite with the blob
  const finalResult = combined.unite(blob);
  combined.remove();
  blob.remove();

  const fill = targetPaths[0].fill;
  const opacity = targetPaths[0].opacity;
  // Pass defaultMirrorAngle: true since blob paths have smoothed handles
  const resultPaths = fromPaperItem(finalResult, fill, opacity, nameGenerator, false, undefined, undefined, true);
  finalResult.remove();

  return resultPaths;
}

// Subtract a blob from existing paths (eraser)
export function subtractBlobFromPaths(
  targetPaths: Path[],
  blobPoints: Point[],
  radius: number,
  simplifyTolerance: number,
  nameGenerator: () => string
): Path[] {
  if (targetPaths.length === 0 || blobPoints.length === 0) return targetPaths;

  // Create the blob shape using capsules
  const blob = createBlobShape(blobPoints, radius, simplifyTolerance);
  if (!blob) return targetPaths;

  // Subtract blob from each target path independently
  const allResults: Path[] = [];

  for (const targetPath of targetPaths) {
    const paperTarget = toPaperPath(targetPath);
    const subtracted = paperTarget.subtract(blob);
    paperTarget.remove();

    // Pass defaultMirrorAngle: true since blob paths have smoothed handles
    const results = fromPaperItem(subtracted, targetPath.fill, targetPath.opacity, nameGenerator, false, undefined, undefined, true);
    subtracted.remove();
    allResults.push(...results);
  }

  blob.remove();
  return allResults;
}
