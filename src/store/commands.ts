import { CubicSegment, Point, PointReference } from "../types.ts";
import {
  isSegmentStraight,
  lerpColor,
  makeStraightControlPoints,
  rotatePoint,
  scalePointAround,
  splitBezierAt,
} from "../geometry.ts";
import { Command, EditorState, emptySelection, HandleType } from "./types.ts";

// Helper to check if two point references are equal
function pointRefsEqual(a: PointReference, b: PointReference): boolean {
  return a.pathId === b.pathId && a.segmentIndex === b.segmentIndex && a.handleType === b.handleType;
}

// Get all points connected to a given point (excluding itself)
function getConnectedPoints(state: EditorState, point: PointReference): PointReference[] {
  for (const conn of state.snapConnections) {
    if (conn.points.some((p) => pointRefsEqual(p, point))) {
      return conn.points.filter((p) => !pointRefsEqual(p, point));
    }
  }
  return [];
}

// Internal helper: move a single control handle (returns new paths array)
function moveHandleInternal(paths: EditorState["paths"], id: string, segmentIndex: number, handleType: HandleType, dx: number, dy: number): EditorState["paths"] {
  return paths.map((p) => {
    if (p.id !== id) return p;
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
        return seg;
      }),
    };
  });
}

// Internal helper: move a single anchor point (returns new paths array)
function movePointInternal(paths: EditorState["paths"], id: string, pointIndex: number, dx: number, dy: number): EditorState["paths"] {
  return paths.map((p) => {
    if (p.id !== id) return p;

    const isFinalAnchorOfOpenPath = !p.closed && pointIndex === p.segments.length;
    const prevIdx = pointIndex === 0
      ? (p.closed ? p.segments.length - 1 : -1)
      : pointIndex - 1;

    const currentSeg = isFinalAnchorOfOpenPath ? null : p.segments[pointIndex];
    const prevSeg = prevIdx >= 0 ? p.segments[prevIdx] : null;
    const currentIsStraight = currentSeg ? isSegmentStraight(currentSeg) : false;
    const prevIsStraight = prevSeg ? isSegmentStraight(prevSeg) : false;

    return {
      ...p,
      segments: p.segments.map((seg, i) => {
        if (!isFinalAnchorOfOpenPath && i === pointIndex) {
          const newP0 = { x: seg.p0.x + dx, y: seg.p0.y + dy };
          if (currentIsStraight) {
            const straight = makeStraightControlPoints(newP0, seg.p1);
            return { ...seg, p0: newP0, c0: straight.c0, c1: straight.c1 };
          } else {
            return { ...seg, p0: newP0, c0: { x: seg.c0.x + dx, y: seg.c0.y + dy } };
          }
        }
        if (prevIdx >= 0 && i === prevIdx) {
          const newP1 = { x: seg.p1.x + dx, y: seg.p1.y + dy };
          if (prevIsStraight) {
            const straight = makeStraightControlPoints(seg.p0, newP1);
            return { ...seg, p1: newP1, c0: straight.c0, c1: straight.c1 };
          } else {
            return { ...seg, c1: { x: seg.c1.x + dx, y: seg.c1.y + dy }, p1: newP1 };
          }
        }
        return seg;
      }),
    };
  });
}

