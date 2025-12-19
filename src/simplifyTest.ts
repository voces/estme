/**
 * Simplification Algorithm Test
 *
 * Compares different path simplification approaches by rendering paths
 * and comparing pixel-by-pixel similarity.
 */

import paper from "paper";
import { Path, Point } from "./types.ts";

// Test path data - replace with actual test path
export const TEST_PATH: Path = {
  id: "test-path",
  name: "Test Path",
  segments: [], // Will be populated with test data
  closed: true,
  fill: "#ff0000",
  opacity: 1,
  visible: true,
  locked: false,
  parentId: null,
};

// Convert our Path to paper.js Path
function toPaperPath(path: Path): paper.Path {
  const paperPath = new paper.Path();
  paperPath.closed = path.closed;

  for (const seg of path.segments) {
    const point = new paper.Point(seg.p0.x, seg.p0.y);
    const handleIn = new paper.Point(
      seg.c0.x - seg.p0.x,
      seg.c0.y - seg.p0.y
    );
    // For handleOut, we need to look at the previous segment's c1
    // This is a simplification - proper conversion would track this
    paperPath.add(new paper.Segment(point, undefined, handleIn));
  }

  return paperPath;
}

// Render a paper.js path to a canvas and get pixel data
function renderPathToPixels(
  paperPath: paper.Path,
  width: number,
  height: number,
  bounds: { x: number; y: number; width: number; height: number }
): Uint8ClampedArray {
  // Create an offscreen canvas
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d")!;

  // Clear
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, width, height);

  // Calculate transform to fit path in canvas
  const scale = Math.min(
    (width - 20) / bounds.width,
    (height - 20) / bounds.height
  );
  const offsetX = (width - bounds.width * scale) / 2 - bounds.x * scale;
  const offsetY = (height - bounds.height * scale) / 2 - bounds.y * scale;

  // Draw the path
  ctx.fillStyle = "black";
  ctx.beginPath();

  const segments = paperPath.segments;
  if (segments.length > 0) {
    const first = segments[0];
    ctx.moveTo(
      first.point.x * scale + offsetX,
      first.point.y * scale + offsetY
    );

    for (let i = 0; i < segments.length; i++) {
      const curr = segments[i];
      const next = segments[(i + 1) % segments.length];

      if (i === segments.length - 1 && !paperPath.closed) break;

      const cp1x = (curr.point.x + (curr.handleOut?.x || 0)) * scale + offsetX;
      const cp1y = (curr.point.y + (curr.handleOut?.y || 0)) * scale + offsetY;
      const cp2x = (next.point.x + (next.handleIn?.x || 0)) * scale + offsetX;
      const cp2y = (next.point.y + (next.handleIn?.y || 0)) * scale + offsetY;
      const x = next.point.x * scale + offsetX;
      const y = next.point.y * scale + offsetY;

      ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y);
    }
  }

  if (paperPath.closed) {
    ctx.closePath();
  }
  ctx.fill();

  // Get pixel data
  return ctx.getImageData(0, 0, width, height).data;
}

// Compare two pixel arrays and return similarity (0-1)
function comparePixels(
  pixels1: Uint8ClampedArray,
  pixels2: Uint8ClampedArray
): { similarity: number; diffCount: number; totalPixels: number } {
  if (pixels1.length !== pixels2.length) {
    throw new Error("Pixel arrays must be same size");
  }

  let diffCount = 0;
  const totalPixels = pixels1.length / 4; // RGBA

  for (let i = 0; i < pixels1.length; i += 4) {
    // Compare just the grayscale value (R channel since we're black/white)
    const diff = Math.abs(pixels1[i] - pixels2[i]);
    if (diff > 10) {
      // Threshold for "different"
      diffCount++;
    }
  }

  return {
    similarity: 1 - diffCount / totalPixels,
    diffCount,
    totalPixels,
  };
}

// Paper.js simplify
function simplifyWithPaperJS(path: paper.Path, tolerance: number): paper.Path {
  const clone = path.clone() as paper.Path;
  clone.simplify(tolerance);
  return clone;
}

