import { Path, PathTransform, Point, Group } from "./types.ts";
import { getPathTransformPoint, getGroupTransformPoint } from "./geometry.ts";

// Animatable properties per the spec
export type AnimatableProperty = "tx" | "ty" | "rot" | "scale" | "opacity";

// A unified keyframe at a specific time with optional values for each property
export type UnifiedKeyframe = {
  t: number; // Time in seconds (0 to duration)
  tx?: number;
  ty?: number;
  rot?: number;
  scale?: number;
  opacity?: number;
};

// Animation data for a single part/path - array of unified keyframes sorted by time
export type PartAnimation = UnifiedKeyframe[];

// A single animation clip
export type AnimationClip = {
  id: string;
  name: string;
  duration: number; // In seconds
  fps: number; // Frames per second for baking (e.g., 60)
  // Animations keyed by path/group ID
  // If defined on a group, applies to all descendant paths
  parts: Record<string, PartAnimation>;
};

// Default values for each property
export const defaultPropertyValues: Record<AnimatableProperty, number> = {
  tx: 0,
  ty: 0,
  rot: 0,
  scale: 1,
  opacity: 1,
};

// Property colors for visual distinction
export const propertyColors: Record<AnimatableProperty, string> = {
  tx: "#ff6b6b",     // Red
  ty: "#6baaff",     // Blue
  rot: "#ffd93d",    // Yellow/Gold
  scale: "#6bcf6b",  // Green
  opacity: "#cc77ff", // Purple/Magenta
};

// All animatable properties in order
export const ANIMATABLE_PROPERTIES: AnimatableProperty[] = ["tx", "ty", "rot", "scale", "opacity"];

// Get value of a property at time t by interpolating keyframes
export function getPropertyValue(
  keyframes: PartAnimation | undefined,
  property: AnimatableProperty,
  t: number,
): number {
  if (!keyframes || keyframes.length === 0) {
    return defaultPropertyValues[property];
  }

  // Find keyframes that have this property set
  const relevantKeyframes = keyframes.filter((kf) => kf[property] !== undefined);
  if (relevantKeyframes.length === 0) {
    return defaultPropertyValues[property];
  }

  if (relevantKeyframes.length === 1) {
    return relevantKeyframes[0][property]!;
  }

  // Find surrounding keyframes
  let left = relevantKeyframes[0];
  let right = relevantKeyframes[relevantKeyframes.length - 1];

  for (let i = 0; i < relevantKeyframes.length - 1; i++) {
    if (relevantKeyframes[i].t <= t && relevantKeyframes[i + 1].t >= t) {
      left = relevantKeyframes[i];
      right = relevantKeyframes[i + 1];
      break;
    }
  }

  // Clamp to first/last keyframe
  if (t <= left.t) return left[property]!;
  if (t >= right.t) return right[property]!;

  // Linear interpolation
  const dt = right.t - left.t;
  if (dt === 0) return left[property]!;
  const alpha = (t - left.t) / dt;
  return left[property]! + (right[property]! - left[property]!) * alpha;
}

// Create a default animation clip
export function createDefaultClip(name: string = "idle"): AnimationClip {
  return {
    id: crypto.randomUUID(),
    name,
    duration: 1.0,
    fps: 60,
    parts: {},
  };
}

// Get or create a keyframe at a specific time
export function getOrCreateKeyframe(
  keyframes: PartAnimation,
  t: number,
): { keyframes: PartAnimation; index: number } {
  // Check if keyframe exists at this time
  const existingIndex = keyframes.findIndex((kf) => Math.abs(kf.t - t) < 0.0001);
  if (existingIndex >= 0) {
    return { keyframes, index: existingIndex };
  }

  // Create new keyframe
  const newKeyframes = [...keyframes, { t }];
  newKeyframes.sort((a, b) => a.t - b.t);
  const newIndex = newKeyframes.findIndex((kf) => Math.abs(kf.t - t) < 0.0001);
  return { keyframes: newKeyframes, index: newIndex };
}

