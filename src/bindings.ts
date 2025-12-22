/**
 * Input Bindings
 *
 * This file is the single source of truth for all mouse and keyboard bindings.
 * Event handlers should import and use these constants.
 */

// =============================================================================
// KEY CODES
// =============================================================================

export const Keys = {
  // Tools
  SELECT_TOOL: "v",
  LINE_TOOL: "p",
  BLOB_TOOL: "b",

  // Edit
  UNDO: "z",
  DELETE: "Delete",
  BACKSPACE: "Backspace",

  // Clipboard
  COPY: "c",
  CUT: "x",
  PASTE: "v",

  // Selection
  SELECT_ALL: "a",
  DESELECT_ALL: "a", // Ctrl+Shift+A
  ESCAPE: "Escape",

  // Groups
  GROUP: "g",

  // Path operations (plain keys)
  SPLIT: "s",
  UNITE: "u",
  INTERSECT: "i",
  SUBTRACT: "d",
  EXCLUDE: "x",

  // View toggles (plain keys)
  TOGGLE_ANCHORS: ".",
  TOGGLE_CONTROLS: ",",
  TOGGLE_TRANSFORM_POINTS: "/",
} as const;

// =============================================================================
// MOUSE BUTTONS
// =============================================================================

export const MouseButton = {
  LEFT: 0,
  MIDDLE: 1,
  RIGHT: 2,
} as const;

// =============================================================================
// KEYBOARD BINDING DEFINITIONS (for documentation)
// =============================================================================

export const KeyboardBindings = {
  // Tool Selection
  tools: {
    select: { key: Keys.SELECT_TOOL, description: "Switch to Select tool" },
    line: { key: Keys.LINE_TOOL, description: "Switch to Line/Pen tool" },
  },

  // Edit Operations
  edit: {
    undo: { key: Keys.UNDO, ctrl: true, description: "Undo last action" },
    redo: { key: Keys.UNDO, ctrl: true, shift: true, description: "Redo last undone action" },
    delete: { key: Keys.DELETE, description: "Delete selection" },
  },

  // Clipboard Operations
  clipboard: {
    copy: { key: Keys.COPY, ctrl: true, description: "Copy selection" },
    cut: { key: Keys.CUT, ctrl: true, description: "Cut selection" },
    paste: { key: Keys.PASTE, ctrl: true, description: "Paste clipboard" },
  },

  // Selection
  selection: {
    selectAll: { key: Keys.SELECT_ALL, ctrl: true, description: "Select all paths" },
    deselectAll: { key: Keys.DESELECT_ALL, alt: true, description: "Deselect all" },
    escape: { key: Keys.ESCAPE, description: "Clear selection / Cancel current path" },
  },

  // Path operations (plain keys)
  pathOps: {
    split: { key: Keys.SPLIT, description: "Split path at selected points" },
    unite: { key: Keys.UNITE, description: "Unite selected paths" },
    intersect: { key: Keys.INTERSECT, description: "Intersect selected paths" },
    subtract: { key: Keys.SUBTRACT, description: "Subtract second path from first" },
    exclude: { key: Keys.EXCLUDE, description: "Exclude (XOR) selected paths" },
  },

  // View toggles
  view: {
    toggleAnchors: { key: Keys.TOGGLE_ANCHORS, description: "Toggle show all anchor points" },
    toggleControls: { key: Keys.TOGGLE_CONTROLS, description: "Toggle show all control points" },
  },
} as const;

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/** Check if the event target is a text input element */
export function isTextInput(e: KeyboardEvent): boolean {
  const target = e.target as HTMLElement;
  if (!target) return false;
  const tagName = target.tagName.toLowerCase();
  // Check for input, textarea, or contenteditable
  if (tagName === "input" || tagName === "textarea") return true;
  if (target.isContentEditable) return true;
  return false;
}

/** Check if a keyboard event matches a binding */
export function matchesKey(
  e: KeyboardEvent,
  key: string,
  options?: { ctrl?: boolean; shift?: boolean; alt?: boolean }
): boolean {
  const { ctrl = false, shift = false, alt = false } = options ?? {};
  return (
    e.key.toLowerCase() === key.toLowerCase() &&
    e.ctrlKey === ctrl &&
    e.shiftKey === shift &&
    e.altKey === alt
  );
}

/** Check if event is undo (Ctrl+Z without shift) */
export function isUndo(e: KeyboardEvent): boolean {
  return matchesKey(e, Keys.UNDO, { ctrl: true });
}

