// SVG import utility - converts SVG paths to estme format

import { Path, CubicSegment, AnchorMeta, defaultAnchorMeta, defaultTransform, Point, Group, SnapConnection, PointReference } from "./types.ts";
import { generateId } from "./storage.ts";

type ParsedPath = {
  segments: CubicSegment[];
  anchorMeta: AnchorMeta[];
  closed: boolean;
  fill: string;
  opacity: number;
  name: string;
  playerMask: boolean;
};

// Parse SVG path d attribute into path commands
function parsePathData(d: string): { type: string; args: number[] }[] {
  const commands: { type: string; args: number[] }[] = [];
  // Match command letter followed by numbers (with optional signs, decimals)
  const regex = /([MmLlHhVvCcSsQqTtAaZz])([^MmLlHhVvCcSsQqTtAaZz]*)/g;
  let match;

  while ((match = regex.exec(d)) !== null) {
    const type = match[1];
    const argsStr = match[2].trim();

    if (type.toLowerCase() === "z") {
      commands.push({ type, args: [] });
    } else if (argsStr) {
      // Parse numbers, handling negative signs and decimals
      const numbers = argsStr.match(/-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g);
      if (numbers) {
        const args = numbers.map(Number);
        commands.push({ type, args });
      }
    }
  }

  return commands;
}

// A single subpath result
type SubpathResult = { segments: CubicSegment[]; closed: boolean };

