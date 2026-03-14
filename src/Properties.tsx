import { useEffect, useRef, useState } from "react";
import { PointSelection, Selection, store, useStore } from "./store/index.ts";
import { InstanceProperties as InstancePropertiesType } from "./store/types.ts";
import { Camera, HandleType, Path, Point, PointReference, Raster } from "./types.ts";
import {
  ANIMATABLE_PROPERTIES,
  AnimatableProperty,
  defaultPropertyValues,
  PartAnimation,
  propertyColors,
  UnifiedKeyframe,
} from "./animation.ts";
import {
  averageColors,
  getAnchorColor,
  getAnchorPosition,
  getGroupCenter,
  getGroupTransformPoint,
  getPathAngle,
  getPathCenter,
  getPathTransformPoint,
} from "./geometry.ts";
import { Group } from "./types.ts";
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

// Number input with drag-to-adjust behavior (like a scrubber/slider)
function DraggableNumberInput(
  { value, onChange, min, max, step = 1, decimals = 0, suffix = "" }: {
    value: number;
    onChange: (value: number) => void;
    min: number;
    max: number;
    step?: number;
    decimals?: number;
    suffix?: string;
  },
) {
  const [localValue, setLocalValue] = useState(formatNumber(value, decimals));
  const [isFocused, setIsFocused] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{ x: number; startValue: number } | null>(null);

  // Update local value when external value changes (but not while focused/dragging)
  useEffect(() => {
    if (!isFocused && !isDragging) {
      setLocalValue(formatNumber(value, decimals));
    }
  }, [value, decimals, isFocused, isDragging]);

  const clamp = (v: number) => Math.max(min, Math.min(max, v));

  const handleMouseDown = (e: React.MouseEvent) => {
    // Only start drag on left click, not when clicking into input to type
    if (e.button !== 0) return;

    dragStartRef.current = { x: e.clientX, startValue: value };
    setIsDragging(true);

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!dragStartRef.current) return;
      const delta = moveEvent.clientX - dragStartRef.current.x;
      // Sensitivity: 1 pixel = step amount
      const newValue = clamp(dragStartRef.current.startValue + delta * step);
      setLocalValue(formatNumber(newValue, decimals));
      onChange(newValue);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      dragStartRef.current = null;
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  };

  return (
    <div
      className={styles.draggableInput}
      style={{ cursor: isDragging ? "ew-resize" : "ew-resize" }}
    >
      <input
        type="number"
        step={step}
        min={min}
        max={max}
        value={localValue}
        onChange={(e) => {
          setLocalValue(e.target.value);
          const num = parseFloat(e.target.value);
          if (!isNaN(num)) {
            onChange(clamp(num));
          }
        }}
        onFocus={() => setIsFocused(true)}
        onBlur={() => {
          setIsFocused(false);
          const num = parseFloat(localValue);
          if (!isNaN(num)) {
            setLocalValue(formatNumber(clamp(num), decimals));
          }
        }}
        onMouseDown={handleMouseDown}
        style={{ cursor: "ew-resize" }}
      />
      {suffix && <span className={styles.unit}>{suffix}</span>}
    </div>
  );
}

// Calculate center of multiple paths/points as bounding box center (includes individual point selections)
function getMultiSelectionCenter(
  paths: Path[],
  selection: Selection,
): Point | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let hasPoints = false;

  // Add all geometry points from fully selected paths
  for (const pathId of selection.pathIds) {
    const path = paths.find((p) => p.id === pathId);
    if (path) {
      for (const seg of path.segments) {
        for (const pt of [seg.p0, seg.c0, seg.c1, seg.p1]) {
          minX = Math.min(minX, pt.x);
          minY = Math.min(minY, pt.y);
          maxX = Math.max(maxX, pt.x);
          maxY = Math.max(maxY, pt.y);
          hasPoints = true;
        }
      }
    }
  }

  // Add position of each selected point
  for (const pointSel of selection.points) {
    const path = paths.find((p) => p.id === pointSel.pathId);
    if (!path) continue;

    let pt: Point;
    if (pointSel.handleType === "anchor") {
      pt = getAnchorPosition(path, pointSel.segmentIndex);
    } else if (pointSel.handleType === "c0") {
      pt = path.segments[pointSel.segmentIndex].c0;
    } else {
      pt = path.segments[pointSel.segmentIndex].c1;
    }
    minX = Math.min(minX, pt.x);
    minY = Math.min(minY, pt.y);
    maxX = Math.max(maxX, pt.x);
    maxY = Math.max(maxY, pt.y);
    hasPoints = true;
  }

  if (!hasPoints) return null;

  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

const PROPERTY_LABELS: Record<AnimatableProperty, string> = {
  tx: "Translate X",
  ty: "Translate Y",
  rot: "Rotation",
  scale: "Scale",
  opacity: "Opacity",
};

// Instance properties section (global rendering properties not part of document)
function InstancePropertiesSection() {
  const instanceProperties = useStore((s) => s.instanceProperties);

  return (
    <>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Instance Properties</div>
        <div className={styles.hint}>
          Rendering properties (not saved with document)
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Opacity</div>
        <div className={styles.row}>
          <DraggableNumberInput
            value={Math.round(instanceProperties.opacity * 100)}
            min={0}
            max={100}
            step={1}
            decimals={0}
            suffix="%"
            onChange={(v) => store.setInstanceOpacity(v / 100)}
          />
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Vertex Color</div>
        <div className={styles.colorRow}>
          <input
            type="color"
            className={styles.colorInput}
            value={instanceProperties.vertexColor}
            onChange={(e) => store.setInstanceVertexColor(e.target.value)}
          />
          <span className={styles.colorValue}>
            {instanceProperties.vertexColor}
          </span>
        </div>
        <div className={styles.hint}>Multiplied with per-vertex colors</div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Accent Color</div>
        <div className={styles.colorRow}>
          <input
            type="color"
            className={styles.colorInput}
            value={instanceProperties.accentColor}
            onChange={(e) => store.setInstanceAccentColor(e.target.value)}
          />
          <span className={styles.colorValue}>
            {instanceProperties.accentColor}
          </span>
        </div>
        <div className={styles.hint}>For player-masked vertices</div>
      </div>

      <div className={styles.section}>
        <div className={styles.checkboxRow}>
          <input
            type="checkbox"
            id="minimapMask"
            checked={instanceProperties.minimapMask}
            onChange={(e) => store.setInstanceMinimapMask(e.target.checked)}
          />
          <label htmlFor="minimapMask">Minimap Mask</label>
        </div>
        <div className={styles.hint}>
          Render as solid accent color silhouette
        </div>
      </div>
    </>
  );
}

// Scene properties section (editor settings like grid visibility)
function ScenePropertiesSection() {
  const showGrid = useStore((s) => s.showGrid);

  return (
    <div className={styles.section}>
      <div className={styles.sectionTitle}>Scene Properties</div>
      <div className={styles.checkboxRow}>
        <input
          type="checkbox"
          id="showGrid"
          checked={showGrid}
          onChange={(e) => store.setShowGrid(e.target.checked)}
        />
        <label htmlFor="showGrid">Show Grid</label>
      </div>
    </div>
  );
}

