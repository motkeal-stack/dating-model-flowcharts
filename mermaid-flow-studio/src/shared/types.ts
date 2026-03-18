export type DiagramType = "flowchart" | "mindmap";
export type PatchMode = "chat" | "code" | "visual";
export type StylePreset = "clean" | "focus" | "warm";
export type ExportFormat = "mmd" | "svg" | "png";

export interface OutlineNode {
  id: string;
  label: string;
  depth: number;
  parentId: string | null;
  children: string[];
  classes: string[];
}

export interface FlowListItem {
  flowId: string;
  title: string;
  diagramType: DiagramType;
  fileName: string;
}

export interface FlowSnapshot {
  flowId: string;
  title: string;
  diagramType: DiagramType;
  source: string;
  outline: OutlineNode[];
  rootId: string | null;
  selectedNodeId: string | null;
  issues: string[];
  updatedAt: string;
  canRender: boolean;
}

export interface CreateDiagramInput {
  title: string;
  diagramType: DiagramType;
  briefHe: string;
  stylePreset?: StylePreset;
}

export interface LoadFlowInput {
  flowId: string;
}

export interface PatchSubtreeInput {
  flowId: string;
  targetNodeId: string;
  instructionHe: string;
  mode: PatchMode;
}

export interface LintAndRepairInput {
  flowId: string;
}

export interface ExportDiagramInput {
  flowId: string;
  format: ExportFormat;
}

export interface ExportPayload {
  flowId: string;
  format: ExportFormat;
  fileName: string;
  mimeType: string;
  textContent?: string;
  source: string;
  diagramType: DiagramType;
  renderedClientSide: boolean;
}