// Convert parsed path commands to cubic bezier segments
// Returns multiple subpaths when the path contains multiple M commands or continues after Z
function commandsToSegments(commands: { type: string; args: number[] }[]): SubpathResult[] {
  const subpaths: SubpathResult[] = [];
  let segments: CubicSegment[] = [];
  let currentX = 0;
  let currentY = 0;
  let startX = 0;
  let startY = 0;
  let lastControlX = 0;
  let lastControlY = 0;
  let closed = false;
  let hasSegments = false; // Track if we've drawn anything in current subpath

  // Helper to finalize current subpath and start a new one
  const finalizeSubpath = () => {
    if (segments.length > 0) {
      subpaths.push({ segments: [...segments], closed });
    }
    segments = [];
    closed = false;
    hasSegments = false;
  };

  for (const cmd of commands) {
    const { type, args } = cmd;
    const isRelative = type === type.toLowerCase();
    const cmdType = type.toUpperCase();

    switch (cmdType) {
      case "M": {
        // Move to - starts a new subpath if we already have content
        if (hasSegments) {
          finalizeSubpath();
        }
        // Move to - can have multiple coordinate pairs (implicit lineto after first)
        for (let i = 0; i < args.length; i += 2) {
          const x = isRelative ? currentX + args[i] : args[i];
          const y = isRelative ? currentY + args[i + 1] : args[i + 1];
          if (i === 0) {
            startX = x;
            startY = y;
          } else {
            // Implicit lineto for subsequent pairs
            const p0 = { x: currentX, y: currentY };
            const p1 = { x, y };
            segments.push({
              p0,
              c0: { x: p0.x + (p1.x - p0.x) / 3, y: p0.y + (p1.y - p0.y) / 3 },
              c1: { x: p0.x + (2 * (p1.x - p0.x)) / 3, y: p0.y + (2 * (p1.y - p0.y)) / 3 },
              p1,
            });
            hasSegments = true;
          }
          currentX = x;
          currentY = y;
        }
        lastControlX = currentX;
        lastControlY = currentY;
        break;
      }

      case "L": {
        // Line to
        for (let i = 0; i < args.length; i += 2) {
          const x = isRelative ? currentX + args[i] : args[i];
          const y = isRelative ? currentY + args[i + 1] : args[i + 1];
          const p0 = { x: currentX, y: currentY };
          const p1 = { x, y };
          segments.push({
            p0,
            c0: { x: p0.x + (p1.x - p0.x) / 3, y: p0.y + (p1.y - p0.y) / 3 },
            c1: { x: p0.x + (2 * (p1.x - p0.x)) / 3, y: p0.y + (2 * (p1.y - p0.y)) / 3 },
            p1,
          });
          hasSegments = true;
          currentX = x;
          currentY = y;
        }
        lastControlX = currentX;
        lastControlY = currentY;
        break;
      }

      case "H": {
        // Horizontal line
        for (const arg of args) {
          const x = isRelative ? currentX + arg : arg;
          const p0 = { x: currentX, y: currentY };
          const p1 = { x, y: currentY };
          segments.push({
            p0,
            c0: { x: p0.x + (p1.x - p0.x) / 3, y: p0.y },
            c1: { x: p0.x + (2 * (p1.x - p0.x)) / 3, y: p0.y },
            p1,
          });
          hasSegments = true;
          currentX = x;
        }
        lastControlX = currentX;
        lastControlY = currentY;
        break;
      }

      case "V": {
        // Vertical line
        for (const arg of args) {
          const y = isRelative ? currentY + arg : arg;
          const p0 = { x: currentX, y: currentY };
          const p1 = { x: currentX, y };
          segments.push({
            p0,
            c0: { x: p0.x, y: p0.y + (p1.y - p0.y) / 3 },
            c1: { x: p0.x, y: p0.y + (2 * (p1.y - p0.y)) / 3 },
            p1,
          });
          hasSegments = true;
          currentY = y;
        }
        lastControlX = currentX;
        lastControlY = currentY;
        break;
      }

      case "C": {
        // Cubic bezier
        for (let i = 0; i < args.length; i += 6) {
          const c0x = isRelative ? currentX + args[i] : args[i];
          const c0y = isRelative ? currentY + args[i + 1] : args[i + 1];
          const c1x = isRelative ? currentX + args[i + 2] : args[i + 2];
          const c1y = isRelative ? currentY + args[i + 3] : args[i + 3];
          const x = isRelative ? currentX + args[i + 4] : args[i + 4];
          const y = isRelative ? currentY + args[i + 5] : args[i + 5];
          segments.push({
            p0: { x: currentX, y: currentY },
            c0: { x: c0x, y: c0y },
            c1: { x: c1x, y: c1y },
            p1: { x, y },
          });
          hasSegments = true;
          lastControlX = c1x;
          lastControlY = c1y;
          currentX = x;
          currentY = y;
        }
        break;
      }

      case "S": {
        // Smooth cubic bezier (reflects previous control point)
        for (let i = 0; i < args.length; i += 4) {
          // Reflect the last control point
          const c0x = 2 * currentX - lastControlX;
          const c0y = 2 * currentY - lastControlY;
          const c1x = isRelative ? currentX + args[i] : args[i];
          const c1y = isRelative ? currentY + args[i + 1] : args[i + 1];
          const x = isRelative ? currentX + args[i + 2] : args[i + 2];
          const y = isRelative ? currentY + args[i + 3] : args[i + 3];
          segments.push({
            p0: { x: currentX, y: currentY },
            c0: { x: c0x, y: c0y },
            c1: { x: c1x, y: c1y },
            p1: { x, y },
          });
          hasSegments = true;
          lastControlX = c1x;
          lastControlY = c1y;
          currentX = x;
          currentY = y;
        }
        break;
      }

      case "Q": {
        // Quadratic bezier - convert to cubic
        for (let i = 0; i < args.length; i += 4) {
          const qx = isRelative ? currentX + args[i] : args[i];
          const qy = isRelative ? currentY + args[i + 1] : args[i + 1];
          const x = isRelative ? currentX + args[i + 2] : args[i + 2];
          const y = isRelative ? currentY + args[i + 3] : args[i + 3];
          // Convert quadratic to cubic control points
          const c0x = currentX + (2 / 3) * (qx - currentX);
          const c0y = currentY + (2 / 3) * (qy - currentY);
          const c1x = x + (2 / 3) * (qx - x);
          const c1y = y + (2 / 3) * (qy - y);
          segments.push({
            p0: { x: currentX, y: currentY },
            c0: { x: c0x, y: c0y },
            c1: { x: c1x, y: c1y },
            p1: { x, y },
          });
          hasSegments = true;
          lastControlX = qx;
          lastControlY = qy;
          currentX = x;
          currentY = y;
        }
        break;
      }

      case "T": {
        // Smooth quadratic bezier
        for (let i = 0; i < args.length; i += 2) {
          // Reflect the last quadratic control point
          const qx = 2 * currentX - lastControlX;
          const qy = 2 * currentY - lastControlY;
          const x = isRelative ? currentX + args[i] : args[i];
          const y = isRelative ? currentY + args[i + 1] : args[i + 1];
          const c0x = currentX + (2 / 3) * (qx - currentX);
          const c0y = currentY + (2 / 3) * (qy - currentY);
          const c1x = x + (2 / 3) * (qx - x);
          const c1y = y + (2 / 3) * (qy - y);
          segments.push({
            p0: { x: currentX, y: currentY },
            c0: { x: c0x, y: c0y },
            c1: { x: c1x, y: c1y },
            p1: { x, y },
          });
          hasSegments = true;
          lastControlX = qx;
          lastControlY = qy;
          currentX = x;
          currentY = y;
        }
        break;
      }

      case "A": {
        // Arc - approximate with cubic beziers
        for (let i = 0; i < args.length; i += 7) {
          const rx = args[i];
          const ry = args[i + 1];
          const xAxisRotation = args[i + 2] * Math.PI / 180;
          const largeArcFlag = args[i + 3];
          const sweepFlag = args[i + 4];
          const x = isRelative ? currentX + args[i + 5] : args[i + 5];
          const y = isRelative ? currentY + args[i + 6] : args[i + 6];

          const arcSegments = arcToCubic(
            currentX, currentY, x, y,
            rx, ry, xAxisRotation, largeArcFlag !== 0, sweepFlag !== 0
          );
          segments.push(...arcSegments);
          hasSegments = true;

          currentX = x;
          currentY = y;
          lastControlX = currentX;
          lastControlY = currentY;
        }
        break;
      }

      case "Z": {
        // Close path - add line segment back to start if needed
        if (Math.abs(currentX - startX) > 0.001 || Math.abs(currentY - startY) > 0.001) {
          const p0 = { x: currentX, y: currentY };
          const p1 = { x: startX, y: startY };
          segments.push({
            p0,
            c0: { x: p0.x + (p1.x - p0.x) / 3, y: p0.y + (p1.y - p0.y) / 3 },
            c1: { x: p0.x + (2 * (p1.x - p0.x)) / 3, y: p0.y + (2 * (p1.y - p0.y)) / 3 },
            p1,
          });
        }
        closed = true;
        hasSegments = true;
        currentX = startX;
        currentY = startY;
        // Z closes the subpath, so finalize it (next M or command will start fresh)
        finalizeSubpath();
        break;
      }
    }
  }

  // Finalize any remaining subpath
  finalizeSubpath();

  return subpaths;
}