export const Properties = () => {
  const selection = useStore((s) => s.selection);
  const paths = useStore((s) => s.paths);
  const groups = useStore((s) => s.groups);
  const rasters = useStore((s) => s.rasters);
  const cameras = useStore((s) => s.cameras);
  const selectedKeyframes = useStore((s) => s.selectedKeyframes);
  const currentClipId = useStore((s) => s.currentClipId);
  const animationClips = useStore((s) => s.animationClips);

  // If keyframes are selected, show unified keyframe editor
  // Include all selected paths so edits apply to the whole selection
  if (selectedKeyframes.length > 0 && currentClipId) {
    const clip = animationClips.find((c) => c.id === currentClipId);

    // Build a map of pathId -> selected keyframe time
    // Each path uses its own selected keyframe time for edits
    const pathTimeMap = new Map<string, number>();
    for (const kf of selectedKeyframes) {
      // If path already has a time, keep the first one (could be multiple keyframes for same path)
      if (!pathTimeMap.has(kf.pathId)) {
        pathTimeMap.set(kf.pathId, kf.time);
      }
    }

    // Get all selected path IDs from keyframes + any other selected paths
    const keyframePathIds = [...new Set(selectedKeyframes.map((kf) => kf.pathId))];
    const selectedPathIds = selection.pathIds.length > 0
      ? selection.pathIds
      : keyframePathIds;

    // For paths without keyframes selected, use the first keyframe's time as fallback
    const fallbackTime = selectedKeyframes[0].time;
    for (const pathId of selectedPathIds) {
      if (!pathTimeMap.has(pathId)) {
        pathTimeMap.set(pathId, fallbackTime);
      }
    }

    // Get names for all selected paths
    const selectedPathNames = selectedPathIds.map((id) => {
      const path = paths.find((p) => p.id === id);
      const group = groups.find((g) => g.id === id);
      const raster = rasters.find((r) => r.id === id);
      return path?.name ?? group?.name ?? raster?.name ?? "Unknown";
    });

    const unifiedKeyframe = store.getSelectedKeyframe();

    if (unifiedKeyframe) {
      return (
        <UnifiedKeyframeProperties
          clipId={currentClipId}
          pathIds={selectedPathIds}
          pathNames={selectedPathNames}
          clipName={clip?.name ?? ""}
          keyframe={unifiedKeyframe}
          pathTimeMap={pathTimeMap}
          clipDuration={clip?.duration ?? 1}
        />
      );
    }
  }

  const hasSelection = selection.pathIds.length > 0 ||
    selection.points.length > 0;

  if (!hasSelection) {
    return (
      <div className={styles.properties}>
        <ScenePropertiesSection />
        <InstancePropertiesSection />
      </div>
    );
  }

  // Check if we have a single path fully selected (show full path properties)
  if (selection.pathIds.length === 1 && selection.points.length === 0) {
    // First check if this ID is a group
    const group = groups.find((g) => g.id === selection.pathIds[0]);
    if (group) {
      return <GroupProperties group={group} paths={paths} groups={groups} />;
    }
    // Check if this is a raster
    const raster = rasters.find((r) => r.id === selection.pathIds[0]);
    if (raster) {
      return <RasterProperties raster={raster} />;
    }
    // Check if this is a camera
    const camera = cameras.find((c) => c.id === selection.pathIds[0]);
    if (camera) {
      return <CameraProperties camera={camera} />;
    }
    // Otherwise it's a path
    const path = paths.find((p) => p.id === selection.pathIds[0]);
    if (path) {
      return <PathProperties path={path} pathId={selection.pathIds[0]} />;
    }
  }

  // Check if selection matches a group exactly (all children of a single group)
  if (selection.pathIds.length > 0 && selection.points.length === 0) {
    // Find if there's a group whose children exactly match selection.pathIds
    for (const group of groups) {
      const childPathIds = paths
        .filter((p) => p.parentId === group.id)
        .map((p) => p.id);
      const childGroupIds = groups
        .filter((g) => g.parentId === group.id)
        .map((g) => g.id);
      const allChildIds = [...childPathIds, ...childGroupIds];

      // Check if selection matches exactly the children of this group
      if (
        allChildIds.length === selection.pathIds.length &&
        selection.pathIds.every((id) => allChildIds.includes(id)) &&
        allChildIds.every((id) => selection.pathIds.includes(id))
      ) {
        return <GroupProperties group={group} paths={paths} groups={groups} />;
      }
    }
  }

  // Check if we have a single point selected (show point properties)
  if (selection.pathIds.length === 0 && selection.points.length === 1) {
    const point = selection.points[0];
    const path = paths.find((p) => p.id === point.pathId);
    if (path) {
      if (point.handleType === "anchor") {
        return (
          <AnchorProperties
            path={path}
            pathId={point.pathId}
            segmentIndex={point.segmentIndex}
          />
        );
      } else {
        return (
          <ControlPointProperties
            path={path}
            pathId={point.pathId}
            segmentIndex={point.segmentIndex}
            handleType={point.handleType}
          />
        );
      }
    }
  }

  // Multiple items selected - show multi-selection properties
  return <MultiSelectionProperties paths={paths} selection={selection} />;
};

