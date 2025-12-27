import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { store, useStore } from "./store/index.ts";
import { AnimatableProperty, AnimationClip, createDefaultClip, propertyColors, ANIMATABLE_PROPERTIES, UnifiedKeyframe, PartAnimation, changeKeyframeTime } from "./animation.ts";
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
  const selectedKeyframes = useStore((s) => s.selectedKeyframes);

  // Clip renaming state
  const [isRenamingClip, setIsRenamingClip] = useState(false);
  const [clipNameValue, setClipNameValue] = useState("");

  const rulerRef = useRef<HTMLDivElement>(null);
  const tracksContainerRef = useRef<HTMLDivElement>(null);
  const tracksContentRef = useRef<HTMLDivElement>(null);
  const [isDraggingPlayhead, setIsDraggingPlayhead] = useState(false);

  // Keyframe dragging state - tracks all keyframes being dragged
  const [draggingKeyframes, setDraggingKeyframes] = useState<{
    keyframes: { pathId: string; originalTime: number }[];
    startTime: number; // The time of the clicked keyframe at drag start
    prevAnimations: Map<string, PartAnimation>; // For undo
  } | null>(null);

  // Marquee selection state
  const [marqueeStart, setMarqueeStart] = useState<{ x: number; y: number } | null>(null);
  const [marqueeEnd, setMarqueeEnd] = useState<{ x: number; y: number } | null>(null);
  const [isMarqueeSelecting, setIsMarqueeSelecting] = useState(false);
  const [marqueeShiftHeld, setMarqueeShiftHeld] = useState(false);

  // Keyframe alignment popup state
  const [showAlignPopup, setShowAlignPopup] = useState(false);
  const [alignTimeGap, setAlignTimeGap] = useState(0.1);
  const alignPopupRef = useRef<HTMLDivElement>(null);
  const alignButtonRef = useRef<HTMLDivElement>(null);
  const alignHoldTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alignSnapshotRef = useRef<{
    animations: Map<string, PartAnimation>;
    keyframes: { pathId: string; originalTime: number }[];
    originalSelectedKeyframes: { pathId: string; time: number }[];
  } | null>(null);

  // Keyframe scale popup state
  const [showScalePopup, setShowScalePopup] = useState(false);
  const [scaleDuration, setScaleDuration] = useState(1);
  const scalePopupRef = useRef<HTMLDivElement>(null);
  const scaleButtonRef = useRef<HTMLButtonElement>(null);
  const scaleSnapshotRef = useRef<{
    animations: Map<string, PartAnimation>;
    keyframes: { pathId: string; originalTime: number }[];
    originalSelectedKeyframes: { pathId: string; time: number }[];
    originalDuration: number;
  } | null>(null);

  // Narrow selection depth tracking (for repeat clicks)
  const [narrowFirstDepth, setNarrowFirstDepth] = useState(1);
  const [narrowLastDepth, setNarrowLastDepth] = useState(1);
  const narrowResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset narrow depth when selection changes externally
  useEffect(() => {
    setNarrowFirstDepth(1);
    setNarrowLastDepth(1);
  }, [selectedKeyframes.length]);

  const handleNarrowFirst = useCallback(() => {
    // Clear any pending reset
    if (narrowResetTimerRef.current) {
      clearTimeout(narrowResetTimerRef.current);
    }
    store.narrowToFirst(narrowFirstDepth);
    setNarrowFirstDepth((d) => d + 1);
    setNarrowLastDepth(1); // Reset the other direction
    // Reset depth after 1.5s of inactivity
    narrowResetTimerRef.current = setTimeout(() => {
      setNarrowFirstDepth(1);
    }, 1500);
  }, [narrowFirstDepth]);

  const handleNarrowLast = useCallback(() => {
    // Clear any pending reset
    if (narrowResetTimerRef.current) {
      clearTimeout(narrowResetTimerRef.current);
    }
    store.narrowToLast(narrowLastDepth);
    setNarrowLastDepth((d) => d + 1);
    setNarrowFirstDepth(1); // Reset the other direction
    // Reset depth after 1.5s of inactivity
    narrowResetTimerRef.current = setTimeout(() => {
      setNarrowLastDepth(1);
    }, 1500);
  }, [narrowLastDepth]);

  // Bake down: can only do this when selected keyframes belong to groups with children
  const canBakeDown = useMemo(() => {
    if (!currentClipId || selectedKeyframes.length === 0) return false;
    // At least one selected keyframe must be on a group that has direct children
    for (const kf of selectedKeyframes) {
      const isGroup = groups.some((g) => g.id === kf.pathId);
      if (isGroup) {
        const childPaths = paths.filter((p) => p.parentId === kf.pathId);
        const childGroups = groups.filter((g) => g.parentId === kf.pathId);
        if (childPaths.length > 0 || childGroups.length > 0) {
          return true;
        }
      }
    }
    return false;
  }, [currentClipId, selectedKeyframes, groups, paths]);

  const handleBakeDown = useCallback(() => {
    if (!currentClipId) return;
    // Bake down all selected keyframes that belong to groups
    for (const kf of selectedKeyframes) {
      const isGroup = groups.some((g) => g.id === kf.pathId);
      if (isGroup) {
        store.bakeKeyframeDown(currentClipId, kf.pathId, kf.time);
      }
    }
  }, [currentClipId, selectedKeyframes, groups]);

  // Check if we can create keyframes (have selection and active clip)
  const canCreateKeyframes = useMemo(() => {
    if (!currentClipId) return false;
    return selection.pathIds.length > 0;
  }, [currentClipId, selection.pathIds]);

  const handleCreateKeyframes = useCallback(() => {
    store.createKeyframesForSelection();
  }, []);

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

  // Generate ruler ticks with major, minor, and micro levels
  const rulerTicks = useMemo(() => {
    if (!currentClip) return [];
    const duration = currentClip.duration;
    const ticks: { time: number; level: "major" | "minor" | "micro" }[] = [];

    // Determine tick intervals based on duration
    let majorStep: number;
    let minorStep: number;
    let microStep: number;

    if (duration <= 1) {
      majorStep = 0.5;
      minorStep = 0.1;
      microStep = 0.05;
    } else if (duration <= 2) {
      majorStep = 0.5;
      minorStep = 0.1;
      microStep = 0.05;
    } else if (duration <= 5) {
      majorStep = 1;
      minorStep = 0.5;
      microStep = 0.1;
    } else if (duration <= 10) {
      majorStep = 1;
      minorStep = 0.5;
      microStep = 0.1;
    } else if (duration <= 30) {
      majorStep = 5;
      minorStep = 1;
      microStep = 0.5;
    } else {
      majorStep = 10;
      minorStep = 5;
      microStep = 1;
    }

    // Generate ticks at micro level, classify each
    for (let t = 0; t <= duration + 0.0001; t += microStep) {
      const roundedT = Math.round(t * 1000) / 1000; // Avoid floating point issues
      if (roundedT > duration) break;

      let level: "major" | "minor" | "micro";
      if (Math.abs(roundedT % majorStep) < 0.0001 || Math.abs(roundedT % majorStep - majorStep) < 0.0001) {
        level = "major";
      } else if (Math.abs(roundedT % minorStep) < 0.0001 || Math.abs(roundedT % minorStep - minorStep) < 0.0001) {
        level = "minor";
      } else {
        level = "micro";
      }
      ticks.push({ time: roundedT, level });
    }
    return ticks;
  }, [currentClip]);

  // Track pending drag (before threshold is met)
  const [pendingDrag, setPendingDrag] = useState<{
    pathId: string;
    time: number;
    startX: number;
    startTime: number; // timestamp when mouse was pressed
  } | null>(null);

  // Handle unified keyframe mouse down (for dragging)
  const handleKeyframeMouseDown = useCallback(
    (e: React.MouseEvent, pathId: string, time: number) => {
      e.stopPropagation();
      e.preventDefault();

      // Check if this keyframe is already selected
      const isAlreadySelected = selectedKeyframes.some(
        (kf) => kf.pathId === pathId && Math.abs(kf.time - time) < 0.0001
      );

      // Handle selection based on shift key and current selection state
      if (e.shiftKey && isAlreadySelected) {
        // Shift-click on already selected keyframe: deselect it
        store.selectKeyframe({ pathId, time }, true); // This toggles off
      } else if (!isAlreadySelected) {
        // Not already selected: select it (shift adds to selection)
        store.selectKeyframe({ pathId, time }, e.shiftKey);
      }
      // If already selected without shift, keep the current selection (for multi-drag)
      store.setPlaybackTime(time);
      // Set up pending drag - actual drag starts after threshold
      setPendingDrag({ pathId, time, startX: e.clientX, startTime: Date.now() });
    },
    [selectedKeyframes]
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
        // Threshold met, start actual drag with all selected keyframes
        const currentSelectedKeyframes = store.getState().selectedKeyframes;
        const clip = store.getState().animationClips.find((c) => c.id === currentClipId);
        if (!clip || currentSelectedKeyframes.length === 0) {
          setPendingDrag(null);
          return;
        }

        // Capture original animations for undo
        const prevAnimations = new Map<string, PartAnimation>();
        const keyframes: { pathId: string; originalTime: number }[] = [];
        for (const kf of currentSelectedKeyframes) {
          keyframes.push({ pathId: kf.pathId, originalTime: kf.time });
          if (!prevAnimations.has(kf.pathId)) {
            prevAnimations.set(kf.pathId, clip.parts[kf.pathId] ?? []);
          }
        }

        setDraggingKeyframes({
          keyframes,
          startTime: pendingDrag.time,
          prevAnimations,
        });
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
  }, [pendingDrag, currentClipId]);

  // Snap threshold as a fraction of clip duration (2%)
  const SNAP_THRESHOLD_RATIO = 0.02;

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

  // Helper to snap a time value to nearby keyframes from other paths (only when shift held)
  const snapTimeToOtherKeyframes = useCallback((time: number, excludePathId: string, shiftHeld: boolean): number => {
    if (!shiftHeld || !currentClip) return time;
    const snapThreshold = currentClip.duration * SNAP_THRESHOLD_RATIO;
    const otherTimes = getOtherKeyframeTimes(excludePathId);
    for (const snapTime of otherTimes) {
      if (Math.abs(time - snapTime) < snapThreshold) {
        return snapTime;
      }
    }
    return time;
  }, [getOtherKeyframeTimes, currentClip]);

  // Collect all keyframe times from paths not being dragged for snapping
  const otherKeyframeTimes = useMemo(() => {
    if (!currentClip || !draggingKeyframes) return [];
    const draggingPathIds = new Set(draggingKeyframes.keyframes.map((k) => k.pathId));
    const times = new Set<number>();
    for (const [partId, partAnim] of Object.entries(currentClip.parts)) {
      if (draggingPathIds.has(partId)) continue;
      for (const kf of partAnim) {
        times.add(kf.t);
      }
    }
    return Array.from(times).sort((a, b) => a - b);
  }, [currentClip, draggingKeyframes]);

  // Handle keyframe drag
  useEffect(() => {
    if (!draggingKeyframes || !currentClipId || !tracksContainerRef.current) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!tracksContainerRef.current || !currentClip) return;
      const rect = tracksContainerRef.current.getBoundingClientRect();
      // Account for 150px label column offset
      const labelWidth = 150;
      const x = e.clientX - rect.left - labelWidth;
      const keyframeAreaWidth = rect.width - labelWidth;
      let newTime = xToTime(x, keyframeAreaWidth);

      // Snap to other keyframes only when shift is held
      if (e.shiftKey) {
        const snapThreshold = currentClip.duration * SNAP_THRESHOLD_RATIO;
        for (const snapTime of otherKeyframeTimes) {
          if (Math.abs(newTime - snapTime) < snapThreshold) {
            newTime = snapTime;
            break;
          }
        }
      }

      // Calculate time delta from original position
      const timeDelta = newTime - draggingKeyframes.startTime;

      // Apply time delta to all keyframes being dragged (live, no undo)
      store.changeKeyframeTimeLive(
        currentClipId,
        draggingKeyframes.prevAnimations,
        draggingKeyframes.keyframes.map((kf) => ({
          pathId: kf.pathId,
          originalTime: kf.originalTime,
        })),
        timeDelta
      );
    };

    const handleMouseUp = () => {
      // Commit the change with undo support
      if (draggingKeyframes.prevAnimations.size > 0) {
        store.commitKeyframeTimeChange(currentClipId, draggingKeyframes.prevAnimations);
      }
      setDraggingKeyframes(null);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [draggingKeyframes, currentClipId, currentClip, xToTime, otherKeyframeTimes]);

  // Handle double-click on track to add empty keyframe (no properties set)
  const handleTrackDoubleClick = useCallback(
    (e: React.MouseEvent, pathId: string) => {
      if (!currentClipId) return;
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const x = e.clientX - rect.left;
      const rawTime = xToTime(x, rect.width);
      // Snap to keyframes from other paths (only when shift held)
      const time = snapTimeToOtherKeyframes(rawTime, pathId, e.shiftKey);

      // Create an empty keyframe (user will tick properties they want)
      store.createEmptyKeyframe(currentClipId, pathId, time);
      // Select the new keyframe and move scrubber to that time
      store.selectKeyframe({ pathId, time });
      store.setPlaybackTime(time);
    },
    [currentClipId, xToTime, snapTimeToOtherKeyframes]
  );

  // Delete selected keyframe
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't delete when typing in an input field
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) {
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selectedKeyframes.length > 0 && currentClipId) {
        // Delete all selected keyframes
        for (const kf of selectedKeyframes) {
          store.deleteKeyframe(currentClipId, kf.pathId, kf.time);
        }
        store.clearKeyframeSelection();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedKeyframes, currentClipId]);

  // Can align keyframes (need 2+ selected)
  const canAlignKeyframes = selectedKeyframes.length >= 2;

  // Align keyframes (quick action - align to center time)
  const handleAlignKeyframes = useCallback(() => {
    if (!currentClipId || !currentClip || selectedKeyframes.length < 2) return;

    // Save for undo
    const prevAnimations = new Map<string, PartAnimation>();
    const keyframes: { pathId: string; originalTime: number }[] = [];
    for (const kf of selectedKeyframes) {
      if (!prevAnimations.has(kf.pathId)) {
        prevAnimations.set(kf.pathId, currentClip.parts[kf.pathId] ?? []);
      }
      keyframes.push({ pathId: kf.pathId, originalTime: kf.time });
    }

    // Apply alignment to center
    store.alignKeyframesToCenter(currentClipId, prevAnimations, keyframes);

    // Commit to undo stack
    store.commitKeyframeTimeChange(currentClipId, prevAnimations);
  }, [currentClipId, currentClip, selectedKeyframes]);

  // Handle align button mouse down (for hold-to-show-popup)
  const handleAlignMouseDown = useCallback(() => {
    if (!canAlignKeyframes || !currentClipId || !currentClip) return;

    alignHoldTimerRef.current = setTimeout(() => {
      // Save snapshot before showing popup
      const animations = new Map<string, PartAnimation>();
      const keyframes: { pathId: string; originalTime: number }[] = [];
      const originalSelectedKeyframes = [...selectedKeyframes];

      for (const kf of selectedKeyframes) {
        if (!animations.has(kf.pathId)) {
          animations.set(kf.pathId, currentClip.parts[kf.pathId] ?? []);
        }
        keyframes.push({ pathId: kf.pathId, originalTime: kf.time });
      }

      // Calculate the current average gap between unique time groups
      const uniqueTimes = [...new Set(keyframes.map((kf) => Math.round(kf.originalTime * 10000) / 10000))].sort((a, b) => a - b);
      let currentGap = 0.1; // Default fallback
      if (uniqueTimes.length >= 2) {
        const totalSpan = uniqueTimes[uniqueTimes.length - 1] - uniqueTimes[0];
        currentGap = Math.round((totalSpan / (uniqueTimes.length - 1)) * 10000) / 10000;
      }

      alignSnapshotRef.current = { animations, keyframes, originalSelectedKeyframes };
      setAlignTimeGap(currentGap);
      setShowAlignPopup(true);

      // Apply initial preview (distribute with current gap - no change initially)
      store.distributeKeyframesLive(currentClipId, animations, keyframes, currentGap);
      alignHoldTimerRef.current = null;
    }, 300);
  }, [canAlignKeyframes, currentClipId, currentClip, selectedKeyframes]);

  const handleAlignMouseUp = useCallback(() => {
    if (alignHoldTimerRef.current) {
      clearTimeout(alignHoldTimerRef.current);
      alignHoldTimerRef.current = null;
      handleAlignKeyframes();
    }
  }, [handleAlignKeyframes]);

  const handleAlignMouseLeave = useCallback(() => {
    if (alignHoldTimerRef.current) {
      clearTimeout(alignHoldTimerRef.current);
      alignHoldTimerRef.current = null;
    }
  }, []);

  // Update preview when gap changes
  useEffect(() => {
    if (!showAlignPopup || !alignSnapshotRef.current || !currentClipId) return;
    const { animations, keyframes } = alignSnapshotRef.current;
    store.distributeKeyframesLive(currentClipId, animations, keyframes, alignTimeGap);
  }, [alignTimeGap, showAlignPopup, currentClipId]);

  // Close popup when clicking outside
  useEffect(() => {
    if (!showAlignPopup) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (
        alignPopupRef.current &&
        !alignPopupRef.current.contains(e.target as Node) &&
        alignButtonRef.current &&
        !alignButtonRef.current.contains(e.target as Node)
      ) {
        // Restore snapshot on cancel
        if (alignSnapshotRef.current && currentClipId) {
          const { animations, originalSelectedKeyframes } = alignSnapshotRef.current;
          store.restoreKeyframesFromSnapshot(currentClipId, animations, originalSelectedKeyframes);
          alignSnapshotRef.current = null;
        }
        setShowAlignPopup(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showAlignPopup, currentClipId]);

  const handleAlignCancel = useCallback(() => {
    if (alignSnapshotRef.current && currentClipId) {
      const { animations, originalSelectedKeyframes } = alignSnapshotRef.current;
      store.restoreKeyframesFromSnapshot(currentClipId, animations, originalSelectedKeyframes);
      alignSnapshotRef.current = null;
    }
    setShowAlignPopup(false);
  }, [currentClipId]);

  const handleAlignApply = useCallback(() => {
    if (alignSnapshotRef.current && currentClipId) {
      const { animations, keyframes } = alignSnapshotRef.current;

      // First restore to original state, then apply with undo
      store.restoreKeyframesFromSnapshot(currentClipId, animations, alignSnapshotRef.current.originalSelectedKeyframes);

      // Apply distribution and commit to undo stack
      store.distributeKeyframesLive(currentClipId, animations, keyframes, alignTimeGap);
      store.commitKeyframeTimeChange(currentClipId, animations);

      alignSnapshotRef.current = null;
    }
    setShowAlignPopup(false);
  }, [currentClipId, alignTimeGap]);

  // Can scale keyframes (need 2+ selected keyframes at different times)
  const canScaleKeyframes = useMemo(() => {
    if (selectedKeyframes.length < 2) return false;
    const uniqueTimes = new Set(selectedKeyframes.map((kf) => Math.round(kf.time * 10000) / 10000));
    return uniqueTimes.size >= 2;
  }, [selectedKeyframes]);

  // Handle scale button click - show popup
  const handleScaleClick = useCallback(() => {
    if (!canScaleKeyframes || !currentClipId || !currentClip) return;

    // Calculate current duration of selected keyframes
    const times = selectedKeyframes.map((kf) => kf.time);
    const minTime = Math.min(...times);
    const maxTime = Math.max(...times);
    const currentDuration = maxTime - minTime;

    // Save snapshot for cancel
    const animations = new Map<string, PartAnimation>();
    const keyframes: { pathId: string; originalTime: number }[] = [];
    for (const kf of selectedKeyframes) {
      if (!animations.has(kf.pathId)) {
        animations.set(kf.pathId, currentClip.parts[kf.pathId] ?? []);
      }
      keyframes.push({ pathId: kf.pathId, originalTime: kf.time });
    }

    scaleSnapshotRef.current = {
      animations,
      keyframes,
      originalSelectedKeyframes: [...selectedKeyframes],
      originalDuration: currentDuration,
    };

    setScaleDuration(Math.round(currentDuration * 1000) / 1000);
    setShowScalePopup(true);
  }, [canScaleKeyframes, currentClipId, currentClip, selectedKeyframes]);

  // Update preview when scale duration changes
  useEffect(() => {
    if (!showScalePopup || !scaleSnapshotRef.current || !currentClipId) return;
    const { animations, keyframes } = scaleSnapshotRef.current;
    store.scaleKeyframesLive(currentClipId, animations, keyframes, scaleDuration);
  }, [scaleDuration, showScalePopup, currentClipId]);

  // Close scale popup when clicking outside
  useEffect(() => {
    if (!showScalePopup) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (
        scalePopupRef.current &&
        !scalePopupRef.current.contains(e.target as Node) &&
        scaleButtonRef.current &&
        !scaleButtonRef.current.contains(e.target as Node)
      ) {
        // Restore snapshot on cancel
        if (scaleSnapshotRef.current && currentClipId) {
          const { animations, originalSelectedKeyframes } = scaleSnapshotRef.current;
          store.restoreKeyframesFromSnapshot(currentClipId, animations, originalSelectedKeyframes);
          scaleSnapshotRef.current = null;
        }
        setShowScalePopup(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showScalePopup, currentClipId]);

  const handleScaleCancel = useCallback(() => {
    if (scaleSnapshotRef.current && currentClipId) {
      const { animations, originalSelectedKeyframes } = scaleSnapshotRef.current;
      store.restoreKeyframesFromSnapshot(currentClipId, animations, originalSelectedKeyframes);
      scaleSnapshotRef.current = null;
    }
    setShowScalePopup(false);
  }, [currentClipId]);

  const handleScaleApply = useCallback(() => {
    if (scaleSnapshotRef.current && currentClipId) {
      const { animations, keyframes } = scaleSnapshotRef.current;

      // First restore to original state, then apply with undo
      store.restoreKeyframesFromSnapshot(currentClipId, animations, scaleSnapshotRef.current.originalSelectedKeyframes);

      // Apply scaling and commit to undo stack
      store.scaleKeyframesLive(currentClipId, animations, keyframes, scaleDuration);
      store.commitKeyframeTimeChange(currentClipId, animations);

      scaleSnapshotRef.current = null;
    }
    setShowScalePopup(false);
  }, [currentClipId, scaleDuration]);

  // Build a list of all keyframe positions for marquee selection
  const keyframePositions = useMemo(() => {
    if (!currentClip || !tracksContainerRef.current) return [];
    const positions: { pathId: string; time: number; element: Element }[] = [];
    // Query all keyframe elements from the DOM
    const keyframeElements = tracksContainerRef.current.querySelectorAll("[data-keyframe]");
    keyframeElements.forEach((el) => {
      const pathId = el.getAttribute("data-path-id");
      const time = parseFloat(el.getAttribute("data-time") ?? "0");
      if (pathId) {
        positions.push({ pathId, time, element: el });
      }
    });
    return positions;
  }, [currentClip, paths, groups]);

  // Handle marquee selection on tracks container
  const handleTracksMouseDown = useCallback((e: React.MouseEvent) => {
    // Only start marquee if clicking on the tracks area (not on keyframes, labels, or ruler)
    const target = e.target as HTMLElement;
    // Don't start marquee if clicking on a keyframe, label, or ruler
    if (target.closest("[data-keyframe]") || target.closest("." + styles.rowLabel) || target.closest("." + styles.rulerRow)) {
      return;
    }
    // Get position relative to tracks content (not container, to avoid ruler offset)
    const contentRect = tracksContentRef.current?.getBoundingClientRect();
    if (!contentRect) return;
    const scrollLeft = tracksContainerRef.current?.scrollLeft ?? 0;
    const scrollTop = tracksContainerRef.current?.scrollTop ?? 0;
    const x = e.clientX - contentRect.left + scrollLeft;
    const y = e.clientY - contentRect.top + scrollTop;
    setMarqueeStart({ x, y });
    setMarqueeEnd({ x, y });
    setIsMarqueeSelecting(true);
    setMarqueeShiftHeld(e.shiftKey);
  }, []);

  // Marquee selection mouse move and up handlers
  useEffect(() => {
    if (!isMarqueeSelecting || !marqueeStart) return;

    const handleMouseMove = (e: MouseEvent) => {
      const contentRect = tracksContentRef.current?.getBoundingClientRect();
      if (!contentRect) return;
      const scrollLeft = tracksContainerRef.current?.scrollLeft ?? 0;
      const scrollTop = tracksContainerRef.current?.scrollTop ?? 0;
      const x = e.clientX - contentRect.left + scrollLeft;
      const y = e.clientY - contentRect.top + scrollTop;
      setMarqueeEnd({ x, y });
    };

    const handleMouseUp = () => {
      // Find keyframes within the marquee bounds
      if (marqueeStart && marqueeEnd && tracksContentRef.current) {
        const minX = Math.min(marqueeStart.x, marqueeEnd.x);
        const maxX = Math.max(marqueeStart.x, marqueeEnd.x);
        const minY = Math.min(marqueeStart.y, marqueeEnd.y);
        const maxY = Math.max(marqueeStart.y, marqueeEnd.y);

        const contentRect = tracksContentRef.current.getBoundingClientRect();
        const scrollLeft = tracksContainerRef.current?.scrollLeft ?? 0;
        const scrollTop = tracksContainerRef.current?.scrollTop ?? 0;

        const selectedKfs: { pathId: string; time: number }[] = [];
        const keyframeElements = tracksContentRef.current.querySelectorAll("[data-keyframe]");
        keyframeElements.forEach((el) => {
          const elRect = el.getBoundingClientRect();
          // Convert element position to content-relative coordinates
          const elX = elRect.left - contentRect.left + scrollLeft + elRect.width / 2;
          const elY = elRect.top - contentRect.top + scrollTop + elRect.height / 2;

          if (elX >= minX && elX <= maxX && elY >= minY && elY <= maxY) {
            const pathId = el.getAttribute("data-path-id");
            const time = parseFloat(el.getAttribute("data-time") ?? "0");
            if (pathId) {
              selectedKfs.push({ pathId, time });
            }
          }
        });

        if (selectedKfs.length > 0) {
          store.selectKeyframes(selectedKfs, marqueeShiftHeld);
        } else if (!marqueeShiftHeld) {
          // Clicked on empty space without shift - clear selection
          store.clearKeyframeSelection();
        }
      }

      setIsMarqueeSelecting(false);
      setMarqueeStart(null);
      setMarqueeEnd(null);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isMarqueeSelecting, marqueeStart, marqueeEnd, marqueeShiftHeld]);

  // Get properties present in a unified keyframe
  const getKeyframeProperties = (kf: UnifiedKeyframe): AnimatableProperty[] => {
    return ANIMATABLE_PROPERTIES.filter((p) => kf[p] !== undefined);
  };

  // Get unique times of selected keyframes (for "affected" highlighting)
  const selectedKeyframeTimes = useMemo(() => {
    const times = new Set<number>();
    for (const kf of selectedKeyframes) {
      times.add(kf.time);
    }
    return times;
  }, [selectedKeyframes]);

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
      <div className={`${styles.unifiedRow} ${isSelected ? styles.unifiedRowSelected : ""}`}>
        {/* Label area */}
        <div
          className={`${styles.rowLabel} ${isGroup ? styles.groupLabel : ""} ${isSelected ? styles.rowLabelSelected : ""}`}
          onClick={() => hasChildren ? toggleExpanded(id) : undefined}
          style={{ paddingLeft }}
        >
          <span className={styles.trackExpand}>
            {hasChildren ? (isExpanded ? "▼" : "▶") : ""}
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
            const isKfSelected = selectedKeyframes.some(
              (sel) => sel.pathId === id && Math.abs(sel.time - kf.t) < 0.0001
            );
            // A keyframe is "affected" if this path is selected, the keyframe isn't directly selected,
            // and there's a selected keyframe at the same time on another path
            const isKfAffected = isSelected && !isKfSelected &&
              [...selectedKeyframeTimes].some((t) => Math.abs(t - kf.t) < 0.0001);
            return (
              <div
                key={kf.t}
                className={`${styles.unifiedKeyframe} ${isKfSelected ? styles.keyframeSelected : ""} ${isKfAffected ? styles.keyframeAffected : ""}`}
                style={{
                  left: `${(kf.t / (currentClip?.duration ?? 1)) * 100}%`,
                  cursor: draggingKeyframes ? "ew-resize" : "pointer",
                }}
                data-keyframe
                data-path-id={id}
                data-time={kf.t}
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

  // Render unified nodes recursively (label + keyframes together)
  // Groups can expand to show children, but no property sub-tracks
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
            {isExpanded && renderUnifiedNodes(node.children, depth + 1)}
          </div>
        );
      } else {
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

        {/* Clip editing buttons */}
        <div className={styles.buttonGroup}>
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
          <button className={styles.headerBtn} onClick={handleAddClip} title="Add clip">
            +
          </button>
          <button className={styles.headerBtn} onClick={handleDeleteClip} disabled={!currentClipId} title="Delete clip">
            −
          </button>
        </div>

        <div className={styles.separator} />

        {/* Playback controls */}
        <div className={styles.buttonGroup}>
          <button
            className={`${styles.headerBtn} ${isPlaying ? styles.active : ""}`}
            onClick={() => store.togglePlayback()}
            title={isPlaying ? "Pause" : "Play"}
          >
            {isPlaying ? "⏸" : "▶"}
          </button>
        </div>

        <div className={styles.separator} />

        {/* Keyframe actions */}
        <div className={styles.buttonGroup} style={{ position: "relative" }}>
          <button
            className={styles.headerBtn}
            onClick={() => currentClipId && store.shiftKeyframes(currentClipId, "left")}
            disabled={selectedKeyframes.length === 0}
            title="Shift keyframes left"
          >
            ←
          </button>
          <button
            className={styles.headerBtn}
            onClick={() => currentClipId && store.shiftKeyframes(currentClipId, "right")}
            disabled={selectedKeyframes.length === 0}
            title="Shift keyframes right"
          >
            →
          </button>
          <button
            className={styles.headerBtn}
            onClick={() => currentClipId && store.reverseKeyframes(currentClipId)}
            disabled={selectedKeyframes.length < 2}
            title="Reverse keyframe order"
          >
            ⇄
          </button>
          <button
            ref={scaleButtonRef}
            className={`${styles.headerBtn} ${showScalePopup ? styles.active : ""}`}
            onClick={handleScaleClick}
            disabled={!canScaleKeyframes}
            title="Scale keyframes"
          >
            ⤢
          </button>
          {showScalePopup && (
            <div ref={scalePopupRef} className={styles.alignPopup}>
              <div className={styles.popupTitle}>Scale Keyframes</div>
              <div className={styles.popupRow}>
                <label>Duration:</label>
                <input
                  type="number"
                  value={scaleDuration}
                  onChange={(e) => {
                    const val = parseFloat(e.target.value);
                    if (!isNaN(val) && val > 0) setScaleDuration(val);
                  }}
                  min={0.001}
                  step={0.1}
                />
                <span className={styles.unit}>s</span>
              </div>
              <div className={styles.popupButtons}>
                <button className={styles.popupButton} onClick={handleScaleCancel}>Cancel</button>
                <button className={`${styles.popupButton} ${styles.applyButton}`} onClick={handleScaleApply}>Apply</button>
              </div>
            </div>
          )}
          <div
            ref={alignButtonRef}
            className={`${styles.headerBtn} ${!canAlignKeyframes ? styles.disabled : ""}`}
            onMouseDown={canAlignKeyframes ? handleAlignMouseDown : undefined}
            onMouseUp={canAlignKeyframes ? handleAlignMouseUp : undefined}
            onMouseLeave={handleAlignMouseLeave}
            title="Align keyframes (hold to distribute)"
            style={{ cursor: canAlignKeyframes ? "pointer" : "not-allowed", opacity: canAlignKeyframes ? 1 : 0.5 }}
          >
            ⇔
          </div>
          {showAlignPopup && (
            <div ref={alignPopupRef} className={styles.alignPopup}>
              <div className={styles.popupTitle}>Distribute Keyframes</div>
              <div className={styles.popupRow}>
                <label>Gap:</label>
                <input
                  type="number"
                  value={alignTimeGap}
                  onChange={(e) => {
                    const val = parseFloat(e.target.value);
                    if (!isNaN(val)) setAlignTimeGap(val);
                  }}
                  min={0}
                />
                <span className={styles.unit}>s</span>
              </div>
              <div className={styles.popupButtons}>
                <button className={styles.popupButton} onClick={handleAlignCancel}>Cancel</button>
                <button className={`${styles.popupButton} ${styles.applyButton}`} onClick={handleAlignApply}>Apply</button>
              </div>
            </div>
          )}
        </div>

        <div className={styles.separator} />

        {/* Selection narrowing */}
        <div className={styles.buttonGroup}>
          <button
            className={styles.headerBtn}
            onClick={handleNarrowFirst}
            disabled={selectedKeyframes.length < 2}
            title="Select first keyframe per track (repeat for 2nd, 3rd...)"
          >
            ⊣
          </button>
          <button
            className={styles.headerBtn}
            onClick={handleNarrowLast}
            disabled={selectedKeyframes.length < 2}
            title="Select last keyframe per track (repeat for 2nd-last, 3rd-last...)"
          >
            ⊢
          </button>
        </div>

        <div className={styles.separator} />

        {/* Bake down button */}
        <div className={styles.buttonGroup}>
          <button
            className={styles.headerBtn}
            onClick={handleBakeDown}
            disabled={!canBakeDown}
            title="Bake keyframe properties down to direct children"
          >
            ↧
          </button>
        </div>

        <div className={styles.separator} />

        {/* Create keyframes button */}
        <div className={styles.buttonGroup}>
          <button
            className={styles.headerBtn}
            onClick={handleCreateKeyframes}
            disabled={!canCreateKeyframes}
            title="Create keyframes at current time for selected items (interpolating existing properties)"
          >
            ◆+
          </button>
        </div>

        <span className={styles.timeDisplay}>
          {playbackTime.toFixed(2)}s /{" "}
          <input
            type="number"
            className={styles.durationInput}
            value={Math.round((currentClip?.duration ?? 1) * 1000) / 1000}
            onChange={handleDurationChange}
            step={0.1}
            min={0.1}
            max={60}
          />
          s
        </span>
      </div>

      <div className={styles.body}>
        {/* Unified scrollable tracks area with sticky ruler */}
        <div
          className={`${styles.tracksContainer}${isMarqueeSelecting ? ` ${styles.selecting}` : ""}`}
          ref={tracksContainerRef}
          onMouseDown={handleTracksMouseDown}
        >
          {/* Sticky ruler header */}
          <div className={styles.rulerRow}>
            <div className={styles.rulerLabelSpace} />
            <div className={styles.ruler} ref={rulerRef} onMouseDown={handleRulerMouseDown}>
              {rulerTicks.map(({ time, level }, index) => {
                const isFirst = index === 0;
                const isLast = index === rulerTicks.length - 1;
                const edgeClass = isFirst ? styles.rulerLabelFirst : isLast ? styles.rulerLabelLast : "";
                return (
                  <div
                    key={time}
                    className={`${styles.rulerTick} ${styles[`rulerTick${level.charAt(0).toUpperCase() + level.slice(1)}`]}`}
                    style={{ left: `${(time / (currentClip?.duration ?? 1)) * 100}%` }}
                  >
                    {level === "major" && (
                      <span className={`${styles.rulerLabel} ${edgeClass}`}>{time % 1 === 0 ? time.toFixed(0) : time.toFixed(1)}s</span>
                    )}
                    {level === "minor" && (
                      <span className={`${styles.rulerLabelMinor} ${edgeClass}`}>{time.toFixed(1)}</span>
                    )}
                  </div>
                );
              })}
              <div
                className={styles.playheadHandle}
                style={{ left: `${(playbackTime / (currentClip?.duration ?? 1)) * 100}%` }}
              />
            </div>
          </div>

          <div className={styles.tracksContent} ref={tracksContentRef}>
            {renderUnifiedNodes(hierarchy, 0)}
            {/* Playhead line - positioned in keyframe area (after 150px label column) */}
            <div
              className={styles.playhead}
              style={{ left: `calc(150px + (100% - 150px) * ${playbackTime / (currentClip?.duration ?? 1)})` }}
            />
            {/* Marquee selection box */}
            {isMarqueeSelecting && marqueeStart && marqueeEnd && (
              <div
                className={styles.marquee}
                style={{
                  left: Math.min(marqueeStart.x, marqueeEnd.x),
                  top: Math.min(marqueeStart.y, marqueeEnd.y),
                  width: Math.abs(marqueeEnd.x - marqueeStart.x),
                  height: Math.abs(marqueeEnd.y - marqueeStart.y),
                }}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