// Convert arc to cubic bezier segments
function arcToCubic(
  x1: number, y1: number, x2: number, y2: number,
  rx: number, ry: number, phi: number,
  largeArc: boolean, sweep: boolean
): CubicSegment[] {
  // Handle edge cases
  if (rx === 0 || ry === 0) {
    return [{
      p0: { x: x1, y: y1 },
      c0: { x: x1 + (x2 - x1) / 3, y: y1 + (y2 - y1) / 3 },
      c1: { x: x1 + (2 * (x2 - x1)) / 3, y: y1 + (2 * (y2 - y1)) / 3 },
      p1: { x: x2, y: y2 },
    }];
  }

  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);

  // Step 1: Compute (x1', y1')
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cosPhi * dx + sinPhi * dy;
  const y1p = -sinPhi * dx + cosPhi * dy;

  // Step 2: Compute (cx', cy')
  let rxSq = rx * rx;
  let rySq = ry * ry;
  const x1pSq = x1p * x1p;
  const y1pSq = y1p * y1p;

  // Correct radii if necessary
  const lambda = x1pSq / rxSq + y1pSq / rySq;
  if (lambda > 1) {
    const sqrtLambda = Math.sqrt(lambda);
    rx *= sqrtLambda;
    ry *= sqrtLambda;
    rxSq = rx * rx;
    rySq = ry * ry;
  }

  let sq = (rxSq * rySq - rxSq * y1pSq - rySq * x1pSq) / (rxSq * y1pSq + rySq * x1pSq);
  if (sq < 0) sq = 0;
  const coef = (largeArc !== sweep ? 1 : -1) * Math.sqrt(sq);
  const cxp = coef * rx * y1p / ry;
  const cyp = -coef * ry * x1p / rx;

  // Step 3: Compute (cx, cy)
  const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;

  // Step 4: Compute theta1 and dtheta
  const ux = (x1p - cxp) / rx;
  const uy = (y1p - cyp) / ry;
  const vx = (-x1p - cxp) / rx;
  const vy = (-y1p - cyp) / ry;

  const n = Math.sqrt(ux * ux + uy * uy);
  let p = ux;
  let theta1 = (uy < 0 ? -1 : 1) * Math.acos(p / n);

  const n2 = Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy));
  p = ux * vx + uy * vy;
  let dtheta = (ux * vy - uy * vx < 0 ? -1 : 1) * Math.acos(Math.max(-1, Math.min(1, p / n2)));

  if (!sweep && dtheta > 0) dtheta -= 2 * Math.PI;
  if (sweep && dtheta < 0) dtheta += 2 * Math.PI;

  // Split arc into segments (max 90 degrees each)
  const segments: CubicSegment[] = [];
  const numSegments = Math.ceil(Math.abs(dtheta) / (Math.PI / 2));
  const segmentAngle = dtheta / numSegments;

  let currentTheta = theta1;
  let prevX = x1;
  let prevY = y1;

  for (let i = 0; i < numSegments; i++) {
    const nextTheta = currentTheta + segmentAngle;

    // Calculate end point
    const cosNext = Math.cos(nextTheta);
    const sinNext = Math.sin(nextTheta);
    const nextX = cosPhi * rx * cosNext - sinPhi * ry * sinNext + cx;
    const nextY = sinPhi * rx * cosNext + cosPhi * ry * sinNext + cy;

    // Calculate control points using the arc approximation formula
    const alpha = Math.sin(segmentAngle) * (Math.sqrt(4 + 3 * Math.tan(segmentAngle / 2) ** 2) - 1) / 3;

    const cosCurrent = Math.cos(currentTheta);
    const sinCurrent = Math.sin(currentTheta);

    // Derivatives at start and end
    const dx1 = -rx * sinCurrent;
    const dy1 = ry * cosCurrent;
    const dx2 = -rx * sinNext;
    const dy2 = ry * cosNext;

    // Rotate derivatives
    const c0x = prevX + alpha * (cosPhi * dx1 - sinPhi * dy1);
    const c0y = prevY + alpha * (sinPhi * dx1 + cosPhi * dy1);
    const c1x = nextX - alpha * (cosPhi * dx2 - sinPhi * dy2);
    const c1y = nextY - alpha * (sinPhi * dx2 + cosPhi * dy2);

    segments.push({
      p0: { x: prevX, y: prevY },
      c0: { x: c0x, y: c0y },
      c1: { x: c1x, y: c1y },
      p1: { x: nextX, y: nextY },
    });

    prevX = nextX;
    prevY = nextY;
    currentTheta = nextTheta;
  }

  return segments;
}

