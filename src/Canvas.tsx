import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import paper from "paper";
import { HandleType, HoveredEdge, HoveredPoint, store, useStore } from "./store/index.ts";
import { defaultAnchorMeta, defaultTransform, lineSegment, Path, Point, Raster } from "./types.ts";
import { loadImage } from "./storage.ts";
import { createBlobPath, addBlobToPaths, subtractBlobFromPaths, getBlobPreviewOutline } from "./pathBool.ts";
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
  isDeselectAll,
  isSelectTool,
  isLineTool,
  isBlobTool,
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
  getPathTransformPoint,
  getGroupTransformPoint,
  getPathBounds,
  getSelectionCenter,
  getSelectionBoundingCenter,
  sampleBezier,
  BoundingBox,
} from "./geometry.ts";
import { AnimatedInstancedMesh } from "./AnimatedInstancedMesh.ts";
import {
  createAnimatedMeshMaterial,
  updateAnimationTime,
} from "./AnimatedMeshMaterial.ts";
import { pathsToGeometry, createIdentityAnimationData, EffectiveTransform } from "./pathsToGeometry.ts";
import { getEffectiveTransform, AnimationClip, getPropertyValue } from "./animation.ts";

const VERTEX_SIZE = 0.035;

// Camera state persistence - stores center position and zoom
const CAMERA_STORAGE_KEY = "estme-camera-state";

type CameraState = {
  centerX: number;
  centerY: number;
  zoom: number;
};

