import { useCallback, useSyncExternalStore } from "react";
import { AnchorMeta, CubicSegment, defaultTransform, Group, lineSegment, Path, Point, PointReference, SnapConnection, Tool } from "../types.ts";
import { booleanOperation, canBooleanOp, uniteMultiplePaths } from "../pathBool.ts";
import { isSegmentStraight, makeStraightControlPoints, rotatePoint, scalePointAround, getPathTransformPoint, getSelectionTransformPoint } from "../geometry.ts";
import { applyCommand } from "./commands.ts";
import { generateId, setCurrentDocumentId } from "../storage.ts";
import {
  Command,
  EditorState,
  emptySelection,
  HandleType,
  HoveredEdge,
  HoveredPoint,
  InstanceProperties,
  PointSelection,
  SelectedKeyframe,
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

const loadShowTransformPoints = (): boolean => {
  try {
    const saved = localStorage.getItem("estme:showTransformPoints");
    return saved === "true";
  } catch {
    return false;
  }
};

const loadTool = (): Tool => {
  try {
    const saved = localStorage.getItem("estme:tool");
    if (saved === "select" || saved === "line" || saved === "blob") {
      return saved;
    }
  } catch {
    // Ignore
  }
  return "line";
};

const loadCurrentClipId = (): string | null => {
  try {
    return localStorage.getItem("estme:currentClipId");
  } catch {
    return null;
  }
};

// Default instance properties
const DEFAULT_INSTANCE_PROPERTIES: InstanceProperties = {
  opacity: 1,
  vertexColor: "#ffffff",
  accentColor: "#ff0303",
  minimapMask: false,
};

const loadInstanceProperties = (): InstanceProperties => {
  try {
    const saved = localStorage.getItem("estme:instanceProperties");
    if (saved) {
      const parsed = JSON.parse(saved);
      return {
        opacity: typeof parsed.opacity === "number" ? parsed.opacity : DEFAULT_INSTANCE_PROPERTIES.opacity,
        vertexColor: typeof parsed.vertexColor === "string" ? parsed.vertexColor : DEFAULT_INSTANCE_PROPERTIES.vertexColor,
        accentColor: typeof parsed.accentColor === "string" ? parsed.accentColor : DEFAULT_INSTANCE_PROPERTIES.accentColor,
        minimapMask: typeof parsed.minimapMask === "boolean" ? parsed.minimapMask : DEFAULT_INSTANCE_PROPERTIES.minimapMask,
      };
    }
  } catch {
    // Ignore
  }
  return DEFAULT_INSTANCE_PROPERTIES;
};

const saveInstanceProperties = (props: InstanceProperties) => {
  try {
    localStorage.setItem("estme:instanceProperties", JSON.stringify(props));
  } catch {
    // Ignore
  }
};

// Selection persistence - only persist pathIds (point selections are transient)
const loadSelection = (): Selection => {
  try {
    const saved = localStorage.getItem("estme:selection");
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed.pathIds)) {
        return { pathIds: parsed.pathIds, points: [] };
      }
    }
  } catch {
    // Ignore
  }
  return emptySelection;
};

const saveSelection = (selection: Selection) => {
  try {
    // Only save pathIds - point selections are too transient
    localStorage.setItem("estme:selection", JSON.stringify({ pathIds: selection.pathIds }));
  } catch {
    // Ignore
  }
};

// Check synchronously if we expect to load a document (either from autosave or saved doc)
// We can't check IndexedDB synchronously, but we can check if there's a current doc ID
// If there is, we'll show loading state until the async load completes
const willLoadDocument = (): boolean => {
  try {
    // If there's a current document ID, we'll try to load it
    const currentId = localStorage.getItem("estme-current-document-id");
    return currentId !== null;
  } catch {
    return false;
  }
};

const initialState: EditorState = {
  isLoadingDocument: willLoadDocument(),
  documentId: null,
  documentName: "untitled",
  isDirty: false,
  tool: loadTool(),
  paths: [],
  groups: [],
  currentPath: null,
  currentPathId: null,
  hoverPoint: null,
  hoveredEdge: null,
  hoveredPoint: null,
  hoveredPathId: null,
  selection: loadSelection(),
  fillColor: "#ffffff",
  fillOpacity: 1,
  blobRadius: 0.3,
  blobSimplify: 0.002,
  showAllPoints: loadShowAllPoints(),
  showAllControlPoints: loadShowAllControlPoints(),
  showTransformPoints: loadShowTransformPoints(),
  undoStack: [],
  redoStack: [],
  mousePosition: null,
  zoom: 1,
  clipboard: null,
  pathCounter: 1,
  groupCounter: 1,
  snapConnections: [],
  pendingBooleanOp: null,
  animationClips: [],
  currentClipId: loadCurrentClipId(),
  playbackTime: 0,
  isPlaying: false,
  selectedKeyframe: null,
  instanceProperties: loadInstanceProperties(),
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
    isDirty: true,
  };
  notify();
}

