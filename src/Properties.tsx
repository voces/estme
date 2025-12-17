import { useState, useEffect } from "react";
import { store, useStore, PointSelection, Selection } from "./store/index.ts";
import { Path, Point, PointReference, HandleType } from "./types.ts";
import {
  averageColors,
  getAnchorColor,
  getAnchorPosition,
  getPathAngle,
  getPathCenter,
} from "./geometry.ts";
import styles from "./Properties.module.css";

// Round to avoid floating point display issues like "-0.000"
function formatNumber(num: number, decimals: number): string {
  // Round to the specified precision to eliminate floating point errors
  const factor = Math.pow(10, decimals);
  const rounded = Math.round(num * factor) / factor;
  // Convert -0 to 0
  const fixed = Object.is(rounded, -0) ? 0 : rounded;
  return fixed.toFixed(decimals);
}

// Input that allows free typing and only formats on blur
function NumberInput({ value, onChange, step, decimals = 3 }: {
  value: number;
  onChange: (value: string) => void;
  step: string;
  decimals?: number;
}) {
  const [localValue, setLocalValue] = useState(formatNumber(value, decimals));
  const [isFocused, setIsFocused] = useState(false);

  // Update local value when external value changes (but not while focused)
  useEffect(() => {
    if (!isFocused) {
      setLocalValue(formatNumber(value, decimals));
    }
  }, [value, decimals, isFocused]);

  return (
    <input
      type="number"
      step={step}
      value={localValue}
      onChange={(e) => {
        setLocalValue(e.target.value);
        onChange(e.target.value);
      }}
      onFocus={() => setIsFocused(true)}
      onBlur={() => {
        setIsFocused(false);
        // Format on blur
        const num = parseFloat(localValue);
        if (!isNaN(num)) {
          setLocalValue(formatNumber(num, decimals));
        }
      }}
    />
  );
}

// Calculate center of multiple paths/points (includes individual point selections)
function getMultiSelectionCenter(paths: Path[], selection: Selection): Point | null {
  const allPoints: Point[] = [];

  // Add centroid of each fully selected path
  for (const pathId of selection.pathIds) {
    const path = paths.find((p) => p.id === pathId);
    if (path) {
      allPoints.push(getPathCenter(path));
    }
  }

  // Add position of each selected point
  for (const pointSel of selection.points) {
    const path = paths.find((p) => p.id === pointSel.pathId);
    if (!path) continue;

    if (pointSel.handleType === "anchor") {
      allPoints.push(getAnchorPosition(path, pointSel.segmentIndex));
    } else if (pointSel.handleType === "c0") {
      allPoints.push(path.segments[pointSel.segmentIndex].c0);
    } else if (pointSel.handleType === "c1") {
      allPoints.push(path.segments[pointSel.segmentIndex].c1);
    }
  }

  if (allPoints.length === 0) return null;

  let sumX = 0, sumY = 0;
  for (const p of allPoints) {
    sumX += p.x;
    sumY += p.y;
  }
  return { x: sumX / allPoints.length, y: sumY / allPoints.length };
}

export const Properties = () => {
  const selection = useStore((s) => s.selection);
  const paths = useStore((s) => s.paths);

  const hasSelection = selection.pathIds.length > 0 || selection.points.length > 0;

  if (!hasSelection) {
    return (
      <div className={styles.properties}>
        <div className={styles.empty}>No path selected</div>
      </div>
    );
  }

  // Check if we have a single path fully selected (show full path properties)
  if (selection.pathIds.length === 1 && selection.points.length === 0) {
    const path = paths.find((p) => p.id === selection.pathIds[0]);
    if (path) {
      return <PathProperties path={path} pathId={selection.pathIds[0]} />;
    }
  }

  // Check if we have a single point selected (show point properties)
  if (selection.pathIds.length === 0 && selection.points.length === 1) {
    const point = selection.points[0];
    const path = paths.find((p) => p.id === point.pathId);
    if (path) {
      if (point.handleType === "anchor") {
        return <AnchorProperties path={path} pathId={point.pathId} segmentIndex={point.segmentIndex} />;
      } else {
        return <ControlPointProperties path={path} pathId={point.pathId} segmentIndex={point.segmentIndex} handleType={point.handleType} />;
      }
    }
  }

  // Multiple items selected - show multi-selection properties
  return <MultiSelectionProperties paths={paths} selection={selection} />;
};

