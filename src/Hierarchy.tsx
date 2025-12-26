import { useState, useRef, useEffect } from "react";
import { Group, Path, Raster } from "./types.ts";
import { store, useStore } from "./store/index.ts";
import { averageColors, getAnchorColor } from "./geometry.ts";
import styles from "./Hierarchy.module.css";

// Calculate average vertex color for a path
function getPathAverageColor(path: Path): string {
  const vertexColors = path.segments.map((_, i) => getAnchorColor(path, i));
  return averageColors(vertexColors);
}

type HierarchyNode =
  | { type: "path"; path: Path; depth: number; flatIndex: number }
  | { type: "group"; group: Group; depth: number; flatIndex: number }
  | { type: "raster"; raster: Raster; depth: number; flatIndex: number }
  | { type: "groupEnd"; groupId: string; parentId: string | null; depth: number };

// Drop target indicator
type DropTarget = {
  type: "before" | "after" | "into";
  targetId: string;
  targetType: "path" | "group" | "raster" | "groupEnd";
  targetParentId: string | null;
  targetDepth: number;
} | null;

function buildHierarchyTree(
  paths: Path[],
  groups: Group[],
  rasters: Raster[],
  parentId: string | null,
  depth: number,
  flatIndex: { current: number },
  pathArrayIndices: Map<string, number>,
  rasterArrayIndices: Map<string, number>
): HierarchyNode[] {
  const result: HierarchyNode[] = [];

  // Get groups at this level
  const levelGroups = groups.filter((g) => g.parentId === parentId);
  // Get paths at this level
  const levelPaths = paths.filter((p) => p.parentId === parentId);
  // Get rasters at this level
  const levelRasters = rasters.filter((r) => r.parentId === parentId);

  // For each group, find the minimum path/raster index among its descendants
  // This determines where the group should appear in the order
  const getGroupMinIndex = (groupId: string): number => {
    let minIndex = Infinity;
    // Check direct child paths
    for (const path of paths) {
      if (path.parentId === groupId) {
        const idx = pathArrayIndices.get(path.id);
        if (idx !== undefined && idx < minIndex) minIndex = idx;
      }
    }
    // Check direct child rasters
    for (const raster of rasters) {
      if (raster.parentId === groupId) {
        const idx = rasterArrayIndices.get(raster.id);
        if (idx !== undefined && idx < minIndex) minIndex = idx;
      }
    }
    // Check child groups recursively
    for (const group of groups) {
      if (group.parentId === groupId) {
        const childMin = getGroupMinIndex(group.id);
        if (childMin < minIndex) minIndex = childMin;
      }
    }
    return minIndex;
  };

  // Build items with their sort keys
  type Item =
    | { type: "path"; path: Path; sortKey: number }
    | { type: "group"; group: Group; sortKey: number }
    | { type: "raster"; raster: Raster; sortKey: number };
  const items: Item[] = [];

  for (const path of levelPaths) {
    const idx = pathArrayIndices.get(path.id) ?? Infinity;
    items.push({ type: "path", path, sortKey: idx });
  }

  for (const raster of levelRasters) {
    const idx = rasterArrayIndices.get(raster.id) ?? Infinity;
    items.push({ type: "raster", raster, sortKey: idx });
  }

  for (const group of levelGroups) {
    const minIdx = getGroupMinIndex(group.id);
    items.push({ type: "group", group, sortKey: minIdx });
  }

  // Sort by the path/raster array index (or min descendant index for groups)
  // Reverse order: higher indices (rendered on top) appear at top of hierarchy list
  items.sort((a, b) => b.sortKey - a.sortKey);

  // Build the result
  for (const item of items) {
    if (item.type === "group") {
      const group = item.group;
      result.push({ type: "group", group, depth, flatIndex: flatIndex.current++ });
      // If not collapsed, add children and a group-end marker for drop zone
      if (!group.collapsed) {
        const children = buildHierarchyTree(paths, groups, rasters, group.id, depth + 1, flatIndex, pathArrayIndices, rasterArrayIndices);
        result.push(...children);
        // Add a group-end drop zone after the children (for dropping as sibling below the group)
        if (children.length > 0) {
          result.push({ type: "groupEnd", groupId: group.id, parentId: group.parentId, depth });
        }
      }
    } else if (item.type === "raster") {
      result.push({ type: "raster", raster: item.raster, depth, flatIndex: flatIndex.current++ });
    } else {
      result.push({ type: "path", path: item.path, depth, flatIndex: flatIndex.current++ });
    }
  }

  return result;
}