// Record a command for undo/redo WITHOUT applying it (state is already correct)
// Used when live editing has already modified state and we just need the undo entry
function recordCommand(cmd: Command) {
  state = {
    ...state,
    undoStack: [...state.undoStack, cmd],
    redoStack: [],
    isDirty: true,
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
    try {
      localStorage.setItem("estme:tool", tool);
    } catch {
      // Ignore localStorage errors
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
  toggleShowTransformPoints: () => {
    const newValue = !state.showTransformPoints;
    state = { ...state, showTransformPoints: newValue };
    try {
      localStorage.setItem("estme:showTransformPoints", String(newValue));
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
    saveSelection(emptySelection);
    notify();
  },
  setSelection: (selection: Selection) => {
    state = { ...state, selection };
    saveSelection(selection);
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
    const newSelection = { pathIds: newPathIds, points: newPoints };
    state = { ...state, selection: newSelection };
    saveSelection(newSelection);
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
    const newSelection = { pathIds: newPathIds, points: newPoints };
    state = { ...state, selection: newSelection };
    saveSelection(newSelection);
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
    const commands: Command[] = [];

    // Helper to collect snap connection cleanup commands for a path
    const getConnectionCleanupCommands = (pathId: string): Command[] => {
      const cmds: Command[] = [];
      const affectedConnections = state.snapConnections.filter((conn) =>
        conn.points.some((p) => p.pathId === pathId)
      );
      for (const conn of affectedConnections) {
        const remainingPoints = conn.points.filter((p) => p.pathId !== pathId);
        if (remainingPoints.length <= 1) {
          cmds.push({ type: "removeSnapConnection", connection: conn });
        } else {
          cmds.push({
            type: "updateSnapConnection",
            prevConnection: conn,
            newConnection: { ...conn, points: remainingPoints },
          });
        }
      }
      return cmds;
    };

    // Delete all fully selected paths (skip locked paths)
    for (const pathId of state.selection.pathIds) {
      const path = state.paths.find((p) => p.id === pathId);
      if (path && !path.locked) {
        // Add snap connection cleanup commands
        commands.push(...getConnectionCleanupCommands(pathId));
        // Add delete path command
        commands.push({ type: "deletePath", path });
      }
    }

    // Sort selected points by segment index descending so we delete higher indices first
    // This prevents index shifting from affecting subsequent deletions
    const sortedPoints = [...state.selection.points].sort((a, b) => {
      // Group by path first, then by segment index descending
      if (a.pathId !== b.pathId) return a.pathId.localeCompare(b.pathId);
      return b.segmentIndex - a.segmentIndex;
    });

    // Delete all selected points (skip locked paths)
    for (const point of sortedPoints) {
      const path = state.paths.find((p) => p.id === point.pathId);
      if (!path || path.locked) continue;

      const { segmentIndex, handleType, pathId } = point;

      if (handleType === "anchor") {
        // Delete anchor - need at least 4 segments to delete one (keeping 3)
        // Account for how many anchors we've already queued for deletion on this path
        const pendingDeletions = commands.filter(
          (c) => c.type === "deleteAnchor" && c.id === pathId
        ).length;
        if (path.segments.length - pendingDeletions <= 3) continue;

        // Update snap connection indices for anchors on this path
        store.updateConnectionIndices(pathId, segmentIndex);
        commands.push({
          type: "deleteAnchor",
          id: pathId,
          anchorIndex: segmentIndex,
          prevPath: path,
        });
      } else if (handleType === "c0") {
        // Delete c0 control point - collapse to anchor (same as toggle off)
        const anchorMeta = path.anchorMeta?.[segmentIndex];
        if (!anchorMeta || !anchorMeta.rightActive) continue; // Already inactive
        const seg = path.segments[segmentIndex];
        const newMeta = { ...anchorMeta, rightActive: false };
        commands.push({
          type: "toggleControl",
          id: pathId,
          anchorIndex: segmentIndex,
          handleType: "right",
          prevMeta: anchorMeta,
          newMeta,
          prevControlPos: seg.c0,
          newControlPos: seg.p0,
        });
      } else if (handleType === "c1") {
        // Delete c1 control point - collapse to anchor of next segment
        const nextIdx = path.closed
          ? (segmentIndex + 1) % path.segments.length
          : segmentIndex + 1;
        const anchorMeta = path.anchorMeta?.[nextIdx];
        if (!anchorMeta || !anchorMeta.leftActive) continue; // Already inactive
        const seg = path.segments[segmentIndex];
        const newMeta = { ...anchorMeta, leftActive: false };
        commands.push({
          type: "toggleControl",
          id: pathId,
          anchorIndex: nextIdx,
          handleType: "left",
          prevMeta: anchorMeta,
          newMeta,
          prevControlPos: seg.c1,
          newControlPos: seg.p1,
        });
      }
    }

    // Execute all commands as a single batch (or single command if only one)
    if (commands.length === 1) {
      executeCommand(commands[0]);
    } else if (commands.length > 1) {
      executeCommand({ type: "batch", commands });
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
    const newSelection = id === null ? emptySelection : { pathIds: [id], points: [] };
    state = { ...state, selection: newSelection };
    saveSelection(newSelection);
    notify();
  },
  selectPaths: (ids: string[]) => {
    // Select multiple paths (replace current selection)
    const newSelection = { pathIds: ids, points: [] };
    state = { ...state, selection: newSelection };
    saveSelection(newSelection);
    notify();
  },
  selectAll: () => {
    // Select all visible paths
    const visiblePathIds = state.paths.filter((p) => p.visible).map((p) => p.id);
    const newSelection = { pathIds: visiblePathIds, points: [] };
    state = { ...state, selection: newSelection };
    saveSelection(newSelection);
    notify();
  },
  selectPoint: (point: PointSelection | null) => {
    // For single point selection (replace current selection)
    const newSelection = point === null ? emptySelection : { pathIds: [], points: [point] };
    state = { ...state, selection: newSelection };
    saveSelection(newSelection); // Saves empty pathIds (point selections are transient)
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
        // If path is fully selected and not locked, translate all points uniformly (preserves straight lines)
        if (selection.pathIds.includes(p.id) && !p.locked) {
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
        // If path is fully selected and not locked, rotate all points
        if (selection.pathIds.includes(p.id) && !p.locked) {
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
      isDirty: true,
    };
    notify();
  },
  commitRotate: (id: string, angle: number, center: Point) => {
    const cmd: Command = { type: "rotatePath", id, angle, center };
    state = {
      ...state,
      undoStack: [...state.undoStack, cmd],
      redoStack: [],
      isDirty: true,
    };
    notify();
  },
  // Commit translation for entire selection as a batch
  commitTranslateSelection: (dx: number, dy: number) => {
    const { selection, paths } = state;
    const commands: Command[] = [];
    for (const pathId of selection.pathIds) {
      const path = paths.find((p) => p.id === pathId);
      if (path?.locked) continue; // Skip locked paths
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
      isDirty: true,
    };
    notify();
  },
  // Commit rotation for entire selection as a batch
  commitRotateSelection: (angle: number, center: Point) => {
    const { selection, paths } = state;
    const commands: Command[] = [];
    for (const pathId of selection.pathIds) {
      const path = paths.find((p) => p.id === pathId);
      if (path?.locked) continue; // Skip locked paths
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
      isDirty: true,
    };
    notify();
  },
  // Scale a single path around a center point (live, no undo)
  scalePathLive: (id: string, scale: number, center: Point, scaledPathIds?: Set<string>) => {
    // Track which paths we've scaled to avoid infinite loops
    const scaled = scaledPathIds || new Set<string>();
    if (scaled.has(id)) return;
    scaled.add(id);

    const path = state.paths.find((p) => p.id === id);
    if (!path) return;

    // First, collect the old positions of all anchors (for computing connected point deltas)
    const oldPositions: Point[] = path.segments.map((seg) => ({ ...seg.p0 }));

    // Scale the path
    state = {
      ...state,
      paths: state.paths.map((p) => {
        if (p.id !== id) return p;
        return {
          ...p,
          segments: p.segments.map((seg) => ({
            p0: scalePointAround(seg.p0, center, scale),
            c0: scalePointAround(seg.c0, center, scale),
            c1: scalePointAround(seg.c1, center, scale),
            p1: scalePointAround(seg.p1, center, scale),
          })),
        };
      }),
    };

    // Move connected points on OTHER paths
    for (let i = 0; i < path.segments.length; i++) {
      const connectedPoints = store.getConnectedPoints({ pathId: id, segmentIndex: i, handleType: "anchor" });
      for (const connPoint of connectedPoints) {
        if (connPoint.pathId !== id && !scaled.has(connPoint.pathId)) {
          // Get the old position of the connected point
          const connPath = state.paths.find((p) => p.id === connPoint.pathId);
          if (!connPath) continue;
          const connOldPos = connPath.segments[connPoint.segmentIndex]?.p0;
          if (!connOldPos) continue;

          // Scale around the same center and calculate delta
          const newPos = scalePointAround(connOldPos, center, scale);
          const dx = newPos.x - connOldPos.x;
          const dy = newPos.y - connOldPos.y;

          store._movePointInternal(connPoint.pathId, connPoint.segmentIndex, dx, dy);
        }
      }
    }

    if (!scaledPathIds) {
      throttledNotify();
    }
  },
  // Scale entire selection around a center point (live, no undo)
  scaleSelectionLive: (scale: number, center: Point) => {
    const { selection } = state;

    // Track all points being scaled
    const scaledPoints: { pathId: string; segmentIndex: number }[] = [];

    state = {
      ...state,
      paths: state.paths.map((p) => {
        // If path is fully selected and not locked, scale all points
        if (selection.pathIds.includes(p.id) && !p.locked) {
          // Track all anchors as scaled
          for (let i = 0; i < p.segments.length; i++) {
            scaledPoints.push({ pathId: p.id, segmentIndex: i });
          }
          return {
            ...p,
            segments: p.segments.map((seg) => ({
              p0: scalePointAround(seg.p0, center, scale),
              c0: scalePointAround(seg.c0, center, scale),
              c1: scalePointAround(seg.c1, center, scale),
              p1: scalePointAround(seg.p1, center, scale),
            })),
          };
        }
        return p;
      }),
    };

    // Move connected points that weren't already scaled
    const scaledSet = new Set(scaledPoints.map((p) => `${p.pathId}:${p.segmentIndex}`));
    for (const pt of scaledPoints) {
      const connectedPoints = store.getConnectedPoints({ pathId: pt.pathId, segmentIndex: pt.segmentIndex, handleType: "anchor" });
      for (const connPoint of connectedPoints) {
        const key = `${connPoint.pathId}:${connPoint.segmentIndex}`;
        if (!scaledSet.has(key)) {
          scaledSet.add(key);
          // Get the current position of the connected point and scale it
          const connPath = state.paths.find((p) => p.id === connPoint.pathId);
          if (!connPath) continue;
          const connOldPos = connPath.segments[connPoint.segmentIndex]?.p0;
          if (!connOldPos) continue;

          const newPos = scalePointAround(connOldPos, center, scale);
          const dx = newPos.x - connOldPos.x;
          const dy = newPos.y - connOldPos.y;

          store._movePointInternal(connPoint.pathId, connPoint.segmentIndex, dx, dy);
        }
      }
    }

    throttledNotify();
  },
  // Commit scale to undo stack
  commitScale: (id: string, scale: number, center: Point) => {
    const cmd: Command = { type: "scalePath", id, scale, center };
    state = {
      ...state,
      undoStack: [...state.undoStack, cmd],
      redoStack: [],
      isDirty: true,
    };
    notify();
  },
  // Commit scale for entire selection as a batch
  commitScaleSelection: (scale: number, center: Point) => {
    const { selection, paths } = state;
    const commands: Command[] = [];
    for (const pathId of selection.pathIds) {
      const path = paths.find((p) => p.id === pathId);
      if (path?.locked) continue; // Skip locked paths
      commands.push({ type: "scalePath", id: pathId, scale, center });
    }
    if (commands.length === 0) return;
    const cmd: Command = commands.length === 1 ? commands[0] : { type: "batch", commands };
    state = {
      ...state,
      undoStack: [...state.undoStack, cmd],
      redoStack: [],
      isDirty: true,
    };
    notify();
  },
  // Align selected paths horizontally (move all transform points to same X as selection center)
  alignHorizontally: () => {
    const { selection, paths } = state;
    if (selection.pathIds.length < 2) return;

    // Get the selection's transform point (target X coordinate)
    const selectionTP = getSelectionTransformPoint(paths, selection.pathIds);
    const targetX = selectionTP.x;

    // Calculate deltas for each path
    const commands: Command[] = [];
    for (const pathId of selection.pathIds) {
      const path = paths.find((p) => p.id === pathId);
      if (!path || path.locked) continue; // Skip locked paths
      const pathTP = getPathTransformPoint(path);
      const dx = targetX - pathTP.x;
      if (Math.abs(dx) > 0.0001) {
        // Apply translation immediately
        state = {
          ...state,
          paths: state.paths.map((p) =>
            p.id === pathId
              ? {
                  ...p,
                  segments: p.segments.map((seg) => ({
                    p0: { x: seg.p0.x + dx, y: seg.p0.y },
                    c0: { x: seg.c0.x + dx, y: seg.c0.y },
                    c1: { x: seg.c1.x + dx, y: seg.c1.y },
                    p1: { x: seg.p1.x + dx, y: seg.p1.y },
                  })),
                  transformPoint: p.transformPoint
                    ? { x: p.transformPoint.x + dx, y: p.transformPoint.y }
                    : null,
                }
              : p
          ),
        };
        commands.push({ type: "translatePath", id: pathId, dx, dy: 0 });
      }
    }

    if (commands.length === 0) return;
    const cmd: Command = commands.length === 1 ? commands[0] : { type: "batch", commands };
    state = {
      ...state,
      undoStack: [...state.undoStack, cmd],
      redoStack: [],
      isDirty: true,
    };
    notify();
  },
  // Align selected paths vertically (move all transform points to same Y as selection center)
  alignVertically: () => {
    const { selection, paths } = state;
    if (selection.pathIds.length < 2) return;

    // Get the selection's transform point (target Y coordinate)
    const selectionTP = getSelectionTransformPoint(paths, selection.pathIds);
    const targetY = selectionTP.y;

    // Calculate deltas for each path
    const commands: Command[] = [];
    for (const pathId of selection.pathIds) {
      const path = paths.find((p) => p.id === pathId);
      if (!path || path.locked) continue; // Skip locked paths
      const pathTP = getPathTransformPoint(path);
      const dy = targetY - pathTP.y;
      if (Math.abs(dy) > 0.0001) {
        // Apply translation immediately
        state = {
          ...state,
          paths: state.paths.map((p) =>
            p.id === pathId
              ? {
                  ...p,
                  segments: p.segments.map((seg) => ({
                    p0: { x: seg.p0.x, y: seg.p0.y + dy },
                    c0: { x: seg.c0.x, y: seg.c0.y + dy },
                    c1: { x: seg.c1.x, y: seg.c1.y + dy },
                    p1: { x: seg.p1.x, y: seg.p1.y + dy },
                  })),
                  transformPoint: p.transformPoint
                    ? { x: p.transformPoint.x, y: p.transformPoint.y + dy }
                    : null,
                }
              : p
          ),
        };
        commands.push({ type: "translatePath", id: pathId, dx: 0, dy });
      }
    }

    if (commands.length === 0) return;
    const cmd: Command = commands.length === 1 ? commands[0] : { type: "batch", commands };
    state = {
      ...state,
      undoStack: [...state.undoStack, cmd],
      redoStack: [],
      isDirty: true,
    };
    notify();
  },
  // Bake transform - apply animation transforms to geometry and reset them
  bakeTransform: (id: string) => {
    const path = state.paths.find((p) => p.id === id);
    if (!path) return;

    const { rot, scale } = path.transform;

    // Nothing to bake if rotation is 0 and scale is 1
    if (Math.abs(rot) < 0.0001 && Math.abs(scale - 1) < 0.0001) return;

    // Get the transform point (pivot) for the transformation
    const center = path.transformPoint || store.getPathCenter(id);
    if (!center) return;

    // Save the original path for undo
    const prevPath = JSON.parse(JSON.stringify(path)) as typeof path;

    // Apply the transform to all geometry points
    const newSegments = path.segments.map((seg) => {
      // First scale, then rotate around center
      const scaleAndRotate = (pt: Point): Point => {
        // Scale around center
        let x = center.x + (pt.x - center.x) * scale;
        let y = center.y + (pt.y - center.y) * scale;

        // Rotate around center
        if (rot !== 0) {
          const cos = Math.cos(rot);
          const sin = Math.sin(rot);
          const dx = x - center.x;
          const dy = y - center.y;
          x = center.x + dx * cos - dy * sin;
          y = center.y + dx * sin + dy * cos;
        }

        return { x, y };
      };

      return {
        p0: scaleAndRotate(seg.p0),
        c0: scaleAndRotate(seg.c0),
        c1: scaleAndRotate(seg.c1),
        p1: scaleAndRotate(seg.p1),
      };
    });

    // Update the path with new geometry and reset transform
    state = {
      ...state,
      paths: state.paths.map((p) => {
        if (p.id !== id) return p;
        return {
          ...p,
          segments: newSegments,
          transform: {
            ...p.transform,
            rot: 0,
            scale: 1,
          },
        };
      }),
    };

    // Add to undo stack
    const cmd: Command = { type: "bakeTransform", id, prevPath };
    state = {
      ...state,
      undoStack: [...state.undoStack, cmd],
      redoStack: [],
      isDirty: true,
    };

    notify();
  },
  // Get path center by ID (bounding box center)
  getPathCenter: (id: string): Point | null => {
    const path = state.paths.find((p) => p.id === id);
    if (!path || path.segments.length === 0) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const seg of path.segments) {
      for (const pt of [seg.p0, seg.c0, seg.c1, seg.p1]) {
        minX = Math.min(minX, pt.x);
        minY = Math.min(minY, pt.y);
        maxX = Math.max(maxX, pt.x);
        maxY = Math.max(maxY, pt.y);
      }
    }
    return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
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
        isDirty: true,
      };
    } else {
      state = {
        ...state,
        undoStack: [...state.undoStack, moveCmd],
        redoStack: [],
        isDirty: true,
      };
    }
    notify();
  },
  // Internal helper: move a single control handle without notify (for batch operations)
  // constrainToMagnitude: when true and mirrorAngle is enabled, only allow magnitude changes (radial movement)
  _moveHandleInternal: (id: string, segmentIndex: number, handleType: HandleType, dx: number, dy: number, constrainToMagnitude?: boolean) => {
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

        // If constrainToMagnitude is true and mirrorAngle is enabled, project dx/dy onto radial direction
        let effectiveDx = dx;
        let effectiveDy = dy;
        if (constrainToMagnitude && mirrorAngle) {
          // Get anchor position
          const anchor = anchorIndex < p.segments.length
            ? p.segments[anchorIndex].p0
            : p.segments[p.segments.length - 1].p1;
          // Get current handle position
          const seg = p.segments[segmentIndex];
          const handle = handleType === "c0" ? seg.c0 : seg.c1;
          // Calculate radial direction from anchor to handle
          const radialX = handle.x - anchor.x;
          const radialY = handle.y - anchor.y;
          const radialDist = Math.sqrt(radialX * radialX + radialY * radialY);
          if (radialDist > 0.001) {
            // Project movement onto radial direction
            const radialUnitX = radialX / radialDist;
            const radialUnitY = radialY / radialDist;
            const projection = dx * radialUnitX + dy * radialUnitY;
            effectiveDx = projection * radialUnitX;
            effectiveDy = projection * radialUnitY;
          }
        }

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
                return { ...seg, c0: { x: seg.c0.x + effectiveDx, y: seg.c0.y + effectiveDy } };
              } else if (handleType === "c1") {
                return { ...seg, c1: { x: seg.c1.x + effectiveDx, y: seg.c1.y + effectiveDy } };
              }
            }

            // Apply mirroring to the opposite handle if active and any mirroring is enabled
            if ((mirrorAngle || mirrorDistance) && mirroredActive && i === mirroredSegmentIndex && segmentIndex !== mirroredSegmentIndex) {
              const movedSeg = p.segments[segmentIndex];
              const movedHandle = handleType === "c0"
                ? { x: movedSeg.c0.x + effectiveDx, y: movedSeg.c0.y + effectiveDy }
                : { x: movedSeg.c1.x + effectiveDx, y: movedSeg.c1.y + effectiveDy };

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
  // constrainToMagnitude: when true and mirrorAngle is enabled, only allow magnitude changes (radial movement)
  moveHandleLive: (id: string, segmentIndex: number, handleType: HandleType, dx: number, dy: number, movedPoints?: Set<string>, constrainToMagnitude?: boolean) => {
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
    store._moveHandleInternal(id, segmentIndex, handleType, dx, dy, constrainToMagnitude);

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
        isDirty: true,
      };
    } else {
      state = {
        ...state,
        undoStack: [...state.undoStack, moveCmd],
        redoStack: [],
        isDirty: true,
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
  // selectedHandle: if provided, only adjust the other handle to match the selected one
  setMirrorAngle: (pathId: string, anchorIndex: number, enabled: boolean, selectedHandle?: "c0" | "c1") => {
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

      // If a specific handle is selected, adjust it to mirror the other one
      if (selectedHandle === "c0" && c1Active) {
        // c0 is selected - adjust c0 to mirror c1's angle (keep c0's distance)
        const vecX = prevC1.x - anchor.x;
        const vecY = prevC1.y - anchor.y;
        const dist = Math.sqrt(vecX * vecX + vecY * vecY);
        if (dist > 0.001) {
          // Keep c0's current distance, just adjust its angle to mirror c1
          const c0VecX = prevC0.x - anchor.x;
          const c0VecY = prevC0.y - anchor.y;
          const c0Dist = c0Active ? Math.sqrt(c0VecX * c0VecX + c0VecY * c0VecY) : dist;
          const useDist = c0Dist > 0.001 ? c0Dist : dist;
          newC0 = {
            x: anchor.x - (vecX / dist) * useDist,
            y: anchor.y - (vecY / dist) * useDist,
          };
          newMeta.rightActive = true;
        }
      } else if (selectedHandle === "c1" && c0Active) {
        // c1 is selected - adjust c1 to mirror c0's angle (keep c1's distance)
        const vecX = prevC0.x - anchor.x;
        const vecY = prevC0.y - anchor.y;
        const dist = Math.sqrt(vecX * vecX + vecY * vecY);
        if (dist > 0.001) {
          // Keep c1's current distance, just adjust its angle to mirror c0
          const c1VecX = prevC1.x - anchor.x;
          const c1VecY = prevC1.y - anchor.y;
          const c1Dist = c1Active ? Math.sqrt(c1VecX * c1VecX + c1VecY * c1VecY) : dist;
          const useDist = c1Dist > 0.001 ? c1Dist : dist;
          newC1 = {
            x: anchor.x - (vecX / dist) * useDist,
            y: anchor.y - (vecY / dist) * useDist,
          };
          newMeta.leftActive = true;
        }
      } else if (c0Active && !c1Active) {
        // No specific handle selected, c0 is active but c1 is not - mirror c0 to create c1
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
        // No specific handle selected, c1 is active but c0 is not - mirror c1 to create c0
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
      } else if (c0Active && c1Active && !selectedHandle) {
        // Both active, no specific handle selected - use average angle and adjust both
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
  // selectedHandle: if provided, only adjust the other handle to match the selected one's distance
  setMirrorDistance: (pathId: string, anchorIndex: number, enabled: boolean, selectedHandle?: "c0" | "c1") => {
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

      // If a specific handle is selected, adjust its distance to match the other one
      if (selectedHandle === "c0" && c1Active) {
        // c0 is selected - adjust c0's distance to match c1
        const c1VecX = prevC1.x - anchor.x;
        const c1VecY = prevC1.y - anchor.y;
        const c1Dist = Math.sqrt(c1VecX * c1VecX + c1VecY * c1VecY);
        if (c1Dist > 0.001) {
          const c0VecX = prevC0.x - anchor.x;
          const c0VecY = prevC0.y - anchor.y;
          const c0Dist = c0Active ? Math.sqrt(c0VecX * c0VecX + c0VecY * c0VecY) : 0;
          if (c0Dist > 0.001) {
            // Scale c0 to match c1's distance
            newC0 = {
              x: anchor.x + (c0VecX / c0Dist) * c1Dist,
              y: anchor.y + (c0VecY / c0Dist) * c1Dist,
            };
          } else {
            // c0 doesn't exist - create it opposite to c1
            newC0 = {
              x: anchor.x - c1VecX,
              y: anchor.y - c1VecY,
            };
            newMeta.rightActive = true;
            newMeta.mirrorAngle = true;
          }
        }
      } else if (selectedHandle === "c1" && c0Active) {
        // c1 is selected - adjust c1's distance to match c0
        const c0VecX = prevC0.x - anchor.x;
        const c0VecY = prevC0.y - anchor.y;
        const c0Dist = Math.sqrt(c0VecX * c0VecX + c0VecY * c0VecY);
        if (c0Dist > 0.001) {
          const c1VecX = prevC1.x - anchor.x;
          const c1VecY = prevC1.y - anchor.y;
          const c1Dist = c1Active ? Math.sqrt(c1VecX * c1VecX + c1VecY * c1VecY) : 0;
          if (c1Dist > 0.001) {
            // Scale c1 to match c0's distance
            newC1 = {
              x: anchor.x + (c1VecX / c1Dist) * c0Dist,
              y: anchor.y + (c1VecY / c1Dist) * c0Dist,
            };
          } else {
            // c1 doesn't exist - create it opposite to c0
            newC1 = {
              x: anchor.x - c0VecX,
              y: anchor.y - c0VecY,
            };
            newMeta.leftActive = true;
            newMeta.mirrorAngle = true;
          }
        }
      } else if (c0Active && !c1Active) {
        // No specific handle selected, c0 is active but c1 is not - create c1 at same distance
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
        // No specific handle selected, c1 is active but c0 is not - create c0 at same distance
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
      } else if (c0Active && c1Active && !selectedHandle) {
        // Both active, no specific handle selected - use average distance and adjust both
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
      isDirty: true,
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
      isDirty: true,
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
      isDirty: true,
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
  setPathPlayerMask: (pathId: string, playerMask: boolean) => {
    const path = state.paths.find((p) => p.id === pathId);
    if (!path || path.playerMask === playerMask) return;
    executeCommand({ type: "setPathPlayerMask", id: pathId, playerMask });
  },
  setPathName: (pathId: string, name: string) => {
    const path = state.paths.find((p) => p.id === pathId);
    if (!path || path.name === name) return;
    executeCommand({ type: "setPathName", id: pathId, prevName: path.name, newName: name });
  },
  // Set transform point for a path or group (with undo)
  setTransformPoint: (itemId: string, itemType: "path" | "group", point: Point | null) => {
    if (itemType === "path") {
      const path = state.paths.find((p) => p.id === itemId);
      if (!path) return;
      const prevPoint = path.transformPoint;
      if ((prevPoint === null && point === null) ||
          (prevPoint !== null && point !== null && prevPoint.x === point.x && prevPoint.y === point.y)) return;
      executeCommand({ type: "setTransformPoint", itemId, itemType, prevPoint, newPoint: point });
    } else {
      const group = state.groups.find((g) => g.id === itemId);
      if (!group) return;
      const prevPoint = group.transformPoint;
      if ((prevPoint === null && point === null) ||
          (prevPoint !== null && point !== null && prevPoint.x === point.x && prevPoint.y === point.y)) return;
      executeCommand({ type: "setTransformPoint", itemId, itemType, prevPoint, newPoint: point });
    }
  },
  // Set transform point live (no undo - for dragging)
  setTransformPointLive: (itemId: string, itemType: "path" | "group", point: Point) => {
    if (itemType === "path") {
      state = {
        ...state,
        paths: state.paths.map((p) =>
          p.id === itemId ? { ...p, transformPoint: point } : p
        ),
      };
    } else {
      state = {
        ...state,
        groups: state.groups.map((g) =>
          g.id === itemId ? { ...g, transformPoint: point } : g
        ),
      };
    }
    throttledNotify();
  },
  // Commit transform point change (for undo stack after drag)
  commitTransformPoint: (itemId: string, itemType: "path" | "group", prevPoint: Point | null, newPoint: Point | null) => {
    if ((prevPoint === null && newPoint === null) ||
        (prevPoint !== null && newPoint !== null && prevPoint.x === newPoint.x && prevPoint.y === newPoint.y)) return;
    const cmd: Command = { type: "setTransformPoint", itemId, itemType, prevPoint, newPoint };
    state = {
      ...state,
      undoStack: [...state.undoStack, cmd],
      redoStack: [],
      isDirty: true,
    };
    notify();
  },
  // Clear transform point (reset to dynamic center)
  clearTransformPoint: (itemId: string, itemType: "path" | "group") => {
    store.setTransformPoint(itemId, itemType, null);
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
      isDirty: true,
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
      // Sort by paths array order (not selection order) to preserve relative z-order
      const selectedSet = new Set(selection.pathIds);
      const sourcePaths = paths.filter((p) => selectedSet.has(p.id));

      const copiedPaths = sourcePaths.map((p) => ({
        ...p,
        id: crypto.randomUUID(), // New ID for paste
        segments: p.segments.map((seg) => ({ ...seg, p0: { ...seg.p0 }, c0: { ...seg.c0 }, c1: { ...seg.c1 }, p1: { ...seg.p1 } })),
        anchorMeta: p.anchorMeta.map((m) => ({ ...m })),
      }));

      if (copiedPaths.length > 0) {
        state = {
          ...state,
          clipboard: {
            type: "paths",
            paths: copiedPaths,
            sourceIds: sourcePaths.map((p) => p.id),
            sourceNames: sourcePaths.map((p) => p.name),
          },
        };
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
    const { clipboard, paths } = state;
    if (!clipboard) return;

    if (clipboard.type === "paths") {
      // Generate names with " 2", " 3" suffixes based on existing paths with same base name
      const getNextCopyName = (baseName: string): string => {
        // Strip existing " N" suffix to get the true base name
        const baseMatch = baseName.match(/^(.+?) (\d+)$/);
        const trueName = baseMatch ? baseMatch[1] : baseName;

        // Find all existing paths with this base name or base name + number
        const existingNumbers: number[] = [1]; // The original counts as "1"
        for (const p of paths) {
          if (p.name === trueName) {
            existingNumbers.push(1);
          } else {
            const match = p.name.match(/^(.+?) (\d+)$/);
            if (match && match[1] === trueName) {
              existingNumbers.push(parseInt(match[2], 10));
            }
          }
        }

        // Find the next available number
        const maxNum = Math.max(...existingNumbers);
        return `${trueName} ${maxNum + 1}`;
      };

      // Determine parent for pasted paths: use source path's parent if it still exists
      const getSourceParent = (index: number): string | null => {
        const sourceId = clipboard.sourceIds[index];
        const sourcePath = paths.find((p) => p.id === sourceId);
        if (sourcePath) {
          return sourcePath.parentId;
        }
        // Fallback: use the parentId from the copied path data
        return clipboard.paths[index].parentId;
      };

      // Create pasted paths with proper names and parent
      const pastedPaths = clipboard.paths.map((p, i) => ({
        ...p,
        id: crypto.randomUUID(),
        name: getNextCopyName(clipboard.sourceNames[i] || p.name),
        parentId: getSourceParent(i),
        segments: p.segments.map((seg) => ({
          p0: { ...seg.p0 },
          c0: { ...seg.c0 },
          c1: { ...seg.c1 },
          p1: { ...seg.p1 },
        })),
        anchorMeta: p.anchorMeta.map((m) => ({ ...m })),
      }));

      // Find the highest index among source paths that still exist
      // Higher index = rendered on top = appears above in hierarchy
      // Insert after the highest-indexed source path so pasted paths appear above
      let insertAfterIdx = -1;
      for (const sourceId of clipboard.sourceIds) {
        const idx = paths.findIndex((p) => p.id === sourceId);
        if (idx > insertAfterIdx) {
          insertAfterIdx = idx;
        }
      }

      // Insert position is right after the highest source path
      const insertPos = insertAfterIdx + 1;

      // Build the target path order: insert pasted paths at the calculated position
      const newPathIds = [
        ...paths.slice(0, insertPos).map((p) => p.id),
        ...pastedPaths.map((p) => p.id),
        ...paths.slice(insertPos).map((p) => p.id),
      ];

      // Create a single batch command: add paths + reorder (if needed)
      const addCommands: Command[] = pastedPaths.map((path) => ({ type: "addPath" as const, path }));
      // Need to reorder if inserting anywhere other than the end
      const needsReorder = insertPos < paths.length;

      if (needsReorder) {
        // After adding, paths will be at end. Calculate prevPathIds for reorder.
        const pathIdsAfterAdd = [...paths.map((p) => p.id), ...pastedPaths.map((p) => p.id)];
        addCommands.push({
          type: "reorderPaths",
          prevPathIds: pathIdsAfterAdd,
          newPathIds: newPathIds,
        });
      }

      const cmd: Command = addCommands.length === 1 ? addCommands[0] : { type: "batch", commands: addCommands };
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
      isDirty: true,
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
      isDirty: true,
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
      opacity: path.opacity,
      visible: path.visible,
      locked: path.locked,
      playerMask: path.playerMask,
      transform: { ...path.transform },
      transformPoint: null, // Reset for new path
    };

    const newPath2: Path = {
      id: crypto.randomUUID(),
      name: store.getNextPathName(),
      parentId: path.parentId, // Inherit parent from original path
      segments: segments2,
      anchorMeta: meta2,
      closed: true,
      fill: path.fill,
      opacity: path.opacity,
      visible: path.visible,
      locked: path.locked,
      playerMask: path.playerMask,
      transform: { ...path.transform },
      transformPoint: null, // Reset for new path
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
      transformPoint: null,
    };
    executeCommand({ type: "addGroup", group });
    return group.id;
  },

  // Get the ancestor chain for an item (path or group), from immediate parent to root
  // Returns Group objects (not just IDs) for use with animation transforms
  getAncestorChain: (parentId: string | null): Group[] => {
    const chain: Group[] = [];
    let current = parentId;
    while (current) {
      const group = state.groups.find((g) => g.id === current);
      if (group) {
        chain.push(group);
        current = group.parentId;
      } else {
        break;
      }
    }
    return chain;
  },

  // Find the lowest common ancestor of multiple parent chains
  findLowestCommonAncestor: (parentIds: (string | null)[]): string | null => {
    if (parentIds.length === 0) return null;

    // Get ancestor chains for all items (as Group objects)
    const chains = parentIds.map((pid) => store.getAncestorChain(pid));

    // If any item is at root level, LCA is root
    if (chains.some((chain) => chain.length === 0)) {
      return null;
    }

    // Find common ancestors by checking each ancestor in the first chain
    const firstChain = chains[0];
    for (const ancestor of firstChain) {
      // Check if this ancestor appears in all other chains
      const isCommon = chains.every((chain) => chain.some((g) => g.id === ancestor.id));
      if (isCommon) {
        return ancestor.id;
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
      transformPoint: null,
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
        for (const ancestor of ancestorChain) {
          if (ancestor.parentId === commonAncestor) {
            groupToMove = ancestor.id;
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
    const newSelection = { pathIds, points: [] };
    state = { ...state, selection: newSelection };
    saveSelection(newSelection);
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

    const newSelection = { pathIds: newPathIds, points: [] };
    state = { ...state, selection: newSelection };
    saveSelection(newSelection);
    notify();
  },

  // Reorder a path within the paths array (affects z-order)
  reorderPath: (pathId: string, newIndex: number) => {
    const prevIndex = state.paths.findIndex((p) => p.id === pathId);
    if (prevIndex === -1 || prevIndex === newIndex) return;
    // Clamp newIndex to valid range
    const clampedIndex = Math.max(0, Math.min(state.paths.length - 1, newIndex));
    if (prevIndex === clampedIndex) return;
    executeCommand({ type: "reorderItem", itemId: pathId, itemType: "path", prevIndex, newIndex: clampedIndex });
  },

  // Reorder a group within the groups array
  reorderGroup: (groupId: string, newIndex: number) => {
    const prevIndex = state.groups.findIndex((g) => g.id === groupId);
    if (prevIndex === -1 || prevIndex === newIndex) return;
    const clampedIndex = Math.max(0, Math.min(state.groups.length - 1, newIndex));
    if (prevIndex === clampedIndex) return;
    executeCommand({ type: "reorderItem", itemId: groupId, itemType: "group", prevIndex, newIndex: clampedIndex });
  },

  // Move item to a different parent group (or root if null)
  moveItemToGroup: (itemId: string, itemType: "path" | "group", newParentId: string | null) => {
    if (itemType === "path") {
      const path = state.paths.find((p) => p.id === itemId);
      if (!path || path.parentId === newParentId) return;
      executeCommand({ type: "moveToGroup", itemId, itemType: "path", prevParentId: path.parentId, newParentId });
    } else {
      const group = state.groups.find((g) => g.id === itemId);
      if (!group || group.parentId === newParentId) return;
      // Prevent moving a group into itself or its descendants
      if (newParentId) {
        const ancestors = store.getAncestorChain(newParentId);
        if (ancestors.some((a) => a.id === itemId) || newParentId === itemId) return;
      }
      executeCommand({ type: "moveToGroup", itemId, itemType: "group", prevParentId: group.parentId, newParentId });
    }
  },

  // Reposition paths to be before or after a target path in the array
  // When moving a group, moves all its descendant paths together
  repositionItem: (
    itemId: string,
    itemType: "path" | "group",
    targetId: string,
    targetType: "path" | "group",
    position: "before" | "after"
  ) => {
    // Get the path IDs that need to be moved (preserving their relative order)
    let pathIdsToMove: string[];
    if (itemType === "path") {
      pathIdsToMove = [itemId];
    } else {
      // Get all descendant paths of the group, in their current array order
      const descendantIds = new Set(store.getDescendantPathIds(itemId));
      pathIdsToMove = state.paths.filter((p) => descendantIds.has(p.id)).map((p) => p.id);
    }

    if (pathIdsToMove.length === 0) return;

    // Find the target index in the paths array
    let targetIndex: number;
    if (targetType === "path") {
      targetIndex = state.paths.findIndex((p) => p.id === targetId);
    } else {
      // For a group target, find the first or last path in the group
      const groupPathIds = new Set(store.getDescendantPathIds(targetId));
      if (groupPathIds.size === 0) return; // Empty group, can't position relative to it

      if (position === "before") {
        // Find the first path that belongs to this group
        targetIndex = state.paths.findIndex((p) => groupPathIds.has(p.id));
      } else {
        // Find the last path that belongs to this group
        for (let i = state.paths.length - 1; i >= 0; i--) {
          if (groupPathIds.has(state.paths[i].id)) {
            targetIndex = i;
            break;
          }
        }
        targetIndex = targetIndex!;
      }
    }

    if (targetIndex === -1) return;

    // Build the new paths array
    const movingSet = new Set(pathIdsToMove);
    const pathsWithoutMoving = state.paths.filter((p) => !movingSet.has(p.id));
    const movingPaths = state.paths.filter((p) => movingSet.has(p.id));

    // Find where to insert in the filtered array
    let insertIndex: number;
    if (targetType === "path") {
      insertIndex = pathsWithoutMoving.findIndex((p) => p.id === targetId);
      if (insertIndex === -1) {
        // Target was one of the moving paths, use original target index logic
        insertIndex = position === "before" ? targetIndex : targetIndex + 1;
        insertIndex = Math.min(insertIndex, pathsWithoutMoving.length);
      } else if (position === "after") {
        insertIndex++;
      }
    } else {
      // For group target, find position relative to group's paths in the filtered array
      const groupPathIds = new Set(store.getDescendantPathIds(targetId));
      if (position === "before") {
        insertIndex = pathsWithoutMoving.findIndex((p) => groupPathIds.has(p.id));
        if (insertIndex === -1) insertIndex = 0;
      } else {
        insertIndex = pathsWithoutMoving.length;
        for (let i = pathsWithoutMoving.length - 1; i >= 0; i--) {
          if (groupPathIds.has(pathsWithoutMoving[i].id)) {
            insertIndex = i + 1;
            break;
          }
        }
      }
    }

    // Create the new array
    const newPaths = [
      ...pathsWithoutMoving.slice(0, insertIndex),
      ...movingPaths,
      ...pathsWithoutMoving.slice(insertIndex),
    ];

    // Check if anything actually changed
    const changed = newPaths.some((p, i) => p.id !== state.paths[i].id);
    if (!changed) return;

    // Use the reorderPaths command for proper undo support
    executeCommand({
      type: "reorderPaths",
      prevPathIds: state.paths.map((p) => p.id),
      newPathIds: newPaths.map((p) => p.id),
    });
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

  // Animation actions
  addAnimationClip: (clip: AnimationClip) => {
    // Add empty keyframe at time 0 for all existing paths (user will tick properties they want)
    const clipWithDefaults: AnimationClip = {
      ...clip,
      parts: { ...clip.parts },
    };
    for (const path of state.paths) {
      // Create an empty unified keyframe at t=0 (no properties set)
      clipWithDefaults.parts[path.id] = [{ t: 0 }];
    }
    executeCommand({ type: "addAnimationClip", clip: clipWithDefaults });
    // Auto-select the new clip and select the first keyframe if there's a path
    const firstPath = state.paths[0];
    state = {
      ...state,
      currentClipId: clipWithDefaults.id,
      selectedKeyframe: firstPath ? { pathId: firstPath.id, time: 0 } : null,
    };
    notify();
  },

  deleteAnimationClip: (clipId: string) => {
    const clip = state.animationClips.find((c) => c.id === clipId);
    if (!clip) return;
    executeCommand({ type: "deleteAnimationClip", clip });
    // Deselect if we deleted the current clip
    if (state.currentClipId === clipId) {
      const newClipId = state.animationClips[0]?.id ?? null;
      state = { ...state, currentClipId: newClipId };
      try {
        if (newClipId) {
          localStorage.setItem("estme:currentClipId", newClipId);
        } else {
          localStorage.removeItem("estme:currentClipId");
        }
      } catch {
        // Ignore localStorage errors
      }
      notify();
    }
  },

  selectAnimationClip: (clipId: string | null) => {
    state = { ...state, currentClipId: clipId };
    try {
      if (clipId) {
        localStorage.setItem("estme:currentClipId", clipId);
      } else {
        localStorage.removeItem("estme:currentClipId");
      }
    } catch {
      // Ignore localStorage errors
    }
    notify();
  },

  updateAnimationClip: (clipId: string, updates: Partial<Omit<AnimationClip, "id">>) => {
    const clip = state.animationClips.find((c) => c.id === clipId);
    if (!clip) return;
    const newClip = { ...clip, ...updates };
    executeCommand({ type: "updateAnimationClip", prevClip: clip, newClip });
  },

  // Set a property value on a keyframe (creates keyframe if needed)
  setKeyframeProperty: (
    clipId: string,
    partId: string,
    property: AnimatableProperty,
    t: number,
    value: number,
  ) => {
    const clip = state.animationClips.find((c) => c.id === clipId);
    if (!clip) return;

    const prevAnimation = clip.parts[partId] ?? [];
    const newAnimation = setKeyframeProperty(prevAnimation, t, property, value);

    executeCommand({
      type: "setPartAnimation",
      clipId,
      partId,
      prevAnimation,
      newAnimation,
    });
  },

  // Set a property value on a keyframe LIVE (no undo entry - used during drag)
  setKeyframePropertyLive: (
    clipId: string,
    partId: string,
    property: AnimatableProperty,
    t: number,
    value: number,
  ) => {
    const clip = state.animationClips.find((c) => c.id === clipId);
    if (!clip) return;

    const prevAnimation = clip.parts[partId] ?? [];
    const newAnimation = setKeyframeProperty(prevAnimation, t, property, value);

    // Update state directly without adding to undo stack
    state = {
      ...state,
      animationClips: state.animationClips.map((c) =>
        c.id === clipId
          ? { ...c, parts: { ...c.parts, [partId]: newAnimation } }
          : c
      ),
    };
    throttledNotify();
  },

  // Commit a keyframe property change (adds undo entry after live editing)
  commitKeyframeProperty: (
    clipId: string,
    partId: string,
    prevAnimation: PartAnimation,
  ) => {
    const clip = state.animationClips.find((c) => c.id === clipId);
    if (!clip) return;

    const newAnimation = clip.parts[partId] ?? [];

    // Only add undo entry if something changed
    // Use recordCommand instead of executeCommand since state is already correct
    if (JSON.stringify(prevAnimation) !== JSON.stringify(newAnimation)) {
      recordCommand({
        type: "setPartAnimation",
        clipId,
        partId,
        prevAnimation,
        newAnimation,
      });
    }
  },

  // Unset a property on a keyframe (removes keyframe if no properties left)
  unsetKeyframeProperty: (
    clipId: string,
    partId: string,
    property: AnimatableProperty,
    t: number,
  ) => {
    const clip = state.animationClips.find((c) => c.id === clipId);
    if (!clip) return;

    const partAnim = clip.parts[partId];
    if (!partAnim) return;

    const prevAnimation = partAnim;
    const newAnimation = unsetKeyframeProperty(prevAnimation, t, property);

    executeCommand({
      type: "setPartAnimation",
      clipId,
      partId,
      prevAnimation,
      newAnimation,
    });
  },

  // Create an empty keyframe (no properties set) at a specific time
  createEmptyKeyframe: (
    clipId: string,
    partId: string,
    t: number,
  ) => {
    const clip = state.animationClips.find((c) => c.id === clipId);
    if (!clip) return;

    const prevAnimation = clip.parts[partId] ?? [];

    // Check if keyframe already exists at this time
    const existingIndex = prevAnimation.findIndex((kf) => Math.abs(kf.t - t) < 0.0001);
    if (existingIndex >= 0) {
      // Keyframe already exists, nothing to do
      return;
    }

    // Find the most immediate (closest in time) existing keyframe to copy properties from
    let closestKeyframe: typeof prevAnimation[0] | null = null;
    let closestDistance = Infinity;
    for (const kf of prevAnimation) {
      const distance = Math.abs(kf.t - t);
      if (distance < closestDistance) {
        closestDistance = distance;
        closestKeyframe = kf;
      }
    }

    // Create new keyframe, copying properties from closest keyframe if one exists
    let newKeyframe: typeof prevAnimation[0] = { t };
    if (closestKeyframe) {
      // Copy all properties except 't' from the closest keyframe
      newKeyframe = { ...closestKeyframe, t };
    }

    const newAnimation = [...prevAnimation, newKeyframe];
    newAnimation.sort((a, b) => a.t - b.t);

    executeCommand({
      type: "setPartAnimation",
      clipId,
      partId,
      prevAnimation,
      newAnimation,
    });
  },

  // Delete an entire keyframe (all properties at that time)
  deleteKeyframe: (
    clipId: string,
    partId: string,
    t: number,
  ) => {
    const clip = state.animationClips.find((c) => c.id === clipId);
    if (!clip) return;

    const partAnim = clip.parts[partId];
    if (!partAnim) return;

    const prevAnimation = partAnim;
    const newAnimation = removeKeyframe(prevAnimation, t);

    executeCommand({
      type: "setPartAnimation",
      clipId,
      partId,
      prevAnimation,
      newAnimation,
    });
  },

  // Change the time of a keyframe
  changeKeyframeTime: (
    clipId: string,
    partId: string,
    oldTime: number,
    newTime: number,
  ) => {
    const clip = state.animationClips.find((c) => c.id === clipId);
    if (!clip) return;

    const partAnim = clip.parts[partId];
    if (!partAnim) return;

    const prevAnimation = partAnim;
    const newAnimation = changeKeyframeTime(prevAnimation, oldTime, newTime);

    executeCommand({
      type: "setPartAnimation",
      clipId,
      partId,
      prevAnimation,
      newAnimation,
    });

    // Update selected keyframe time if it was the one being moved
    if (state.selectedKeyframe &&
        state.selectedKeyframe.pathId === partId &&
        Math.abs(state.selectedKeyframe.time - oldTime) < 0.0001) {
      state = { ...state, selectedKeyframe: { pathId: partId, time: newTime } };
      notify();
    }
  },

  setPlaybackTime: (time: number) => {
    state = { ...state, playbackTime: time };
    notify();
  },

  setIsPlaying: (isPlaying: boolean) => {
    state = { ...state, isPlaying };
    notify();
  },

  togglePlayback: () => {
    state = { ...state, isPlaying: !state.isPlaying };
    notify();
  },

  // Transform-based path manipulation (for animation)
  // Updates animation keyframes if a clip is active for live visual feedback
  translatePathTransform: (id: string, dx: number, dy: number) => {
    const path = state.paths.find((p) => p.id === id);
    if (!path) return;

    // If we have an active animation clip, update keyframes directly for live feedback
    if (state.currentClipId) {
      const clip = state.animationClips.find((c) => c.id === state.currentClipId);
      if (clip) {
        const t = state.playbackTime;
        const prevAnimation = clip.parts[id] ?? [];

        // Get current tx/ty values at this time (interpolated or from keyframe)
        const currentTx = getPropertyValue(prevAnimation, "tx", t);
        const currentTy = getPropertyValue(prevAnimation, "ty", t);

        // Set new tx and ty on the keyframe at this time
        let newAnimation = setKeyframeProperty(prevAnimation, t, "tx", currentTx + dx);
        newAnimation = setKeyframeProperty(newAnimation, t, "ty", currentTy + dy);

        state = {
          ...state,
          animationClips: state.animationClips.map((c) =>
            c.id === state.currentClipId
              ? { ...c, parts: { ...c.parts, [id]: newAnimation } }
              : c
          ),
          selectedKeyframe: { pathId: id, time: t },
        };
        throttledNotify();
        return;
      }
    }

    // Fallback: update path transform directly (no animation clip active)
    const newTransform = {
      ...path.transform,
      tx: path.transform.tx + dx,
      ty: path.transform.ty + dy,
    };

    state = {
      ...state,
      paths: state.paths.map((p) =>
        p.id === id ? { ...p, transform: newTransform } : p
      ),
    };
    throttledNotify();
  },

  commitTranslateTransform: (id: string, prevAnimation: PartAnimation | null) => {
    // In animation mode, the keyframes have already been updated by live editing
    // We just need to record the undo entry
    if (state.currentClipId && prevAnimation !== null) {
      const clip = state.animationClips.find((c) => c.id === state.currentClipId);
      if (clip) {
        const newAnimation = clip.parts[id] ?? [];

        // Only record if something changed
        if (JSON.stringify(prevAnimation) !== JSON.stringify(newAnimation)) {
          recordCommand({
            type: "setPartAnimation",
            clipId: state.currentClipId,
            partId: id,
            prevAnimation,
            newAnimation,
          });
        }
      }
    }
  },

  rotatePathTransform: (id: string, angle: number) => {
    const path = state.paths.find((p) => p.id === id);
    if (!path) return;

    // If we have an active animation clip, update keyframes directly for live feedback
    if (state.currentClipId) {
      const clip = state.animationClips.find((c) => c.id === state.currentClipId);
      if (clip) {
        const t = state.playbackTime;
        const prevAnimation = clip.parts[id] ?? [];

        // Get current rotation value at this time (interpolated or from keyframe)
        const currentRot = getPropertyValue(prevAnimation, "rot", t);

        // Set new rotation on the keyframe at this time
        const newAnimation = setKeyframeProperty(prevAnimation, t, "rot", currentRot + angle);

        state = {
          ...state,
          animationClips: state.animationClips.map((c) =>
            c.id === state.currentClipId
              ? { ...c, parts: { ...c.parts, [id]: newAnimation } }
              : c
          ),
          selectedKeyframe: { pathId: id, time: t },
        };
        throttledNotify();
        return;
      }
    }

    // Fallback: update path transform directly (no animation clip active)
    const newTransform = {
      ...path.transform,
      rot: path.transform.rot + angle,
    };

    state = {
      ...state,
      paths: state.paths.map((p) =>
        p.id === id ? { ...p, transform: newTransform } : p
      ),
    };
    throttledNotify();
  },

  commitRotateTransform: (id: string, prevAnimation: PartAnimation | null) => {
    // In animation mode, the keyframes have already been updated by live editing
    // We just need to record the undo entry
    if (state.currentClipId && prevAnimation !== null) {
      const clip = state.animationClips.find((c) => c.id === state.currentClipId);
      if (clip) {
        const newAnimation = clip.parts[id] ?? [];

        // Only record if something changed
        if (JSON.stringify(prevAnimation) !== JSON.stringify(newAnimation)) {
          recordCommand({
            type: "setPartAnimation",
            clipId: state.currentClipId,
            partId: id,
            prevAnimation,
            newAnimation,
          });
        }
      }
    }
  },

  // Translate all selected paths in animation mode
  translateSelectionTransform: (dx: number, dy: number) => {
    if (!state.currentClipId) return;

    const clip = state.animationClips.find((c) => c.id === state.currentClipId);
    if (!clip) return;

    const t = state.playbackTime;
    const selectedPathIds = state.selection.pathIds;
    if (selectedPathIds.length === 0) return;

    // Update keyframes for all selected paths
    const newParts = { ...clip.parts };
    for (const pathId of selectedPathIds) {
      const path = state.paths.find((p) => p.id === pathId);
      if (!path) continue;

      const prevAnimation = newParts[pathId] ?? [];
      const currentTx = getPropertyValue(prevAnimation, "tx", t);
      const currentTy = getPropertyValue(prevAnimation, "ty", t);

      let newAnimation = setKeyframeProperty(prevAnimation, t, "tx", currentTx + dx);
      newAnimation = setKeyframeProperty(newAnimation, t, "ty", currentTy + dy);
      newParts[pathId] = newAnimation;
    }

    state = {
      ...state,
      animationClips: state.animationClips.map((c) =>
        c.id === state.currentClipId ? { ...c, parts: newParts } : c
      ),
      // Select keyframe of first path in selection
      selectedKeyframe: selectedPathIds.length > 0
        ? { pathId: selectedPathIds[0], time: t }
        : state.selectedKeyframe,
    };
    throttledNotify();
  },

  // Rotate all selected paths in animation mode
  rotateSelectionTransform: (angle: number) => {
    if (!state.currentClipId) return;

    const clip = state.animationClips.find((c) => c.id === state.currentClipId);
    if (!clip) return;

    const t = state.playbackTime;
    const selectedPathIds = state.selection.pathIds;
    if (selectedPathIds.length === 0) return;

    // Update keyframes for all selected paths
    const newParts = { ...clip.parts };
    for (const pathId of selectedPathIds) {
      const path = state.paths.find((p) => p.id === pathId);
      if (!path) continue;

      const prevAnimation = newParts[pathId] ?? [];
      const currentRot = getPropertyValue(prevAnimation, "rot", t);

      const newAnimation = setKeyframeProperty(prevAnimation, t, "rot", currentRot + angle);
      newParts[pathId] = newAnimation;
    }

    state = {
      ...state,
      animationClips: state.animationClips.map((c) =>
        c.id === state.currentClipId ? { ...c, parts: newParts } : c
      ),
      // Select keyframe of first path in selection
      selectedKeyframe: selectedPathIds.length > 0
        ? { pathId: selectedPathIds[0], time: t }
        : state.selectedKeyframe,
    };
    throttledNotify();
  },

  // Commit selection translation in animation mode (for undo)
  commitTranslateSelectionTransform: (prevAnimations: Map<string, PartAnimation>) => {
    if (!state.currentClipId) return;

    const clip = state.animationClips.find((c) => c.id === state.currentClipId);
    if (!clip) return;

    // Collect all commands for batch undo
    const commands: Command[] = [];
    for (const [pathId, prevAnimation] of prevAnimations) {
      const newAnimation = clip.parts[pathId] ?? [];

      if (JSON.stringify(prevAnimation) !== JSON.stringify(newAnimation)) {
        commands.push({
          type: "setPartAnimation",
          clipId: state.currentClipId,
          partId: pathId,
          prevAnimation,
          newAnimation,
        });
      }
    }

    // Record as a single batch command for atomic undo
    if (commands.length > 0) {
      const cmd: Command = commands.length === 1 ? commands[0] : { type: "batch", commands };
      recordCommand(cmd);
    }
  },

  // Commit selection rotation in animation mode (for undo)
  commitRotateSelectionTransform: (prevAnimations: Map<string, PartAnimation>) => {
    if (!state.currentClipId) return;

    const clip = state.animationClips.find((c) => c.id === state.currentClipId);
    if (!clip) return;

    // Collect all commands for batch undo
    const commands: Command[] = [];
    for (const [pathId, prevAnimation] of prevAnimations) {
      const newAnimation = clip.parts[pathId] ?? [];

      if (JSON.stringify(prevAnimation) !== JSON.stringify(newAnimation)) {
        commands.push({
          type: "setPartAnimation",
          clipId: state.currentClipId,
          partId: pathId,
          prevAnimation,
          newAnimation,
        });
      }
    }

    // Record as a single batch command for atomic undo
    if (commands.length > 0) {
      const cmd: Command = commands.length === 1 ? commands[0] : { type: "batch", commands };
      recordCommand(cmd);
    }
  },

  // Check if we should use transform-based or geometry-based movement
  hasActiveAnimationClip: (): boolean => {
    return state.currentClipId !== null;
  },

  // Keyframe selection
  selectKeyframe: (keyframe: SelectedKeyframe) => {
    state = { ...state, selectedKeyframe: keyframe };
    notify();
  },

  clearKeyframeSelection: () => {
    state = { ...state, selectedKeyframe: null };
    notify();
  },

  // Get the unified keyframe at the selected time
  getSelectedKeyframe: () => {
    if (!state.selectedKeyframe || !state.currentClipId) return null;
    const { pathId, time } = state.selectedKeyframe;
    const clip = state.animationClips.find((c) => c.id === state.currentClipId);
    if (!clip) return null;
    const partAnim = clip.parts[pathId];
    if (!partAnim) return null;
    return partAnim.find((kf) => Math.abs(kf.t - time) < 0.0001) ?? null;
  },

  // ============================================================================
  // Document save/load
  // ============================================================================

  // Get document data for saving
  getDocumentData: () => {
    return {
      version: 1,
      id: state.documentId,
      name: state.documentName,
      paths: state.paths,
      groups: state.groups,
      snapConnections: state.snapConnections,
      animationClips: state.animationClips,
      pathCounter: state.pathCounter,
      groupCounter: state.groupCounter,
    };
  },

  // Load document from saved data
  // If documentId is provided, use it (from IndexedDB open) - not dirty
  // If documentId is null, use ID from file data or generate new (from file load) - dirty (needs saving)
  // If documentId is undefined, preserve existing documentId (for autosave reload)
  loadDocument: (data: {
    version?: number;
    id?: string | null;
    name?: string;
    paths: Path[];
    groups: Group[];
    snapConnections?: SnapConnection[];
    animationClips?: AnimationClip[];
    pathCounter?: number;
    groupCounter?: number;
  }, documentId?: string | null) => {
    // undefined = preserve existing, null = use file's id or generate new, string = use provided
    const id = documentId === undefined
      ? state.documentId
      : (documentId ?? data.id ?? generateId());
    const isFromStorage = documentId != null && documentId !== undefined;
    // Migrate paths: ensure newer properties exist with defaults
    const migratedPaths = (data.paths || []).map((p) => ({
      ...p,
      playerMask: p.playerMask ?? false,
      visible: p.visible ?? true,
      locked: p.locked ?? false,
    }));
    // Load selection and filter to only include paths that exist in this document
    const pathIdSet = new Set(migratedPaths.map((p) => p.id));
    const groupIdSet = new Set((data.groups || []).map((g) => g.id));
    const savedSelection = loadSelection();
    const validSelection: Selection = {
      pathIds: savedSelection.pathIds.filter((id) => pathIdSet.has(id) || groupIdSet.has(id)),
      points: [],
    };
    state = {
      ...initialState,
      isLoadingDocument: false, // Done loading
      documentId: id,
      documentName: data.name || "untitled",
      isDirty: !isFromStorage, // Dirty if loaded from file (not yet in storage)
      paths: migratedPaths,
      groups: data.groups || [],
      snapConnections: data.snapConnections || [],
      animationClips: data.animationClips || [],
      pathCounter: data.pathCounter || (data.paths?.length || 0) + 1,
      groupCounter: data.groupCounter || (data.groups?.length || 0) + 1,
      // Preserve UI settings
      showAllPoints: state.showAllPoints,
      showAllControlPoints: state.showAllControlPoints,
      showTransformPoints: state.showTransformPoints,
      // Restore valid selection
      selection: validSelection,
    };
    if (id) setCurrentDocumentId(id);
    saveSelection(validSelection);
    notify();
  },

  // Set document ID (for IndexedDB storage)
  setDocumentId: (id: string | null) => {
    state = { ...state, documentId: id };
    setCurrentDocumentId(id);
    notify();
  },

  // Create a new empty document
  newDocument: () => {
    const newId = generateId();
    state = {
      ...initialState,
      isLoadingDocument: false, // Done loading
      documentId: newId,
      // Preserve UI settings
      showAllPoints: state.showAllPoints,
      showAllControlPoints: state.showAllControlPoints,
      showTransformPoints: state.showTransformPoints,
      // Clear selection for new document
      selection: emptySelection,
    };
    setCurrentDocumentId(newId);
    saveSelection(emptySelection);
    notify();
  },

  // Set document name (marks document as dirty)
  setDocumentName: (name: string) => {
    state = { ...state, documentName: name, isDirty: true };
    notify();
  },

  // Mark document as clean (no unsaved changes)
  markClean: () => {
    state = { ...state, isDirty: false };
    notify();
  },

  // Mark document as dirty (has unsaved changes)
  markDirty: () => {
    state = { ...state, isDirty: true };
    notify();
  },

  // Instance properties (not part of document, stored in localStorage)
  setInstanceOpacity: (opacity: number) => {
    const instanceProperties = { ...state.instanceProperties, opacity: Math.max(0, Math.min(1, opacity)) };
    state = { ...state, instanceProperties };
    saveInstanceProperties(instanceProperties);
    notify();
  },
  setInstanceVertexColor: (vertexColor: string) => {
    const instanceProperties = { ...state.instanceProperties, vertexColor };
    state = { ...state, instanceProperties };
    saveInstanceProperties(instanceProperties);
    notify();
  },
  setInstanceAccentColor: (accentColor: string) => {
    const instanceProperties = { ...state.instanceProperties, accentColor };
    state = { ...state, instanceProperties };
    saveInstanceProperties(instanceProperties);
    notify();
  },
  setInstanceMinimapMask: (minimapMask: boolean) => {
    const instanceProperties = { ...state.instanceProperties, minimapMask };
    state = { ...state, instanceProperties };
    saveInstanceProperties(instanceProperties);
    notify();
  },
};

// Import AnimationClip, AnimatableProperty, and keyframe utilities for use in store
import { AnimationClip, AnimatableProperty, PartAnimation, setKeyframeProperty, unsetKeyframeProperty, removeKeyframe, changeKeyframeTime, getOrCreateKeyframe, getPropertyValue } from "../animation.ts";

export function useStore<T>(selector: (state: EditorState) => T): T {
  return useSyncExternalStore(
    store.subscribe,
    useCallback(() => selector(store.getState()), [selector]),
  );
}
