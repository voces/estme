import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AnimatableProperty,
  AnimationClip,
  ANIMATABLE_PROPERTIES,
  propertyColors,
  PartAnimation,
  getPropertyValue,
  defaultPropertyValues,
} from "./animation.ts";
import { store } from "./store/index.ts";
import styles from "./ValueWaterfall.module.css";

const PROPERTY_LABELS: Record<AnimatableProperty, string> = {
  tx: "X",
  ty: "Y",
  rot: "Rot",
  scale: "Scale",
  opacity: "Opacity",
};

type ValueWaterfallProps = {
  clip: AnimationClip;
  partId: string;
  playbackTime: number;
  clipId: string;
};

export const ValueWaterfall = ({ clip, partId, playbackTime, clipId }: ValueWaterfallProps) => {
  const [enabledProperties, setEnabledProperties] = useState<Set<AnimatableProperty>>(
    () => new Set(ANIMATABLE_PROPERTIES)
  );

  const [dragging, setDragging] = useState<{
    property: AnimatableProperty;
    keyframeTime: number;
    startY: number;
    startValue: number;
    prevAnimation: PartAnimation;
  } | null>(null);

  const [hoveredPoint, setHoveredPoint] = useState<{
    property: AnimatableProperty;
    time: number;
    value: number;
    x: number;
    y: number;
  } | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 600, height: 150 });

  // Track container size
  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setDimensions({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const partAnim = clip.parts[partId] ?? [];

  // Properties that actually have keyframe values set
  const activeProperties = useMemo(() => {
    return ANIMATABLE_PROPERTIES.filter((prop) =>
      partAnim.some((kf) => kf[prop] !== undefined)
    );
  }, [partAnim]);

  // Active AND toggled on
  const visibleProperties = useMemo(
    () => activeProperties.filter((p) => enabledProperties.has(p)),
    [activeProperties, enabledProperties]
  );

  // Y axis ranges per property
  const yRanges = useMemo(() => {
    const ranges: Record<string, { min: number; max: number }> = {};
    for (const prop of ANIMATABLE_PROPERTIES) {
      if (prop === "rot") {
        const values = partAnim
          .filter((kf) => kf[prop] !== undefined)
          .map((kf) => kf[prop]!);
        if (values.length === 0) {
          ranges[prop] = { min: -Math.PI, max: Math.PI };
        } else {
          const min = Math.min(...values);
          const max = Math.max(...values);
          const padding = Math.max((max - min) * 0.1, 0.01);
          ranges[prop] = {
            min: Math.max(min - padding, -Math.PI),
            max: Math.min(max + padding, Math.PI),
          };
        }
      } else if (prop === "opacity") {
        ranges[prop] = { min: 0, max: 1 };
      } else {
        const values = partAnim
          .filter((kf) => kf[prop] !== undefined)
          .map((kf) => kf[prop]!);
        if (values.length === 0) {
          const def = defaultPropertyValues[prop];
          ranges[prop] = { min: def - 1, max: def + 1 };
        } else {
          const min = Math.min(...values);
          const max = Math.max(...values);
          const padding = Math.max((max - min) * 0.1, 0.01);
          ranges[prop] = { min: min - padding, max: max + padding };
        }
      }
    }
    return ranges;
  }, [partAnim]);

  const { width: svgWidth, height: svgHeight } = dimensions;

  const timeToX = useCallback(
    (t: number) => (t / clip.duration) * svgWidth,
    [clip.duration, svgWidth]
  );

  const valueToY = useCallback(
    (value: number, prop: AnimatableProperty) => {
      const range = yRanges[prop];
      if (!range || range.max === range.min) return svgHeight / 2;
      return svgHeight - ((value - range.min) / (range.max - range.min)) * svgHeight;
    },
    [yRanges, svgHeight]
  );

  const yToValue = useCallback(
    (y: number, prop: AnimatableProperty) => {
      const range = yRanges[prop];
      if (!range) return 0;
      return range.min + ((svgHeight - y) / svgHeight) * (range.max - range.min);
    },
    [yRanges, svgHeight]
  );

  // Generate interpolated polyline points for a property
  const generateLinePath = useCallback(
    (prop: AnimatableProperty) => {
      const steps = Math.max(Math.floor(svgWidth / 2), 50);
      const points: string[] = [];
      for (let i = 0; i <= steps; i++) {
        const t = (i / steps) * clip.duration;
        const value = getPropertyValue(partAnim, prop, t);
        points.push(`${timeToX(t)},${valueToY(value, prop)}`);
      }
      return points.join(" ");
    },
    [partAnim, clip.duration, svgWidth, timeToX, valueToY]
  );

  const toggleProperty = useCallback((prop: AnimatableProperty) => {
    setEnabledProperties((prev) => {
      const next = new Set(prev);
      if (next.has(prop)) next.delete(prop);
      else next.add(prop);
      return next;
    });
  }, []);

  // Point drag start
  const handlePointMouseDown = useCallback(
    (e: React.MouseEvent, prop: AnimatableProperty, kfTime: number, currentValue: number) => {
      e.stopPropagation();
      e.preventDefault();
      setHoveredPoint(null);
      setDragging({
        property: prop,
        keyframeTime: kfTime,
        startY: e.clientY,
        startValue: currentValue,
        prevAnimation: partAnim.map((kf) => ({ ...kf })),
      });
    },
    [partAnim]
  );

  // Drag move/up listeners
  useEffect(() => {
    if (!dragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const dy = e.clientY - dragging.startY;
      const range = yRanges[dragging.property];
      if (!range) return;
      const valueDelta = -(dy / svgHeight) * (range.max - range.min);
      let newValue = dragging.startValue + valueDelta;

      if (dragging.property === "opacity") {
        newValue = Math.max(0, Math.min(1, newValue));
      }

      store.setKeyframePropertyLive(
        clipId,
        partId,
        dragging.property,
        dragging.keyframeTime,
        newValue
      );
    };

    const handleMouseUp = () => {
      store.commitKeyframeProperty(clipId, partId, dragging.prevAnimation);
      setDragging(null);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [dragging, clipId, partId, yRanges, svgHeight]);

  const formatValue = (prop: AnimatableProperty, value: number): string => {
    if (prop === "rot") return `${(value * 180 / Math.PI).toFixed(1)}\u00B0`;
    if (prop === "opacity") return value.toFixed(2);
    return value.toFixed(1);
  };

  return (
    <div className={styles.waterfallPanel}>
      <div className={styles.waterfallLabels}>
        {activeProperties.map((prop) => (
          <label key={prop} className={styles.propToggle}>
            <input
              type="checkbox"
              checked={enabledProperties.has(prop)}
              onChange={() => toggleProperty(prop)}
            />
            <span
              className={styles.propDot}
              style={{ backgroundColor: propertyColors[prop] }}
            />
            <span className={styles.propName}>{PROPERTY_LABELS[prop]}</span>
          </label>
        ))}
        {activeProperties.length === 0 && (
          <span className={styles.emptyLabel}>No animated properties</span>
        )}
      </div>

      <div className={styles.waterfallChart} ref={containerRef}>
        <svg
          width="100%"
          height="100%"
          viewBox={`0 0 ${svgWidth} ${svgHeight}`}
          preserveAspectRatio="none"
        >
          {/* Interpolated curves */}
          {visibleProperties.map((prop) => (
            <polyline
              key={`line-${prop}`}
              points={generateLinePath(prop)}
              fill="none"
              stroke={propertyColors[prop]}
              strokeWidth="1.5"
              opacity="0.7"
              vectorEffect="non-scaling-stroke"
            />
          ))}

          {/* Keyframe points */}
          {visibleProperties.map((prop) =>
            partAnim
              .filter((kf) => kf[prop] !== undefined)
              .map((kf) => {
                const value = kf[prop]!;
                const cx = timeToX(kf.t);
                const cy = valueToY(value, prop);
                return (
                  <circle
                    key={`pt-${prop}-${kf.t}`}
                    cx={cx}
                    cy={cy}
                    r="4"
                    fill={propertyColors[prop]}
                    stroke="#000"
                    strokeWidth="1"
                    style={{ cursor: "ns-resize" }}
                    vectorEffect="non-scaling-stroke"
                    onMouseDown={(e) => handlePointMouseDown(e, prop, kf.t, value)}
                    onMouseEnter={() =>
                      !dragging && setHoveredPoint({ property: prop, time: kf.t, value, x: cx, y: cy })
                    }
                    onMouseLeave={() => !dragging && setHoveredPoint(null)}
                  />
                );
              })
          )}

          {/* Playhead */}
          <line
            x1={timeToX(playbackTime)}
            y1={0}
            x2={timeToX(playbackTime)}
            y2={svgHeight}
            stroke="#ff4444"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        </svg>

        {/* Tooltip */}
        {hoveredPoint && !dragging && (
          <div
            className={styles.waterfallTooltip}
            style={{
              left: hoveredPoint.x,
              top: hoveredPoint.y < 24 ? hoveredPoint.y + 12 : hoveredPoint.y - 24,
            }}
          >
            {formatValue(hoveredPoint.property, hoveredPoint.value)}
          </div>
        )}
      </div>
    </div>
  );
};
