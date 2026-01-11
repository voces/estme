/**
 * Binary export format for estme models.
 *
 * Uses Float16 for coordinates (sufficient precision for SVG-scale graphics).
 * Much smaller than JSON.
 *
 * Format:
 * - Header: "EST\x03" (4 bytes) - magic + version 3
 * - PathCount: u16
 * - GroupCount: u16
 * - ClipCount: u16
 * - Paths[]
 * - Groups[]
 * - Clips[]
 *
 * Path:
 * - flags: u8 (bit 0: playerMask, bit 1: hasParent, bit 2: hasTransformPoint, bit 3: hasVertexColors)
 * - fill: u24 (RGB)
 * - opacity: u8
 * - parentIdx: u16 (if hasParent)
 * - transformPoint: f16 x 2 (if hasTransformPoint)
 * - segmentCount: u16
 * - segments: f16 x 8 x segmentCount (p0x, p0y, c0x, c0y, c1x, c1y, p1x, p1y)
 * - vertexColors: u24 x segmentCount (if hasVertexColors)
 *
 * Group:
 * - flags: u8 (bit 0: hasParent, bit 1: hasTransformPoint)
 * - parentIdx: u16 (if hasParent)
 * - transformPoint: f16 x 2 (if hasTransformPoint)
 *
 * Clip:
 * - nameLen: u8
 * - name: u8 x nameLen
 * - duration: f32
 * - fps: u8
 * - partCount: u16
 * - Parts[]:
 *   - partIdx: i16 (negative for groups)
 *   - keyframeCount: u16
 *   - Keyframes[]:
 *     - t: f16
 *     - flags: u8 (bit 0-4: has tx,ty,rot,scale,opacity)
 *     - values: f16 x popcount(flags)
 */

import { Path, Group, CubicSegment } from "./types.ts";
import { AnimationClip } from "./animation.ts";
import { averageColors, getAnchorColor } from "./geometry.ts";

// Float16 encoding/decoding
function floatToFloat16(value: number): number {
  const floatView = new Float32Array(1);
  const int32View = new Int32Array(floatView.buffer);
  floatView[0] = value;
  const f = int32View[0];

  const sign = (f >> 31) & 0x1;
  let exp = (f >> 23) & 0xff;
  let frac = f & 0x7fffff;

  if (exp === 0xff) {
    // Inf/NaN
    return (sign << 15) | 0x7c00 | (frac ? 0x200 : 0);
  }

  exp = exp - 127 + 15;

  if (exp >= 31) {
    // Overflow -> Inf
    return (sign << 15) | 0x7c00;
  }

  if (exp <= 0) {
    // Underflow -> denormal or zero
    if (exp < -10) return sign << 15;
    frac = (frac | 0x800000) >> (1 - exp);
    return (sign << 15) | (frac >> 13);
  }

  return (sign << 15) | (exp << 10) | (frac >> 13);
}

function float16ToFloat(h: number): number {
  const sign = (h >> 15) & 0x1;
  const exp = (h >> 10) & 0x1f;
  const frac = h & 0x3ff;

  if (exp === 0) {
    if (frac === 0) return sign ? -0 : 0;
    // Denormal
    let e = -14;
    let m = frac;
    while ((m & 0x400) === 0) { m <<= 1; e--; }
    m &= 0x3ff;
    const floatView = new Float32Array(1);
    const int32View = new Int32Array(floatView.buffer);
    int32View[0] = (sign << 31) | ((e + 127) << 23) | (m << 13);
    return floatView[0];
  }

  if (exp === 31) {
    return frac ? NaN : (sign ? -Infinity : Infinity);
  }

  const floatView = new Float32Array(1);
  const int32View = new Int32Array(floatView.buffer);
  int32View[0] = (sign << 31) | ((exp - 15 + 127) << 23) | (frac << 13);
  return floatView[0];
}

class BinaryWriter {
  private buffer: ArrayBuffer;
  private view: DataView;
  private pos = 0;

  constructor(initialSize = 4096) {
    this.buffer = new ArrayBuffer(initialSize);
    this.view = new DataView(this.buffer);
  }