// Multi-selection properties (shows center only)
function MultiSelectionProperties({ paths, selection }: { paths: Path[]; selection: Selection }) {
  const center = getMultiSelectionCenter(paths, selection);
  const count = selection.pathIds.length + selection.points.length;

  // Collect all vertex colors in the selection
  const vertexColors: string[] = [];

  // Add all vertex colors from fully selected paths
  for (const pathId of selection.pathIds) {
    const path = paths.find((p) => p.id === pathId);
    if (path) {
      for (let i = 0; i < path.segments.length; i++) {
        vertexColors.push(getAnchorColor(path, i));
      }
    }
  }

  // Add colors of individually selected anchor points
  const anchorPoints = selection.points.filter(p => p.handleType === "anchor");
  for (const point of anchorPoints) {
    const path = paths.find((p) => p.id === point.pathId);
    if (path) {
      vertexColors.push(getAnchorColor(path, point.segmentIndex));
    }
  }

  const avgColor = averageColors(vertexColors);
  const allSameColor = vertexColors.length > 0 && vertexColors.every(c => c === vertexColors[0]);

  if (!center) {
    return (
      <div className={styles.properties}>
        <div className={styles.empty}>No valid selection</div>
      </div>
    );
  }

  return (
    <div className={styles.properties}>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Multi-Selection</div>
        <div className={styles.row}>
          <label>Items</label>
          <span className={styles.value}>{count}</span>
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Vertex Color</div>
        {vertexColors.length > 1 && !allSameColor && (
          <div className={styles.hint}>Average of {vertexColors.length} vertices</div>
        )}
        {vertexColors.length > 0 ? (
          <div className={styles.colorRow}>
            <input
              type="color"
              className={styles.colorInput}
              value={avgColor}
              onChange={(e) => store.setSelectionColorLive(e.target.value)}
            />
            <span className={styles.colorValue}>{avgColor}</span>
          </div>
        ) : (
          <div className={styles.hint}>No vertices selected</div>
        )}
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Center</div>
        <div className={styles.row}>
          <label>X</label>
          <span className={styles.value}>{formatNumber(center.x, 3)}</span>
        </div>
        <div className={styles.row}>
          <label>Y</label>
          <span className={styles.value}>{formatNumber(center.y, 3)}</span>
        </div>
      </div>
    </div>
  );
}

// Path properties (center, angle)
function PathProperties({ path, pathId }: { path: Path; pathId: string }) {
  const center = getPathCenter(path);
  const angle = getPathAngle(path);

  // Calculate average vertex color for all anchors
  const vertexColors = path.segments.map((_, i) => getAnchorColor(path, i));
  const avgColor = averageColors(vertexColors);
  const isAverage = path.segments.length > 1;
  // Check if all colors are the same
  const allSameColor = vertexColors.every(c => c === vertexColors[0]);

  const handleCenterChange = (axis: "x" | "y", value: string) => {
    const num = parseFloat(value);
    if (isNaN(num)) return;
    const currentCenter = getPathCenter(path);
    const dx = axis === "x" ? num - currentCenter.x : 0;
    const dy = axis === "y" ? num - currentCenter.y : 0;
    if (dx !== 0 || dy !== 0) {
      store.translatePathLive(pathId, dx, dy);
      store.commitTranslate(pathId, dx, dy);
    }
  };

  const handleAngleChange = (value: string) => {
    const num = parseFloat(value);
    if (isNaN(num)) return;
    const currentAngle = getPathAngle(path);
    const deltaAngle = (num - currentAngle) * (Math.PI / 180);
    if (Math.abs(deltaAngle) > 0.0001) {
      const currentCenter = getPathCenter(path);
      store.rotatePathLive(pathId, deltaAngle, currentCenter);
      store.commitRotate(pathId, deltaAngle, currentCenter);
    }
  };

  // Set all vertices to the same color (live, no undo per change)
  const handleColorChange = (color: string) => {
    store.setPathVertexColorsLive(pathId, color);
  };

  return (
    <div className={styles.properties}>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Path</div>
        <div className={styles.row}>
          <label>Anchors</label>
          <span className={styles.value}>{path.segments.length}</span>
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Vertex Color</div>
        {isAverage && !allSameColor && (
          <div className={styles.hint}>Average of {path.segments.length} vertices</div>
        )}
        <div className={styles.colorRow}>
          <input
            type="color"
            className={styles.colorInput}
            value={avgColor}
            onChange={(e) => handleColorChange(e.target.value)}
          />
          <span className={styles.colorValue}>{avgColor}</span>
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Center</div>
        <div className={styles.row}>
          <label>X</label>
          <NumberInput
            value={center.x}
            step="0.1"
            onChange={(v) => handleCenterChange("x", v)}
          />
        </div>
        <div className={styles.row}>
          <label>Y</label>
          <NumberInput
            value={center.y}
            step="0.1"
            onChange={(v) => handleCenterChange("y", v)}
          />
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Rotation</div>
        <div className={styles.row}>
          <label>°</label>
          <NumberInput
            value={angle}
            step="1"
            decimals={1}
            onChange={handleAngleChange}
          />
        </div>
      </div>
    </div>
  );
}

