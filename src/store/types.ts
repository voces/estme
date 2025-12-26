import { AnchorMeta, Group, HandleType, Path, PathTransform, Point, PointReference, Raster, SnapConnection, Tool } from "../types.ts";
import { BooleanOperation } from "../pathBool.ts";
import { AnimationClip, PartAnimation } from "../animation.ts";

// Selected keyframe in timeline (can be multiple keyframes)
export type SelectedKeyframe = {
  pathId: string;
  time: number;
};

export type SelectedKeyframes = SelectedKeyframe[];

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
  | { type: "translatePath"; id: string; dx: number; dy: number; skipSnap?: boolean }
  | { type: "rotatePath"; id: string; angle: number; center: Point }
  | { type: "scalePath"; id: string; scale: number; center: Point }
  | { type: "movePoint"; id: string; pointIndex: number; dx: number; dy: number }
  | { type: "moveHandle"; id: string; segmentIndex: number; handleType: HandleType; dx: number; dy: number; mirrorMove?: { segmentIndex: number; handleType: HandleType; dx: number; dy: number } }
  | { type: "setAnchorMeta"; id: string; anchorIndex: number; prevMeta: AnchorMeta; newMeta: AnchorMeta }
  | { type: "toggleControl"; id: string; anchorIndex: number; handleType: "left" | "right"; prevMeta: AnchorMeta; newMeta: AnchorMeta; prevControlPos: Point; newControlPos: Point }
  | { type: "setMirror"; id: string; anchorIndex: number; prevMeta: AnchorMeta; newMeta: AnchorMeta; prevC0: Point; newC0: Point; prevC1: Point; newC1: Point }
  | { type: "deleteAnchor"; id: string; anchorIndex: number; prevPath: Path }
  | { type: "setPathFill"; id: string; prevFill: string; newFill: string }
  | { type: "setPathOpacity"; id: string; prevOpacity: number; newOpacity: number }
  | { type: "insertAnchor"; id: string; segmentIndex: number; t: number; prevPath: Path }
  | { type: "setPathVisible"; id: string; visible: boolean }
  | { type: "setPathLocked"; id: string; locked: boolean }
  | { type: "setPathPlayerMask"; id: string; playerMask: boolean }
  | { type: "setPathName"; id: string; prevName: string; newName: string }
  | { type: "splitPath"; originalPath: Path; newPath1: Path; newPath2: Path; idx1: number; idx2: number }
  | { type: "joinPaths"; originalPaths: Path[]; newPath: Path }
  | { type: "booleanOp"; originalPaths: Path[]; resultPaths: Path[]; operation: BooleanOperation }
  | { type: "batch"; commands: Command[] }
  // Group commands
  | { type: "addGroup"; group: Group }
  | { type: "deleteGroup"; group: Group; childPathIds: string[]; childGroupIds: string[] }
  | { type: "setGroupName"; id: string; prevName: string; newName: string }
  | { type: "setGroupCollapsed"; id: string; collapsed: boolean }
  | { type: "moveToGroup"; itemId: string; itemType: "path" | "group" | "raster"; prevParentId: string | null; newParentId: string | null }
  // Reorder commands (for z-order / hierarchy position)
  | { type: "reorderItem"; itemId: string; itemType: "path" | "group" | "raster"; prevIndex: number; newIndex: number }
  // Raster commands
  | { type: "addRaster"; raster: Raster }
  | { type: "deleteRaster"; raster: Raster }
  | { type: "setRasterVisible"; id: string; visible: boolean }
  | { type: "setRasterLocked"; id: string; locked: boolean }
  | { type: "setRasterName"; id: string; prevName: string; newName: string }
  | { type: "setRasterOpacity"; id: string; prevOpacity: number; newOpacity: number }
  | { type: "setRasterTransform"; id: string; prevTransform: PathTransform; newTransform: PathTransform }
  | { type: "setRasterPosition"; id: string; prevX: number; prevY: number; newX: number; newY: number }
  | { type: "setRasterSize"; id: string; prevWidth: number; prevHeight: number; newWidth: number; newHeight: number }
  | { type: "setRasterRenderOrder"; id: string; renderOrder: "front" | "back" }
  | { type: "reorderPaths"; prevPathIds: string[]; newPathIds: string[] }
  // Snap connection commands
  | { type: "addSnapConnection"; connection: SnapConnection }
  | { type: "removeSnapConnection"; connection: SnapConnection }
  | { type: "updateSnapConnection"; prevConnection: SnapConnection; newConnection: SnapConnection }
  // Animation commands
  | { type: "addAnimationClip"; clip: AnimationClip }
  | { type: "deleteAnimationClip"; clip: AnimationClip }
  | { type: "updateAnimationClip"; prevClip: AnimationClip; newClip: AnimationClip }
  // Unified keyframe commands - operates on entire PartAnimation array
  | { type: "setPartAnimation"; clipId: string; partId: string; prevAnimation: PartAnimation; newAnimation: PartAnimation }
  // Path transform commands
  | { type: "setPathTransform"; id: string; prevTransform: PathTransform; newTransform: PathTransform }
  // Transform point commands
  | { type: "setTransformPoint"; itemId: string; itemType: "path" | "group"; prevPoint: Point | null; newPoint: Point | null }
  // Bake transform commands
  | { type: "bakeTransform"; id: string; prevPath: Path };

