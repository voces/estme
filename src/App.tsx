import { useCallback, useEffect, useRef, useState } from "react";
import { Canvas } from "./Canvas.tsx";
import { Header } from "./Header.tsx";
import { Hierarchy } from "./Hierarchy.tsx";
import { MenuBar } from "./MenuBar.tsx";
import { Properties } from "./Properties.tsx";
import { Timeline } from "./Timeline.tsx";
import { Toolbox } from "./Toolbox.tsx";
import { useStore } from "./store/index.ts";
import styles from "./App.module.css";

const formatCoord = (n: number) => n.toFixed(3);

const SIDEBAR_STORAGE_KEY = "estme-sidebar-width";
const TIMELINE_STORAGE_KEY = "estme-timeline-height";
const DEFAULT_SIDEBAR_WIDTH = 200;
const DEFAULT_TIMELINE_HEIGHT = 200;
const MIN_SIDEBAR_WIDTH = 150;
const MIN_TIMELINE_HEIGHT = 100;

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

const loadTimelineHeight = (): number => {
  try {
    const stored = localStorage.getItem(TIMELINE_STORAGE_KEY);
    if (stored) {
      const height = parseInt(stored, 10);
      if (!isNaN(height) && height >= MIN_TIMELINE_HEIGHT) {
        return height;
      }
    }
  } catch {
    // Ignore localStorage errors
  }
  return DEFAULT_TIMELINE_HEIGHT;
};

const saveTimelineHeight = (height: number) => {
  try {
    localStorage.setItem(TIMELINE_STORAGE_KEY, String(Math.round(height)));
  } catch {
    // Ignore localStorage errors
  }
};

export const App = () => {
  const mousePosition = useStore((s) => s.mousePosition);
  const zoom = useStore((s) => s.zoom);
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);
  const [timelineHeight, setTimelineHeight] = useState(loadTimelineHeight);
  const isDraggingSidebar = useRef(false);
  const isDraggingTimeline = useRef(false);
  const appRef = useRef<HTMLDivElement>(null);

  const handleSidebarMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDraggingSidebar.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  const handleTimelineMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDraggingTimeline.current = true;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!appRef.current) return;

      if (isDraggingSidebar.current) {
        const appRect = appRef.current.getBoundingClientRect();
        const maxWidth = appRect.width * 0.4; // Max 40% of screen
        const newWidth = appRect.right - e.clientX;
        const clampedWidth = Math.max(MIN_SIDEBAR_WIDTH, Math.min(maxWidth, newWidth));
        setSidebarWidth(clampedWidth);
      }

      if (isDraggingTimeline.current) {
        const appRect = appRef.current.getBoundingClientRect();
        const maxHeight = appRect.height * 0.6; // Max 60% of screen
        const newHeight = appRect.bottom - e.clientY;
        const clampedHeight = Math.max(MIN_TIMELINE_HEIGHT, Math.min(maxHeight, newHeight));
        setTimelineHeight(clampedHeight);
      }
    };

    const handleMouseUp = () => {
      if (isDraggingSidebar.current) {
        isDraggingSidebar.current = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        setSidebarWidth((w) => {
          saveSidebarWidth(w);
          return w;
        });
      }
      if (isDraggingTimeline.current) {
        isDraggingTimeline.current = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        setTimelineHeight((h) => {
          saveTimelineHeight(h);
          return h;
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
      style={{
        gridTemplateColumns: `40px 1fr ${sidebarWidth}px`,
        gridTemplateRows: `auto auto 1fr ${timelineHeight}px auto`,
      }}
    >
      <MenuBar />
      <Header />
      <aside className={styles.left}>
        <Toolbox />
      </aside>
      <main className={styles.canvas}>
        <Canvas />
      </main>
      <aside className={styles.right}>
        <div className={styles.resizeHandle} onMouseDown={handleSidebarMouseDown} />
        <div className={styles.rightContent}>
          <Hierarchy />
          <Properties />
        </div>
      </aside>
      <div className={styles.timeline}>
        <div className={styles.timelineResizeHandle} onMouseDown={handleTimelineMouseDown} />
        <Timeline />
      </div>
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