// Set a property value on a keyframe at a specific time
export function setKeyframeProperty(
  keyframes: PartAnimation,
  t: number,
  property: AnimatableProperty,
  value: number,
): PartAnimation {
  const { keyframes: updated, index } = getOrCreateKeyframe(keyframes, t);
  // Always create a new array to avoid mutating the original
  const result = [...updated];
  result[index] = { ...result[index], [property]: value };
  return result;
}

// Unset a property on a keyframe at a specific time
// Keeps the keyframe even if empty (user can delete explicitly via Delete Keyframe button)
export function unsetKeyframeProperty(
  keyframes: PartAnimation,
  t: number,
  property: AnimatableProperty,
): PartAnimation {
  const index = keyframes.findIndex((kf) => Math.abs(kf.t - t) < 0.0001);
  if (index < 0) return keyframes;

  const kf = { ...keyframes[index] };
  delete kf[property];

  // Keep the keyframe even if no properties remain (user can delete explicitly)
  const result = [...keyframes];
  result[index] = kf;
  return result;
}

// Remove a keyframe at a specific time
export function removeKeyframe(keyframes: PartAnimation, t: number): PartAnimation {
  return keyframes.filter((kf) => Math.abs(kf.t - t) > 0.0001);
}

// Change the time of a keyframe
export function changeKeyframeTime(
  keyframes: PartAnimation,
  oldTime: number,
  newTime: number,
): PartAnimation {
  const index = keyframes.findIndex((kf) => Math.abs(kf.t - oldTime) < 0.0001);
  if (index < 0) return keyframes;

  // Check if there's already a keyframe at the new time
  const existingAtNew = keyframes.findIndex((kf) => Math.abs(kf.t - newTime) < 0.0001);
  if (existingAtNew >= 0 && existingAtNew !== index) {
    // Merge properties into existing keyframe
    const result = [...keyframes];
    result[existingAtNew] = { ...result[existingAtNew], ...result[index], t: newTime };
    result.splice(index, 1);
    return result;
  }

  // Just update the time
  const result = [...keyframes];
  result[index] = { ...result[index], t: newTime };
  result.sort((a, b) => a.t - b.t);
  return result;
}

// Get all unique keyframe times for a part
export function getKeyframeTimes(keyframes: PartAnimation): number[] {
  return keyframes.map((kf) => kf.t);
}

// Get which properties are set on a keyframe at a specific time
export function getKeyframeProperties(keyframes: PartAnimation, t: number): AnimatableProperty[] {
  const kf = keyframes.find((k) => Math.abs(k.t - t) < 0.0001);
  if (!kf) return [];
  return ANIMATABLE_PROPERTIES.filter((p) => kf[p] !== undefined);
}

// Calculate the translation offset needed to rotate around a pivot point instead of origin
// When rotating by angle θ around pivot P, the offset is: P - rotate(P, θ)
function getPivotOffset(pivot: Point, rot: number, scale: number): Point {
  if (Math.abs(rot) < 0.0001 && Math.abs(scale - 1) < 0.0001) {
    return { x: 0, y: 0 };
  }

  const cos = Math.cos(rot);
  const sin = Math.sin(rot);

  // After scale and rotation around origin, pivot P would move to:
  // (P.x * scale * cos - P.y * scale * sin, P.x * scale * sin + P.y * scale * cos)
  // To keep it at P, we need to add: P - rotatedScaledP
  const rotatedX = pivot.x * scale * cos - pivot.y * scale * sin;
  const rotatedY = pivot.x * scale * sin + pivot.y * scale * cos;

  return {
    x: pivot.x - rotatedX,
    y: pivot.y - rotatedY,
  };
}