// Multi-selection properties (shows center only)
function MultiSelectionProperties(
  { paths, selection }: { paths: Path[]; selection: Selection },
) {
  const center = getMultiSelectionCenter(paths, selection);
  const count = selection.pathIds.length + selection.points.length;

  // Calculate average opacity for selected paths
  const selectedPaths = paths.filter((p) => selection.pathIds.includes(p.id));
  const avgOpacity = selectedPaths.length > 0
    ? selectedPaths.reduce((sum, p) => sum + p.opacity, 0) /
      selectedPaths.length
    : 1;
  const allSameOpacity = selectedPaths.length > 0 &&
    selectedPaths.every((p) => p.opacity === selectedPaths[0].opacity);

  const handleCenterChange = (axis: "x" | "y", value: number) => {
    if (!center) return;
    const dx = axis === "x" ? value - center.x : 0;
    const dy = axis === "y" ? value - center.y : 0;
    if (dx !== 0 || dy !== 0) {
      // Translate all selected paths and points
      store.translateSelectionLive(dx, dy);
      // Commit as a batch
      store.commitTranslateSelection(dx, dy);
    }
  };

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
  const anchorPoints = selection.points.filter((p) =>
    p.handleType === "anchor"
  );
  for (const point of anchorPoints) {
    const path = paths.find((p) => p.id === point.pathId);
    if (path) {
      vertexColors.push(getAnchorColor(path, point.segmentIndex));
    }
  }

  const avgColor = averageColors(vertexColors);
  const allSameColor = vertexColors.length > 0 &&
    vertexColors.every((c) => c === vertexColors[0]);

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
          <div className={styles.hint}>
            Average of {vertexColors.length} vertices
          </div>
        )}
        {vertexColors.length > 0
          ? (
            <div className={styles.colorRow}>
              <input
                type="color"
                className={styles.colorInput}
                value={avgColor}
                onChange={(e) => store.setSelectionColorLive(e.target.value)}
              />
              <span className={styles.colorValue}>{avgColor}</span>
            </div>
          )
          : <div className={styles.hint}>No vertices selected</div>}
        {selectedPaths.length > 0 && (
          <>
            <div className={styles.row} style={{ marginTop: 8 }}>
              <label>Opacity</label>
              <DraggableNumberInput
                value={Math.round(avgOpacity * 100)}
                min={0}
                max={100}
                step={1}
                decimals={0}
                suffix="%"
                onChange={(v) => {
                  const newOpacity = v / 100;
                  for (const pathId of selection.pathIds) {
                    store.setPathOpacity(pathId, newOpacity);
                  }
                }}
              />
            </div>
            {!allSameOpacity && (
              <div className={styles.hint}>
                Average of {selectedPaths.length} paths
              </div>
            )}
          </>
        )}
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Center</div>
        <div className={styles.row}>
          <label>X</label>
          <DraggableNumberInput
            value={center.x}
            min={-100000}
            max={100000}
            step={0.1}
            decimals={3}
            onChange={(v) => handleCenterChange("x", v)}
          />
        </div>
        <div className={styles.row}>
          <label>Y</label>
          <DraggableNumberInput
            value={center.y}
            min={-100000}
            max={100000}
            step={0.1}
            decimals={3}
            onChange={(v) => handleCenterChange("y", v)}
          />
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
  const allSameColor = vertexColors.every((c) => c === vertexColors[0]);

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
          <div className={styles.hint}>
            Average of {path.segments.length} vertices
          </div>
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
        <div className={styles.row}>
          <label>Opacity</label>
          <DraggableNumberInput
            value={Math.round(path.opacity * 100)}
            min={0}
            max={100}
            step={1}
            decimals={0}
            suffix="%"
            onChange={(v) => store.setPathOpacity(path.id, v / 100)}
          />
        </div>
        <div className={styles.checkboxRow}>
          <input
            type="checkbox"
            id={`playerMask-${pathId}`}
            checked={path.playerMask}
            onChange={(e) => store.setPathPlayerMask(path.id, e.target.checked)}
          />
          <label htmlFor={`playerMask-${pathId}`}>Accent Color</label>
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

      <TransformPointSection itemId={pathId} itemType="path" path={path} />

      {(path.transform.rot !== 0 || path.transform.scale !== 1) && (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Animation Transform</div>
          <div className={styles.row}>
            <label>Rot</label>
            <span className={styles.value}>
              {formatNumber(path.transform.rot * (180 / Math.PI), 1)}°
            </span>
          </div>
          <div className={styles.row}>
            <label>Scale</label>
            <span className={styles.value}>
              {formatNumber(path.transform.scale * 100, 0)}%
            </span>
          </div>
          <button
            className={styles.resetButton}
            onClick={() =>
              store.bakeTransform(pathId)}
            title="Apply rotation and scale to geometry, resetting them to identity"
            style={{ width: "100%", marginTop: "4px" }}
          >
            Bake Transform
          </button>
        </div>
      )}

      <div className={styles.notesSection}>
        <div className={styles.sectionTitle}>Notes</div>
        <textarea
          className={styles.notesTextarea}
          value={path.notes ?? ""}
          onChange={(e) => store.setNotes(pathId, e.target.value)}
          placeholder="Add notes..."
        />
      </div>
    </div>
  );
}

// Raster properties panel
function RasterProperties({ raster }: { raster: Raster }) {
  const handlePositionChange = (axis: "x" | "y", value: string) => {
    const num = parseFloat(value);
    if (isNaN(num)) return;
    store.setRasterPosition(raster.id,
      axis === "x" ? num : raster.x,
      axis === "y" ? num : raster.y
    );
  };

  const handleSizeChange = (axis: "width" | "height", value: string) => {
    const num = parseFloat(value);
    if (isNaN(num) || num <= 0) return;
    store.setRasterSize(raster.id,
      axis === "width" ? num : raster.width,
      axis === "height" ? num : raster.height
    );
  };

  return (
    <div className={styles.properties}>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Raster</div>
        <div className={styles.row}>
          <label>Size</label>
          <span className={styles.value}>
            {Math.round(raster.width)} × {Math.round(raster.height)}
          </span>
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Position</div>
        <div className={styles.row}>
          <label>X</label>
          <NumberInput
            value={raster.x}
            step="0.1"
            onChange={(v) => handlePositionChange("x", v)}
          />
        </div>
        <div className={styles.row}>
          <label>Y</label>
          <NumberInput
            value={raster.y}
            step="0.1"
            onChange={(v) => handlePositionChange("y", v)}
          />
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Size</div>
        <div className={styles.row}>
          <label>W</label>
          <NumberInput
            value={raster.width}
            step="0.1"
            onChange={(v) => handleSizeChange("width", v)}
          />
        </div>
        <div className={styles.row}>
          <label>H</label>
          <NumberInput
            value={raster.height}
            step="0.1"
            onChange={(v) => handleSizeChange("height", v)}
          />
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Appearance</div>
        <div className={styles.row}>
          <label>Opacity</label>
          <DraggableNumberInput
            value={Math.round(raster.opacity * 100)}
            min={0}
            max={100}
            step={1}
            decimals={0}
            suffix="%"
            onChange={(v) => store.setRasterOpacity(raster.id, v / 100)}
          />
        </div>
        <div className={styles.row}>
          <label>Layer</label>
          <select
            value={raster.renderOrder}
            onChange={(e) => store.setRasterRenderOrder(raster.id, e.target.value as "front" | "back")}
          >
            <option value="back">Back</option>
            <option value="front">Front</option>
          </select>
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Transform</div>
        <div className={styles.row}>
          <label>Rotation</label>
          <NumberInput
            value={raster.transform.rot * (180 / Math.PI)}
            step="1"
            decimals={1}
            onChange={(v) => {
              const num = parseFloat(v);
              if (isNaN(num)) return;
              store.setRasterTransform(raster.id, {
                ...raster.transform,
                rot: num * (Math.PI / 180)
              });
            }}
          />
        </div>
        <div className={styles.row}>
          <label>Scale</label>
          <DraggableNumberInput
            value={Math.round(raster.transform.scale * 100)}
            min={1}
            max={1000}
            step={1}
            decimals={0}
            suffix="%"
            onChange={(v) => store.setRasterTransform(raster.id, {
              ...raster.transform,
              scale: v / 100
            })}
          />
        </div>
      </div>

      <div className={styles.notesSection}>
        <div className={styles.sectionTitle}>Notes</div>
        <textarea
          className={styles.notesTextarea}
          value={raster.notes ?? ""}
          onChange={(e) => store.setNotes(raster.id, e.target.value)}
          placeholder="Add notes..."
        />
      </div>
    </div>
  );
}

