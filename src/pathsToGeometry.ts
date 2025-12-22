import {
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  FloatType,
  RGBAFormat,
  RedFormat,
  Shape,
  ShapeGeometry,
} from "three";
import { Path, PathTransform } from "./types.ts";
import { AnimationData } from "./AnimatedInstancedMesh.ts";
import { hexToRgbNormalized, lerpRgb, sampleBezier } from "./geometry.ts";

// Transform for a specific path (from animation or base transform)
export type EffectiveTransform = PathTransform & { opacity: number };

// Apply transform to a point (translate, rotate around origin, scale)
function applyTransform(x: number, y: number, transform: EffectiveTransform): { x: number; y: number } {
  // Apply scale
  let tx = x * transform.scale;
  let ty = y * transform.scale;

  // Apply rotation
  if (transform.rot !== 0) {
    const cos = Math.cos(transform.rot);
    const sin = Math.sin(transform.rot);
    const rx = tx * cos - ty * sin;
    const ry = tx * sin + ty * cos;
    tx = rx;
    ty = ry;
  }

  // Apply translation
  tx += transform.tx;
  ty += transform.ty;

  return { x: tx, y: ty };
}

/**
 * Convert estme paths to a BufferGeometry with attributes for AnimatedInstancedMesh.
 * Each path becomes a "part" with its own partID.
 *
 * @param paths - The paths to convert
 * @param transforms - Optional per-path transforms to apply (animated or base transforms)
 *
 * Geometry attributes:
 * - position (vec3): vertex positions
 * - color (vec3): vertex colors (from path fill or vertex colors)
 * - playerMask (float): 1 if vertex should use player coloring (not implemented yet)
 * - partID (float): which part this vertex belongs to
 */
export function pathsToGeometry(
  paths: Path[],
  transforms?: Map<string, EffectiveTransform>,
): BufferGeometry | null {
  if (paths.length === 0) return null;

  const allPositions: number[] = [];
  const allColors: number[] = [];
  const allAlphas: number[] = [];
  const allPartIDs: number[] = [];
  const allPlayerMasks: number[] = [];

  for (let partIdx = 0; partIdx < paths.length; partIdx++) {
    const path = paths[partIdx];
    if (path.segments.length === 0) continue;

    // Get effective transform for this path
    const transform = transforms?.get(path.id) ?? {
      tx: path.transform.tx,
      ty: path.transform.ty,
      rot: path.transform.rot,
      scale: path.transform.scale,
      opacity: path.opacity,
    };

    // Check if path has vertex colors
    const hasVertexColors = path.anchorMeta?.some((meta) => meta.color !== null) ?? false;

    let geometry: ShapeGeometry;
    let colors: Float32Array;

    if (hasVertexColors) {
      // Create geometry with vertex colors
      const result = createVertexColoredGeometry(path);
      if (!result) continue;
      geometry = result.geometry;
      colors = result.colors;
    } else {
      // Create standard geometry
      const shape = new Shape();
      const first = path.segments[0].p0;
      shape.moveTo(first.x, first.y);

      for (const seg of path.segments) {
        shape.bezierCurveTo(
          seg.c0.x,
          seg.c0.y,
          seg.c1.x,
          seg.c1.y,
          seg.p1.x,
          seg.p1.y,
        );
      }

      if (path.closed) {
        shape.closePath();
      }

      geometry = new ShapeGeometry(shape, 32);

      // Create uniform colors from path fill
      const fillColor = hexToRgbNormalized(path.fill);
      const vertexCount = geometry.attributes.position.count;
      colors = new Float32Array(vertexCount * 3);
      for (let i = 0; i < vertexCount; i++) {
        colors[i * 3] = fillColor.r;
        colors[i * 3 + 1] = fillColor.g;
        colors[i * 3 + 2] = fillColor.b;
      }
    }

    // Extract positions and add to merged arrays
    const positions = geometry.attributes.position;
    const vertexCount = positions.count;

    // Clamp opacity to 0-1 range
    const opacity = Math.max(0, Math.min(1, transform.opacity));

    for (let i = 0; i < vertexCount; i++) {
      // Apply transform to position
      const transformed = applyTransform(positions.getX(i), positions.getY(i), transform);
      allPositions.push(transformed.x, transformed.y, positions.getZ(i));
      // Store colors without opacity multiplication - alpha is separate
      allColors.push(
        colors[i * 3],
        colors[i * 3 + 1],
        colors[i * 3 + 2],
      );
      allAlphas.push(opacity);
      allPartIDs.push(partIdx);
      allPlayerMasks.push(path.playerMask ? 1 : 0);
    }

    // Copy indices with offset
    const indices = geometry.index;
    if (indices) {
      // We need to handle indices - ShapeGeometry uses indexed geometry
      // For now, let's convert to non-indexed
      const nonIndexedPositions: number[] = [];
      const nonIndexedColors: number[] = [];
      const nonIndexedAlphas: number[] = [];
      const nonIndexedPartIDs: number[] = [];
      const nonIndexedPlayerMasks: number[] = [];

      for (let i = 0; i < indices.count; i++) {
        const idx = indices.getX(i);
        // Apply transform to position
        const transformed = applyTransform(positions.getX(idx), positions.getY(idx), transform);
        nonIndexedPositions.push(transformed.x, transformed.y, positions.getZ(idx));
        // Store colors without opacity multiplication - alpha is separate
        nonIndexedColors.push(
          colors[idx * 3],
          colors[idx * 3 + 1],
          colors[idx * 3 + 2],
        );
        nonIndexedAlphas.push(opacity);
        nonIndexedPartIDs.push(partIdx);
        nonIndexedPlayerMasks.push(path.playerMask ? 1 : 0);
      }

      // Replace the last added vertices with the expanded ones
      allPositions.splice(allPositions.length - vertexCount * 3);
      allColors.splice(allColors.length - vertexCount * 3);
      allAlphas.splice(allAlphas.length - vertexCount);
      allPartIDs.splice(allPartIDs.length - vertexCount);
      allPlayerMasks.splice(allPlayerMasks.length - vertexCount);

      allPositions.push(...nonIndexedPositions);
      allColors.push(...nonIndexedColors);
      allAlphas.push(...nonIndexedAlphas);
      allPartIDs.push(...nonIndexedPartIDs);
      allPlayerMasks.push(...nonIndexedPlayerMasks);
    }

    geometry.dispose();
  }

  if (allPositions.length === 0) return null;

  const mergedGeometry = new BufferGeometry();
  mergedGeometry.setAttribute(
    "position",
    new BufferAttribute(new Float32Array(allPositions), 3),
  );
  mergedGeometry.setAttribute(
    "color",
    new BufferAttribute(new Float32Array(allColors), 3),
  );
  mergedGeometry.setAttribute(
    "alpha",
    new BufferAttribute(new Float32Array(allAlphas), 1),
  );
  mergedGeometry.setAttribute(
    "partID",
    new BufferAttribute(new Float32Array(allPartIDs), 1),
  );
  mergedGeometry.setAttribute(
    "playerMask",
    new BufferAttribute(new Float32Array(allPlayerMasks), 1),
  );

  mergedGeometry.computeBoundingBox();
  mergedGeometry.computeBoundingSphere();

  return mergedGeometry;
}

