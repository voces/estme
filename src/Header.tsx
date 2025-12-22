import { store, useStore } from "./store/index.ts";
import styles from "./Header.module.css";

export const Header = () => {
  const canUndo = useStore((s) => s.undoStack.length > 0);
  const canRedo = useStore((s) => s.redoStack.length > 0);
  const selection = useStore((s) => s.selection);
  const paths = useStore((s) => s.paths);
  const showAllPoints = useStore((s) => s.showAllPoints);
  const showAllControlPoints = useStore((s) => s.showAllControlPoints);
  const showTransformPoints = useStore((s) => s.showTransformPoints);
  const clipboard = useStore((s) => s.clipboard);
  const canDelete = selection.pathIds.length > 0 || selection.points.length > 0;
  const canCopy = selection.pathIds.length > 0 || selection.points.some((p) => p.handleType === "anchor");
  const canPaste = clipboard !== null && clipboard.type === "paths";
  const hasSelection = selection.pathIds.length > 0 || selection.points.length > 0;
  const hasPaths = paths.length > 0;

  // Check if split is possible (2 non-adjacent anchors on same closed path)
  const canSplit = (() => {
    if (selection.pathIds.length !== 0 || selection.points.length !== 2) return false;
    const [p1, p2] = selection.points;
    if (p1.handleType !== "anchor" || p2.handleType !== "anchor") return false;
    if (p1.pathId !== p2.pathId) return false;
    const path = paths.find((p) => p.id === p1.pathId);
    if (!path || !path.closed) return false;
    const n = path.segments.length;
    const diff = Math.abs(p1.segmentIndex - p2.segmentIndex);
    return diff !== 1 && diff !== n - 1;
  })();

  // Check if boolean operations are possible (paths must intersect/overlap)
  const canUnite = useStore(() => store.canUnite());
  const canIntersect = useStore(() => store.canIntersect());
  const canSubtract = useStore(() => store.canSubtract());
  const canExclude = useStore(() => store.canExclude());

  // Check if alignment is possible (need 2+ selected paths)
  const canAlign = selection.pathIds.length >= 2;

  return (
    <header className={styles.header}>
      <div className={styles.buttonGroup}>
        <button
          className={`${styles.button} ${!canUndo ? styles.disabled : ""}`}
          onClick={() => store.undo()}
          disabled={!canUndo}
          title="Undo (Ctrl+Z)"
        >
          {"\u21A9"}
        </button>
        <button
          className={`${styles.button} ${!canRedo ? styles.disabled : ""}`}
          onClick={() => store.redo()}
          disabled={!canRedo}
          title="Redo (Ctrl+Shift+Z)"
        >
          {"\u21AA"}
        </button>
      </div>
      <div className={styles.separator} />
      <div className={styles.buttonGroup}>
        <button
          className={`${styles.button} ${!hasPaths ? styles.disabled : ""}`}
          onClick={() => store.selectAll()}
          disabled={!hasPaths}
          title="Select All (Ctrl+A)"
        >
          {"\u2610"}
        </button>
        <button
          className={`${styles.button} ${!hasSelection ? styles.disabled : ""}`}
          onClick={() => store.clearSelection()}
          disabled={!hasSelection}
          title="Deselect All (Alt+A)"
        >
          {"\u2612"}
        </button>
      </div>
      <div className={styles.separator} />
      <div className={styles.buttonGroup}>
        <button
          className={`${styles.button} ${!canCopy ? styles.disabled : ""}`}
          onClick={() => store.copy()}
          disabled={!canCopy}
          title="Copy (Ctrl+C)"
        >
          {"\u{1F4CB}"}
        </button>
        <button
          className={`${styles.button} ${!canCopy ? styles.disabled : ""}`}
          onClick={() => store.cut()}
          disabled={!canCopy}
          title="Cut (Ctrl+X)"
        >
          {"\u2702"}
        </button>
        <button
          className={`${styles.button} ${!canPaste ? styles.disabled : ""}`}
          onClick={() => store.paste()}
          disabled={!canPaste}
          title="Paste (Ctrl+V)"
        >
          {"\u{1F4C4}"}
        </button>
        <button
          className={`${styles.button} ${!canDelete ? styles.disabled : ""}`}
          onClick={() => store.deleteSelection()}
          disabled={!canDelete}
          title="Delete (Del)"
        >
          {"\u{1F5D1}"}
        </button>
      </div>
      <div className={styles.separator} />
      <div className={styles.buttonGroup}>
        <button
          className={`${styles.button} ${!canSplit ? styles.disabled : ""}`}
          onClick={() => store.splitPath()}
          disabled={!canSplit}
          title="Split Path (S)"
        >
          {"\u2194"}
        </button>
        <button
          className={`${styles.button} ${!canUnite ? styles.disabled : ""}`}
          onClick={() => store.unitePaths()}
          disabled={!canUnite}
          title="Unite (U)"
        >
          {"\u222A"}
        </button>
        <button
          className={`${styles.button} ${!canIntersect ? styles.disabled : ""}`}
          onClick={() => store.intersectPaths()}
          disabled={!canIntersect}
          title="Intersect (I)"
        >
          {"\u2229"}
        </button>
        <button
          className={`${styles.button} ${!canSubtract ? styles.disabled : ""}`}
          onClick={() => store.subtractPaths()}
          disabled={!canSubtract}
          title="Subtract (D)"
        >
          {"\u2212"}
        </button>
        <button
          className={`${styles.button} ${!canExclude ? styles.disabled : ""}`}
          onClick={() => store.excludePaths()}
          disabled={!canExclude}
          title="Exclude (X)"
        >
          {"\u2296"}
        </button>
      </div>
      <div className={styles.separator} />
      <div className={styles.buttonGroup}>
        <button
          className={`${styles.button} ${!canAlign ? styles.disabled : ""}`}
          onClick={() => store.alignHorizontally()}
          disabled={!canAlign}
          title="Align Horizontally (centers)"
        >
          {"\u2550"}
        </button>
        <button
          className={`${styles.button} ${!canAlign ? styles.disabled : ""}`}
          onClick={() => store.alignVertically()}
          disabled={!canAlign}
          title="Align Vertically (centers)"
        >
          {"\u2551"}
        </button>
      </div>
      <div className={styles.separator} />
      <div className={styles.buttonGroup}>
        <button
          className={`${styles.button} ${showAllPoints ? styles.active : ""}`}
          onClick={() => store.toggleShowAllPoints()}
          title="Show All Anchor Points (.)"
        >
          {"\u25C9"}
        </button>
        <button
          className={`${styles.button} ${showAllControlPoints ? styles.active : ""}`}
          onClick={() => store.toggleShowAllControlPoints()}
          title="Show All Control Points (,)"
        >
          {"\u25CE"}
        </button>
        <button
          className={`${styles.button} ${showTransformPoints ? styles.active : ""}`}
          onClick={() => store.toggleShowTransformPoints()}
          title="Show Transform Points (/)"
        >
          {"\u2316"}
        </button>
      </div>
    </header>
  );
};