// Camera properties panel
function CameraProperties({ camera }: { camera: Camera }) {
  const handlePositionChange = (axis: "x" | "y", value: string) => {
    const num = parseFloat(value);
    if (isNaN(num)) return;
    store.setCameraPosition(camera.id,
      axis === "x" ? num : camera.x,
      axis === "y" ? num : camera.y
    );
  };

  const handleSizeChange = (value: string) => {
    const num = parseFloat(value);
    if (isNaN(num) || num <= 0) return;
    store.setCameraSize(camera.id, num);
  };

  return (
    <div className={styles.properties}>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Camera</div>
        <div className={styles.row}>
          <label>Name</label>
          <span className={styles.value}>{camera.name}</span>
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Position</div>
        <div className={styles.row}>
          <label>X</label>
          <NumberInput
            value={camera.x}
            step="0.1"
            onChange={(v) => handlePositionChange("x", v)}
          />
        </div>
        <div className={styles.row}>
          <label>Y</label>
          <NumberInput
            value={camera.y}
            step="0.1"
            onChange={(v) => handlePositionChange("y", v)}
          />
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Size</div>
        <div className={styles.row}>
          <label>Half-width</label>
          <NumberInput
            value={camera.size}
            step="0.1"
            onChange={handleSizeChange}
          />
        </div>
      </div>

      <div className={styles.section}>
        <button
          className={styles.deleteButton}
          onClick={() => store.deleteCamera(camera.id)}
        >
          Delete Camera
        </button>
      </div>

      <div className={styles.notesSection}>
        <div className={styles.sectionTitle}>Notes</div>
        <textarea
          className={styles.notesTextarea}
          value={camera.notes ?? ""}
          onChange={(e) => store.setNotes(camera.id, e.target.value)}
          placeholder="Add notes..."
        />
      </div>
    </div>
  );
}

// Transform point editing section
function TransformPointSection(
  { itemId, itemType, path, group, allPaths, allGroups }: {
    itemId: string;
    itemType: "path" | "group";
    path?: Path;
    group?: Group;
    allPaths?: Path[];
    allGroups?: Group[];
  },
) {
  const currentPoint = itemType === "path" && path
    ? getPathTransformPoint(path)
    : itemType === "group" && group && allPaths && allGroups
    ? getGroupTransformPoint(group, allPaths, allGroups)
    : null;

  const isCustom = itemType === "path" && path
    ? path.transformPoint !== null
    : itemType === "group" && group
    ? group.transformPoint !== null
    : false;

  if (!currentPoint) return null;

  const handleTransformPointChange = (axis: "x" | "y", value: string) => {
    const num = parseFloat(value);
    if (isNaN(num)) return;
    const newPoint: Point = {
      x: axis === "x" ? num : currentPoint.x,
      y: axis === "y" ? num : currentPoint.y,
    };
    store.setTransformPoint(itemId, itemType, newPoint);
  };

  const handleReset = () => {
    store.clearTransformPoint(itemId, itemType);
  };

  return (
    <div className={styles.section}>
      <div className={styles.sectionTitle}>
        <span>Transform Point</span>
        {isCustom && (
          <button
            className={styles.resetButton}
            onClick={handleReset}
            title="Reset to dynamic center"
          >
            Reset
          </button>
        )}
      </div>
      <div className={styles.row}>
        <label>X</label>
        <NumberInput
          value={currentPoint.x}
          step="0.1"
          onChange={(v) => handleTransformPointChange("x", v)}
        />
      </div>
      <div className={styles.row}>
        <label>Y</label>
        <NumberInput
          value={currentPoint.y}
          step="0.1"
          onChange={(v) => handleTransformPointChange("y", v)}
        />
      </div>
      {!isCustom && (
        <div className={styles.hint}>Dynamic (follows geometry)</div>
      )}
    </div>
  );
}

