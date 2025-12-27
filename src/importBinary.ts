/**
 * Import estb binary format back into editor format.
 */

import { Path, Group, CubicSegment, Point, defaultAnchorMeta, defaultTransform, AnchorMeta } from "./types.ts";
import { AnimationClip, UnifiedKeyframe } from "./animation.ts";
import { BinaryReader, float16ToFloat } from "./exportBinary.ts";

type ParsedPath = {
  fill: { r: number; g: number; b: number };
  opacity: number;
  playerMask: boolean;
  parentIdx: number | null;
  transformPoint: Point | null;
  segments: CubicSegment[];
  vertexColors: ({ r: number; g: number; b: number } | null)[] | null;
};

type ParsedGroup = {
  parentIdx: number | null;
  transformPoint: Point | null;
};

type ParsedKeyframe = {
  t: number;
  tx?: number;
  ty?: number;
  rot?: number;
  scale?: number;
  opacity?: number;
};

type ParsedClip = {
  name: string;
  duration: number;
  fps: number;
  parts: Map<number, ParsedKeyframe[]>;
};

const intToRgb = (n: number): { r: number; g: number; b: number } => ({
  r: ((n >> 16) & 0xff) / 255,
  g: ((n >> 8) & 0xff) / 255,
  b: (n & 0xff) / 255,
});

const rgbToHex = (rgb: { r: number; g: number; b: number }): string => {
  const r = Math.round(rgb.r * 255);
  const g = Math.round(rgb.g * 255);
  const b = Math.round(rgb.b * 255);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
};

function parseEstb(buffer: ArrayBuffer): { paths: ParsedPath[]; groups: ParsedGroup[]; clips: ParsedClip[] } {
  const r = new BinaryReader(buffer);

  // Read header
  const magic0 = r.readU8();
  const magic1 = r.readU8();
  const magic2 = r.readU8();
  const version = r.readU8();

  if (magic0 !== 0x45 || magic1 !== 0x53 || magic2 !== 0x54) {
    throw new Error("Invalid estb file: bad magic");
  }
  if (version !== 3) throw new Error(`Unsupported estb version: ${version}`);

  // Read counts
  const pathCount = r.readU16();
  const groupCount = r.readU16();
  const clipCount = r.readU16();

  // Read paths
  const paths: ParsedPath[] = [];
  for (let i = 0; i < pathCount; i++) {
    const flags = r.readU8();
    const playerMask = (flags & 1) !== 0;
    const hasParent = (flags & 2) !== 0;
    const hasTP = (flags & 4) !== 0;
    const hasVC = (flags & 8) !== 0;

    const fill = intToRgb(r.readU24());
    const opacity = r.readU8() / 255;

    const parentIdx = hasParent ? r.readU16() : null;
    const transformPoint = hasTP ? { x: r.readF16(), y: r.readF16() } : null;

    const segmentCount = r.readU16();
    const segments: CubicSegment[] = [];
    for (let s = 0; s < segmentCount; s++) {
      segments.push({
        p0: { x: r.readF16(), y: r.readF16() },
        c0: { x: r.readF16(), y: r.readF16() },
        c1: { x: r.readF16(), y: r.readF16() },
        p1: { x: r.readF16(), y: r.readF16() },
      });
    }

    let vertexColors: ({ r: number; g: number; b: number } | null)[] | null = null;
    if (hasVC) {
      vertexColors = [];
      for (let v = 0; v < segmentCount; v++) {
        const c = r.readU24();
        vertexColors.push(c === 0 ? null : intToRgb(c));
      }
    }

    paths.push({
      fill,
      opacity,
      playerMask,
      parentIdx,
      transformPoint,
      segments,
      vertexColors,
    });
  }

  // Read groups
  const groups: ParsedGroup[] = [];
  for (let i = 0; i < groupCount; i++) {
    const flags = r.readU8();
    const hasParent = (flags & 1) !== 0;
    const hasTP = (flags & 2) !== 0;

    const parentIdx = hasParent ? r.readU16() : null;
    const transformPoint = hasTP ? { x: r.readF16(), y: r.readF16() } : null;

    groups.push({ parentIdx, transformPoint });
  }

  // Read clips
  const clips: ParsedClip[] = [];
  for (let i = 0; i < clipCount; i++) {
    const name = r.readString();
    const duration = r.readF32();
    const fps = r.readU8();
    const partCount = r.readU16();

    const parts = new Map<number, ParsedKeyframe[]>();

    for (let p = 0; p < partCount; p++) {
      const partIdx = r.readI16();
      const keyframeCount = r.readU16();

      const keyframes: ParsedKeyframe[] = [];
      for (let k = 0; k < keyframeCount; k++) {
        const t = r.readF16();
        const flags = r.readU8();

        const kf: ParsedKeyframe = { t };
        if (flags & 1) kf.tx = r.readF16();
        if (flags & 2) kf.ty = r.readF16();
        if (flags & 4) kf.rot = r.readF16();
        if (flags & 8) kf.scale = r.readF16();
        if (flags & 16) kf.opacity = r.readF16();

        keyframes.push(kf);
      }

      parts.set(partIdx, keyframes);
    }

    clips.push({ name, duration, fps, parts });
  }

  return { paths, groups, clips };
}

