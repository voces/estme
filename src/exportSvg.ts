// SVG export utility - converts estme paths to SVG format

import { Path, Group } from "./types.ts";

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

// Build group hierarchy for proper nesting in SVG
function buildGroupTree(
  groups: Group[],
  paths: Path[]
): Map<string | null, { groups: Group[]; paths: Path[] }> {
  const tree = new Map<string | null, { groups: Group[]; paths: Path[] }>();

  // Initialize with root
  tree.set(null, { groups: [], paths: [] });

  // Add all groups to tree
  for (const group of groups) {
    if (!tree.has(group.id)) {
      tree.set(group.id, { groups: [], paths: [] });
    }
    const parentChildren = tree.get(group.parentId);
    if (parentChildren) {
      parentChildren.groups.push(group);
    } else {
      tree.set(group.parentId, { groups: [group], paths: [] });
    }
  }

  // Add paths to their parents
  for (const path of paths) {
    const parentChildren = tree.get(path.parentId);
    if (parentChildren) {
      parentChildren.paths.push(path);
    } else {
      tree.set(path.parentId, { groups: [], paths: [path] });
    }
  }

  return tree;
}

// Recursively render a group and its children
function renderGroup(
  groupId: string | null,
  tree: Map<string | null, { groups: Group[]; paths: Path[] }>,
  groups: Group[],
  indent: string
): string[] {
  const lines: string[] = [];
  const children = tree.get(groupId);
  if (!children) return lines;

  // Render child groups first (they appear behind paths in the same group)
  for (const childGroup of children.groups) {
    const group = groups.find((g) => g.id === childGroup.id);
    if (!group) continue;

    lines.push(`${indent}<g id="${escapeXml(group.name)}">`);
    lines.push(...renderGroup(group.id, tree, groups, indent + "  "));
    lines.push(`${indent}</g>`);
  }

  // Render paths
  for (const path of children.paths) {
    const d = pathToSvgD(path);
    if (!d) continue;

    const opacity = path.opacity < 1 ? ` fill-opacity="${path.opacity}"` : "";
    lines.push(
      `${indent}<path id="${escapeXml(path.name)}" d="${d}" fill="${path.fill}"${opacity}/>`
    );
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

export function exportSvg(paths: Path[], groups: Group[]): string {
  // Filter to visible paths only
  const visiblePaths = paths.filter((p) => p.visible);

  // Calculate bounds
  const bounds = calculateBounds(visiblePaths);
  const padding = 10;
  const width = bounds.maxX - bounds.minX + padding * 2;
  const height = bounds.maxY - bounds.minY + padding * 2;
  const viewBox = `${bounds.minX - padding} ${bounds.minY - padding} ${width} ${height}`;

  // Build group tree
  const tree = buildGroupTree(groups, visiblePaths);

  // Build SVG
  const lines: string[] = [];
  lines.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  lines.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${width}" height="${height}">`
  );

  // Render from root
  lines.push(...renderGroup(null, tree, groups, "  "));

  lines.push(`</svg>`);

  return lines.join("\n");
}