/** Check if event is redo (Ctrl+Shift+Z) */
export function isRedo(e: KeyboardEvent): boolean {
  return matchesKey(e, Keys.UNDO, { ctrl: true, shift: true });
}

/** Check if event is copy (Ctrl+C) */
export function isCopy(e: KeyboardEvent): boolean {
  return matchesKey(e, Keys.COPY, { ctrl: true });
}

/** Check if event is cut (Ctrl+X) */
export function isCut(e: KeyboardEvent): boolean {
  return matchesKey(e, Keys.CUT, { ctrl: true });
}

/** Check if event is paste (Ctrl+V) */
export function isPaste(e: KeyboardEvent): boolean {
  return matchesKey(e, Keys.PASTE, { ctrl: true });
}

/** Check if event is select all (Ctrl+A) */
export function isSelectAll(e: KeyboardEvent): boolean {
  return matchesKey(e, Keys.SELECT_ALL, { ctrl: true });
}

/** Check if event is deselect all (Alt+A) */
export function isDeselectAll(e: KeyboardEvent): boolean {
  return matchesKey(e, Keys.DESELECT_ALL, { alt: true });
}

/** Check if event is delete */
export function isDelete(e: KeyboardEvent): boolean {
  return e.key === Keys.DELETE || e.key === Keys.BACKSPACE;
}

/** Check if event is escape */
export function isEscape(e: KeyboardEvent): boolean {
  return e.key === Keys.ESCAPE;
}

/** Check if event is select tool */
export function isSelectTool(e: KeyboardEvent): boolean {
  return e.key.toLowerCase() === Keys.SELECT_TOOL && !e.ctrlKey;
}

/** Check if event is line tool */
export function isLineTool(e: KeyboardEvent): boolean {
  return e.key.toLowerCase() === Keys.LINE_TOOL && !e.ctrlKey;
}

/** Check if event is blob tool */
export function isBlobTool(e: KeyboardEvent): boolean {
  return e.key.toLowerCase() === Keys.BLOB_TOOL && !e.ctrlKey;
}

/** Check if event is group (G without modifiers) */
export function isGroup(e: KeyboardEvent): boolean {
  return e.key.toLowerCase() === Keys.GROUP && !e.ctrlKey && !e.altKey && !e.shiftKey;
}

/** Check if event is ungroup (Shift+G) */
export function isUngroup(e: KeyboardEvent): boolean {
  return e.key.toLowerCase() === Keys.GROUP && e.shiftKey && !e.ctrlKey && !e.altKey;
}

/** Check if event is split path (S) */
export function isSplitPath(e: KeyboardEvent): boolean {
  return e.key.toLowerCase() === Keys.SPLIT && !e.ctrlKey && !e.altKey && !e.shiftKey;
}

/** Check if event is unite paths (U) */
export function isUnite(e: KeyboardEvent): boolean {
  return e.key.toLowerCase() === Keys.UNITE && !e.ctrlKey && !e.altKey && !e.shiftKey;
}

/** Check if event is intersect paths (I) */
export function isIntersect(e: KeyboardEvent): boolean {
  return e.key.toLowerCase() === Keys.INTERSECT && !e.ctrlKey && !e.altKey && !e.shiftKey;
}

/** Check if event is subtract paths (D) */
export function isSubtract(e: KeyboardEvent): boolean {
  return e.key.toLowerCase() === Keys.SUBTRACT && !e.ctrlKey && !e.altKey && !e.shiftKey;
}

/** Check if event is exclude paths (X) */
export function isExclude(e: KeyboardEvent): boolean {
  return e.key.toLowerCase() === Keys.EXCLUDE && !e.ctrlKey && !e.altKey && !e.shiftKey;
}

/** Check if event is toggle show all anchors (.) */
export function isToggleAnchors(e: KeyboardEvent): boolean {
  return e.key === Keys.TOGGLE_ANCHORS && !e.ctrlKey && !e.altKey && !e.shiftKey;
}

/** Check if event is toggle show all controls (,) */
export function isToggleControls(e: KeyboardEvent): boolean {
  return e.key === Keys.TOGGLE_CONTROLS && !e.ctrlKey && !e.altKey && !e.shiftKey;
}

// =============================================================================
// MOUSE BINDINGS - SELECT TOOL
// =============================================================================

