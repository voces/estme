/**
 * Export estme documents to a Three.js-compatible format.
 *
 * The export format contains:
 * - Pre-triangulated geometry with all vertex attributes
 * - Baked animation textures for GPU-driven animation
 * - Part mapping and clip metadata
 */

import { Path, Group } from "./types.ts";
import { AnimationClip, getPropertyValue, ANIMATABLE_PROPERTIES, defaultPropertyValues } from "./animation.ts";
import { hexToRgbNormalized, sampleBezier, lerpRgb, getPathTransformPoint, getGroupTransformPoint } from "./geometry.ts";
import { Shape, ShapeGeometry } from "three";

/**
 * Exported model format - JSON serializable
 */
export interface ExportedModel {
  version: 1;
  name: string;

  // Geometry data (all Float32Array encoded as base64)
  geometry: {
    vertexCount: number;
    // Each attribute is base64-encoded Float32Array
    position: string; // vec3 per vertex
    color: string; // vec3 per vertex
    alpha: string; // float per vertex
    partID: string; // float per vertex
    playerMask: string; // float per vertex
  };

  // Part metadata
  parts: {
    id: string;
    name: string;
    index: number;
  }[];

  // Animation data
  animation: {
    partCount: number;
    sampleCount: number; // samples per clip
    clipCount: number;
    fps: number; // common FPS for all clips
    clips: { name: string; duration: number; index: number }[];
    // Transform texture: RGBA per sample per part per clip
    // Layout: [clip0: [part0: [sample0, sample1, ...], part1: [...], ...], clip1: [...], ...]
    // R=tx, G=ty, B=rot, A=scale
    transformData: string; // base64 Float32Array
    // Opacity texture: R per sample per part per clip
    opacityData: string; // base64 Float32Array
  };
}

