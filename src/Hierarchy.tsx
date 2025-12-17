import { useState, useRef, useEffect } from "react";
import { Group, Path } from "./types.ts";
import { store, useStore } from "./store/index.ts";
import { averageColors, getAnchorColor } from "./geometry.ts";
import styles from "./Hierarchy.module.css";

// Calculate average vertex color for a path
function getPathAverageColor(path: Path): string {
  const vertexColors = path.segments.map((_, i) => getAnchorColor(path, i));
  return averageColors(vertexColors);
}

type HierarchyNode =
  | { type: "path"; path: Path; depth: number }
  | { type: "group"; group: Group; depth: number };

function buildHierarchyTree(
  paths: Path[],
  groups: Group[],
  parentId: string | null,
  depth: number
): HierarchyNode[] {
  const result: HierarchyNode[] = [];

  // Add groups at this level
  for (const group of groups) {
    if (group.parentId === parentId) {
      result.push({ type: "group", group, depth });
      // If not collapsed, add children
      if (!group.collapsed) {
        result.push(...buildHierarchyTree(paths, groups, group.id, depth + 1));
      }
    }
  }

  // Add paths at this level
  for (const path of paths) {
    if (path.parentId === parentId) {
      result.push({ type: "path", path, depth });
    }
  }

  return result;
}