// Parse color from SVG (handles hex, rgb, named colors)
function parseColor(color: string | null): string {
  if (!color || color === "none" || color === "transparent") {
    return "#808080"; // Default gray for no fill
  }

  // Already hex
  if (color.startsWith("#")) {
    // Expand shorthand (#RGB -> #RRGGBB)
    if (color.length === 4) {
      return `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`;
    }
    return color;
  }

  // RGB/RGBA
  const rgbMatch = color.match(/rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (rgbMatch) {
    const r = parseInt(rgbMatch[1]).toString(16).padStart(2, "0");
    const g = parseInt(rgbMatch[2]).toString(16).padStart(2, "0");
    const b = parseInt(rgbMatch[3]).toString(16).padStart(2, "0");
    return `#${r}${g}${b}`;
  }

  // Named colors (common ones)
  const namedColors: Record<string, string> = {
    black: "#000000",
    white: "#ffffff",
    red: "#ff0000",
    green: "#008000",
    blue: "#0000ff",
    yellow: "#ffff00",
    cyan: "#00ffff",
    magenta: "#ff00ff",
    gray: "#808080",
    grey: "#808080",
    orange: "#ffa500",
    purple: "#800080",
    pink: "#ffc0cb",
    brown: "#a52a2a",
  };

  return namedColors[color.toLowerCase()] || "#808080";
}

// Parse opacity from SVG
function parseOpacity(element: Element): number {
  const opacity = element.getAttribute("opacity");
  const fillOpacity = element.getAttribute("fill-opacity");

  let result = 1;
  if (opacity) result *= parseFloat(opacity);
  if (fillOpacity) result *= parseFloat(fillOpacity);

  return Math.max(0, Math.min(1, result));
}

// Apply transform matrix to a point
function applyTransform(point: Point, matrix: DOMMatrix): Point {
  return {
    x: matrix.a * point.x + matrix.c * point.y + matrix.e,
    y: matrix.b * point.x + matrix.d * point.y + matrix.f,
  };
}

// Get accumulated transform for an element
function getAccumulatedTransform(element: Element): DOMMatrix {
  const transforms: DOMMatrix[] = [];
  let current: Element | null = element;

  while (current && current.tagName !== "svg") {
    const transformAttr = current.getAttribute("transform");
    if (transformAttr) {
      const matrix = parseTransform(transformAttr);
      transforms.unshift(matrix);
    }
    current = current.parentElement;
  }

  // Combine all transforms
  let result = new DOMMatrix();
  for (const m of transforms) {
    result = result.multiply(m);
  }
  return result;
}

// Parse SVG transform attribute
function parseTransform(transform: string): DOMMatrix {
  const matrix = new DOMMatrix();

  // Match transform functions
  const regex = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]+)\)/gi;
  let match;

  while ((match = regex.exec(transform)) !== null) {
    const type = match[1].toLowerCase();
    const args = match[2].split(/[\s,]+/).map(Number);

    switch (type) {
      case "matrix":
        if (args.length >= 6) {
          const m = new DOMMatrix([args[0], args[1], args[2], args[3], args[4], args[5]]);
          matrix.multiplySelf(m);
        }
        break;
      case "translate":
        matrix.translateSelf(args[0] || 0, args[1] || 0);
        break;
      case "scale":
        matrix.scaleSelf(args[0] || 1, args.length > 1 ? args[1] : args[0] || 1);
        break;
      case "rotate":
        if (args.length === 1) {
          matrix.rotateSelf(args[0]);
        } else if (args.length === 3) {
          matrix.translateSelf(args[1], args[2]);
          matrix.rotateSelf(args[0]);
          matrix.translateSelf(-args[1], -args[2]);
        }
        break;
      case "skewx":
        matrix.skewXSelf(args[0] || 0);
        break;
      case "skewy":
        matrix.skewYSelf(args[0] || 0);
        break;
    }
  }

  return matrix;
}