// Snap connections section for a point
function SnapConnectionsSection({ pathId, segmentIndex, handleType }: { pathId: string; segmentIndex: number; handleType: HandleType }) {
  const paths = useStore((s) => s.paths);
  const snapConnections = useStore((s) => s.snapConnections);

  const pointRef: PointReference = { pathId, segmentIndex, handleType };
  const connectedPoints = store.getConnectedPoints(pointRef);

  if (connectedPoints.length === 0) return null;

  return (
    <div className={styles.section}>
      <div className={styles.sectionTitle}>Snapped With</div>
      {connectedPoints.map((connPoint, idx) => {
        const connPath = paths.find((p) => p.id === connPoint.pathId);
        const pathName = connPath?.name || "Unknown";
        const pointType = connPoint.handleType === "anchor" ? "anchor" : connPoint.handleType;
        return (
          <div key={idx} className={styles.snapRow}>
            <span className={styles.snapInfo}>
              {pathName} • {pointType} #{connPoint.segmentIndex}
            </span>
            <button
              className={styles.unsnapButton}
              onClick={() => store.unsnapPoint(pointRef)}
              title="Unsnap this point"
            >
              Unsnap
            </button>
          </div>
        );
      })}
      {connectedPoints.length > 1 && (
        <button
          className={styles.unsnapAllButton}
          onClick={() => store.unsnapPoint(pointRef)}
        >
          Unsnap All
        </button>
      )}
    </div>
  );
}