export function applyCommand(
  state: EditorState,
  cmd: Command,
  isUndo = false
): EditorState {
  switch (cmd.type) {
    case "addPath": {
      if (isUndo) {
        return {
          ...state,
          paths: state.paths.filter((p) => p.id !== cmd.path.id),
          selection: {
            pathIds: state.selection.pathIds.filter((id) => id !== cmd.path.id),
            points: state.selection.points.filter((pt) => pt.pathId !== cmd.path.id),
          },
        };
      } else {
        return {
          ...state,
          paths: [...state.paths, cmd.path],
          selection: { pathIds: [cmd.path.id], points: [] },
        };
      }
    }
    case "deletePath": {
      if (isUndo) {
        // Undo delete = re-add the path
        return {
          ...state,
          paths: [...state.paths, cmd.path],
          selection: { pathIds: [cmd.path.id], points: [] },
        };
      } else {
        // Delete the path
        return {
          ...state,
          paths: state.paths.filter((p) => p.id !== cmd.path.id),
          selection: {
            pathIds: state.selection.pathIds.filter((id) => id !== cmd.path.id),
            points: state.selection.points.filter((pt) => pt.pathId !== cmd.path.id),
          },
        };
      }
    }
    case "selectPath": {
      if (isUndo) {
        return { ...state, selection: cmd.prevId ? { pathIds: [cmd.prevId], points: [] } : emptySelection };
      } else {
        return { ...state, selection: cmd.newId ? { pathIds: [cmd.newId], points: [] } : emptySelection };
      }
    }
    case "translatePath": {
      const dx = isUndo ? -cmd.dx : cmd.dx;
      const dy = isUndo ? -cmd.dy : cmd.dy;

      const path = state.paths.find((p) => p.id === cmd.id);
      if (!path) return state;

      // First, translate the main path
      let newPaths = state.paths.map((p) => {
        if (p.id !== cmd.id) return p;
        return {
          ...p,
          segments: p.segments.map((seg) => ({
            p0: { x: seg.p0.x + dx, y: seg.p0.y + dy },
            c0: { x: seg.c0.x + dx, y: seg.c0.y + dy },
            c1: { x: seg.c1.x + dx, y: seg.c1.y + dy },
            p1: { x: seg.p1.x + dx, y: seg.p1.y + dy },
          })),
        };
      });

      // Then, move all connected points on OTHER paths
      const movedPoints = new Set<string>();
      for (let i = 0; i < path.segments.length; i++) {
        const connectedPoints = getConnectedPoints(state, { pathId: cmd.id, segmentIndex: i, handleType: "anchor" });
        for (const connPoint of connectedPoints) {
          if (connPoint.pathId !== cmd.id) {
            const key = `${connPoint.pathId}:${connPoint.segmentIndex}`;
            if (!movedPoints.has(key)) {
              movedPoints.add(key);
              newPaths = movePointInternal(newPaths, connPoint.pathId, connPoint.segmentIndex, dx, dy);
            }
          }
        }
      }

      return { ...state, paths: newPaths };
    }
    case "rotatePath": {
      const angle = isUndo ? -cmd.angle : cmd.angle;

      const path = state.paths.find((p) => p.id === cmd.id);
      if (!path) return state;

      // First, rotate the main path
      let newPaths = state.paths.map((p) => {
        if (p.id !== cmd.id) return p;
        return {
          ...p,
          segments: p.segments.map((seg) => ({
            p0: rotatePoint(seg.p0, cmd.center, angle),
            c0: rotatePoint(seg.c0, cmd.center, angle),
            c1: rotatePoint(seg.c1, cmd.center, angle),
            p1: rotatePoint(seg.p1, cmd.center, angle),
          })),
        };
      });

      // Then, rotate all connected points on OTHER paths around the same center
      const movedPoints = new Set<string>();
      for (let i = 0; i < path.segments.length; i++) {
        const connectedPoints = getConnectedPoints(state, { pathId: cmd.id, segmentIndex: i, handleType: "anchor" });
        for (const connPoint of connectedPoints) {
          if (connPoint.pathId !== cmd.id) {
            const key = `${connPoint.pathId}:${connPoint.segmentIndex}`;
            if (!movedPoints.has(key)) {
              movedPoints.add(key);
              // Get the current position and rotate it
              const connPath = newPaths.find((p) => p.id === connPoint.pathId);
              if (connPath && connPath.segments[connPoint.segmentIndex]) {
                const oldPos = connPath.segments[connPoint.segmentIndex].p0;
                const newPos = rotatePoint(oldPos, cmd.center, angle);
                const dx = newPos.x - oldPos.x;
                const dy = newPos.y - oldPos.y;
                newPaths = movePointInternal(newPaths, connPoint.pathId, connPoint.segmentIndex, dx, dy);
              }
            }
          }
        }
      }

      return { ...state, paths: newPaths };
    }
    case "scalePath": {
      // For undo, we need to scale by 1/scale
      const scale = isUndo ? 1 / cmd.scale : cmd.scale;

      const path = state.paths.find((p) => p.id === cmd.id);
      if (!path) return state;

      // First, scale the main path
      let newPaths = state.paths.map((p) => {
        if (p.id !== cmd.id) return p;
        return {
          ...p,
          segments: p.segments.map((seg) => ({
            p0: scalePointAround(seg.p0, cmd.center, scale),
            c0: scalePointAround(seg.c0, cmd.center, scale),
            c1: scalePointAround(seg.c1, cmd.center, scale),
            p1: scalePointAround(seg.p1, cmd.center, scale),
          })),
        };
      });

      // Then, scale all connected points on OTHER paths around the same center
      const movedPoints = new Set<string>();
      for (let i = 0; i < path.segments.length; i++) {
        const connectedPoints = getConnectedPoints(state, { pathId: cmd.id, segmentIndex: i, handleType: "anchor" });
        for (const connPoint of connectedPoints) {
          if (connPoint.pathId !== cmd.id) {
            const key = `${connPoint.pathId}:${connPoint.segmentIndex}`;
            if (!movedPoints.has(key)) {
              movedPoints.add(key);
              // Get the current position and scale it
              const connPath = newPaths.find((p) => p.id === connPoint.pathId);
              if (connPath && connPath.segments[connPoint.segmentIndex]) {
                const oldPos = connPath.segments[connPoint.segmentIndex].p0;
                const newPos = scalePointAround(oldPos, cmd.center, scale);
                const dx = newPos.x - oldPos.x;
                const dy = newPos.y - oldPos.y;
                newPaths = movePointInternal(newPaths, connPoint.pathId, connPoint.segmentIndex, dx, dy);
              }
            }
          }
        }
      }

      return { ...state, paths: newPaths };
    }
    case "movePoint": {
      const dx = isUndo ? -cmd.dx : cmd.dx;
      const dy = isUndo ? -cmd.dy : cmd.dy;

      // First, move the main point
      let newPaths = movePointInternal(state.paths, cmd.id, cmd.pointIndex, dx, dy);

      // Then, move all connected points
      const movedPoints = new Set<string>();
      movedPoints.add(`${cmd.id}:${cmd.pointIndex}`);

      const connectedPoints = getConnectedPoints(state, { pathId: cmd.id, segmentIndex: cmd.pointIndex, handleType: "anchor" });
      for (const connPoint of connectedPoints) {
        if (connPoint.handleType === "anchor") {
          const key = `${connPoint.pathId}:${connPoint.segmentIndex}`;
          if (!movedPoints.has(key)) {
            movedPoints.add(key);
            newPaths = movePointInternal(newPaths, connPoint.pathId, connPoint.segmentIndex, dx, dy);
          }
        }
      }

      return { ...state, paths: newPaths };
    }
    case "moveHandle": {
      const dx = isUndo ? -cmd.dx : cmd.dx;
      const dy = isUndo ? -cmd.dy : cmd.dy;

      // First, move the main handle
      let newPaths = moveHandleInternal(state.paths, cmd.id, cmd.segmentIndex, cmd.handleType, dx, dy);

      // Then, move all connected handles
      const movedHandles = new Set<string>();
      movedHandles.add(`${cmd.id}:${cmd.segmentIndex}:${cmd.handleType}`);

      const connectedPoints = getConnectedPoints(state, { pathId: cmd.id, segmentIndex: cmd.segmentIndex, handleType: cmd.handleType });
      for (const connPoint of connectedPoints) {
        if (connPoint.handleType === "c0" || connPoint.handleType === "c1") {
          const key = `${connPoint.pathId}:${connPoint.segmentIndex}:${connPoint.handleType}`;
          if (!movedHandles.has(key)) {
            movedHandles.add(key);
            newPaths = moveHandleInternal(newPaths, connPoint.pathId, connPoint.segmentIndex, connPoint.handleType, dx, dy);
          }
        }
      }

      return { ...state, paths: newPaths };
    }
    case "setAnchorMeta": {
      const meta = isUndo ? cmd.prevMeta : cmd.newMeta;
      return {
        ...state,
        paths: state.paths.map((p) => {
          if (p.id !== cmd.id) return p;
          return {
            ...p,
            anchorMeta: p.anchorMeta.map((m, i) =>
              i === cmd.anchorIndex ? meta : m
            ),
          };
        }),
      };
    }
    case "toggleControl": {
      const meta = isUndo ? cmd.prevMeta : cmd.newMeta;
      const controlPos = isUndo ? cmd.prevControlPos : cmd.newControlPos;
      return {
        ...state,
        paths: state.paths.map((p) => {
          if (p.id !== cmd.id) return p;
          // Update anchor meta
          const newAnchorMeta = p.anchorMeta.map((m, i) =>
            i === cmd.anchorIndex ? meta : m
          );
          // Update control point position
          let newSegments = p.segments;
          if (cmd.handleType === "left") {
            // c1 is on the previous segment
            const prevSegIdx = cmd.anchorIndex === 0 ? p.segments.length - 1 : cmd.anchorIndex - 1;
            newSegments = p.segments.map((seg, i) =>
              i === prevSegIdx ? { ...seg, c1: { ...controlPos } } : seg
            );
          } else {
            // c0 is on this segment
            newSegments = p.segments.map((seg, i) =>
              i === cmd.anchorIndex ? { ...seg, c0: { ...controlPos } } : seg
            );
          }
          return { ...p, anchorMeta: newAnchorMeta, segments: newSegments };
        }),
      };
    }
    case "setMirror": {
      const meta = isUndo ? cmd.prevMeta : cmd.newMeta;
      const c0 = isUndo ? cmd.prevC0 : cmd.newC0;
      const c1 = isUndo ? cmd.prevC1 : cmd.newC1;
      const path = state.paths.find((p) => p.id === cmd.id);
      if (!path) return state;
      const actualPrevSegIdx = cmd.anchorIndex === 0 ? path.segments.length - 1 : cmd.anchorIndex - 1;

      // Calculate deltas for c0 and c1
      const c0From = isUndo ? cmd.newC0 : cmd.prevC0;
      const c1From = isUndo ? cmd.newC1 : cmd.prevC1;
      const c0Dx = c0.x - c0From.x;
      const c0Dy = c0.y - c0From.y;
      const c1Dx = c1.x - c1From.x;
      const c1Dy = c1.y - c1From.y;

      // First, update the main path
      let newPaths = state.paths.map((p) => {
        if (p.id !== cmd.id) return p;
        return {
          ...p,
          anchorMeta: p.anchorMeta.map((m, i) => i === cmd.anchorIndex ? meta : m),
          segments: p.segments.map((seg, i) => {
            if (i === cmd.anchorIndex) return { ...seg, c0: { ...c0 } };
            if (i === actualPrevSegIdx) return { ...seg, c1: { ...c1 } };
            return seg;
          }),
        };
      });

      // Then, move all connected control points
      // For c0
      if (c0Dx !== 0 || c0Dy !== 0) {
        const movedHandles = new Set<string>();
        movedHandles.add(`${cmd.id}:${cmd.anchorIndex}:c0`);
        const connectedC0 = getConnectedPoints(state, { pathId: cmd.id, segmentIndex: cmd.anchorIndex, handleType: "c0" });
        for (const connPoint of connectedC0) {
          if (connPoint.handleType === "c0" || connPoint.handleType === "c1") {
            const key = `${connPoint.pathId}:${connPoint.segmentIndex}:${connPoint.handleType}`;
            if (!movedHandles.has(key)) {
              movedHandles.add(key);
              newPaths = moveHandleInternal(newPaths, connPoint.pathId, connPoint.segmentIndex, connPoint.handleType, c0Dx, c0Dy);
            }
          }
        }
      }

      // For c1
      if (c1Dx !== 0 || c1Dy !== 0) {
        const movedHandles = new Set<string>();
        movedHandles.add(`${cmd.id}:${actualPrevSegIdx}:c1`);
        const connectedC1 = getConnectedPoints(state, { pathId: cmd.id, segmentIndex: actualPrevSegIdx, handleType: "c1" });
        for (const connPoint of connectedC1) {
          if (connPoint.handleType === "c0" || connPoint.handleType === "c1") {
            const key = `${connPoint.pathId}:${connPoint.segmentIndex}:${connPoint.handleType}`;
            if (!movedHandles.has(key)) {
              movedHandles.add(key);
              newPaths = moveHandleInternal(newPaths, connPoint.pathId, connPoint.segmentIndex, connPoint.handleType, c1Dx, c1Dy);
            }
          }
        }
      }

      return { ...state, paths: newPaths };
    }
    case "deleteAnchor": {
      if (isUndo) {
        // Restore the previous path state
        return {
          ...state,
          paths: state.paths.map((p) =>
            p.id === cmd.id ? cmd.prevPath : p
          ),
          selection: { pathIds: state.selection.pathIds, points: [] },
        };
      } else {
        // Delete the anchor by merging segments
        return {
          ...state,
          paths: state.paths.map((p) => {
            if (p.id !== cmd.id) return p;

            // Can't delete if only 3 or fewer segments (need at least 3 for a valid closed path)
            if (p.segments.length <= 3) return p;

            const idx = cmd.anchorIndex;
            const prevIdx = idx === 0 ? p.segments.length - 1 : idx - 1;

            // Get the segments before and after the anchor
            const prevSeg = p.segments[prevIdx];
            const currSeg = p.segments[idx];

            // Check if both adjacent segments are straight
            const bothStraight = isSegmentStraight(prevSeg) && isSegmentStraight(currSeg);

            // Create merged segment: from prev's p0 to curr's p1
            let mergedSeg: CubicSegment;
            if (bothStraight) {
              // If both were straight, make the merged segment straight too
              const straight = makeStraightControlPoints(prevSeg.p0, currSeg.p1);
              mergedSeg = {
                p0: prevSeg.p0,
                c0: straight.c0,
                c1: straight.c1,
                p1: currSeg.p1,
              };
            } else {
              // Keep prev's c0 and curr's c1 for the curve shape
              mergedSeg = {
                p0: prevSeg.p0,
                c0: prevSeg.c0,
                c1: currSeg.c1,
                p1: currSeg.p1,
              };
            }

            // Build new segments array
            const newSegments = [];
            for (let i = 0; i < p.segments.length; i++) {
              if (i === prevIdx) {
                newSegments.push(mergedSeg);
              } else if (i !== idx) {
                newSegments.push(p.segments[i]);
              }
            }

            // Build new anchorMeta array (remove the deleted anchor's metadata)
            const newAnchorMeta = p.anchorMeta.filter((_, i) => i !== idx);

            return {
              ...p,
              segments: newSegments,
              anchorMeta: newAnchorMeta,
            };
          }),
          selection: { pathIds: state.selection.pathIds, points: [] },
        };
      }
    }
    case "setPathFill": {
      const fill = isUndo ? cmd.prevFill : cmd.newFill;
      return {
        ...state,
        paths: state.paths.map((p) =>
          p.id === cmd.id ? { ...p, fill } : p
        ),
      };
    }
    case "setPathOpacity": {
      const opacity = isUndo ? cmd.prevOpacity : cmd.newOpacity;
      return {
        ...state,
        paths: state.paths.map((p) =>
          p.id === cmd.id ? { ...p, opacity } : p
        ),
      };
    }
    case "setPathVisible": {
      const visible = isUndo ? !cmd.visible : cmd.visible;
      return {
        ...state,
        paths: state.paths.map((p) =>
          p.id === cmd.id ? { ...p, visible } : p
        ),
      };
    }
    case "setPathLocked": {
      const locked = isUndo ? !cmd.locked : cmd.locked;
      return {
        ...state,
        paths: state.paths.map((p) =>
          p.id === cmd.id ? { ...p, locked } : p
        ),
      };
    }
    case "setPathPlayerMask": {
      const playerMask = isUndo ? !cmd.playerMask : cmd.playerMask;
      return {
        ...state,
        paths: state.paths.map((p) =>
          p.id === cmd.id ? { ...p, playerMask } : p
        ),
      };
    }
    case "setPathName": {
      const name = isUndo ? cmd.prevName : cmd.newName;
      return {
        ...state,
        paths: state.paths.map((p) =>
          p.id === cmd.id ? { ...p, name } : p
        ),
      };
    }
    case "insertAnchor": {
      if (isUndo) {
        // Restore the previous path state
        return {
          ...state,
          paths: state.paths.map((p) =>
            p.id === cmd.id ? cmd.prevPath : p
          ),
          selection: { pathIds: state.selection.pathIds, points: [] },
        };
      } else {
        // Insert a new anchor by splitting a segment at parameter t
        return {
          ...state,
          paths: state.paths.map((p) => {
            if (p.id !== cmd.id) return p;

            const seg = p.segments[cmd.segmentIndex];
            const { first: seg1, second: seg2 } = splitBezierAt(seg, cmd.t);

            // Build new segments array
            const newSegments = [
              ...p.segments.slice(0, cmd.segmentIndex),
              seg1,
              seg2,
              ...p.segments.slice(cmd.segmentIndex + 1),
            ];

            // Interpolate vertex color based on position along segment
            const startAnchorIndex = cmd.segmentIndex;
            // For open paths, the last segment ends at the final anchor (index = segments.length)
            const endAnchorIndex = p.closed
              ? (cmd.segmentIndex + 1) % p.segments.length
              : cmd.segmentIndex + 1;
            const startColor = p.anchorMeta[startAnchorIndex]?.color || p.fill;
            const endColor = p.anchorMeta[endAnchorIndex]?.color || p.fill;
            const interpolatedColor = lerpColor(startColor, endColor, cmd.t);

            // Build new anchorMeta array (insert meta with interpolated color for the new anchor)
            const newAnchorMeta = [
              ...p.anchorMeta.slice(0, cmd.segmentIndex + 1),
              { leftActive: true, rightActive: true, mirrorAngle: false, mirrorDistance: false, color: interpolatedColor },
              ...p.anchorMeta.slice(cmd.segmentIndex + 1),
            ];

            return {
              ...p,
              segments: newSegments,
              anchorMeta: newAnchorMeta,
            };
          }),
          // Select the newly inserted anchor
          selection: {
            pathIds: [],
            points: [{
              pathId: cmd.id,
              segmentIndex: cmd.segmentIndex + 1,
              handleType: "anchor",
            }],
          },
        };
      }
    }
    case "splitPath": {
      if (isUndo) {
        // Remove the two new paths and restore the original
        return {
          ...state,
          paths: state.paths.filter((p) => p.id !== cmd.newPath1.id && p.id !== cmd.newPath2.id).concat(cmd.originalPath),
          selection: { pathIds: [cmd.originalPath.id], points: [] },
        };
      } else {
        // Remove the original path and add the two new paths
        return {
          ...state,
          paths: state.paths.filter((p) => p.id !== cmd.originalPath.id).concat(cmd.newPath1, cmd.newPath2),
          selection: { pathIds: [cmd.newPath1.id, cmd.newPath2.id], points: [] },
        };
      }
    }
    case "joinPaths": {
      if (isUndo) {
        // Remove the joined path and restore the original paths
        const originalIds = cmd.originalPaths.map((p) => p.id);
        return {
          ...state,
          paths: state.paths.filter((p) => p.id !== cmd.newPath.id).concat(cmd.originalPaths),
          selection: { pathIds: originalIds, points: [] },
        };
      } else {
        // Remove the original paths and add the joined path
        const originalIds = new Set(cmd.originalPaths.map((p) => p.id));
        return {
          ...state,
          paths: state.paths.filter((p) => !originalIds.has(p.id)).concat(cmd.newPath),
          selection: { pathIds: [cmd.newPath.id], points: [] },
        };
      }
    }
    case "booleanOp": {
      if (isUndo) {
        // Remove result paths and restore original paths
        const resultIds = new Set(cmd.resultPaths.map((p) => p.id));
        return {
          ...state,
          paths: state.paths.filter((p) => !resultIds.has(p.id)).concat(cmd.originalPaths),
          selection: { pathIds: cmd.originalPaths.map((p) => p.id), points: [] },
        };
      } else {
        // Remove original paths and add result paths
        const originalIds = new Set(cmd.originalPaths.map((p) => p.id));
        return {
          ...state,
          paths: state.paths.filter((p) => !originalIds.has(p.id)).concat(cmd.resultPaths),
          selection: { pathIds: cmd.resultPaths.map((p) => p.id), points: [] },
        };
      }
    }
    case "batch": {
      // Apply all commands in the batch (in reverse order for undo)
      let newState = state;
      if (isUndo) {
        for (let i = cmd.commands.length - 1; i >= 0; i--) {
          newState = applyCommand(newState, cmd.commands[i], true);
        }
      } else {
        for (const subCmd of cmd.commands) {
          newState = applyCommand(newState, subCmd, false);
        }
      }
      return newState;
    }
    // Group commands
    case "addGroup": {
      if (isUndo) {
        return {
          ...state,
          groups: state.groups.filter((g) => g.id !== cmd.group.id),
        };
      } else {
        return {
          ...state,
          groups: [...state.groups, cmd.group],
        };
      }
    }
    case "deleteGroup": {
      if (isUndo) {
        // Restore the group and reparent children back to it
        return {
          ...state,
          groups: [...state.groups, cmd.group].map((g) =>
            cmd.childGroupIds.includes(g.id) ? { ...g, parentId: cmd.group.id } : g
          ),
          paths: state.paths.map((p) =>
            cmd.childPathIds.includes(p.id) ? { ...p, parentId: cmd.group.id } : p
          ),
        };
      } else {
        // Delete the group and move children to the group's parent
        return {
          ...state,
          groups: state.groups
            .filter((g) => g.id !== cmd.group.id)
            .map((g) =>
              cmd.childGroupIds.includes(g.id) ? { ...g, parentId: cmd.group.parentId } : g
            ),
          paths: state.paths.map((p) =>
            cmd.childPathIds.includes(p.id) ? { ...p, parentId: cmd.group.parentId } : p
          ),
        };
      }
    }
    case "setGroupName": {
      const name = isUndo ? cmd.prevName : cmd.newName;
      return {
        ...state,
        groups: state.groups.map((g) =>
          g.id === cmd.id ? { ...g, name } : g
        ),
      };
    }
    case "setGroupCollapsed": {
      const collapsed = isUndo ? !cmd.collapsed : cmd.collapsed;
      return {
        ...state,
        groups: state.groups.map((g) =>
          g.id === cmd.id ? { ...g, collapsed } : g
        ),
      };
    }
    case "moveToGroup": {
      const parentId = isUndo ? cmd.prevParentId : cmd.newParentId;
      if (cmd.itemType === "path") {
        return {
          ...state,
          paths: state.paths.map((p) =>
            p.id === cmd.itemId ? { ...p, parentId } : p
          ),
        };
      } else {
        return {
          ...state,
          groups: state.groups.map((g) =>
            g.id === cmd.itemId ? { ...g, parentId } : g
          ),
        };
      }
    }
    case "reorderItem": {
      const fromIndex = isUndo ? cmd.newIndex : cmd.prevIndex;
      const toIndex = isUndo ? cmd.prevIndex : cmd.newIndex;
      if (cmd.itemType === "path") {
        const newPaths = [...state.paths];
        const [item] = newPaths.splice(fromIndex, 1);
        newPaths.splice(toIndex, 0, item);
        return { ...state, paths: newPaths };
      } else {
        const newGroups = [...state.groups];
        const [item] = newGroups.splice(fromIndex, 1);
        newGroups.splice(toIndex, 0, item);
        return { ...state, groups: newGroups };
      }
    }
    case "reorderPaths": {
      // Reorder paths array to match the specified order
      const targetOrder = isUndo ? cmd.prevPathIds : cmd.newPathIds;
      const pathById = new Map(state.paths.map((p) => [p.id, p]));
      const newPaths = targetOrder.map((id) => pathById.get(id)!).filter(Boolean);
      return { ...state, paths: newPaths };
    }
    // Snap connection commands
    case "addSnapConnection": {
      if (isUndo) {
        return {
          ...state,
          snapConnections: state.snapConnections.filter((c) => c.id !== cmd.connection.id),
        };
      } else {
        return {
          ...state,
          snapConnections: [...state.snapConnections, cmd.connection],
        };
      }
    }
    case "removeSnapConnection": {
      if (isUndo) {
        return {
          ...state,
          snapConnections: [...state.snapConnections, cmd.connection],
        };
      } else {
        return {
          ...state,
          snapConnections: state.snapConnections.filter((c) => c.id !== cmd.connection.id),
        };
      }
    }
    case "updateSnapConnection": {
      const connection = isUndo ? cmd.prevConnection : cmd.newConnection;
      return {
        ...state,
        snapConnections: state.snapConnections.map((c) =>
          c.id === connection.id ? connection : c
        ),
      };
    }
    // Animation commands
    case "addAnimationClip": {
      if (isUndo) {
        return {
          ...state,
          animationClips: state.animationClips.filter((c) => c.id !== cmd.clip.id),
        };
      } else {
        return {
          ...state,
          animationClips: [...state.animationClips, cmd.clip],
        };
      }
    }
    case "deleteAnimationClip": {
      if (isUndo) {
        return {
          ...state,
          animationClips: [...state.animationClips, cmd.clip],
        };
      } else {
        return {
          ...state,
          animationClips: state.animationClips.filter((c) => c.id !== cmd.clip.id),
        };
      }
    }
    case "updateAnimationClip": {
      const clip = isUndo ? cmd.prevClip : cmd.newClip;
      return {
        ...state,
        animationClips: state.animationClips.map((c) =>
          c.id === clip.id ? clip : c
        ),
      };
    }
    case "setPartAnimation": {
      const animation = isUndo ? cmd.prevAnimation : cmd.newAnimation;
      return {
        ...state,
        animationClips: state.animationClips.map((c) => {
          if (c.id !== cmd.clipId) return c;
          return {
            ...c,
            parts: {
              ...c.parts,
              [cmd.partId]: animation,
            },
          };
        }),
      };
    }
    case "setPathTransform": {
      const transform = isUndo ? cmd.prevTransform : cmd.newTransform;
      return {
        ...state,
        paths: state.paths.map((p) =>
          p.id === cmd.id ? { ...p, transform } : p
        ),
      };
    }
    case "setTransformPoint": {
      const transformPoint = isUndo ? cmd.prevPoint : cmd.newPoint;
      if (cmd.itemType === "path") {
        return {
          ...state,
          paths: state.paths.map((p) =>
            p.id === cmd.itemId ? { ...p, transformPoint } : p
          ),
        };
      } else {
        return {
          ...state,
          groups: state.groups.map((g) =>
            g.id === cmd.itemId ? { ...g, transformPoint } : g
          ),
        };
      }
    }
    case "bakeTransform": {
      if (isUndo) {
        // Restore the original path entirely
        return {
          ...state,
          paths: state.paths.map((p) =>
            p.id === cmd.id ? cmd.prevPath : p
          ),
        };
      } else {
        // Bake is applied immediately when the command is created,
        // so we just need to ensure the current state is preserved
        // (the bake operation should have already modified the path)
        return state;
      }
    }
  }
}