// Convert basic shapes to path data
function shapeToPathData(element: Element): string | null {
  const tag = element.tagName.toLowerCase();

  switch (tag) {
    case "rect": {
      const x = parseFloat(element.getAttribute("x") || "0");
      const y = parseFloat(element.getAttribute("y") || "0");
      const width = parseFloat(element.getAttribute("width") || "0");
      const height = parseFloat(element.getAttribute("height") || "0");
      const rx = parseFloat(element.getAttribute("rx") || "0");
      const ry = parseFloat(element.getAttribute("ry") || rx.toString());

      if (rx === 0 && ry === 0) {
        return `M${x},${y} L${x + width},${y} L${x + width},${y + height} L${x},${y + height} Z`;
      } else {
        // Rounded rectangle
        const r = Math.min(rx, width / 2);
        const rY = Math.min(ry, height / 2);
        return `M${x + r},${y} L${x + width - r},${y} A${r},${rY} 0 0 1 ${x + width},${y + rY} L${x + width},${y + height - rY} A${r},${rY} 0 0 1 ${x + width - r},${y + height} L${x + r},${y + height} A${r},${rY} 0 0 1 ${x},${y + height - rY} L${x},${y + rY} A${r},${rY} 0 0 1 ${x + r},${y} Z`;
      }
    }

    case "circle": {
      const cx = parseFloat(element.getAttribute("cx") || "0");
      const cy = parseFloat(element.getAttribute("cy") || "0");
      const r = parseFloat(element.getAttribute("r") || "0");
      return `M${cx - r},${cy} A${r},${r} 0 1 0 ${cx + r},${cy} A${r},${r} 0 1 0 ${cx - r},${cy} Z`;
    }

    case "ellipse": {
      const cx = parseFloat(element.getAttribute("cx") || "0");
      const cy = parseFloat(element.getAttribute("cy") || "0");
      const rx = parseFloat(element.getAttribute("rx") || "0");
      const ry = parseFloat(element.getAttribute("ry") || "0");
      return `M${cx - rx},${cy} A${rx},${ry} 0 1 0 ${cx + rx},${cy} A${rx},${ry} 0 1 0 ${cx - rx},${cy} Z`;
    }

    case "line": {
      const x1 = parseFloat(element.getAttribute("x1") || "0");
      const y1 = parseFloat(element.getAttribute("y1") || "0");
      const x2 = parseFloat(element.getAttribute("x2") || "0");
      const y2 = parseFloat(element.getAttribute("y2") || "0");
      return `M${x1},${y1} L${x2},${y2}`;
    }

    case "polyline":
    case "polygon": {
      const points = element.getAttribute("points");
      if (!points) return null;
      const coords = points.trim().split(/[\s,]+/).map(Number);
      if (coords.length < 4) return null;
      let d = `M${coords[0]},${coords[1]}`;
      for (let i = 2; i < coords.length; i += 2) {
        d += ` L${coords[i]},${coords[i + 1]}`;
      }
      if (tag === "polygon") d += " Z";
      return d;
    }

    default:
      return null;
  }
}

