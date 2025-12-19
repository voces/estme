import { useCallback, useSyncExternalStore } from "react";
import { AnchorMeta, CubicSegment, Group, lineSegment, Path, Point, PointReference, SnapConnection, Tool } from "../types.ts";
import { booleanOperation, canBooleanOp, uniteMultiplePaths } from "../pathBool.ts";
import { isSegmentStraight, makeStraightControlPoints, rotatePoint } from "../geometry.ts";
import { applyCommand } from "./commands.ts";
import {
  Command,
  EditorState,
  emptySelection,
  HandleType,
  HoveredEdge,
  HoveredPoint,
  PointSelection,
  Selection,
} from "./types.ts";

// Re-export types for convenience
export type { HandleType, HoveredEdge, HoveredPoint, PointSelection, Selection } from "./types.ts";

// Load persisted settings from localStorage
const loadShowAllPoints = (): boolean => {
  try {
    const saved = localStorage.getItem("estme:showAllPoints");
    return saved === "true";
  } catch {
    return false;
  }
};

const loadShowAllControlPoints = (): boolean => {
  try {
    const saved = localStorage.getItem("estme:showAllControlPoints");
    return saved === "true";
  } catch {
    return false;
  }
};

const initialState: EditorState = {
  tool: "line",
  paths: [],
  groups: [],
  currentPath: null,
  currentPathId: null,
  hoverPoint: null,
  hoveredEdge: null,
  hoveredPoint: null,
  hoveredPathId: null,
  selection: emptySelection,
  fillColor: "#ffffff",
  fillOpacity: 1,
  blobRadius: 0.3,
  blobSimplify: 0.002,
  showAllPoints: loadShowAllPoints(),
  showAllControlPoints: loadShowAllControlPoints(),
  undoStack: [],
  redoStack: [],
  mousePosition: null,
  zoom: 1,
  clipboard: null,
  pathCounter: 1,
  groupCounter: 1,
  snapConnections: [],
  pendingBooleanOp: null,
};

let state = initialState;
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((l) => l());
}

// Throttled notify for live updates during drag - updates state immediately but batches React renders
let lastNotifyTime = 0;
let pendingNotify = false;
const NOTIFY_THROTTLE_MS = 16; // ~60fps

function throttledNotify() {
  const now = performance.now();
  if (now - lastNotifyTime >= NOTIFY_THROTTLE_MS) {
    lastNotifyTime = now;
    pendingNotify = false;
    notify();
  } else if (!pendingNotify) {
    pendingNotify = true;
    requestAnimationFrame(() => {
      if (pendingNotify) {
        lastNotifyTime = performance.now();
        pendingNotify = false;
        notify();
      }
    });
  }
}

// Flush any pending throttled notify immediately
function flushThrottledNotify() {
  if (pendingNotify) {
    pendingNotify = false;
    notify();
  }
}

function executeCommand(cmd: Command) {
  state = applyCommand(state, cmd, false);
  state = {
    ...state,
    undoStack: [...state.undoStack, cmd],
    redoStack: [],
  };
  notify();
}