export const Hierarchy = () => {
  const paths = useStore((s) => s.paths);
  const groups = useStore((s) => s.groups);
  const rasters = useStore((s) => s.rasters);
  const selection = useStore((s) => s.selection);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingType, setEditingType] = useState<"path" | "group" | "raster" | null>(null);
  const [editingName, setEditingName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Track last clicked item for shift+click range selection
  const lastClickedRef = useRef<{ id: string; type: "path" | "group" | "raster" } | null>(null);

  // Drag and drop state
  const [draggedItem, setDraggedItem] = useState<{ id: string; type: "path" | "group" | "raster"; parentId: string | null } | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget>(null);

  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingId]);

  // Build a flat list of selectable items in display order for range selection
  const getSelectableItems = (): { id: string; type: "path" | "group" | "raster" }[] => {
    const pathArrayIndices = new Map(paths.map((p, i) => [p.id, i]));
    const rasterArrayIndices = new Map(rasters.map((r, i) => [r.id, i]));
    const tree = buildHierarchyTree(paths, groups, rasters, null, 0, { current: 0 }, pathArrayIndices, rasterArrayIndices);
    const items: { id: string; type: "path" | "group" | "raster" }[] = [];
    for (const node of tree) {
      if (node.type === "path") {
        items.push({ id: node.path.id, type: "path" });
      } else if (node.type === "group") {
        items.push({ id: node.group.id, type: "group" });
      } else if (node.type === "raster") {
        items.push({ id: node.raster.id, type: "raster" });
      }
    }
    return items;
  };

  // Handle range selection between two items
  const selectRange = (fromId: string, toId: string) => {
    const items = getSelectableItems();
    const fromIndex = items.findIndex(item => item.id === fromId);
    const toIndex = items.findIndex(item => item.id === toId);

    if (fromIndex === -1 || toIndex === -1) return;

    const startIndex = Math.min(fromIndex, toIndex);
    const endIndex = Math.max(fromIndex, toIndex);

    const pathIds: string[] = [];
    for (let i = startIndex; i <= endIndex; i++) {
      const item = items[i];
      if (item.type === "path") {
        pathIds.push(item.id);
      } else if (item.type === "raster") {
        // Rasters are selected by their ID in the same selection array
        pathIds.push(item.id);
      } else if (item.type === "group") {
        // Add all paths in the group
        const groupPathIds = store.getDescendantPathIds(item.id);
        pathIds.push(...groupPathIds);
      }
    }

    // Add paths in range to existing selection (shift always adds, never removes)
    const existingPathIds = store.getState().selection.pathIds;
    const allPathIds = [...new Set([...existingPathIds, ...pathIds])];
    store.setSelection({ pathIds: allPathIds, points: [] });
  };

  // Find the nearest selected item to use as anchor for range selection
  const findNearestSelectedItem = (clickedId: string): { id: string; type: "path" | "group" | "raster" } | null => {
    const items = getSelectableItems();
    const clickedIndex = items.findIndex(item => item.id === clickedId);
    if (clickedIndex === -1) return null;

    // Check which items are currently selected
    const selectedPathIds = new Set(selection.pathIds);

    let nearestItem: { id: string; type: "path" | "group" | "raster" } | null = null;
    let nearestDistance = Infinity;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      let isSelected = false;

      if (item.type === "path") {
        isSelected = selectedPathIds.has(item.id);
      } else if (item.type === "raster") {
        isSelected = selectedPathIds.has(item.id);
      } else if (item.type === "group") {
        // Group is selected if all its paths are selected
        const groupPathIds = store.getDescendantPathIds(item.id);
        isSelected = groupPathIds.length > 0 && groupPathIds.every(id => selectedPathIds.has(id));
      }

      if (isSelected) {
        const distance = Math.abs(i - clickedIndex);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearestItem = item;
        }
      }
    }

    return nearestItem;
  };

  const handlePathClick = (pathId: string, e: React.MouseEvent) => {
    e.preventDefault();

    if (e.shiftKey) {
      // Shift+click: range select from nearest selected item
      const nearestSelected = findNearestSelectedItem(pathId);
      if (nearestSelected) {
        selectRange(nearestSelected.id, pathId);
      } else {
        store.selectPath(pathId);
      }
    } else if (e.ctrlKey || e.metaKey) {
      // Ctrl+click: toggle in selection
      store.toggleInSelection(pathId);
    } else {
      // Regular click: single selection
      store.selectPath(pathId);
    }

    lastClickedRef.current = { id: pathId, type: "path" };
  };

  const handleGroupClick = (groupId: string, e: React.MouseEvent) => {
    e.preventDefault();

    if (e.shiftKey) {
      // Shift+click: range select from nearest selected item
      const nearestSelected = findNearestSelectedItem(groupId);
      if (nearestSelected) {
        selectRange(nearestSelected.id, groupId);
      } else {
        store.selectGroup(groupId);
      }
    } else if (e.ctrlKey || e.metaKey) {
      // Ctrl+click: toggle group in selection
      store.toggleGroupInSelection(groupId);
    } else {
      // Regular click: single selection
      store.selectGroup(groupId);
    }

    lastClickedRef.current = { id: groupId, type: "group" };
  };

  const handleRasterClick = (rasterId: string, e: React.MouseEvent) => {
    e.preventDefault();

    if (e.shiftKey) {
      // Shift+click: range select from nearest selected item
      const nearestSelected = findNearestSelectedItem(rasterId);
      if (nearestSelected) {
        selectRange(nearestSelected.id, rasterId);
      } else {
        store.setSelection({ pathIds: [rasterId], points: [] });
      }
    } else if (e.ctrlKey || e.metaKey) {
      // Ctrl+click: toggle in selection
      store.toggleInSelection(rasterId);
    } else {
      // Regular click: single selection
      store.setSelection({ pathIds: [rasterId], points: [] });
    }

    lastClickedRef.current = { id: rasterId, type: "raster" };
  };

  const handleDoubleClick = (id: string, type: "path" | "group" | "raster", currentName: string, e: React.MouseEvent) => {
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
      } else if (editingType === "raster") {
        store.setRasterName(editingId, editingName.trim());
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

  // Drag handlers
  const handleDragStart = (e: React.DragEvent, id: string, type: "path" | "group" | "raster", parentId: string | null) => {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", id);
    setDraggedItem({ id, type, parentId });
  };

  const handleDragEnd = () => {
    setDraggedItem(null);
    setDropTarget(null);
  };

  const handleDragOver = (e: React.DragEvent, targetId: string, targetType: "path" | "group" | "raster", targetParentId: string | null, targetDepth: number) => {
    e.preventDefault();
    e.stopPropagation();

    if (!draggedItem) return;

    // Don't allow dropping on self
    if (draggedItem.id === targetId) {
      setDropTarget(null);
      return;
    }

    // Don't allow dropping a group into its own descendants
    if (draggedItem.type === "group" && targetType === "group") {
      const ancestors = store.getAncestorChain(targetId);
      if (ancestors.some((a) => a.id === draggedItem.id)) {
        setDropTarget(null);
        return;
      }
    }

    const rect = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const height = rect.height;

    // Determine drop position based on mouse position
    let dropType: "before" | "after" | "into";
    if (targetType === "group") {
      // For groups: top 33% = before (sibling above), rest = into (child of group)
      // "After" (sibling below) is handled by the groupEnd drop zone
      if (y < height * 0.33) {
        dropType = "before";
      } else {
        dropType = "into";
      }
    } else {
      // For paths and rasters, top 50% = before, bottom 50% = after
      dropType = y < height * 0.5 ? "before" : "after";
    }

    setDropTarget({ type: dropType, targetId, targetType, targetParentId, targetDepth });
  };

  const handleDragLeave = (e: React.DragEvent) => {
    // Only clear if leaving the item entirely
    const relatedTarget = e.relatedTarget as HTMLElement;
    if (!e.currentTarget.contains(relatedTarget)) {
      setDropTarget(null);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (!draggedItem || !dropTarget) return;

    const { id: dragId, type: dragType, parentId: dragParentId } = draggedItem;
    const { type: dropType, targetId, targetType, targetParentId } = dropTarget;

    if (dropType === "into" && targetType === "group") {
      // Move into a group - change parent and reposition paths to front of group
      // (front in UI = highest index = "after" in array terms)
      store.moveItemToGroup(dragId, dragType, targetId);
      store.repositionItem(dragId, dragType, targetId, "group", "after");
    } else if (targetType === "groupEnd") {
      // Dropping on the groupEnd zone = dropping below the group (as sibling)
      // In reversed UI, "below" means lower index = "before" in array terms
      const groupId = targetId.replace("groupEnd:", "");

      // Move to the group's parent (sibling of the group)
      if (dragParentId !== targetParentId) {
        store.moveItemToGroup(dragId, dragType, targetParentId);
      }

      // Position before the group in the array (below in UI)
      store.repositionItem(dragId, dragType, groupId, "group", "before");
    } else if (dropType !== "into") {
      // Dropping before/after an item
      const newParentId = targetParentId;

      // First, move to the correct parent if needed
      if (dragParentId !== newParentId) {
        store.moveItemToGroup(dragId, dragType, newParentId);
      }

      // UI is displayed in reverse order (top = front = high index)
      // So "before" in UI means "after" in array, and vice versa
      const arrayPosition = dropType === "before" ? "after" : "before";
      store.repositionItem(dragId, dragType, targetId, targetType, arrayPosition);
    }

    setDraggedItem(null);
    setDropTarget(null);
  };

  // Helper: Check if an item's ancestor group is directly selected
  const isAncestorGroupSelected = (parentId: string | null): boolean => {
    let currentParentId = parentId;
    while (currentParentId) {
      if (selection.pathIds.includes(currentParentId)) return true;
      const parentGroup = groups.find((g) => g.id === currentParentId);
      currentParentId = parentGroup?.parentId ?? null;
    }
    return false;
  };

  // Check if a group has all its descendants selected OR the group itself is directly selected
  // OR an ancestor group is directly selected
  const isGroupFullySelected = (groupId: string): boolean => {
    // Group is directly selected (e.g., from timeline keyframe selection)
    if (selection.pathIds.includes(groupId)) return true;
    // Check if an ancestor group is selected (for nested groups)
    const group = groups.find((g) => g.id === groupId);
    if (group && isAncestorGroupSelected(group.parentId)) return true;
    // Or all descendant paths are selected
    const descendantIds = store.getDescendantPathIds(groupId);
    return descendantIds.length > 0 && descendantIds.every((id) => selection.pathIds.includes(id));
  };

  // Check if a group has some but not all descendants selected
  const isGroupPartiallySelected = (groupId: string): boolean => {
    // Not partial if the group itself is directly selected
    if (selection.pathIds.includes(groupId)) return false;
    // Not partial if an ancestor is selected
    const group = groups.find((g) => g.id === groupId);
    if (group && isAncestorGroupSelected(group.parentId)) return false;
    const descendantIds = store.getDescendantPathIds(groupId);
    const selectedCount = descendantIds.filter((id) => selection.pathIds.includes(id)).length;
    return selectedCount > 0 && selectedCount < descendantIds.length;
  };

  // Check if a path is selected via ancestor group selection
  const isPathSelectedViaGroup = (pathId: string): boolean => {
    const path = paths.find((p) => p.id === pathId);
    if (!path) return false;
    return isAncestorGroupSelected(path.parentId);
  };

  // Check if a raster is selected via ancestor group selection
  const isRasterSelectedViaGroup = (rasterId: string): boolean => {
    const raster = rasters.find((r) => r.id === rasterId);
    if (!raster) return false;
    return isAncestorGroupSelected(raster.parentId);
  };

  // Build a map of path ID to array index for sorting
  const pathArrayIndices = new Map(paths.map((p, i) => [p.id, i]));
  const rasterArrayIndices = new Map(rasters.map((r, i) => [r.id, i]));
  const tree = buildHierarchyTree(paths, groups, rasters, null, 0, { current: 0 }, pathArrayIndices, rasterArrayIndices);

  const getDropIndicatorClass = (itemId: string, itemType: "path" | "group" | "raster" | "groupEnd") => {
    if (!dropTarget || dropTarget.targetId !== itemId) return "";
    if (dropTarget.type === "before") return styles.dropBefore;
    if (dropTarget.type === "after") return styles.dropAfter;
    if (dropTarget.type === "into" && itemType === "group") return styles.dropInto;
    return "";
  };

  // Get the indent for the drop indicator line based on target depth
  const getDropIndent = (itemId: string): string | undefined => {
    if (!dropTarget || dropTarget.targetId !== itemId) return undefined;
    // The indent should match where the item will be placed
    return `${6 + dropTarget.targetDepth * 16}px`;
  };

  // Render a drop zone after an expanded group's children (for dropping as sibling below the group)
  const renderGroupEndDropZone = (groupId: string, parentId: string | null, depth: number) => {
    const targetId = `groupEnd:${groupId}`;
    const isDropTarget = dropTarget?.targetId === targetId && dropTarget?.type === "after";
    const dropIndent = isDropTarget ? `${6 + depth * 16}px` : undefined;

    if (!draggedItem) return null;

    // Don't show if dragging the group itself
    if (draggedItem.id === groupId) return null;

    return (
      <div
        key={targetId}
        className={`${styles.groupEndDropZone} ${isDropTarget ? styles.dropAfter : ""}`}
        style={{ "--drop-indent": dropIndent } as React.CSSProperties}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDropTarget({
            type: "after",
            targetId,
            targetType: "groupEnd",
            targetParentId: parentId,
            targetDepth: depth,
          });
        }}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      />
    );
  };

  const renderGroupItem = (group: Group, depth: number) => {
    const isFullySelected = isGroupFullySelected(group.id);
    const isPartiallySelected = isGroupPartiallySelected(group.id);
    const isEditing = editingId === group.id && editingType === "group";
    const hasChildren = paths.some((p) => p.parentId === group.id) || groups.some((g) => g.parentId === group.id);
    const isDragging = draggedItem?.id === group.id;
    // Derive visibility/lock from children
    const isVisible = store.isGroupVisible(group.id);
    const isLocked = store.isGroupLocked(group.id);
    const dropClass = getDropIndicatorClass(group.id, "group");
    const dropIndent = getDropIndent(group.id);

    return (
      <div
        key={group.id}
        className={`${styles.item} ${styles.groupItem} ${isFullySelected ? styles.selected : ""} ${isPartiallySelected ? styles.partialSelected : ""} ${isDragging ? styles.dragging : ""} ${dropClass}`}
        style={{ paddingLeft: `${6 + depth * 16}px`, "--drop-indent": dropIndent } as React.CSSProperties}
        onClick={(e) => handleGroupClick(group.id, e)}
        draggable={!isEditing}
        onDragStart={(e) => handleDragStart(e, group.id, "group", group.parentId)}
        onDragEnd={handleDragEnd}
        onDragOver={(e) => handleDragOver(e, group.id, "group", group.parentId, depth)}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
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
    const isSelected = selection.pathIds.includes(path.id) || isPathSelectedViaGroup(path.id);
    const hasPointSelected = selection.points.some((p) => p.pathId === path.id);
    const isEditing = editingId === path.id && editingType === "path";
    const avgColor = getPathAverageColor(path);
    const isDragging = draggedItem?.id === path.id;
    const dropClass = getDropIndicatorClass(path.id, "path");
    const dropIndent = getDropIndent(path.id);

    return (
      <div
        key={path.id}
        className={`${styles.item} ${isSelected ? styles.selected : ""} ${hasPointSelected ? styles.partialSelected : ""} ${isDragging ? styles.dragging : ""} ${dropClass}`}
        style={{ paddingLeft: `${6 + depth * 16}px`, "--drop-indent": dropIndent } as React.CSSProperties}
        onClick={(e) => handlePathClick(path.id, e)}
        draggable={!isEditing}
        onDragStart={(e) => handleDragStart(e, path.id, "path", path.parentId)}
        onDragEnd={handleDragEnd}
        onDragOver={(e) => handleDragOver(e, path.id, "path", path.parentId, depth)}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
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

  const renderRasterItem = (raster: Raster, depth: number) => {
    const isSelected = selection.pathIds.includes(raster.id) || isRasterSelectedViaGroup(raster.id);
    const isEditing = editingId === raster.id && editingType === "raster";
    const isDragging = draggedItem?.id === raster.id;
    const dropClass = getDropIndicatorClass(raster.id, "raster");
    const dropIndent = getDropIndent(raster.id);

    return (
      <div
        key={raster.id}
        className={`${styles.item} ${isSelected ? styles.selected : ""} ${isDragging ? styles.dragging : ""} ${dropClass}`}
        style={{ paddingLeft: `${6 + depth * 16}px`, "--drop-indent": dropIndent } as React.CSSProperties}
        onClick={(e) => handleRasterClick(raster.id, e)}
        draggable={!isEditing}
        onDragStart={(e) => handleDragStart(e, raster.id, "raster", raster.parentId)}
        onDragEnd={handleDragEnd}
        onDragOver={(e) => handleDragOver(e, raster.id, "raster", raster.parentId, depth)}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <span className={styles.collapseToggleSpacer} />
        <button
          className={`${styles.toggle} ${!raster.visible ? styles.hidden : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            store.setRasterVisible(raster.id, !raster.visible);
          }}
          title={raster.visible ? "Hide raster" : "Show raster"}
        >
          {raster.visible ? "\u25C9" : "\u25CE"}
        </button>
        <button
          className={`${styles.toggle} ${raster.locked ? styles.locked : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            store.setRasterLocked(raster.id, !raster.locked);
          }}
          title={raster.locked ? "Unlock raster" : "Lock raster"}
        >
          {raster.locked ? "\u{1F512}" : "\u{1F513}"}
        </button>
        <span className={styles.rasterIcon}>{"\u{1F5BC}"}</span>
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
            onDoubleClick={(e) => handleDoubleClick(raster.id, "raster", raster.name, e)}
          >
            {raster.name}
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
            } else if (node.type === "groupEnd") {
              return renderGroupEndDropZone(node.groupId, node.parentId, node.depth);
            } else if (node.type === "raster") {
              return renderRasterItem(node.raster, node.depth);
            } else {
              return renderPathItem(node.path, node.depth);
            }
          })
        )}
      </div>
    </div>
  );
};