// Tolerance for floating point comparisons (1 degree in radians for angles, 1% for distances)
const ANGLE_TOLERANCE = Math.PI / 180; // 1 degree
const DISTANCE_TOLERANCE = 0.01; // 1%

// Detect mirrored control points for a closed path
// For each anchor, check if c1 of previous segment and c0 of current segment are mirrored
function detectMirroredHandles(segments: CubicSegment[], closed: boolean): AnchorMeta[] {
  const anchorMeta: AnchorMeta[] = [];

  for (let i = 0; i < segments.length; i++) {
    const meta = defaultAnchorMeta();

    // Get the anchor point (p0 of current segment)
    const anchor = segments[i].p0;

    // Get outgoing control point (c0 of current segment)
    const outgoing = segments[i].c0;

    // Get incoming control point (c1 of previous segment)
    // For closed paths, prev of first segment is last segment
    // For open paths, first anchor has no incoming
    const prevIndex = i === 0 ? (closed ? segments.length - 1 : -1) : i - 1;
    const incoming = prevIndex >= 0 ? segments[prevIndex].c1 : null;

    // Calculate vectors from anchor to control points
    const outVec = { x: outgoing.x - anchor.x, y: outgoing.y - anchor.y };
    const outDist = Math.sqrt(outVec.x * outVec.x + outVec.y * outVec.y);
    const outAngle = Math.atan2(outVec.y, outVec.x);

    if (incoming) {
      const inVec = { x: incoming.x - anchor.x, y: incoming.y - anchor.y };
      const inDist = Math.sqrt(inVec.x * inVec.x + inVec.y * inVec.y);
      const inAngle = Math.atan2(inVec.y, inVec.x);

      // Check if both handles are active (not collapsed to anchor)
      const outActive = outDist > 0.001;
      const inActive = inDist > 0.001;

      if (outActive && inActive) {
        // Check angle mirroring: handles should be ~180 degrees apart
        // Normalize angle difference to [-PI, PI]
        let angleDiff = outAngle - inAngle;
        while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
        while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;

        // Check if they're opposite (180 degrees apart)
        const isAngleMirrored = Math.abs(Math.abs(angleDiff) - Math.PI) < ANGLE_TOLERANCE;

        // Check distance mirroring: handles should be same length
        const avgDist = (outDist + inDist) / 2;
        const distDiff = Math.abs(outDist - inDist) / avgDist;
        const isDistanceMirrored = distDiff < DISTANCE_TOLERANCE;

        meta.mirrorAngle = isAngleMirrored;
        meta.mirrorDistance = isAngleMirrored && isDistanceMirrored;
      }

      meta.leftActive = inActive;
    } else {
      // First anchor in open path has no incoming
      meta.leftActive = false;
    }

    meta.rightActive = outDist > 0.001;

    anchorMeta.push(meta);
  }

  return anchorMeta;
}

