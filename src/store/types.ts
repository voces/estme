import { AnchorMeta, Group, HandleType, Path, Point, PointReference, SnapConnection, Tool } from "../types.ts";
import { BooleanOperation } from "../pathBool.ts";

// Re-export HandleType for convenience
export type { HandleType } from "../types.ts";

// Point selection: which specific point is selected within a path
export type PointSelection = {
  pathId: string;
  segmentIndex: number;
  handleType: HandleType;
};

// Selection can include multiple paths and/or multiple points
export type Selection = {
  pathIds: string[]; // Fully selected paths
  points: PointSelection[]; // Individual point selections
};

// Command types for undo/redo
export type Command =
  | { type: "addPath"; path: Path }
  | { type: "deletePath"; path: Path }
  | { type: "selectPath"; prevId: string | null; newId: string | null }
  | { type: "translatePath"; id: string; dx: number; dy: number }
  | { type: "rotatePath"; id: string; angle: number; center: Point }
  | { type: "movePoint"; id: string; pointIndex: number; dx: number; dy: number }
  | { type: "moveHandle"; id: string; segmentIndex: number; handleType: HandleType; dx: number; dy: number }
  | { type: "setAnchorMeta"; id: string; anchorIndex: number; prevMeta: AnchorMeta; newMeta: AnchorMeta }
  | { type: "toggleControl"; id: string; anchorIndex: number; handleType: "left" | "right"; prevMeta: AnchorMeta; newMeta: AnchorMeta; prevControlPos: Point; newControlPos: Point }
  | { type: "setMirror"; id: string; anchorIndex: number; prevMeta: AnchorMeta; newMeta: AnchorMeta; prevC0: Point; newC0: Point; prevC1: Point; newC1: Point }
  | { type: "deleteAnchor"; id: string; anchorIndex: number; prevPath: Path }
  | { type: "setPathFill"; id: string; prevFill: string; newFill: string }
  | { type: "insertAnchor"; id: string; segmentIndex: number; t: number; prevPath: Path }
  | { type: "setPathVisible"; id: string; visible: boolean }
  | { type: "setPathLocked"; id: string; locked: boolean }
  | { type: "setPathName"; id: string; prevName: string; newName: string }
  | { type: "splitPath"; originalPath: Path; newPath1: Path; newPath2: Path }
  | { type: "joinPaths"; originalPaths: Path[]; newPath: Path }
  | { type: "booleanOp"; originalPaths: Path[]; resultPaths: Path[]; operation: BooleanOperation }
  | { type: "batch"; commands: Command[] }
  // Group commands
  | { type: "addGroup"; group: Group }
  | { type: "deleteGroup"; group: Group; childPathIds: string[]; childGroupIds: string[] }
  | { type: "setGroupName"; id: string; prevName: string; newName: string }
  | { type: "setGroupCollapsed"; id: string; collapsed: boolean }
  | { type: "moveToGroup"; itemId: string; itemType: "path" | "group"; prevParentId: string | null; newParentId: string | null }
  // Snap connection commands
  | { type: "addSnapConnection"; connection: SnapConnection }
  | { type: "removeSnapConnection"; connection: SnapConnection }
  | { type: "updateSnapConnection"; prevConnection: SnapConnection; newConnection: SnapConnection };

// Clipboard content - can hold full paths or individual anchors
export type ClipboardContent = {
  type: "paths";
  paths: Path[];
} | {
  type: "anchors";
  // Store anchor data with relative positions from clipboard center
  anchors: { pathId: string; segmentIndex: number; point: Point; meta: AnchorMeta }[];
  center: Point;
} | null;

// Hovered edge info
export type HoveredEdge = {
  pathId: string;
  segmentIndex: number;
  t: number; // Parameter along the bezier (0-1)
  point: Point; // Closest point on the edge
} | null;

// Hovered point info
export type HoveredPoint = {
  pathId: string;
  segmentIndex: number;
  handleType: HandleType;
} | null;

// Pending boolean operation - when user triggers a bool op without intersecting paths,
// we enter drawing mode and apply the operation when the new path is completed
export type PendingBooleanOp = {
  operation: BooleanOperation;
  targetPathIds: string[]; // The selected paths to apply the operation against
} | null;

export type EditorState = {
  tool: Tool;
  paths: Path[];
  groups: Group[];
  currentPath: Point[] | null;
  currentPathId: string | null;
  hoverPoint: Point | null;
  hoveredEdge: HoveredEdge;
  hoveredPoint: HoveredPoint;
  hoveredPathId: string | null;
  selection: Selection;
  fillColor: string;
  showAllPoints: boolean;
  showAllControlPoints: boolean;
  undoStack: Command[];
  redoStack: Command[];
  // Status bar info
  mousePosition: Point | null;
  zoom: number;
  // Clipboard
  clipboard: ClipboardContent;
  // Path naming counter (for generating unique names)
  pathCounter: number;
  // Group naming counter
  groupCounter: number;
  // Snap connections between points
  snapConnections: SnapConnection[];
  // Pending boolean operation (when drawing a new path to apply against selection)
  pendingBooleanOp: PendingBooleanOp;
};

export const emptySelection: Selection = { pathIds: [], points: [] };