// Group properties
function GroupProperties(
  { group, paths, groups }: { group: Group; paths: Path[]; groups: Group[] },
) {
  const center = getGroupCenter(group, paths, groups);

  // Count direct children
  const childPathCount = paths.filter((p) => p.parentId === group.id).length;
  const childGroupCount = groups.filter((g) => g.parentId === group.id).length;

  // Get all descendant paths for editing
  const descendantPathIds = store.getDescendantPathIds(group.id);
  const descendantPaths = paths.filter((p) => descendantPathIds.includes(p.id));

  // Calculate average opacity for descendant paths
  const avgOpacity = descendantPaths.length > 0
    ? descendantPaths.reduce((sum, p) => sum + p.opacity, 0) /
      descendantPaths.length
    : 1;
  const allSameOpacity = descendantPaths.length > 0 &&
    descendantPaths.every((p) => p.opacity === descendantPaths[0].opacity);

  // Collect all vertex colors from descendant paths
  const vertexColors: string[] = [];
  for (const path of descendantPaths) {
    for (let i = 0; i < path.segments.length; i++) {
      vertexColors.push(getAnchorColor(path, i));
    }
  }
  const avgColor = averageColors(vertexColors);
  const allSameColor = vertexColors.length > 0 &&
    vertexColors.every((c) => c === vertexColors[0]);

  const handleCenterChange = (axis: "x" | "y", value: number) => {
    const dx = axis === "x" ? value - center.x : 0;
    const dy = axis === "y" ? value - center.y : 0;
    if (dx !== 0 || dy !== 0) {
      // Select all paths in group temporarily and translate
      const prevSelection = store.getState().selection;
      store.setSelection({ pathIds: descendantPathIds, points: [] });
      store.translateSelectionLive(dx, dy);
      store.commitTranslateSelection(dx, dy);
      // Restore previous selection
      store.setSelection(prevSelection);
    }
  };

  const handleColorChange = (color: string) => {
    // Set color for all vertices in all descendant paths
    for (const path of descendantPaths) {
      for (let i = 0; i < path.segments.length; i++) {
        store.setAnchorColor(path.id, i, color);
      }
    }
  };

  const handleOpacityChange = (value: number) => {
    const newOpacity = value / 100;
    for (const pathId of descendantPathIds) {
      store.setPathOpacity(pathId, newOpacity);
    }
  };

  return (
    <div className={styles.properties}>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Group</div>
        <div className={styles.row}>
          <label>Name</label>
          <span className={styles.value}>{group.name}</span>
        </div>
        <div className={styles.row}>
          <label>Children</label>
          <span className={styles.value}>
            {childPathCount} path{childPathCount !== 1 ? "s" : ""},{" "}
            {childGroupCount} group{childGroupCount !== 1 ? "s" : ""}
          </span>
        </div>
      </div>

      {vertexColors.length > 0 && (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Vertex Color</div>
          {vertexColors.length > 1 && !allSameColor && (
            <div className={styles.hint}>
              Average of {vertexColors.length} vertices
            </div>
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
          {descendantPaths.length > 0 && (
            <>
              <div className={styles.row} style={{ marginTop: 8 }}>
                <label>Opacity</label>
                <DraggableNumberInput
                  value={Math.round(avgOpacity * 100)}
                  min={0}
                  max={100}
                  step={1}
                  decimals={0}
                  suffix="%"
                  onChange={handleOpacityChange}
                />
              </div>
              {!allSameOpacity && (
                <div className={styles.hint}>
                  Average of {descendantPaths.length} paths
                </div>
              )}
              <div className={styles.checkboxRow}>
                <input
                  type="checkbox"
                  id={`playerMask-group-${group.id}`}
                  checked={descendantPaths.every((p) => p.playerMask)}
                  ref={(el) => {
                    if (el) {
                      const allChecked = descendantPaths.every((p) =>
                        p.playerMask
                      );
                      const noneChecked = descendantPaths.every((p) =>
                        !p.playerMask
                      );
                      el.indeterminate = !allChecked && !noneChecked;
                    }
                  }}
                  onChange={(e) => {
                    for (const pathId of descendantPathIds) {
                      store.setPathPlayerMask(pathId, e.target.checked);
                    }
                  }}
                />
                <label htmlFor={`playerMask-group-${group.id}`}>
                  Accent Color
                </label>
              </div>
            </>
          )}
        </div>
      )}

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Center</div>
        <div className={styles.row}>
          <label>X</label>
          <DraggableNumberInput
            value={center.x}
            min={-100000}
            max={100000}
            step={0.1}
            decimals={3}
            onChange={(v) => handleCenterChange("x", v)}
          />
        </div>
        <div className={styles.row}>
          <label>Y</label>
          <DraggableNumberInput
            value={center.y}
            min={-100000}
            max={100000}
            step={0.1}
            decimals={3}
            onChange={(v) => handleCenterChange("y", v)}
          />
        </div>
      </div>

      {descendantPaths.length > 1 && (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Align</div>
          <div className={styles.buttonRow}>
            <button
              className={styles.smallButton}
              onClick={() => {
                // Temporarily select group paths for alignment
                const prevSelection = store.getState().selection;
                store.setSelection({ pathIds: descendantPathIds, points: [] });
                store.alignHorizontally();
                store.setSelection(prevSelection);
              }}
              title="Align transform points horizontally"
            >
              ⇔ Horizontal
            </button>
            <button
              className={styles.smallButton}
              onClick={() => {
                // Temporarily select group paths for alignment
                const prevSelection = store.getState().selection;
                store.setSelection({ pathIds: descendantPathIds, points: [] });
                store.alignVertically();
                store.setSelection(prevSelection);
              }}
              title="Align transform points vertically"
            >
              ⇕ Vertical
            </button>
          </div>
        </div>
      )}

      <TransformPointSection
        itemId={group.id}
        itemType="group"
        group={group}
        allPaths={paths}
        allGroups={groups}
      />

      <div className={styles.notesSection}>
        <div className={styles.sectionTitle}>Notes</div>
        <textarea
          className={styles.notesTextarea}
          value={group.notes ?? ""}
          onChange={(e) => store.setNotes(group.id, e.target.value)}
          placeholder="Add notes..."
        />
      </div>
    </div>
  );
}

// Snap connections section for a point
function SnapConnectionsSection(
  { pathId, segmentIndex, handleType }: {
    pathId: string;
    segmentIndex: number;
    handleType: HandleType;
  },
) {
  const paths = useStore((s) => s.paths);
  const snapConnections = useStore((s) => s.snapConnections);

  const pointRef: PointReference = { pathId, segmentIndex, handleType };
  const connectedPoints = store.getConnectedPoints(pointRef);

  if (connectedPoints.length === 0) return null;

  const handleSelectPoint = (connPoint: PointReference) => {
    // Select just this individual point
    store.setSelection({
      pathIds: [],
      points: [connPoint],
    });
  };

  return (
    <div className={styles.section}>
      <div className={styles.sectionTitle}>Snapped With</div>
      {connectedPoints.map((connPoint, idx) => {
        const connPath = paths.find((p) => p.id === connPoint.pathId);
        const pathName = connPath?.name || "Unknown";
        const pointType = connPoint.handleType === "anchor"
          ? "anchor"
          : connPoint.handleType;
        return (
          <div key={idx} className={styles.snapRow}>
            <button
              className={styles.snapInfoButton}
              onClick={() => handleSelectPoint(connPoint)}
              title="Click to select this point"
            >
              {pathName} • {pointType} #{connPoint.segmentIndex}
            </button>
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
function AnchorProperties(
  { path, pathId, segmentIndex }: {
    path: Path;
    pathId: string;
    segmentIndex: number;
  },
) {
  const meta = path.anchorMeta[segmentIndex];

  // For open paths, the final anchor (segmentIndex === segments.length) has no outgoing segment
  const isFinalAnchorOfOpenPath = !path.closed &&
    segmentIndex === path.segments.length;
  // For open paths, the first anchor (segmentIndex === 0) has no incoming segment
  const isFirstAnchorOfOpenPath = !path.closed && segmentIndex === 0;

  // Get the segment that starts at this anchor (if any)
  const segment = isFinalAnchorOfOpenPath ? null : path.segments[segmentIndex];
  // Get the segment that ends at this anchor (if any)
  const prevSegIdx = segmentIndex === 0
    ? path.segments.length - 1
    : segmentIndex - 1;
  const prevSegment = isFirstAnchorOfOpenPath
    ? null
    : path.segments[prevSegIdx];

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
        <div className={styles.sectionTitle}>Anchor #{segmentIndex}</div>
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
            <span
              className={styles.clickableHandle}
              onClick={() => store.selectPoint({ pathId, segmentIndex, handleType: "c0" })}
              title="Click to select this handle"
            >Right Handle (c0)</span>
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
            <span
              className={styles.clickableHandle}
              onClick={() => store.selectPoint({ pathId, segmentIndex: prevSegIdx, handleType: "c1" })}
              title="Click to select this handle"
            >Left Handle (c1)</span>
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
              onChange={() =>
                store.setMirrorAngle(pathId, segmentIndex, !meta.mirrorAngle)}
            />
            <label htmlFor="mirrorAngle">Lock angles (180°)</label>
          </div>
          <div className={styles.checkboxRow}>
            <input
              type="checkbox"
              id="mirrorDistance"
              checked={meta.mirrorDistance}
              onChange={() =>
                store.setMirrorDistance(
                  pathId,
                  segmentIndex,
                  !meta.mirrorDistance,
                )}
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
            onChange={(e) =>
              store.setAnchorColorLive(pathId, segmentIndex, e.target.value)}
          />
          <span className={styles.colorValue}>
            {meta.color || `(inherit: ${path.fill})`}
          </span>
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

      <SnapConnectionsSection
        pathId={pathId}
        segmentIndex={segmentIndex}
        handleType="anchor"
      />
    </div>
  );
}

// Control point properties (c0 or c1)
function ControlPointProperties(
  { path, pathId, segmentIndex, handleType }: {
    path: Path;
    pathId: string;
    segmentIndex: number;
    handleType: "c0" | "c1";
  },
) {
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
  const vecX = controlPoint.x - anchor.x;
  const vecY = controlPoint.y - anchor.y;
  const magnitude = Math.sqrt(vecX * vecX + vecY * vecY);
  const angle = Math.atan2(vecY, vecX) * (180 / Math.PI);

  const handleAngleChange = (value: string) => {
    const newAngle = parseFloat(value);
    if (isNaN(newAngle)) return;
    const newAngleRad = newAngle * (Math.PI / 180);
    // Keep the same magnitude, change the angle
    const newX = anchor.x + Math.cos(newAngleRad) * magnitude;
    const newY = anchor.y + Math.sin(newAngleRad) * magnitude;
    const dx = newX - controlPoint.x;
    const dy = newY - controlPoint.y;
    if (dx !== 0 || dy !== 0) {
      store.moveHandleLive(pathId, segmentIndex, handleType, dx, dy);
      store.commitMoveHandle(pathId, segmentIndex, handleType, dx, dy);
    }
  };

  const handleMagnitudeChange = (value: string) => {
    const newMagnitude = parseFloat(value);
    if (isNaN(newMagnitude) || newMagnitude < 0) return;
    if (magnitude < 0.001) return; // Can't scale from zero
    // Keep the same direction, change the magnitude
    const scale = newMagnitude / magnitude;
    const newX = anchor.x + vecX * scale;
    const newY = anchor.y + vecY * scale;
    const dx = newX - controlPoint.x;
    const dy = newY - controlPoint.y;
    if (dx !== 0 || dy !== 0) {
      store.moveHandleLive(pathId, segmentIndex, handleType, dx, dy);
      store.commitMoveHandle(pathId, segmentIndex, handleType, dx, dy);
    }
  };

  return (
    <div className={styles.properties}>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>
          Control Point {handleType} #{segmentIndex}
        </div>
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
        <div className={styles.sectionTitle}>
          <span>Relative to <span
            className={styles.clickableHandle}
            onClick={() => store.selectPoint({ pathId, segmentIndex: anchorIndex, handleType: "anchor" })}
            title="Click to select the anchor"
          >Anchor #{anchorIndex}</span></span>
        </div>
        <div className={styles.row}>
          <label>Angle</label>
          <NumberInput
            value={angle}
            step="1"
            onChange={handleAngleChange}
          />
          <span className={styles.unit}>°</span>
        </div>
        <div className={styles.row}>
          <label>Dist</label>
          <NumberInput
            value={magnitude}
            step="0.01"
            onChange={handleMagnitudeChange}
          />
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Mirror to Other Handle</div>
        {!otherHandleActive && (
          <div className={styles.hint}>
            Checking will create the other handle
          </div>
        )}
        <div className={styles.checkboxRow}>
          <input
            type="checkbox"
            id="mirrorAngle"
            checked={meta.mirrorAngle}
            onChange={() =>
              store.setMirrorAngle(
                pathId,
                anchorIndex,
                !meta.mirrorAngle,
                handleType,
              )}
          />
          <label htmlFor="mirrorAngle">Lock angles (180°)</label>
        </div>
        <div className={styles.checkboxRow}>
          <input
            type="checkbox"
            id="mirrorDistance"
            checked={meta.mirrorDistance}
            onChange={() =>
              store.setMirrorDistance(
                pathId,
                anchorIndex,
                !meta.mirrorDistance,
                handleType,
              )}
          />
          <label htmlFor="mirrorDistance">Lock magnitudes</label>
        </div>
      </div>

      <SnapConnectionsSection
        pathId={pathId}
        segmentIndex={segmentIndex}
        handleType={handleType}
      />
    </div>
  );
}

// Keyframe property input with live updates during typing (supports multi-selection)
// Get the base value for a property (the value at t=0, or the path's inherent property)
function getBasePropertyValue(
  pathId: string,
  property: AnimatableProperty,
): number {
  const { paths } = store.getState();
  const path = paths.find((p) => p.id === pathId);
  if (!path) return defaultPropertyValues[property];

  switch (property) {
    case "rot":
      // Base rotation is the path's geometric angle (in radians for animation, but PCA returns degrees)
      return getPathAngle(path) * (Math.PI / 180);
    case "tx":
    case "ty":
      // Base translation is 0 (path is at its geometric position)
      return 0;
    case "scale":
      return 1;
    case "opacity":
      return path.opacity;
    default:
      return defaultPropertyValues[property];
  }
}

function KeyframePropertyInput({
  clipId,
  pathIds,
  property,
  pathTimeMap,
  value,
  step,
  decimals,
}: {
  clipId: string;
  pathIds: string[];
  property: AnimatableProperty;
  pathTimeMap: Map<string, number>;
  value: number;
  step: string;
  decimals: number;
}) {
  const [localValue, setLocalValue] = useState(formatNumber(value, decimals));
  const [isFocused, setIsFocused] = useState(false);
  const [absoluteMode, setAbsoluteMode] = useState(false);
  const prevAnimationsRef = useRef<Map<string, PartAnimation> | null>(null);
  // Track which keyframe we're editing to detect when it changes
  // Use the first path's time as a representative for comparison
  const firstKeyframeTime = pathTimeMap.get(pathIds[0]) ?? 0;
  const editingKeyframeRef = useRef<{ pathIds: string[]; time: number } | null>(
    null,
  );

  // Calculate absolute value
  // For single path: base + relative = absolute
  // For multi path in abs mode: use first path's base to display, but apply target angle to all
  const baseValue = getBasePropertyValue(pathIds[0], property);

  // For rotation, convert radians to degrees for display
  const isRotation = property === "rot";
  const displayValue = absoluteMode
    ? (isRotation ? (baseValue + value) * (180 / Math.PI) : baseValue + value)
    : (isRotation ? value * (180 / Math.PI) : value);

  // Update local value when external value changes (but not while focused on SAME keyframe)
  useEffect(() => {
    // If keyframe changed (different paths or time), always update even if focused
    const keyframeChanged = editingKeyframeRef.current &&
      (JSON.stringify(editingKeyframeRef.current.pathIds) !==
          JSON.stringify(pathIds) ||
        Math.abs(editingKeyframeRef.current.time - firstKeyframeTime) > 0.0001);

    if (!isFocused || keyframeChanged) {
      setLocalValue(formatNumber(displayValue, decimals));
      // If keyframe changed while focused, commit any pending changes
      if (keyframeChanged && isFocused) {
        setIsFocused(false);
        if (prevAnimationsRef.current !== null) {
          store.commitKeyframePropertyMulti(clipId, prevAnimationsRef.current);
          prevAnimationsRef.current = null;
        }
        editingKeyframeRef.current = null;
      }
    }
  }, [displayValue, decimals, isFocused, pathIds, firstKeyframeTime, clipId]);

  // Update local value when switching modes
  useEffect(() => {
    if (!isFocused) {
      setLocalValue(formatNumber(displayValue, decimals));
    }
  }, [absoluteMode]);

  const handleFocus = () => {
    setIsFocused(true);
    // Track which keyframe we're editing
    editingKeyframeRef.current = { pathIds, time: firstKeyframeTime };
    // Capture the animation state before editing starts for all paths
    const clip = store.getState().animationClips.find((c) => c.id === clipId);
    const prevAnimations = new Map<string, PartAnimation>();
    for (const pathId of pathIds) {
      prevAnimations.set(pathId, clip?.parts[pathId] ?? []);
    }
    prevAnimationsRef.current = prevAnimations;
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    setLocalValue(newValue);
    // Live update for immediate visual feedback
    const num = parseFloat(newValue);
    if (!isNaN(num)) {
      if (absoluteMode) {
        // In absolute mode, set each path to the target absolute value
        // This means each path gets a different relative value based on its own base
        const targetAbsolute = isRotation ? num * (Math.PI / 180) : num;
        for (const pathId of pathIds) {
          const pathBase = getBasePropertyValue(pathId, property);
          const relativeValue = targetAbsolute - pathBase;
          const pathTime = pathTimeMap.get(pathId) ?? firstKeyframeTime;
          store.setKeyframePropertyLive(clipId, pathId, property, pathTime, relativeValue);
        }
      } else {
        // In relative mode, apply the same relative value to all paths
        // Each path uses its own selected keyframe time
        const relativeValue = isRotation ? num * (Math.PI / 180) : num;
        store.setKeyframePropertyLiveMulti(
          clipId,
          pathTimeMap,
          property,
          relativeValue,
        );
      }
    }
  };

  const handleBlur = () => {
    setIsFocused(false);
    // Commit the change to undo stack
    if (prevAnimationsRef.current !== null) {
      store.commitKeyframePropertyMulti(clipId, prevAnimationsRef.current);
      prevAnimationsRef.current = null;
    }
    // Format on blur
    const num = parseFloat(localValue);
    if (!isNaN(num)) {
      setLocalValue(formatNumber(num, decimals));
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Pressing '-' anywhere negates the value (without moving cursor or reformatting)
    if (e.key === "-") {
      const num = parseFloat(localValue);
      if (!isNaN(num)) {
        e.preventDefault();
        const input = e.currentTarget;
        const cursorPos = input.selectionStart;
        const negated = -num;
        // Convert to string without reformatting
        const newValueStr = String(negated);
        setLocalValue(newValueStr);
        // Live update
        if (absoluteMode) {
          // In absolute mode, set each path to the target absolute value
          const targetAbsolute = isRotation ? negated * (Math.PI / 180) : negated;
          for (const pathId of pathIds) {
            const pathBase = getBasePropertyValue(pathId, property);
            const relativeValue = targetAbsolute - pathBase;
            const pathTime = pathTimeMap.get(pathId) ?? firstKeyframeTime;
            store.setKeyframePropertyLive(clipId, pathId, property, pathTime, relativeValue);
          }
        } else {
          // In relative mode, apply the same relative value to all paths
          const relativeValue = isRotation ? negated * (Math.PI / 180) : negated;
          store.setKeyframePropertyLiveMulti(
            clipId,
            pathTimeMap,
            property,
            relativeValue,
          );
        }
        // Restore cursor position after React updates the input
        requestAnimationFrame(() => {
          // Adjust cursor position: if we added/removed a minus sign, shift accordingly
          if (cursorPos !== null) {
            const hadMinus = num < 0;
            const hasMinus = negated < 0;
            let newPos = cursorPos;
            if (!hadMinus && hasMinus) {
              // Added minus sign, shift cursor right by 1
              newPos = cursorPos + 1;
            } else if (hadMinus && !hasMinus) {
              // Removed minus sign, shift cursor left by 1 (but not below 0)
              newPos = Math.max(0, cursorPos - 1);
            }
            input.setSelectionRange(newPos, newPos);
          }
        });
      }
    }
  };

  // Show absolute toggle for rotation (works for both single and multi-path)
  const showAbsoluteToggle = isRotation;

  return (
    <>
      <input
        type="number"
        step={step}
        value={localValue}
        onChange={handleChange}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
      />
      {showAbsoluteToggle && (
        <button
          className={styles.resetButton}
          onClick={() => setAbsoluteMode(!absoluteMode)}
          style={{
            background: absoluteMode ? "#4488ff" : undefined,
            color: absoluteMode ? "#fff" : undefined,
          }}
          title={absoluteMode
            ? "Showing absolute angle (click for relative)"
            : "Showing relative offset (click for absolute)"}
        >
          Abs
        </button>
      )}
    </>
  );
}

// Unified keyframe properties editor - shows all properties in a single keyframe
// Supports multi-selection: edits apply to all selected paths
function UnifiedKeyframeProperties({
  clipId,
  pathIds,
  pathNames,
  clipName,
  keyframe,
  pathTimeMap,
  clipDuration,
}: {
  clipId: string;
  pathIds: string[];
  pathNames: string[];
  clipName: string;
  keyframe: UnifiedKeyframe;
  pathTimeMap: Map<string, number>;
  clipDuration: number;
}) {
  const [editingTime, setEditingTime] = useState(false);
  const [timeValue, setTimeValue] = useState(keyframe.t.toFixed(3));

  // Update time value when keyframe changes
  useEffect(() => {
    if (!editingTime) {
      setTimeValue(keyframe.t.toFixed(3));
    }
  }, [keyframe.t, editingTime]);

  const handlePropertyToggle = (
    property: AnimatableProperty,
    isSet: boolean,
  ) => {
    if (isSet) {
      // Unset the property on all selected paths at their respective times
      store.unsetKeyframePropertyMulti(clipId, pathTimeMap, property);
    } else {
      // Set the property to its default value on all selected paths at their respective times
      store.setKeyframePropertyMulti(
        clipId,
        pathTimeMap,
        property,
        defaultPropertyValues[property],
      );
    }
  };

  const handleTimeChange = () => {
    const newTime = parseFloat(timeValue);
    if (
      !isNaN(newTime) && newTime >= 0 && newTime <= clipDuration &&
      Math.abs(newTime - keyframe.t) > 0.0001
    ) {
      store.changeKeyframeTimeMulti(clipId, pathIds, keyframe.t, newTime);
    }
    setEditingTime(false);
  };

  const handleDelete = () => {
    store.deleteKeyframeMulti(clipId, pathIds, keyframe.t);
    store.clearKeyframeSelection();
  };

  // Snap rotation to a specific angle (used when property is not yet set)
  const handleSnapToAngle = (targetDegrees: number) => {
    // For each path, calculate the relative rotation needed to achieve the target absolute angle
    for (const pathId of pathIds) {
      const pathBase = getBasePropertyValue(pathId, "rot");
      const targetAbsolute = targetDegrees * (Math.PI / 180);
      const relativeValue = targetAbsolute - pathBase;
      const pathTime = pathTimeMap.get(pathId) ?? keyframe.t;
      store.setKeyframeProperty(clipId, pathId, "rot", pathTime, relativeValue);
    }
  };

  // Copy property value from adjacent keyframe (left or right)
  const handleCopyFromAdjacent = (property: AnimatableProperty, direction: "left" | "right") => {
    const clip = store.getState().animationClips.find((c) => c.id === clipId);
    if (!clip) return;

    for (const pathId of pathIds) {
      const pathTime = pathTimeMap.get(pathId) ?? keyframe.t;
      const partAnim = clip.parts[pathId] ?? [];

      // Find adjacent keyframe with this property set
      let adjacentKf: { t: number; value: number } | null = null;

      if (direction === "left") {
        // Find the closest keyframe to the left that has this property
        for (const kf of partAnim) {
          if (kf.t < pathTime - 0.0001 && kf[property] !== undefined) {
            if (!adjacentKf || kf.t > adjacentKf.t) {
              adjacentKf = { t: kf.t, value: kf[property]! };
            }
          }
        }
      } else {
        // Find the closest keyframe to the right that has this property
        for (const kf of partAnim) {
          if (kf.t > pathTime + 0.0001 && kf[property] !== undefined) {
            if (!adjacentKf || kf.t < adjacentKf.t) {
              adjacentKf = { t: kf.t, value: kf[property]! };
            }
          }
        }
      }

      if (adjacentKf) {
        store.setKeyframeProperty(clipId, pathId, property, pathTime, adjacentKf.value);
      }
    }
  };

  // Check if there's a keyframe with the property to the left/right
  const hasAdjacentKeyframe = (property: AnimatableProperty, direction: "left" | "right"): boolean => {
    const clip = store.getState().animationClips.find((c) => c.id === clipId);
    if (!clip) return false;

    // Check if any selected path has an adjacent keyframe with this property
    for (const pathId of pathIds) {
      const pathTime = pathTimeMap.get(pathId) ?? keyframe.t;
      const partAnim = clip.parts[pathId] ?? [];

      for (const kf of partAnim) {
        if (direction === "left") {
          if (kf.t < pathTime - 0.0001 && kf[property] !== undefined) {
            return true;
          }
        } else {
          if (kf.t > pathTime + 0.0001 && kf[property] !== undefined) {
            return true;
          }
        }
      }
    }
    return false;
  };

  // Get which properties are currently set
  const setProperties = ANIMATABLE_PROPERTIES.filter((p) =>
    keyframe[p] !== undefined
  );

  // Determine step and decimals based on property
  const getInputConfig = (property: AnimatableProperty) => {
    switch (property) {
      case "tx":
      case "ty":
        return { step: "0.1", decimals: 3 };
      case "rot":
        return { step: "0.01", decimals: 3 };
      case "scale":
        return { step: "0.01", decimals: 3 };
      case "opacity":
        return { step: "0.01", decimals: 2 };
    }
  };

  const isMultiSelection = pathIds.length > 1;
  const displayName = isMultiSelection
    ? `${pathIds.length} paths`
    : pathNames[0] ?? "Unknown";

  return (
    <div className={styles.properties}>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Keyframe</div>
        <div className={styles.row}>
          <label>Clip</label>
          <span className={styles.value}>{clipName}</span>
        </div>
        <div className={styles.row}>
          <label>{isMultiSelection ? "Paths" : "Path"}</label>
          <span className={styles.value} title={pathNames.join(", ")}>
            {displayName}
          </span>
        </div>
        <div className={styles.row}>
          <label>Time</label>
          {editingTime
            ? (
              <input
                type="number"
                step="0.001"
                min={0}
                max={clipDuration}
                value={timeValue}
                onChange={(e) => setTimeValue(e.target.value)}
                onBlur={handleTimeChange}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleTimeChange();
                  if (e.key === "Escape") {
                    setTimeValue(keyframe.t.toFixed(3));
                    setEditingTime(false);
                  }
                }}
                autoFocus
              />
            )
            : (
              <span
                className={styles.value}
                style={{ cursor: "pointer" }}
                onClick={() => setEditingTime(true)}
                title="Click to edit time"
              >
                {keyframe.t.toFixed(3)}s
              </span>
            )}
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Properties</div>
        {ANIMATABLE_PROPERTIES.map((prop) => {
          const isSet = keyframe[prop] !== undefined;
          const value = keyframe[prop] ?? defaultPropertyValues[prop];
          const config = getInputConfig(prop);
          return (
            <div key={prop} className={styles.row}>
              <input
                type="checkbox"
                checked={isSet}
                onChange={() => handlePropertyToggle(prop, isSet)}
                title={isSet ? "Unset this property" : "Set this property"}
                style={{ marginRight: 4 }}
              />
              <label style={{ color: propertyColors[prop], minWidth: 50 }}>
                {PROPERTY_LABELS[prop]}
              </label>
              {isSet
                ? (
                  <KeyframePropertyInput
                    clipId={clipId}
                    pathIds={pathIds}
                    property={prop}
                    pathTimeMap={pathTimeMap}
                    value={value}
                    step={config.step}
                    decimals={config.decimals}
                  />
                )
                : (
                  <span className={styles.buttonGroup}>
                    <button
                      className={styles.resetButton}
                      onClick={() => handleCopyFromAdjacent(prop, "left")}
                      disabled={!hasAdjacentKeyframe(prop, "left")}
                      title="Copy from keyframe to the left"
                      style={{ opacity: hasAdjacentKeyframe(prop, "left") ? 1 : 0.3 }}
                    >
                      ←
                    </button>
                    <button
                      className={styles.resetButton}
                      onClick={() => handleCopyFromAdjacent(prop, "right")}
                      disabled={!hasAdjacentKeyframe(prop, "right")}
                      title="Copy from keyframe to the right"
                      style={{ opacity: hasAdjacentKeyframe(prop, "right") ? 1 : 0.3 }}
                    >
                      →
                    </button>
                    {prop === "rot" && (
                      <>
                        <button
                          className={styles.resetButton}
                          onClick={() => handleSnapToAngle(0)}
                          title="Set to horizontal (0°)"
                        >
                          ―
                        </button>
                        <button
                          className={styles.resetButton}
                          onClick={() => handleSnapToAngle(90)}
                          title="Set to vertical (90°)"
                        >
                          |
                        </button>
                      </>
                    )}
                  </span>
                )}
            </div>
          );
        })}
      </div>

      <div className={styles.section}>
        <button className={styles.deleteButton} onClick={handleDelete}>
          Delete Keyframe
        </button>
      </div>
    </div>
  );
}