export const Hierarchy = () => {
  const paths = useStore((s) => s.paths);
  const groups = useStore((s) => s.groups);
  const selection = useStore((s) => s.selection);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingType, setEditingType] = useState<"path" | "group" | null>(null);
  const [editingName, setEditingName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingId]);

  const handlePathClick = (pathId: string, e: React.MouseEvent) => {
    e.preventDefault();
    if (e.shiftKey) {
      store.toggleInSelection(pathId);
    } else {
      store.selectPath(pathId);
    }
  };

  const handleGroupClick = (groupId: string, e: React.MouseEvent) => {
    e.preventDefault();
    if (e.shiftKey) {
      store.toggleGroupInSelection(groupId);
    } else {
      store.selectGroup(groupId);
    }
  };

  const handleDoubleClick = (id: string, type: "path" | "group", currentName: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId(id);
    setEditingType(type);
    setEditingName(currentName);
  };

  const handleRenameSubmit = () => {
    if (editingId && editingName.trim()) {
      if (editingType === "path") {
        store.setPathName(editingId, editingName.trim());
      } else if (editingType === "group") {
        store.setGroupName(editingId, editingName.trim());
      }
    }
    setEditingId(null);
    setEditingType(null);
    setEditingName("");
  };

  const handleRenameCancel = () => {
    setEditingId(null);
    setEditingType(null);
    setEditingName("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleRenameSubmit();
    } else if (e.key === "Escape") {
      handleRenameCancel();
    }
  };

  // Check if a group has all its descendants selected
  const isGroupFullySelected = (groupId: string): boolean => {
    const descendantIds = store.getDescendantPathIds(groupId);
    return descendantIds.length > 0 && descendantIds.every((id) => selection.pathIds.includes(id));
  };

  // Check if a group has some but not all descendants selected
  const isGroupPartiallySelected = (groupId: string): boolean => {
    const descendantIds = store.getDescendantPathIds(groupId);
    const selectedCount = descendantIds.filter((id) => selection.pathIds.includes(id)).length;
    return selectedCount > 0 && selectedCount < descendantIds.length;
  };

  const tree = buildHierarchyTree(paths, groups, null, 0);

  const renderGroupItem = (group: Group, depth: number) => {
    const isFullySelected = isGroupFullySelected(group.id);
    const isPartiallySelected = isGroupPartiallySelected(group.id);
    const isEditing = editingId === group.id && editingType === "group";
    const hasChildren = paths.some((p) => p.parentId === group.id) || groups.some((g) => g.parentId === group.id);
    // Derive visibility/lock from children
    const isVisible = store.isGroupVisible(group.id);
    const isLocked = store.isGroupLocked(group.id);

    return (
      <div
        key={group.id}
        className={`${styles.item} ${styles.groupItem} ${isFullySelected ? styles.selected : ""} ${isPartiallySelected ? styles.partialSelected : ""}`}
        style={{ paddingLeft: `${6 + depth * 16}px` }}
        onClick={(e) => handleGroupClick(group.id, e)}
      >
        <button
          className={styles.collapseToggle}
          onClick={(e) => {
            e.stopPropagation();
            store.setGroupCollapsed(group.id, !group.collapsed);
          }}
          title={group.collapsed ? "Expand group" : "Collapse group"}
        >
          {hasChildren ? (group.collapsed ? "\u25B6" : "\u25BC") : "\u00A0"}
        </button>
        <button
          className={`${styles.toggle} ${!isVisible ? styles.hidden : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            store.setGroupVisible(group.id, !isVisible);
          }}
          title={isVisible ? "Hide group" : "Show group"}
        >
          {isVisible ? "\u25C9" : "\u25CE"}
        </button>
        <button
          className={`${styles.toggle} ${isLocked ? styles.locked : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            store.setGroupLocked(group.id, !isLocked);
          }}
          title={isLocked ? "Unlock group" : "Lock group"}
        >
          {isLocked ? "\u{1F512}" : "\u{1F513}"}
        </button>
        <span className={styles.groupIcon}>{"\u{1F4C1}"}</span>
        {isEditing ? (
          <input
            ref={inputRef}
            className={styles.nameInput}
            value={editingName}
            onChange={(e) => setEditingName(e.target.value)}
            onBlur={handleRenameSubmit}
            onKeyDown={handleKeyDown}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span
            className={styles.name}
            onDoubleClick={(e) => handleDoubleClick(group.id, "group", group.name, e)}
          >
            {group.name}
          </span>
        )}
      </div>
    );
  };

  const renderPathItem = (path: Path, depth: number) => {
    const isSelected = selection.pathIds.includes(path.id);
    const hasPointSelected = selection.points.some((p) => p.pathId === path.id);
    const isEditing = editingId === path.id && editingType === "path";
    const avgColor = getPathAverageColor(path);

    return (
      <div
        key={path.id}
        className={`${styles.item} ${isSelected ? styles.selected : ""} ${hasPointSelected ? styles.partialSelected : ""}`}
        style={{ paddingLeft: `${6 + depth * 16}px` }}
        onClick={(e) => handlePathClick(path.id, e)}
      >
        <span className={styles.collapseToggleSpacer} />
        <button
          className={`${styles.toggle} ${!path.visible ? styles.hidden : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            store.setPathVisible(path.id, !path.visible);
          }}
          title={path.visible ? "Hide path" : "Show path"}
        >
          {path.visible ? "\u25C9" : "\u25CE"}
        </button>
        <button
          className={`${styles.toggle} ${path.locked ? styles.locked : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            store.setPathLocked(path.id, !path.locked);
          }}
          title={path.locked ? "Unlock path" : "Lock path"}
        >
          {path.locked ? "\u{1F512}" : "\u{1F513}"}
        </button>
        <span
          className={styles.colorSwatch}
          style={{ backgroundColor: avgColor }}
        />
        {isEditing ? (
          <input
            ref={inputRef}
            className={styles.nameInput}
            value={editingName}
            onChange={(e) => setEditingName(e.target.value)}
            onBlur={handleRenameSubmit}
            onKeyDown={handleKeyDown}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span
            className={styles.name}
            onDoubleClick={(e) => handleDoubleClick(path.id, "path", path.name, e)}
          >
            {path.name}
          </span>
        )}
      </div>
    );
  };

  const canGroup = selection.pathIds.length > 0;
  // Can ungroup if any selected path has a parent group
  const canUngroup = selection.pathIds.some((id) => {
    const path = paths.find((p) => p.id === id);
    return path?.parentId != null;
  });

  return (
    <div className={styles.hierarchy}>
      <div className={styles.title}>
        <span>Hierarchy</span>
        <div className={styles.titleButtons}>
          <button
            className={styles.groupButton}
            onClick={() => store.groupSelection()}
            disabled={!canGroup}
            title="Group selected paths (G)"
          >
            Group
          </button>
          <button
            className={styles.groupButton}
            onClick={() => store.ungroupSelection()}
            disabled={!canUngroup}
            title="Ungroup selected paths (Shift+G)"
          >
            Ungroup
          </button>
        </div>
      </div>
      <div className={styles.list}>
        {tree.length === 0 ? (
          <div className={styles.empty}>No paths</div>
        ) : (
          tree.map((node) => {
            if (node.type === "group") {
              return renderGroupItem(node.group, node.depth);
            } else {
              return renderPathItem(node.path, node.depth);
            }
          })
        )}
      </div>
    </div>
  );
};