  private ensure(bytes: number) {
    if (this.pos + bytes > this.buffer.byteLength) {
      const newSize = Math.max(this.buffer.byteLength * 2, this.pos + bytes);
      const newBuffer = new ArrayBuffer(newSize);
      new Uint8Array(newBuffer).set(new Uint8Array(this.buffer));
      this.buffer = newBuffer;
      this.view = new DataView(this.buffer);
    }
  }

  writeU8(v: number) {
    this.ensure(1);
    this.view.setUint8(this.pos++, v);
  }

  writeU16(v: number) {
    this.ensure(2);
    this.view.setUint16(this.pos, v, true);
    this.pos += 2;
  }

  writeI16(v: number) {
    this.ensure(2);
    this.view.setInt16(this.pos, v, true);
    this.pos += 2;
  }

  writeU24(v: number) {
    this.ensure(3);
    this.view.setUint8(this.pos++, v & 0xff);
    this.view.setUint8(this.pos++, (v >> 8) & 0xff);
    this.view.setUint8(this.pos++, (v >> 16) & 0xff);
  }

  writeF16(v: number) {
    this.writeU16(floatToFloat16(v));
  }

  writeF32(v: number) {
    this.ensure(4);
    this.view.setFloat32(this.pos, v, true);
    this.pos += 4;
  }

  writeString(s: string) {
    const bytes = new TextEncoder().encode(s);
    this.writeU8(bytes.length);
    this.ensure(bytes.length);
    new Uint8Array(this.buffer, this.pos, bytes.length).set(bytes);
    this.pos += bytes.length;
  }

  getBuffer(): ArrayBuffer {
    return this.buffer.slice(0, this.pos);
  }
}

class BinaryReader {
  private view: DataView;
  private pos = 0;

  constructor(buffer: ArrayBuffer) {
    this.view = new DataView(buffer);
  }

  readU8(): number {
    return this.view.getUint8(this.pos++);
  }