// Anchor properties
function AnchorProperties({ path, pathId, segmentIndex }: { path: Path; pathId: string; segmentIndex: number }) {
  const meta = path.anchorMeta[segmentIndex];

  // For open paths, the final anchor (segmentIndex === segments.length) has no outgoing segment
  const isFinalAnchorOfOpenPath = !path.closed && segmentIndex === path.segments.length;
  // For open paths, the first anchor (segmentIndex === 0) has no incoming segment
  const isFirstAnchorOfOpenPath = !path.closed && segmentIndex === 0;

  // Get the segment that starts at this anchor (if any)
  const segment = isFinalAnchorOfOpenPath ? null : path.segments[segmentIndex];
  // Get the segment that ends at this anchor (if any)
  const prevSegIdx = segmentIndex === 0 ? path.segments.length - 1 : segmentIndex - 1;
  const prevSegment = isFirstAnchorOfOpenPath ? null : path.segments[prevSegIdx];

  // Get anchor position
  const anchorPos = isFinalAnchorOfOpenPath
    ? path.segments[path.segments.length - 1].p1
    : path.segments[segmentIndex].p0;

  // Whether this anchor has c0 (outgoing) and c1 (incoming) handles
  const hasC0 = !isFinalAnchorOfOpenPath;
  const hasC1 = !isFirstAnchorOfOpenPath;

  const handleAnchorChange = (axis: "x" | "y", value: string) => {
    const num = parseFloat(value);
    if (isNaN(num)) return;
    const dx = axis === "x" ? num - anchorPos.x : 0;
    const dy = axis === "y" ? num - anchorPos.y : 0;
    if (dx !== 0 || dy !== 0) {
      store.movePointLive(pathId, segmentIndex, dx, dy);
      store.commitMovePoint(pathId, segmentIndex, dx, dy);
    }
  };

  const handleC0Change = (axis: "x" | "y", value: string) => {
    if (!segment) return;
    const num = parseFloat(value);
    if (isNaN(num)) return;
    const dx = axis === "x" ? num - segment.c0.x : 0;
    const dy = axis === "y" ? num - segment.c0.y : 0;
    if (dx !== 0 || dy !== 0) {
      store.moveHandleLive(pathId, segmentIndex, "c0", dx, dy);
      store.commitMoveHandle(pathId, segmentIndex, "c0", dx, dy);
    }
  };

  const handleC1Change = (axis: "x" | "y", value: string) => {
    if (!prevSegment) return;
    const num = parseFloat(value);
    if (isNaN(num)) return;
    const dx = axis === "x" ? num - prevSegment.c1.x : 0;
    const dy = axis === "y" ? num - prevSegment.c1.y : 0;
    if (dx !== 0 || dy !== 0) {
      store.moveHandleLive(pathId, prevSegIdx, "c1", dx, dy);
      store.commitMoveHandle(pathId, prevSegIdx, "c1", dx, dy);
    }
  };

  return (
    <div className={styles.properties}>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Anchor</div>
        <div className={styles.row}>
          <label>X</label>
          <NumberInput
            value={anchorPos.x}
            step="0.1"
            onChange={(v) => handleAnchorChange("x", v)}
          />
        </div>
        <div className={styles.row}>
          <label>Y</label>
          <NumberInput
            value={anchorPos.y}
            step="0.1"
            onChange={(v) => handleAnchorChange("y", v)}
          />
        </div>
      </div>

      {hasC0 && segment && (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>
            <span>Right Handle (c0)</span>
            <input
              type="checkbox"
              checked={meta.rightActive}
              onChange={() => store.toggleRightControl(pathId, segmentIndex)}
            />
          </div>
          {meta.rightActive && (
            <>
              <div className={styles.row}>
                <label>X</label>
                <NumberInput
                  value={segment.c0.x}
                  step="0.1"
                  onChange={(v) => handleC0Change("x", v)}
                />
              </div>
              <div className={styles.row}>
                <label>Y</label>
                <NumberInput
                  value={segment.c0.y}
                  step="0.1"
                  onChange={(v) => handleC0Change("y", v)}
                />
              </div>
            </>
          )}
        </div>
      )}

      {hasC1 && prevSegment && (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>
            <span>Left Handle (c1)</span>
            <input
              type="checkbox"
              checked={meta.leftActive}
              onChange={() => store.toggleLeftControl(pathId, segmentIndex)}
            />
          </div>
          {meta.leftActive && (
            <>
              <div className={styles.row}>
                <label>X</label>
                <NumberInput
                  value={prevSegment.c1.x}
                  step="0.1"
                  onChange={(v) => handleC1Change("x", v)}
                />
              </div>
              <div className={styles.row}>
                <label>Y</label>
                <NumberInput
                  value={prevSegment.c1.y}
                  step="0.1"
                  onChange={(v) => handleC1Change("y", v)}
                />
              </div>
            </>
          )}
        </div>
      )}

      {/* Symmetry only makes sense if anchor has both handles */}
      {hasC0 && hasC1 && (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Symmetry</div>
          <div className={styles.checkboxRow}>
            <input
              type="checkbox"
              id="mirrorAngle"
              checked={meta.mirrorAngle}
              onChange={() => store.setMirrorAngle(pathId, segmentIndex, !meta.mirrorAngle)}
            />
            <label htmlFor="mirrorAngle">Lock angles (180°)</label>
          </div>
          <div className={styles.checkboxRow}>
            <input
              type="checkbox"
              id="mirrorDistance"
              checked={meta.mirrorDistance}
              onChange={() => store.setMirrorDistance(pathId, segmentIndex, !meta.mirrorDistance)}
            />
            <label htmlFor="mirrorDistance">Lock magnitudes</label>
          </div>
        </div>
      )}

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Vertex Color</div>
        <div className={styles.colorRow}>
          <input
            type="color"
            className={styles.colorInput}
            value={meta.color || path.fill}
            onChange={(e) => store.setAnchorColorLive(pathId, segmentIndex, e.target.value)}
          />
          <span className={styles.colorValue}>{meta.color || `(inherit: ${path.fill})`}</span>
          {meta.color && (
            <button
              className={styles.clearButton}
              onClick={() => store.clearAnchorColor(pathId, segmentIndex)}
            >
              Clear
            </button>
          )}
        </div>
      </div>

      <SnapConnectionsSection pathId={pathId} segmentIndex={segmentIndex} handleType="anchor" />
    </div>
  );
}