function saveCameraState(camera: THREE.OrthographicCamera, zoom: number): void {
  const state: CameraState = {
    centerX: (camera.left + camera.right) / 2,
    centerY: (camera.top + camera.bottom) / 2,
    zoom,
  };
  try {
    localStorage.setItem(CAMERA_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage errors
  }
}

function loadCameraState(): CameraState | null {
  try {
    const stored = localStorage.getItem(CAMERA_STORAGE_KEY);
    if (!stored) return null;
    const state = JSON.parse(stored) as CameraState;
    // Validate the state has all required fields
    if (
      typeof state.centerX !== "number" ||
      typeof state.centerY !== "number" ||
      typeof state.zoom !== "number"
    ) {
      return null;
    }
    return state;
  } catch {
    return null;
  }
}

// Apply forward transform to a point (for rendering animated objects)
// Given a local-space point and a transform, returns the world-space point
function applyTransform(point: Point, transform: EffectiveTransform): Point {
  // Order: scale, rotate, translate
  let x = point.x * transform.scale;
  let y = point.y * transform.scale;

  if (transform.rot !== 0) {
    const cos = Math.cos(transform.rot);
    const sin = Math.sin(transform.rot);
    const rx = x * cos - y * sin;
    const ry = x * sin + y * cos;
    x = rx;
    y = ry;
  }

  x += transform.tx;
  y += transform.ty;

  return { x, y };
}

// Apply inverse transform to a point (for hit-testing animated objects)
// Given a world-space point and a transform, returns the local-space point
function applyInverseTransform(point: Point, transform: EffectiveTransform): Point {
  // Reverse order of operations: translate, rotate, scale
  // First, reverse translation
  let x = point.x - transform.tx;
  let y = point.y - transform.ty;

  // Reverse rotation
  if (transform.rot !== 0) {
    const cos = Math.cos(-transform.rot);
    const sin = Math.sin(-transform.rot);
    const rx = x * cos - y * sin;
    const ry = x * sin + y * cos;
    x = rx;
    y = ry;
  }

  // Reverse scale
  if (transform.scale !== 0) {
    x /= transform.scale;
    y /= transform.scale;
  }

  return { x, y };
}
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

function createPathMesh(path: Path): THREE.Mesh | null {
  const geometry = createPathGeometry(path);
  if (!geometry) return null;

  const material = new THREE.MeshBasicMaterial({
    color: path.fill,
    side: THREE.DoubleSide,
    transparent: path.opacity < 1,
    opacity: path.opacity,
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

// Find all paths that contain a point, ordered from top (highest z-index) to bottom
// Returns array of path IDs in z-order (top first)
// deno-lint-ignore no-explicit-any
function findPathsAtPoint(
  testPoint: Point,
  visiblePaths: Path[],
  activeClip: AnimationClip | null,
  playbackTime: number,
  getAncestorChainFn: (parentId: string | null) => any[],
  getEffectiveTransformFn: (path: Path, clip: any, time: number, ancestors: any[]) => EffectiveTransform,
  applyInverseTransformFn: (point: Point, transform: EffectiveTransform) => Point
): string[] {
  const result: string[] = [];

  // Iterate in reverse order since higher indices are rendered on top
  for (let i = visiblePaths.length - 1; i >= 0; i--) {
    const path = visiblePaths[i];
    if (!path.closed || path.segments.length < 2) continue;

    // Build paper.js path for hit testing
    const paperPath = new paper.Path();
    for (const seg of path.segments) {
      paperPath.add(new paper.Segment(
        new paper.Point(seg.p0.x, seg.p0.y),
        undefined,
        new paper.Point(seg.c0.x - seg.p0.x, seg.c0.y - seg.p0.y)
      ));
    }
    paperPath.closed = true;
    // Set incoming handle of first segment
    const lastSeg = path.segments[path.segments.length - 1];
    paperPath.firstSegment.handleIn = new paper.Point(
      lastSeg.c1.x - lastSeg.p1.x,
      lastSeg.c1.y - lastSeg.p1.y
    );
    // Set outgoing handles for all segments
    for (let j = 0; j < path.segments.length; j++) {
      const seg = path.segments[j];
      const nextIdx = (j + 1) % path.segments.length;
      paperPath.segments[j].handleOut = new paper.Point(
        seg.c0.x - seg.p0.x, seg.c0.y - seg.p0.y
      );
      paperPath.segments[nextIdx].handleIn = new paper.Point(
        seg.c1.x - seg.p1.x, seg.c1.y - seg.p1.y
      );
    }

    // If animation is active, transform test point by inverse of path's animation transform
    let testPt = testPoint;
    if (activeClip) {
      const ancestors = getAncestorChainFn(path.parentId).reverse();
      const transform = getEffectiveTransformFn(path, activeClip, playbackTime, ancestors);
      testPt = applyInverseTransformFn(testPoint, transform);
    }

    const pt = new paper.Point(testPt.x, testPt.y);
    if (paperPath.contains(pt)) {
      result.push(path.id);
    }
    paperPath.remove();
  }

  return result;
}

// Given a list of paths at a point (in z-order) and the currently selected path,
// return the next path in the cycle. If no path is selected or the selected path
// is not in the list, return the topmost path.
function getNextPathInCycle(
  pathsAtPoint: string[],
  currentlySelectedId: string | null,
  selectionPathIds: string[]
): string | null {
  if (pathsAtPoint.length === 0) return null;

  // If nothing is selected or current selection is not at this point, return top
  if (!currentlySelectedId || !pathsAtPoint.includes(currentlySelectedId)) {
    return pathsAtPoint[0];
  }

  // Find current position in the stack
  const currentIndex = pathsAtPoint.indexOf(currentlySelectedId);

  // Return next in cycle (wrap around to top)
  const nextIndex = (currentIndex + 1) % pathsAtPoint.length;
  return pathsAtPoint[nextIndex];
}

export const Canvas = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<
    {
      scene: THREE.Scene;
      camera: THREE.OrthographicCamera;
      renderer: THREE.WebGLRenderer;
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
      selectionFlashOutlines: THREE.Line[];
      blobPreviewMesh: THREE.Mesh | null;
      transformPointMeshes: THREE.Mesh[];
      // AnimatedInstancedMesh for rendering paths
      animatedMeshMaterial: THREE.MeshBasicMaterial | null;
      modelPreview: AnimatedInstancedMesh | null;
      // Raster image meshes
      rasterMeshes: Map<string, THREE.Mesh>;
      rasterTextures: Map<string, THREE.Texture>;
      // Transform handles for selection bounding box
      transformHandles: {
        boundingBox: THREE.Line | null;
        corners: THREE.Mesh[]; // 4 corner handles for scaling
        rotationHandle: THREE.Mesh | null;
        rotationLine: THREE.Line | null;
      };
      updateGrid: () => void;
      updatePointScales: () => void;
      zoom: number;
    } | null
  >(null);

  const paths = useStore((s) => s.paths);
  const rasters = useStore((s) => s.rasters);
  const currentPath = useStore((s) => s.currentPath);
  const hoverPoint = useStore((s) => s.hoverPoint);
  const hoveredEdge = useStore((s) => s.hoveredEdge);
  const hoveredPoint = useStore((s) => s.hoveredPoint);
  const hoveredPathId = useStore((s) => s.hoveredPathId);
  const selection = useStore((s) => s.selection);
  const tool = useStore((s) => s.tool);
  const fillColor = useStore((s) => s.fillColor);
  const fillOpacity = useStore((s) => s.fillOpacity);
  const showAllPoints = useStore((s) => s.showAllPoints);
  const showAllControlPoints = useStore((s) => s.showAllControlPoints);
  const showTransformPoints = useStore((s) => s.showTransformPoints);
  const showGrid = useStore((s) => s.showGrid);
  const groups = useStore((s) => s.groups);
  const blobRadius = useStore((s) => s.blobRadius);
  const animationClips = useStore((s) => s.animationClips);
  const currentClipId = useStore((s) => s.currentClipId);
  const playbackTime = useStore((s) => s.playbackTime);
  const instanceProperties = useStore((s) => s.instanceProperties);
  const mousePosition = useStore((s) => s.mousePosition);

  // Get current animation clip
  const currentClip = currentClipId
    ? animationClips.find((c) => c.id === currentClipId) ?? null
    : null;

  // Recalculate hovered path when selection changes (for cycling behavior)
  // This ensures the hover highlights the next path in cycle after a click
  useEffect(() => {
    if (tool !== "select" || !mousePosition) return;

    const visiblePaths = paths.filter((p) => p.visible);

    // Find all paths at mouse position
    const pathsAtPoint = findPathsAtPoint(
      mousePosition,
      visiblePaths,
      currentClip,
      playbackTime,
      store.getAncestorChain,
      getEffectiveTransform,
      applyInverseTransform
    );

    // Get the next path in cycle based on current selection
    const currentlySelectedId = selection.pathIds.length === 1 ? selection.pathIds[0] : null;
    const hoveredPath = getNextPathInCycle(pathsAtPoint, currentlySelectedId, selection.pathIds);
    store.setHoveredPathId(hoveredPath);
  }, [selection.pathIds, mousePosition, tool, paths, currentClip, playbackTime]);

  // Blob preview state - updated during blob drawing
  const [blobPreviewPoints, setBlobPreviewPoints] = useState<Point[]>([]);
  const setBlobPreviewPointsRef = useRef(setBlobPreviewPoints);
  setBlobPreviewPointsRef.current = setBlobPreviewPoints;

  // Counter to force re-render when raster textures finish loading
  const [rasterTextureVersion, setRasterTextureVersion] = useState(0);

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

  // Render paths using AnimatedInstancedMesh
  useEffect(() => {
    const state = stateRef.current;
    if (!state || !state.animatedMeshMaterial) return;

    // Remove old preview
    if (state.modelPreview) {
      state.scene.remove(state.modelPreview);
      state.modelPreview.geometry.dispose();
      state.modelPreview = null;
    }

    // Only create preview if we have visible paths
    const visiblePaths = paths.filter((p) => p.visible);
    if (visiblePaths.length === 0) return;

    // Compute effective transforms for each path based on animation state
    const transforms = new Map<string, EffectiveTransform>();
    for (const path of visiblePaths) {
      // Get ancestor chain (from immediate parent to root) and reverse it for root-to-parent order
      const ancestors = store.getAncestorChain(path.parentId).reverse();
      transforms.set(path.id, getEffectiveTransform(path, currentClip, playbackTime, ancestors));
    }

    // Create geometry from paths with transforms applied
    const geometry = pathsToGeometry(visiblePaths, transforms);
    if (!geometry) return;

    // Extract opacities from transforms for animation data
    const opacities = visiblePaths.map((path) => transforms.get(path.id)?.opacity ?? 1);

    // Create identity animation data with effective opacities
    const animationData = createIdentityAnimationData(visiblePaths.length, opacities);

    // Create the AnimatedInstancedMesh with 1 instance
    const mesh = new AnimatedInstancedMesh(
      geometry,
      state.animatedMeshMaterial,
      1,
      "preview",
      animationData,
    );

    // Position the instance at origin
    mesh.setPositionAt(0, 0, 0);
    mesh.setScaleAt(0, 1);

    // Apply instance properties
    const instanceProps = store.getState().instanceProperties;
    mesh.setAlphaAt(0, instanceProps.opacity);
    // Use tint for vertex color multiplier
    mesh.setTintAt(0, new THREE.Color(instanceProps.vertexColor), 1);
    mesh.setPlayerColorAt(0, new THREE.Color(instanceProps.accentColor));
    mesh.setMinimapMaskAt(0, instanceProps.minimapMask ? 1 : 0);

    state.modelPreview = mesh;
    state.scene.add(mesh);
  }, [paths, currentClip, playbackTime]);

  // Update instance properties on the mesh when they change
  useEffect(() => {
    const state = stateRef.current;
    if (!state || !state.modelPreview) return;

    state.modelPreview.setAlphaAt(0, instanceProperties.opacity);
    // Use tint for vertex color multiplier
    state.modelPreview.setTintAt(0, new THREE.Color(instanceProperties.vertexColor), 1);
    state.modelPreview.setPlayerColorAt(0, new THREE.Color(instanceProperties.accentColor));
    state.modelPreview.setMinimapMaskAt(0, instanceProperties.minimapMask ? 1 : 0);
  }, [instanceProperties]);

  // Render raster images
  useEffect(() => {
    const state = stateRef.current;
    if (!state) return;

    // Track which rasters we've processed
    const currentRasterIds = new Set(rasters.filter((r) => r.visible).map((r) => r.id));

    // Remove meshes for rasters that no longer exist or are hidden
    for (const [rasterId, mesh] of state.rasterMeshes) {
      if (!currentRasterIds.has(rasterId)) {
        state.scene.remove(mesh);
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
        state.rasterMeshes.delete(rasterId);
      }
    }

    // Remove textures for rasters that no longer exist
    for (const [rasterId] of state.rasterTextures) {
      if (!rasters.find((r) => r.id === rasterId)) {
        const texture = state.rasterTextures.get(rasterId);
        if (texture) {
          texture.dispose();
          state.rasterTextures.delete(rasterId);
        }
      }
    }

    // Process visible rasters
    for (let i = 0; i < rasters.length; i++) {
      const raster = rasters[i];
      if (!raster.visible) continue;

      // Check if we already have a mesh for this raster
      let mesh = state.rasterMeshes.get(raster.id);

      if (!mesh) {
        // Check if texture is loaded (not just placeholder)
        const texture = state.rasterTextures.get(raster.id);
        if (texture) {
          // Texture exists but mesh doesn't - create mesh now
          const geometry = new THREE.PlaneGeometry(1, 1);
          const material = new THREE.MeshBasicMaterial({
            map: texture,
            transparent: true,
            side: THREE.DoubleSide,
          });
          mesh = new THREE.Mesh(geometry, material);
          state.rasterMeshes.set(raster.id, mesh);
          state.scene.add(mesh);
        } else if (!state.rasterTextures.has(raster.id)) {
          // Need to load the texture - mark as loading by setting a placeholder
          state.rasterTextures.set(raster.id, null as unknown as THREE.Texture);

          // Use an async IIFE to load the image
          (async () => {
            const currentState = stateRef.current;
            if (!currentState) return;

            const blob = await loadImage(raster.imageId);
            if (!blob) {
              // Remove the placeholder on failure
              currentState.rasterTextures.delete(raster.id);
              return;
            }

            // Create object URL and load as texture
            const url = URL.createObjectURL(blob);
            const loader = new THREE.TextureLoader();
            const texture = await loader.loadAsync(url);
            URL.revokeObjectURL(url);

            // Configure texture
            texture.colorSpace = THREE.SRGBColorSpace;
            texture.minFilter = THREE.LinearFilter;
            texture.magFilter = THREE.LinearFilter;

            // Store the real texture (replacing placeholder)
            currentState.rasterTextures.set(raster.id, texture);

            // Trigger a re-render to create the mesh
            setRasterTextureVersion((v) => v + 1);
          })();
          continue; // Skip transform update for this raster until loaded
        } else {
          // Placeholder exists, still loading - skip
          continue;
        }
      }

      // Update mesh transform (runs for existing meshes and newly created ones)
      if (mesh) {
        // Update existing mesh transform
        const transform = raster.transform;
        const tx = transform.tx + raster.x;
        const ty = transform.ty + raster.y;
        const sx = transform.scale * raster.width;
        const sy = transform.scale * raster.height;

        // z-position: back rasters at -0.5, front rasters at 0.5, with slight offset per raster for ordering
        const baseZ = raster.renderOrder === "front" ? 0.5 : -0.5;
        mesh.position.set(tx, ty, baseZ + i * 0.001);
        mesh.scale.set(sx, sy, 1);
        mesh.rotation.z = transform.rot;

        // Update opacity
        const material = mesh.material as THREE.MeshBasicMaterial;
        material.opacity = raster.opacity;
      }
    }
  }, [rasters, rasterTextureVersion]);

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

    // Hide anchors and control points when editing an animation clip
    // (geometry editing is disabled in animation mode)
    if (currentClipId) {
      // Skip rendering any vertices/control points in animation mode
    } else {
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
    } // End else (not in animation mode)
  }, [paths, currentPath, selection, tool, showAllPoints, showAllControlPoints, hoveredPoint, currentClipId]);

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
          opacity: fillOpacity,
          visible: true,
          locked: false,
          playerMask: false,
          transform: defaultTransform(),
          transformPoint: null,
        };
        const mesh = createPathMesh(previewPath);
        if (mesh) {
          state.scene.add(mesh);
          state.previewMesh = mesh;
        }
      }
    }
  }, [currentPath, hoverPoint, fillColor, fillOpacity]);

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

    // Create highlight if hovering an edge (disabled when editing a clip)
    if (hoveredEdge && tool === "select" && !currentClipId) {
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
  }, [hoveredEdge, paths, tool, currentClipId]);

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
        // Get effective transform for animated paths
        const currentClip = animationClips.find((c) => c.id === currentClipId) ?? null;
        const ancestors = store.getAncestorChain(path.parentId).reverse();
        const transform = getEffectiveTransform(path, currentClip, playbackTime, ancestors);

        // Sample all bezier segments to create outline
        const outlinePoints: THREE.Vector3[] = [];
        const samples = 20;
        for (const seg of path.segments) {
          for (let i = 0; i < samples; i++) {
            const t = i / samples;
            const localPt = sampleBezier(seg.p0, seg.c0, seg.c1, seg.p1, t);
            // Apply animation transform to get world position
            const worldPt = applyTransform(localPt, transform);
            outlinePoints.push(new THREE.Vector3(worldPt.x, worldPt.y, 0.3));
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
  }, [hoveredPathId, hoveredPoint, hoveredEdge, paths, tool, animationClips, currentClipId, playbackTime]);

  // Track previous selection for flash effect
  const prevSelectionRef = useRef<Set<string>>(new Set());

  // Selection flash effect - brief highlight when paths are selected
  useEffect(() => {
    const state = stateRef.current;
    if (!state) return;

    // Find newly selected path IDs (not in previous selection)
    const currentPathIds = new Set(selection.pathIds);
    const newlySelected: string[] = [];
    for (const id of currentPathIds) {
      if (!prevSelectionRef.current.has(id)) {
        newlySelected.push(id);
      }
    }
    prevSelectionRef.current = currentPathIds;

    if (newlySelected.length === 0) return;

    // Create flash outlines for newly selected paths
    const currentClip = animationClips.find((c) => c.id === currentClipId) ?? null;
    const flashLines: THREE.Line[] = [];

    // Expand groups to their descendant paths for flashing
    const pathIdsToFlash: string[] = [];
    for (const id of newlySelected) {
      // Check if it's a group
      const group = groups.find((g) => g.id === id);
      if (group) {
        // Get all descendant paths of this group
        const descendantPathIds = store.getDescendantPathIds(id);
        pathIdsToFlash.push(...descendantPathIds);
      } else {
        // It's a path
        pathIdsToFlash.push(id);
      }
    }

    for (const pathId of pathIdsToFlash) {
      const path = paths.find((p) => p.id === pathId);
      if (!path) continue;

      // Get effective transform for animated paths
      const ancestors = store.getAncestorChain(path.parentId).reverse();
      const transform = getEffectiveTransform(path, currentClip, playbackTime, ancestors);

      // Sample all bezier segments to create outline
      const outlinePoints: THREE.Vector3[] = [];
      const samples = 20;
      for (const seg of path.segments) {
        for (let i = 0; i < samples; i++) {
          const t = i / samples;
          const localPt = sampleBezier(seg.p0, seg.c0, seg.c1, seg.p1, t);
          // Apply animation transform to get world position
          const worldPt = applyTransform(localPt, transform);
          outlinePoints.push(new THREE.Vector3(worldPt.x, worldPt.y, 0.35));
        }
      }
      // Close the path
      if (path.closed && outlinePoints.length > 0) {
        outlinePoints.push(outlinePoints[0].clone());
      }

      const geometry = new THREE.BufferGeometry().setFromPoints(outlinePoints);
      const material = new THREE.LineBasicMaterial({
        color: 0xffff44,
        transparent: true,
        opacity: 1.0
      });
      const line = new THREE.Line(geometry, material);
      state.scene.add(line);
      flashLines.push(line);
      state.selectionFlashOutlines.push(line);
    }

    if (flashLines.length === 0) return;

    // Animate fade out
    const startTime = performance.now();
    const duration = 300; // ms

    const animate = () => {
      const elapsed = performance.now() - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const opacity = 1 - progress;

      for (const line of flashLines) {
        (line.material as THREE.LineBasicMaterial).opacity = opacity;
      }

      if (progress < 1) {
        requestAnimationFrame(animate);
      } else {
        // Clean up
        for (const line of flashLines) {
          state.scene.remove(line);
          line.geometry.dispose();
          (line.material as THREE.Material).dispose();
          const idx = state.selectionFlashOutlines.indexOf(line);
          if (idx >= 0) state.selectionFlashOutlines.splice(idx, 1);
        }
      }
    };

    requestAnimationFrame(animate);
  }, [selection.pathIds, paths, groups, animationClips, currentClipId, playbackTime]);

  // Render blob preview while drawing (render outline from Paper.js boolean operations)
  useEffect(() => {
    const state = stateRef.current;
    if (!state) return;

    // Remove old blob preview (could be a mesh or a group)
    if (state.blobPreviewMesh) {
      state.scene.remove(state.blobPreviewMesh);
      // Dispose of geometry/material if it's a mesh
      if ((state.blobPreviewMesh as THREE.Mesh).geometry) {
        (state.blobPreviewMesh as THREE.Mesh).geometry.dispose();
      }
      if ((state.blobPreviewMesh as THREE.Mesh).material) {
        ((state.blobPreviewMesh as THREE.Mesh).material as THREE.Material).dispose();
      }
      // If it's a group, dispose children
      if (state.blobPreviewMesh instanceof THREE.Group) {
        for (const child of state.blobPreviewMesh.children) {
          if ((child as THREE.Line).geometry) (child as THREE.Line).geometry.dispose();
          if ((child as THREE.Line).material) ((child as THREE.Line).material as THREE.Material).dispose();
        }
      }
      state.blobPreviewMesh = null;
    }

    // Create blob preview if we have points
    if (blobPreviewPoints.length > 0 && tool === "blob") {
      // Get the actual blob outline from Paper.js
      const outlines = getBlobPreviewOutline(blobPreviewPoints, blobRadius);

      if (outlines.length > 0) {
        // Render as line loops (outlines only)
        const group = new THREE.Group();

        for (const outline of outlines) {
          if (outline.length < 3) continue;

          const points: THREE.Vector3[] = [];
          for (const pt of outline) {
            points.push(new THREE.Vector3(pt.x, pt.y, 0.1));
          }
          // Close the loop
          points.push(points[0].clone());

          const geometry = new THREE.BufferGeometry().setFromPoints(points);
          const material = new THREE.LineBasicMaterial({
            color: new THREE.Color(fillColor),
            transparent: true,
            opacity: fillOpacity,
          });

          const line = new THREE.Line(geometry, material);
          group.add(line);
        }

        state.blobPreviewMesh = group as unknown as THREE.Mesh;
        state.scene.add(group);
      }
    }
  }, [blobPreviewPoints, blobRadius, fillColor, fillOpacity, tool]);

  // Render transform points for paths and groups
  useEffect(() => {
    const state = stateRef.current;
    if (!state) return;

    // Remove old transform point meshes
    for (const mesh of state.transformPointMeshes) {
      state.scene.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    state.transformPointMeshes = [];

    // Only show if visibility is on
    if (!showTransformPoints) return;

    const zoom = state.zoom;
    const size = VERTEX_SIZE * 1.2; // Slightly larger than vertices

    // Helper to create a crosshair-style mesh for transform points
    // Created at scale 1, then scaled by updatePointScales() based on zoom
    // Colors vary by: type (path/group), selected state, and custom (modified) state
    const createTransformPointMesh = (
      point: Point,
      isCustom: boolean,
      isSelected: boolean,
      itemType: "path" | "group"
    ): THREE.Mesh => {
      // Use a diamond shape to distinguish from circle vertices
      const shape = new THREE.Shape();
      shape.moveTo(0, size);
      shape.lineTo(size, 0);
      shape.lineTo(0, -size);
      shape.lineTo(-size, 0);
      shape.closePath();

      const geometry = new THREE.ShapeGeometry(shape);

      // Color scheme:
      // Paths use orange tones, groups use purple/magenta tones
      // Selected = brighter, Custom = saturated, Dynamic = dimmer
      let color: number;
      if (itemType === "path") {
        if (isSelected) {
          color = isCustom ? 0xffaa00 : 0xcc8844; // Selected path: bright orange / dim orange
        } else {
          color = isCustom ? 0xcc6600 : 0x886644; // Unselected path: medium orange / very dim
        }
      } else {
        // Group
        if (isSelected) {
          color = isCustom ? 0xcc66ff : 0x9966cc; // Selected group: bright magenta / dim purple
        } else {
          color = isCustom ? 0x9944cc : 0x664488; // Unselected group: medium purple / very dim
        }
      }

      const material = new THREE.MeshBasicMaterial({ color });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(point.x, point.y, 1.5); // Above vertices
      mesh.scale.setScalar(zoom); // Initial scale based on current zoom
      return mesh;
    };

    // Get selected path and group IDs
    const selectedPathIds = new Set(selection.pathIds);
    // Also consider paths with selected points as selected
    for (const pt of selection.points) {
      selectedPathIds.add(pt.pathId);
    }
    // For now, groups aren't directly selectable, but we can highlight groups
    // that contain selected paths (including all ancestor groups)
    const selectedGroupIds = new Set<string>();
    for (const pathId of selectedPathIds) {
      const path = paths.find((p) => p.id === pathId);
      // Walk up the ancestor chain and add all ancestor groups
      let parentId = path?.parentId;
      while (parentId) {
        selectedGroupIds.add(parentId);
        const parentGroup = groups.find((g) => g.id === parentId);
        parentId = parentGroup?.parentId ?? null;
      }
    }

    // Render transform points for visible paths
    for (const path of paths) {
      if (!path.visible) continue;

      const transformPoint = getPathTransformPoint(path);
      const isCustom = path.transformPoint !== null;
      const isSelected = selectedPathIds.has(path.id);

      // Apply animation transform if in animation mode
      let worldPoint = transformPoint;
      if (currentClipId) {
        const clip = animationClips.find((c) => c.id === currentClipId) ?? null;
        const ancestors = store.getAncestorChain(path.parentId).reverse();
        const transform = getEffectiveTransform(path, clip, playbackTime, ancestors);
        worldPoint = applyTransform(transformPoint, transform);
      }

      const mesh = createTransformPointMesh(worldPoint, isCustom, isSelected, "path");
      state.scene.add(mesh);
      state.transformPointMeshes.push(mesh);
    }

    // Render transform points for groups
    for (const group of groups) {
      const transformPoint = getGroupTransformPoint(group, paths, groups);
      const isCustom = group.transformPoint !== null;
      const isSelected = selectedGroupIds.has(group.id);

      // Apply animation transform if in animation mode
      let worldPoint = transformPoint;
      if (currentClipId) {
        const clip = animationClips.find((c) => c.id === currentClipId) ?? null;
        const ancestors = store.getAncestorChain(group.parentId).reverse();
        // Groups don't have their own transforms yet, but they inherit from ancestors
        // For now just show at the calculated position
        // TODO: Apply group transforms when groups support animation
      }

      const mesh = createTransformPointMesh(worldPoint, isCustom, isSelected, "group");
      state.scene.add(mesh);
      state.transformPointMeshes.push(mesh);
    }
  }, [paths, groups, showTransformPoints, currentClipId, animationClips, playbackTime, selection]);

  // Render transform handles around selection bounding box (only in edit mode, not animation mode)
  useEffect(() => {
    const state = stateRef.current;
    if (!state) return;

    // Helper to clean up transform handles
    const clearTransformHandles = () => {
      const { transformHandles } = state;
      if (transformHandles.boundingBox) {
        state.scene.remove(transformHandles.boundingBox);
        transformHandles.boundingBox.geometry.dispose();
        (transformHandles.boundingBox.material as THREE.Material).dispose();
        transformHandles.boundingBox = null;
      }
      for (const corner of transformHandles.corners) {
        state.scene.remove(corner);
        corner.geometry.dispose();
        (corner.material as THREE.Material).dispose();
      }
      transformHandles.corners = [];
      if (transformHandles.rotationHandle) {
        state.scene.remove(transformHandles.rotationHandle);
        transformHandles.rotationHandle.geometry.dispose();
        (transformHandles.rotationHandle.material as THREE.Material).dispose();
        transformHandles.rotationHandle = null;
      }
      if (transformHandles.rotationLine) {
        state.scene.remove(transformHandles.rotationLine);
        transformHandles.rotationLine.geometry.dispose();
        (transformHandles.rotationLine.material as THREE.Material).dispose();
        transformHandles.rotationLine = null;
      }
    };

    clearTransformHandles();

    // Only show in edit mode (no animation clip selected) and when there's a selection
    if (currentClipId) return;
    if (selection.pathIds.length === 0 && selection.points.length === 0) return;
    if (tool !== "select") return;

    // Calculate the bounding box of the selection
    const selectedPathIds = new Set<string>();
    for (const id of selection.pathIds) {
      // Check if it's a group - expand to child paths
      const group = groups.find((g) => g.id === id);
      if (group) {
        const descendantIds = store.getDescendantPathIds(id);
        for (const pid of descendantIds) {
          selectedPathIds.add(pid);
        }
      } else {
        selectedPathIds.add(id);
      }
    }
    // Also include paths that have selected points
    for (const pt of selection.points) {
      selectedPathIds.add(pt.pathId);
    }

    if (selectedPathIds.size === 0) return;

    // Calculate combined bounding box
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const pathId of selectedPathIds) {
      const path = paths.find((p) => p.id === pathId);
      if (!path || !path.visible) continue;
      const bounds = getPathBounds(path);
      minX = Math.min(minX, bounds.minX);
      minY = Math.min(minY, bounds.minY);
      maxX = Math.max(maxX, bounds.maxX);
      maxY = Math.max(maxY, bounds.maxY);
    }

    if (!isFinite(minX)) return;

    const zoom = state.zoom;
    const handleSize = VERTEX_SIZE * 1.5 * zoom;
    const rotationHandleDistance = 0.15 * zoom; // Distance above top edge

    // Create bounding box outline
    const boxGeometry = new THREE.BufferGeometry();
    const boxVertices = new Float32Array([
      minX, minY, 0.4,
      maxX, minY, 0.4,
      maxX, maxY, 0.4,
      minX, maxY, 0.4,
      minX, minY, 0.4,
    ]);
    boxGeometry.setAttribute("position", new THREE.BufferAttribute(boxVertices, 3));
    const boxMaterial = new THREE.LineBasicMaterial({ color: 0x4488ff });
    const boxLine = new THREE.Line(boxGeometry, boxMaterial);
    state.scene.add(boxLine);
    state.transformHandles.boundingBox = boxLine;

    // Create corner handles (squares for scaling)
    const corners: Point[] = [
      { x: minX, y: minY }, // bottom-left
      { x: maxX, y: minY }, // bottom-right
      { x: maxX, y: maxY }, // top-right
      { x: minX, y: maxY }, // top-left
    ];

    for (const corner of corners) {
      const shape = new THREE.Shape();
      shape.moveTo(-handleSize / 2, -handleSize / 2);
      shape.lineTo(handleSize / 2, -handleSize / 2);
      shape.lineTo(handleSize / 2, handleSize / 2);
      shape.lineTo(-handleSize / 2, handleSize / 2);
      shape.closePath();

      const geometry = new THREE.ShapeGeometry(shape);
      const material = new THREE.MeshBasicMaterial({ color: 0x4488ff });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(corner.x, corner.y, 0.5);
      state.scene.add(mesh);
      state.transformHandles.corners.push(mesh);
    }

    // Create rotation handle (circle above top center)
    const topCenterX = (minX + maxX) / 2;
    const topCenterY = maxY;
    const rotationY = topCenterY + rotationHandleDistance;

    // Line from top center to rotation handle
    const lineGeometry = new THREE.BufferGeometry();
    const lineVertices = new Float32Array([
      topCenterX, topCenterY, 0.4,
      topCenterX, rotationY, 0.4,
    ]);
    lineGeometry.setAttribute("position", new THREE.BufferAttribute(lineVertices, 3));
    const lineMaterial = new THREE.LineBasicMaterial({ color: 0x4488ff });
    const rotLine = new THREE.Line(lineGeometry, lineMaterial);
    state.scene.add(rotLine);
    state.transformHandles.rotationLine = rotLine;

    // Circle for rotation handle
    const circleGeometry = new THREE.CircleGeometry(handleSize * 0.6, 16);
    const circleMaterial = new THREE.MeshBasicMaterial({ color: 0x4488ff });
    const circleMesh = new THREE.Mesh(circleGeometry, circleMaterial);
    circleMesh.position.set(topCenterX, rotationY, 0.5);
    state.scene.add(circleMesh);
    state.transformHandles.rotationHandle = circleMesh;

  }, [paths, groups, selection, currentClipId, tool]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Setup
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1a1a);

    const { clientWidth: width, clientHeight: height } = container;
    const aspect = width / height;
    const frustum = 5;

    // Try to load saved camera state
    const savedCamera = loadCameraState();
    let initialZoom = savedCamera?.zoom ?? 1;

    // Calculate camera bounds from frustum, aspect, zoom, and center
    const halfWidth = frustum * aspect * initialZoom;
    const halfHeight = frustum * initialZoom;
    const centerX = savedCamera?.centerX ?? 0;
    const centerY = savedCamera?.centerY ?? 0;

    const camera = new THREE.OrthographicCamera(
      centerX - halfWidth,
      centerX + halfWidth,
      centerY + halfHeight,
      centerY - halfHeight,
      0.1,
      100,
    );
    camera.position.z = 10;

    if (savedCamera) {
      // Update store zoom for status bar
      store.setZoom(initialZoom);
    }

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(window.devicePixelRatio);
    // Use linear color space output to prevent double gamma correction
    // (our colors are already in sRGB, we don't want Three.js to apply gamma again)
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    container.appendChild(renderer.domElement);

    // Create the shared animated mesh material
    const animatedMeshMaterial = createAnimatedMeshMaterial();

    stateRef.current = {
      scene,
      camera,
      renderer,
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
      selectionFlashOutlines: [],
      blobPreviewMesh: null,
      transformPointMeshes: [],
      animatedMeshMaterial,
      modelPreview: null,
      rasterMeshes: new Map(),
      rasterTextures: new Map(),
      transformHandles: {
        boundingBox: null,
        corners: [],
        rotationHandle: null,
        rotationLine: null,
      },
      zoom: initialZoom,
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

      // Check if grid should be shown
      if (!store.getState().showGrid) {
        return;
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

      const axisColor = { r: 0.25, g: 0.25, b: 0.25 }; // Brighter for x=0 and y=0
      const majorColor = { r: 0.05, g: 0.05, b: 0.05 };
      const minorColor = { r: 0.02, g: 0.02, b: 0.02 };

      // Helper to check if a value is on a major grid line (handles floating point)
      const isMajorLine = (val: number) => {
        const remainder = Math.abs(val % majorSpacing);
        const tolerance = minorSpacing * 0.1;
        // Check both close to 0 and close to majorSpacing (for negative modulo results)
        return remainder < tolerance || Math.abs(remainder - majorSpacing) < tolerance;
      };

      // Helper to check if a value is the origin axis (x=0 or y=0)
      const isAxisLine = (val: number) => Math.abs(val) < minorSpacing * 0.1;

      // Draw lines in priority order (minor first, then major, then axis)
      // so more important lines render on top
      const zMinor = -1;
      const zMajor = -0.9;
      const zAxis = -0.8;

      // Minor lines (both vertical and horizontal)
      for (let x = left; x <= right; x += minorSpacing) {
        if (!isMajorLine(x) && !isAxisLine(x)) {
          positions.push(x, bottom, zMinor, x, top, zMinor);
          colors.push(minorColor.r, minorColor.g, minorColor.b, minorColor.r, minorColor.g, minorColor.b);
        }
      }
      for (let y = bottom; y <= top; y += minorSpacing) {
        if (!isMajorLine(y) && !isAxisLine(y)) {
          positions.push(left, y, zMinor, right, y, zMinor);
          colors.push(minorColor.r, minorColor.g, minorColor.b, minorColor.r, minorColor.g, minorColor.b);
        }
      }

      // Major lines (both vertical and horizontal, excluding axis)
      for (let x = left; x <= right; x += minorSpacing) {
        if (isMajorLine(x) && !isAxisLine(x)) {
          positions.push(x, bottom, zMajor, x, top, zMajor);
          colors.push(majorColor.r, majorColor.g, majorColor.b, majorColor.r, majorColor.g, majorColor.b);
        }
      }
      for (let y = bottom; y <= top; y += minorSpacing) {
        if (isMajorLine(y) && !isAxisLine(y)) {
          positions.push(left, y, zMajor, right, y, zMajor);
          colors.push(majorColor.r, majorColor.g, majorColor.b, majorColor.r, majorColor.g, majorColor.b);
        }
      }

      // Axis lines (x=0 and y=0)
      for (let x = left; x <= right; x += minorSpacing) {
        if (isAxisLine(x)) {
          positions.push(x, bottom, zAxis, x, top, zAxis);
          colors.push(axisColor.r, axisColor.g, axisColor.b, axisColor.r, axisColor.g, axisColor.b);
        }
      }
      for (let y = bottom; y <= top; y += minorSpacing) {
        if (isAxisLine(y)) {
          positions.push(left, y, zAxis, right, y, zAxis);
          colors.push(axisColor.r, axisColor.g, axisColor.b, axisColor.r, axisColor.g, axisColor.b);
        }
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
      for (const mesh of state.transformPointMeshes) {
        mesh.scale.setScalar(scale);
      }
    };

    stateRef.current.updatePointScales = updatePointScales;

    // Initial grid
    updateGrid();

    // Render loop with animation time update
    let frameId: number;
    const startTime = performance.now();
    const render = () => {
      frameId = requestAnimationFrame(render);
      // Update animation time for AnimatedInstancedMesh
      const timeSeconds = (performance.now() - startTime) / 1000;
      updateAnimationTime(animatedMeshMaterial, timeSeconds);
      renderer.render(scene, camera);
    };
    render();

    // Resize handler - preserve center and zoom, adjust for new aspect ratio
    const onResize = () => {
      const state = stateRef.current;
      if (!state) return;
      const { clientWidth: w, clientHeight: h } = container;
      const a = w / h;
      // Preserve the center of the current view
      const centerX = (camera.left + camera.right) / 2;
      const centerY = (camera.top + camera.bottom) / 2;
      // Calculate new bounds using current zoom and new aspect ratio
      const halfWidth = frustum * a * state.zoom;
      const halfHeight = frustum * state.zoom;
      camera.left = centerX - halfWidth;
      camera.right = centerX + halfWidth;
      camera.top = centerY + halfHeight;
      camera.bottom = centerY - halfHeight;
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

  // Update grid visibility when showGrid changes
  useEffect(() => {
    const state = stateRef.current;
    if (state) {
      state.updateGrid();
    }
  }, [showGrid]);

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
    let startDistance: number | null = null;
    let totalDx = 0;
    let totalDy = 0;
    let totalAngle = 0;
    let totalScale = 1;
    let isRotating = false;
    let isScaling = false;
    let isDraggingPoint = false;
    let dragPointIndex = -1;
    let dragPointOriginalPos: Point | null = null; // Original position of the anchor being dragged (for snapping)
    let isDraggingHandle = false;
    let dragHandleType: HandleType = "anchor";
    let dragSegmentIndex = -1;
    let dragHandleOriginalPos: Point | null = null; // Original position of the control point being dragged (for snapping)
    let dragMirrorHandleOriginalPos: Point | null = null; // Original position of the mirrored handle (for undo tracking)
    let dragMirrorSegmentIndex = -1;
    let dragMirrorHandleType: HandleType = "anchor";
    let dragInitialStart: Point | null = null; // Initial mouse position when drag started (doesn't update each frame)
    let isPanning = false;
    let panStart: Point | null = null;
    let isDraggingSelection = false; // True when dragging multiple items
    let dragPrevAnimation: import("./animation.ts").PartAnimation | null = null; // Previous animation state for undo in animation mode
    let dragPrevAnimations: Map<string, import("./animation.ts").PartAnimation> | null = null; // Previous animations for multi-selection undo
    let isBoxSelecting = false;
    let boxSelectStart: Point | null = null;
    let boxSelectAdditive = false; // True when shift is held (add to selection)
    let snappedToTarget: SnapPoint | null = null; // Track which point we snapped to (for creating connection)
    // Track snap targets during path drawing: map from point index to snap target info
    let drawingSnapTargets: Map<number, { pathId: string; segmentIndex: number }> = new Map();
    // Blob tool state
    let isBlobbing = false;
    let blobPoints: Point[] = [];
    let blobMode: "add" | "subtract" | "create" = "create"; // Mode determined at start of stroke
    let blobTargetPathIds: string[] = []; // Paths to modify (for add/subtract modes)
    let lastBlobTime = 0; // Timestamp of last blob point for velocity calculation
    // Transform point dragging state
    let isDraggingTransformPoint = false;
    let dragTransformPointItemId: string | null = null;
    let dragTransformPointItemType: "path" | "group" | null = null;
    let dragTransformPointOriginal: Point | null = null;
    // Transform handle dragging state (for selection bounding box handles)
    let isDraggingTransformHandle = false;
    let transformHandleType: "corner" | "rotation" | null = null;
    let transformHandleCornerIndex = -1; // 0=BL, 1=BR, 2=TR, 3=TL
    let transformHandleStartBounds: BoundingBox | null = null;
    let transformHandleCenter: Point | null = null;
    let transformHandleStartAngle: number | null = null;
    let transformHandlePreserveAspect = false;
    // Cumulative tracking for undo/redo
    let transformHandleTotalAngle = 0; // Cumulative rotation angle
    let transformHandleTotalScaleX = 1; // Cumulative X scale
    let transformHandleTotalScaleY = 1; // Cumulative Y scale
    let transformHandlePrevScaleX = 1; // Previous frame's scale (for delta calculation)
    let transformHandlePrevScaleY = 1;
    // Click-to-cycle state: only cycle through overlapping paths on mouseup (not mousedown)
    // This allows dragging an already-selected path without it cycling away
    let pendingCyclePathsAtPoint: string[] = [];
    let pendingCycleClickPoint: Point | null = null;
    let pendingCycleWasAlreadySelected = false;
    // Drag threshold state: prevent accidental drags when clicking
    // Drag only starts after moving MIN_DRAG_DISTANCE pixels OR holding for MIN_DRAG_TIME_MS
    const MIN_DRAG_DISTANCE = 5; // Screen pixels
    const MIN_DRAG_TIME_MS = 100;
    let dragThresholdMet = false;
    let dragStartTime = 0;
    let dragStartScreen: Point | null = null; // Screen-space start position for distance check

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

    // Helper to find if a click is on a transform point
    const findNearestTransformPoint = (
      clickPoint: Point,
      threshold: number,
    ): { id: string; type: "path" | "group"; point: Point } | null => {
      const { paths, groups, showTransformPoints } = store.getState();

      // Only check if transform points are visible (respects toggle even in animation mode)
      if (!showTransformPoints) return null;

      let nearest: { id: string; type: "path" | "group"; dist: number; point: Point } | null = null;

      // Check paths
      for (const path of paths) {
        if (!path.visible) continue;
        const transformPoint = getPathTransformPoint(path);
        const dist = distance(clickPoint, transformPoint);
        if (dist < threshold && (!nearest || dist < nearest.dist)) {
          nearest = { id: path.id, type: "path", dist, point: transformPoint };
        }
      }

      // Check groups
      for (const group of groups) {
        const transformPoint = getGroupTransformPoint(group, paths, groups);
        const dist = distance(clickPoint, transformPoint);
        if (dist < threshold && (!nearest || dist < nearest.dist)) {
          nearest = { id: group.id, type: "group", dist, point: transformPoint };
        }
      }

      return nearest ? { id: nearest.id, type: nearest.type, point: nearest.point } : null;
    };

    const onMouseDown = (e: MouseEvent) => {
      // Middle mouse button for panning
      if (e.button === MouseButton.MIDDLE) {
        isPanning = true;
        panStart = screenToWorld(e, container, state.camera);
        e.preventDefault();
        return;
      }

      // Blob tool handling
      // Block blob tool when animation clip is active (geometry editing disabled)
      if (tool === "blob" && e.button === MouseButton.LEFT) {
        const { currentClipId: activeClipId } = store.getState();
        if (activeClipId) {
          // In animation mode - blob tool is disabled
          e.preventDefault();
          return;
        }
        const clickPoint = screenToWorld(e, container, state.camera);
        const { paths, selection, blobRadius } = store.getState();

        isBlobbing = true;
        blobPoints = [clickPoint];
        lastBlobTime = performance.now();
        setBlobPreviewPointsRef.current([clickPoint]);

        // Determine mode based on selection and click position
        const selectedPaths = selection.pathIds
          .map((id) => paths.find((p) => p.id === id))
          .filter((p): p is Path => p !== undefined && p.visible && !p.locked);

        if (selectedPaths.length === 0) {
          // No selection - create new path
          blobMode = "create";
          blobTargetPathIds = [];
        } else {
          // Check if click is over any selected path
          let clickedOnSelected = false;
          for (const path of selectedPaths) {
            // Simple point-in-polygon check using Paper.js
            const paperPath = new paper.Path();
            for (const seg of path.segments) {
              paperPath.add(new paper.Segment(
                new paper.Point(seg.p0.x, seg.p0.y),
                undefined,
                new paper.Point(seg.c0.x - seg.p0.x, seg.c0.y - seg.p0.y)
              ));
            }
            if (path.closed) {
              paperPath.closed = true;
              // Set the incoming handle of the first point
              const lastSeg = path.segments[path.segments.length - 1];
              paperPath.firstSegment.handleIn = new paper.Point(
                lastSeg.c1.x - path.segments[0].p0.x,
                lastSeg.c1.y - path.segments[0].p0.y
              );
            }
            // Fix handles for all segments
            for (let i = 0; i < path.segments.length; i++) {
              const seg = path.segments[i];
              const nextIdx = (i + 1) % path.segments.length;
              if (i < path.segments.length - 1 || path.closed) {
                paperPath.segments[i].handleOut = new paper.Point(
                  seg.c0.x - seg.p0.x, seg.c0.y - seg.p0.y
                );
                paperPath.segments[nextIdx].handleIn = new paper.Point(
                  seg.c1.x - path.segments[nextIdx].p0.x,
                  seg.c1.y - path.segments[nextIdx].p0.y
                );
              }
            }

            // Check if point is inside or within blob radius of the path
            const testPoint = new paper.Point(clickPoint.x, clickPoint.y);
            if (paperPath.contains(testPoint) || paperPath.getNearestPoint(testPoint).getDistance(testPoint) <= blobRadius) {
              clickedOnSelected = true;
            }
            paperPath.remove();
            if (clickedOnSelected) break;
          }

          if (clickedOnSelected) {
            // Started on a selected path - add mode
            blobMode = "add";
            blobTargetPathIds = selectedPaths.map((p) => p.id);
          } else {
            // Started outside selected paths - subtract mode (eraser)
            blobMode = "subtract";
            blobTargetPathIds = selectedPaths.map((p) => p.id);
          }
        }

        e.preventDefault();
        return;
      }

      if (tool !== "select") return;

      const { paths, selection, currentClipId: activeClipId, animationClips, playbackTime, groups } = store.getState();
      const clickPoint = screenToWorld(e, container, state.camera);
      const isShiftClick = e.shiftKey;
      const isAnimationMode = activeClipId !== null;

      // Check for transform handle click first (only in edit mode with a selection)
      if (!isAnimationMode && (selection.pathIds.length > 0 || selection.points.length > 0)) {
        const handleHitThreshold = VERTEX_SIZE * 2 * state.zoom;
        const { transformHandles } = state;

        // Check rotation handle
        if (transformHandles.rotationHandle) {
          const handlePos = transformHandles.rotationHandle.position;
          const dist = distance(clickPoint, { x: handlePos.x, y: handlePos.y });
          if (dist <= handleHitThreshold) {
            // Start rotation drag
            isDraggingTransformHandle = true;
            transformHandleType = "rotation";
            transformHandlePreserveAspect = false;

            // Calculate selection bounds and center for rotation
            const selectedPathIds = new Set<string>();
            for (const id of selection.pathIds) {
              const group = groups.find((g) => g.id === id);
              if (group) {
                const descendantIds = store.getDescendantPathIds(id);
                for (const pid of descendantIds) selectedPathIds.add(pid);
              } else {
                selectedPathIds.add(id);
              }
            }
            for (const pt of selection.points) selectedPathIds.add(pt.pathId);

            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const pathId of selectedPathIds) {
              const path = paths.find((p) => p.id === pathId);
              if (!path || !path.visible) continue;
              const bounds = getPathBounds(path);
              minX = Math.min(minX, bounds.minX);
              minY = Math.min(minY, bounds.minY);
              maxX = Math.max(maxX, bounds.maxX);
              maxY = Math.max(maxY, bounds.maxY);
            }
            transformHandleStartBounds = { minX, minY, maxX, maxY };
            transformHandleCenter = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
            transformHandleStartAngle = Math.atan2(
              clickPoint.y - transformHandleCenter.y,
              clickPoint.x - transformHandleCenter.x
            );
            transformHandleTotalAngle = 0; // Reset cumulative angle
            dragStart = clickPoint;
            e.preventDefault();
            return;
          }
        }

        // Check corner handles
        for (let i = 0; i < transformHandles.corners.length; i++) {
          const corner = transformHandles.corners[i];
          const cornerPos = corner.position;
          const dist = distance(clickPoint, { x: cornerPos.x, y: cornerPos.y });
          if (dist <= handleHitThreshold) {
            // Start scale drag
            isDraggingTransformHandle = true;
            transformHandleType = "corner";
            transformHandleCornerIndex = i;
            transformHandlePreserveAspect = e.shiftKey;

            // Calculate selection bounds and center for scaling
            const selectedPathIds = new Set<string>();
            for (const id of selection.pathIds) {
              const group = groups.find((g) => g.id === id);
              if (group) {
                const descendantIds = store.getDescendantPathIds(id);
                for (const pid of descendantIds) selectedPathIds.add(pid);
              } else {
                selectedPathIds.add(id);
              }
            }
            for (const pt of selection.points) selectedPathIds.add(pt.pathId);

            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const pathId of selectedPathIds) {
              const path = paths.find((p) => p.id === pathId);
              if (!path || !path.visible) continue;
              const bounds = getPathBounds(path);
              minX = Math.min(minX, bounds.minX);
              minY = Math.min(minY, bounds.minY);
              maxX = Math.max(maxX, bounds.maxX);
              maxY = Math.max(maxY, bounds.maxY);
            }
            transformHandleStartBounds = { minX, minY, maxX, maxY };
            // The pivot is the opposite corner from the one being dragged
            const pivotCorners: Point[] = [
              { x: maxX, y: maxY }, // Dragging BL, pivot at TR
              { x: minX, y: maxY }, // Dragging BR, pivot at TL
              { x: minX, y: minY }, // Dragging TR, pivot at BL
              { x: maxX, y: minY }, // Dragging TL, pivot at BR
            ];
            transformHandleCenter = pivotCorners[i];
            // Reset cumulative scale tracking
            transformHandleTotalScaleX = 1;
            transformHandleTotalScaleY = 1;
            transformHandlePrevScaleX = 1;
            transformHandlePrevScaleY = 1;
            dragStart = clickPoint;
            e.preventDefault();
            return;
          }
        }
      }

      // Check for transform point click first (highest priority when visible)
      const hitThreshold = VERTEX_SIZE * 2 * state.zoom;
      const transformPointHit = findNearestTransformPoint(clickPoint, hitThreshold);
      if (transformPointHit) {
        // Select the path/group when clicking its transform point
        if (transformPointHit.type === "path") {
          if (isShiftClick) {
            // Toggle selection
            store.toggleInSelection(transformPointHit.id);
          } else {
            // Replace selection
            store.selectPath(transformPointHit.id);
          }
        } else if (transformPointHit.type === "group") {
          // Select all paths in the group
          const groupPaths = paths.filter((p) => p.parentId === transformPointHit.id);
          const groupPathIds = groupPaths.map((p) => p.id);
          if (isShiftClick) {
            // Check if all paths in group are already selected
            const allSelected = groupPathIds.every((id) => selection.pathIds.includes(id));
            if (allSelected && groupPathIds.length > 0) {
              // Remove all paths in group from selection (toggle each one)
              for (const pathId of groupPathIds) {
                store.toggleInSelection(pathId);
              }
            } else {
              // Add all paths in group to selection
              for (const pathId of groupPathIds) {
                if (!selection.pathIds.includes(pathId)) {
                  store.addToSelection(pathId);
                }
              }
            }
          } else {
            // Replace selection with all paths in the group
            if (groupPathIds.length > 0) {
              store.setSelection({ pathIds: groupPathIds, points: [] });
            }
          }
        }

        isDraggingTransformPoint = true;
        dragTransformPointItemId = transformPointHit.id;
        dragTransformPointItemType = transformPointHit.type;
        dragTransformPointOriginal = transformPointHit.point;
        dragStart = clickPoint;
        e.preventDefault();
        return;
      }

      // Get paths that have something selected
      const selectedPathIds = new Set(selection.pathIds);
      for (const pt of selection.points) {
        selectedPathIds.add(pt.pathId);
      }

      // Skip individual point/handle editing when in animation mode
      // (only allow whole-path selection and dragging)
      if (isAnimationMode) {
        // Skip directly to path selection logic (after all the point/handle checks)
        // Jump to the path containment check
        goto_path_selection: {
          // Check which paths contain the clicked point using cycling logic
          // Use inverse transform for hit testing in animation mode
          const visiblePaths = paths.filter((p) => p.visible);
          const activeClip = animationClips.find((c) => c.id === activeClipId) ?? null;

          // Find all paths at click point using cycle-aware helper
          const pathsAtPoint = findPathsAtPoint(
            clickPoint,
            visiblePaths,
            activeClip,
            playbackTime,
            store.getAncestorChain,
            getEffectiveTransform,
            applyInverseTransform
          );

          // Get current selection to determine cycling
          const currentSelection = store.getState().selection;
          const currentlySelectedId = currentSelection.pathIds.length === 1 ? currentSelection.pathIds[0] : null;

          // Check if clicking on an already-selected path
          // If so, don't cycle on mousedown - allow dragging. Cycle on mouseup if no drag occurred.
          const topmostPath = pathsAtPoint[0] ?? null;
          const clickedIsAlreadySelected = topmostPath && currentSelection.pathIds.includes(topmostPath);

          // Determine which path to select on mousedown
          let clickedPathId: string | null;
          if (clickedIsAlreadySelected) {
            // Keep current selection - will cycle on mouseup if it's a simple click
            clickedPathId = topmostPath;
            // Store info for potential cycling on mouseup
            pendingCyclePathsAtPoint = pathsAtPoint;
            pendingCycleClickPoint = clickPoint;
            pendingCycleWasAlreadySelected = true;
          } else {
            // Not already selected - select topmost (or use cycle logic if something else was selected)
            clickedPathId = getNextPathInCycle(pathsAtPoint, currentlySelectedId, currentSelection.pathIds);
            // Store info for potential cycling on mouseup
            pendingCyclePathsAtPoint = pathsAtPoint;
            pendingCycleClickPoint = clickPoint;
            pendingCycleWasAlreadySelected = false;
          }
          const clickedPath = clickedPathId ? paths.find((p) => p.id === clickedPathId) ?? null : null;

          if (isShiftClick && clickedPathId) {
            // Toggle path in selection
            store.toggleInSelection(clickedPathId);
            // Clear pending cycle on shift-click
            pendingCyclePathsAtPoint = [];
            pendingCycleClickPoint = null;
          } else if (clickedPathId) {
            // If clicked path is already in selection (directly or via ancestor group), preserve selection
            const clickedIsSelected = store.isEffectivelySelected(clickedPathId);
            if (!clickedIsSelected) {
              store.selectPath(clickedPathId);
            }
          } else {
            // Clicked empty space
            // If Alt is held, don't clear selection - user may be scaling/rotating from empty space
            if (e.altKey) {
              const currentSelection = store.getState().selection;
              if (currentSelection.pathIds.length > 0) {
                isDragging = true;
                isDraggingPoint = false;
                isDraggingHandle = false;
                dragPointIndex = -1;
                dragStart = clickPoint;
                dragPathId = currentSelection.pathIds[0];
                isDraggingSelection = currentSelection.pathIds.length > 1;

                dragCenter = getSelectionBoundingCenter(paths, currentSelection.pathIds);
                // In animation mode, offset drag center by animated translation
                if (activeClip && dragCenter && currentSelection.pathIds.length === 1) {
                  const partId = currentSelection.pathIds[0];
                  const partAnim = activeClip.parts[partId] ?? [];
                  const animTx = getPropertyValue(partAnim, "tx", playbackTime);
                  const animTy = getPropertyValue(partAnim, "ty", playbackTime);
                  dragCenter = { x: dragCenter.x + animTx, y: dragCenter.y + animTy };
                }
                startAngle = Math.atan2(clickPoint.y - dragCenter.y, clickPoint.x - dragCenter.x);
                startDistance = distance(clickPoint, dragCenter);
                // Alt-drag for rotation/scale should start immediately (no threshold)
                dragThresholdMet = true;
                dragStartTime = Date.now();
                dragStartScreen = { x: e.clientX, y: e.clientY };
                e.preventDefault();
                return;
              }
            }
            // Start box selection
            isBoxSelecting = true;
            boxSelectStart = clickPoint;
            boxSelectAdditive = isShiftClick;
            if (!isShiftClick) {
              store.selectPath(null);
            }
            e.preventDefault();
            return;
          }

          // Start drag if we clicked on a path (not locked) - use transform-based in animation mode
          if (clickedPath && clickedPathId && !clickedPath.locked) {
            isDragging = true;
            isDraggingPoint = false;
            isDraggingHandle = false;
            dragPointIndex = -1;
            dragStart = clickPoint;

            // Check if the clicked path is selected via an ancestor group
            // If so, we drag the group (not the individual path)
            const selectedAncestorGroupId = store.getSelectedAncestorGroupId(clickedPathId);
            const effectiveDragId = selectedAncestorGroupId ?? clickedPathId;
            dragPathId = effectiveDragId;

            // Check if we're dragging a multi-selection
            const currentSelection = store.getState().selection;
            isDraggingSelection = currentSelection.pathIds.length > 1 ||
              (currentSelection.pathIds.length > 0 && currentSelection.points.length > 0) ||
              currentSelection.points.length > 1;

            // Capture animation state for undo in animation mode
            if (activeClip) {
              if (isDraggingSelection) {
                // Capture previous animations for all selected paths
                dragPrevAnimations = new Map();
                for (const pathId of currentSelection.pathIds) {
                  dragPrevAnimations.set(pathId, activeClip.parts[pathId] ? [...activeClip.parts[pathId]] : []);
                }
                dragPrevAnimation = null;
              } else {
                dragPrevAnimation = activeClip.parts[effectiveDragId] ? [...activeClip.parts[effectiveDragId]] : [];
                dragPrevAnimations = null;
              }
            } else {
              dragPrevAnimation = null;
              dragPrevAnimations = null;
            }

            // Use selection center for multi-selection, otherwise single path transform point
            if (isDraggingSelection) {
              // For multi-selection, use bounding box center
              dragCenter = getSelectionBoundingCenter(paths, currentSelection.pathIds);
            } else {
              dragCenter = getPathTransformPoint(clickedPath);
            }

            // In animation mode, offset drag center by animated translation
            if (activeClip && dragCenter) {
              const partAnim = activeClip.parts[effectiveDragId] ?? [];
              const animTx = getPropertyValue(partAnim, "tx", playbackTime);
              const animTy = getPropertyValue(partAnim, "ty", playbackTime);
              dragCenter = { x: dragCenter.x + animTx, y: dragCenter.y + animTy };
            }

            if (dragStart && dragCenter) {
              startAngle = Math.atan2(
                dragStart.y - dragCenter.y,
                dragStart.x - dragCenter.x,
              );
              startDistance = distance(dragStart, dragCenter);
            }
            totalDx = 0;
            totalDy = 0;
            totalAngle = 0;
            totalScale = 1;
            isRotating = false;
            isScaling = false;
            // Initialize drag threshold state for path dragging (not point/handle)
            dragThresholdMet = false;
            dragStartTime = Date.now();
            dragStartScreen = { x: e.clientX, y: e.clientY };
            e.preventDefault();
          }
        }
        return;
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

          // Check if path is fully selected (in pathIds)
          const isPathFullySelected = selection.pathIds.includes(pathId);

          if (isShiftClick) {
            store.toggleInSelection(undefined, pointSel);
          } else if (e.altKey && isPathFullySelected) {
            // Alt+drag on fully-selected path: preserve selection for scale/rotate
            // Don't change selection
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

          // Capture mirrored handle position for undo tracking
          dragMirrorHandleOriginalPos = null;
          dragMirrorSegmentIndex = -1;
          dragMirrorHandleType = "anchor";

          // Calculate mirrored handle info if mirroring is enabled
          let mirrorAnchorIndex: number;
          if (handle.handleType === "c0") {
            mirrorAnchorIndex = handle.segmentIndex;
            dragMirrorSegmentIndex = handle.segmentIndex === 0
              ? (selectedPath.closed ? selectedPath.segments.length - 1 : -1)
              : handle.segmentIndex - 1;
            dragMirrorHandleType = "c1";
          } else {
            const nextIdx = selectedPath.closed
              ? (handle.segmentIndex + 1) % selectedPath.segments.length
              : handle.segmentIndex + 1;
            mirrorAnchorIndex = nextIdx;
            dragMirrorSegmentIndex = (selectedPath.closed || handle.segmentIndex < selectedPath.segments.length - 1) ? nextIdx : -1;
            dragMirrorHandleType = "c0";
          }

          if (dragMirrorSegmentIndex >= 0) {
            const anchorMeta = selectedPath.anchorMeta?.[mirrorAnchorIndex];
            const mirrorAngle = anchorMeta?.mirrorAngle || false;
            const mirrorDistance = anchorMeta?.mirrorDistance || false;
            const mirroredActive = dragMirrorHandleType === "c0"
              ? selectedPath.anchorMeta?.[mirrorAnchorIndex]?.rightActive !== false
              : selectedPath.anchorMeta?.[mirrorAnchorIndex]?.leftActive !== false;

            if ((mirrorAngle || mirrorDistance) && mirroredActive) {
              const mirrorSeg = selectedPath.segments[dragMirrorSegmentIndex];
              dragMirrorHandleOriginalPos = dragMirrorHandleType === "c0" ? { ...mirrorSeg.c0 } : { ...mirrorSeg.c1 };
            }
          }

          dragStart = clickPoint;
          dragInitialStart = clickPoint; // Track initial position for absolute snapping
          dragPathId = pathId;
          totalDx = 0;
          totalDy = 0;

          // If Alt is held, set up for scale/rotate
          if (e.altKey && updatedSelection.pathIds.length > 0) {
            dragCenter = getSelectionBoundingCenter(paths, updatedSelection.pathIds);
            startAngle = Math.atan2(clickPoint.y - dragCenter.y, clickPoint.x - dragCenter.x);
            startDistance = distance(clickPoint, dragCenter);
          }

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
          } else if (e.altKey && isPathFullySelected) {
            // Alt+drag on fully-selected path: preserve selection for scale/rotate
            // Don't change selection
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

          // If Alt is held, set up for scale/rotate
          if (e.altKey && updatedSelection.pathIds.length > 0) {
            dragCenter = getSelectionBoundingCenter(paths, updatedSelection.pathIds);
            startAngle = Math.atan2(clickPoint.y - dragCenter.y, clickPoint.x - dragCenter.x);
            startDistance = distance(clickPoint, dragCenter);
          }

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

            // Capture mirrored handle position for undo tracking
            dragMirrorHandleOriginalPos = null;
            dragMirrorSegmentIndex = -1;
            dragMirrorHandleType = "anchor";

            // Calculate mirrored handle info if mirroring is enabled
            let mirrorAnchorIdx: number;
            if (handle.handleType === "c0") {
              mirrorAnchorIdx = handle.segmentIndex;
              dragMirrorSegmentIndex = handle.segmentIndex === 0
                ? (path.closed ? path.segments.length - 1 : -1)
                : handle.segmentIndex - 1;
              dragMirrorHandleType = "c1";
            } else {
              const nextIdx = path.closed
                ? (handle.segmentIndex + 1) % path.segments.length
                : handle.segmentIndex + 1;
              mirrorAnchorIdx = nextIdx;
              dragMirrorSegmentIndex = (path.closed || handle.segmentIndex < path.segments.length - 1) ? nextIdx : -1;
              dragMirrorHandleType = "c0";
            }

            if (dragMirrorSegmentIndex >= 0) {
              const anchorMeta = path.anchorMeta?.[mirrorAnchorIdx];
              const mirrorAngle = anchorMeta?.mirrorAngle || false;
              const mirrorDistance = anchorMeta?.mirrorDistance || false;
              const mirroredActive = dragMirrorHandleType === "c0"
                ? path.anchorMeta?.[mirrorAnchorIdx]?.rightActive !== false
                : path.anchorMeta?.[mirrorAnchorIdx]?.leftActive !== false;

              if ((mirrorAngle || mirrorDistance) && mirroredActive) {
                const mirrorSeg = path.segments[dragMirrorSegmentIndex];
                dragMirrorHandleOriginalPos = dragMirrorHandleType === "c0" ? { ...mirrorSeg.c0 } : { ...mirrorSeg.c1 };
              }
            }

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

          // Check if this path is already selected (for Alt+drag to preserve selection)
          const currentSelection = store.getState().selection;
          const pathAlreadySelected = currentSelection.pathIds.includes(path.id);

          if (isShiftClick) {
            store.toggleInSelection(undefined, pointSel);
          } else if (e.altKey && pathAlreadySelected) {
            // Alt+drag on already-selected path: preserve selection for scale/rotate
            // Don't change selection
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

          // If Alt is held, set up for scale/rotate
          if (e.altKey && updatedSelection.pathIds.length > 0) {
            dragCenter = getSelectionBoundingCenter(paths, updatedSelection.pathIds);
            startAngle = Math.atan2(clickPoint.y - dragCenter.y, clickPoint.x - dragCenter.x);
            startDistance = distance(clickPoint, dragCenter);
          }

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

      // Check which path contains the clicked point using cycling logic
      // Get current animation state for transform-aware hit testing
      const { currentClipId: clipId, animationClips: clips, playbackTime: time } = store.getState();
      const activeClip = clipId
        ? clips.find((c) => c.id === clipId) ?? null
        : null;

      // Find all paths at click point using cycle-aware helper
      const pathsAtPoint = findPathsAtPoint(
        clickPoint,
        visiblePaths,
        activeClip,
        time,
        store.getAncestorChain,
        getEffectiveTransform,
        applyInverseTransform
      );

      // Get current selection to determine cycling
      const currentSelection = store.getState().selection;
      const currentlySelectedId = currentSelection.pathIds.length === 1 ? currentSelection.pathIds[0] : null;

      // Check if clicking on an already-selected path
      // If so, don't cycle on mousedown - allow dragging. Cycle on mouseup if no drag occurred.
      const topmostPath = pathsAtPoint[0] ?? null;
      const clickedIsAlreadySelected = topmostPath && currentSelection.pathIds.includes(topmostPath);

      // Determine which path to select on mousedown
      let clickedPathId: string | null;
      if (clickedIsAlreadySelected) {
        // Keep current selection - will cycle on mouseup if it's a simple click
        clickedPathId = topmostPath;
        // Store info for potential cycling on mouseup
        pendingCyclePathsAtPoint = pathsAtPoint;
        pendingCycleClickPoint = clickPoint;
        pendingCycleWasAlreadySelected = true;
      } else {
        // Not already selected - select topmost (or use cycle logic if something else was selected)
        clickedPathId = getNextPathInCycle(pathsAtPoint, currentlySelectedId, currentSelection.pathIds);
        // Store info for potential cycling on mouseup
        pendingCyclePathsAtPoint = pathsAtPoint;
        pendingCycleClickPoint = clickPoint;
        pendingCycleWasAlreadySelected = false;
      }
      const clickedPath = clickedPathId ? paths.find((p) => p.id === clickedPathId) ?? null : null;

      if (isShiftClick && clickedPathId) {
        // Check if Alt is held and path is already selected - preserve selection for scale/rotate
        const clickedIsSelected = currentSelection.pathIds.includes(clickedPathId);
        if (e.altKey && clickedIsSelected) {
          // Alt+Shift+drag on selected path: preserve selection for scale/rotate
          // Don't toggle
        } else {
          // Toggle path in selection
          store.toggleInSelection(clickedPathId);
        }
        // Clear pending cycle on shift-click
        pendingCyclePathsAtPoint = [];
        pendingCycleClickPoint = null;
      } else if (clickedPathId) {
        // If clicked path is already in selection (directly or via ancestor group), preserve selection
        const clickedIsSelected = store.isEffectivelySelected(clickedPathId);
        if (!clickedIsSelected) {
          store.selectPath(clickedPathId);
        }
      } else {
        // Clicked empty space
        // If Alt is held, don't clear selection - user may be scaling/rotating from empty space
        if (e.altKey) {
          // Start drag for scale/rotate even when clicking on empty space
          const currentSelection = store.getState().selection;
          if (currentSelection.pathIds.length > 0) {
            isDragging = true;
            isDraggingPoint = false;
            isDraggingHandle = false;
            dragPointIndex = -1;
            dragStart = clickPoint;
            // Use first selected path as drag target
            dragPathId = currentSelection.pathIds[0];
            isDraggingSelection = currentSelection.pathIds.length > 1;

            // Calculate center for rotation/scaling using bounding box center
            dragCenter = getSelectionBoundingCenter(paths, currentSelection.pathIds);
            // In animation mode, offset drag center by animated translation
            if (activeClip && dragCenter && currentSelection.pathIds.length === 1) {
              const partId = currentSelection.pathIds[0];
              const partAnim = activeClip.parts[partId] ?? [];
              const animTx = getPropertyValue(partAnim, "tx", playbackTime);
              const animTy = getPropertyValue(partAnim, "ty", playbackTime);
              dragCenter = { x: dragCenter.x + animTx, y: dragCenter.y + animTy };
            }
            startAngle = Math.atan2(clickPoint.y - dragCenter.y, clickPoint.x - dragCenter.x);
            startDistance = distance(clickPoint, dragCenter);
            // Alt-drag for rotation/scale should start immediately (no threshold)
            dragThresholdMet = true;
            dragStartTime = Date.now();
            dragStartScreen = { x: e.clientX, y: e.clientY };
            e.preventDefault();
            return;
          }
        }
        // Start box selection
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

        // Check if the clicked path is selected via an ancestor group
        // If so, we drag the group (not the individual path)
        const selectedAncestorGroupId = store.getSelectedAncestorGroupId(clickedPathId);
        const effectiveDragId = selectedAncestorGroupId ?? clickedPathId;
        dragPathId = effectiveDragId;

        // Check if we're dragging a multi-selection
        const currentSelection = store.getState().selection;
        isDraggingSelection = currentSelection.pathIds.length > 1 ||
          (currentSelection.pathIds.length > 0 &&
            currentSelection.points.length > 0) ||
          currentSelection.points.length > 1;

        // Capture animation state for undo in animation mode
        if (activeClip) {
          if (isDraggingSelection) {
            // Capture previous animations for all selected paths
            dragPrevAnimations = new Map();
            for (const pathId of currentSelection.pathIds) {
              dragPrevAnimations.set(pathId, activeClip.parts[pathId] ? [...activeClip.parts[pathId]] : []);
            }
            dragPrevAnimation = null;
          } else {
            dragPrevAnimation = activeClip.parts[effectiveDragId] ? [...activeClip.parts[effectiveDragId]] : [];
            dragPrevAnimations = null;
          }
        } else {
          dragPrevAnimation = null;
          dragPrevAnimations = null;
        }

        // Use selection center for multi-selection, otherwise single path transform point
        if (isDraggingSelection) {
          // For multi-selection, use bounding box center
          dragCenter = getSelectionBoundingCenter(paths, currentSelection.pathIds);
        } else {
          dragCenter = getPathTransformPoint(clickedPath);
        }

        // In animation mode, offset drag center by animated translation
        if (activeClip && dragCenter) {
          const partAnim = activeClip.parts[effectiveDragId] ?? [];
          const animTx = getPropertyValue(partAnim, "tx", playbackTime);
          const animTy = getPropertyValue(partAnim, "ty", playbackTime);
          dragCenter = { x: dragCenter.x + animTx, y: dragCenter.y + animTy };
        }

        if (dragStart && dragCenter) {
          startAngle = Math.atan2(
            dragStart.y - dragCenter.y,
            dragStart.x - dragCenter.x,
          );
          startDistance = distance(dragStart, dragCenter);
        }
        totalDx = 0;
        totalDy = 0;
        totalAngle = 0;
        totalScale = 1;
        isRotating = false;
        isScaling = false;
        // Initialize drag threshold state for path dragging (not point/handle)
        dragThresholdMet = false;
        dragStartTime = Date.now();
        dragStartScreen = { x: e.clientX, y: e.clientY };
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

      // Handle blob tool dragging
      if (isBlobbing) {
        const point = screenToWorld(e, container, state.camera);
        const { blobRadius } = store.getState();
        const now = performance.now();

        // Only add point if it's far enough from the last point (reduces redundant circles)
        const lastPoint = blobPoints[blobPoints.length - 1];
        const dist = Math.sqrt(
          (point.x - lastPoint.x) ** 2 + (point.y - lastPoint.y) ** 2
        );

        // Calculate velocity-based minimum distance
        // Slow movements = smaller min distance for precision
        // Fast movements = larger min distance for performance
        const dt = Math.max(1, now - lastBlobTime); // ms since last point
        const velocity = dist / dt; // world units per ms
        // Scale from 0.05 (slow) to 1.0 (fast) of radius based on velocity
        // velocity of ~0.01 is slow, ~0.1+ is fast
        const velocityFactor = Math.min(1, Math.max(0.05, velocity * 10));
        const minDist = blobRadius * velocityFactor * 0.5;

        if (dist >= minDist) {
          blobPoints.push(point);
          lastBlobTime = now;
          setBlobPreviewPointsRef.current([...blobPoints]);
        }
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

      // Handle transform point dragging
      if (isDraggingTransformPoint && dragStart && dragTransformPointItemId && dragTransformPointItemType) {
        const currentPoint = screenToWorld(e, container, state.camera);
        // Set the transform point to the current mouse position (live, no undo)
        store.setTransformPointLive(dragTransformPointItemId, dragTransformPointItemType, currentPoint);
        return;
      }

      // Handle transform handle dragging (scale/rotate from bounding box handles)
      if (isDraggingTransformHandle && transformHandleCenter && transformHandleStartBounds) {
        const currentPoint = screenToWorld(e, container, state.camera);

        // Check if shift is currently held for aspect ratio preservation
        transformHandlePreserveAspect = e.shiftKey;

        if (transformHandleType === "rotation") {
          // Rotation drag
          const currentAngle = Math.atan2(
            currentPoint.y - transformHandleCenter.y,
            currentPoint.x - transformHandleCenter.x
          );
          const deltaAngle = currentAngle - (transformHandleStartAngle ?? 0);

          // Track cumulative angle for undo
          transformHandleTotalAngle += deltaAngle;

          // Rotate selection around center (delta-based)
          store.rotateSelectionLive(deltaAngle, transformHandleCenter);
          transformHandleStartAngle = currentAngle;
        } else if (transformHandleType === "corner") {
          // Scale drag
          const bounds = transformHandleStartBounds;
          const pivot = transformHandleCenter;

          // Calculate cumulative scale based on how far the corner has moved from its ORIGINAL position
          // Corner indices: 0=BL, 1=BR, 2=TR, 3=TL
          const originalCorners: Point[] = [
            { x: bounds.minX, y: bounds.minY },
            { x: bounds.maxX, y: bounds.minY },
            { x: bounds.maxX, y: bounds.maxY },
            { x: bounds.minX, y: bounds.maxY },
          ];
          const originalCorner = originalCorners[transformHandleCornerIndex];

          // Distance from pivot to original corner vs current mouse position
          const originalDist = distance(pivot, originalCorner);
          const currentDist = distance(pivot, currentPoint);

          if (originalDist > 0.001) {
            let newTotalScaleX = 1;
            let newTotalScaleY = 1;

            if (transformHandlePreserveAspect) {
              // Uniform scale
              const uniformScale = currentDist / originalDist;
              newTotalScaleX = uniformScale;
              newTotalScaleY = uniformScale;
            } else {
              // Non-uniform scale: compute X and Y scale separately
              const originalVec = { x: originalCorner.x - pivot.x, y: originalCorner.y - pivot.y };
              const currentVec = { x: currentPoint.x - pivot.x, y: currentPoint.y - pivot.y };

              newTotalScaleX = Math.abs(originalVec.x) > 0.001 ? currentVec.x / originalVec.x : 1;
              newTotalScaleY = Math.abs(originalVec.y) > 0.001 ? currentVec.y / originalVec.y : 1;
            }

            // Calculate delta scale (how much to scale from previous frame)
            // If prev was 2x and now is 3x, we need to apply 1.5x delta
            const deltaScaleX = transformHandlePrevScaleX !== 0 ? newTotalScaleX / transformHandlePrevScaleX : 1;
            const deltaScaleY = transformHandlePrevScaleY !== 0 ? newTotalScaleY / transformHandlePrevScaleY : 1;

            // Update tracking
            transformHandleTotalScaleX = newTotalScaleX;
            transformHandleTotalScaleY = newTotalScaleY;
            transformHandlePrevScaleX = newTotalScaleX;
            transformHandlePrevScaleY = newTotalScaleY;

            // Apply delta scale
            store.scaleSelectionNonUniformLive(deltaScaleX, deltaScaleY, pivot);
          }
        }
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
          // Ctrl/Meta constrains to magnitude-only when angle mirroring is enabled
          const constrainToMagnitude = e.ctrlKey || e.metaKey;
          store.moveHandleLive(dragPathId!, dragSegmentIndex, dragHandleType, dx, dy, undefined, constrainToMagnitude);
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
      } else if (e.shiftKey && e.altKey && dragCenter && startDistance !== null && startDistance > 0.001) {
        // Shift+Alt: Scale around center
        isScaling = true;
        isRotating = false;

        const currentDistance = distance(point, dragCenter);
        const newTotalScale = currentDistance / startDistance;
        const deltaScale = newTotalScale / totalScale;
        totalScale = newTotalScale;

        // In animation mode, use transform-based scaling (TODO: not yet implemented)
        const { currentClipId: activeClipId } = store.getState();
        if (!activeClipId) {
          // Normal mode: geometry-based scaling
          if (isDraggingSelection) {
            store.scaleSelectionLive(deltaScale, dragCenter!);
          } else {
            store.scalePathLive(dragPathId!, deltaScale, dragCenter!);
          }
        }
      } else if (e.altKey && dragCenter && startAngle !== null) {
        // Alt only: Rotation around center
        isRotating = true;
        isScaling = false;

        const currentAngle = Math.atan2(
          point.y - dragCenter.y,
          point.x - dragCenter.x,
        );
        const deltaAngle = currentAngle - startAngle;
        totalAngle += deltaAngle;
        startAngle = currentAngle;

        // Always update store (throttles React renders internally)
        // In animation mode, use transform-based rotation
        const { currentClipId: activeClipId } = store.getState();
        if (activeClipId) {
          // Animation mode: use transform-based rotation
          if (isDraggingSelection) {
            store.rotateSelectionTransform(deltaAngle);
          } else {
            store.rotatePathTransform(dragPathId!, deltaAngle);
          }
        } else {
          // Normal mode: geometry-based rotation
          if (isDraggingSelection) {
            store.rotateSelectionLive(deltaAngle, dragCenter!);
          } else {
            store.rotatePathLive(dragPathId!, deltaAngle, dragCenter!);
          }
        }
      } else {
        // Switching from rotation/scale back to translation
        isRotating = false;
        isScaling = false;

        // For path translation (not point/handle), check drag threshold
        // This prevents accidental movement when clicking to select
        if (!isDraggingPoint && !isDraggingHandle && !dragThresholdMet && dragStartScreen) {
          const screenDx = e.clientX - dragStartScreen.x;
          const screenDy = e.clientY - dragStartScreen.y;
          const screenDist = Math.sqrt(screenDx * screenDx + screenDy * screenDy);
          const timeSinceStart = Date.now() - dragStartTime;

          if (screenDist >= MIN_DRAG_DISTANCE || timeSinceStart >= MIN_DRAG_TIME_MS) {
            dragThresholdMet = true;
          } else {
            // Threshold not met yet - don't translate, just update dragStart
            dragStart = point;
            return;
          }
        }

        // Translate
        const dx = point.x - dragStart.x;
        const dy = point.y - dragStart.y;

        // Check if we're in animation mode
        const { currentClipId: activeClipId } = store.getState();
        if (activeClipId) {
          // Animation mode: use transform-based translation
          totalDx += dx;
          totalDy += dy;
          if (isDraggingSelection) {
            store.translateSelectionTransform(dx, dy);
          } else {
            store.translatePathTransform(dragPathId!, dx, dy);
          }
        } else {
          // Normal mode: geometry-based translation
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
        // Save camera state after panning ends
        saveCameraState(state.camera, state.zoom);
        return;
      }

      // End blob tool
      if (isBlobbing) {
        const { paths, blobRadius, blobSimplify, fillColor, fillOpacity } = store.getState();

        if (blobPoints.length > 0) {
          if (blobMode === "create") {
            // Create new path from blob
            const resultPaths = createBlobPath(
              blobPoints,
              blobRadius,
              blobSimplify,
              fillColor,
              fillOpacity,
              () => store.getNextPathName()
            );
            for (const path of resultPaths) {
              store.finishPath(path);
            }
            // Select the new paths
            if (resultPaths.length > 0) {
              store.selectPaths(resultPaths.map((p) => p.id));
            }
          } else if (blobMode === "add") {
            // Add blob to selected paths
            const targetPaths = blobTargetPathIds
              .map((id) => paths.find((p) => p.id === id))
              .filter((p): p is Path => p !== undefined);

            if (targetPaths.length > 0) {
              const resultPaths = addBlobToPaths(
                targetPaths,
                blobPoints,
                blobRadius,
                blobSimplify,
                () => store.getNextPathName()
              );
              if (resultPaths.length > 0) {
                // Use booleanOp command for undo/redo
                store.executeBlobOp(targetPaths, resultPaths);
              }
            }
          } else if (blobMode === "subtract") {
            // Subtract blob from selected paths
            const targetPaths = blobTargetPathIds
              .map((id) => paths.find((p) => p.id === id))
              .filter((p): p is Path => p !== undefined);

            if (targetPaths.length > 0) {
              const resultPaths = subtractBlobFromPaths(
                targetPaths,
                blobPoints,
                blobRadius,
                blobSimplify,
                () => store.getNextPathName()
              );
              // Use booleanOp command for undo/redo (may result in fewer paths)
              store.executeBlobOp(targetPaths, resultPaths);
            }
          }
        }

        // Reset blob state
        isBlobbing = false;
        blobPoints = [];
        blobMode = "create";
        blobTargetPathIds = [];
        setBlobPreviewPointsRef.current([]);
        return;
      }

      // End transform point dragging
      if (isDraggingTransformPoint && dragTransformPointItemId && dragTransformPointItemType) {
        // Get the current (final) transform point position
        const { paths, groups } = store.getState();
        let newPoint: Point | null = null;
        if (dragTransformPointItemType === "path") {
          const path = paths.find((p) => p.id === dragTransformPointItemId);
          newPoint = path?.transformPoint ?? null;
        } else {
          const group = groups.find((g) => g.id === dragTransformPointItemId);
          newPoint = group?.transformPoint ?? null;
        }
        // Commit to undo stack
        if (newPoint && dragTransformPointOriginal) {
          store.commitTransformPoint(dragTransformPointItemId, dragTransformPointItemType, dragTransformPointOriginal, newPoint);
        }
        isDraggingTransformPoint = false;
        dragTransformPointItemId = null;
        dragTransformPointItemType = null;
        dragTransformPointOriginal = null;
        dragStart = null;
        return;
      }

      // End transform handle drag (scale/rotate)
      if (isDraggingTransformHandle && transformHandleCenter) {
        // Commit scale/rotate to undo stack
        if (transformHandleType === "rotation" && transformHandleTotalAngle !== 0) {
          store.commitRotateSelection(transformHandleTotalAngle, transformHandleCenter);
        } else if (transformHandleType === "corner" && (transformHandleTotalScaleX !== 1 || transformHandleTotalScaleY !== 1)) {
          store.commitScaleSelectionNonUniform(transformHandleTotalScaleX, transformHandleTotalScaleY, transformHandleCenter);
        }
        // Reset state
        isDraggingTransformHandle = false;
        transformHandleType = null;
        transformHandleCornerIndex = -1;
        transformHandleStartBounds = null;
        transformHandleCenter = null;
        transformHandleStartAngle = null;
        transformHandlePreserveAspect = false;
        transformHandleTotalAngle = 0;
        transformHandleTotalScaleX = 1;
        transformHandleTotalScaleY = 1;
        transformHandlePrevScaleX = 1;
        transformHandlePrevScaleY = 1;
        dragStart = null;
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
          const { paths, currentClipId: activeClipId } = store.getState();
          const isAnimationMode = activeClipId !== null;

          // Find all paths whose ALL anchors are within the box (fully selected)
          // and individual points that are within the box (for partial selection)
          // In animation mode, only select full paths (no individual point selection)
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
            } else if (!isAnimationMode) {
              // Only some anchors in box - select individual points
              // (disabled in animation mode - only full path selection allowed)
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

        const { currentClipId: activeClipId } = store.getState();

        if (isDraggingHandle && (totalDx !== 0 || totalDy !== 0)) {
          // Handle dragging is blocked in animation mode, but just in case...
          if (!activeClipId) {
            // Pass snap connection to commit (batched as single undo action)
            const snapConn = snappedToTarget ? {
              points: [
                { pathId: dragPathId, segmentIndex: dragSegmentIndex, handleType: dragHandleType },
                { pathId: snappedToTarget.pathId, segmentIndex: snappedToTarget.segmentIndex, handleType: snappedToTarget.handleType },
              ]
            } : undefined;

            // Calculate mirror movement for proper undo
            let mirrorMove: { segmentIndex: number; handleType: HandleType; dx: number; dy: number } | undefined;
            if (dragMirrorHandleOriginalPos && dragMirrorSegmentIndex >= 0) {
              const currentPath = store.getState().paths.find((p) => p.id === dragPathId);
              if (currentPath && dragMirrorSegmentIndex < currentPath.segments.length) {
                const mirrorSeg = currentPath.segments[dragMirrorSegmentIndex];
                const mirrorCurrentPos = dragMirrorHandleType === "c0" ? mirrorSeg.c0 : mirrorSeg.c1;
                const mirrorDx = mirrorCurrentPos.x - dragMirrorHandleOriginalPos.x;
                const mirrorDy = mirrorCurrentPos.y - dragMirrorHandleOriginalPos.y;
                if (mirrorDx !== 0 || mirrorDy !== 0) {
                  mirrorMove = {
                    segmentIndex: dragMirrorSegmentIndex,
                    handleType: dragMirrorHandleType,
                    dx: mirrorDx,
                    dy: mirrorDy,
                  };
                }
              }
            }

            store.commitMoveHandle(dragPathId, dragSegmentIndex, dragHandleType, totalDx, totalDy, snapConn, mirrorMove);
          }
        } else if (isDraggingPoint && (totalDx !== 0 || totalDy !== 0)) {
          // Point dragging is blocked in animation mode, but just in case...
          if (!activeClipId) {
            // Pass snap connection to commit (batched as single undo action)
            const snapConn = snappedToTarget ? {
              points: [
                { pathId: dragPathId, segmentIndex: dragPointIndex, handleType: "anchor" as HandleType },
                { pathId: snappedToTarget.pathId, segmentIndex: snappedToTarget.segmentIndex, handleType: snappedToTarget.handleType },
              ]
            } : undefined;
            store.commitMovePoint(dragPathId, dragPointIndex, totalDx, totalDy, snapConn);
          }
        } else if (isScaling && totalScale !== 1 && dragCenter) {
          // Geometry-based scaling commit (no animation mode support yet)
          if (!activeClipId) {
            if (isDraggingSelection) {
              store.commitScaleSelection(totalScale, dragCenter);
            } else {
              store.commitScale(dragPathId, totalScale, dragCenter);
            }
          }
        } else if (isRotating && totalAngle !== 0 && dragCenter) {
          if (activeClipId) {
            // Animation mode: commit transform-based rotation (with keyframes)
            if (isDraggingSelection && dragPrevAnimations) {
              store.commitRotateSelectionTransform(dragPrevAnimations);
            } else if (dragPrevAnimation) {
              store.commitRotateTransform(dragPathId, dragPrevAnimation);
            }
          } else {
            // Normal mode: geometry-based rotation
            if (isDraggingSelection) {
              store.commitRotateSelection(totalAngle, dragCenter);
            } else {
              store.commitRotate(dragPathId, totalAngle, dragCenter);
            }
          }
        } else if (totalDx !== 0 || totalDy !== 0) {
          if (activeClipId) {
            // Animation mode: commit transform-based translation (with keyframes)
            if (isDraggingSelection && dragPrevAnimations) {
              store.commitTranslateSelectionTransform(dragPrevAnimations);
            } else if (dragPrevAnimation) {
              store.commitTranslateTransform(dragPathId, dragPrevAnimation);
            }
          } else {
            // Normal mode: geometry-based translation
            if (isDraggingSelection) {
              store.commitTranslateSelection(totalDx, totalDy);
            } else {
              store.commitTranslate(dragPathId, totalDx, totalDy);
            }
          }
        }
      }

      // Handle click-to-cycle through overlapping paths
      // Only cycle if this was a simple click (no significant drag), the path was already selected
      // on mousedown, and there are multiple overlapping paths
      const wasSimpleClick = Math.abs(totalDx) < 0.5 && Math.abs(totalDy) < 0.5 && !isRotating && !isScaling;
      if (wasSimpleClick && pendingCycleWasAlreadySelected && pendingCyclePathsAtPoint.length > 1) {
        const currentSelection = store.getState().selection;
        const currentlySelectedId = currentSelection.pathIds.length === 1 ? currentSelection.pathIds[0] : null;

        if (currentlySelectedId && pendingCyclePathsAtPoint.includes(currentlySelectedId)) {
          // Get next path in cycle
          const nextPathId = getNextPathInCycle(pendingCyclePathsAtPoint, currentlySelectedId, currentSelection.pathIds);
          if (nextPathId && nextPathId !== currentlySelectedId) {
            store.selectPath(nextPathId);
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
      dragPrevAnimation = null;
      dragPrevAnimations = null;
      dragStart = null;
      dragPathId = null;
      dragCenter = null;
      startAngle = null;
      startDistance = null;
      totalDx = 0;
      totalDy = 0;
      totalAngle = 0;
      totalScale = 1;
      isRotating = false;
      isScaling = false;
      snappedToTarget = null;
      // Reset drag threshold state
      dragThresholdMet = false;
      dragStartTime = 0;
      dragStartScreen = null;
      // Reset cycle state
      pendingCyclePathsAtPoint = [];
      pendingCycleClickPoint = null;
      pendingCycleWasAlreadySelected = false;
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

      // Save camera state after zooming
      saveCameraState(state.camera, state.zoom);
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

      // Block line tool when animation clip is active (geometry editing disabled)
      const { currentClipId: activeClipId } = store.getState();
      if (activeClipId) {
        return;
      }

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

          const { fillColor: currentFillColor, fillOpacity: currentFillOpacity } = store.getState();
          const pathId = store.getState().currentPathId!;
          const path: Path = {
            id: pathId,
            name: store.getNextPathName(),
            parentId: null,
            segments,
            anchorMeta: segments.map(() => ({ ...defaultAnchorMeta(), color: currentFillColor })),
            closed: true,
            fill: currentFillColor,
            opacity: currentFillOpacity,
            visible: true,
            locked: false,
            playerMask: false,
            transform: defaultTransform(),
            transformPoint: null,
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
      // Block geometry editing in animation mode
      const { currentClipId: activeClipId } = store.getState();
      if (activeClipId) {
        return;
      }

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

        const { fillColor: currentFillColor, fillOpacity: currentFillOpacity } = store.getState();
        const path: Path = {
          id: currentPathId,
          name: store.getNextPathName(),
          parentId: null,
          segments,
          anchorMeta: segments.map(() => ({ ...defaultAnchorMeta(), color: currentFillColor })),
          closed: true,
          fill: currentFillColor,
          opacity: currentFillOpacity,
          visible: true,
          locked: false,
          playerMask: false,
          transform: defaultTransform(),
          transformPoint: null,
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
          // Priority: selected paths first (in reverse z-order), then unselected (in reverse z-order)
          let foundHoveredPoint: { pathId: string; segmentIndex: number; handleType: HandleType } | null = null;

          // Get visible paths in reverse order (higher index = on top = checked first)
          const visiblePathsReversed = paths.filter((p) => p.visible).reverse();

          // Check selected paths first for control points
          const selectedPathsForControls = visiblePathsReversed.filter((p) => selectedPathIds.has(p.id));
          for (const path of selectedPathsForControls) {
            const handle = findNearestHandle(point, path, controlThreshold);
            if (handle) {
              foundHoveredPoint = { pathId: path.id, segmentIndex: handle.segmentIndex, handleType: handle.handleType };
              break;
            }
          }

          // If showAllControlPoints, also check unselected paths (but selected paths have priority)
          if (!foundHoveredPoint && showAllControlPoints) {
            const unselectedPathsForControls = visiblePathsReversed.filter((p) => !selectedPathIds.has(p.id));
            for (const path of unselectedPathsForControls) {
              const handle = findNearestHandle(point, path, controlThreshold);
              if (handle) {
                foundHoveredPoint = { pathId: path.id, segmentIndex: handle.segmentIndex, handleType: handle.handleType };
                break;
              }
            }
          }

          // Check for hovered anchor points on visible paths
          // Priority: selected paths first (in reverse z-order), then unselected (in reverse z-order)
          if (!foundHoveredPoint) {
            // Check selected paths first for anchor points
            const selectedPathsForAnchors = visiblePathsReversed.filter((p) => selectedPathIds.has(p.id));
            for (const path of selectedPathsForAnchors) {
              const pathPoints = getPathPoints(path);
              const pointIdx = findNearestPointIndex(point, pathPoints, anchorThreshold);
              if (pointIdx >= 0) {
                foundHoveredPoint = { pathId: path.id, segmentIndex: pointIdx, handleType: "anchor" };
                break;
              }
            }

            // If showAllPoints, also check unselected paths (but selected paths have priority)
            if (!foundHoveredPoint && showAllPoints) {
              const unselectedPathsForAnchors = visiblePathsReversed.filter((p) => !selectedPathIds.has(p.id));
              for (const path of unselectedPathsForAnchors) {
                const pathPoints = getPathPoints(path);
                const pointIdx = findNearestPointIndex(point, pathPoints, anchorThreshold);
                if (pointIdx >= 0) {
                  foundHoveredPoint = { pathId: path.id, segmentIndex: pointIdx, handleType: "anchor" };
                  break;
                }
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
            // Get current animation state for transform-aware hit testing
            const { currentClipId, animationClips, playbackTime } = store.getState();

            // Skip edge hover when editing a clip (geometry editing is disabled)
            if (currentClipId) {
              store.setHoveredEdge(null);
            } else {
              // Check for edge hover (only on visible paths)
              // Priority: selected paths first, then unselected (both in reverse z-order)
              const edgeThreshold = VERTEX_SIZE * 2 * state.zoom;

              // Check selected paths first (reverse z-order for topmost priority)
              const selectedVisiblePaths = visiblePathsReversed.filter((p) => selectedPathIds.has(p.id));
              let edgeHit = findNearestEdge(point, selectedVisiblePaths, edgeThreshold);

              // If no hit on selected paths, check unselected paths
              if (!edgeHit) {
                const unselectedVisiblePaths = visiblePathsReversed.filter((p) => !selectedPathIds.has(p.id));
                edgeHit = findNearestEdge(point, unselectedVisiblePaths, edgeThreshold);
              }

              if (edgeHit) {
                store.setHoveredEdge({
                  pathId: edgeHit.pathId,
                  segmentIndex: edgeHit.segmentIndex,
                  t: edgeHit.t,
                  point: edgeHit.point,
                });
                store.setHoveredPathId(null);
                return; // Skip path hover check
              } else {
                store.setHoveredEdge(null);
              }
            }

            {
              // Check for path hover using cycling logic
              // Highlight the next path in cycle based on current selection
              const visiblePaths = paths.filter((p) => p.visible);
              const currentClip = currentClipId
                ? animationClips.find((c) => c.id === currentClipId) ?? null
                : null;

              // Find all paths at hover point
              const pathsAtPoint = findPathsAtPoint(
                point,
                visiblePaths,
                currentClip,
                playbackTime,
                store.getAncestorChain,
                getEffectiveTransform,
                applyInverseTransform
              );

              // Get current selection to determine cycling
              const currentSelection = store.getState().selection;
              const currentlySelectedId = currentSelection.pathIds.length === 1 ? currentSelection.pathIds[0] : null;

              // Get the next path in cycle (shows what would be selected on click)
              const hoveredPath = getNextPathInCycle(pathsAtPoint, currentlySelectedId, currentSelection.pathIds);
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
      // Delete to delete selection (or keyframe when editing a clip)
      if (isDelete(e)) {
        const { currentPath, selection, currentClipId, selectedKeyframes } = store.getState();

        // When editing a clip, delete all selected keyframes instead of paths
        if (currentClipId) {
          if (selectedKeyframes.length > 0) {
            e.preventDefault();
            for (const kf of selectedKeyframes) {
              store.deleteKeyframe(currentClipId, kf.pathId, kf.time);
            }
            store.clearKeyframeSelection();
          }
          return; // Don't delete paths when editing a clip
        }

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
        // Don't intercept if user has text selected (let browser handle it)
        const textSelection = window.getSelection();
        if (textSelection && textSelection.toString().length > 0) {
          return; // Let browser handle text copy
        }
        const { currentPath, selection } = store.getState();
        const hasSelection = selection.pathIds.length > 0 || selection.points.length > 0;
        if (!currentPath && hasSelection) {
          e.preventDefault();
          store.copyToClipboard();
        }
      }
      // Ctrl+X / Cmd+X for cut
      if (isCut(e)) {
        // Don't intercept if user has text selected
        const textSelection = window.getSelection();
        if (textSelection && textSelection.toString().length > 0) {
          return; // Let browser handle text cut
        }
        const { currentPath, selection } = store.getState();
        const hasSelection = selection.pathIds.length > 0 || selection.points.length > 0;
        if (!currentPath && hasSelection) {
          e.preventDefault();
          store.cutToClipboard();
        }
      }
      // Ctrl+V / Cmd+V for paste
      if (isPaste(e)) {
        const { currentPath } = store.getState();
        if (!currentPath) {
          e.preventDefault();
          store.pasteFromClipboard();
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
      // Ctrl+Shift+A for deselect all
      if (isDeselectAll(e)) {
        e.preventDefault();
        store.clearSelection();
      }
      // V for select tool
      if (isSelectTool(e)) {
        store.setTool("select");
      }
      // P for line tool
      if (isLineTool(e)) {
        store.setTool("line");
      }
      // B for blob tool
      if (isBlobTool(e)) {
        store.setTool("blob");
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
      // / for toggle transform points
      if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        store.toggleShowTransformPoints();
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
