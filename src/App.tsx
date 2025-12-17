import { useCallback, useEffect, useRef, useState } from "react";
import { Canvas } from "./Canvas.tsx";
import { Header } from "./Header.tsx";
import { Hierarchy } from "./Hierarchy.tsx";
import { Properties } from "./Properties.tsx";
import { Toolbox } from "./Toolbox.tsx";
import { useStore } from "./store/index.ts";
import styles from "./App.module.css";

const formatCoord = (n: number) => n.toFixed(3);

const SIDEBAR_STORAGE_KEY = "estme-sidebar-width";
const DEFAULT_SIDEBAR_WIDTH = 200;
const MIN_SIDEBAR_WIDTH = 150;

const loadSidebarWidth = (): number => {
  try {
    const stored = localStorage.getItem(SIDEBAR_STORAGE_KEY);
    if (stored) {
      const width = parseInt(stored, 10);
      if (!isNaN(width) && width >= MIN_SIDEBAR_WIDTH) {
        return width;
      }
    }
  } catch {
    // Ignore localStorage errors
  }
  return DEFAULT_SIDEBAR_WIDTH;
};

const saveSidebarWidth = (width: number) => {
  try {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, String(Math.round(width)));
  } catch {
    // Ignore localStorage errors
  }
};

export const App = () => {
  const mousePosition = useStore((s) => s.mousePosition);
  const zoom = useStore((s) => s.zoom);
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);
  const isDragging = useRef(false);
  const appRef = useRef<HTMLDivElement>(null);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current || !appRef.current) return;

      const appRect = appRef.current.getBoundingClientRect();
      const maxWidth = appRect.width * 0.4; // Max 40% of screen
      const newWidth = appRect.right - e.clientX;
      const clampedWidth = Math.max(MIN_SIDEBAR_WIDTH, Math.min(maxWidth, newWidth));

      setSidebarWidth(clampedWidth);
    };

    const handleMouseUp = () => {
      if (isDragging.current) {
        isDragging.current = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        // Save on mouse up
        setSidebarWidth((w) => {
          saveSidebarWidth(w);
          return w;
        });
      }
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  return (
    <div
      ref={appRef}
      className={styles.app}
      style={{ gridTemplateColumns: `40px 1fr ${sidebarWidth}px` }}
    >
      <Header />
      <aside className={styles.left}>
        <Toolbox />
      </aside>
      <main className={styles.canvas}>
        <Canvas />
      </main>
      <aside className={styles.right}>
        <div className={styles.resizeHandle} onMouseDown={handleMouseDown} />
        <div className={styles.rightContent}>
          <Hierarchy />
          <Properties />
        </div>
      </aside>
      <footer className={styles.footer}>
        {mousePosition
          ? `X: ${formatCoord(mousePosition.x)}  Y: ${formatCoord(mousePosition.y)}`
          : "X: -  Y: -"}
        {"  |  "}
        Zoom: {Math.round(100 / zoom)}%
      </footer>
    </div>
  );
};