// Custom RDP-based simplification
// This samples the bezier curve to points, simplifies, then fits new beziers
function simplifyWithRDP(
  path: paper.Path,
  tolerance: number,
  samplesPerSegment = 10
): paper.Path {
  // Sample path to points
  const points: paper.Point[] = [];
  const length = path.length;
  const numSamples = Math.max(10, Math.floor(length / tolerance));

  for (let i = 0; i <= numSamples; i++) {
    const offset = (i / numSamples) * length;
    points.push(path.getPointAt(offset));
  }

  // Apply RDP simplification
  const simplified = rdpSimplify(
    points.map((p) => ({ x: p.x, y: p.y })),
    tolerance
  );

  // Create new path from simplified points
  const newPath = new paper.Path();
  newPath.closed = path.closed;

  for (const pt of simplified) {
    newPath.add(new paper.Point(pt.x, pt.y));
  }

  // Smooth the path to add bezier handles
  newPath.smooth({ type: "catmull-rom" });

  return newPath;
}

// Ramer-Douglas-Peucker algorithm
function rdpSimplify(
  points: { x: number; y: number }[],
  epsilon: number
): { x: number; y: number }[] {
  if (points.length <= 2) return points;

  // Find the point with maximum distance from line between first and last
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

  // If max distance is greater than epsilon, recursively simplify
  if (maxDist > epsilon) {
    const left = rdpSimplify(points.slice(0, maxIndex + 1), epsilon);
    const right = rdpSimplify(points.slice(maxIndex), epsilon);
    return [...left.slice(0, -1), ...right];
  } else {
    return [first, last];
  }
}

function perpendicularDistance(
  point: { x: number; y: number },
  lineStart: { x: number; y: number },
  lineEnd: { x: number; y: number }
): number {
  const dx = lineEnd.x - lineStart.x;
  const dy = lineEnd.y - lineStart.y;

  if (dx === 0 && dy === 0) {
    return Math.sqrt(
      (point.x - lineStart.x) ** 2 + (point.y - lineStart.y) ** 2
    );
  }

  const t = Math.max(
    0,
    Math.min(
      1,
      ((point.x - lineStart.x) * dx + (point.y - lineStart.y) * dy) /
        (dx * dx + dy * dy)
    )
  );

  const projX = lineStart.x + t * dx;
  const projY = lineStart.y + t * dy;

  return Math.sqrt((point.x - projX) ** 2 + (point.y - projY) ** 2);
}

// Run comparison test
export function runSimplifyTest(
  originalPath: paper.Path,
  tolerance: number,
  canvasSize = 500
): {
  paperJS: { path: paper.Path; segments: number; similarity: number };
  rdp: { path: paper.Path; segments: number; similarity: number };
} {
  const bounds = originalPath.bounds;
  const boundsObj = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  };

  // Get original pixels
  const originalPixels = renderPathToPixels(
    originalPath,
    canvasSize,
    canvasSize,
    boundsObj
  );

  // Test Paper.js simplify
  const paperSimplified = simplifyWithPaperJS(originalPath, tolerance);
  const paperPixels = renderPathToPixels(
    paperSimplified,
    canvasSize,
    canvasSize,
    boundsObj
  );
  const paperComparison = comparePixels(originalPixels, paperPixels);

  // Test RDP simplify
  const rdpSimplified = simplifyWithRDP(originalPath, tolerance);
  const rdpPixels = renderPathToPixels(
    rdpSimplified,
    canvasSize,
    canvasSize,
    boundsObj
  );
  const rdpComparison = comparePixels(originalPixels, rdpPixels);

  return {
    paperJS: {
      path: paperSimplified,
      segments: paperSimplified.segments.length,
      similarity: paperComparison.similarity,
    },
    rdp: {
      path: rdpSimplified,
      segments: rdpSimplified.segments.length,
      similarity: rdpComparison.similarity,
    },
  };
}

// Export for use in tests
export { rdpSimplify, perpendicularDistance };