  readU16(): number {
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  readI16(): number {
    const v = this.view.getInt16(this.pos, true);
    this.pos += 2;
    return v;
  }

  readU24(): number {
    const b0 = this.view.getUint8(this.pos++);
    const b1 = this.view.getUint8(this.pos++);
    const b2 = this.view.getUint8(this.pos++);
    return b0 | (b1 << 8) | (b2 << 16);
  }

  readF16(): number {
    return float16ToFloat(this.readU16());
  }

  readF32(): number {
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }

  readString(): string {
    const len = this.readU8();
    const bytes = new Uint8Array(this.view.buffer, this.pos, len);
    this.pos += len;
    return new TextDecoder().decode(bytes);
  }
}

function hexToInt(hex: string): number {
  return parseInt(hex.replace("#", ""), 16);
}

export function exportBinary(
  paths: Path[],
  groups: Group[],
  clips: AnimationClip[],
): ArrayBuffer {
  const visiblePaths = paths.filter((p) => p.visible);

  // Build ID -> index maps
  const pathIdToIdx = new Map<string, number>();
  visiblePaths.forEach((p, i) => pathIdToIdx.set(p.id, i));

  const groupIdToIdx = new Map<string, number>();
  groups.forEach((g, i) => groupIdToIdx.set(g.id, i));

  // Find used groups
  const usedGroupIds = new Set<string>();
  for (const clip of clips) {
    for (const partId of Object.keys(clip.parts)) {
      if (groupIdToIdx.has(partId)) {
        usedGroupIds.add(partId);
        let g = groups.find((x) => x.id === partId);
        while (g?.parentId) {
          usedGroupIds.add(g.parentId);
          g = groups.find((x) => x.id === g!.parentId);
        }
      }
    }
  }
  for (const path of visiblePaths) {
    let parentId = path.parentId;
    while (parentId) {
      usedGroupIds.add(parentId);
      const g = groups.find((x) => x.id === parentId);
      parentId = g?.parentId ?? null;
    }
  }

  const usedGroups = groups.filter((g) => usedGroupIds.has(g.id));
  const usedGroupIdToIdx = new Map<string, number>();
  usedGroups.forEach((g, i) => usedGroupIdToIdx.set(g.id, i));

  const w = new BinaryWriter();

  // Header
  w.writeU8(0x45); // 'E'
  w.writeU8(0x53); // 'S'
  w.writeU8(0x54); // 'T'
  w.writeU8(3);    // version

  // Counts
  w.writeU16(visiblePaths.length);
  w.writeU16(usedGroups.length);
  w.writeU16(clips.length);

  // Paths
  for (const path of visiblePaths) {
    const hasParent = path.parentId !== null;
    const hasTP = path.transformPoint !== null;
    const hasVC = path.anchorMeta.some((m) => m.color !== null);

    let flags = 0;
    if (path.playerMask) flags |= 1;
    if (hasParent) flags |= 2;
    if (hasTP) flags |= 4;
    if (hasVC) flags |= 8;

    w.writeU8(flags);
    // If path has vertex colors, compute average for the base fill color
    const fillColor = hasVC
      ? averageColors(path.anchorMeta.map((_, i) => getAnchorColor(path, i)))
      : path.fill;
    w.writeU24(hexToInt(fillColor));
    w.writeU8(Math.round(path.opacity * 255));

    if (hasParent) {
      w.writeU16(usedGroupIdToIdx.get(path.parentId!) ?? 0);
    }
    if (hasTP) {
      w.writeF16(path.transformPoint!.x);
      w.writeF16(path.transformPoint!.y);
    }

    w.writeU16(path.segments.length);
    for (const seg of path.segments) {
      w.writeF16(seg.p0.x);
      w.writeF16(seg.p0.y);
      w.writeF16(seg.c0.x);
      w.writeF16(seg.c0.y);
      w.writeF16(seg.c1.x);
      w.writeF16(seg.c1.y);
      w.writeF16(seg.p1.x);
      w.writeF16(seg.p1.y);
    }

    if (hasVC) {
      for (const meta of path.anchorMeta) {
        w.writeU24(meta.color ? hexToInt(meta.color) : 0);
      }
    }
  }

  // Groups
  for (const group of usedGroups) {
    const hasParent = group.parentId !== null && usedGroupIdToIdx.has(group.parentId);
    const hasTP = group.transformPoint !== null;

    let flags = 0;
    if (hasParent) flags |= 1;
    if (hasTP) flags |= 2;

    w.writeU8(flags);

    if (hasParent) {
      w.writeU16(usedGroupIdToIdx.get(group.parentId!) ?? 0);
    }
    if (hasTP) {
      w.writeF16(group.transformPoint!.x);
      w.writeF16(group.transformPoint!.y);
    }
  }

  // Clips
  for (const clip of clips) {
    w.writeString(clip.name);
    w.writeF32(clip.duration);
    w.writeU8(clip.fps);

    // Count non-empty parts that have valid indices
    const validParts: { idx: number; keyframes: typeof clip.parts[string] }[] = [];
    for (const [partId, keyframes] of Object.entries(clip.parts)) {
      if (keyframes.length === 0) continue;

      let idx = pathIdToIdx.get(partId);
      if (idx === undefined) {
        const groupIdx = usedGroupIdToIdx.get(partId);
        if (groupIdx !== undefined) {
          idx = -(groupIdx + 1);
        }
      }
      if (idx === undefined) continue;

      validParts.push({ idx, keyframes });
    }

    w.writeU16(validParts.length);

    for (const { idx, keyframes } of validParts) {
      w.writeI16(idx);
      w.writeU16(keyframes.length);

      for (const kf of keyframes) {
        w.writeF16(kf.t);

        let flags = 0;
        if (kf.tx !== undefined) flags |= 1;
        if (kf.ty !== undefined) flags |= 2;
        if (kf.rot !== undefined) flags |= 4;
        if (kf.scale !== undefined) flags |= 8;
        if (kf.opacity !== undefined) flags |= 16;

        w.writeU8(flags);

        if (flags & 1) w.writeF16(kf.tx!);
        if (flags & 2) w.writeF16(kf.ty!);
        if (flags & 4) w.writeF16(kf.rot!);
        if (flags & 8) w.writeF16(kf.scale!);
        if (flags & 16) w.writeF16(kf.opacity!);
      }
    }
  }

  return w.getBuffer();
}

// Export BinaryReader for use by loader
export { BinaryReader, float16ToFloat };