// Helper to encode Float32Array as base64
function encodeFloat32ArrayToBase64(arr: Float32Array): string {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// Calculate pivot offset for rotation around a point
function getPivotOffset(pivot: { x: number; y: number }, rot: number, scale: number): { x: number; y: number } {
  if (Math.abs(rot) < 0.0001 && Math.abs(scale - 1) < 0.0001) {
    return { x: 0, y: 0 };
  }

  const cos = Math.cos(rot);
  const sin = Math.sin(rot);

  const rotatedX = pivot.x * scale * cos - pivot.y * scale * sin;
  const rotatedY = pivot.x * scale * sin + pivot.y * scale * cos;

  return {
    x: pivot.x - rotatedX,
    y: pivot.y - rotatedY,
  };
}

/**
 * Export an estme document to Three.js format.
 */
export function exportToThreeJS(
  name: string,
  paths: Path[],
  groups: Group[],
  clips: AnimationClip[],
): ExportedModel {
  // Filter to visible paths only
  const visiblePaths = paths.filter((p) => p.visible);

  if (visiblePaths.length === 0) {
    throw new Error("No visible paths to export");
  }

  // Build geometry
  const geometry = buildGeometry(visiblePaths);

  // Build part metadata
  const partsMetadata = visiblePaths.map((path, index) => ({
    id: path.id,
    name: path.name,
    index,
  }));

  // Build animation data
  const animation = buildAnimationData(visiblePaths, groups, clips);

  return {
    version: 1,
    name,
    geometry,
    parts: partsMetadata,
    animation,
  };
}

/**
 * Build geometry data for export.
 */
function buildGeometry(paths: Path[]): ExportedModel["geometry"] {
  const allPositions: number[] = [];
  const allColors: number[] = [];
  const allAlphas: number[] = [];
  const allPartIDs: number[] = [];
  const allPlayerMasks: number[] = [];

  for (let partIdx = 0; partIdx < paths.length; partIdx++) {
    const path = paths[partIdx];
    if (path.segments.length === 0) continue;

    // Check if path has vertex colors
    const hasVertexColors = path.anchorMeta?.some((meta) => meta.color !== null) ?? false;

    let shape: Shape;
    let pathPoints: { x: number; y: number }[] | null = null;
    let pathColors: { r: number; g: number; b: number }[] | null = null;

    if (hasVertexColors) {
      // Sample points along the path for vertex colors
      const fillColor = hexToRgbNormalized(path.fill);
      const numAnchors = path.closed ? path.segments.length : path.segments.length + 1;
      const anchorColors: { r: number; g: number; b: number }[] = [];
      for (let i = 0; i < numAnchors; i++) {
        const metaColor = path.anchorMeta?.[i]?.color;
        anchorColors.push(metaColor ? hexToRgbNormalized(metaColor) : fillColor);
      }

      const samplesPerSegment = 16;
      pathPoints = [];
      pathColors = [];

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

      shape = new Shape();
      shape.moveTo(pathPoints[0].x, pathPoints[0].y);
      for (let i = 1; i < pathPoints.length; i++) {
        shape.lineTo(pathPoints[i].x, pathPoints[i].y);
      }
      if (path.closed) {
        shape.closePath();
      }
    } else {
      // Create shape from bezier segments
      shape = new Shape();
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
    }

    const geometry = hasVertexColors ? new ShapeGeometry(shape) : new ShapeGeometry(shape, 32);

    // Get colors
    const positions = geometry.attributes.position;
    const vertexCount = positions.count;
    const colors: Float32Array = new Float32Array(vertexCount * 3);

    if (hasVertexColors && pathPoints && pathColors) {
      // Map colors to vertices
      for (let i = 0; i < vertexCount; i++) {
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
    } else {
      // Uniform color from path fill
      const fillColor = hexToRgbNormalized(path.fill);
      for (let i = 0; i < vertexCount; i++) {
        colors[i * 3] = fillColor.r;
        colors[i * 3 + 1] = fillColor.g;
        colors[i * 3 + 2] = fillColor.b;
      }
    }

    // Handle indexed geometry
    const indices = geometry.index;
    if (indices) {
      // Expand indexed geometry to non-indexed
      for (let i = 0; i < indices.count; i++) {
        const idx = indices.getX(i);
        allPositions.push(positions.getX(idx), positions.getY(idx), positions.getZ(idx));
        allColors.push(colors[idx * 3], colors[idx * 3 + 1], colors[idx * 3 + 2]);
        allAlphas.push(path.opacity);
        allPartIDs.push(partIdx);
        allPlayerMasks.push(path.playerMask ? 1 : 0);
      }
    } else {
      // Non-indexed geometry
      for (let i = 0; i < vertexCount; i++) {
        allPositions.push(positions.getX(i), positions.getY(i), positions.getZ(i));
        allColors.push(colors[i * 3], colors[i * 3 + 1], colors[i * 3 + 2]);
        allAlphas.push(path.opacity);
        allPartIDs.push(partIdx);
        allPlayerMasks.push(path.playerMask ? 1 : 0);
      }
    }

    geometry.dispose();
  }

  return {
    vertexCount: allPositions.length / 3,
    position: encodeFloat32ArrayToBase64(new Float32Array(allPositions)),
    color: encodeFloat32ArrayToBase64(new Float32Array(allColors)),
    alpha: encodeFloat32ArrayToBase64(new Float32Array(allAlphas)),
    partID: encodeFloat32ArrayToBase64(new Float32Array(allPartIDs)),
    playerMask: encodeFloat32ArrayToBase64(new Float32Array(allPlayerMasks)),
  };
}

/**
 * Build animation data for export.
 * Bakes all animations into textures at a fixed sample rate.
 */
function buildAnimationData(
  paths: Path[],
  groups: Group[],
  clips: AnimationClip[],
): ExportedModel["animation"] {
  const partCount = paths.length;

  // If no clips, create a default "idle" with identity transforms
  if (clips.length === 0) {
    const sampleCount = 1;
    const transformData = new Float32Array(sampleCount * partCount * 4);
    const opacityData = new Float32Array(sampleCount * partCount);

    for (let p = 0; p < partCount; p++) {
      transformData[p * 4 + 0] = 0; // tx
      transformData[p * 4 + 1] = 0; // ty
      transformData[p * 4 + 2] = 0; // rot
      transformData[p * 4 + 3] = 1; // scale
      opacityData[p] = 1; // opacity
    }

    return {
      partCount,
      sampleCount,
      clipCount: 1,
      fps: 60,
      clips: [{ name: "default", duration: 0, index: 0 }],
      transformData: encodeFloat32ArrayToBase64(transformData),
      opacityData: encodeFloat32ArrayToBase64(opacityData),
    };
  }

  // Use the FPS of the first clip (typically all clips have the same FPS)
  const fps = clips[0].fps;

  // Calculate sample count based on longest clip
  const maxDuration = Math.max(...clips.map((c) => c.duration));
  const sampleCount = Math.max(1, Math.ceil(maxDuration * fps));

  // Build group lookup for ancestor chains
  const groupMap = new Map(groups.map((g) => [g.id, g]));

  // Function to get ancestor chain for a path
  function getAncestorChain(path: Path): Group[] {
    const chain: Group[] = [];
    let parentId = path.parentId;
    while (parentId) {
      const parent = groupMap.get(parentId);
      if (!parent) break;
      chain.unshift(parent); // Add at beginning to maintain root-to-parent order
      parentId = parent.parentId;
    }
    return chain;
  }

  // Allocate data arrays
  // Layout: clip0[part0[sample0..N], part1[sample0..N], ...], clip1[...], ...
  const clipCount = clips.length;
  const totalSamples = sampleCount * partCount * clipCount;
  const transformData = new Float32Array(totalSamples * 4);
  const opacityData = new Float32Array(totalSamples);

  // Bake each clip
  for (let clipIdx = 0; clipIdx < clips.length; clipIdx++) {
    const clip = clips[clipIdx];
    const clipOffset = clipIdx * partCount * sampleCount;

    // Calculate samples for this clip
    for (let sampleIdx = 0; sampleIdx < sampleCount; sampleIdx++) {
      // Time for this sample (loop within clip duration)
      const t = clip.duration > 0
        ? (sampleIdx / sampleCount) * clip.duration
        : 0;

      // Sample each part
      for (let partIdx = 0; partIdx < partCount; partIdx++) {
        const path = paths[partIdx];
        const ancestorChain = getAncestorChain(path);

        // Calculate effective transform (same logic as getEffectiveTransform)
        let combinedTx = 0;
        let combinedTy = 0;
        let combinedRot = 0;
        let combinedScale = 1;
        let combinedOpacity = 1;

        // Apply ancestor transforms
        for (const ancestor of ancestorChain) {
          const ancestorAnim = clip.parts[ancestor.id];
          if (ancestorAnim && ancestorAnim.length > 0) {
            const aTx = getPropertyValue(ancestorAnim, "tx", t);
            const aTy = getPropertyValue(ancestorAnim, "ty", t);
            const aRot = getPropertyValue(ancestorAnim, "rot", t);
            const aScale = getPropertyValue(ancestorAnim, "scale", t);
            const aOpacity = getPropertyValue(ancestorAnim, "opacity", t);

            const pivot = ancestor.transformPoint ?? { x: 0, y: 0 };
            const pivotOffset = getPivotOffset(pivot, aRot, aScale);

            const cos = Math.cos(aRot);
            const sin = Math.sin(aRot);
            const rotatedTx = combinedTx * cos - combinedTy * sin;
            const rotatedTy = combinedTx * sin + combinedTy * cos;

            combinedTx = rotatedTx * aScale + aTx + pivotOffset.x;
            combinedTy = rotatedTy * aScale + aTy + pivotOffset.y;
            combinedRot += aRot;
            combinedScale *= aScale;
            combinedOpacity *= aOpacity;
          }
        }

        // Apply path's own animation
        const partAnim = clip.parts[path.id];
        const pathTx = getPropertyValue(partAnim, "tx", t);
        const pathTy = getPropertyValue(partAnim, "ty", t);
        const pathRot = getPropertyValue(partAnim, "rot", t);
        const pathScale = getPropertyValue(partAnim, "scale", t);
        const pathOpacity = getPropertyValue(partAnim, "opacity", t);

        const pathPivot = getPathTransformPoint(path);
        const pathPivotOffset = getPivotOffset(pathPivot, pathRot, pathScale);

        const cos = Math.cos(combinedRot);
        const sin = Math.sin(combinedRot);
        const rotatedPathTx = (pathTx + pathPivotOffset.x) * cos - (pathTy + pathPivotOffset.y) * sin;
        const rotatedPathTy = (pathTx + pathPivotOffset.x) * sin + (pathTy + pathPivotOffset.y) * cos;

        const finalTx = combinedTx + rotatedPathTx * combinedScale;
        const finalTy = combinedTy + rotatedPathTy * combinedScale;
        const finalRot = combinedRot + pathRot;
        const finalScale = combinedScale * pathScale;
        const finalOpacity = combinedOpacity * pathOpacity;

        // Store in texture data
        // Layout: transform[clipOffset + partIdx * sampleCount + sampleIdx]
        const dataIdx = clipOffset + partIdx * sampleCount + sampleIdx;
        transformData[dataIdx * 4 + 0] = finalTx;
        transformData[dataIdx * 4 + 1] = finalTy;
        transformData[dataIdx * 4 + 2] = finalRot;
        transformData[dataIdx * 4 + 3] = finalScale;
        opacityData[dataIdx] = finalOpacity;
      }
    }
  }

  return {
    partCount,
    sampleCount,
    clipCount,
    fps,
    clips: clips.map((c, i) => ({ name: c.name, duration: c.duration, index: i })),
    transformData: encodeFloat32ArrayToBase64(transformData),
    opacityData: encodeFloat32ArrayToBase64(opacityData),
  };
}
