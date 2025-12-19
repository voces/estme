import { useState, useEffect, useRef } from "react";
import { store, useStore } from "./store/index.ts";
import { Tool } from "./types.ts";
import styles from "./Toolbox.module.css";

const tools: { id: Tool; icon: string; title: string }[] = [
  { id: "select", icon: "\u{1F5B1}", title: "Select (V)" },
  { id: "line", icon: "\u{1F4CF}", title: "Line (P)" },
  { id: "blob", icon: "\u{1F58C}", title: "Blob (B)" },
];

// Draggable number input with optional display transform
function DraggableInput({ label, title, value, onChange, min, max, decimals = 2, sensitivity = 0.02, displayScale = 1 }: {
  label: string;
  title?: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  decimals?: number;
  sensitivity?: number;
  displayScale?: number; // Multiplier for display value (e.g., 100 shows 0.02 as "2")
}) {
  // Display values are scaled for user-friendliness
  const toDisplay = (v: number) => v * displayScale;
  const fromDisplay = (v: number) => v / displayScale;
  const displayMin = toDisplay(min);
  const displayMax = toDisplay(max);

  const [localValue, setLocalValue] = useState(toDisplay(value).toFixed(decimals));
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{ x: number; startValue: number } | null>(null);

  useEffect(() => {
    if (!isDragging) {
      setLocalValue(toDisplay(value).toFixed(decimals));
    }
  }, [value, isDragging, decimals, displayScale]);

  const clamp = (v: number) => Math.max(min, Math.min(max, v));
  const clampDisplay = (v: number) => Math.max(displayMin, Math.min(displayMax, v));

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    dragStartRef.current = { x: e.clientX, startValue: toDisplay(value) };
    setIsDragging(true);

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!dragStartRef.current) return;
      const delta = moveEvent.clientX - dragStartRef.current.x;
      // Scale sensitivity based on current value for better control at small sizes
      const sens = Math.max(0.01, dragStartRef.current.startValue * sensitivity);
      const newDisplayValue = clampDisplay(dragStartRef.current.startValue + delta * sens);
      setLocalValue(newDisplayValue.toFixed(decimals));
      onChange(clamp(fromDisplay(newDisplayValue)));
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
    <div className={styles.radiusControl} title={title}>
      <label>{label}</label>
      <input
        type="number"
        min={displayMin}
        max={displayMax}
        step={Math.pow(10, -decimals)}
        value={localValue}
        onChange={(e) => {
          setLocalValue(e.target.value);
          const num = parseFloat(e.target.value);
          if (!isNaN(num)) {
            onChange(clamp(fromDisplay(num)));
          }
        }}
        onMouseDown={handleMouseDown}
        className={styles.radiusInput}
        style={{ cursor: "ew-resize" }}
      />
    </div>
  );
}

export const Toolbox = () => {
  const currentTool = useStore((s) => s.tool);
  const blobRadius = useStore((s) => s.blobRadius);
  const blobSimplify = useStore((s) => s.blobSimplify);

  return (
    <div className={styles.toolbox}>
      {tools.map((tool) => (
        <button
          key={tool.id}
          className={`${styles.tool} ${currentTool === tool.id ? styles.active : ""}`}
          onClick={() => store.setTool(tool.id)}
          title={tool.title}
        >
          {tool.icon}
        </button>
      ))}
      {currentTool === "blob" && (
        <>
          <DraggableInput
            label="Size"
            value={blobRadius}
            onChange={(v) => store.setBlobRadius(v)}
            min={0.01}
            max={200}
          />
          <DraggableInput
            label="Tol"
            title="Simplify tolerance"
            value={blobSimplify}
            onChange={(v) => store.setBlobSimplify(v)}
            min={0}
            max={1}
            decimals={0}
            sensitivity={0.02}
            displayScale={1000}
          />
        </>
      )}
    </div>
  );
};