/**
 * Create identity animation data (no animation, all parts at default pose).
 * This is useful for previewing models without any animation.
 */
export function createIdentityAnimationData(partCount: number): AnimationData {
  const sampleCount = 1; // Only one sample needed for static pose

  // Transform texture: R=tx, G=ty, B=rot, A=scale
  // Identity: tx=0, ty=0, rot=0, scale=1
  const transformData = new Float32Array(sampleCount * partCount * 4);
  for (let i = 0; i < partCount; i++) {
    const offset = i * 4;
    transformData[offset + 0] = 0; // tx
    transformData[offset + 1] = 0; // ty
    transformData[offset + 2] = 0; // rot
    transformData[offset + 3] = 1; // scale
  }

  const transformTexture = new DataTexture(
    transformData,
    sampleCount,
    partCount,
    RGBAFormat,
    FloatType,
  );
  transformTexture.needsUpdate = true;

  // Opacity texture: R=opacity
  // Identity: opacity=1
  const opacityData = new Float32Array(sampleCount * partCount);
  opacityData.fill(1);

  const opacityTexture = new DataTexture(
    opacityData,
    sampleCount,
    partCount,
    RedFormat,
    FloatType,
  );
  opacityTexture.needsUpdate = true;

  return {
    partCount,
    sampleCount,
    clips: new Map([["default", 0]]),
    transformTexture,
    opacityTexture,
  };
}

// Helper function to create geometry with vertex colors
function createVertexColoredGeometry(
  path: Path,
): { geometry: ShapeGeometry; colors: Float32Array } | null {
  if (path.segments.length === 0) return null;

  // Get colors for each anchor
  const fillColor = hexToRgbNormalized(path.fill);
  const numAnchors = path.closed ? path.segments.length : path.segments.length + 1;
  const anchorColors: { r: number; g: number; b: number }[] = [];
  for (let i = 0; i < numAnchors; i++) {
    const metaColor = path.anchorMeta?.[i]?.color;
    anchorColors.push(metaColor ? hexToRgbNormalized(metaColor) : fillColor);
  }

  // Sample points along the path
  const samplesPerSegment = 16;
  const pathPoints: { x: number; y: number }[] = [];
  const pathColors: { r: number; g: number; b: number }[] = [];

  for (let segIdx = 0; segIdx < path.segments.length; segIdx++) {
    const seg = path.segments[segIdx];
    const nextIdx = path.closed
      ? (segIdx + 1) % path.segments.length
      : segIdx + 1;
    const startColor = anchorColors[segIdx];
    const endColor = anchorColors[nextIdx];

    for (let i = 0; i < samplesPerSegment; i++) {
      const t = i / samplesPerSegment;
      pathPoints.push(sampleBezier(seg.p0, seg.c0, seg.c1, seg.p1, t));
      pathColors.push(lerpRgb(startColor, endColor, t));
    }
  }

  // Create shape from sampled points
  const shape = new Shape();
  shape.moveTo(pathPoints[0].x, pathPoints[0].y);
  for (let i = 1; i < pathPoints.length; i++) {
    shape.lineTo(pathPoints[i].x, pathPoints[i].y);
  }
  if (path.closed) {
    shape.closePath();
  }

  const geometry = new ShapeGeometry(shape);

  // Map colors to vertices
  const positions = geometry.getAttribute("position");
  const colors = new Float32Array(positions.count * 3);

  for (let i = 0; i < positions.count; i++) {
    const vx = positions.getX(i);
    const vy = positions.getY(i);

    // Find closest path point
    let closestIdx = 0;
    let closestDist = Infinity;
    for (let j = 0; j < pathPoints.length; j++) {
      const dx = pathPoints[j].x - vx;
      const dy = pathPoints[j].y - vy;
      const dist = dx * dx + dy * dy;
      if (dist < closestDist) {
        closestDist = dist;
        closestIdx = j;
      }
    }

    const color = pathColors[closestIdx];
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }

  return { geometry, colors };
}