// Clipboard content - can hold full paths, individual anchors, or keyframes
export type ClipboardContent = {
  type: "paths";
  paths: Path[];
  sourceIds: string[]; // Original path IDs (for inserting after source)
  sourceNames: string[]; // Original path names (for naming copies)
} | {
  type: "anchors";
  // Store anchor data with relative positions from clipboard center
  anchors: { pathId: string; segmentIndex: number; point: Point; meta: AnchorMeta }[];
  center: Point;
} | {
  type: "keyframes";
  // Store keyframe data from selected keyframes
  // Each entry is a keyframe with its property values (relative time offset from first keyframe)
  keyframes: { partId: string; keyframe: { t: number; tx?: number; ty?: number; rot?: number; scale?: number; opacity?: number } }[];
  baseTime: number; // The time of the first selected keyframe (used as reference for relative time)
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

// Instance rendering properties (not part of document data, stored in localStorage)
export type InstanceProperties = {
  opacity: number; // 0-1, instance-level opacity multiplier
  vertexColor: string; // Hex color, multiplied with per-vertex colors
  accentColor: string; // Hex color for player-masked vertices
  minimapMask: boolean; // When true, render as solid accent color silhouette
};

export type EditorState = {
  // Whether the initial document is still loading
  isLoadingDocument: boolean;
  // Document ID (unique identifier for this document)
  documentId: string | null;
  // Document name (used for save filename)
  documentName: string;
  // Whether this document has unsaved changes
  isDirty: boolean;
  tool: Tool;
  paths: Path[];
  groups: Group[];
  rasters: Raster[];
  currentPath: Point[] | null;
  currentPathId: string | null;
  hoverPoint: Point | null;
  hoveredEdge: HoveredEdge;
  hoveredPoint: HoveredPoint;
  hoveredPathId: string | null;
  selection: Selection;
  fillColor: string;
  fillOpacity: number;
  blobRadius: number;
  blobSimplify: number;
  showAllPoints: boolean;
  showAllControlPoints: boolean;
  showTransformPoints: boolean;
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
  // Raster naming counter
  rasterCounter: number;
  // Snap connections between points
  snapConnections: SnapConnection[];
  // Pending boolean operation (when drawing a new path to apply against selection)
  pendingBooleanOp: PendingBooleanOp;
  // Animation clips
  animationClips: AnimationClip[];
  // Currently selected animation clip ID (for editing)
  currentClipId: string | null;
  // Current playback time in the timeline (seconds)
  playbackTime: number;
  // Is animation playing?
  isPlaying: boolean;
  // Selected keyframe in timeline (for editing in Properties panel)
  selectedKeyframes: SelectedKeyframes;
  // Instance rendering properties (not part of document, stored separately in localStorage)
  instanceProperties: InstanceProperties;
};

export const emptySelection: Selection = { pathIds: [], points: [] };