// Control point properties (c0 or c1)
function ControlPointProperties({ path, pathId, segmentIndex, handleType }: { path: Path; pathId: string; segmentIndex: number; handleType: "c0" | "c1" }) {
  const segment = path.segments[segmentIndex];

  // Determine which anchor this control point belongs to
  let anchorIndex: number;
  let controlPoint: Point;
  let otherHandleActive: boolean;

  if (handleType === "c0") {
    // c0 belongs to this segment's anchor (p0)
    anchorIndex = segmentIndex;
    controlPoint = segment.c0;
    otherHandleActive = path.anchorMeta[anchorIndex].leftActive;
  } else {
    // c1 belongs to the next segment's anchor
    // For open paths, the last segment's c1 belongs to the final anchor (index = segments.length)
    anchorIndex = path.closed
      ? (segmentIndex + 1) % path.segments.length
      : segmentIndex + 1;
    controlPoint = segment.c1;
    otherHandleActive = path.anchorMeta[anchorIndex]?.rightActive ?? true;
  }

  const meta = path.anchorMeta[anchorIndex];
  // Get anchor position (for open paths, final anchor is at segments[length-1].p1)
  const anchor = anchorIndex < path.segments.length
    ? path.segments[anchorIndex].p0
    : path.segments[path.segments.length - 1].p1;

  const handleCoordChange = (axis: "x" | "y", value: string) => {
    const num = parseFloat(value);
    if (isNaN(num)) return;
    const dx = axis === "x" ? num - controlPoint.x : 0;
    const dy = axis === "y" ? num - controlPoint.y : 0;
    if (dx !== 0 || dy !== 0) {
      store.moveHandleLive(pathId, segmentIndex, handleType, dx, dy);
      store.commitMoveHandle(pathId, segmentIndex, handleType, dx, dy);
    }
  };

  // Calculate angle and magnitude relative to anchor
  const dx = controlPoint.x - anchor.x;
  const dy = controlPoint.y - anchor.y;
  const magnitude = Math.sqrt(dx * dx + dy * dy);
  const angle = Math.atan2(dy, dx) * (180 / Math.PI);

  return (
    <div className={styles.properties}>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Control Point ({handleType})</div>
        <div className={styles.row}>
          <label>X</label>
          <NumberInput
            value={controlPoint.x}
            step="0.1"
            onChange={(v) => handleCoordChange("x", v)}
          />
        </div>
        <div className={styles.row}>
          <label>Y</label>
          <NumberInput
            value={controlPoint.y}
            step="0.1"
            onChange={(v) => handleCoordChange("y", v)}
          />
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Relative to Anchor</div>
        <div className={styles.row}>
          <label>Angle</label>
          <span className={styles.value}>{angle.toFixed(1)}°</span>
        </div>
        <div className={styles.row}>
          <label>Dist</label>
          <span className={styles.value}>{magnitude.toFixed(3)}</span>
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Mirror to Other Handle</div>
        {!otherHandleActive && (
          <div className={styles.hint}>Checking will create the other handle</div>
        )}
        <div className={styles.checkboxRow}>
          <input
            type="checkbox"
            id="mirrorAngle"
            checked={meta.mirrorAngle}
            onChange={() => store.setMirrorAngle(pathId, anchorIndex, !meta.mirrorAngle)}
          />
          <label htmlFor="mirrorAngle">Lock angles (180°)</label>
        </div>
        <div className={styles.checkboxRow}>
          <input
            type="checkbox"
            id="mirrorDistance"
            checked={meta.mirrorDistance}
            onChange={() => store.setMirrorDistance(pathId, anchorIndex, !meta.mirrorDistance)}
          />
          <label htmlFor="mirrorDistance">Lock magnitudes</label>
        </div>
      </div>

      <SnapConnectionsSection pathId={pathId} segmentIndex={segmentIndex} handleType={handleType} />
    </div>
  );
}
