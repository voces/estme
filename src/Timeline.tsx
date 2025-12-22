import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { store, useStore } from "./store/index.ts";
import { AnimatableProperty, AnimationClip, createDefaultClip, propertyColors, ANIMATABLE_PROPERTIES, UnifiedKeyframe, defaultPropertyValues, PartAnimation } from "./animation.ts";
import styles from "./Timeline.module.css";
import { Group, Path } from "./types.ts";

const PROPERTY_LABELS: Record<AnimatableProperty, string> = {
  tx: "X",
  ty: "Y",
  rot: "Rot",
  scale: "Scale",
  opacity: "Opacity",
};

// A node in the hierarchy tree (either a group or a path)
type HierarchyNode =
  | { type: "group"; group: Group; children: HierarchyNode[] }
  | { type: "path"; path: Path };

// Build a tree structure from flat paths and groups
function buildHierarchy(paths: Path[], groups: Group[]): HierarchyNode[] {
  const groupMap = new Map<string, Group>();
  for (const group of groups) {
    groupMap.set(group.id, group);
  }

  // Build children lookup
  const childGroups = new Map<string | null, Group[]>();
  const childPaths = new Map<string | null, Path[]>();

  for (const group of groups) {
    const parentId = group.parentId;
    if (!childGroups.has(parentId)) {
      childGroups.set(parentId, []);
    }
    childGroups.get(parentId)!.push(group);
  }

  for (const path of paths) {
    const parentId = path.parentId;
    if (!childPaths.has(parentId)) {
      childPaths.set(parentId, []);
    }
    childPaths.get(parentId)!.push(path);
  }

  // Recursively build tree
  function buildNode(parentId: string | null): HierarchyNode[] {
    const result: HierarchyNode[] = [];

    // Add child groups first
    const cGroups = childGroups.get(parentId) ?? [];
    for (const group of cGroups) {
      result.push({
        type: "group",
        group,
        children: buildNode(group.id),
      });
    }

    // Then add child paths
    const cPaths = childPaths.get(parentId) ?? [];
    for (const path of cPaths) {
      result.push({ type: "path", path });
    }

    return result;
  }

  return buildNode(null);
}

