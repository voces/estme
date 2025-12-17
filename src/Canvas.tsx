import { useEffect, useRef } from "react";
import * as THREE from "three";
import { HandleType, HoveredEdge, HoveredPoint, store, useStore } from "./store/index.ts";
import { defaultAnchorMeta, lineSegment, Path, Point } from "./types.ts";
import {
  MouseButton,
  isUndo,
  isRedo,
  isCopy,
  isCut,
  isPaste,
  isEscape,
  isDelete,
  isSelectAll,
  isSelectTool,
  isLineTool,
  isGroup,
  isUngroup,
  isTextInput,
  isSplitPath,
  isUnite,
  isIntersect,
  isSubtract,
  isExclude,
  isToggleAnchors,
  isToggleControls,
} from "./bindings.ts";
import {
  closestPointOnBezier,
  distance,
  findNearestPoint,
  findNearestPointIndex,
  findNearestPointWithInfo,
  getAllAnchorPoints,
  getAllAnchorPointsWithInfo,
  getPathCenter,
  getPathPoints,
  getSelectionCenter,
  hasVertexColors,
  hexToRgbNormalized,
  lerpRgb,
  sampleBezier,
} from "./geometry.ts";

const VERTEX_SIZE = 0.035;
const CONTROL_POINT_SIZE = 0.03;

function screenToWorld(
  e: MouseEvent,
  container: HTMLElement,
  camera: THREE.OrthographicCamera,
): Point {
  const rect = container.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  const y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

  return {
    x: (x * (camera.right - camera.left)) / 2 +
      (camera.right + camera.left) / 2,
    y: (y * (camera.top - camera.bottom)) / 2 +
      (camera.top + camera.bottom) / 2,
  };
}

// Snap point with identity info
type SnapPoint = {
  point: Point;
  pathId: string;
  segmentIndex: number;
  handleType: HandleType;
};

// Get snap points for anchor dragging - excludes the anchor being dragged and its adjacent anchors
function getSnapPointsForAnchor(
  paths: Path[],
  draggedPathId: string,
  draggedAnchorIndex: number
): Point[] {
  return getSnapPointsForAnchorWithInfo(paths, draggedPathId, draggedAnchorIndex).map(sp => sp.point);
}

// Enhanced version that returns identity info
function getSnapPointsForAnchorWithInfo(
  paths: Path[],
  draggedPathId: string,
  draggedAnchorIndex: number
): SnapPoint[] {
  const points: SnapPoint[] = [];
  for (const path of paths) {
    const n = path.segments.length;
    for (let i = 0; i < n; i++) {
      // If this is the path being dragged, exclude the dragged anchor and its neighbors
      if (path.id === draggedPathId) {
        // Skip the dragged anchor itself
        if (i === draggedAnchorIndex) continue;
        // Skip adjacent anchors (prev and next, accounting for closed path wrap)
        const prevIdx = (draggedAnchorIndex - 1 + n) % n;
        const nextIdx = (draggedAnchorIndex + 1) % n;
        if (i === prevIdx || i === nextIdx) continue;
      }
      points.push({
        point: path.segments[i].p0,
        pathId: path.id,
        segmentIndex: i,
        handleType: "anchor",
      });
    }
  }
  return points;
}

// Get snap points for control point dragging
// Always includes anchor points, includes control points only if showAllControlPoints is enabled
function getSnapPointsForControlPoint(
  paths: Path[],
  draggedPathId: string,
  draggedSegmentIndex: number,
  draggedHandleType: "c0" | "c1",
  includeControlPoints: boolean
): Point[] {
  return getSnapPointsForControlPointWithInfo(paths, draggedPathId, draggedSegmentIndex, draggedHandleType, includeControlPoints).map(sp => sp.point);
}

// Enhanced version that returns identity info
function getSnapPointsForControlPointWithInfo(
  paths: Path[],
  draggedPathId: string,
  draggedSegmentIndex: number,
  draggedHandleType: "c0" | "c1",
  includeControlPoints: boolean
): SnapPoint[] {
  const points: SnapPoint[] = [];
  for (const path of paths) {
    const n = path.segments.length;
    // Always include anchor points
    for (let i = 0; i < n; i++) {
      points.push({
        point: path.segments[i].p0,
        pathId: path.id,
        segmentIndex: i,
        handleType: "anchor",
      });
    }

    // Include control points only if showAllControlPoints is enabled
    if (includeControlPoints) {
      for (let i = 0; i < n; i++) {
        const seg = path.segments[i];
        const anchorMeta = path.anchorMeta?.[i];
        const nextAnchorIdx = path.closed ? (i + 1) % n : i + 1;
        const nextAnchorMeta = path.anchorMeta?.[nextAnchorIdx];

        // Skip the control point being dragged
        const isC0BeingDragged = path.id === draggedPathId && i === draggedSegmentIndex && draggedHandleType === "c0";
        const isC1BeingDragged = path.id === draggedPathId && i === draggedSegmentIndex && draggedHandleType === "c1";

        // c0 (only if active)
        if (anchorMeta?.rightActive !== false && !isC0BeingDragged) {
          points.push({
            point: seg.c0,
            pathId: path.id,
            segmentIndex: i,
            handleType: "c0",
          });
        }
        // c1 (only if active)
        if (nextAnchorMeta?.leftActive !== false && !isC1BeingDragged) {
          points.push({
            point: seg.c1,
            pathId: path.id,
            segmentIndex: i,
            handleType: "c1",
          });
        }
      }
    }
  }
  return points;
}

// Find nearest snap point with full info
function findNearestSnapPoint(target: Point, snapPoints: SnapPoint[], threshold = 0.1): SnapPoint | null {
  let nearest: SnapPoint | null = null;
  let nearestDist = threshold;

  for (const sp of snapPoints) {
    const dist = distance(target, sp.point);
    if (dist < nearestDist) {
      nearestDist = dist;
      nearest = sp;
    }
  }

  return nearest;
}

// Edge hit info
type EdgeHit = {
  pathId: string;
  segmentIndex: number;
  t: number;
  point: Point;
  distance: number;
};

// Find the nearest edge to a point across all paths
function findNearestEdge(
  target: Point,
  paths: Path[],
  threshold: number,
): EdgeHit | null {
  let best: EdgeHit | null = null;

  for (const path of paths) {
    for (let segIdx = 0; segIdx < path.segments.length; segIdx++) {
      const seg = path.segments[segIdx];
      const result = closestPointOnBezier(target, seg.p0, seg.c0, seg.c1, seg.p1);
      if (result.distance < threshold && (!best || result.distance < best.distance)) {
        best = {
          pathId: path.id,
          segmentIndex: segIdx,
          t: result.t,
          point: result.point,
          distance: result.distance,
        };
      }
    }
  }

  return best;
}

function createPathGeometry(path: Path): THREE.ShapeGeometry | null {
  if (path.segments.length === 0) return null;

  const shape = new THREE.Shape();
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

  return new THREE.ShapeGeometry(shape, 32);
}

// Create geometry with vertex colors for paths that have per-vertex coloring
function createVertexColoredGeometry(
  path: Path,
): { geometry: THREE.BufferGeometry; colors: Float32Array } | null {
  if (path.segments.length === 0) return null;

  // Get colors for each anchor (use path fill as default)
  // For closed paths: anchorMeta.length = segments.length
  // For open paths: anchorMeta.length = segments.length + 1 (final endpoint)
  const fillColor = hexToRgbNormalized(path.fill);
  const numAnchors = path.closed ? path.segments.length : path.segments.length + 1;
  const anchorColors: { r: number; g: number; b: number }[] = [];
  for (let i = 0; i < numAnchors; i++) {
    const metaColor = path.anchorMeta?.[i]?.color;
    anchorColors.push(metaColor ? hexToRgbNormalized(metaColor) : fillColor);
  }

  // Sample points along the path
  const samplesPerSegment = 16;
  const pathPoints: Point[] = [];
  const pathColors: { r: number; g: number; b: number }[] = [];

  for (let segIdx = 0; segIdx < path.segments.length; segIdx++) {
    const seg = path.segments[segIdx];
    // For open paths, the last segment ends at the final anchor (index = segments.length)
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
  const shape = new THREE.Shape();
  shape.moveTo(pathPoints[0].x, pathPoints[0].y);
  for (let i = 1; i < pathPoints.length; i++) {
    shape.lineTo(pathPoints[i].x, pathPoints[i].y);
  }
  if (path.closed) {
    shape.closePath();
  }

  const geometry = new THREE.ShapeGeometry(shape);

  // Get position attribute to map colors to vertices
  const positions = geometry.getAttribute("position");
  const colors = new Float32Array(positions.count * 3);

  // For each vertex in the triangulated geometry, find the closest path point and use its color
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

function createPathMesh(path: Path): THREE.Mesh | null {
  // Check if path has vertex colors
  if (hasVertexColors(path)) {
    const result = createVertexColoredGeometry(path);
    if (!result) return null;

    result.geometry.setAttribute(
      "color",
      new THREE.BufferAttribute(result.colors, 3),
    );

    const material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
    });
    return new THREE.Mesh(result.geometry, material);
  }

  // Standard single-color path
  const geometry = createPathGeometry(path);
  if (!geometry) return null;

  const material = new THREE.MeshBasicMaterial({
    color: path.fill,
    side: THREE.DoubleSide,
  });
  return new THREE.Mesh(geometry, material);
}