// Get the effective transform for a path at a given time
// Combines the path's base transform with any animation keyframes
// Also combines transforms from ancestor groups (parent-to-child order)
// The ancestorChain contains Group objects with their transform points
export function getEffectiveTransform(
  path: Path,
  clip: AnimationClip | null,
  t: number,
  ancestorChain: Group[] = [], // Parent groups from root to immediate parent
): PathTransform & { opacity: number } {
  const base = path.transform;

  if (!clip) {
    return { ...base, opacity: path.opacity };
  }

  // Start with identity transform
  let combinedTx = 0;
  let combinedTy = 0;
  let combinedRot = 0;
  let combinedScale = 1;
  let combinedOpacity = 1;

  // Track if any ancestor has set opacity via keyframes
  let anyAncestorHasOpacityKeyframes = false;

  // Apply ancestor transforms in order (root to immediate parent)
  for (const ancestor of ancestorChain) {
    const ancestorAnim = clip.parts[ancestor.id];
    if (ancestorAnim && ancestorAnim.length > 0) {
      // Get ancestor's transform at this time
      const aTx = getPropertyValue(ancestorAnim, "tx", t);
      const aTy = getPropertyValue(ancestorAnim, "ty", t);
      const aRot = getPropertyValue(ancestorAnim, "rot", t);
      const aScale = getPropertyValue(ancestorAnim, "scale", t);
      // For opacity: use animated value if keyframes exist, otherwise 1 (inherit from further up)
      const hasAncestorOpacityKeyframes = ancestorAnim.some((kf) => kf.opacity !== undefined);
      if (hasAncestorOpacityKeyframes) {
        anyAncestorHasOpacityKeyframes = true;
      }
      const aOpacity = hasAncestorOpacityKeyframes
        ? getPropertyValue(ancestorAnim, "opacity", t)
        : 1;

      // Get the ancestor's transform point for rotation pivot
      // Note: For groups, we'd need all paths/groups to compute dynamic center
      // For now, use the stored transform point if set, otherwise origin
      const pivot = ancestor.transformPoint ?? { x: 0, y: 0 };

      // Calculate pivot offset for this ancestor's rotation/scale
      const pivotOffset = getPivotOffset(pivot, aRot, aScale);

      // Apply ancestor transform to current accumulated transform
      // First rotate and scale the current translation
      const cos = Math.cos(aRot);
      const sin = Math.sin(aRot);
      const rotatedTx = combinedTx * cos - combinedTy * sin;
      const rotatedTy = combinedTx * sin + combinedTy * cos;

      // Combine: scale current, add ancestor translation + pivot offset
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
  // For opacity:
  // - If path has opacity keyframes, use animated value (first keyframe as initial)
  // - If no keyframes but ancestor has opacity keyframes, use 1 (fully controlled by ancestor)
  // - If no one in the chain has opacity keyframes, use base path opacity
  const hasOpacityKeyframes = partAnim?.some((kf) => kf.opacity !== undefined) ?? false;
  const pathOpacity = hasOpacityKeyframes
    ? getPropertyValue(partAnim, "opacity", t)
    : (anyAncestorHasOpacityKeyframes ? 1 : path.opacity);

  // Get the path's transform point for rotation pivot
  const pathPivot = getPathTransformPoint(path);

  // Calculate pivot offset for path's own rotation/scale
  const pathPivotOffset = getPivotOffset(pathPivot, pathRot, pathScale);

  // Apply parent transform to path's local transform
  const cos = Math.cos(combinedRot);
  const sin = Math.sin(combinedRot);
  const rotatedPathTx = (pathTx + pathPivotOffset.x) * cos - (pathTy + pathPivotOffset.y) * sin;
  const rotatedPathTy = (pathTx + pathPivotOffset.x) * sin + (pathTy + pathPivotOffset.y) * cos;

  return {
    tx: combinedTx + rotatedPathTx * combinedScale,
    ty: combinedTy + rotatedPathTy * combinedScale,
    rot: combinedRot + pathRot,
    scale: combinedScale * pathScale,
    opacity: combinedOpacity * pathOpacity,
  };
}

// Legacy compatibility: Keyframe type for old code
export type Keyframe = {
  t: number;
  v: number;
};