export const Timeline = () => {
  const clips = useStore((s) => s.animationClips);
  const currentClipId = useStore((s) => s.currentClipId);
  const playbackTime = useStore((s) => s.playbackTime);
  const isPlaying = useStore((s) => s.isPlaying);
  const paths = useStore((s) => s.paths);
  const groups = useStore((s) => s.groups);
  const selection = useStore((s) => s.selection);

  const currentClip = useMemo(
    () => clips.find((c) => c.id === currentClipId) ?? null,
    [clips, currentClipId]
  );

  // Build hierarchy tree
  const hierarchy = useMemo(() => buildHierarchy(paths, groups), [paths, groups]);

  // Track expanded items (both groups and paths for property expansion)
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());
  const selectedKeyframe = useStore((s) => s.selectedKeyframe);

  // Clip renaming state
  const [isRenamingClip, setIsRenamingClip] = useState(false);
  const [clipNameValue, setClipNameValue] = useState("");

  const rulerRef = useRef<HTMLDivElement>(null);
  const tracksContainerRef = useRef<HTMLDivElement>(null);
  const [isDraggingPlayhead, setIsDraggingPlayhead] = useState(false);

  // Keyframe dragging state
  const [draggingKeyframe, setDraggingKeyframe] = useState<{
    pathId: string;
    originalTime: number;
  } | null>(null);

  // Playback loop
  useEffect(() => {
    if (!isPlaying || !currentClip) return;

    let lastTime = performance.now();
    let animationId: number;

    const tick = (now: number) => {
      const dt = (now - lastTime) / 1000;
      lastTime = now;

      let newTime = store.getState().playbackTime + dt;
      if (newTime >= currentClip.duration) {
        newTime = 0; // Loop
      }
      store.setPlaybackTime(newTime);

      animationId = requestAnimationFrame(tick);
    };

    animationId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animationId);
  }, [isPlaying, currentClip]);

  const handleAddClip = useCallback(() => {
    const name = `clip_${clips.length + 1}`;
    store.addAnimationClip(createDefaultClip(name));
  }, [clips.length]);

  const handleDeleteClip = useCallback(() => {
    if (currentClipId) {
      store.deleteAnimationClip(currentClipId);
    }
  }, [currentClipId]);

  const handleClipChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    store.selectAnimationClip(e.target.value || null);
  }, []);

  const handleStartRename = useCallback(() => {
    if (currentClip) {
      setClipNameValue(currentClip.name);
      setIsRenamingClip(true);
    }
  }, [currentClip]);

  const handleFinishRename = useCallback(() => {
    if (currentClipId && clipNameValue.trim()) {
      store.updateAnimationClip(currentClipId, { name: clipNameValue.trim() });
    }
    setIsRenamingClip(false);
  }, [currentClipId, clipNameValue]);

  const handleDurationChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!currentClipId) return;
      const duration = parseFloat(e.target.value);
      if (!isNaN(duration) && duration > 0) {
        store.updateAnimationClip(currentClipId, { duration });
      }
    },
    [currentClipId]
  );

  const toggleExpanded = useCallback((itemId: string) => {
    setExpandedItems((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) {
        next.delete(itemId);
      } else {
        next.add(itemId);
      }
      return next;
    });
  }, []);

  const xToTime = useCallback(
    (x: number, containerWidth: number): number => {
      if (!currentClip || containerWidth === 0) return 0;
      return Math.max(0, Math.min(currentClip.duration, (x / containerWidth) * currentClip.duration));
    },
    [currentClip]
  );

  // Playhead dragging
  const handleRulerMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!rulerRef.current || !currentClip) return;
      e.preventDefault(); // Prevent text selection while dragging
      const rect = rulerRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const time = xToTime(x, rect.width);
      store.setPlaybackTime(time);
      setIsDraggingPlayhead(true);
    },
    [currentClip, xToTime]
  );

  useEffect(() => {
    if (!isDraggingPlayhead) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!rulerRef.current) return;
      const rect = rulerRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const time = xToTime(x, rect.width);
      store.setPlaybackTime(time);
    };

    const handleMouseUp = () => {
      setIsDraggingPlayhead(false);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDraggingPlayhead, xToTime]);

  // Generate ruler ticks
  const rulerTicks = useMemo(() => {
    if (!currentClip) return [];
    const ticks: { time: number; major: boolean }[] = [];
    const step = currentClip.duration <= 2 ? 0.1 : currentClip.duration <= 10 ? 0.5 : 1;
    for (let t = 0; t <= currentClip.duration; t += step) {
      const isMajor = Math.abs(t - Math.round(t)) < 0.001;
      ticks.push({ time: t, major: isMajor || step >= 1 });
    }
    return ticks;
  }, [currentClip]);

  // Track pending drag (before threshold is met)
  const [pendingDrag, setPendingDrag] = useState<{
    pathId: string;
    originalTime: number;
    startX: number;
    startTime: number; // timestamp when mouse was pressed
  } | null>(null);

  // Handle unified keyframe mouse down (for dragging)
  const handleKeyframeMouseDown = useCallback(
    (e: React.MouseEvent, pathId: string, time: number) => {
      e.stopPropagation();
      e.preventDefault();
      // Select this keyframe
      store.selectKeyframe({ pathId, time });
      store.setPlaybackTime(time);
      // Set up pending drag - actual drag starts after threshold
      setPendingDrag({ pathId, originalTime: time, startX: e.clientX, startTime: Date.now() });
    },
    []
  );

  // Handle pending drag -> actual drag transition
  useEffect(() => {
    if (!pendingDrag) return;

    const DRAG_THRESHOLD_PX = 5; // pixels
    const DRAG_THRESHOLD_MS = 200; // milliseconds

    const handleMouseMove = (e: MouseEvent) => {
      const dx = Math.abs(e.clientX - pendingDrag.startX);
      const elapsed = Date.now() - pendingDrag.startTime;
      // Start drag if either distance OR time threshold is met
      if (dx >= DRAG_THRESHOLD_PX || elapsed >= DRAG_THRESHOLD_MS) {
        // Threshold met, start actual drag
        setDraggingKeyframe({ pathId: pendingDrag.pathId, originalTime: pendingDrag.originalTime });
        setPendingDrag(null);
      }
    };

    const handleMouseUp = () => {
      // Mouse up before threshold - just a click, no drag
      setPendingDrag(null);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [pendingDrag]);

  const SNAP_THRESHOLD = 0.02; // Time threshold for snapping (in seconds)

  // Helper to get all keyframe times from other paths (for snapping)
  const getOtherKeyframeTimes = useCallback((excludePathId: string): number[] => {
    if (!currentClip) return [];
    const times = new Set<number>();
    for (const [partId, partAnim] of Object.entries(currentClip.parts)) {
      if (partId === excludePathId) continue;
      for (const kf of partAnim) {
        times.add(kf.t);
      }
    }
    return Array.from(times).sort((a, b) => a - b);
  }, [currentClip]);

  // Helper to snap a time value to nearby keyframes from other paths
  const snapTimeToOtherKeyframes = useCallback((time: number, excludePathId: string): number => {
    const otherTimes = getOtherKeyframeTimes(excludePathId);
    for (const snapTime of otherTimes) {
      if (Math.abs(time - snapTime) < SNAP_THRESHOLD) {
        return snapTime;
      }
    }
    return time;
  }, [getOtherKeyframeTimes]);

  // Collect all keyframe times from other paths for snapping (used during drag)
  const otherKeyframeTimes = useMemo(() => {
    if (!currentClip || !draggingKeyframe) return [];
    return getOtherKeyframeTimes(draggingKeyframe.pathId);
  }, [currentClip, draggingKeyframe?.pathId, getOtherKeyframeTimes]);

  // Handle keyframe drag
  useEffect(() => {
    if (!draggingKeyframe || !currentClipId || !tracksContainerRef.current) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!tracksContainerRef.current || !currentClip) return;
      const rect = tracksContainerRef.current.getBoundingClientRect();
      // Account for 150px label column offset
      const labelWidth = 150;
      const x = e.clientX - rect.left - labelWidth;
      const keyframeAreaWidth = rect.width - labelWidth;
      let newTime = xToTime(x, keyframeAreaWidth);

      // Snap to other keyframes if close enough
      for (const snapTime of otherKeyframeTimes) {
        if (Math.abs(newTime - snapTime) < SNAP_THRESHOLD) {
          newTime = snapTime;
          break;
        }
      }

      // Only update if time actually changed
      const selectedKf = store.getState().selectedKeyframe;
      if (selectedKf && Math.abs(selectedKf.time - newTime) > 0.001) {
        store.changeKeyframeTime(
          currentClipId,
          draggingKeyframe.pathId,
          selectedKf.time,
          newTime
        );
      }
    };

    const handleMouseUp = () => {
      setDraggingKeyframe(null);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [draggingKeyframe, currentClipId, currentClip, xToTime, otherKeyframeTimes]);

  // Handle double-click on track to add empty keyframe (no properties set)
  const handleTrackDoubleClick = useCallback(
    (e: React.MouseEvent, pathId: string) => {
      if (!currentClipId) return;
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const x = e.clientX - rect.left;
      const rawTime = xToTime(x, rect.width);
      // Snap to keyframes from other paths
      const time = snapTimeToOtherKeyframes(rawTime, pathId);

      // Create an empty keyframe (user will tick properties they want)
      store.createEmptyKeyframe(currentClipId, pathId, time);
      // Select the new keyframe and move scrubber to that time
      store.selectKeyframe({ pathId, time });
      store.setPlaybackTime(time);
    },
    [currentClipId, xToTime, snapTimeToOtherKeyframes]
  );

  // Handle double-click on property row to add single property keyframe
  const handlePropertyRowDoubleClick = useCallback(
    (e: React.MouseEvent, pathId: string, property: AnimatableProperty) => {
      if (!currentClipId) return;
      e.stopPropagation();
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const x = e.clientX - rect.left;
      const rawTime = xToTime(x, rect.width);
      // Snap to keyframes from other paths
      const time = snapTimeToOtherKeyframes(rawTime, pathId);

      store.setKeyframeProperty(currentClipId, pathId, property, time, defaultPropertyValues[property]);
    },
    [currentClipId, xToTime, snapTimeToOtherKeyframes]
  );

  // Add keyframe at current playhead position
  const handleAddKeyframeAtPlayhead = useCallback(
    (e: React.MouseEvent, pathId: string, property: AnimatableProperty) => {
      e.stopPropagation();
      if (!currentClipId) return;
      store.setKeyframeProperty(currentClipId, pathId, property, playbackTime, defaultPropertyValues[property]);
    },
    [currentClipId, playbackTime]
  );

  // Delete selected keyframe
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't delete when typing in an input field
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) {
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selectedKeyframe && currentClipId) {
        store.deleteKeyframe(currentClipId, selectedKeyframe.pathId, selectedKeyframe.time);
        store.clearKeyframeSelection();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedKeyframe, currentClipId]);

  // Get properties present in a unified keyframe
  const getKeyframeProperties = (kf: UnifiedKeyframe): AnimatableProperty[] => {
    return ANIMATABLE_PROPERTIES.filter((p) => kf[p] !== undefined);
  };

  // Render a unified track row (label + keyframe area)
  const renderUnifiedTrackRow = (
    id: string,
    name: string,
    isGroup: boolean,
    hasChildren: boolean,
    depth: number,
    partAnim: PartAnimation
  ) => {
    const isExpanded = expandedItems.has(id);
    const isSelected = !isGroup && selection.pathIds.includes(id);
    const paddingLeft = `${0.5 + depth * 0.75}rem`;

    return (
      <div className={styles.unifiedRow}>
        {/* Label area */}
        <div
          className={`${styles.rowLabel} ${isGroup ? styles.groupLabel : ""} ${isSelected ? styles.rowLabelSelected : ""}`}
          onClick={() => toggleExpanded(id)}
          style={{ paddingLeft }}
        >
          <span className={styles.trackExpand}>
            {(hasChildren || !isGroup) ? (isExpanded ? "▼" : "▶") : ""}
          </span>
          <span className={styles.trackName}>{name}</span>
        </div>
        {/* Keyframe area */}
        <div
          className={styles.rowKeyframes}
          onDoubleClick={(e) => handleTrackDoubleClick(e, id)}
        >
          {partAnim.map((kf) => {
            const properties = getKeyframeProperties(kf);
            const isKfSelected = selectedKeyframe &&
              selectedKeyframe.pathId === id &&
              Math.abs(selectedKeyframe.time - kf.t) < 0.0001;
            return (
              <div
                key={kf.t}
                className={`${styles.unifiedKeyframe} ${isKfSelected ? styles.keyframeSelected : ""}`}
                style={{
                  left: `${(kf.t / (currentClip?.duration ?? 1)) * 100}%`,
                  cursor: draggingKeyframe ? "ew-resize" : "pointer",
                }}
                onMouseDown={(e) => handleKeyframeMouseDown(e, id, kf.t)}
              >
                {properties.length === 0 ? (
                  <div
                    className={styles.emptyPip}
                    title="Empty keyframe (no properties set)"
                  />
                ) : (
                  properties.map((prop) => (
                    <div
                      key={prop}
                      className={styles.propertyPip}
                      style={{ backgroundColor: propertyColors[prop] }}
                      title={PROPERTY_LABELS[prop]}
                    />
                  ))
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  // Render property rows (label + keyframe area)
  const renderPropertyRow = (
    id: string,
    prop: AnimatableProperty,
    depth: number,
    partAnim: PartAnimation
  ) => {
    const keyframesWithProp = partAnim.filter((kf) => kf[prop] !== undefined);
    const paddingLeft = `${1.5 + depth * 0.75}rem`;

    return (
      <div key={prop} className={styles.unifiedRow}>
        {/* Label area */}
        <div className={styles.rowLabel} style={{ paddingLeft }}>
          <span
            className={styles.propertyLabel}
            style={{ color: propertyColors[prop] }}
          >
            {PROPERTY_LABELS[prop]}
          </span>
          <button
            className={styles.addKeyframeBtn}
            onClick={(e) => handleAddKeyframeAtPlayhead(e, id, prop)}
            title="Add keyframe at playhead"
          >
            +
          </button>
        </div>
        {/* Keyframe area */}
        <div
          className={styles.rowKeyframes}
          onDoubleClick={(e) => handlePropertyRowDoubleClick(e, id, prop)}
        >
          {keyframesWithProp.map((kf) => {
            const isSelected = selectedKeyframe &&
              selectedKeyframe.pathId === id &&
              Math.abs(selectedKeyframe.time - kf.t) < 0.0001;
            return (
              <div
                key={kf.t}
                className={`${styles.keyframe} ${isSelected ? styles.keyframeSelected : ""}`}
                style={{
                  left: `${(kf.t / (currentClip?.duration ?? 1)) * 100}%`,
                  backgroundColor: propertyColors[prop],
                  cursor: draggingKeyframe ? "ew-resize" : "pointer",
                }}
                onMouseDown={(e) => handleKeyframeMouseDown(e, id, kf.t)}
              />
            );
          })}
        </div>
      </div>
    );
  };

  // Render unified nodes recursively (label + keyframes together)
  const renderUnifiedNodes = (nodes: HierarchyNode[], depth: number): React.ReactNode => {
    return nodes.map((node) => {
      if (node.type === "group") {
        const isExpanded = expandedItems.has(node.group.id);
        const partAnim = currentClip?.parts[node.group.id] ?? [];
        return (
          <div key={node.group.id}>
            {renderUnifiedTrackRow(
              node.group.id,
              node.group.name,
              true,
              node.children.length > 0,
              depth,
              partAnim
            )}
            {isExpanded && ANIMATABLE_PROPERTIES.map((prop) =>
              renderPropertyRow(node.group.id, prop, depth, partAnim)
            )}
            {isExpanded && renderUnifiedNodes(node.children, depth + 1)}
          </div>
        );
      } else {
        const isExpanded = expandedItems.has(node.path.id);
        const partAnim = currentClip?.parts[node.path.id] ?? [];
        return (
          <div key={node.path.id}>
            {renderUnifiedTrackRow(
              node.path.id,
              node.path.name,
              false,
              false,
              depth,
              partAnim
            )}
            {isExpanded && ANIMATABLE_PROPERTIES.map((prop) =>
              renderPropertyRow(node.path.id, prop, depth, partAnim)
            )}
          </div>
        );
      }
    });
  };

  if (clips.length === 0) {
    return (
      <div className={styles.timeline}>
        <div className={styles.header}>
          <button className={styles.headerBtn} onClick={handleAddClip}>
            + Add Clip
          </button>
        </div>
        <div className={styles.emptyState}>No animation clips. Add one to get started.</div>
      </div>
    );
  }

  return (
    <div className={styles.timeline}>
      <div className={styles.header}>
        <select className={styles.clipSelect} value={currentClipId ?? ""} onChange={handleClipChange}>
          <option value="">— None —</option>
          {clips.map((clip) => (
            <option key={clip.id} value={clip.id}>
              {clip.name}
            </option>
          ))}
        </select>
        {currentClip && !isRenamingClip && (
          <button
            className={styles.headerBtn}
            onClick={handleStartRename}
            title="Rename clip"
          >
            ✎
          </button>
        )}
        {isRenamingClip && (
          <input
            type="text"
            className={styles.clipNameInput}
            value={clipNameValue}
            onChange={(e) => setClipNameValue(e.target.value)}
            onBlur={handleFinishRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleFinishRename();
              if (e.key === "Escape") setIsRenamingClip(false);
            }}
            autoFocus
          />
        )}
        <button className={styles.headerBtn} onClick={handleAddClip}>
          +
        </button>
        <button className={styles.headerBtn} onClick={handleDeleteClip} disabled={!currentClipId}>
          −
        </button>
        <button
          className={`${styles.headerBtn} ${styles.playBtn}`}
          onClick={() => store.togglePlayback()}
        >
          {isPlaying ? "⏸" : "▶"}
        </button>
        <span className={styles.timeDisplay}>
          {playbackTime.toFixed(2)}s /
          <input
            type="number"
            className={styles.durationInput}
            value={currentClip?.duration ?? 1}
            onChange={handleDurationChange}
            step={0.1}
            min={0.1}
          />
          s
        </span>
      </div>

      <div className={styles.body}>
        {/* Ruler header */}
        <div className={styles.rulerRow}>
          <div className={styles.rulerLabelSpace} />
          <div className={styles.ruler} ref={rulerRef} onMouseDown={handleRulerMouseDown}>
            {rulerTicks.map(({ time, major }) => (
              <div key={time} className={styles.rulerTick} style={{ left: `${(time / (currentClip?.duration ?? 1)) * 100}%` }}>
                {major && <span className={styles.rulerLabel} style={{ left: 0 }}>{time.toFixed(1)}</span>}
              </div>
            ))}
            <div
              className={styles.playheadHandle}
              style={{ left: `${(playbackTime / (currentClip?.duration ?? 1)) * 100}%` }}
            />
          </div>
        </div>

        {/* Unified scrollable tracks area */}
        <div className={styles.tracksContainer} ref={tracksContainerRef}>
          {renderUnifiedNodes(hierarchy, 0)}
          {/* Playhead line - positioned in keyframe area (after 150px label column) */}
          <div
            className={styles.playhead}
            style={{ left: `calc(150px + (100% - 150px) * ${playbackTime / (currentClip?.duration ?? 1)})` }}
          />
        </div>
      </div>
    </div>
  );
};