export type ImportedDocument = {
  paths: Path[];
  groups: Group[];
  animationClips: AnimationClip[];
  pathCounter: number;
  groupCounter: number;
};

export function importBinary(buffer: ArrayBuffer, startPathCounter: number = 1, startGroupCounter: number = 1): ImportedDocument {
  const { paths: parsedPaths, groups: parsedGroups, clips: parsedClips } = parseEstb(buffer);

  // Create IDs for groups first (since paths reference them)
  const groupIds: string[] = [];
  const groups: Group[] = [];

  for (let i = 0; i < parsedGroups.length; i++) {
    const id = crypto.randomUUID();
    groupIds.push(id);
  }

  // Now create groups with proper parent references
  for (let i = 0; i < parsedGroups.length; i++) {
    const pg = parsedGroups[i];
    groups.push({
      id: groupIds[i],
      name: `Group ${startGroupCounter + i}`,
      parentId: pg.parentIdx !== null ? groupIds[pg.parentIdx] : null,
      collapsed: false,
      transformPoint: pg.transformPoint,
    });
  }

  // Create paths with proper parent references
  const pathIds: string[] = [];
  const paths: Path[] = [];

  for (let i = 0; i < parsedPaths.length; i++) {
    const pp = parsedPaths[i];
    const id = crypto.randomUUID();
    pathIds.push(id);

    // Build anchor metadata from vertex colors
    const anchorMeta: AnchorMeta[] = pp.segments.map((_, idx) => {
      const meta = defaultAnchorMeta();
      if (pp.vertexColors && pp.vertexColors[idx]) {
        meta.color = rgbToHex(pp.vertexColors[idx]!);
      }
      return meta;
    });

    paths.push({
      id,
      name: `Path ${startPathCounter + i}`,
      parentId: pp.parentIdx !== null ? groupIds[pp.parentIdx] : null,
      segments: pp.segments,
      anchorMeta,
      closed: true, // estb only exports closed paths
      fill: rgbToHex(pp.fill),
      opacity: pp.opacity,
      visible: true,
      locked: false,
      playerMask: pp.playerMask,
      transform: defaultTransform(),
      transformPoint: pp.transformPoint,
    });
  }

  // Create animation clips with proper ID references
  const animationClips: AnimationClip[] = parsedClips.map((pc) => {
    const parts: Record<string, UnifiedKeyframe[]> = {};

    for (const [partIdx, keyframes] of pc.parts) {
      let partId: string;
      if (partIdx >= 0) {
        // Path index
        partId = pathIds[partIdx];
      } else {
        // Group index (negative, -1 means group 0)
        partId = groupIds[-(partIdx + 1)];
      }

      if (partId) {
        parts[partId] = keyframes.map((kf) => {
          const ukf: UnifiedKeyframe = { t: kf.t };
          if (kf.tx !== undefined) ukf.tx = kf.tx;
          if (kf.ty !== undefined) ukf.ty = kf.ty;
          if (kf.rot !== undefined) ukf.rot = kf.rot;
          if (kf.scale !== undefined) ukf.scale = kf.scale;
          if (kf.opacity !== undefined) ukf.opacity = kf.opacity;
          return ukf;
        });
      }
    }

    return {
      id: crypto.randomUUID(),
      name: pc.name,
      duration: pc.duration,
      fps: pc.fps,
      parts,
    };
  });

  return {
    paths,
    groups,
    animationClips,
    pathCounter: startPathCounter + parsedPaths.length,
    groupCounter: startGroupCounter + parsedGroups.length,
  };
}