// Parse a single path element - may return multiple paths for multi-subpath elements
function parseSvgPath(element: Element, index: number): ParsedPath[] {
  let d: string | null = null;

  if (element.tagName.toLowerCase() === "path") {
    d = element.getAttribute("d");
  } else {
    d = shapeToPathData(element);
  }

  if (!d) return [];

  const commands = parsePathData(d);
  if (commands.length === 0) return [];

  const subpaths = commandsToSegments(commands);
  if (subpaths.length === 0) return [];

  // Apply transforms to all points
  const matrix = getAccumulatedTransform(element);

  // Get fill color
  const fill = element.getAttribute("fill") || element.getAttribute("style")?.match(/fill:\s*([^;]+)/)?.[1] || "#808080";

  // Get name from id or generate one
  const id = element.getAttribute("id");
  const baseName = id || `path ${index + 1}`;

  // Check for data-player attribute (indicates accent/player coloring)
  const playerMask = element.hasAttribute("data-player");

  const parsedPaths: ParsedPath[] = [];

  for (let subIdx = 0; subIdx < subpaths.length; subIdx++) {
    const { segments, closed } = subpaths[subIdx];
    if (segments.length === 0) continue;

    const transformedSegments = segments.map((seg) => ({
      p0: applyTransform(seg.p0, matrix),
      c0: applyTransform(seg.c0, matrix),
      c1: applyTransform(seg.c1, matrix),
      p1: applyTransform(seg.p1, matrix),
    }));

    // Detect mirrored handles
    const anchorMeta = detectMirroredHandles(transformedSegments, closed);

    // Name subpaths differently if there are multiple
    const name = subpaths.length > 1 ? `${baseName} ${subIdx + 1}` : baseName;

    parsedPaths.push({
      segments: transformedSegments,
      anchorMeta,
      closed,
      fill: parseColor(fill),
      opacity: parseOpacity(element),
      name,
      playerMask,
    });
  }

  return parsedPaths;
}

// Tolerance for detecting snapped points (in SVG units)
// Using a small but reasonable tolerance to catch floating point imprecision
const SNAP_TOLERANCE = 0.0005;

// Detect snap connections between paths
// Returns snap connections for points that are at the same position
function detectSnapConnections(paths: Path[]): SnapConnection[] {
  // Collect all points (anchors and control points) with their references
  type PointWithRef = { x: number; y: number; ref: PointReference };
  const allPoints: PointWithRef[] = [];

  for (const path of paths) {
    for (let segIdx = 0; segIdx < path.segments.length; segIdx++) {
      const seg = path.segments[segIdx];
      // Add anchor point (p0)
      allPoints.push({
        x: seg.p0.x,
        y: seg.p0.y,
        ref: { pathId: path.id, segmentIndex: segIdx, handleType: "anchor" },
      });
      // Add control points
      allPoints.push({
        x: seg.c0.x,
        y: seg.c0.y,
        ref: { pathId: path.id, segmentIndex: segIdx, handleType: "c0" },
      });
      allPoints.push({
        x: seg.c1.x,
        y: seg.c1.y,
        ref: { pathId: path.id, segmentIndex: segIdx, handleType: "c1" },
      });
    }
    // For open paths, also add the final anchor (p1 of last segment)
    if (!path.closed && path.segments.length > 0) {
      const lastSeg = path.segments[path.segments.length - 1];
      allPoints.push({
        x: lastSeg.p1.x,
        y: lastSeg.p1.y,
        ref: { pathId: path.id, segmentIndex: path.segments.length, handleType: "anchor" },
      });
    }
  }

  // Group points by position (using tolerance)
  // First, cluster ALL points at the same position together
  const clusters: number[][] = []; // Each cluster is a list of indices into allPoints
  const pointToCluster = new Map<number, number>(); // Maps point index to cluster index

  for (let i = 0; i < allPoints.length; i++) {
    if (pointToCluster.has(i)) continue;

    const point = allPoints[i];
    const cluster: number[] = [i];
    pointToCluster.set(i, clusters.length);

    for (let j = i + 1; j < allPoints.length; j++) {
      if (pointToCluster.has(j)) continue;

      const other = allPoints[j];
      const dx = Math.abs(other.x - point.x);
      const dy = Math.abs(other.y - point.y);

      if (dx < SNAP_TOLERANCE && dy < SNAP_TOLERANCE) {
        cluster.push(j);
        pointToCluster.set(j, clusters.length);
      }
    }

    clusters.push(cluster);
  }

  // Now create snap connections from clusters
  // For each cluster, only include ONE point per path (prefer anchor over control points)
  const connections: SnapConnection[] = [];

  for (const cluster of clusters) {
    if (cluster.length < 2) continue;

    // Group points in cluster by path
    const byPath = new Map<string, PointReference[]>();
    for (const idx of cluster) {
      const ref = allPoints[idx].ref;
      if (!byPath.has(ref.pathId)) {
        byPath.set(ref.pathId, []);
      }
      byPath.get(ref.pathId)!.push(ref);
    }

    // Skip if all points are from the same path
    if (byPath.size < 2) continue;

    // For each path, pick the best point (prefer anchor over control points)
    const connectionPoints: PointReference[] = [];
    for (const [_pathId, points] of byPath) {
      // Sort: anchor first, then c0, then c1
      points.sort((a, b) => {
        const order = { anchor: 0, c0: 1, c1: 2 };
        return order[a.handleType] - order[b.handleType];
      });
      // Take the first (highest priority) point
      connectionPoints.push(points[0]);
    }

    if (connectionPoints.length >= 2) {
      connections.push({
        id: generateId(),
        points: connectionPoints,
      });
    }
  }

  return connections;
}