function createVertexMesh(point: Point, color: number = 0x4488ff, scale: number = 1): THREE.Mesh {
  const geometry = new THREE.CircleGeometry(VERTEX_SIZE, 16);
  const material = new THREE.MeshBasicMaterial({ color });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(point.x, point.y, 1);
  mesh.scale.setScalar(scale);
  return mesh;
}

export const Canvas = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<
    {
      scene: THREE.Scene;
      camera: THREE.OrthographicCamera;
      renderer: THREE.WebGLRenderer;
      pathMeshes: Map<string, THREE.Mesh>;
      previewMesh: THREE.Mesh | null;
      vertexMeshes: THREE.Mesh[];
      controlPointMeshes: THREE.Mesh[];
      handleLines: THREE.Line[];
      // Track which vertex/control meshes belong to which path for fast translation
      pathVertexMeshes: Map<string, THREE.Mesh[]>;
      pathControlMeshes: Map<string, THREE.Mesh[]>;
      pathHandleLines: Map<string, THREE.Line[]>;
      selectionBoxMesh: THREE.Line | null;
      gridLines: THREE.LineSegments | null;
      hoveredEdgeLine: THREE.Line | null;
      hoveredPathOutline: THREE.Line | null;
      updateGrid: () => void;
      updatePointScales: () => void;
      zoom: number;
    } | null
  >(null);

  const paths = useStore((s) => s.paths);
  const currentPath = useStore((s) => s.currentPath);
  const hoverPoint = useStore((s) => s.hoverPoint);
  const hoveredEdge = useStore((s) => s.hoveredEdge);
  const hoveredPoint = useStore((s) => s.hoveredPoint);
  const hoveredPathId = useStore((s) => s.hoveredPathId);
  const selection = useStore((s) => s.selection);
  const tool = useStore((s) => s.tool);
  const fillColor = useStore((s) => s.fillColor);
  const showAllPoints = useStore((s) => s.showAllPoints);
  const showAllControlPoints = useStore((s) => s.showAllControlPoints);

  // Helper to check if a point is selected
  const isPointSelected = (
    pathId: string,
    segmentIndex: number,
    handleType: HandleType,
  ) => {
    return selection.points.some(
      (p) =>
        p.pathId === pathId && p.segmentIndex === segmentIndex &&
        p.handleType === handleType,
    );
  };

  // Helper to check if a path is fully selected
  const isPathSelected = (pathId: string) => {
    return selection.pathIds.includes(pathId);
  };

  // Get all path IDs that have something selected (either fully or points)
  const getPathsWithSelection = () => {
    const pathIds = new Set(selection.pathIds);
    for (const point of selection.points) {
      pathIds.add(point.pathId);
    }
    return pathIds;
  };

  // Sync paths to scene
  useEffect(() => {
    const state = stateRef.current;
    if (!state) return;

    // Remove old meshes for deleted paths
    for (const [id, mesh] of state.pathMeshes) {
      if (!paths.find((p) => p.id === id)) {
        state.scene.remove(mesh);
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
        state.pathMeshes.delete(id);
      }
    }

    // Add or update meshes
    for (const path of paths) {
      const existingMesh = state.pathMeshes.get(path.id);
      const pathHasVertexColors = hasVertexColors(path);
      const existingMat = existingMesh?.material as THREE.MeshBasicMaterial | undefined;
      const existingHasVertexColors = existingMat?.vertexColors ?? false;

      // If vertex color state changed, recreate the entire mesh
      if (existingMesh && pathHasVertexColors !== existingHasVertexColors) {
        state.scene.remove(existingMesh);
        existingMesh.geometry.dispose();
        (existingMesh.material as THREE.Material).dispose();
        state.pathMeshes.delete(path.id);
        // Fall through to create new mesh
      }

      const currentMesh = state.pathMeshes.get(path.id);
      if (currentMesh) {
        // Update visibility
        currentMesh.visible = path.visible;

        // Update existing mesh
        const oldGeometry = currentMesh.geometry;

        if (pathHasVertexColors) {
          // Update vertex-colored geometry
          const result = createVertexColoredGeometry(path);
          if (result) {
            result.geometry.setAttribute(
              "color",
              new THREE.BufferAttribute(result.colors, 3),
            );
            currentMesh.geometry = result.geometry;
            oldGeometry.dispose();
          }
        } else {
          // Update standard geometry
          const newGeometry = createPathGeometry(path);
          if (newGeometry) {
            currentMesh.geometry = newGeometry;
            oldGeometry.dispose();
            // Update material color if changed
            const mat = currentMesh.material as THREE.MeshBasicMaterial;
            if (mat.color.getHexString() !== path.fill.slice(1).toLowerCase()) {
              mat.color.set(path.fill);
            }
          }
        }
      } else {
        // Create new mesh
        const mesh = createPathMesh(path);
        if (mesh) {
          mesh.visible = path.visible;
          state.scene.add(mesh);
          state.pathMeshes.set(path.id, mesh);
        }
      }
    }
  }, [paths]);

  // Create a selection box mesh for box selection visualization
  const createSelectionBoxMesh = (start: Point, end: Point): THREE.Line => {
    const minX = Math.min(start.x, end.x);
    const maxX = Math.max(start.x, end.x);
    const minY = Math.min(start.y, end.y);
    const maxY = Math.max(start.y, end.y);

    const points = [
      new THREE.Vector3(minX, minY, 2),
      new THREE.Vector3(maxX, minY, 2),
      new THREE.Vector3(maxX, maxY, 2),
      new THREE.Vector3(minX, maxY, 2),
      new THREE.Vector3(minX, minY, 2),
    ];
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({
      color: 0x4488ff,
      linewidth: 1,
    });
    return new THREE.Line(geometry, material);
  };

  // Render vertex points, control points, and handle lines for selected paths or current drawing
  useEffect(() => {
    const state = stateRef.current;
    if (!state) return;

    // Remove old vertex meshes
    for (const mesh of state.vertexMeshes) {
      state.scene.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    state.vertexMeshes = [];

    // Remove old control point meshes
    for (const mesh of state.controlPointMeshes) {
      state.scene.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    state.controlPointMeshes = [];

    // Remove old handle lines
    for (const line of state.handleLines) {
      state.scene.remove(line);
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
    }
    state.handleLines = [];

    // Clear per-path tracking
    state.pathVertexMeshes.clear();
    state.pathControlMeshes.clear();
    state.pathHandleLines.clear();

    // Get current zoom for scaling points
    const zoom = state.zoom;

    if (currentPath) {
      // Drawing mode - show current path points
      for (let i = 0; i < currentPath.length; i++) {
        const point = currentPath[i];
        const mesh = createVertexMesh(point, 0x4488ff, zoom);
        state.scene.add(mesh);
        state.vertexMeshes.push(mesh);
      }
    }

    // Show anchor points on all paths if showAllPoints is enabled or in line tool mode
    // Otherwise only show for paths with selection
    // Always skip hidden paths
    const pathsToShowVertices = (showAllPoints || tool === "line")
      ? new Set(paths.filter((p) => p.visible).map((p) => p.id))
      : getPathsWithSelection();

    // Show control points on all paths if showAllControlPoints is enabled
    const pathsToShowControlPoints = showAllControlPoints
      ? new Set(paths.filter((p) => p.visible).map((p) => p.id))
      : getPathsWithSelection();

    for (const pathId of pathsToShowVertices) {
      const path = paths.find((p) => p.id === pathId);
      if (!path || !path.visible) continue;

      const pathIsFullySelected = isPathSelected(pathId);
      const pathHasSelection = pathIsFullySelected ||
        selection.points.some((pt) => pt.pathId === pathId);
      const shouldShowControlPoints = pathsToShowControlPoints.has(pathId);

      // Initialize per-path arrays
      const pathVertices: THREE.Mesh[] = [];
      const pathControls: THREE.Mesh[] = [];
      const pathLines: THREE.Line[] = [];

      // Draw anchor points
      for (let segIdx = 0; segIdx < path.segments.length; segIdx++) {
        const seg = path.segments[segIdx];
        const anchorMeta = path.anchorMeta?.[segIdx];
        // For open paths, the last segment's c1 belongs to the final anchor (index = segments.length)
        // For closed paths, it wraps around to index 0
        const nextAnchorIdx = path.closed
          ? (segIdx + 1) % path.segments.length
          : segIdx + 1;
        const nextAnchorMeta = path.anchorMeta?.[nextAnchorIdx];

        // Check if this anchor is selected (either path is fully selected or point is individually selected)
        const anchorSelected = pathIsFullySelected ||
          isPointSelected(pathId, segIdx, "anchor");
        // Check if this anchor is hovered
        const anchorHovered = hoveredPoint?.pathId === pathId &&
          hoveredPoint?.segmentIndex === segIdx &&
          hoveredPoint?.handleType === "anchor";
        // Determine anchor color: hovered (cyan), selected (yellow), normal (blue/dim)
        let anchorColor: number;
        if (anchorHovered && !anchorSelected) {
          anchorColor = 0x44ffff; // Cyan for hover
        } else if (anchorSelected) {
          anchorColor = 0xffff00; // Yellow for selected
        } else if (pathHasSelection) {
          anchorColor = 0x4488ff; // Blue for paths with selection
        } else {
          anchorColor = 0x446688; // Dim for line tool mode
        }
        const mesh = createVertexMesh(seg.p0, anchorColor, zoom);
        state.scene.add(mesh);
        state.vertexMeshes.push(mesh);
        pathVertices.push(mesh);

        // Only show control points if this path has something selected or showAllControlPoints is enabled
        if (!shouldShowControlPoints) continue;

        // Check if control points are selected/hovered
        const c0Selected = isPointSelected(pathId, segIdx, "c0");
        const c1Selected = isPointSelected(pathId, segIdx, "c1");
        const c0Hovered = hoveredPoint?.pathId === pathId &&
          hoveredPoint?.segmentIndex === segIdx &&
          hoveredPoint?.handleType === "c0";
        const c1Hovered = hoveredPoint?.pathId === pathId &&
          hoveredPoint?.segmentIndex === segIdx &&
          hoveredPoint?.handleType === "c1";

        // c0 control point (outgoing from p0) - controlled by this anchor's rightActive
        const c0Active = anchorMeta?.rightActive !== false;
        if (c0Active) {
          let c0Color: number;
          if (c0Hovered && !c0Selected) {
            c0Color = 0x44ffff; // Cyan for hover
          } else if (c0Selected) {
            c0Color = 0xffff00; // Yellow for selected
          } else {
            c0Color = 0xff8844; // Orange for normal
          }
          const c0Mesh = createVertexMesh(
            seg.c0,
            c0Color,
            zoom * CONTROL_POINT_SIZE / VERTEX_SIZE,
          );
          state.scene.add(c0Mesh);
          state.controlPointMeshes.push(c0Mesh);
          pathControls.push(c0Mesh);

          // Line from p0 to c0
          const line1Geom = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(seg.p0.x, seg.p0.y, 0.5),
            new THREE.Vector3(seg.c0.x, seg.c0.y, 0.5),
          ]);
          const line1 = new THREE.Line(
            line1Geom,
            new THREE.LineBasicMaterial({ color: 0x666666 }),
          );
          state.scene.add(line1);
          state.handleLines.push(line1);
          pathLines.push(line1);
        }

        // c1 control point (incoming to p1) - controlled by next anchor's leftActive
        const c1Active = nextAnchorMeta?.leftActive !== false;
        if (c1Active) {
          let c1Color: number;
          if (c1Hovered && !c1Selected) {
            c1Color = 0x44ffff; // Cyan for hover
          } else if (c1Selected) {
            c1Color = 0xffff00; // Yellow for selected
          } else {
            c1Color = 0xff8844; // Orange for normal
          }
          const c1Mesh = createVertexMesh(
            seg.c1,
            c1Color,
            zoom * CONTROL_POINT_SIZE / VERTEX_SIZE,
          );
          state.scene.add(c1Mesh);
          state.controlPointMeshes.push(c1Mesh);
          pathControls.push(c1Mesh);

          // Line from c1 to p1
          const line2Geom = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(seg.c1.x, seg.c1.y, 0.5),
            new THREE.Vector3(seg.p1.x, seg.p1.y, 0.5),
          ]);
          const line2 = new THREE.Line(
            line2Geom,
            new THREE.LineBasicMaterial({ color: 0x666666 }),
          );
          state.scene.add(line2);
          state.handleLines.push(line2);
          pathLines.push(line2);
        }
      }

      // For open paths, also draw the final endpoint (last segment's p1)
      if (!path.closed && path.segments.length > 0) {
        const lastSegIdx = path.segments.length - 1;
        const lastSeg = path.segments[lastSegIdx];
        const finalAnchorIdx = path.segments.length; // The final anchor meta index for open paths

        // Check if this final anchor is selected
        const finalAnchorSelected = pathIsFullySelected ||
          isPointSelected(pathId, finalAnchorIdx, "anchor");
        // Check if hovered
        const finalAnchorHovered = hoveredPoint?.pathId === pathId &&
          hoveredPoint?.segmentIndex === finalAnchorIdx &&
          hoveredPoint?.handleType === "anchor";

        let finalAnchorColor: number;
        if (finalAnchorHovered && !finalAnchorSelected) {
          finalAnchorColor = 0x44ffff;
        } else if (finalAnchorSelected) {
          finalAnchorColor = 0xffff00;
        } else if (pathHasSelection) {
          finalAnchorColor = 0x4488ff;
        } else {
          finalAnchorColor = 0x446688;
        }
        const finalMesh = createVertexMesh(lastSeg.p1, finalAnchorColor, zoom);
        state.scene.add(finalMesh);
        state.vertexMeshes.push(finalMesh);
        pathVertices.push(finalMesh);
      }

      // Store per-path references
      state.pathVertexMeshes.set(pathId, pathVertices);
      state.pathControlMeshes.set(pathId, pathControls);
      state.pathHandleLines.set(pathId, pathLines);
    }
  }, [paths, currentPath, selection, tool, showAllPoints, showAllControlPoints, hoveredPoint]);

  // Preview current path being drawn
  useEffect(() => {
    const state = stateRef.current;
    if (!state) return;

    // Remove old preview
    if (state.previewMesh) {
      state.scene.remove(state.previewMesh);
      state.previewMesh.geometry.dispose();
      (state.previewMesh.material as THREE.Material).dispose();
      state.previewMesh = null;
    }

    // Create preview if drawing
    if (currentPath && currentPath.length >= 1) {
      const previewPoints = hoverPoint
        ? [...currentPath, hoverPoint]
        : currentPath;

      if (previewPoints.length >= 2) {
        const segments = [];
        for (let i = 0; i < previewPoints.length - 1; i++) {
          segments.push(lineSegment(previewPoints[i], previewPoints[i + 1]));
        }
        const previewPath: Path = {
          id: "preview",
          name: "Preview",
          parentId: null,
          segments,
          anchorMeta: [],
          closed: false,
          fill: fillColor,
          visible: true,
          locked: false,
        };
        const mesh = createPathMesh(previewPath);
        if (mesh) {
          state.scene.add(mesh);
          state.previewMesh = mesh;
        }
      }
    }
  }, [currentPath, hoverPoint, fillColor]);

  // Render hovered edge highlight
  useEffect(() => {
    const state = stateRef.current;
    if (!state) return;

    // Remove old highlight
    if (state.hoveredEdgeLine) {
      state.scene.remove(state.hoveredEdgeLine);
      state.hoveredEdgeLine.geometry.dispose();
      (state.hoveredEdgeLine.material as THREE.Material).dispose();
      state.hoveredEdgeLine = null;
    }

    // Create highlight if hovering an edge
    if (hoveredEdge && tool === "select") {
      const path = paths.find((p) => p.id === hoveredEdge.pathId);
      if (path) {
        const seg = path.segments[hoveredEdge.segmentIndex];
        // Sample the bezier to create a visible tube/ribbon
        // Since linewidth doesn't work in WebGL, we create a tube mesh instead
        const samples = 32;
        const tubeRadius = VERTEX_SIZE * 0.3 * state.zoom; // Scale with zoom
        const pathPoints: THREE.Vector3[] = [];
        for (let i = 0; i <= samples; i++) {
          const t = i / samples;
          const pt = sampleBezier(seg.p0, seg.c0, seg.c1, seg.p1, t);
          pathPoints.push(new THREE.Vector3(pt.x, pt.y, 0));
        }
        const curve = new THREE.CatmullRomCurve3(pathPoints);
        const tubeGeometry = new THREE.TubeGeometry(curve, samples, tubeRadius, 8, false);
        const material = new THREE.MeshBasicMaterial({ color: 0x44aaff });
        state.hoveredEdgeLine = new THREE.Mesh(tubeGeometry, material) as unknown as THREE.Line;
        state.hoveredEdgeLine.position.z = 0.5; // Above path fill but below points
        state.scene.add(state.hoveredEdgeLine);
      }
    }
  }, [hoveredEdge, paths, tool]);

  // Render hovered path outline
  useEffect(() => {
    const state = stateRef.current;
    if (!state) return;

    // Remove old outline
    if (state.hoveredPathOutline) {
      state.scene.remove(state.hoveredPathOutline);
      state.hoveredPathOutline.geometry.dispose();
      (state.hoveredPathOutline.material as THREE.Material).dispose();
      state.hoveredPathOutline = null;
    }

    // Create outline if hovering a path (and not hovering a point or edge)
    if (hoveredPathId && tool === "select" && !hoveredPoint && !hoveredEdge) {
      const path = paths.find((p) => p.id === hoveredPathId);
      if (path) {
        // Sample all bezier segments to create outline
        const outlinePoints: THREE.Vector3[] = [];
        const samples = 20;
        for (const seg of path.segments) {
          for (let i = 0; i < samples; i++) {
            const t = i / samples;
            const pt = sampleBezier(seg.p0, seg.c0, seg.c1, seg.p1, t);
            outlinePoints.push(new THREE.Vector3(pt.x, pt.y, 0.3));
          }
        }
        // Close the path
        if (path.closed && outlinePoints.length > 0) {
          outlinePoints.push(outlinePoints[0].clone());
        }

        const geometry = new THREE.BufferGeometry().setFromPoints(outlinePoints);
        const material = new THREE.LineBasicMaterial({ color: 0x44ffff });
        state.hoveredPathOutline = new THREE.Line(geometry, material);
        state.scene.add(state.hoveredPathOutline);
      }
    }
  }, [hoveredPathId, hoveredPoint, hoveredEdge, paths, tool]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Setup
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1a1a);

    const { clientWidth: width, clientHeight: height } = container;
    const aspect = width / height;
    const frustum = 5;

    const camera = new THREE.OrthographicCamera(
      -frustum * aspect,
      frustum * aspect,
      frustum,
      -frustum,
      0.1,
      100,
    );
    camera.position.z = 10;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(renderer.domElement);

    stateRef.current = {
      scene,
      camera,
      renderer,
      pathMeshes: new Map(),
      previewMesh: null,
      vertexMeshes: [],
      controlPointMeshes: [],
      handleLines: [],
      pathVertexMeshes: new Map(),
      pathControlMeshes: new Map(),
      pathHandleLines: new Map(),
      selectionBoxMesh: null,
      gridLines: null,
      hoveredEdgeLine: null,
      hoveredPathOutline: null,
      zoom: 1,
      updateGrid: () => {}, // Placeholder, will be set after function is defined
      updatePointScales: () => {}, // Placeholder, will be set after function is defined
    };

    // Function to create/update grid based on camera view
    const updateGrid = () => {
      const state = stateRef.current;
      if (!state) return;

      // Remove old grid
      if (state.gridLines) {
        state.scene.remove(state.gridLines);
        state.gridLines.geometry.dispose();
        (state.gridLines.material as THREE.Material).dispose();
        state.gridLines = null;
      }

      const { camera } = state;
      const viewWidth = camera.right - camera.left;
      const viewHeight = camera.top - camera.bottom;

      // Determine grid spacing based on view size
      // Find a nice round number for the grid spacing
      const targetLinesPerView = 10; // Aim for roughly this many major lines visible
      const rawSpacing = Math.max(viewWidth, viewHeight) / targetLinesPerView;

      // Snap to nice values: 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, etc.
      const magnitude = Math.pow(10, Math.floor(Math.log10(rawSpacing)));
      const normalized = rawSpacing / magnitude;
      let majorSpacing: number;
      if (normalized < 1.5) majorSpacing = magnitude;
      else if (normalized < 3.5) majorSpacing = 2 * magnitude;
      else if (normalized < 7.5) majorSpacing = 5 * magnitude;
      else majorSpacing = 10 * magnitude;

      const minorSpacing = majorSpacing / 5;

      // Extend grid beyond view to account for panning
      const padding = majorSpacing * 2;
      const left = Math.floor((camera.left - padding) / minorSpacing) *
        minorSpacing;
      const right = Math.ceil((camera.right + padding) / minorSpacing) *
        minorSpacing;
      const bottom = Math.floor((camera.bottom - padding) / minorSpacing) *
        minorSpacing;
      const top = Math.ceil((camera.top + padding) / minorSpacing) *
        minorSpacing;

      const positions: number[] = [];
      const colors: number[] = [];

      const majorColor = { r: 0.05, g: 0.05, b: 0.05 };
      const minorColor = { r: 0.02, g: 0.02, b: 0.02 };

      // Helper to check if a value is on a major grid line (handles floating point)
      const isMajorLine = (val: number) => {
        const remainder = Math.abs(val % majorSpacing);
        const tolerance = minorSpacing * 0.1;
        // Check both close to 0 and close to majorSpacing (for negative modulo results)
        return remainder < tolerance || Math.abs(remainder - majorSpacing) < tolerance;
      };

      // Vertical lines
      for (let x = left; x <= right; x += minorSpacing) {
        const color = isMajorLine(x) ? majorColor : minorColor;

        positions.push(x, bottom, -1, x, top, -1);
        colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
      }

      // Horizontal lines
      for (let y = bottom; y <= top; y += minorSpacing) {
        const color = isMajorLine(y) ? majorColor : minorColor;

        positions.push(left, y, -1, right, y, -1);
        colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
      }

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(positions, 3),
      );
      geometry.setAttribute(
        "color",
        new THREE.Float32BufferAttribute(colors, 3),
      );

      const material = new THREE.LineBasicMaterial({ vertexColors: true });
      state.gridLines = new THREE.LineSegments(geometry, material);
      state.scene.add(state.gridLines);
    };

    // Store updateGrid on state so it can be called from event handlers
    stateRef.current.updateGrid = updateGrid;

    // Function to update vertex/control point scales based on zoom
    const updatePointScales = () => {
      const state = stateRef.current;
      if (!state) return;

      // Scale points inversely with zoom so they stay the same visual size
      const scale = state.zoom;

      for (const mesh of state.vertexMeshes) {
        mesh.scale.setScalar(scale);
      }
      for (const mesh of state.controlPointMeshes) {
        mesh.scale.setScalar(scale * CONTROL_POINT_SIZE / VERTEX_SIZE);
      }
    };

    stateRef.current.updatePointScales = updatePointScales;

    // Initial grid
    updateGrid();

    // Render loop
    let frameId: number;
    const render = () => {
      frameId = requestAnimationFrame(render);
      renderer.render(scene, camera);
    };
    render();

    // Resize handler
    const onResize = () => {
      const { clientWidth: w, clientHeight: h } = container;
      const a = w / h;
      camera.left = -frustum * a;
      camera.right = frustum * a;
      camera.top = frustum;
      camera.bottom = -frustum;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      updateGrid();
    };

    const resizeObserver = new ResizeObserver(onResize);
    resizeObserver.observe(container);

    // Cleanup
    return () => {
      cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      renderer.dispose();
      container.removeChild(renderer.domElement);
    };
  }, []);

  // Mouse handlers
  useEffect(() => {
    const container = containerRef.current;
    const state = stateRef.current;
    if (!container || !state) return;

    let isDragging = false;
    let dragStart: Point | null = null;
    let dragPathId: string | null = null;
    let dragCenter: Point | null = null;
    let startAngle: number | null = null;
    let totalDx = 0;
    let totalDy = 0;
    let totalAngle = 0;
    let isRotating = false;
    let isDraggingPoint = false;
    let dragPointIndex = -1;
    let dragPointOriginalPos: Point | null = null; // Original position of the anchor being dragged (for snapping)
    let isDraggingHandle = false;
    let dragHandleType: HandleType = "anchor";
    let dragSegmentIndex = -1;
    let dragHandleOriginalPos: Point | null = null; // Original position of the control point being dragged (for snapping)
    let dragInitialStart: Point | null = null; // Initial mouse position when drag started (doesn't update each frame)
    let isPanning = false;
    let panStart: Point | null = null;
    let isDraggingSelection = false; // True when dragging multiple items
    let isBoxSelecting = false;
    let boxSelectStart: Point | null = null;
    let boxSelectAdditive = false; // True when shift is held (add to selection)
    let snappedToTarget: SnapPoint | null = null; // Track which point we snapped to (for creating connection)
    // Track snap targets during path drawing: map from point index to snap target info
    let drawingSnapTargets: Map<number, { pathId: string; segmentIndex: number }> = new Map();

    // Helper to find nearest control handle (respects active state)
    const findNearestHandle = (
      clickPoint: Point,
      path: Path,
      threshold: number,
    ): { segmentIndex: number; handleType: HandleType } | null => {
      let nearest: {
        segmentIndex: number;
        handleType: HandleType;
        dist: number;
      } | null = null;

      for (let i = 0; i < path.segments.length; i++) {
        const seg = path.segments[i];
        const anchorMeta = path.anchorMeta?.[i];
        // For open paths, the last segment's c1 belongs to the final anchor (index = segments.length)
        const nextAnchorIdx = path.closed
          ? (i + 1) % path.segments.length
          : i + 1;
        const nextAnchorMeta = path.anchorMeta?.[nextAnchorIdx];

        // Check c0 (only if rightActive for this anchor)
        const c0Active = anchorMeta?.rightActive !== false;
        if (c0Active) {
          const distC0 = distance(clickPoint, seg.c0);
          if (distC0 < threshold && (!nearest || distC0 < nearest.dist)) {
            nearest = { segmentIndex: i, handleType: "c0", dist: distC0 };
          }
        }

        // Check c1 (only if leftActive for next anchor)
        const c1Active = nextAnchorMeta?.leftActive !== false;
        if (c1Active) {
          const distC1 = distance(clickPoint, seg.c1);
          if (distC1 < threshold && (!nearest || distC1 < nearest.dist)) {
            nearest = { segmentIndex: i, handleType: "c1", dist: distC1 };
          }
        }
      }

      return nearest
        ? { segmentIndex: nearest.segmentIndex, handleType: nearest.handleType }
        : null;
    };

    const onMouseDown = (e: MouseEvent) => {
      // Middle mouse button for panning
      if (e.button === MouseButton.MIDDLE) {
        isPanning = true;
        panStart = screenToWorld(e, container, state.camera);
        e.preventDefault();
        return;
      }

      if (tool !== "select") return;

      const { paths, selection } = store.getState();
      const clickPoint = screenToWorld(e, container, state.camera);
      const isShiftClick = e.shiftKey;

      // Get paths that have something selected
      const selectedPathIds = new Set(selection.pathIds);
      for (const pt of selection.points) {
        selectedPathIds.add(pt.pathId);
      }

      // First check if clicking on a control handle or anchor of any selected path
      for (const pathId of selectedPathIds) {
        const selectedPath = paths.find((p) => p.id === pathId);
        if (!selectedPath) continue;

        // Skip hidden and locked paths for dragging
        if (!selectedPath.visible || selectedPath.locked) continue;

        // Check control handles first (they're smaller and harder to click)
        const handle = findNearestHandle(
          clickPoint,
          selectedPath,
          CONTROL_POINT_SIZE * state.zoom,
        );
        if (handle) {
          const pointSel = {
            pathId,
            segmentIndex: handle.segmentIndex,
            handleType: handle.handleType,
          };

          // Check if this point is already in selection (for multi-selection drag)
          const isAlreadySelected = selection.points.some(
            (p) =>
              p.pathId === pathId && p.segmentIndex === handle.segmentIndex &&
              p.handleType === handle.handleType,
          );

          if (isShiftClick) {
            store.toggleInSelection(undefined, pointSel);
          } else if (!isAlreadySelected) {
            store.selectPoint(pointSel);
          }

          // Check updated selection for multi-drag
          const updatedSelection = store.getState().selection;
          isDraggingSelection = updatedSelection.pathIds.length > 0 ||
            updatedSelection.points.length > 1;

          isDragging = true;
          isDraggingHandle = !isDraggingSelection; // Only drag single handle if not multi-selecting
          dragSegmentIndex = handle.segmentIndex;
          dragHandleType = handle.handleType;
          // Capture original control point position for snapping
          const seg = selectedPath.segments[handle.segmentIndex];
          dragHandleOriginalPos = handle.handleType === "c0" ? { ...seg.c0 } : { ...seg.c1 };
          dragStart = clickPoint;
          dragInitialStart = clickPoint; // Track initial position for absolute snapping
          dragPathId = pathId;
          totalDx = 0;
          totalDy = 0;
          e.preventDefault();
          return;
        }

        // Check anchor points
        const pathPoints = getPathPoints(selectedPath);
        const pointIdx = findNearestPointIndex(
          clickPoint,
          pathPoints,
          VERTEX_SIZE * state.zoom,
        );
        if (pointIdx >= 0) {
          const pointSel = {
            pathId,
            segmentIndex: pointIdx,
            handleType: "anchor" as HandleType,
          };

          // Check if this specific anchor is already selected as a point (not just the path)
          const isPointAlreadySelected = selection.points.some(
            (p) =>
              p.pathId === pathId && p.segmentIndex === pointIdx &&
              p.handleType === "anchor",
          );
          // Check if the path is fully selected
          const isPathFullySelected = selection.pathIds.includes(pathId);

          if (isShiftClick) {
            store.toggleInSelection(undefined, pointSel);
          } else if (isPathFullySelected) {
            // Clicking a point on a fully-selected path: switch to point selection
            store.selectPoint(pointSel);
          } else if (!isPointAlreadySelected) {
            store.selectPoint(pointSel);
          }

          // Check updated selection for multi-drag
          const updatedSelection = store.getState().selection;
          isDraggingSelection = updatedSelection.pathIds.length > 0 ||
            updatedSelection.points.length > 1;

          isDragging = true;
          isDraggingPoint = !isDraggingSelection; // Only drag single point if not multi-selecting
          dragPointIndex = pointIdx;
          dragPointOriginalPos = { ...pathPoints[pointIdx] }; // Capture original anchor position for snapping
          dragStart = clickPoint;
          dragInitialStart = clickPoint; // Track initial position for absolute snapping
          dragPathId = pathId;
          totalDx = 0;
          totalDy = 0;
          e.preventDefault();
          return;
        }
      }

      // Check if clicking on a control handle of ANY visible path (when showAllControlPoints is enabled)
      const { showAllControlPoints } = store.getState();
      if (showAllControlPoints) {
        for (const path of paths) {
          // Skip hidden, locked, or already-checked paths
          if (!path.visible || path.locked) continue;
          if (selectedPathIds.has(path.id)) continue; // Already checked above

          const handle = findNearestHandle(
            clickPoint,
            path,
            CONTROL_POINT_SIZE * state.zoom,
          );
          if (handle) {
            const pointSel = {
              pathId: path.id,
              segmentIndex: handle.segmentIndex,
              handleType: handle.handleType,
            };

            if (isShiftClick) {
              store.toggleInSelection(undefined, pointSel);
            } else {
              store.selectPoint(pointSel);
            }

            // Check updated selection for multi-drag
            const updatedSelection = store.getState().selection;
            isDraggingSelection = updatedSelection.pathIds.length > 0 ||
              updatedSelection.points.length > 1;

            isDragging = true;
            isDraggingHandle = !isDraggingSelection;
            dragSegmentIndex = handle.segmentIndex;
            dragHandleType = handle.handleType;
            // Capture original control point position for snapping
            const seg = path.segments[handle.segmentIndex];
            dragHandleOriginalPos = handle.handleType === "c0" ? { ...seg.c0 } : { ...seg.c1 };
            dragStart = clickPoint;
            dragInitialStart = clickPoint; // Track initial position for absolute snapping
            dragPathId = path.id;
            totalDx = 0;
            totalDy = 0;
            e.preventDefault();
            return;
          }
        }
      }

      // Check if clicking on an anchor point of ANY path (not just selected ones)
      // This takes priority over edge detection
      for (const path of paths) {
        // Skip hidden and locked paths
        if (!path.visible || path.locked) continue;

        const pathPoints = getPathPoints(path);
        const pointIdx = findNearestPointIndex(
          clickPoint,
          pathPoints,
          VERTEX_SIZE * state.zoom,
        );
        if (pointIdx >= 0) {
          const pointSel = {
            pathId: path.id,
            segmentIndex: pointIdx,
            handleType: "anchor" as HandleType,
          };

          if (isShiftClick) {
            store.toggleInSelection(undefined, pointSel);
          } else {
            store.selectPoint(pointSel);
          }

          // Check updated selection for multi-drag
          const updatedSelection = store.getState().selection;
          isDraggingSelection = updatedSelection.pathIds.length > 0 ||
            updatedSelection.points.length > 1;

          isDragging = true;
          isDraggingPoint = !isDraggingSelection;
          dragPointIndex = pointIdx;
          dragPointOriginalPos = { ...pathPoints[pointIdx] }; // Capture original anchor position for snapping
          dragStart = clickPoint;
          dragInitialStart = clickPoint; // Track initial position for absolute snapping
          dragPathId = path.id;
          totalDx = 0;
          totalDy = 0;
          e.preventDefault();
          return;
        }
      }

      // Check if clicking on an edge (select both endpoints and allow dragging)
      // Only consider visible paths for edge detection
      const edgeThreshold = VERTEX_SIZE * 2 * state.zoom;
      const visiblePaths = paths.filter((p) => p.visible);
      const edgeHit = findNearestEdge(clickPoint, visiblePaths, edgeThreshold);
      if (edgeHit) {
        const path = paths.find((p) => p.id === edgeHit.pathId);
        if (path && !path.locked) {
          const segIdx = edgeHit.segmentIndex;
          // For open paths, the last segment ends at the final anchor (index = segments.length)
          const nextIdx = path.closed
            ? (segIdx + 1) % path.segments.length
            : segIdx + 1;

          // Select both endpoints of the edge
          const point1 = {
            pathId: edgeHit.pathId,
            segmentIndex: segIdx,
            handleType: "anchor" as HandleType,
          };
          const point2 = {
            pathId: edgeHit.pathId,
            segmentIndex: nextIdx,
            handleType: "anchor" as HandleType,
          };

          if (isShiftClick) {
            // Add both points to selection
            store.addToSelection(undefined, point1);
            store.addToSelection(undefined, point2);
          } else {
            // Replace selection with both points
            store.setSelection({ pathIds: [], points: [point1, point2] });
          }

          // Setup for dragging the edge (both points together)
          isDragging = true;
          isDraggingSelection = true; // Treat as multi-point drag
          dragStart = clickPoint;
          dragPathId = edgeHit.pathId;
          totalDx = 0;
          totalDy = 0;
          e.preventDefault();
          return;
        }
      }

      // Raycast to find clicked path (only visible paths)
      const raycaster = new THREE.Raycaster();
      const rect = container.getBoundingClientRect();
      const mouse = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(mouse, state.camera);

      let clickedPathId: string | null = null;
      let clickedPath: Path | null = null;
      for (const path of visiblePaths) {
        const mesh = state.pathMeshes.get(path.id);
        if (mesh) {
          const intersects = raycaster.intersectObject(mesh);
          if (intersects.length > 0) {
            clickedPathId = path.id;
            clickedPath = path;
            break;
          }
        }
      }

      if (isShiftClick && clickedPathId) {
        // Toggle path in selection
        store.toggleInSelection(clickedPathId);
      } else if (clickedPathId) {
        // Check if clicked path is already in selection - if so, don't change selection (allows dragging multi-selection)
        const currentSelection = store.getState().selection;
        const clickedIsSelected = currentSelection.pathIds.includes(
          clickedPathId,
        );
        if (!clickedIsSelected) {
          // Replace selection with clicked path
          store.selectPath(clickedPathId);
        }
      } else {
        // Clicked empty space - start box selection
        isBoxSelecting = true;
        boxSelectStart = clickPoint;
        boxSelectAdditive = isShiftClick;
        if (!isShiftClick) {
          // Clear selection when starting non-additive box select
          store.selectPath(null);
        }
        e.preventDefault();
        return;
      }

      // Start drag if we clicked on a path (not locked)
      if (clickedPath && clickedPathId && !clickedPath.locked) {
        isDragging = true;
        isDraggingPoint = false;
        isDraggingHandle = false;
        dragPointIndex = -1;
        dragStart = clickPoint;
        dragPathId = clickedPathId;

        // Check if we're dragging a multi-selection
        const currentSelection = store.getState().selection;
        isDraggingSelection = currentSelection.pathIds.length > 1 ||
          (currentSelection.pathIds.length > 0 &&
            currentSelection.points.length > 0) ||
          currentSelection.points.length > 1;

        // Use selection center for multi-selection, otherwise single path center
        if (isDraggingSelection) {
          dragCenter = getSelectionCenter(paths, currentSelection.pathIds);
        } else {
          dragCenter = getPathCenter(clickedPath);
        }

        if (dragStart && dragCenter) {
          startAngle = Math.atan2(
            dragStart.y - dragCenter.y,
            dragStart.x - dragCenter.x,
          );
        }
        totalDx = 0;
        totalDy = 0;
        totalAngle = 0;
        isRotating = false;
        e.preventDefault();
      }
    };

    const onMouseMoveDrag = (e: MouseEvent) => {
      // Handle panning
      if (isPanning && panStart) {
        const point = screenToWorld(e, container, state.camera);
        const dx = panStart.x - point.x;
        const dy = panStart.y - point.y;

        // Move camera
        state.camera.left += dx;
        state.camera.right += dx;
        state.camera.top += dy;
        state.camera.bottom += dy;
        state.camera.updateProjectionMatrix();

        // Update grid for new camera position
        state.updateGrid();
        return;
      }

      // Handle box selection
      if (isBoxSelecting && boxSelectStart) {
        const currentPoint = screenToWorld(e, container, state.camera);

        // Update selection box visualization
        if (state.selectionBoxMesh) {
          state.scene.remove(state.selectionBoxMesh);
          state.selectionBoxMesh.geometry.dispose();
          (state.selectionBoxMesh.material as THREE.Material).dispose();
        }
        state.selectionBoxMesh = createSelectionBoxMesh(
          boxSelectStart,
          currentPoint,
        );
        state.scene.add(state.selectionBoxMesh);
        return;
      }

      if (!isDragging || !dragStart || !dragPathId) return;

      const point = screenToWorld(e, container, state.camera);

      if (isDraggingHandle) {
        // Moving control handle - throttle React updates for geometry
        // Calculate absolute offset from initial drag start (not frame-to-frame)
        if (!dragInitialStart || !dragHandleOriginalPos) return;

        const cursorOffsetX = point.x - dragInitialStart.x;
        const cursorOffsetY = point.y - dragInitialStart.y;

        let newTotalDx = cursorOffsetX;
        let newTotalDy = cursorOffsetY;

        // Shift-snap: snap to anchors (always) and control points (if visible)
        if (e.shiftKey && dragPathId && (dragHandleType === "c0" || dragHandleType === "c1")) {
          const { showAllControlPoints, paths: currentPaths } = store.getState();
          // Calculate where the control point would be without snapping
          const targetPos = {
            x: dragHandleOriginalPos.x + cursorOffsetX,
            y: dragHandleOriginalPos.y + cursorOffsetY,
          };
          // Get snap points from current state with identity info
          const snapPointsWithInfo = getSnapPointsForControlPointWithInfo(
            currentPaths,
            dragPathId,
            dragSegmentIndex,
            dragHandleType,
            showAllControlPoints
          );
          const snapped = findNearestSnapPoint(targetPos, snapPointsWithInfo);
          if (snapped) {
            // Snap to the nearest point
            newTotalDx = snapped.point.x - dragHandleOriginalPos.x;
            newTotalDy = snapped.point.y - dragHandleOriginalPos.y;
            snappedToTarget = snapped;
          } else {
            snappedToTarget = null;
          }
        } else {
          snappedToTarget = null;
        }

        // Calculate the delta to apply since last frame
        const dx = newTotalDx - totalDx;
        const dy = newTotalDy - totalDy;
        totalDx = newTotalDx;
        totalDy = newTotalDy;

        // Always update store (throttles React renders internally)
        if (dx !== 0 || dy !== 0) {
          store.moveHandleLive(dragPathId!, dragSegmentIndex, dragHandleType, dx, dy);
        }
      } else if (isDraggingPoint) {
        // Moving individual anchor point - move mesh directly, throttle React updates for geometry
        // Calculate absolute offset from initial drag start (not frame-to-frame)
        if (!dragInitialStart || !dragPointOriginalPos) return;

        const cursorOffsetX = point.x - dragInitialStart.x;
        const cursorOffsetY = point.y - dragInitialStart.y;

        let newTotalDx = cursorOffsetX;
        let newTotalDy = cursorOffsetY;

        // Shift-snap: snap to nearest non-adjacent anchor point
        if (e.shiftKey && dragPathId) {
          const { paths: currentPaths } = store.getState();
          // Calculate where the point would be without snapping
          const targetPos = {
            x: dragPointOriginalPos.x + cursorOffsetX,
            y: dragPointOriginalPos.y + cursorOffsetY,
          };
          // Get snap points from current state with identity info
          const snapPointsWithInfo = getSnapPointsForAnchorWithInfo(currentPaths, dragPathId, dragPointIndex);
          const snapped = findNearestSnapPoint(targetPos, snapPointsWithInfo);
          if (snapped) {
            // Snap to the nearest point
            newTotalDx = snapped.point.x - dragPointOriginalPos.x;
            newTotalDy = snapped.point.y - dragPointOriginalPos.y;
            snappedToTarget = snapped;
          } else {
            snappedToTarget = null;
          }
        } else {
          snappedToTarget = null;
        }

        // Calculate the delta to apply since last frame
        const dx = newTotalDx - totalDx;
        const dy = newTotalDy - totalDy;
        totalDx = newTotalDx;
        totalDy = newTotalDy;

        // Always update store (throttles React renders internally)
        if (dx !== 0 || dy !== 0) {
          store.movePointLive(dragPathId!, dragPointIndex, dx, dy);
        }
      } else if (e.altKey && dragCenter && startAngle !== null) {
        // Switching to rotation
        if (!isRotating) {
          // No need to sync - store is always up to date now
        }

        // Rotate around center
        isRotating = true;
        const currentAngle = Math.atan2(
          point.y - dragCenter.y,
          point.x - dragCenter.x,
        );
        const deltaAngle = currentAngle - startAngle;
        totalAngle += deltaAngle;
        startAngle = currentAngle;

        // Always update store (throttles React renders internally)
        if (isDraggingSelection) {
          store.rotateSelectionLive(deltaAngle, dragCenter!);
        } else {
          store.rotatePathLive(dragPathId!, deltaAngle, dragCenter!);
        }
      } else {
        // Switching from rotation back to translation
        isRotating = false;

        // Translate
        const dx = point.x - dragStart.x;
        const dy = point.y - dragStart.y;

        if (isDraggingSelection) {
          // Selection translation - always update store (throttles React renders internally)
          totalDx += dx;
          totalDy += dy;
          store.translateSelectionLive(dx, dy);
        } else {
          // Single path translation - always update store (throttles React renders internally)
          totalDx += dx;
          totalDy += dy;
          store.translatePathLive(dragPathId!, dx, dy);
        }
        if (dragCenter) {
          dragCenter = { x: dragCenter.x + dx, y: dragCenter.y + dy };
        }
      }
      dragStart = point;
    };

    const onMouseUp = (e: MouseEvent) => {
      // End panning
      if (isPanning) {
        isPanning = false;
        panStart = null;
        return;
      }

      // End box selection
      if (isBoxSelecting && boxSelectStart) {
        const endPoint = screenToWorld(e, container, state.camera);

        // Remove selection box visualization
        if (state.selectionBoxMesh) {
          state.scene.remove(state.selectionBoxMesh);
          state.selectionBoxMesh.geometry.dispose();
          (state.selectionBoxMesh.material as THREE.Material).dispose();
          state.selectionBoxMesh = null;
        }

        // Calculate box bounds
        const minX = Math.min(boxSelectStart.x, endPoint.x);
        const maxX = Math.max(boxSelectStart.x, endPoint.x);
        const minY = Math.min(boxSelectStart.y, endPoint.y);
        const maxY = Math.max(boxSelectStart.y, endPoint.y);

        // Only select if the box has some size
        const boxWidth = maxX - minX;
        const boxHeight = maxY - minY;

        if (boxWidth > 0.01 || boxHeight > 0.01) {
          const { paths } = store.getState();

          // Find all paths whose ALL anchors are within the box (fully selected)
          // and individual points that are within the box (for partial selection)
          const pathsInBox: string[] = [];
          const pointsInBox: {
            pathId: string;
            segmentIndex: number;
            handleType: HandleType;
          }[] = [];

          for (const path of paths) {
            // Skip hidden paths
            if (!path.visible) continue;

            // Check if ALL anchors of this path are in the box
            let allAnchorsInBox = true;
            const anchorsInBox: number[] = [];

            for (let segIdx = 0; segIdx < path.segments.length; segIdx++) {
              const anchor = path.segments[segIdx].p0;
              if (
                anchor.x >= minX && anchor.x <= maxX && anchor.y >= minY &&
                anchor.y <= maxY
              ) {
                anchorsInBox.push(segIdx);
              } else {
                allAnchorsInBox = false;
              }
            }

            if (allAnchorsInBox && path.segments.length > 0) {
              // All anchors in box - select the entire path
              pathsInBox.push(path.id);
            } else {
              // Only some anchors in box - select individual points
              for (const segIdx of anchorsInBox) {
                pointsInBox.push({
                  pathId: path.id,
                  segmentIndex: segIdx,
                  handleType: "anchor",
                });
              }
            }
          }

          // Update selection
          if (boxSelectAdditive) {
            // Add to existing selection
            for (const pathId of pathsInBox) {
              store.addToSelection(pathId);
            }
            for (const point of pointsInBox) {
              store.addToSelection(undefined, point);
            }
          } else {
            // Replace selection
            if (pathsInBox.length > 0 || pointsInBox.length > 0) {
              store.setSelection({ pathIds: pathsInBox, points: pointsInBox });
            }
          }
        }

        isBoxSelecting = false;
        boxSelectStart = null;
        boxSelectAdditive = false;
        return;
      }

      // Flush any pending throttled updates and commit to undo stack
      if (isDragging && dragPathId) {
        store.flushUpdates();

        if (isDraggingHandle && (totalDx !== 0 || totalDy !== 0)) {
          // Pass snap connection to commit (batched as single undo action)
          const snapConn = snappedToTarget ? {
            points: [
              { pathId: dragPathId, segmentIndex: dragSegmentIndex, handleType: dragHandleType },
              { pathId: snappedToTarget.pathId, segmentIndex: snappedToTarget.segmentIndex, handleType: snappedToTarget.handleType },
            ]
          } : undefined;
          store.commitMoveHandle(dragPathId, dragSegmentIndex, dragHandleType, totalDx, totalDy, snapConn);
        } else if (isDraggingPoint && (totalDx !== 0 || totalDy !== 0)) {
          // Pass snap connection to commit (batched as single undo action)
          const snapConn = snappedToTarget ? {
            points: [
              { pathId: dragPathId, segmentIndex: dragPointIndex, handleType: "anchor" as HandleType },
              { pathId: snappedToTarget.pathId, segmentIndex: snappedToTarget.segmentIndex, handleType: snappedToTarget.handleType },
            ]
          } : undefined;
          store.commitMovePoint(dragPathId, dragPointIndex, totalDx, totalDy, snapConn);
        } else if (isRotating && totalAngle !== 0 && dragCenter) {
          if (isDraggingSelection) {
            store.commitRotateSelection(totalAngle, dragCenter);
          } else {
            store.commitRotate(dragPathId, totalAngle, dragCenter);
          }
        } else if (totalDx !== 0 || totalDy !== 0) {
          // Commit to undo stack
          if (isDraggingSelection) {
            store.commitTranslateSelection(totalDx, totalDy);
          } else {
            store.commitTranslate(dragPathId, totalDx, totalDy);
          }
        }
      }
      // Reset tracking variables
      isDragging = false;
      isDraggingPoint = false;
      isDraggingHandle = false;
      isDraggingSelection = false;
      dragPointIndex = -1;
      dragPointOriginalPos = null;
      dragSegmentIndex = -1;
      dragHandleOriginalPos = null;
      dragInitialStart = null;
      dragStart = null;
      dragPathId = null;
      dragCenter = null;
      startAngle = null;
      totalDx = 0;
      totalDy = 0;
      totalAngle = 0;
      isRotating = false;
      snappedToTarget = null;
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();

      // Use a base so zoom in/out are exact inverses: 1.1^1 and 1.1^-1
      const zoomBase = 1.1;
      const zoomFactor = e.deltaY > 0 ? zoomBase : 1 / zoomBase;
      state.zoom *= zoomFactor;

      // Get mouse position in world space before zoom
      const mouseWorld = screenToWorld(
        e as unknown as MouseEvent,
        container,
        state.camera,
      );

      // Scale camera frustum
      const centerX = (state.camera.left + state.camera.right) / 2;
      const centerY = (state.camera.top + state.camera.bottom) / 2;
      const halfWidth = (state.camera.right - state.camera.left) / 2;
      const halfHeight = (state.camera.top - state.camera.bottom) / 2;

      const newHalfWidth = halfWidth * zoomFactor;
      const newHalfHeight = halfHeight * zoomFactor;

      // Zoom towards mouse position
      const offsetX = (mouseWorld.x - centerX) * (1 - zoomFactor);
      const offsetY = (mouseWorld.y - centerY) * (1 - zoomFactor);

      state.camera.left = centerX - newHalfWidth + offsetX;
      state.camera.right = centerX + newHalfWidth + offsetX;
      state.camera.top = centerY + newHalfHeight + offsetY;
      state.camera.bottom = centerY - newHalfHeight + offsetY;
      state.camera.updateProjectionMatrix();

      // Update grid for new zoom level
      state.updateGrid();

      // Update point scales for new zoom level
      state.updatePointScales();

      // Update store zoom for status bar
      store.setZoom(state.zoom);
    };

    // Helper to create snap connections for a finished path
    const createSnapConnectionsForPath = (pathId: string, pointCount: number) => {
      for (const [pointIndex, target] of drawingSnapTargets) {
        // Only create connections for points that exist in the final path
        if (pointIndex < pointCount) {
          store.createSnapConnection([
            { pathId, segmentIndex: pointIndex, handleType: "anchor" },
            { pathId: target.pathId, segmentIndex: target.segmentIndex, handleType: "anchor" },
          ]);
        }
      }
      drawingSnapTargets.clear();
    };

    const onClick = (e: MouseEvent) => {
      if (tool !== "line") return;

      const point = screenToWorld(e, container, state.camera);

      let clickPoint = point;
      const { currentPath, paths } = store.getState();
      let snapTarget: { pathId: string; segmentIndex: number } | null = null;

      // Shift-snap to nearest point (no threshold - snaps to closest point)
      if (e.shiftKey) {
        // Get all snap candidates: existing path anchors + current path start point (if drawing)
        const allPointsWithInfo = getAllAnchorPointsWithInfo(paths);

        // Add the start point of the current path as a snap candidate (to close the path)
        // Exclude recent points to avoid snapping to just-placed points
        if (currentPath && currentPath.length >= 2) {
          // We don't add it to allPointsWithInfo since it doesn't have a pathId yet,
          // but we'll check it separately
        }

        // Find nearest point from existing paths
        const snappedWithInfo = findNearestPointWithInfo(clickPoint, allPointsWithInfo);

        // Also check distance to current path's start point (for closing)
        let distToExisting = snappedWithInfo ? distance(clickPoint, snappedWithInfo.point) : Infinity;
        let distToStart = Infinity;
        if (currentPath && currentPath.length >= 2) {
          distToStart = distance(clickPoint, currentPath[0]);
        }

        // If start point is closer (or equal), close the path
        if (currentPath && currentPath.length >= 2 && distToStart <= distToExisting) {
          // Close and finish the path
          const segments = [];
          for (let i = 0; i < currentPath.length - 1; i++) {
            segments.push(lineSegment(currentPath[i], currentPath[i + 1]));
          }
          segments.push(
            lineSegment(
              currentPath[currentPath.length - 1],
              currentPath[0],
            ),
          );

          const currentFillColor = store.getState().fillColor;
          const pathId = store.getState().currentPathId!;
          const path: Path = {
            id: pathId,
            name: store.getNextPathName(),
            parentId: null,
            segments,
            anchorMeta: segments.map(() => ({ ...defaultAnchorMeta(), color: currentFillColor })),
            closed: true,
            fill: currentFillColor,
            visible: true,
            locked: false,
          };
          store.finishPath(path);
          // Create snap connections for all tracked snap targets
          createSnapConnectionsForPath(pathId, segments.length);
          return;
        }

        // Otherwise snap to existing path point
        if (snappedWithInfo) {
          clickPoint = snappedWithInfo.point;
          snapTarget = { pathId: snappedWithInfo.pathId, segmentIndex: snappedWithInfo.segmentIndex };
        }
      }

      if (!currentPath) {
        // Starting a new path - clear any previous snap targets
        drawingSnapTargets.clear();
        store.startPath(clickPoint);
        // Track snap target for the first point (index 0)
        if (snapTarget) {
          drawingSnapTargets.set(0, snapTarget);
        }
      } else {
        // Track snap target for this point
        const newPointIndex = currentPath.length;
        if (snapTarget) {
          drawingSnapTargets.set(newPointIndex, snapTarget);
        }
        store.addPoint(clickPoint);
      }
    };

    const onDblClick = (e: MouseEvent) => {
      // Handle edge double-click to insert anchor in select mode
      if (tool === "select") {
        const { hoveredEdge } = store.getState();
        if (hoveredEdge) {
          store.insertAnchor(hoveredEdge.pathId, hoveredEdge.segmentIndex, hoveredEdge.t);
          e.preventDefault();
          return;
        }
      }

      if (tool !== "line") return;

      const { currentPath, currentPathId } = store.getState();
      if (currentPath && currentPath.length >= 3 && currentPathId) {
        const segments = [];
        for (let i = 0; i < currentPath.length - 1; i++) {
          segments.push(lineSegment(currentPath[i], currentPath[i + 1]));
        }
        // Close the path
        segments.push(
          lineSegment(currentPath[currentPath.length - 1], currentPath[0]),
        );

        const currentFillColor = store.getState().fillColor;
        const path: Path = {
          id: currentPathId,
          name: store.getNextPathName(),
          parentId: null,
          segments,
          anchorMeta: segments.map(() => ({ ...defaultAnchorMeta(), color: currentFillColor })),
          closed: true,
          fill: currentFillColor,
          visible: true,
          locked: false,
        };
        store.finishPath(path);
        // Create snap connections for all tracked snap targets
        createSnapConnectionsForPath(currentPathId, segments.length);
      }
    };

    const onMouseMove = (e: MouseEvent) => {
      const point = screenToWorld(e, container, state.camera);

      // Always update mouse position for status bar
      store.setMousePosition(point);

      if (tool === "select") {
        // Detect hover (only when not dragging)
        if (!isDragging && !isBoxSelecting && !isPanning) {
          const { paths, selection, showAllPoints, showAllControlPoints } = store.getState();

          // Get paths that have something selected (for control point visibility)
          const selectedPathIds = new Set(selection.pathIds);
          for (const pt of selection.points) {
            selectedPathIds.add(pt.pathId);
          }

          // Threshold matches visual size of points
          const anchorThreshold = VERTEX_SIZE * state.zoom;
          const controlThreshold = CONTROL_POINT_SIZE * state.zoom;

          // Check for hovered control points first
          // Check selected paths OR all visible paths if showAllControlPoints is enabled
          let foundHoveredPoint: { pathId: string; segmentIndex: number; handleType: HandleType } | null = null;
          const pathsToCheckForControls = showAllControlPoints
            ? paths.filter((p) => p.visible)
            : paths.filter((p) => p.visible && selectedPathIds.has(p.id));

          for (const path of pathsToCheckForControls) {
            const handle = findNearestHandle(point, path, controlThreshold);
            if (handle) {
              foundHoveredPoint = { pathId: path.id, segmentIndex: handle.segmentIndex, handleType: handle.handleType };
              break;
            }
          }

          // Check for hovered anchor points on visible paths
          if (!foundHoveredPoint) {
            const pathsToCheck = showAllPoints
              ? paths.filter((p) => p.visible)
              : paths.filter((p) => p.visible && selectedPathIds.has(p.id));

            for (const path of pathsToCheck) {
              const pathPoints = getPathPoints(path);
              const pointIdx = findNearestPointIndex(point, pathPoints, anchorThreshold);
              if (pointIdx >= 0) {
                foundHoveredPoint = { pathId: path.id, segmentIndex: pointIdx, handleType: "anchor" };
                break;
              }
            }
          }

          // Set hovered point
          store.setHoveredPoint(foundHoveredPoint);

          // If hovering a point, don't show edge or path hover
          if (foundHoveredPoint) {
            store.setHoveredEdge(null);
            store.setHoveredPathId(null);
          } else {
            // Check for edge hover (only on visible paths)
            const edgeThreshold = VERTEX_SIZE * 2 * state.zoom;
            const visiblePaths = paths.filter((p) => p.visible);
            const edgeHit = findNearestEdge(point, visiblePaths, edgeThreshold);
            if (edgeHit) {
              store.setHoveredEdge({
                pathId: edgeHit.pathId,
                segmentIndex: edgeHit.segmentIndex,
                t: edgeHit.t,
                point: edgeHit.point,
              });
              store.setHoveredPathId(null);
            } else {
              store.setHoveredEdge(null);

              // Check for path hover via raycast (only visible paths)
              const raycaster = new THREE.Raycaster();
              const rect = container.getBoundingClientRect();
              const mouse = new THREE.Vector2(
                ((e.clientX - rect.left) / rect.width) * 2 - 1,
                -((e.clientY - rect.top) / rect.height) * 2 + 1,
              );
              raycaster.setFromCamera(mouse, state.camera);

              let hoveredPath: string | null = null;
              for (const path of visiblePaths) {
                const mesh = state.pathMeshes.get(path.id);
                if (mesh) {
                  const intersects = raycaster.intersectObject(mesh);
                  if (intersects.length > 0) {
                    hoveredPath = path.id;
                    break;
                  }
                }
              }
              store.setHoveredPathId(hoveredPath);
            }
          }
        } else {
          // Clear all hover states when dragging
          store.setHoveredPoint(null);
          store.setHoveredEdge(null);
          store.setHoveredPathId(null);
        }
        return;
      }

      if (tool !== "line") return;
      const { currentPath, paths } = store.getState();
      if (currentPath) {
        let hoverPt = point;

        // Shift-snap preview (exclude last 2 points to avoid snapping to recently placed points)
        if (e.shiftKey) {
          const allPoints = getAllAnchorPoints(paths, currentPath, 2);
          const snapped = findNearestPoint(hoverPt, allPoints);
          if (snapped) {
            hoverPt = snapped;
          }
        }

        store.setHoverPoint(hoverPt);
      }
    };

    const onMouseLeave = () => {
      store.setHoverPoint(null);
      store.setHoveredEdge(null);
      store.setHoveredPoint(null);
      store.setHoveredPathId(null);
      store.setMousePosition(null);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      // Don't capture shortcuts when typing in text inputs
      if (isTextInput(e)) return;

      if (isEscape(e)) {
        store.cancelPath();
        drawingSnapTargets.clear();
      }
      // Delete to delete selection
      if (isDelete(e)) {
        const { currentPath, selection } = store.getState();
        const hasSelection = selection.pathIds.length > 0 ||
          selection.points.length > 0;
        if (!currentPath && hasSelection) {
          e.preventDefault();
          store.deleteSelection();
        }
      }
      // Ctrl+Z / Cmd+Z for undo
      if (isUndo(e)) {
        e.preventDefault();
        const { currentPath } = store.getState();
        if (currentPath && currentPath.length > 1) {
          store.removeLastPoint();
          // Also remove snap target for this point
          drawingSnapTargets.delete(currentPath.length - 1);
        } else if (currentPath && currentPath.length === 1) {
          store.cancelPath();
          drawingSnapTargets.clear();
        } else {
          store.undo();
        }
      }
      // Ctrl+Shift+Z / Cmd+Shift+Z for redo
      if (isRedo(e)) {
        e.preventDefault();
        store.redo();
      }
      // Ctrl+C / Cmd+C for copy
      if (isCopy(e)) {
        const { currentPath, selection } = store.getState();
        const hasSelection = selection.pathIds.length > 0 || selection.points.length > 0;
        if (!currentPath && hasSelection) {
          e.preventDefault();
          store.copy();
        }
      }
      // Ctrl+X / Cmd+X for cut
      if (isCut(e)) {
        const { currentPath, selection } = store.getState();
        const hasSelection = selection.pathIds.length > 0 || selection.points.length > 0;
        if (!currentPath && hasSelection) {
          e.preventDefault();
          store.cut();
        }
      }
      // Ctrl+V / Cmd+V for paste
      if (isPaste(e)) {
        const { currentPath } = store.getState();
        if (!currentPath && store.canPaste()) {
          e.preventDefault();
          store.paste();
        }
      }
      // Ctrl+A / Cmd+A for select all
      if (isSelectAll(e)) {
        const { currentPath } = store.getState();
        if (!currentPath) {
          e.preventDefault();
          store.selectAll();
        }
      }
      // V for select tool
      if (isSelectTool(e)) {
        store.setTool("select");
      }
      // P for line tool
      if (isLineTool(e)) {
        store.setTool("line");
      }
      // G for group selection
      if (isGroup(e)) {
        const { currentPath, selection } = store.getState();
        if (!currentPath && selection.pathIds.length > 0) {
          e.preventDefault();
          store.groupSelection();
        }
      }
      // Shift+G for ungroup selection
      if (isUngroup(e)) {
        const { currentPath, selection } = store.getState();
        if (!currentPath && selection.pathIds.length > 0) {
          e.preventDefault();
          store.ungroupSelection();
        }
      }
      // Ctrl+Shift+S for split path
      if (isSplitPath(e)) {
        const { currentPath } = store.getState();
        if (!currentPath && store.canSplit()) {
          e.preventDefault();
          store.splitPath();
        }
      }
      // Ctrl+Shift+U for unite paths
      if (isUnite(e)) {
        const { currentPath } = store.getState();
        if (!currentPath && store.canUnite()) {
          e.preventDefault();
          store.unitePaths();
        }
      }
      // Ctrl+Shift+I for intersect paths
      if (isIntersect(e)) {
        const { currentPath } = store.getState();
        if (!currentPath && store.canIntersect()) {
          e.preventDefault();
          store.intersectPaths();
        }
      }
      // Ctrl+Shift+D for subtract paths
      if (isSubtract(e)) {
        const { currentPath } = store.getState();
        if (!currentPath && store.canSubtract()) {
          e.preventDefault();
          store.subtractPaths();
        }
      }
      // Ctrl+Shift+E for exclude paths
      if (isExclude(e)) {
        const { currentPath } = store.getState();
        if (!currentPath && store.canExclude()) {
          e.preventDefault();
          store.excludePaths();
        }
      }
      // . for toggle show all anchors
      if (isToggleAnchors(e)) {
        e.preventDefault();
        store.toggleShowAllPoints();
      }
      // , for toggle show all controls
      if (isToggleControls(e)) {
        e.preventDefault();
        store.toggleShowAllControlPoints();
      }
    };

    container.addEventListener("mousedown", onMouseDown);
    container.addEventListener("click", onClick);
    container.addEventListener("dblclick", onDblClick);
    container.addEventListener("mousemove", onMouseMove);
    container.addEventListener("mousemove", onMouseMoveDrag);
    container.addEventListener("mouseleave", onMouseLeave);
    container.addEventListener("mouseup", onMouseUp);
    container.addEventListener("wheel", onWheel, { passive: false });
    container.addEventListener("contextmenu", (e) => e.preventDefault());
    window.addEventListener("mousemove", onMouseMoveDrag);
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("keydown", onKeyDown);

    return () => {
      container.removeEventListener("mousedown", onMouseDown);
      container.removeEventListener("click", onClick);
      container.removeEventListener("dblclick", onDblClick);
      container.removeEventListener("mousemove", onMouseMove);
      container.removeEventListener("mousemove", onMouseMoveDrag);
      container.removeEventListener("mouseleave", onMouseLeave);
      container.removeEventListener("mouseup", onMouseUp);
      container.removeEventListener("wheel", onWheel);
      window.removeEventListener("mousemove", onMouseMoveDrag);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [tool]);

  return (
    <div
      ref={containerRef}
      style={{ width: "100%", height: "100%", overflow: "hidden" }}
    />
  );
};