export const SelectToolBindings = {
  // Click Actions
  click: {
    selectPath: { button: "left", description: "Select path under cursor" },
    selectPoint: { button: "left", description: "Select anchor point under cursor" },
    selectHandle: { button: "left", description: "Select control handle under cursor" },
    selectEdge: { button: "left", description: "Select edge (both endpoints)" },
    addToSelection: { button: "left", shift: true, description: "Add to / toggle in selection" },
    clearSelection: { button: "left", target: "empty", description: "Clear selection (click empty space)" },
  },

  // Double Click
  doubleClick: {
    insertAnchor: { button: "left", target: "edge", description: "Insert anchor point on edge" },
  },

  // Drag Actions
  drag: {
    movePath: { button: "left", target: "path", description: "Move selected path(s)" },
    movePoint: { button: "left", target: "point", description: "Move selected point(s)" },
    moveHandle: { button: "left", target: "handle", description: "Move control handle" },
    moveEdge: { button: "left", target: "edge", description: "Move edge (both endpoints)" },
    boxSelect: { button: "left", target: "empty", description: "Box select paths/points" },
    boxSelectAdd: { button: "left", target: "empty", shift: true, description: "Box select (additive)" },
    rotate: { button: "left", alt: true, description: "Rotate selection around center" },
    pan: { button: "middle", description: "Pan camera" },
  },

  // Scroll
  scroll: {
    zoom: { wheel: true, description: "Zoom in/out at cursor" },
  },
} as const;

// =============================================================================
// MOUSE BINDINGS - LINE TOOL
// =============================================================================

export const LineToolBindings = {
  // Click Actions
  click: {
    addPoint: { button: "left", description: "Add point to current path" },
    closePath: { button: "left", target: "firstPoint", description: "Close path (click first point)" },
    snapToPoint: { button: "left", shift: true, description: "Snap to nearest existing point" },
  },

  // Double Click
  doubleClick: {
    finishPath: { button: "left", description: "Finish and close current path" },
  },

  // Drag Actions
  drag: {
    pan: { button: "middle", description: "Pan camera" },
  },

  // Scroll
  scroll: {
    zoom: { wheel: true, description: "Zoom in/out at cursor" },
  },

  // Keyboard during line tool
  keyboard: {
    cancelPath: { key: "Escape", description: "Cancel current path" },
  },
} as const;

// =============================================================================
// MODIFIER KEY EFFECTS
// =============================================================================

export const ModifierEffects = {
  shift: {
    selectTool: "Add to selection / Toggle in selection",
    lineTool: "Snap to nearest existing point",
    boxSelect: "Additive box selection",
  },
  alt: {
    selectTool: "Rotate instead of translate while dragging",
  },
  ctrl: {
    global: "Keyboard shortcuts (undo, redo, copy, cut, paste, select all)",
  },
} as const;

// =============================================================================
// HOVER EFFECTS
// =============================================================================

export const HoverEffects = {
  point: {
    anchor: { color: 0x44ffff, description: "Cyan highlight on anchor points" },
    control: { color: 0x44ffff, description: "Cyan highlight on control handles" },
  },
  edge: {
    description: "Cyan tube highlight along edge curve",
  },
  path: {
    description: "Cyan outline around path shape",
  },
} as const;

// =============================================================================
// VISUAL FEEDBACK
// =============================================================================

export const VisualFeedback = {
  selection: {
    selectedAnchor: { color: 0xffff00, description: "Yellow for selected anchors" },
    selectedHandle: { color: 0xff8800, description: "Orange for selected handles" },
    unselectedAnchor: { color: 0x4488ff, description: "Blue for unselected anchors" },
    dimAnchor: { color: 0x446688, description: "Dim blue for anchors in line tool mode" },
  },
  boxSelect: {
    color: 0x4488ff,
    description: "Blue dashed rectangle during box selection",
  },
  preview: {
    description: "Semi-transparent preview of path being drawn",
  },
} as const;

// =============================================================================
// HIERARCHY PANEL BINDINGS
// =============================================================================

export const HierarchyBindings = {
  click: {
    selectPath: { button: "left", description: "Select path" },
    toggleSelect: { button: "left", shift: true, description: "Toggle path in selection" },
    toggleVisibility: { button: "left", target: "eyeIcon", description: "Toggle path visibility" },
    toggleLock: { button: "left", target: "lockIcon", description: "Toggle path lock" },
  },
} as const;

// =============================================================================
// PROPERTIES PANEL BINDINGS
// =============================================================================

export const PropertiesBindings = {
  input: {
    editValue: { description: "Click and type to edit numeric values" },
    colorPicker: { description: "Click color swatch to open color picker" },
    checkbox: { description: "Click to toggle boolean properties" },
  },
} as const;