// Main function to import SVG
export function importSvg(svgText: string, pathCounter: number, groupCounter: number = 0): { paths: Path[]; groups: Group[]; snapConnections: SnapConnection[]; newPathCounter: number; newGroupCounter: number } {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgText, "image/svg+xml");

  // Check for parse errors
  const parseError = doc.querySelector("parsererror");
  if (parseError) {
    throw new Error("Invalid SVG file");
  }

  const paths: Path[] = [];
  const groups: Group[] = [];
  let pCounter = pathCounter;
  let gCounter = groupCounter;

  // Find all path elements and basic shapes
  const elements = doc.querySelectorAll("path, rect, circle, ellipse, line, polyline, polygon");

  elements.forEach((element, index) => {
    const parsedPaths = parseSvgPath(element, index);
    if (parsedPaths.length === 0) return;

    // If there are multiple subpaths, create a group for them
    let parentId: string | null = null;
    if (parsedPaths.length > 1) {
      const groupId = generateId();
      const groupName = element.getAttribute("id") || `Group ${++gCounter}`;
      groups.push({
        id: groupId,
        name: groupName,
        parentId: null,
        collapsed: false,
        transformPoint: null,
      });
      parentId = groupId;
    }

    for (const parsed of parsedPaths) {
      paths.push({
        id: generateId(),
        name: parsed.name || `Path ${++pCounter}`,
        parentId,
        segments: parsed.segments,
        anchorMeta: parsed.anchorMeta,
        closed: parsed.closed,
        fill: parsed.fill,
        opacity: parsed.opacity,
        visible: true,
        locked: false,
        playerMask: parsed.playerMask,
        transform: defaultTransform(),
        transformPoint: null,
      });
    }
  });

  if (paths.length === 0) {
    return { paths, groups, snapConnections: [], newPathCounter: pCounter, newGroupCounter: gCounter };
  }

  // Calculate bounding box of all paths
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const path of paths) {
    for (const seg of path.segments) {
      for (const pt of [seg.p0, seg.c0, seg.c1, seg.p1]) {
        minX = Math.min(minX, pt.x);
        minY = Math.min(minY, pt.y);
        maxX = Math.max(maxX, pt.x);
        maxY = Math.max(maxY, pt.y);
      }
    }
  }

  // Calculate center offset and flip Y (SVG Y goes down, canvas Y goes up)
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;

  // Detect snap connections BEFORE transforming (coordinates match at this point)
  const snapConnections = detectSnapConnections(paths);

  // Transform all paths: flip Y and center at origin
  for (const path of paths) {
    path.segments = path.segments.map((seg) => ({
      p0: { x: seg.p0.x - centerX, y: -(seg.p0.y - centerY) },
      c0: { x: seg.c0.x - centerX, y: -(seg.c0.y - centerY) },
      c1: { x: seg.c1.x - centerX, y: -(seg.c1.y - centerY) },
      p1: { x: seg.p1.x - centerX, y: -(seg.p1.y - centerY) },
    }));
  }

  return { paths, groups, snapConnections, newPathCounter: pCounter, newGroupCounter: gCounter };
}