export const store = {
  getState: () => state,
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  // Flush any pending throttled notification (call when drag ends)
  flushUpdates: () => {
    flushThrottledNotify();
  },

  // Non-undoable actions (UI state)
  setTool: (tool: Tool) => {
    // Cancel any in-progress path when switching away from line tool
    if (state.tool === "line" && tool !== "line" && state.currentPath) {
      state = { ...state, tool, currentPath: null, currentPathId: null, hoverPoint: null };
    } else {
      state = { ...state, tool };
    }
    notify();
  },
  setFillColor: (fillColor: string) => {
    state = { ...state, fillColor };
    notify();
  },
  setBlobRadius: (blobRadius: number) => {
    state = { ...state, blobRadius };
    notify();
  },
  setBlobSimplify: (blobSimplify: number) => {
    state = { ...state, blobSimplify };
    notify();
  },
  toggleShowAllPoints: () => {
    const newValue = !state.showAllPoints;
    state = { ...state, showAllPoints: newValue };
    try {
      localStorage.setItem("estme:showAllPoints", String(newValue));
    } catch {
      // Ignore localStorage errors
    }
    notify();
  },
  toggleShowAllControlPoints: () => {
    const newValue = !state.showAllControlPoints;
    state = { ...state, showAllControlPoints: newValue };
    try {
      localStorage.setItem("estme:showAllControlPoints", String(newValue));
    } catch {
      // Ignore localStorage errors
    }
    notify();
  },
  setHoverPoint: (point: Point | null) => {
    state = { ...state, hoverPoint: point };
    notify();
  },
  setHoveredEdge: (edge: HoveredEdge) => {
    state = { ...state, hoveredEdge: edge };
    notify();
  },
  setHoveredPoint: (point: HoveredPoint) => {
    state = { ...state, hoveredPoint: point };
    notify();
  },
  setHoveredPathId: (pathId: string | null) => {
    state = { ...state, hoveredPathId: pathId };
    notify();
  },
  setMousePosition: (point: Point | null) => {
    state = { ...state, mousePosition: point };
    notify();
  },
  setZoom: (zoom: number) => {
    state = { ...state, zoom };
    notify();
  },
  startPath: (point: Point) => {
    const id = crypto.randomUUID();
    state = { ...state, currentPath: [point], currentPathId: id, selection: { pathIds: [id], points: [] } };
    notify();
  },
  addPoint: (point: Point) => {
    if (state.currentPath) {
      state = { ...state, currentPath: [...state.currentPath, point] };
      notify();
    }
  },
  cancelPath: () => {
    state = { ...state, currentPath: null, currentPathId: null, hoverPoint: null, pendingBooleanOp: null };
    notify();
  },
  removeLastPoint: () => {
    if (state.currentPath && state.currentPath.length > 1) {
      state = { ...state, currentPath: state.currentPath.slice(0, -1) };
      notify();
    }
  },

  // Selection management (non-undoable UI state)
  clearSelection: () => {
    state = { ...state, selection: emptySelection };
    notify();
  },
  setSelection: (selection: Selection) => {
    state = { ...state, selection };
    notify();
  },
  // Add to selection (for shift+click)
  addToSelection: (pathId?: string, point?: PointSelection) => {
    const newPathIds = pathId && !state.selection.pathIds.includes(pathId)
      ? [...state.selection.pathIds, pathId]
      : state.selection.pathIds;
    const newPoints = point && !state.selection.points.some(
      (p) => p.pathId === point.pathId && p.segmentIndex === point.segmentIndex && p.handleType === point.handleType
    )
      ? [...state.selection.points, point]
      : state.selection.points;
    state = { ...state, selection: { pathIds: newPathIds, points: newPoints } };
    notify();
  },
  // Toggle item in selection
  toggleInSelection: (pathId?: string, point?: PointSelection) => {
    let newPathIds = state.selection.pathIds;
    let newPoints = state.selection.points;
    if (pathId) {
      if (newPathIds.includes(pathId)) {
        newPathIds = newPathIds.filter((id) => id !== pathId);
      } else {
        newPathIds = [...newPathIds, pathId];
      }
    }
    if (point) {
      const idx = newPoints.findIndex(
        (p) => p.pathId === point.pathId && p.segmentIndex === point.segmentIndex && p.handleType === point.handleType
      );
      if (idx >= 0) {
        newPoints = newPoints.filter((_, i) => i !== idx);
      } else {
        newPoints = [...newPoints, point];
      }
    }
    state = { ...state, selection: { pathIds: newPathIds, points: newPoints } };
    notify();
  },

  // Undoable commands
  finishPath: (path: Path) => {
    state = { ...state, currentPath: null, currentPathId: null };

    // Check if there's a pending boolean operation
    const pending = state.pendingBooleanOp;
    if (pending) {
      // Clear the pending operation
      state = { ...state, pendingBooleanOp: null };

      // Get the target paths (they should still exist)
      const targetPaths = pending.targetPathIds
        .map((id) => state.paths.find((p) => p.id === id))
        .filter((p): p is Path => p !== undefined);

      if (targetPaths.length === 0) {
        // No target paths, just add the new path normally
        executeCommand({ type: "addPath", path });
        return;
      }

      // Apply the boolean operation
      if (pending.operation === "unite") {
        // Unite the new path with all target paths
        // First add the new path to get a complete list
        const allPaths = [...targetPaths, path];
        if (allPaths.length >= 2) {
          const resultPaths = uniteMultiplePaths(allPaths, () => store.getNextPathName());
          if (resultPaths.length > 0) {
            executeCommand({ type: "booleanOp", originalPaths: allPaths, resultPaths, operation: "unite" });
            return;
          }
        }
        // Fallback: just add the new path
        executeCommand({ type: "addPath", path });
      } else {
        // For intersect, subtract, exclude: apply operation independently to each target path
        const commands: Command[] = [];
        let anySuccess = false;
        // Collect all result paths from intersect/exclude operations for snap connections
        const allSnapResultPaths: Path[] = [];

        for (const targetPath of targetPaths) {
          // Check if these paths intersect
          if (canBooleanOp([targetPath, path], pending.operation)) {
            const resultPaths = booleanOperation(targetPath, path, pending.operation, () => store.getNextPathName());
            if (resultPaths.length > 0) {
              commands.push({ type: "booleanOp", originalPaths: [targetPath], resultPaths, operation: pending.operation });
              anySuccess = true;
              // Collect intersect/exclude results for snap connections
              if (pending.operation === "exclude" || pending.operation === "intersect") {
                allSnapResultPaths.push(...resultPaths);
              }
            } else {
              // No result means the path should be removed (e.g., no intersection area)
              commands.push({ type: "deletePath", path: targetPath });
            }
          }
          // If no intersection, keep the target path as-is (don't include in command)
        }

        if (anySuccess) {
          // For intersect/exclude operations, add snap connections for coincident points
          if ((pending.operation === "exclude" || pending.operation === "intersect") && allSnapResultPaths.length >= 2) {
            const snapCommands = store._createCoincidentSnapCommands(allSnapResultPaths);
            commands.push(...snapCommands);
          }

          // Execute all boolean operations as a batch
          if (commands.length === 1) {
            executeCommand(commands[0]);
          } else if (commands.length > 1) {
            executeCommand({ type: "batch", commands });
          }
        } else {
          // No intersections found, just add the new path
          executeCommand({ type: "addPath", path });
        }
      }
    } else {
      // No pending operation, add path normally
      executeCommand({ type: "addPath", path });
    }
  },
  deletePath: (id: string) => {
    const path = state.paths.find((p) => p.id === id);
    if (!path) return;
    // Clean up any snap connections for this path before deleting
    store.cleanupConnectionsForPath(id);
    executeCommand({ type: "deletePath", path });
  },
  deleteSelection: () => {
    // Delete all fully selected paths
    for (const pathId of state.selection.pathIds) {
      const path = state.paths.find((p) => p.id === pathId);
      if (path) {
        // Clean up snap connections first
        store.cleanupConnectionsForPath(pathId);
        executeCommand({ type: "deletePath", path });
      }
    }
    // Delete all selected points
    for (const point of state.selection.points) {
      const path = state.paths.find((p) => p.id === point.pathId);
      if (!path) continue;

      const { segmentIndex, handleType, pathId } = point;

      if (handleType === "anchor") {
        // Delete anchor - need at least 4 segments to delete one (keeping 3)
        if (path.segments.length <= 3) continue;
        // Update snap connection indices for anchors on this path
        store.updateConnectionIndices(pathId, segmentIndex);
        executeCommand({
          type: "deleteAnchor",
          id: pathId,
          anchorIndex: segmentIndex,
          prevPath: path,
        });
      } else if (handleType === "c0") {
        // Delete c0 control point - collapse to anchor (same as toggle off)
        const anchorMeta = path.anchorMeta?.[segmentIndex];
        if (!anchorMeta || !anchorMeta.rightActive) continue; // Already inactive
        store.toggleRightControl(pathId, segmentIndex);
      } else if (handleType === "c1") {
        // Delete c1 control point - collapse to anchor of next segment
        // For open paths, the last segment's c1 belongs to the final anchor (index = segments.length)
        const nextIdx = path.closed
          ? (segmentIndex + 1) % path.segments.length
          : segmentIndex + 1;
        const anchorMeta = path.anchorMeta?.[nextIdx];
        if (!anchorMeta || !anchorMeta.leftActive) continue; // Already inactive
        store.toggleLeftControl(pathId, nextIdx);
      }
    }
  },
  insertAnchor: (pathId: string, segmentIndex: number, t: number) => {
    const path = state.paths.find((p) => p.id === pathId);
    if (!path) return;
    executeCommand({
      type: "insertAnchor",
      id: pathId,
      segmentIndex,
      t,
      prevPath: path,
    });
  },
  selectPath: (id: string | null) => {
    // For single path selection (replace current selection)
    if (id === null) {
      state = { ...state, selection: emptySelection };
    } else {
      state = { ...state, selection: { pathIds: [id], points: [] } };
    }
    notify();
  },
  selectPaths: (ids: string[]) => {
    // Select multiple paths (replace current selection)
    state = { ...state, selection: { pathIds: ids, points: [] } };
    notify();
  },
  selectAll: () => {
    // Select all visible paths
    const visiblePathIds = state.paths.filter((p) => p.visible).map((p) => p.id);
    state = { ...state, selection: { pathIds: visiblePathIds, points: [] } };
    notify();
  },
  selectPoint: (point: PointSelection | null) => {
    // For single point selection (replace current selection)
    if (point === null) {
      state = { ...state, selection: emptySelection };
    } else {
      state = { ...state, selection: { pathIds: [], points: [point] } };
    }
    notify();
  },
  // Live transform (no undo entry - used during drag)
  translatePathLive: (id: string, dx: number, dy: number, movedPathIds?: Set<string>) => {
    // Track which paths we've moved to avoid infinite loops
    const moved = movedPathIds || new Set<string>();
    if (moved.has(id)) return;
    moved.add(id);

    const path = state.paths.find((p) => p.id === id);
    if (!path) return;

    // Move the path
    state = {
      ...state,
      paths: state.paths.map((p) => {
        if (p.id !== id) return p;
        return {
          ...p,
          segments: p.segments.map((seg) => ({
            p0: { x: seg.p0.x + dx, y: seg.p0.y + dy },
            c0: { x: seg.c0.x + dx, y: seg.c0.y + dy },
            c1: { x: seg.c1.x + dx, y: seg.c1.y + dy },
            p1: { x: seg.p1.x + dx, y: seg.p1.y + dy },
          })),
        };
      }),
    };

    // Move connected points on OTHER paths (not on this path since all its points moved together)
    for (let i = 0; i < path.segments.length; i++) {
      const connectedPoints = store.getConnectedPoints({ pathId: id, segmentIndex: i, handleType: "anchor" });
      for (const connPoint of connectedPoints) {
        if (connPoint.pathId !== id && !moved.has(connPoint.pathId)) {
          // Move this connected point
          store._movePointInternal(connPoint.pathId, connPoint.segmentIndex, dx, dy);
        }
      }
    }

    if (!movedPathIds) {
      // Only notify once at the top level - use throttled notify for smooth 60fps
      throttledNotify();
    }
  },
  // Translate entire selection (all selected paths and points)
  translateSelectionLive: (dx: number, dy: number) => {
    const { selection } = state;

    // Track all points that are being moved (to find connected points on other paths)
    const movedPoints: { pathId: string; segmentIndex: number; handleType: HandleType }[] = [];

    state = {
      ...state,
      paths: state.paths.map((p) => {
        // If path is fully selected, translate all points uniformly (preserves straight lines)
        if (selection.pathIds.includes(p.id)) {
          // Track all anchors as moved
          for (let i = 0; i < p.segments.length; i++) {
            movedPoints.push({ pathId: p.id, segmentIndex: i, handleType: "anchor" });
          }
          return {
            ...p,
            segments: p.segments.map((seg) => ({
              p0: { x: seg.p0.x + dx, y: seg.p0.y + dy },
              c0: { x: seg.c0.x + dx, y: seg.c0.y + dy },
              c1: { x: seg.c1.x + dx, y: seg.c1.y + dy },
              p1: { x: seg.p1.x + dx, y: seg.p1.y + dy },
            })),
          };
        }

        // Check if any individual points from this path are selected
        const selectedPoints = selection.points.filter((pt) => pt.pathId === p.id);
        if (selectedPoints.length === 0) return p;

        // Track moved points
        for (const pt of selectedPoints) {
          movedPoints.push({ pathId: p.id, segmentIndex: pt.segmentIndex, handleType: pt.handleType });
        }

        // Build set of which anchors are being moved
        const movedAnchors = new Set<number>();
        for (const pt of selectedPoints) {
          if (pt.handleType === "anchor") {
            movedAnchors.add(pt.segmentIndex);
          }
        }

        // Move only the selected points, preserving straight segments
        const newSegments = p.segments.map((seg, i) => ({ ...seg }));

        for (const pt of selectedPoints) {
          const segIdx = pt.segmentIndex;
          // For open paths, final anchor is at segIdx === segments.length
          const isFinalAnchorOfOpenPath = !p.closed && segIdx === newSegments.length;
          const seg = isFinalAnchorOfOpenPath ? null : newSegments[segIdx];
          const prevIdx = segIdx === 0
            ? (p.closed ? newSegments.length - 1 : -1)
            : segIdx - 1;
          const prevSeg = prevIdx >= 0 ? newSegments[prevIdx] : null;

          if (pt.handleType === "anchor") {
            // Check if adjacent segments are straight before moving
            const currentIsStraight = seg ? isSegmentStraight(p.segments[segIdx]) : false;
            const prevIsStraight = prevSeg && prevIdx >= 0 ? isSegmentStraight(p.segments[prevIdx]) : false;

            // Get current anchor position
            const anchorPos = isFinalAnchorOfOpenPath
              ? newSegments[newSegments.length - 1].p1
              : seg!.p0;
            const newP0 = { x: anchorPos.x + dx, y: anchorPos.y + dy };

            if (isFinalAnchorOfOpenPath) {
              // Update p1 of the last segment
              newSegments[newSegments.length - 1] = { ...newSegments[newSegments.length - 1], p1: newP0 };
              // Handle previous segment's control points (c1)
              if (prevIsStraight && prevSeg) {
                const straight = makeStraightControlPoints(prevSeg.p0, newP0);
                newSegments[prevIdx] = { ...newSegments[prevIdx], c0: straight.c0, c1: straight.c1 };
              } else if (prevSeg) {
                newSegments[prevIdx] = { ...newSegments[prevIdx], c1: { x: prevSeg.c1.x + dx, y: prevSeg.c1.y + dy } };
              }
            } else {
              // Move anchor (p0)
              newSegments[segIdx] = { ...seg!, p0: newP0 };

              // Also update p1 of previous segment (if exists)
              if (prevSeg && prevIdx >= 0) {
                newSegments[prevIdx] = { ...newSegments[prevIdx], p1: newP0 };
              }

              // Handle current segment's control points
              if (currentIsStraight) {
                // Recalculate control points to keep it straight
                const straight = makeStraightControlPoints(newP0, seg!.p1);
                newSegments[segIdx] = { ...newSegments[segIdx], c0: straight.c0, c1: straight.c1 };
              } else {
                // Move c0 with anchor
                newSegments[segIdx] = { ...newSegments[segIdx], c0: { x: seg!.c0.x + dx, y: seg!.c0.y + dy } };
              }

              // Handle previous segment's control points (if exists)
              if (prevSeg && prevIdx >= 0) {
                if (prevIsStraight) {
                  // Recalculate control points to keep it straight
                  const straight = makeStraightControlPoints(prevSeg.p0, newP0);
                  newSegments[prevIdx] = { ...newSegments[prevIdx], c0: straight.c0, c1: straight.c1 };
                } else {
                  // Move c1 with anchor
                  newSegments[prevIdx] = { ...newSegments[prevIdx], c1: { x: prevSeg.c1.x + dx, y: prevSeg.c1.y + dy } };
                }
              }
            }
          } else if (pt.handleType === "c0") {
            if (seg) {
              newSegments[segIdx] = { ...newSegments[segIdx], c0: { x: seg.c0.x + dx, y: seg.c0.y + dy } };
            }
          } else if (pt.handleType === "c1") {
            if (seg) {
              newSegments[segIdx] = { ...newSegments[segIdx], c1: { x: seg.c1.x + dx, y: seg.c1.y + dy } };
            }
          }
        }
        return { ...p, segments: newSegments };
      }),
    };

    // Now move connected points that weren't already moved
    const movedSet = new Set(movedPoints.map(p => `${p.pathId}:${p.segmentIndex}:${p.handleType}`));
    for (const pt of movedPoints) {
      if (pt.handleType !== "anchor") continue; // Only check anchor connections
      const connectedPoints = store.getConnectedPoints(pt);
      for (const connPoint of connectedPoints) {
        const key = `${connPoint.pathId}:${connPoint.segmentIndex}:${connPoint.handleType}`;
        if (!movedSet.has(key)) {
          movedSet.add(key); // Mark as moved to avoid duplicates
          store._movePointInternal(connPoint.pathId, connPoint.segmentIndex, dx, dy);
        }
      }
    }

    throttledNotify();
  },
  rotatePathLive: (id: string, angle: number, center: Point, rotatedPathIds?: Set<string>) => {
    // Track which paths we've rotated to avoid infinite loops
    const rotated = rotatedPathIds || new Set<string>();
    if (rotated.has(id)) return;
    rotated.add(id);

    const path = state.paths.find((p) => p.id === id);
    if (!path) return;

    // First, collect the old positions of all anchors (for computing connected point deltas)
    const oldPositions: Point[] = path.segments.map((seg) => ({ ...seg.p0 }));

    // Rotate the path
    state = {
      ...state,
      paths: state.paths.map((p) => {
        if (p.id !== id) return p;
        return {
          ...p,
          segments: p.segments.map((seg) => ({
            p0: rotatePoint(seg.p0, center, angle),
            c0: rotatePoint(seg.c0, center, angle),
            c1: rotatePoint(seg.c1, center, angle),
            p1: rotatePoint(seg.p1, center, angle),
          })),
        };
      }),
    };

    // Move connected points on OTHER paths
    for (let i = 0; i < path.segments.length; i++) {
      const connectedPoints = store.getConnectedPoints({ pathId: id, segmentIndex: i, handleType: "anchor" });
      for (const connPoint of connectedPoints) {
        if (connPoint.pathId !== id && !rotated.has(connPoint.pathId)) {
          // Get the old position of the connected point
          const connPath = state.paths.find((p) => p.id === connPoint.pathId);
          if (!connPath) continue;
          const connOldPos = connPath.segments[connPoint.segmentIndex]?.p0;
          if (!connOldPos) continue;

          // Rotate around the same center and calculate delta
          const newPos = rotatePoint(connOldPos, center, angle);
          const dx = newPos.x - connOldPos.x;
          const dy = newPos.y - connOldPos.y;

          store._movePointInternal(connPoint.pathId, connPoint.segmentIndex, dx, dy);
        }
      }
    }

    if (!rotatedPathIds) {
      throttledNotify();
    }
  },
  // Rotate entire selection around a center point
  rotateSelectionLive: (angle: number, center: Point) => {
    const { selection } = state;

    // Track all points being rotated
    const rotatedPoints: { pathId: string; segmentIndex: number }[] = [];

    state = {
      ...state,
      paths: state.paths.map((p) => {
        // If path is fully selected, rotate all points
        if (selection.pathIds.includes(p.id)) {
          // Track all anchors as rotated
          for (let i = 0; i < p.segments.length; i++) {
            rotatedPoints.push({ pathId: p.id, segmentIndex: i });
          }
          return {
            ...p,
            segments: p.segments.map((seg) => ({
              p0: rotatePoint(seg.p0, center, angle),
              c0: rotatePoint(seg.c0, center, angle),
              c1: rotatePoint(seg.c1, center, angle),
              p1: rotatePoint(seg.p1, center, angle),
            })),
          };
        }
        return p;
      }),
    };

    // Move connected points that weren't already rotated
    const rotatedSet = new Set(rotatedPoints.map((p) => `${p.pathId}:${p.segmentIndex}`));
    for (const pt of rotatedPoints) {
      const connectedPoints = store.getConnectedPoints({ pathId: pt.pathId, segmentIndex: pt.segmentIndex, handleType: "anchor" });
      for (const connPoint of connectedPoints) {
        const key = `${connPoint.pathId}:${connPoint.segmentIndex}`;
        if (!rotatedSet.has(key)) {
          rotatedSet.add(key);
          // Get the current position of the connected point and rotate it
          const connPath = state.paths.find((p) => p.id === connPoint.pathId);
          if (!connPath) continue;
          const connOldPos = connPath.segments[connPoint.segmentIndex]?.p0;
          if (!connOldPos) continue;

          const newPos = rotatePoint(connOldPos, center, angle);
          const dx = newPos.x - connOldPos.x;
          const dy = newPos.y - connOldPos.y;

          store._movePointInternal(connPoint.pathId, connPoint.segmentIndex, dx, dy);
        }
      }
    }

    throttledNotify();
  },
  // Commit accumulated transform to undo stack (records for undo, doesn't re-apply)
  commitTranslate: (id: string, dx: number, dy: number) => {
    const cmd: Command = { type: "translatePath", id, dx, dy };
    state = {
      ...state,
      undoStack: [...state.undoStack, cmd],
      redoStack: [],
    };
    notify();
  },
  commitRotate: (id: string, angle: number, center: Point) => {
    const cmd: Command = { type: "rotatePath", id, angle, center };
    state = {
      ...state,
      undoStack: [...state.undoStack, cmd],
      redoStack: [],
    };
    notify();
  },
  // Commit translation for entire selection as a batch
  commitTranslateSelection: (dx: number, dy: number) => {
    const { selection } = state;
    const commands: Command[] = [];
    for (const pathId of selection.pathIds) {
      commands.push({ type: "translatePath", id: pathId, dx, dy });
    }
    // For individual points, we'd need movePoint commands
    for (const pt of selection.points) {
      if (pt.handleType === "anchor") {
        commands.push({ type: "movePoint", id: pt.pathId, pointIndex: pt.segmentIndex, dx, dy });
      } else {
        commands.push({ type: "moveHandle", id: pt.pathId, segmentIndex: pt.segmentIndex, handleType: pt.handleType, dx, dy });
      }
    }
    if (commands.length === 0) return;
    const cmd: Command = commands.length === 1 ? commands[0] : { type: "batch", commands };
    state = {
      ...state,
      undoStack: [...state.undoStack, cmd],
      redoStack: [],
    };
    notify();
  },
  // Commit rotation for entire selection as a batch
  commitRotateSelection: (angle: number, center: Point) => {
    const { selection } = state;
    const commands: Command[] = [];
    for (const pathId of selection.pathIds) {
      commands.push({ type: "rotatePath", id: pathId, angle, center });
    }
    // Note: rotating individual points is just translation in a circle, complex to implement
    // For now, only full paths support rotation
    if (commands.length === 0) return;
    const cmd: Command = commands.length === 1 ? commands[0] : { type: "batch", commands };
    state = {
      ...state,
      undoStack: [...state.undoStack, cmd],
      redoStack: [],
    };
    notify();
  },
  // Internal helper: move a single anchor point without notify (for batch operations)
  _movePointInternal: (id: string, pointIndex: number, dx: number, dy: number) => {
    state = {
      ...state,
      paths: state.paths.map((p) => {
        if (p.id !== id) return p;

        // For open paths, the final anchor (pointIndex === segments.length) only has an incoming segment
        const isFinalAnchorOfOpenPath = !p.closed && pointIndex === p.segments.length;

        // Previous segment index (the segment that ends at this anchor)
        const prevIdx = pointIndex === 0
          ? (p.closed ? p.segments.length - 1 : -1)  // Open path first anchor has no prev
          : pointIndex - 1;

        // Check if adjacent segments are straight before moving
        const currentSeg = isFinalAnchorOfOpenPath ? null : p.segments[pointIndex];
        const prevSeg = prevIdx >= 0 ? p.segments[prevIdx] : null;
        const currentIsStraight = currentSeg ? isSegmentStraight(currentSeg) : false;
        const prevIsStraight = prevSeg ? isSegmentStraight(prevSeg) : false;

        return {
          ...p,
          segments: p.segments.map((seg, i) => {
            // Move this segment's p0 (if this anchor has an outgoing segment)
            if (!isFinalAnchorOfOpenPath && i === pointIndex) {
              const newP0 = { x: seg.p0.x + dx, y: seg.p0.y + dy };

              if (currentIsStraight) {
                // Keep segment straight by recalculating control points
                const straight = makeStraightControlPoints(newP0, seg.p1);
                return { ...seg, p0: newP0, c0: straight.c0, c1: straight.c1 };
              } else {
                // Just move p0 and c0 together
                return {
                  ...seg,
                  p0: newP0,
                  c0: { x: seg.c0.x + dx, y: seg.c0.y + dy },
                };
              }
            }
            // Also update c1 and p1 of the segment that ends at this point (if any)
            if (prevIdx >= 0 && i === prevIdx) {
              const newP1 = { x: seg.p1.x + dx, y: seg.p1.y + dy };

              if (prevIsStraight) {
                // Keep segment straight by recalculating control points
                const straight = makeStraightControlPoints(seg.p0, newP1);
                return { ...seg, p1: newP1, c0: straight.c0, c1: straight.c1 };
              } else {
                // Just move c1 and p1 together
                return {
                  ...seg,
                  c1: { x: seg.c1.x + dx, y: seg.c1.y + dy },
                  p1: newP1,
                };
              }
            }
            return seg;
          }),
        };
      }),
    };
  },

  // Live point move (no undo entry - used during drag)
  // Also moves connected points
  movePointLive: (id: string, pointIndex: number, dx: number, dy: number, movedPoints?: Set<string>) => {
    // Track which points we've moved to avoid infinite loops
    const moved = movedPoints || new Set<string>();
    const pointKey = `${id}:${pointIndex}:anchor`;
    if (moved.has(pointKey)) return;
    moved.add(pointKey);

    // Move this point
    store._movePointInternal(id, pointIndex, dx, dy);

    // Move connected points
    const connectedPoints = store.getConnectedPoints({ pathId: id, segmentIndex: pointIndex, handleType: "anchor" });
    for (const connPoint of connectedPoints) {
      if (connPoint.handleType === "anchor") {
        store.movePointLive(connPoint.pathId, connPoint.segmentIndex, dx, dy, moved);
      }
      // Note: If connected to a control point, we might want to handle that differently
    }

    if (!movedPoints) {
      // Only notify once at the top level - use throttled notify for smooth dragging
      throttledNotify();
    }
  },
  commitMovePoint: (id: string, pointIndex: number, dx: number, dy: number, snapConnection?: { points: PointReference[] }) => {
    const moveCmd: Command = { type: "movePoint", id, pointIndex, dx, dy };

    // If snapping, batch the move with the snap connection creation
    if (snapConnection) {
      const connId = crypto.randomUUID();
      const snapCmd: Command = { type: "addSnapConnection", connection: { id: connId, points: snapConnection.points } };
      // Apply the snap connection to state (the move is already applied via live updates)
      state = {
        ...state,
        snapConnections: [...state.snapConnections, { id: connId, points: snapConnection.points }],
        undoStack: [...state.undoStack, { type: "batch", commands: [moveCmd, snapCmd] }],
        redoStack: [],
      };
    } else {
      state = {
        ...state,
        undoStack: [...state.undoStack, moveCmd],
        redoStack: [],
      };
    }
    notify();
  },
  // Internal helper: move a single control handle without notify (for batch operations)
  _moveHandleInternal: (id: string, segmentIndex: number, handleType: HandleType, dx: number, dy: number) => {
    state = {
      ...state,
      paths: state.paths.map((p) => {
        if (p.id !== id) return p;

        // Get anchor info for mirroring
        let anchorIndex: number;
        let mirroredSegmentIndex: number;
        let mirroredHandleType: HandleType;

        if (handleType === "c0") {
          // c0 belongs to this segment's anchor (p0)
          // The mirrored handle is c1 of the previous segment
          anchorIndex = segmentIndex;
          // For open paths at segment 0, there is no previous segment to mirror to
          mirroredSegmentIndex = segmentIndex === 0
            ? (p.closed ? p.segments.length - 1 : -1)
            : segmentIndex - 1;
          mirroredHandleType = "c1";
        } else {
          // c1 belongs to the next segment's anchor (p1 of this segment = p0 of next)
          // The mirrored handle is c0 of the next segment
          // For open paths, the last segment's c1 belongs to the final anchor (index = segments.length)
          const nextIdx = p.closed
            ? (segmentIndex + 1) % p.segments.length
            : segmentIndex + 1;
          anchorIndex = nextIdx;
          // For open paths, the final anchor has no c0 to mirror (no outgoing segment)
          mirroredSegmentIndex = (p.closed || segmentIndex < p.segments.length - 1) ? nextIdx : -1;
          mirroredHandleType = "c0";
        }

        const anchorMeta = p.anchorMeta?.[anchorIndex];
        const mirrorAngle = anchorMeta?.mirrorAngle || false;
        const mirrorDistance = anchorMeta?.mirrorDistance || false;

        // Check if the mirrored handle is active
        let mirroredActive = true;
        if (mirroredHandleType === "c0") {
          mirroredActive = p.anchorMeta?.[anchorIndex]?.rightActive !== false;
        } else {
          mirroredActive = p.anchorMeta?.[anchorIndex]?.leftActive !== false;
        }

        // Get anchor position (for open paths, final anchor is at segments[length-1].p1)
        const anchor = anchorIndex < p.segments.length
          ? p.segments[anchorIndex].p0
          : p.segments[p.segments.length - 1].p1;

        return {
          ...p,
          segments: p.segments.map((seg, i) => {
            if (i === segmentIndex) {
              if (handleType === "c0") {
                return { ...seg, c0: { x: seg.c0.x + dx, y: seg.c0.y + dy } };
              } else if (handleType === "c1") {
                return { ...seg, c1: { x: seg.c1.x + dx, y: seg.c1.y + dy } };
              }
            }

            // Apply mirroring to the opposite handle if active and any mirroring is enabled
            if ((mirrorAngle || mirrorDistance) && mirroredActive && i === mirroredSegmentIndex && segmentIndex !== mirroredSegmentIndex) {
              const movedSeg = p.segments[segmentIndex];
              const movedHandle = handleType === "c0"
                ? { x: movedSeg.c0.x + dx, y: movedSeg.c0.y + dy }
                : { x: movedSeg.c1.x + dx, y: movedSeg.c1.y + dy };

              // Calculate vector from anchor to moved handle
              const vecX = movedHandle.x - anchor.x;
              const vecY = movedHandle.y - anchor.y;
              const dist = Math.sqrt(vecX * vecX + vecY * vecY);

              if (dist > 0.001) {
                // Get current mirrored handle info
                const currentMirroredHandle = mirroredHandleType === "c0" ? seg.c0 : seg.c1;
                const currentMirroredVecX = currentMirroredHandle.x - anchor.x;
                const currentMirroredVecY = currentMirroredHandle.y - anchor.y;
                const currentMirroredDist = Math.sqrt(currentMirroredVecX ** 2 + currentMirroredVecY ** 2);

                let newX: number, newY: number;

                if (mirrorAngle && mirrorDistance) {
                  // Both: opposite direction, same distance
                  newX = anchor.x - (vecX / dist) * dist;
                  newY = anchor.y - (vecY / dist) * dist;
                } else if (mirrorAngle) {
                  // Angle only: opposite direction, keep current distance
                  newX = anchor.x - (vecX / dist) * currentMirroredDist;
                  newY = anchor.y - (vecY / dist) * currentMirroredDist;
                } else {
                  // Distance only: keep current direction, match distance
                  if (currentMirroredDist > 0.001) {
                    newX = anchor.x + (currentMirroredVecX / currentMirroredDist) * dist;
                    newY = anchor.y + (currentMirroredVecY / currentMirroredDist) * dist;
                  } else {
                    // Current handle has no direction, use opposite of moved handle
                    newX = anchor.x - (vecX / dist) * dist;
                    newY = anchor.y - (vecY / dist) * dist;
                  }
                }

                if (mirroredHandleType === "c0") {
                  return { ...seg, c0: { x: newX, y: newY } };
                } else {
                  return { ...seg, c1: { x: newX, y: newY } };
                }
              }
            }

            return seg;
          }),
        };
      }),
    };
  },

  // Live handle move (no undo entry - used during drag)
  // Also moves connected control points and handles mirroring propagation
  moveHandleLive: (id: string, segmentIndex: number, handleType: HandleType, dx: number, dy: number, movedPoints?: Set<string>) => {
    // Track which points we've moved to avoid infinite loops
    const moved = movedPoints || new Set<string>();
    const pointKey = `${id}:${segmentIndex}:${handleType}`;
    if (moved.has(pointKey)) return;
    moved.add(pointKey);

    // Get the path to check for mirroring
    const path = state.paths.find((p) => p.id === id);
    if (!path) return;

    // Calculate mirrored handle info BEFORE moving (so we can calculate delta)
    let mirroredSegmentIndex = -1;
    let mirroredHandleType: HandleType = "anchor";
    let anchorIndex: number;
    let mirrorAngle = false;
    let mirrorDistance = false;
    let mirroredActive = false;

    if (handleType === "c0") {
      anchorIndex = segmentIndex;
      mirroredSegmentIndex = segmentIndex === 0
        ? (path.closed ? path.segments.length - 1 : -1)
        : segmentIndex - 1;
      mirroredHandleType = "c1";
    } else {
      const nextIdx = path.closed
        ? (segmentIndex + 1) % path.segments.length
        : segmentIndex + 1;
      anchorIndex = nextIdx;
      mirroredSegmentIndex = (path.closed || segmentIndex < path.segments.length - 1) ? nextIdx : -1;
      mirroredHandleType = "c0";
    }

    if (mirroredSegmentIndex >= 0) {
      const anchorMeta = path.anchorMeta?.[anchorIndex];
      mirrorAngle = anchorMeta?.mirrorAngle || false;
      mirrorDistance = anchorMeta?.mirrorDistance || false;

      if (mirroredHandleType === "c0") {
        mirroredActive = path.anchorMeta?.[anchorIndex]?.rightActive !== false;
      } else {
        mirroredActive = path.anchorMeta?.[anchorIndex]?.leftActive !== false;
      }
    }

    // Get mirrored handle's old position (before move)
    let mirroredOldPos: Point | null = null;
    if ((mirrorAngle || mirrorDistance) && mirroredActive && mirroredSegmentIndex >= 0) {
      const mirroredSeg = path.segments[mirroredSegmentIndex];
      mirroredOldPos = mirroredHandleType === "c0" ? { ...mirroredSeg.c0 } : { ...mirroredSeg.c1 };
    }

    // Move this handle (which also applies mirroring internally)
    store._moveHandleInternal(id, segmentIndex, handleType, dx, dy);

    // Move connected control points for the primary handle
    const connectedPoints = store.getConnectedPoints({ pathId: id, segmentIndex, handleType });
    for (const connPoint of connectedPoints) {
      if (connPoint.handleType === "c0" || connPoint.handleType === "c1") {
        store.moveHandleLive(connPoint.pathId, connPoint.segmentIndex, connPoint.handleType, dx, dy, moved);
      }
    }

    // If mirroring was applied, also propagate the mirrored handle's movement to its connected points
    if (mirroredOldPos && mirroredSegmentIndex >= 0) {
      const mirroredKey = `${id}:${mirroredSegmentIndex}:${mirroredHandleType}`;
      if (!moved.has(mirroredKey)) {
        moved.add(mirroredKey);

        // Get the new position of the mirrored handle
        const updatedPath = state.paths.find((p) => p.id === id);
        if (updatedPath) {
          const mirroredSeg = updatedPath.segments[mirroredSegmentIndex];
          const mirroredNewPos = mirroredHandleType === "c0" ? mirroredSeg.c0 : mirroredSeg.c1;

          // Calculate delta for the mirrored handle
          const mirroredDx = mirroredNewPos.x - mirroredOldPos.x;
          const mirroredDy = mirroredNewPos.y - mirroredOldPos.y;

          // Move connected points of the mirrored handle
          if (mirroredDx !== 0 || mirroredDy !== 0) {
            const mirroredConnected = store.getConnectedPoints({ pathId: id, segmentIndex: mirroredSegmentIndex, handleType: mirroredHandleType });
            for (const connPoint of mirroredConnected) {
              if (connPoint.handleType === "c0" || connPoint.handleType === "c1") {
                store.moveHandleLive(connPoint.pathId, connPoint.segmentIndex, connPoint.handleType, mirroredDx, mirroredDy, moved);
              }
            }
          }
        }
      }
    }

    if (!movedPoints) {
      // Only notify once at the top level - use throttled notify for smooth dragging
      throttledNotify();
    }
  },
  commitMoveHandle: (id: string, segmentIndex: number, handleType: HandleType, dx: number, dy: number, snapConnection?: { points: PointReference[] }) => {
    const moveCmd: Command = { type: "moveHandle", id, segmentIndex, handleType, dx, dy };

    // If snapping, batch the move with the snap connection creation
    if (snapConnection) {
      const connId = crypto.randomUUID();
      const snapCmd: Command = { type: "addSnapConnection", connection: { id: connId, points: snapConnection.points } };
      // Apply the snap connection to state (the move is already applied via live updates)
      state = {
        ...state,
        snapConnections: [...state.snapConnections, { id: connId, points: snapConnection.points }],
        undoStack: [...state.undoStack, { type: "batch", commands: [moveCmd, snapCmd] }],
        redoStack: [],
      };
    } else {
      state = {
        ...state,
        undoStack: [...state.undoStack, moveCmd],
        redoStack: [],
      };
    }
    notify();
  },

  // Anchor metadata modifications
  toggleLeftControl: (pathId: string, anchorIndex: number) => {
    const path = state.paths.find((p) => p.id === pathId);
    if (!path || !path.anchorMeta) return;
    const prevMeta = path.anchorMeta[anchorIndex];
    const newActive = !prevMeta.leftActive;
    const newMeta = { ...prevMeta, leftActive: newActive };

    // c1 is on the previous segment
    const prevSegIdx = anchorIndex === 0 ? path.segments.length - 1 : anchorIndex - 1;
    const seg = path.segments[prevSegIdx];
    const anchor = path.segments[anchorIndex].p0;

    // Store previous control point position
    const prevControlPos = { ...seg.c1 };

    let newControlPos: Point;
    if (newActive) {
      // Reactivating: place c1 at 1/3 distance from anchor to previous anchor (p0 of prev segment)
      const prevAnchor = seg.p0;
      newControlPos = {
        x: anchor.x + (prevAnchor.x - anchor.x) / 3,
        y: anchor.y + (prevAnchor.y - anchor.y) / 3,
      };
    } else {
      // Deactivating: collapse c1 to the anchor position
      newControlPos = { ...anchor };
    }

    // Update segment c1 in state
    state = {
      ...state,
      paths: state.paths.map((p) => {
        if (p.id !== pathId) return p;
        return {
          ...p,
          segments: p.segments.map((s, i) =>
            i === prevSegIdx ? { ...s, c1: newControlPos } : s
          ),
        };
      }),
    };

    executeCommand({ type: "toggleControl", id: pathId, anchorIndex, handleType: "left", prevMeta, newMeta, prevControlPos, newControlPos });
  },
  toggleRightControl: (pathId: string, anchorIndex: number) => {
    const path = state.paths.find((p) => p.id === pathId);
    if (!path || !path.anchorMeta) return;
    const prevMeta = path.anchorMeta[anchorIndex];
    const newActive = !prevMeta.rightActive;
    const newMeta = { ...prevMeta, rightActive: newActive };

    // c0 is on this segment
    const seg = path.segments[anchorIndex];
    const anchor = seg.p0;
    const nextAnchor = seg.p1;

    // Store previous control point position
    const prevControlPos = { ...seg.c0 };

    let newControlPos: Point;
    if (newActive) {
      // Reactivating: place c0 at 1/3 distance from anchor to next anchor
      newControlPos = {
        x: anchor.x + (nextAnchor.x - anchor.x) / 3,
        y: anchor.y + (nextAnchor.y - anchor.y) / 3,
      };
    } else {
      // Deactivating: collapse c0 to the anchor position
      newControlPos = { ...anchor };
    }

    // Update segment c0 in state
    state = {
      ...state,
      paths: state.paths.map((p) => {
        if (p.id !== pathId) return p;
        return {
          ...p,
          segments: p.segments.map((s, i) =>
            i === anchorIndex ? { ...s, c0: newControlPos } : s
          ),
        };
      }),
    };

    executeCommand({ type: "toggleControl", id: pathId, anchorIndex, handleType: "right", prevMeta, newMeta, prevControlPos, newControlPos });
  },
  setMirrorAngle: (pathId: string, anchorIndex: number, enabled: boolean) => {
    const path = state.paths.find((p) => p.id === pathId);
    if (!path || !path.anchorMeta) return;
    const prevMeta = path.anchorMeta[anchorIndex];
    if (prevMeta.mirrorAngle === enabled) return;

    const newMeta = { ...prevMeta, mirrorAngle: enabled };
    const anchor = path.segments[anchorIndex].p0;
    const prevSegIdx = anchorIndex === 0 ? path.segments.length - 1 : anchorIndex - 1;

    // Store original positions for undo
    const prevC0 = { ...path.segments[anchorIndex].c0 };
    const prevC1 = { ...path.segments[prevSegIdx].c1 };

    // Calculate new positions (default to unchanged)
    let newC0 = { ...prevC0 };
    let newC1 = { ...prevC1 };

    // If enabling, apply symmetry immediately
    if (enabled) {
      const c0Active = prevMeta.rightActive;
      const c1Active = prevMeta.leftActive;

      // If one is active and one is not, create the inactive one by mirroring
      if (c0Active && !c1Active) {
        // Mirror c0 to create c1
        const vecX = prevC0.x - anchor.x;
        const vecY = prevC0.y - anchor.y;
        const dist = Math.sqrt(vecX * vecX + vecY * vecY);
        if (dist > 0.001) {
          newC1 = {
            x: anchor.x - (vecX / dist) * dist,
            y: anchor.y - (vecY / dist) * dist,
          };
          newMeta.leftActive = true;
        }
      } else if (c1Active && !c0Active) {
        // Mirror c1 to create c0
        const vecX = prevC1.x - anchor.x;
        const vecY = prevC1.y - anchor.y;
        const dist = Math.sqrt(vecX * vecX + vecY * vecY);
        if (dist > 0.001) {
          newC0 = {
            x: anchor.x - (vecX / dist) * dist,
            y: anchor.y - (vecY / dist) * dist,
          };
          newMeta.rightActive = true;
        }
      } else if (c0Active && c1Active) {
        // Both active - use average angle and adjust both control points
        const c0VecX = prevC0.x - anchor.x;
        const c0VecY = prevC0.y - anchor.y;
        const c0Dist = Math.sqrt(c0VecX * c0VecX + c0VecY * c0VecY);
        const c0Angle = Math.atan2(c0VecY, c0VecX);

        const c1VecX = prevC1.x - anchor.x;
        const c1VecY = prevC1.y - anchor.y;
        const c1Dist = Math.sqrt(c1VecX * c1VecX + c1VecY * c1VecY);
        const c1Angle = Math.atan2(c1VecY, c1VecX);

        if (c0Dist > 0.001 && c1Dist > 0.001) {
          // Calculate the average angle between c0 and the opposite of c1
          const c1AlignedAngle = c1Angle + Math.PI;
          let angleDiff = c1AlignedAngle - c0Angle;
          while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
          while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;
          const avgAngle = c0Angle + angleDiff / 2;

          newC0 = {
            x: anchor.x + Math.cos(avgAngle) * c0Dist,
            y: anchor.y + Math.sin(avgAngle) * c0Dist,
          };
          newC1 = {
            x: anchor.x + Math.cos(avgAngle + Math.PI) * c1Dist,
            y: anchor.y + Math.sin(avgAngle + Math.PI) * c1Dist,
          };
        }
      }
    }

    executeCommand({ type: "setMirror", id: pathId, anchorIndex, prevMeta, newMeta, prevC0, newC0, prevC1, newC1 });
  },
  setMirrorDistance: (pathId: string, anchorIndex: number, enabled: boolean) => {
    const path = state.paths.find((p) => p.id === pathId);
    if (!path || !path.anchorMeta) return;
    const prevMeta = path.anchorMeta[anchorIndex];
    if (prevMeta.mirrorDistance === enabled) return;

    const newMeta = { ...prevMeta, mirrorDistance: enabled };
    const anchor = path.segments[anchorIndex].p0;
    const prevSegIdx = anchorIndex === 0 ? path.segments.length - 1 : anchorIndex - 1;

    // Store original positions for undo
    const prevC0 = { ...path.segments[anchorIndex].c0 };
    const prevC1 = { ...path.segments[prevSegIdx].c1 };

    // Calculate new positions (default to unchanged)
    let newC0 = { ...prevC0 };
    let newC1 = { ...prevC1 };

    // If enabling, apply distance symmetry immediately
    if (enabled) {
      const c0Active = prevMeta.rightActive;
      const c1Active = prevMeta.leftActive;

      // If one is active and one is not, create the inactive one
      if (c0Active && !c1Active) {
        // Create c1 at same distance as c0, opposite direction
        const vecX = prevC0.x - anchor.x;
        const vecY = prevC0.y - anchor.y;
        const dist = Math.sqrt(vecX * vecX + vecY * vecY);
        if (dist > 0.001) {
          newC1 = {
            x: anchor.x - vecX,
            y: anchor.y - vecY,
          };
          newMeta.leftActive = true;
          newMeta.mirrorAngle = true; // Also enable angle mirroring
        }
      } else if (c1Active && !c0Active) {
        // Create c0 at same distance as c1, opposite direction
        const vecX = prevC1.x - anchor.x;
        const vecY = prevC1.y - anchor.y;
        const dist = Math.sqrt(vecX * vecX + vecY * vecY);
        if (dist > 0.001) {
          newC0 = {
            x: anchor.x - vecX,
            y: anchor.y - vecY,
          };
          newMeta.rightActive = true;
          newMeta.mirrorAngle = true; // Also enable angle mirroring
        }
      } else if (c0Active && c1Active) {
        // Both active - use average distance and adjust both control points
        const c0VecX = prevC0.x - anchor.x;
        const c0VecY = prevC0.y - anchor.y;
        const c0Dist = Math.sqrt(c0VecX * c0VecX + c0VecY * c0VecY);
        const c1VecX = prevC1.x - anchor.x;
        const c1VecY = prevC1.y - anchor.y;
        const c1Dist = Math.sqrt(c1VecX * c1VecX + c1VecY * c1VecY);

        if (c0Dist > 0.001 && c1Dist > 0.001) {
          const avgDist = (c0Dist + c1Dist) / 2;
          newC0 = {
            x: anchor.x + (c0VecX / c0Dist) * avgDist,
            y: anchor.y + (c0VecY / c0Dist) * avgDist,
          };
          newC1 = {
            x: anchor.x + (c1VecX / c1Dist) * avgDist,
            y: anchor.y + (c1VecY / c1Dist) * avgDist,
          };
        }
      }
    }

    executeCommand({ type: "setMirror", id: pathId, anchorIndex, prevMeta, newMeta, prevC0, newC0, prevC1, newC1 });
  },

  // Color modifications - track original colors for live editing
  _colorEditStart: null as { type: "anchor"; pathId: string; anchorIndex: number; originalColor: string | null }
                       | { type: "pathFill"; pathId: string; originalFill: string }
                       | { type: "selection"; originalColors: { pathId: string; anchorIndex: number; color: string | null }[] }
                       | null,
  _colorCommitTimer: null as ReturnType<typeof setTimeout> | null,

  // Live anchor color (updates immediately, no undo)
  setAnchorColorLive: (pathId: string, anchorIndex: number, color: string | null) => {
    const path = state.paths.find((p) => p.id === pathId);
    if (!path || !path.anchorMeta) return;

    // Record original color on first call
    if (!store._colorEditStart || store._colorEditStart.type !== "anchor"
        || store._colorEditStart.pathId !== pathId || store._colorEditStart.anchorIndex !== anchorIndex) {
      store._colorEditStart = { type: "anchor", pathId, anchorIndex, originalColor: path.anchorMeta[anchorIndex].color };
    }

    // Update immediately without undo
    const newMeta = { ...path.anchorMeta[anchorIndex], color };
    state = {
      ...state,
      paths: state.paths.map((p) =>
        p.id === pathId
          ? { ...p, anchorMeta: p.anchorMeta.map((m, i) => (i === anchorIndex ? newMeta : m)) }
          : p
      ),
    };
    throttledNotify();

    // Schedule auto-commit after inactivity (handles browsers where onChange fires on every change)
    if (store._colorCommitTimer) clearTimeout(store._colorCommitTimer);
    store._colorCommitTimer = setTimeout(() => {
      store.commitAnchorColor(pathId, anchorIndex);
    }, 300);
  },

  // Commit anchor color change to undo stack
  commitAnchorColor: (pathId: string, anchorIndex: number) => {
    // Clear any pending auto-commit timer
    if (store._colorCommitTimer) {
      clearTimeout(store._colorCommitTimer);
      store._colorCommitTimer = null;
    }

    if (!store._colorEditStart || store._colorEditStart.type !== "anchor"
        || store._colorEditStart.pathId !== pathId || store._colorEditStart.anchorIndex !== anchorIndex) {
      return;
    }

    const path = state.paths.find((p) => p.id === pathId);
    if (!path || !path.anchorMeta) {
      store._colorEditStart = null;
      return;
    }

    const currentColor = path.anchorMeta[anchorIndex].color;
    const originalColor = store._colorEditStart.originalColor;
    store._colorEditStart = null;

    if (currentColor === originalColor) return;

    // Create undo command with original values - need to copy all meta fields
    const currentMeta = path.anchorMeta[anchorIndex];
    const prevMeta = {
      leftActive: currentMeta.leftActive,
      rightActive: currentMeta.rightActive,
      mirrorAngle: currentMeta.mirrorAngle,
      mirrorDistance: currentMeta.mirrorDistance,
      color: originalColor,
    };
    const newMeta = {
      leftActive: currentMeta.leftActive,
      rightActive: currentMeta.rightActive,
      mirrorAngle: currentMeta.mirrorAngle,
      mirrorDistance: currentMeta.mirrorDistance,
      color: currentColor,
    };

    // Don't re-apply since state is already updated - just add to undo stack
    state = {
      ...state,
      undoStack: [...state.undoStack, { type: "setAnchorMeta", id: pathId, anchorIndex, prevMeta, newMeta }],
      redoStack: [],
    };
    notify();

    // Store this color for new paths (if it's not null/clearing)
    if (currentColor !== null) {
      state = { ...state, fillColor: currentColor };
      notify();
    }
  },

  // Original setAnchorColor - immediate commit (for Clear button, etc.)
  setAnchorColor: (pathId: string, anchorIndex: number, color: string | null) => {
    const path = state.paths.find((p) => p.id === pathId);
    if (!path || !path.anchorMeta) return;
    const prevMeta = path.anchorMeta[anchorIndex];
    if (prevMeta.color === color) return;
    const newMeta = { ...prevMeta, color };
    executeCommand({ type: "setAnchorMeta", id: pathId, anchorIndex, prevMeta, newMeta });
    // Store this color for new paths (if it's not null/clearing)
    if (color !== null) {
      state = { ...state, fillColor: color };
      notify();
    }
  },

  // Live path vertex colors (all anchors at once, updates immediately, no undo)
  setPathVertexColorsLive: (pathId: string, color: string) => {
    const path = state.paths.find((p) => p.id === pathId);
    if (!path || !path.anchorMeta) return;

    // Record original colors on first call
    if (!store._colorEditStart || store._colorEditStart.type !== "selection") {
      const originalColors: { pathId: string; anchorIndex: number; color: string | null }[] = [];
      for (let i = 0; i < path.anchorMeta.length; i++) {
        originalColors.push({ pathId, anchorIndex: i, color: path.anchorMeta[i].color });
      }
      store._colorEditStart = { type: "selection", originalColors };
    }

    // Update all vertex colors immediately without undo
    state = {
      ...state,
      paths: state.paths.map((p) =>
        p.id === pathId
          ? { ...p, anchorMeta: p.anchorMeta.map((m) => ({ ...m, color })) }
          : p
      ),
    };
    throttledNotify();

    // Schedule auto-commit after inactivity
    if (store._colorCommitTimer) clearTimeout(store._colorCommitTimer);
    store._colorCommitTimer = setTimeout(() => {
      store.commitPathVertexColors(pathId);
    }, 300);
  },

  // Commit path vertex colors change to undo stack
  commitPathVertexColors: (pathId: string) => {
    // Clear any pending auto-commit timer
    if (store._colorCommitTimer) {
      clearTimeout(store._colorCommitTimer);
      store._colorCommitTimer = null;
    }

    if (!store._colorEditStart || store._colorEditStart.type !== "selection") {
      return;
    }

    const { originalColors } = store._colorEditStart;
    // Only commit if all original colors belong to this path
    if (!originalColors.every((c) => c.pathId === pathId)) {
      return;
    }

    store._colorEditStart = null;

    const path = state.paths.find((p) => p.id === pathId);
    if (!path || !path.anchorMeta) return;

    const commands: Command[] = [];
    for (const orig of originalColors) {
      const currentMeta = path.anchorMeta[orig.anchorIndex];
      const currentColor = currentMeta.color;
      if (currentColor === orig.color) continue;
      const prevMeta = {
        leftActive: currentMeta.leftActive,
        rightActive: currentMeta.rightActive,
        mirrorAngle: currentMeta.mirrorAngle,
        mirrorDistance: currentMeta.mirrorDistance,
        color: orig.color,
      };
      const newMeta = {
        leftActive: currentMeta.leftActive,
        rightActive: currentMeta.rightActive,
        mirrorAngle: currentMeta.mirrorAngle,
        mirrorDistance: currentMeta.mirrorDistance,
        color: currentColor,
      };
      commands.push({ type: "setAnchorMeta", id: pathId, anchorIndex: orig.anchorIndex, prevMeta, newMeta });
    }

    if (commands.length === 0) return;
    const cmd: Command = commands.length === 1 ? commands[0] : { type: "batch", commands };

    // Don't re-apply since state is already updated - just add to undo stack
    state = {
      ...state,
      undoStack: [...state.undoStack, cmd],
      redoStack: [],
    };
    notify();

    // Store this color for new paths
    if (path.anchorMeta.length > 0 && path.anchorMeta[0].color !== null) {
      state = { ...state, fillColor: path.anchorMeta[0].color };
      notify();
    }
  },

  // Live path fill (updates immediately, no undo)
  setPathFillLive: (pathId: string, fill: string) => {
    const path = state.paths.find((p) => p.id === pathId);
    if (!path) return;

    // Record original fill on first call
    if (!store._colorEditStart || store._colorEditStart.type !== "pathFill" || store._colorEditStart.pathId !== pathId) {
      store._colorEditStart = { type: "pathFill", pathId, originalFill: path.fill };
    }

    // Update immediately without undo
    state = {
      ...state,
      paths: state.paths.map((p) => (p.id === pathId ? { ...p, fill } : p)),
    };
    throttledNotify();
  },

  // Commit path fill change to undo stack
  commitPathFill: (pathId: string) => {
    if (!store._colorEditStart || store._colorEditStart.type !== "pathFill" || store._colorEditStart.pathId !== pathId) {
      return;
    }

    const path = state.paths.find((p) => p.id === pathId);
    if (!path) {
      store._colorEditStart = null;
      return;
    }

    const currentFill = path.fill;
    const originalFill = store._colorEditStart.originalFill;
    store._colorEditStart = null;

    if (currentFill === originalFill) return;

    // Don't re-apply since state is already updated - just add to undo stack
    state = {
      ...state,
      undoStack: [...state.undoStack, { type: "setPathFill", id: pathId, prevFill: originalFill, newFill: currentFill }],
      redoStack: [],
    };
    notify();
  },

  // Original setPathFill - immediate commit
  setPathFill: (pathId: string, fill: string) => {
    const path = state.paths.find((p) => p.id === pathId);
    if (!path || path.fill === fill) return;
    executeCommand({ type: "setPathFill", id: pathId, prevFill: path.fill, newFill: fill });
  },
  setPathOpacity: (pathId: string, opacity: number) => {
    const path = state.paths.find((p) => p.id === pathId);
    if (!path || path.opacity === opacity) return;
    executeCommand({ type: "setPathOpacity", id: pathId, prevOpacity: path.opacity, newOpacity: opacity });
    // Store this opacity for new paths
    state = { ...state, fillOpacity: opacity };
    notify();
  },
  setPathVisible: (pathId: string, visible: boolean) => {
    const path = state.paths.find((p) => p.id === pathId);
    if (!path || path.visible === visible) return;
    executeCommand({ type: "setPathVisible", id: pathId, visible });
  },
  setPathLocked: (pathId: string, locked: boolean) => {
    const path = state.paths.find((p) => p.id === pathId);
    if (!path || path.locked === locked) return;
    executeCommand({ type: "setPathLocked", id: pathId, locked });
  },
  setPathName: (pathId: string, name: string) => {
    const path = state.paths.find((p) => p.id === pathId);
    if (!path || path.name === name) return;
    executeCommand({ type: "setPathName", id: pathId, prevName: path.name, newName: name });
  },
  getNextPathName: (): string => {
    const name = `Path ${state.pathCounter}`;
    state = { ...state, pathCounter: state.pathCounter + 1 };
    notify();
    return name;
  },
  // Live selection color (updates immediately, no undo)
  setSelectionColorLive: (color: string) => {
    const { selection, paths } = state;

    // Record original colors on first call
    if (!store._colorEditStart || store._colorEditStart.type !== "selection") {
      const originalColors: { pathId: string; anchorIndex: number; color: string | null }[] = [];

      for (const pathId of selection.pathIds) {
        const path = paths.find((p) => p.id === pathId);
        if (!path || !path.anchorMeta) continue;
        for (let i = 0; i < path.anchorMeta.length; i++) {
          originalColors.push({ pathId, anchorIndex: i, color: path.anchorMeta[i].color });
        }
      }

      for (const pt of selection.points) {
        if (pt.handleType !== "anchor") continue;
        const path = paths.find((p) => p.id === pt.pathId);
        if (!path || !path.anchorMeta) continue;
        originalColors.push({ pathId: pt.pathId, anchorIndex: pt.segmentIndex, color: path.anchorMeta[pt.segmentIndex].color });
      }

      store._colorEditStart = { type: "selection", originalColors };
    }

    // Update all colors immediately without undo
    let newPaths = paths;
    for (const pathId of selection.pathIds) {
      const path = newPaths.find((p) => p.id === pathId);
      if (!path || !path.anchorMeta) continue;
      newPaths = newPaths.map((p) =>
        p.id === pathId
          ? { ...p, anchorMeta: p.anchorMeta.map((m) => ({ ...m, color })) }
          : p
      );
    }

    for (const pt of selection.points) {
      if (pt.handleType !== "anchor") continue;
      const path = newPaths.find((p) => p.id === pt.pathId);
      if (!path || !path.anchorMeta) continue;
      newPaths = newPaths.map((p) =>
        p.id === pt.pathId
          ? { ...p, anchorMeta: p.anchorMeta.map((m, i) => (i === pt.segmentIndex ? { ...m, color } : m)) }
          : p
      );
    }

    state = { ...state, paths: newPaths };
    throttledNotify();

    // Schedule auto-commit after inactivity
    if (store._colorCommitTimer) clearTimeout(store._colorCommitTimer);
    store._colorCommitTimer = setTimeout(() => {
      store.commitSelectionColor();
    }, 300);
  },

  // Commit selection color change to undo stack
  commitSelectionColor: () => {
    // Clear any pending auto-commit timer
    if (store._colorCommitTimer) {
      clearTimeout(store._colorCommitTimer);
      store._colorCommitTimer = null;
    }

    if (!store._colorEditStart || store._colorEditStart.type !== "selection") {
      return;
    }

    const { originalColors } = store._colorEditStart;
    store._colorEditStart = null;

    const { paths } = state;
    const commands: Command[] = [];

    for (const orig of originalColors) {
      const path = paths.find((p) => p.id === orig.pathId);
      if (!path || !path.anchorMeta) continue;
      const currentMeta = path.anchorMeta[orig.anchorIndex];
      const currentColor = currentMeta.color;
      if (currentColor === orig.color) continue;
      const prevMeta = {
        leftActive: currentMeta.leftActive,
        rightActive: currentMeta.rightActive,
        mirrorAngle: currentMeta.mirrorAngle,
        mirrorDistance: currentMeta.mirrorDistance,
        color: orig.color,
      };
      const newMeta = {
        leftActive: currentMeta.leftActive,
        rightActive: currentMeta.rightActive,
        mirrorAngle: currentMeta.mirrorAngle,
        mirrorDistance: currentMeta.mirrorDistance,
        color: currentColor,
      };
      commands.push({ type: "setAnchorMeta", id: orig.pathId, anchorIndex: orig.anchorIndex, prevMeta, newMeta });
    }

    if (commands.length === 0) return;
    const cmd: Command = commands.length === 1 ? commands[0] : { type: "batch", commands };

    // Don't re-apply since state is already updated - just add to undo stack
    state = {
      ...state,
      undoStack: [...state.undoStack, cmd],
      redoStack: [],
    };
    notify();

    // Store this color for new paths
    const firstColor = paths.length > 0 && paths[0].anchorMeta?.length > 0
      ? paths[0].anchorMeta[0].color
      : null;
    if (firstColor !== null) {
      state = { ...state, fillColor: firstColor };
      notify();
    }
  },

  // Original setSelectionColor - immediate commit
  setSelectionColor: (color: string) => {
    const { selection, paths } = state;
    const commands: Command[] = [];

    // Set vertex color for all anchors in fully selected paths
    for (const pathId of selection.pathIds) {
      const path = paths.find((p) => p.id === pathId);
      if (!path || !path.anchorMeta) continue;
      for (let i = 0; i < path.anchorMeta.length; i++) {
        const prevMeta = path.anchorMeta[i];
        if (prevMeta.color === color) continue;
        const newMeta = { ...prevMeta, color };
        commands.push({ type: "setAnchorMeta", id: pathId, anchorIndex: i, prevMeta, newMeta });
      }
    }

    // Set anchor colors for all selected points
    for (const pt of selection.points) {
      if (pt.handleType !== "anchor") continue; // Only anchors have vertex colors
      const path = paths.find((p) => p.id === pt.pathId);
      if (!path || !path.anchorMeta) continue;
      const prevMeta = path.anchorMeta[pt.segmentIndex];
      if (prevMeta.color === color) continue;
      const newMeta = { ...prevMeta, color };
      commands.push({ type: "setAnchorMeta", id: pt.pathId, anchorIndex: pt.segmentIndex, prevMeta, newMeta });
    }

    if (commands.length === 0) return;
    const cmd: Command = commands.length === 1 ? commands[0] : { type: "batch", commands };
    executeCommand(cmd);

    // Store this color for new paths
    state = { ...state, fillColor: color };
    notify();
  },
  clearAnchorColor: (pathId: string, anchorIndex: number) => {
    store.setAnchorColor(pathId, anchorIndex, null);
  },

  // Clipboard operations
  copy: () => {
    const { selection, paths } = state;

    // If full paths are selected, copy them
    if (selection.pathIds.length > 0) {
      const copiedPaths = selection.pathIds
        .map((id) => paths.find((p) => p.id === id))
        .filter((p): p is Path => p !== undefined)
        .map((p) => ({
          ...p,
          id: crypto.randomUUID(), // New ID for paste
          segments: p.segments.map((seg) => ({ ...seg, p0: { ...seg.p0 }, c0: { ...seg.c0 }, c1: { ...seg.c1 }, p1: { ...seg.p1 } })),
          anchorMeta: p.anchorMeta.map((m) => ({ ...m })),
        }));

      if (copiedPaths.length > 0) {
        state = { ...state, clipboard: { type: "paths", paths: copiedPaths } };
        notify();
      }
      return;
    }

    // If individual anchor points are selected, copy them (for future paste into same or different path)
    const anchorPoints = selection.points.filter((pt) => pt.handleType === "anchor");
    if (anchorPoints.length > 0) {
      const anchors: { pathId: string; segmentIndex: number; point: Point; meta: AnchorMeta }[] = [];
      let sumX = 0, sumY = 0;

      for (const pt of anchorPoints) {
        const path = paths.find((p) => p.id === pt.pathId);
        if (!path) continue;
        const point = path.segments[pt.segmentIndex].p0;
        const meta = path.anchorMeta[pt.segmentIndex];
        anchors.push({
          pathId: pt.pathId,
          segmentIndex: pt.segmentIndex,
          point: { ...point },
          meta: { ...meta },
        });
        sumX += point.x;
        sumY += point.y;
      }

      if (anchors.length > 0) {
        const center = { x: sumX / anchors.length, y: sumY / anchors.length };
        state = { ...state, clipboard: { type: "anchors", anchors, center } };
        notify();
      }
    }
  },
  cut: () => {
    // Copy first, then delete
    store.copy();
    store.deleteSelection();
  },
  paste: () => {
    const { clipboard } = state;
    if (!clipboard) return;

    if (clipboard.type === "paths") {
      // Paste paths with new IDs and names (no offset), at root level
      const pastedPaths = clipboard.paths.map((p) => ({
        ...p,
        id: crypto.randomUUID(),
        name: store.getNextPathName(),
        parentId: null, // Paste at root level
        segments: p.segments.map((seg) => ({
          p0: { ...seg.p0 },
          c0: { ...seg.c0 },
          c1: { ...seg.c1 },
          p1: { ...seg.p1 },
        })),
        anchorMeta: p.anchorMeta.map((m) => ({ ...m })),
      }));

      // Add all pasted paths
      const commands: Command[] = pastedPaths.map((path) => ({ type: "addPath" as const, path }));
      const cmd: Command = commands.length === 1 ? commands[0] : { type: "batch", commands };
      executeCommand(cmd);

      // Select the pasted paths
      state = { ...state, selection: { pathIds: pastedPaths.map((p) => p.id), points: [] } };
      notify();
    }
    // Note: Pasting individual anchors into paths is complex (would need to insert new segments)
    // For now, we only support pasting full paths
  },
  canPaste: () => state.clipboard !== null && state.clipboard.type === "paths",

  // Undo/Redo
  undo: () => {
    if (state.undoStack.length === 0) return;
    const cmd = state.undoStack[state.undoStack.length - 1];
    state = applyCommand(state, cmd, true);
    state = {
      ...state,
      undoStack: state.undoStack.slice(0, -1),
      redoStack: [...state.redoStack, cmd],
    };
    notify();
  },
  redo: () => {
    if (state.redoStack.length === 0) return;
    const cmd = state.redoStack[state.redoStack.length - 1];
    state = applyCommand(state, cmd, false);
    state = {
      ...state,
      redoStack: state.redoStack.slice(0, -1),
      undoStack: [...state.undoStack, cmd],
    };
    notify();
  },
  canUndo: () => state.undoStack.length > 0,
  canRedo: () => state.redoStack.length > 0,

  // Split path - check if we can split (exactly 2 non-adjacent anchors on same path)
  canSplit: () => {
    const { selection, paths } = state;
    // Must have exactly 2 selected points
    if (selection.pathIds.length !== 0 || selection.points.length !== 2) return false;

    // Both must be anchors
    const [p1, p2] = selection.points;
    if (p1.handleType !== "anchor" || p2.handleType !== "anchor") return false;

    // Both must be on the same path
    if (p1.pathId !== p2.pathId) return false;

    const path = paths.find((p) => p.id === p1.pathId);
    if (!path || !path.closed) return false; // Can only split closed paths

    // Must not be adjacent
    const n = path.segments.length;
    const idx1 = p1.segmentIndex;
    const idx2 = p2.segmentIndex;
    const diff = Math.abs(idx1 - idx2);
    // Adjacent if diff is 1 or n-1 (wrap around)
    if (diff === 1 || diff === n - 1) return false;

    return true;
  },

  // Split the path at the two selected anchor points
  splitPath: () => {
    if (!store.canSplit()) return;

    const { selection, paths } = state;
    const [p1, p2] = selection.points;
    const path = paths.find((p) => p.id === p1.pathId)!;

    // Sort indices so idx1 < idx2
    let idx1 = p1.segmentIndex;
    let idx2 = p2.segmentIndex;
    if (idx1 > idx2) [idx1, idx2] = [idx2, idx1];

    const n = path.segments.length;

    // Create two new closed paths
    // Path 1: from idx1 to idx2 with a closing segment back to idx1
    // Path 2: from idx2 to idx1 (wrapping) with a closing segment back to idx2

    // Deep copy helper for segment
    const copySegment = (seg: CubicSegment): CubicSegment => ({
      p0: { ...seg.p0 },
      c0: { ...seg.c0 },
      c1: { ...seg.c1 },
      p1: { ...seg.p1 },
    });

    // Deep copy helper for anchor meta
    const copyMeta = (meta: AnchorMeta): AnchorMeta => ({ ...meta });

    // Path 1: segments from idx1 to idx2-1, plus a closing segment from idx2 back to idx1
    const segments1: CubicSegment[] = [];
    const meta1: AnchorMeta[] = [];
    for (let i = idx1; i < idx2; i++) {
      segments1.push(copySegment(path.segments[i]));
      meta1.push(copyMeta(path.anchorMeta[i]));
    }
    // Add closing segment from anchor at idx2 back to anchor at idx1
    const closingSeg1 = lineSegment(
      path.segments[idx2 === n ? 0 : idx2].p0, // Position of anchor idx2
      path.segments[idx1].p0 // Position of anchor idx1
    );
    segments1.push(closingSeg1);
    meta1.push(copyMeta(path.anchorMeta[idx2]));

    // Path 2: segments from idx2 wrapping to idx1, plus a closing segment from idx1 back to idx2
    const segments2: CubicSegment[] = [];
    const meta2: AnchorMeta[] = [];
    for (let i = idx2; i !== idx1; i = (i + 1) % n) {
      segments2.push(copySegment(path.segments[i]));
      meta2.push(copyMeta(path.anchorMeta[i]));
    }
    // Add closing segment from anchor at idx1 back to anchor at idx2
    const closingSeg2 = lineSegment(
      path.segments[idx1].p0, // Position of anchor idx1
      path.segments[idx2 === n ? 0 : idx2].p0 // Position of anchor idx2
    );
    segments2.push(closingSeg2);
    meta2.push(copyMeta(path.anchorMeta[idx1]));

    const newPath1: Path = {
      id: crypto.randomUUID(),
      name: store.getNextPathName(),
      parentId: path.parentId, // Inherit parent from original path
      segments: segments1,
      anchorMeta: meta1,
      closed: true,
      fill: path.fill,
      visible: path.visible,
      locked: path.locked,
    };

    const newPath2: Path = {
      id: crypto.randomUUID(),
      name: store.getNextPathName(),
      parentId: path.parentId, // Inherit parent from original path
      segments: segments2,
      anchorMeta: meta2,
      closed: true,
      fill: path.fill,
      visible: path.visible,
      locked: path.locked,
    };

    // Create snap connections for the split points (they're at the same position)
    // In path1: anchor 0 is at idx1's original position, anchor (idx2-idx1) is at idx2's position
    // In path2: anchor 0 is at idx2's original position, last anchor (segments2.length-1) is at idx1's position
    const path1Idx1Anchor = 0;
    const path1Idx2Anchor = idx2 - idx1;
    const path2Idx2Anchor = 0;
    const path2Idx1Anchor = segments2.length - 1;

    // Batch the split command with the snap connection commands for proper undo/redo
    const commands: Command[] = [
      { type: "splitPath", originalPath: path, newPath1, newPath2 },
    ];

    // Connect the two anchors at idx1's original position
    const conn1 = store._createSnapConnectionCommand([
      { pathId: newPath1.id, segmentIndex: path1Idx1Anchor, handleType: "anchor" },
      { pathId: newPath2.id, segmentIndex: path2Idx1Anchor, handleType: "anchor" },
    ]);
    if (conn1) commands.push(conn1);

    // Connect the two anchors at idx2's original position
    const conn2 = store._createSnapConnectionCommand([
      { pathId: newPath1.id, segmentIndex: path1Idx2Anchor, handleType: "anchor" },
      { pathId: newPath2.id, segmentIndex: path2Idx2Anchor, handleType: "anchor" },
    ]);
    if (conn2) commands.push(conn2);

    executeCommand({ type: "batch", commands });
  },

  // Get selected paths helper
  getSelectedPaths: () => {
    const { selection, paths } = state;
    return selection.pathIds
      .map((id) => paths.find((p) => p.id === id))
      .filter((p): p is Path => p !== undefined);
  },

  // Check if specific boolean operation is possible
  // Now always enabled when paths are selected - if no intersection, will enter drawing mode
  canUnite: () => {
    const selectedPaths = store.getSelectedPaths();
    return selectedPaths.length >= 1;
  },

  canIntersect: () => {
    const selectedPaths = store.getSelectedPaths();
    return selectedPaths.length >= 1;
  },

  canSubtract: () => {
    const selectedPaths = store.getSelectedPaths();
    return selectedPaths.length >= 1;
  },

  canExclude: () => {
    const selectedPaths = store.getSelectedPaths();
    return selectedPaths.length >= 1;
  },

  // Check if paths actually intersect (used internally to decide immediate vs drawing mode)
  _pathsCanBooleanOp: (operation: "unite" | "intersect" | "subtract" | "exclude") => {
    const selectedPaths = store.getSelectedPaths();
    if (operation === "unite") {
      if (selectedPaths.length < 2) return false;
    } else {
      if (selectedPaths.length !== 2) return false;
    }
    return canBooleanOp(selectedPaths, operation);
  },

  // Helper to start drawing mode for a pending boolean operation
  _startPendingBooleanOp: (operation: "unite" | "intersect" | "subtract" | "exclude") => {
    const selectedPaths = store.getSelectedPaths();
    if (selectedPaths.length === 0) return;

    // Store the pending operation and switch to line tool
    state = {
      ...state,
      pendingBooleanOp: {
        operation,
        targetPathIds: selectedPaths.map((p) => p.id),
      },
      tool: "line",
    };
    notify();
  },

  // Cancel any pending boolean operation
  cancelPendingBooleanOp: () => {
    if (state.pendingBooleanOp) {
      state = { ...state, pendingBooleanOp: null };
      notify();
    }
  },

  // Get the pending boolean operation
  getPendingBooleanOp: () => state.pendingBooleanOp,

  // Execute a blob operation (add/subtract) - used by blob tool
  executeBlobOp: (originalPaths: Path[], resultPaths: Path[]) => {
    // Clean up snap connections for original paths
    for (const path of originalPaths) {
      store.cleanupConnectionsForPath(path.id);
    }
    executeCommand({ type: "booleanOp", originalPaths, resultPaths, operation: "unite" });
    // Select the result paths
    if (resultPaths.length > 0) {
      state = { ...state, selection: { pathIds: resultPaths.map((p) => p.id), points: [] } };
      notify();
    }
  },

  // Unite multiple paths (2+) - or enter drawing mode if no intersection
  unitePaths: () => {
    const selectedPaths = store.getSelectedPaths();
    if (selectedPaths.length === 0) return;

    // If we have 2+ paths that intersect, do immediate unite
    if (selectedPaths.length >= 2 && canBooleanOp(selectedPaths, "unite")) {
      const resultPaths = uniteMultiplePaths(selectedPaths, () => store.getNextPathName());
      if (resultPaths.length > 0) {
        executeCommand({ type: "booleanOp", originalPaths: selectedPaths, resultPaths, operation: "unite" });
        return;
      }
    }

    // Otherwise, enter drawing mode to draw a new path to unite with
    store._startPendingBooleanOp("unite");
  },

  // Intersect paths - or enter drawing mode if no intersection
  intersectPaths: () => {
    const selectedPaths = store.getSelectedPaths();
    if (selectedPaths.length === 0) return;

    // If we have exactly 2 paths that intersect, do immediate intersect
    if (selectedPaths.length === 2 && canBooleanOp(selectedPaths, "intersect")) {
      const resultPaths = booleanOperation(selectedPaths[0], selectedPaths[1], "intersect", () => store.getNextPathName());
      if (resultPaths.length > 0) {
        // Batch the boolean op with snap connections for proper undo/redo
        const commands: Command[] = [
          { type: "booleanOp", originalPaths: selectedPaths, resultPaths, operation: "intersect" },
        ];

        // Find coincident points across result paths and create snap connections
        const snapCommands = store._createCoincidentSnapCommands(resultPaths);
        commands.push(...snapCommands);

        executeCommand({ type: "batch", commands });
        return;
      }
    }

    // Otherwise, enter drawing mode to draw a new path to intersect with
    store._startPendingBooleanOp("intersect");
  },

  // Subtract paths - or enter drawing mode if no intersection
  subtractPaths: () => {
    const selectedPaths = store.getSelectedPaths();
    if (selectedPaths.length === 0) return;

    // If we have exactly 2 paths that intersect, do immediate subtract
    if (selectedPaths.length === 2 && canBooleanOp(selectedPaths, "subtract")) {
      const resultPaths = booleanOperation(selectedPaths[0], selectedPaths[1], "subtract", () => store.getNextPathName());
      if (resultPaths.length > 0) {
        executeCommand({ type: "booleanOp", originalPaths: selectedPaths, resultPaths, operation: "subtract" });
        return;
      }
    }

    // Otherwise, enter drawing mode to draw a new path to subtract
    store._startPendingBooleanOp("subtract");
  },

  excludePaths: () => {
    const selectedPaths = store.getSelectedPaths();
    if (selectedPaths.length === 0) return;

    // If we have exactly 2 paths that intersect, do immediate exclude
    if (selectedPaths.length === 2 && canBooleanOp(selectedPaths, "exclude")) {
      const resultPaths = booleanOperation(selectedPaths[0], selectedPaths[1], "exclude", () => store.getNextPathName());
      if (resultPaths.length > 0) {
        // Batch the boolean op with snap connections for proper undo/redo
        const commands: Command[] = [
          { type: "booleanOp", originalPaths: selectedPaths, resultPaths, operation: "exclude" },
        ];

        // For exclude (XOR), find coincident points across result paths and create snap connections
        const snapCommands = store._createCoincidentSnapCommands(resultPaths);
        commands.push(...snapCommands);

        executeCommand({ type: "batch", commands });
        return;
      }
    }

    // Otherwise, enter drawing mode to draw a new path to exclude
    store._startPendingBooleanOp("exclude");
  },

  // Group helpers
  getDescendantPathIds: (groupId: string): string[] => {
    const result: string[] = [];
    // Get direct child paths
    for (const path of state.paths) {
      if (path.parentId === groupId) {
        result.push(path.id);
      }
    }
    // Get paths from child groups recursively
    for (const group of state.groups) {
      if (group.parentId === groupId) {
        result.push(...store.getDescendantPathIds(group.id));
      }
    }
    return result;
  },

  getDescendantGroupIds: (groupId: string): string[] => {
    const result: string[] = [];
    for (const group of state.groups) {
      if (group.parentId === groupId) {
        result.push(group.id);
        result.push(...store.getDescendantGroupIds(group.id));
      }
    }
    return result;
  },

  getDirectChildPathIds: (groupId: string): string[] => {
    return state.paths.filter((p) => p.parentId === groupId).map((p) => p.id);
  },

  getDirectChildGroupIds: (groupId: string): string[] => {
    return state.groups.filter((g) => g.parentId === groupId).map((g) => g.id);
  },

  // Check if a path is effectively visible (just path's own state now - groups derive visibility)
  isPathEffectivelyVisible: (pathId: string): boolean => {
    const path = state.paths.find((p) => p.id === pathId);
    return path?.visible ?? false;
  },

  // Check if a path is effectively locked (just path's own state now - groups derive lock status)
  isPathEffectivelyLocked: (pathId: string): boolean => {
    const path = state.paths.find((p) => p.id === pathId);
    return path?.locked ?? false;
  },

  // Derive group visibility from descendants (true if ANY descendant is visible)
  isGroupVisible: (groupId: string): boolean => {
    const descendantPathIds = store.getDescendantPathIds(groupId);
    if (descendantPathIds.length === 0) return true; // Empty group is visible
    return descendantPathIds.some((id) => {
      const path = state.paths.find((p) => p.id === id);
      return path?.visible ?? false;
    });
  },

  // Derive group lock status from descendants (true if ALL descendants are locked)
  isGroupLocked: (groupId: string): boolean => {
    const descendantPathIds = store.getDescendantPathIds(groupId);
    if (descendantPathIds.length === 0) return false; // Empty group is unlocked
    return descendantPathIds.every((id) => {
      const path = state.paths.find((p) => p.id === id);
      return path?.locked ?? false;
    });
  },

  // Group management actions
  getNextGroupName: (): string => {
    const name = `Group ${state.groupCounter}`;
    state = { ...state, groupCounter: state.groupCounter + 1 };
    notify();
    return name;
  },

  createGroup: (parentId: string | null = null) => {
    const group: Group = {
      id: crypto.randomUUID(),
      name: store.getNextGroupName(),
      parentId,
      collapsed: false,
    };
    executeCommand({ type: "addGroup", group });
    return group.id;
  },

  // Get the ancestor chain for an item (path or group), from immediate parent to root
  getAncestorChain: (parentId: string | null): string[] => {
    const chain: string[] = [];
    let current = parentId;
    while (current) {
      chain.push(current);
      const group = state.groups.find((g) => g.id === current);
      current = group?.parentId ?? null;
    }
    return chain;
  },

  // Find the lowest common ancestor of multiple parent chains
  findLowestCommonAncestor: (parentIds: (string | null)[]): string | null => {
    if (parentIds.length === 0) return null;

    // Get ancestor chains for all items
    const chains = parentIds.map((pid) => store.getAncestorChain(pid));

    // If any item is at root level, LCA is root
    if (chains.some((chain) => chain.length === 0)) {
      return null;
    }

    // Find common ancestors by checking each ancestor in the first chain
    const firstChain = chains[0];
    for (const ancestorId of firstChain) {
      // Check if this ancestor appears in all other chains
      const isCommon = chains.every((chain) => chain.includes(ancestorId));
      if (isCommon) {
        return ancestorId;
      }
    }

    return null;
  },

  groupSelection: () => {
    const { selection } = state;
    if (selection.pathIds.length === 0) return;

    const selectedPaths = selection.pathIds.map((id) => state.paths.find((p) => p.id === id)).filter((p): p is Path => p !== undefined);
    if (selectedPaths.length === 0) return;

    // Find the lowest common ancestor of all selected paths
    const parentIds = selectedPaths.map((p) => p.parentId);
    const commonAncestor = store.findLowestCommonAncestor(parentIds);

    // Create the group at the common ancestor level
    const group: Group = {
      id: crypto.randomUUID(),
      name: store.getNextGroupName(),
      parentId: commonAncestor,
      collapsed: false,
    };

    const commands: Command[] = [{ type: "addGroup", group }];

    // Find which items to move into the new group:
    // - For paths whose parent IS the common ancestor (or null if commonAncestor is null), move the path directly
    // - For paths whose parent is a descendant of the common ancestor, move their closest ancestor that's a direct child of commonAncestor
    const itemsToMove = new Set<string>(); // Track what we're moving to avoid duplicates
    const movedGroups = new Set<string>(); // Track groups we're moving

    for (const path of selectedPaths) {
      if (path.parentId === commonAncestor) {
        // Path is direct child of common ancestor, move the path itself
        if (!itemsToMove.has(`path:${path.id}`)) {
          itemsToMove.add(`path:${path.id}`);
          commands.push({
            type: "moveToGroup",
            itemId: path.id,
            itemType: "path",
            prevParentId: path.parentId,
            newParentId: group.id,
          });
        }
      } else {
        // Path is deeper - find the ancestor group that's a direct child of commonAncestor
        const ancestorChain = store.getAncestorChain(path.parentId);
        // ancestorChain goes from immediate parent toward root
        // We want the one whose parent is commonAncestor
        let groupToMove: string | null = null;
        for (const ancestorId of ancestorChain) {
          const ancestorGroup = state.groups.find((g) => g.id === ancestorId);
          if (ancestorGroup?.parentId === commonAncestor) {
            groupToMove = ancestorId;
            break;
          }
        }

        if (groupToMove && !movedGroups.has(groupToMove)) {
          movedGroups.add(groupToMove);
          itemsToMove.add(`group:${groupToMove}`);
          const grp = state.groups.find((g) => g.id === groupToMove);
          if (grp) {
            commands.push({
              type: "moveToGroup",
              itemId: groupToMove,
              itemType: "group",
              prevParentId: grp.parentId,
              newParentId: group.id,
            });
          }
        }
      }
    }

    executeCommand({ type: "batch", commands });
  },

  deleteGroup: (groupId: string) => {
    const group = state.groups.find((g) => g.id === groupId);
    if (!group) return;

    const childPathIds = store.getDirectChildPathIds(groupId);
    const childGroupIds = store.getDirectChildGroupIds(groupId);

    executeCommand({
      type: "deleteGroup",
      group,
      childPathIds,
      childGroupIds,
    });
  },

  ungroupSelection: () => {
    const { selection } = state;
    if (selection.pathIds.length === 0) return;

    // Find all unique parent groups of selected paths
    const parentGroupIds = new Set<string>();
    for (const pathId of selection.pathIds) {
      const path = state.paths.find((p) => p.id === pathId);
      if (path?.parentId) {
        parentGroupIds.add(path.parentId);
      }
    }

    if (parentGroupIds.size === 0) return;

    // Delete each parent group (this moves children to grandparent)
    const commands: Command[] = [];
    for (const groupId of parentGroupIds) {
      const group = state.groups.find((g) => g.id === groupId);
      if (group) {
        const childPathIds = store.getDirectChildPathIds(groupId);
        const childGroupIds = store.getDirectChildGroupIds(groupId);
        commands.push({
          type: "deleteGroup",
          group,
          childPathIds,
          childGroupIds,
        });
      }
    }

    if (commands.length === 0) return;
    const cmd: Command = commands.length === 1 ? commands[0] : { type: "batch", commands };
    executeCommand(cmd);
  },

  setGroupVisible: (groupId: string, visible: boolean) => {
    const group = state.groups.find((g) => g.id === groupId);
    if (!group) return;

    // Only affect descendant paths (groups don't have their own visibility)
    const commands: Command[] = [];
    const descendantPathIds = store.getDescendantPathIds(groupId);
    for (const pathId of descendantPathIds) {
      const path = state.paths.find((p) => p.id === pathId);
      if (path && path.visible !== visible) {
        commands.push({ type: "setPathVisible", id: pathId, visible });
      }
    }

    if (commands.length === 0) return;
    const cmd: Command = commands.length === 1 ? commands[0] : { type: "batch", commands };
    executeCommand(cmd);
  },

  setGroupLocked: (groupId: string, locked: boolean) => {
    const group = state.groups.find((g) => g.id === groupId);
    if (!group) return;

    // Only affect descendant paths (groups don't have their own lock state)
    const commands: Command[] = [];
    const descendantPathIds = store.getDescendantPathIds(groupId);
    for (const pathId of descendantPathIds) {
      const path = state.paths.find((p) => p.id === pathId);
      if (path && path.locked !== locked) {
        commands.push({ type: "setPathLocked", id: pathId, locked });
      }
    }

    if (commands.length === 0) return;
    const cmd: Command = commands.length === 1 ? commands[0] : { type: "batch", commands };
    executeCommand(cmd);
  },

  setGroupName: (groupId: string, name: string) => {
    const group = state.groups.find((g) => g.id === groupId);
    if (!group || group.name === name) return;
    executeCommand({ type: "setGroupName", id: groupId, prevName: group.name, newName: name });
  },

  setGroupCollapsed: (groupId: string, collapsed: boolean) => {
    const group = state.groups.find((g) => g.id === groupId);
    if (!group || group.collapsed === collapsed) return;
    executeCommand({ type: "setGroupCollapsed", id: groupId, collapsed });
  },

  selectGroup: (groupId: string) => {
    // Select all descendant paths
    const pathIds = store.getDescendantPathIds(groupId);
    state = { ...state, selection: { pathIds, points: [] } };
    notify();
  },

  toggleGroupInSelection: (groupId: string) => {
    // Toggle all descendant paths in selection
    const pathIds = store.getDescendantPathIds(groupId);
    const currentSelected = state.selection.pathIds;

    // Check if all descendants are currently selected
    const allSelected = pathIds.every((id) => currentSelected.includes(id));

    let newPathIds: string[];
    if (allSelected) {
      // Remove all descendants from selection
      newPathIds = currentSelected.filter((id) => !pathIds.includes(id));
    } else {
      // Add all descendants to selection
      newPathIds = [...new Set([...currentSelected, ...pathIds])];
    }

    state = { ...state, selection: { pathIds: newPathIds, points: [] } };
    notify();
  },

  // =========================================================================
  // Snap Connection Management
  // =========================================================================

  // Check if two point references are equal
  pointRefsEqual: (a: PointReference, b: PointReference): boolean => {
    return a.pathId === b.pathId && a.segmentIndex === b.segmentIndex && a.handleType === b.handleType;
  },

  // Get the position of a point reference
  getPointRefPosition: (ref: PointReference): Point | null => {
    const path = state.paths.find((p) => p.id === ref.pathId);
    if (!path || ref.segmentIndex < 0 || ref.segmentIndex >= path.segments.length) return null;
    const seg = path.segments[ref.segmentIndex];
    if (ref.handleType === "anchor") return seg.p0;
    if (ref.handleType === "c0") return seg.c0;
    // c1 ref uses the segment index where c1 is stored (same convention as Canvas.tsx)
    if (ref.handleType === "c1") return seg.c1;
    return null;
  },

  // Get control point references for an anchor
  // c0 (right/outgoing) is at segments[anchorIndex].c0
  // c1 (left/incoming) is at segments[anchorIndex - 1].c1
  getAnchorControlRefs: (ref: PointReference): { c0: PointReference | null; c1: PointReference | null } | null => {
    if (ref.handleType !== "anchor") return null;
    const path = state.paths.find((p) => p.id === ref.pathId);
    if (!path) return null;

    // c0 is valid if this anchor has an outgoing segment
    const hasC0 = ref.segmentIndex < path.segments.length;
    // c1 is valid if this anchor has an incoming segment
    const c1SegIdx = ref.segmentIndex === 0
      ? (path.closed ? path.segments.length - 1 : -1)
      : ref.segmentIndex - 1;
    const hasC1 = c1SegIdx >= 0;

    return {
      c0: hasC0 ? { pathId: ref.pathId, segmentIndex: ref.segmentIndex, handleType: "c0" } : null,
      c1: hasC1 ? { pathId: ref.pathId, segmentIndex: c1SegIdx, handleType: "c1" } : null,
    };
  },

  // Find connection containing a point
  getConnectionForPoint: (point: PointReference): SnapConnection | null => {
    return state.snapConnections.find((conn) =>
      conn.points.some((p) => store.pointRefsEqual(p, point))
    ) || null;
  },

  // Get all points connected to a given point (excluding itself)
  getConnectedPoints: (point: PointReference): PointReference[] => {
    const conn = store.getConnectionForPoint(point);
    if (!conn) return [];
    return conn.points.filter((p) => !store.pointRefsEqual(p, point));
  },

  // Create a simple snap connection command (for internal batching - doesn't check for merging)
  _createSnapConnectionCommand: (points: PointReference[]): Command | null => {
    if (points.length < 2) return null;
    const connection: SnapConnection = {
      id: crypto.randomUUID(),
      points: [...points],
    };
    return { type: "addSnapConnection", connection };
  },

  // Create snap connection commands for coincident anchor points across multiple paths
  // Used by exclude (XOR) operation to snap overlapping points from different result paths
  _createCoincidentSnapCommands: (resultPaths: Path[]): Command[] => {
    if (resultPaths.length < 2) return [];

    const EPSILON = 0.001;
    const commands: Command[] = [];

    // Collect all anchor points from all result paths
    const allAnchors: { pathId: string; segmentIndex: number; x: number; y: number }[] = [];
    for (const path of resultPaths) {
      for (let i = 0; i < path.segments.length; i++) {
        const seg = path.segments[i];
        allAnchors.push({ pathId: path.id, segmentIndex: i, x: seg.p0.x, y: seg.p0.y });
      }
    }

    // Group coincident points (points at the same position)
    const coincidentGroups: PointReference[][] = [];
    const used = new Set<number>();

    for (let i = 0; i < allAnchors.length; i++) {
      if (used.has(i)) continue;
      const group: PointReference[] = [
        { pathId: allAnchors[i].pathId, segmentIndex: allAnchors[i].segmentIndex, handleType: "anchor" },
      ];
      used.add(i);

      for (let j = i + 1; j < allAnchors.length; j++) {
        if (used.has(j)) continue;
        // Only match points from DIFFERENT paths
        if (allAnchors[i].pathId === allAnchors[j].pathId) continue;

        const dx = allAnchors[i].x - allAnchors[j].x;
        const dy = allAnchors[i].y - allAnchors[j].y;
        if (Math.sqrt(dx * dx + dy * dy) < EPSILON) {
          group.push({ pathId: allAnchors[j].pathId, segmentIndex: allAnchors[j].segmentIndex, handleType: "anchor" });
          used.add(j);
        }
      }

      // Only create connections for groups with 2+ points
      if (group.length >= 2) {
        coincidentGroups.push(group);
      }
    }

    // Create snap connection commands for each group of coincident points
    for (const group of coincidentGroups) {
      const cmd = store._createSnapConnectionCommand(group);
      if (cmd) commands.push(cmd);
    }

    return commands;
  },

  // Create or merge a snap connection between points
  // When snapping anchors, also auto-snap any aligned control points
  createSnapConnection: (points: PointReference[]) => {
    if (points.length < 2) return;

    const EPSILON = 0.001;
    const commands: Command[] = [];

    // Check for auto-snap of control points when snapping anchors
    const anchorPoints = points.filter((p) => p.handleType === "anchor");
    const controlPointSnaps: PointReference[][] = [];

    // Helper to check control point alignment between two anchors and add snap if aligned
    const checkControlPointAlignment = (anchorA: PointReference, anchorB: PointReference) => {
      if (anchorA.pathId === anchorB.pathId) return; // Only cross-path

      const controlsA = store.getAnchorControlRefs(anchorA);
      const controlsB = store.getAnchorControlRefs(anchorB);
      if (!controlsA || !controlsB) return;

      // Build pairs of control points to check (only if both refs exist)
      const pairs: [PointReference, Point, PointReference, Point][] = [];

      // Helper to add a pair if both refs and positions exist
      const addPair = (refA: PointReference | null, refB: PointReference | null) => {
        if (!refA || !refB) return;
        const posA = store.getPointRefPosition(refA);
        const posB = store.getPointRefPosition(refB);
        if (posA && posB) {
          pairs.push([refA, posA, refB, posB]);
        }
      };

      addPair(controlsA.c0, controlsB.c0);
      addPair(controlsA.c0, controlsB.c1);
      addPair(controlsA.c1, controlsB.c0);
      addPair(controlsA.c1, controlsB.c1);

      for (const [ref1, pos1, ref2, pos2] of pairs) {
        const dx = pos1.x - pos2.x;
        const dy = pos1.y - pos2.y;
        if (Math.sqrt(dx * dx + dy * dy) < EPSILON) {
          // These control points are aligned - add to snap list
          let foundGroup = false;
          for (const snapGroup of controlPointSnaps) {
            const has1 = snapGroup.some((p) => store.pointRefsEqual(p, ref1));
            const has2 = snapGroup.some((p) => store.pointRefsEqual(p, ref2));
            if (has1 || has2) {
              if (!has1) snapGroup.push(ref1);
              if (!has2) snapGroup.push(ref2);
              foundGroup = true;
              break;
            }
          }
          if (!foundGroup) {
            controlPointSnaps.push([ref1, ref2]);
          }
        }
      }
    };

    // Helper to get all anchors already snapped to a given anchor (on different paths)
    const getAlreadySnappedAnchors = (anchorRef: PointReference): PointReference[] => {
      const conn = store.getConnectionForPoint(anchorRef);
      if (!conn) return [];
      return conn.points.filter(
        (p) => p.handleType === "anchor" && p.pathId !== anchorRef.pathId
      );
    };

    // Build the full set of anchors to check: the ones being snapped + any already snapped to them
    // This handles triplets: if A is being snapped to B, and B is already snapped to C, check A vs C too
    const allAnchorsInGroup = new Set<string>();
    const anchorRefKey = (ref: PointReference) => `${ref.pathId}:${ref.segmentIndex}`;

    // Add anchors being snapped
    for (const anchor of anchorPoints) {
      allAnchorsInGroup.add(anchorRefKey(anchor));
    }

    // Add anchors already snapped to any of the anchors being snapped
    for (const anchor of anchorPoints) {
      const alreadySnapped = getAlreadySnappedAnchors(anchor);
      for (const snapped of alreadySnapped) {
        allAnchorsInGroup.add(anchorRefKey(snapped));
      }
    }

    // Convert back to PointReference array for checking
    const allAnchorsToCheck: PointReference[] = [];
    for (const key of allAnchorsInGroup) {
      const [pathId, segIdxStr] = key.split(":");
      allAnchorsToCheck.push({ pathId, segmentIndex: parseInt(segIdxStr), handleType: "anchor" });
    }

    // Check control points for all pairs of anchors in the group
    for (let i = 0; i < allAnchorsToCheck.length; i++) {
      for (let j = i + 1; j < allAnchorsToCheck.length; j++) {
        checkControlPointAlignment(allAnchorsToCheck[i], allAnchorsToCheck[j]);
      }
    }

    // Helper to get neighbor anchor refs for an anchor
    const getNeighborAnchors = (anchorRef: PointReference): PointReference[] => {
      const path = state.paths.find((p) => p.id === anchorRef.pathId);
      if (!path) return [];
      const neighbors: PointReference[] = [];
      const numAnchors = path.closed ? path.segments.length : path.segments.length + 1;

      // Previous neighbor
      if (anchorRef.segmentIndex > 0) {
        neighbors.push({ pathId: anchorRef.pathId, segmentIndex: anchorRef.segmentIndex - 1, handleType: "anchor" });
      } else if (path.closed && numAnchors > 1) {
        // For closed paths, previous of index 0 wraps to last anchor
        neighbors.push({ pathId: anchorRef.pathId, segmentIndex: path.segments.length - 1, handleType: "anchor" });
      }

      // Next neighbor
      if (anchorRef.segmentIndex < numAnchors - 1) {
        neighbors.push({ pathId: anchorRef.pathId, segmentIndex: anchorRef.segmentIndex + 1, handleType: "anchor" });
      } else if (path.closed && numAnchors > 1) {
        // For closed paths, next of last anchor wraps to index 0
        neighbors.push({ pathId: anchorRef.pathId, segmentIndex: 0, handleType: "anchor" });
      }

      return neighbors;
    };

    // Helper to find what another anchor is snapped to (on a different path)
    const getSnappedAnchor = (anchorRef: PointReference): PointReference | null => {
      const conn = store.getConnectionForPoint(anchorRef);
      if (!conn) return null;
      // Find another anchor in the same connection on a different path
      for (const p of conn.points) {
        if (p.handleType === "anchor" && p.pathId !== anchorRef.pathId) {
          return p;
        }
      }
      return null;
    };

    // Check neighbors of all anchors being snapped
    // If a neighbor is already snapped to another anchor, check control point alignment
    const checkedNeighborPairs = new Set<string>();
    for (const anchor of anchorPoints) {
      const neighbors = getNeighborAnchors(anchor);
      for (const neighbor of neighbors) {
        const snappedTo = getSnappedAnchor(neighbor);
        if (snappedTo) {
          // Create a unique key for this pair to avoid duplicate checks
          const key1 = `${neighbor.pathId}:${neighbor.segmentIndex}:${snappedTo.pathId}:${snappedTo.segmentIndex}`;
          const key2 = `${snappedTo.pathId}:${snappedTo.segmentIndex}:${neighbor.pathId}:${neighbor.segmentIndex}`;
          if (!checkedNeighborPairs.has(key1) && !checkedNeighborPairs.has(key2)) {
            checkedNeighborPairs.add(key1);
            checkControlPointAlignment(neighbor, snappedTo);
          }
        }
      }
    }

    // Find existing connections for any of these points
    const existingConnections = new Set<string>();
    for (const point of points) {
      const conn = store.getConnectionForPoint(point);
      if (conn) existingConnections.add(conn.id);
    }

    if (existingConnections.size === 0) {
      // No existing connections - create new one
      const connection: SnapConnection = {
        id: crypto.randomUUID(),
        points: [...points],
      };
      commands.push({ type: "addSnapConnection", connection });
    } else if (existingConnections.size === 1) {
      // One existing connection - merge new points into it
      const connId = [...existingConnections][0];
      const conn = state.snapConnections.find((c) => c.id === connId)!;
      const newPoints = [...conn.points];
      for (const point of points) {
        if (!newPoints.some((p) => store.pointRefsEqual(p, point))) {
          newPoints.push(point);
        }
      }
      if (newPoints.length !== conn.points.length) {
        commands.push({
          type: "updateSnapConnection",
          prevConnection: conn,
          newConnection: { ...conn, points: newPoints },
        });
      }
    } else {
      // Multiple existing connections - merge them all
      const allPoints: PointReference[] = [];
      const connIds = [...existingConnections];
      for (const connId of connIds) {
        const conn = state.snapConnections.find((c) => c.id === connId)!;
        for (const p of conn.points) {
          if (!allPoints.some((existing) => store.pointRefsEqual(existing, p))) {
            allPoints.push(p);
          }
        }
      }
      // Add any new points not in existing connections
      for (const point of points) {
        if (!allPoints.some((p) => store.pointRefsEqual(p, point))) {
          allPoints.push(point);
        }
      }
      // Remove all old connections and create one new merged connection
      for (const connId of connIds) {
        const conn = state.snapConnections.find((c) => c.id === connId)!;
        commands.push({ type: "removeSnapConnection", connection: conn });
      }
      const newConnection: SnapConnection = {
        id: crypto.randomUUID(),
        points: allPoints,
      };
      commands.push({ type: "addSnapConnection", connection: newConnection });
    }

    // Add auto-snap commands for aligned control points
    for (const group of controlPointSnaps) {
      // Filter out control points that are already connected
      const unconnectedInGroup = group.filter((p) => !store.getConnectionForPoint(p));
      if (unconnectedInGroup.length >= 2) {
        const connection: SnapConnection = {
          id: crypto.randomUUID(),
          points: unconnectedInGroup,
        };
        commands.push({ type: "addSnapConnection", connection });
      }
    }

    // Execute all commands as a batch
    if (commands.length === 1) {
      executeCommand(commands[0]);
    } else if (commands.length > 1) {
      executeCommand({ type: "batch", commands });
    }
  },

  // Remove a point from its connection (unsnap single point)
  unsnapPoint: (point: PointReference) => {
    const conn = store.getConnectionForPoint(point);
    if (!conn) return;

    const remainingPoints = conn.points.filter((p) => !store.pointRefsEqual(p, point));

    if (remainingPoints.length <= 1) {
      // Connection would have 0 or 1 points - remove it entirely
      executeCommand({ type: "removeSnapConnection", connection: conn });
    } else {
      // Update connection without this point
      executeCommand({
        type: "updateSnapConnection",
        prevConnection: conn,
        newConnection: { ...conn, points: remainingPoints },
      });
    }
  },

  // Remove entire connection
  removeSnapConnection: (connectionId: string) => {
    const conn = state.snapConnections.find((c) => c.id === connectionId);
    if (!conn) return;
    executeCommand({ type: "removeSnapConnection", connection: conn });
  },

  // Clean up connections when a path is deleted
  cleanupConnectionsForPath: (pathId: string) => {
    const affectedConnections = state.snapConnections.filter((conn) =>
      conn.points.some((p) => p.pathId === pathId)
    );

    if (affectedConnections.length === 0) return;

    const commands: Command[] = [];
    for (const conn of affectedConnections) {
      const remainingPoints = conn.points.filter((p) => p.pathId !== pathId);
      if (remainingPoints.length <= 1) {
        commands.push({ type: "removeSnapConnection", connection: conn });
      } else {
        commands.push({
          type: "updateSnapConnection",
          prevConnection: conn,
          newConnection: { ...conn, points: remainingPoints },
        });
      }
    }

    if (commands.length === 1) {
      executeCommand(commands[0]);
    } else if (commands.length > 1) {
      executeCommand({ type: "batch", commands });
    }
  },

  // Update segment indices in connections when path structure changes
  updateConnectionIndices: (pathId: string, deletedIndex: number) => {
    const affectedConnections = state.snapConnections.filter((conn) =>
      conn.points.some((p) => p.pathId === pathId && p.segmentIndex >= deletedIndex)
    );

    if (affectedConnections.length === 0) return;

    const commands: Command[] = [];
    for (const conn of affectedConnections) {
      const newPoints = conn.points
        .filter((p) => !(p.pathId === pathId && p.segmentIndex === deletedIndex))
        .map((p) => {
          if (p.pathId === pathId && p.segmentIndex > deletedIndex) {
            return { ...p, segmentIndex: p.segmentIndex - 1 };
          }
          return p;
        });

      if (newPoints.length <= 1) {
        commands.push({ type: "removeSnapConnection", connection: conn });
      } else if (newPoints.length !== conn.points.length || newPoints.some((p, i) => p.segmentIndex !== conn.points[i].segmentIndex)) {
        commands.push({
          type: "updateSnapConnection",
          prevConnection: conn,
          newConnection: { ...conn, points: newPoints },
        });
      }
    }

    if (commands.length === 1) {
      executeCommand(commands[0]);
    } else if (commands.length > 1) {
      executeCommand({ type: "batch", commands });
    }
  },
};

export function useStore<T>(selector: (state: EditorState) => T): T {
  return useSyncExternalStore(
    store.subscribe,
    useCallback(() => selector(store.getState()), [selector]),
  );
}
