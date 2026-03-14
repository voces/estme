// SVG export utility - converts estme paths to SVG format

import { Camera, Path, Group } from "./types.ts";
import { averageColors, getAnchorColor } from "./geometry.ts";

// Convert a path's segments to an SVG path d attribute
// Y coordinates are negated to flip from canvas coordinates (Y up) to SVG coordinates (Y down)
function pathToSvgD(path: Path): string {
  if (path.segments.length === 0) return "";

  const parts: string[] = [];
  const first = path.segments[0];

  // Move to start (negate Y)
  parts.push(`M ${first.p0.x} ${-first.p0.y}`);

  // Add cubic bezier curves for each segment (negate Y)
  for (const seg of path.segments) {
    parts.push(`C ${seg.c0.x} ${-seg.c0.y} ${seg.c1.x} ${-seg.c1.y} ${seg.p1.x} ${-seg.p1.y}`);
  }

  // Close path if needed
  if (path.closed) {
    parts.push("Z");
  }

  return parts.join(" ");
}

// Get the effective fill color for a path, accounting for per-anchor vertex colors
function getPathFillColor(path: Path): string {
  const hasVertexColors = path.anchorMeta?.some((meta) => meta.color !== null) ?? false;
  if (!hasVertexColors) return path.fill;
  const vertexColors = path.segments.map((_, i) => getAnchorColor(path, i));
  return averageColors(vertexColors);
}

// Build a path index map for determining render order
function buildPathIndices(paths: Path[]): Map<string, number> {
  const indices = new Map<string, number>();
  for (let i = 0; i < paths.length; i++) {
    indices.set(paths[i].id, i);
  }
  return indices;
}

// Get the minimum path array index among all descendants of a group
function getGroupMinIndex(
  groupId: string,
  groups: Group[],
  paths: Path[],
  pathIndices: Map<string, number>,
): number {
  let minIndex = Infinity;
  for (const path of paths) {
    if (path.parentId === groupId) {
      const idx = pathIndices.get(path.id);
      if (idx !== undefined && idx < minIndex) minIndex = idx;
    }
  }
  for (const group of groups) {
    if (group.parentId === groupId) {
      const childMin = getGroupMinIndex(group.id, groups, paths, pathIndices);
      if (childMin < minIndex) minIndex = childMin;
    }
  }
  return minIndex;
}

// Recursively render children of a group, interleaving groups and paths by array order
function renderChildren(
  parentId: string | null,
  groups: Group[],
  paths: Path[],
  pathIndices: Map<string, number>,
  indent: string,
): string[] {
  const lines: string[] = [];

  // Collect items at this level with their sort keys
  type Item =
    | { type: "path"; path: Path; sortKey: number }
    | { type: "group"; group: Group; sortKey: number };
  const items: Item[] = [];

  for (const path of paths) {
    if (path.parentId !== parentId) continue;
    const idx = pathIndices.get(path.id) ?? Infinity;
    items.push({ type: "path", path, sortKey: idx });
  }

  for (const group of groups) {
    if (group.parentId !== parentId) continue;
    const minIdx = getGroupMinIndex(group.id, groups, paths, pathIndices);
    items.push({ type: "group", group, sortKey: minIdx });
  }

  // Sort by array index (lower index = rendered first = behind in SVG)
  items.sort((a, b) => a.sortKey - b.sortKey);

  for (const item of items) {
    if (item.type === "group") {
      lines.push(`${indent}<g id="${escapeXml(item.group.name)}">`);
      lines.push(...renderChildren(item.group.id, groups, paths, pathIndices, indent + "  "));
      lines.push(`${indent}</g>`);
    } else {
      const d = pathToSvgD(item.path);
      if (!d) continue;
      const fill = getPathFillColor(item.path);
      const opacity = item.path.opacity < 1 ? ` fill-opacity="${item.path.opacity}"` : "";
      const player = item.path.playerMask ? ` data-player="true"` : "";
      lines.push(
        `${indent}<path id="${escapeXml(item.path.name)}" d="${d}" fill="${fill}"${opacity}${player}/>`
      );
    }
  }

  return lines;
}

// Escape special XML characters
function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Calculate bounding box of all paths (in SVG coordinates with Y negated)
function calculateBounds(paths: Path[]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const path of paths) {
    if (!path.visible) continue;
    for (const seg of path.segments) {
      // Include all control points for accurate bounds (negate Y for SVG coords)
      for (const pt of [seg.p0, seg.c0, seg.c1, seg.p1]) {
        minX = Math.min(minX, pt.x);
        minY = Math.min(minY, -pt.y);
        maxX = Math.max(maxX, pt.x);
        maxY = Math.max(maxY, -pt.y);
      }
    }
  }

  // Handle empty case
  if (minX === Infinity) {
    return { minX: 0, minY: 0, maxX: 100, maxY: 100 };
  }

  return { minX, minY, maxX, maxY };
}

export function exportSvg(paths: Path[], groups: Group[], cameras?: Camera[]): string {
  // Filter to visible paths only
  const visiblePaths = paths.filter((p) => p.visible);

  // Calculate bounds
  const bounds = calculateBounds(visiblePaths);
  const padding = 10;
  const width = bounds.maxX - bounds.minX + padding * 2;
  const height = bounds.maxY - bounds.minY + padding * 2;
  const viewBox = `${bounds.minX - padding} ${bounds.minY - padding} ${width} ${height}`;

  // Build path index map for correct render ordering
  const pathIndices = buildPathIndices(visiblePaths);

  // Build SVG
  const lines: string[] = [];
  lines.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  lines.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${width}" height="${height}">`
  );

  // Render from root, interleaving groups and paths by array order
  lines.push(...renderChildren(null, groups, visiblePaths, pathIndices, "  "));

  // Export cameras as rect elements
  if (cameras) {
    for (const camera of cameras) {
      const x = camera.x - camera.size;
      const y = -(camera.y + camera.size); // Negate Y for SVG coords
      const w = camera.size * 2;
      const h = camera.size * 2;
      lines.push(
        `  <rect id="${escapeXml(camera.name)}" data-camera="true" x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#888" stroke-dasharray="5,5"/>`
      );
    }
  }

  lines.push(`</svg>`);

  return lines.join("\n");
}
