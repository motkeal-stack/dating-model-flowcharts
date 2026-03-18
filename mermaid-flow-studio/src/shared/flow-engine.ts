import {
  CreateDiagramInput,
  DiagramType,
  FlowSnapshot,
  OutlineNode,
  PatchMode,
  StylePreset,
} from "./types.js";

type MermaidNode = {
  id: string;
  label: string;
  originalLabel: string;
  originalRaw?: string;
  classes: Set<string>;
  inlineMindmapClasses: string[];
};

type MermaidEdge = {
  from: string;
  to: string;
  label: string | null;
  originalLabel: string | null;
  connector: string;
  originalRaw?: string;
  kind: "directed" | "layout";
};

type MermaidDocument = {
  diagramType: DiagramType;
  headerLine: string;
  directives: string[];
  comments: string[];
  classDefs: string[];
  otherLines: string[];
  nodes: Map<string, MermaidNode>;
  nodeOrder: string[];
  edges: MermaidEdge[];
  rootId: string | null;
};

type PatchOperation =
  | { type: "replace-source"; source: string }
  | { type: "rename-node"; label: string }
  | { type: "add-child"; label: string }
  | { type: "add-sibling"; label: string }
  | { type: "delete-node" }
  | { type: "set-emphasis"; className: string | null }
  | { type: "set-edge-label"; label: string | null };

type OutlineSeed = {
  id: string;
  label: string;
  depth: number;
  parentId: string | null;
};

const ID_PATTERN = /[A-Za-z_][\w-]*/g;
const CONNECTOR_PATTERN = /-->|==>|-\.->|~~~/;
const DEFAULT_FLOWCHART_DIRECTIVE =
  '%%{init: {"flowchart": {"useMaxWidth": false, "htmlLabels": true}}}%%';
const DEFAULT_FLOWCHART_CLASS_DEFS = [
  "classDef default fill:#ffffff,stroke:#d0d7de,stroke-width:1.6px,color:#1f2937,rx:10px,ry:10px;",
  "classDef highlighted fill:#ecfeff,stroke:#0891b2,stroke-width:2.4px,color:#164e63,rx:12px,ry:12px;",
  "classDef primaryAction fill:#eff6ff,stroke:#2563eb,stroke-width:2px,color:#1d4ed8,rx:10px,ry:10px;",
  "classDef painPoint fill:#fff1f2,stroke:#e11d48,stroke-width:2px,color:#881337,rx:10px,ry:10px;",
  "classDef rootNode fill:#f8fafc,stroke:#334155,stroke-width:2.6px,color:#0f172a,rx:16px,ry:16px;",
];
const DEFAULT_MINDMAP_CONFIG = ["---", "config:", "  layout: tidy-tree", "---"];
const DEFAULT_MINDMAP_CLASS_DEFS = [
  "classDef highlighted fill:#ecfeff,stroke:#0891b2,stroke-width:2px,color:#164e63;",
  "classDef primaryAction fill:#eff6ff,stroke:#2563eb,stroke-width:2px,color:#1d4ed8;",
  "classDef painPoint fill:#fff1f2,stroke:#e11d48,stroke-width:2px,color:#881337;",
];

export function normalizeMermaidSource(source: string): string {
  return source.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim();
}

export function detectDiagramType(source: string): DiagramType | null {
  const normalized = normalizeMermaidSource(source);
  if (!normalized) {
    return null;
  }

  for (const line of normalized.split("\n")) {
    const trimmed = line.trim().toLowerCase();
    if (!trimmed) {
      continue;
    }
    if (trimmed.startsWith("flowchart") || trimmed.startsWith("graph")) {
      return "flowchart";
    }
    if (trimmed === "mindmap" || trimmed.startsWith("mindmap ")) {
      return "mindmap";
    }
  }

  return null;
}

export function createDiagramSource(input: CreateDiagramInput): string {
  const stylePreset = input.stylePreset ?? "focus";
  const tree = buildOutlineTree(input.title, input.briefHe);
  return input.diagramType === "mindmap"
    ? renderMindmapFromTree(tree, stylePreset)
    : renderFlowchartFromTree(tree, stylePreset);
}

export function createSnapshot(
  flowId: string,
  source: string,
  selectedNodeId: string | null = null,
): FlowSnapshot {
  const normalized = normalizeMermaidSource(source);
  const type = detectDiagramType(normalized);

  if (!type) {
    return {
      flowId,
      title: flowId,
      diagramType: "flowchart",
      source: normalized,
      outline: [],
      rootId: null,
      selectedNodeId,
      issues: ["לא זוהה סוג תרשים נתמך. נתמכים כרגע flowchart ו-mindmap."],
      updatedAt: new Date().toISOString(),
      canRender: false,
    };
  }

  const document = parseDocument(normalized, type);
  const outline = buildOutline(document);
  return {
    flowId,
    title: outline[0]?.label ?? flowId,
    diagramType: type,
    source: normalized,
    outline,
    rootId: document.rootId,
    selectedNodeId,
    issues: [],
    updatedAt: new Date().toISOString(),
    canRender: true,
  };
}

export function lintAndRepairSource(source: string, fallbackTitle = "תרשים חדש"): string {
  const normalized = normalizeMermaidSource(source);
  if (!normalized) {
    return createDiagramSource({
      title: fallbackTitle,
      diagramType: "flowchart",
      briefHe: "",
      stylePreset: "focus",
    });
  }

  const type = detectDiagramType(normalized);
  if (type) {
    return serializeDocument(parseDocument(normalized, type));
  }

  return createDiagramSource({
    title: fallbackTitle,
    diagramType: "flowchart",
    briefHe: normalized,
    stylePreset: "focus",
  });
}

export function applyPatch(
  source: string,
  targetNodeId: string,
  instructionHe: string,
  mode: PatchMode,
): string {
  const normalized = normalizeMermaidSource(source);
  const type = detectDiagramType(normalized);
  if (!type) {
    if (mode === "code") {
      return lintAndRepairSource(instructionHe);
    }
    throw new Error("לא ניתן לערוך תרשים שלא זוהה.");
  }

  if (mode === "code") {
    return lintAndRepairSource(instructionHe);
  }

  const document = parseDocument(normalized, type);
  const operation = resolvePatchOperation(document, targetNodeId, instructionHe, mode);
  applyOperation(document, targetNodeId, operation);
  return serializeDocument(document);
}

function parseDocument(source: string, type: DiagramType): MermaidDocument {
  return type === "mindmap" ? parseMindmap(source) : parseFlowchart(source);
}

function parseFlowchart(source: string): MermaidDocument {
  const lines = normalizeMermaidSource(source).split("\n");
  const nodes = new Map<string, MermaidNode>();
  const nodeOrder: string[] = [];
  const edges: MermaidEdge[] = [];
  const directives: string[] = [];
  const comments: string[] = [];
  const classDefs: string[] = [];
  const otherLines: string[] = [];
  let headerLine = "flowchart TD";

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      continue;
    }

    if (trimmed.startsWith("%%{")) {
      directives.push(trimmed);
      continue;
    }

    if (trimmed.startsWith("%%")) {
      comments.push(trimmed);
      continue;
    }

    if (/^(flowchart|graph)\b/i.test(trimmed)) {
      headerLine = trimmed;
      continue;
    }

    if (/^classDef\b/i.test(trimmed)) {
      classDefs.push(trimmed);
      continue;
    }

    if (/^class\b/i.test(trimmed)) {
      applyClassLine(trimmed, nodes, nodeOrder);
      continue;
    }

    const edge = parseEdgeLine(trimmed);
    if (edge) {
      ensureNode(edge.from, nodes, nodeOrder);
      ensureNode(edge.to, nodes, nodeOrder);
      edges.push(edge);
      continue;
    }

    const node = parseFlowchartNodeLine(trimmed);
    if (node) {
      const existing = ensureNode(node.id, nodes, nodeOrder);
      existing.label = node.label;
      existing.originalLabel = node.label;
      existing.originalRaw = trimmed;
      continue;
    }

    otherLines.push(trimmed);
  }

  return {
    diagramType: "flowchart",
    headerLine,
    directives,
    comments,
    classDefs,
    otherLines,
    nodes,
    nodeOrder,
    edges,
    rootId: findRootId(nodes, edges),
  };
}

function parseMindmap(source: string): MermaidDocument {
  const lines = normalizeMermaidSource(source).split("\n");
  const nodes = new Map<string, MermaidNode>();
  const nodeOrder: string[] = [];
  const edges: MermaidEdge[] = [];
  const directives: string[] = [];
  const comments: string[] = [];
  const classDefs: string[] = [];
  const otherLines: string[] = [];
  let headerLine = "mindmap";
  let inMindmap = false;
  const stack: Array<{ indent: number; id: string }> = [];
  let generatedCounter = 1;

  for (const rawLine of lines) {
    const trimmedRight = rawLine.trimEnd();
    const trimmed = trimmedRight.trim();
    if (!trimmed) {
      continue;
    }

    if (trimmed === "mindmap") {
      headerLine = "mindmap";
      inMindmap = true;
      continue;
    }

    if (!inMindmap) {
      if (trimmed === "---" || /^(config:|layout:)/.test(trimmed)) {
        directives.push(trimmedRight);
      } else {
        comments.push(trimmedRight);
      }
      continue;
    }

    if (/^classDef\b/i.test(trimmed)) {
      classDefs.push(trimmed);
      continue;
    }

    const parsed = parseMindmapNodeLine(trimmedRight, generatedCounter);
    if (!parsed) {
      otherLines.push(trimmed);
      continue;
    }
    generatedCounter = parsed.nextCounter;

    const node = ensureNode(parsed.id, nodes, nodeOrder);
    node.label = parsed.label;
    node.originalLabel = parsed.label;
    node.originalRaw = trimmedRight;
    node.inlineMindmapClasses = [...parsed.inlineClasses];
    for (const className of parsed.inlineClasses) {
      node.classes.add(className);
    }

    while (stack.length && stack[stack.length - 1].indent >= parsed.indent) {
      stack.pop();
    }

    if (stack.length) {
      edges.push({
        from: stack[stack.length - 1].id,
        to: parsed.id,
        label: null,
        originalLabel: null,
        connector: "mindmap",
        kind: "directed",
      });
    }

    stack.push({ indent: parsed.indent, id: parsed.id });
  }

  return {
    diagramType: "mindmap",
    headerLine,
    directives,
    comments,
    classDefs,
    otherLines,
    nodes,
    nodeOrder,
    edges,
    rootId: nodeOrder[0] ?? null,
  };
}

function buildOutline(document: MermaidDocument): OutlineNode[] {
  const parentById = new Map<string, string | null>();
  const childrenById = new Map<string, string[]>();
  for (const nodeId of document.nodeOrder) {
    parentById.set(nodeId, null);
    childrenById.set(nodeId, []);
  }

  for (const edge of document.edges) {
    if (edge.kind !== "directed") {
      continue;
    }
    childrenById.get(edge.from)?.push(edge.to);
    if (!parentById.get(edge.to)) {
      parentById.set(edge.to, edge.from);
    }
  }

  const roots = document.nodeOrder.filter((nodeId) => parentById.get(nodeId) === null);
  const result: OutlineNode[] = [];
  const visited = new Set<string>();

  const visit = (nodeId: string, depth: number) => {
    if (visited.has(nodeId)) {
      return;
    }
    visited.add(nodeId);
    const node = document.nodes.get(nodeId);
    if (!node) {
      return;
    }
    const children = childrenById.get(nodeId) ?? [];
    result.push({
      id: nodeId,
      label: node.label,
      depth,
      parentId: parentById.get(nodeId) ?? null,
      children: [...children],
      classes: [...node.classes],
    });

    for (const childId of children) {
      visit(childId, depth + 1);
    }
  };

  for (const rootId of roots) {
    visit(rootId, 0);
  }
  for (const nodeId of document.nodeOrder) {
    visit(nodeId, 0);
  }

  return result;
}

function serializeDocument(document: MermaidDocument): string {
  return document.diagramType === "mindmap"
    ? serializeMindmap(document)
    : serializeFlowchart(document);
}

function serializeFlowchart(document: MermaidDocument): string {
  const lines: string[] = [];
  lines.push(...(document.directives.length ? document.directives : [DEFAULT_FLOWCHART_DIRECTIVE]));
  lines.push(document.headerLine || "flowchart TD");
  lines.push(...document.comments);

  for (const nodeId of document.nodeOrder) {
    const node = document.nodes.get(nodeId);
    if (node) {
      lines.push(`    ${renderFlowchartNode(node)}`);
    }
  }

  for (const edge of document.edges) {
    if (document.nodes.has(edge.from) && document.nodes.has(edge.to)) {
      lines.push(`    ${renderEdge(edge)}`);
    }
  }

  const classDefs = document.classDefs.length ? document.classDefs : DEFAULT_FLOWCHART_CLASS_DEFS;
  lines.push("");
  lines.push(...classDefs);
  lines.push(...renderClassLines(document.nodes));

  if (document.otherLines.length) {
    lines.push("");
    lines.push(...document.otherLines);
  }

  return lines.join("\n").trim();
}

function serializeMindmap(document: MermaidDocument): string {
  const lines: string[] = [];
  lines.push(...(document.directives.length ? document.directives : DEFAULT_MINDMAP_CONFIG));
  lines.push("mindmap");

  for (const item of buildOutline(document)) {
    const node = document.nodes.get(item.id);
    if (!node) {
      continue;
    }
    const indent = "  ".repeat(item.depth + 1);
    lines.push(`${indent}${renderMindmapNode(node)}`);
  }

  const classDefs = document.classDefs.length ? document.classDefs : DEFAULT_MINDMAP_CLASS_DEFS;
  lines.push(...classDefs);
  lines.push(...document.otherLines);
  return lines.join("\n").trim();
}

function renderFlowchartFromTree(tree: OutlineSeed[], stylePreset: StylePreset): string {
  const document: MermaidDocument = {
    diagramType: "flowchart",
    headerLine: "flowchart TD",
    directives: [DEFAULT_FLOWCHART_DIRECTIVE],
    comments: [],
    classDefs: DEFAULT_FLOWCHART_CLASS_DEFS,
    otherLines: [],
    nodes: new Map(),
    nodeOrder: [],
    edges: [],
    rootId: "n_root",
  };

  for (const item of tree) {
    const node = ensureNode(item.id, document.nodes, document.nodeOrder);
    node.label = item.label;
    node.originalLabel = item.label;
  }

  for (const item of tree) {
    if (item.parentId) {
      document.edges.push({
        from: item.parentId,
        to: item.id,
        label: null,
        originalLabel: null,
        connector: "-->",
        kind: "directed",
      });
    }
  }

  document.nodes.get("n_root")?.classes.add("rootNode");
  if (stylePreset === "focus") {
    document.nodes.get("n_root")?.classes.add("highlighted");
  }
  if (stylePreset === "warm") {
    const firstChild = tree.find((item) => item.parentId === "n_root");
    if (firstChild) {
      document.nodes.get(firstChild.id)?.classes.add("primaryAction");
    }
  }

  return serializeFlowchart(document);
}

function renderMindmapFromTree(tree: OutlineSeed[], stylePreset: StylePreset): string {
  const document: MermaidDocument = {
    diagramType: "mindmap",
    headerLine: "mindmap",
    directives: DEFAULT_MINDMAP_CONFIG,
    comments: [],
    classDefs: DEFAULT_MINDMAP_CLASS_DEFS,
    otherLines: [],
    nodes: new Map(),
    nodeOrder: [],
    edges: [],
    rootId: "n_root",
  };

  for (const item of tree) {
    const node = ensureNode(item.id, document.nodes, document.nodeOrder);
    node.label = item.label;
    node.originalLabel = item.label;
  }

  for (const item of tree) {
    if (item.parentId) {
      document.edges.push({
        from: item.parentId,
        to: item.id,
        label: null,
        originalLabel: null,
        connector: "mindmap",
        kind: "directed",
      });
    }
  }

  if (stylePreset === "focus") {
    document.nodes.get("n_root")?.classes.add("highlighted");
  }

  return serializeMindmap(document);
}

function resolvePatchOperation(
  document: MermaidDocument,
  targetNodeId: string,
  instructionHe: string,
  mode: PatchMode,
): PatchOperation {
  if (mode === "visual") {
    try {
      const parsed = JSON.parse(instructionHe) as {
        operation?: string;
        label?: string;
        className?: string | null;
      };
      switch (parsed.operation) {
        case "rename":
          return { type: "rename-node", label: parsed.label?.trim() || "צומת חדש" };
        case "add-child":
          return { type: "add-child", label: parsed.label?.trim() || "שלב חדש" };
        case "add-sibling":
          return { type: "add-sibling", label: parsed.label?.trim() || "שלב מקביל" };
        case "delete":
          return { type: "delete-node" };
        case "highlight":
          return { type: "set-emphasis", className: parsed.className ?? "highlighted" };
        case "clear-highlight":
          return { type: "set-emphasis", className: null };
        case "edge-label":
          return { type: "set-edge-label", label: parsed.label?.trim() || null };
      }
    } catch {
      // Fall back to natural language parsing.
    }
  }

  const normalized = instructionHe.trim();
  const extractedLabel = extractRequestedLabel(normalized);

  if (/(הסר הדגשה|בטל הדגשה)/.test(normalized)) {
    return { type: "set-emphasis", className: null };
  }
  if (/(הדגש|הבלט)/.test(normalized)) {
    return { type: "set-emphasis", className: "highlighted" };
  }
  if (/(מחק|הסר)\s/.test(normalized) || normalized === "מחק" || normalized === "הסר") {
    return { type: "delete-node" };
  }
  if (/(תווית|כיתוב|label).*(קשר|חץ)/.test(normalized)) {
    return { type: "set-edge-label", label: extractedLabel };
  }
  if (/(הוסף|תוסיף).*(אח|מקביל|נושא נוסף|סעיף נוסף)/.test(normalized)) {
    return { type: "add-sibling", label: extractedLabel || "נושא מקביל" };
  }
  if (/(הוסף|תוסיף).*(ילד|תת|ענף|שלב|צומת)/.test(normalized)) {
    return { type: "add-child", label: extractedLabel || "שלב חדש" };
  }
  if (/(שנה|עדכן|החלף).*(שם|טקסט|כותרת)/.test(normalized)) {
    return { type: "rename-node", label: extractedLabel || normalized };
  }

  if (!document.nodes.has(targetNodeId)) {
    throw new Error("לא נמצא צומת מתאים לעדכון.");
  }

  return { type: "rename-node", label: extractedLabel || normalized };
}

function applyOperation(document: MermaidDocument, targetNodeId: string, operation: PatchOperation): void {
  if (!document.nodes.has(targetNodeId)) {
    throw new Error(`לא מצאתי את הצומת ${targetNodeId}.`);
  }

  if (operation.type === "replace-source") {
    throw new Error("replace-source אינו אמור להגיע לכאן.");
  }

  switch (operation.type) {
    case "rename-node":
      document.nodes.get(targetNodeId)!.label = operation.label;
      return;
    case "add-child": {
      const newNodeId = createNextNodeId(document.nodes);
      const node = ensureNode(newNodeId, document.nodes, document.nodeOrder);
      node.label = operation.label;
      node.originalLabel = operation.label;
      document.edges.push({
        from: targetNodeId,
        to: newNodeId,
        label: null,
        originalLabel: null,
        connector: "-->",
        kind: "directed",
      });
      return;
    }
    case "add-sibling": {
      const parentId = findParentId(document, targetNodeId) ?? document.rootId ?? targetNodeId;
      const newNodeId = createNextNodeId(document.nodes);
      const node = ensureNode(newNodeId, document.nodes, document.nodeOrder);
      node.label = operation.label;
      node.originalLabel = operation.label;
      document.edges.push({
        from: parentId,
        to: newNodeId,
        label: null,
        originalLabel: null,
        connector: "-->",
        kind: "directed",
      });
      return;
    }
    case "delete-node": {
      const toDelete = collectDescendants(document, targetNodeId);
      for (const nodeId of toDelete) {
        document.nodes.delete(nodeId);
      }
      document.nodeOrder = document.nodeOrder.filter((nodeId) => !toDelete.has(nodeId));
      document.edges = document.edges.filter(
        (edge) => !toDelete.has(edge.from) && !toDelete.has(edge.to),
      );
      if (document.rootId && toDelete.has(document.rootId)) {
        document.rootId = document.nodeOrder[0] ?? null;
      }
      return;
    }
    case "set-emphasis": {
      const node = document.nodes.get(targetNodeId)!;
      node.classes.delete("highlighted");
      node.classes.delete("primaryAction");
      node.classes.delete("painPoint");
      if (operation.className) {
        node.classes.add(operation.className);
      }
      return;
    }
    case "set-edge-label": {
      if (document.diagramType !== "flowchart") {
        throw new Error("תוויות על קשתות נתמכות כרגע רק ב-flowchart.");
      }
      const edge =
        document.edges.find((item) => item.to === targetNodeId && item.kind === "directed") ??
        document.edges.find((item) => item.from === targetNodeId && item.kind === "directed");
      if (!edge) {
        throw new Error("לא מצאתי קשת לעדכון התווית.");
      }
      edge.label = operation.label;
      return;
    }
  }
}

function renderFlowchartNode(node: MermaidNode): string {
  if (node.originalRaw && node.label === node.originalLabel) {
    return node.originalRaw;
  }

  const wrapper: [string, string] = node.id === "n_root" ? ["((", "))"] : ['["', '"]'];
  return `${node.id}${wrapper[0]}${escapeLabel(node.label)}${wrapper[1]}`;
}

function renderMindmapNode(node: MermaidNode): string {
  const suffix = node.classes.size ? `:::${[...node.classes].join(" ")}` : "";
  if (node.id === "n_root") {
    return `${node.id}((${escapeLabel(node.label)}))${suffix}`;
  }
  return `${node.id}["${escapeLabel(node.label)}"]${suffix}`;
}

function renderEdge(edge: MermaidEdge): string {
  if (edge.kind === "layout") {
    return `${edge.from} ~~~ ${edge.to}`;
  }
  if (edge.originalRaw && edge.label === edge.originalLabel) {
    return edge.originalRaw;
  }
  if (edge.label) {
    return `${edge.from} -->|"${escapeLabel(edge.label)}"| ${edge.to}`;
  }
  return `${edge.from} --> ${edge.to}`;
}

function renderClassLines(nodes: Map<string, MermaidNode>): string[] {
  const grouped = new Map<string, string[]>();
  for (const [nodeId, node] of nodes.entries()) {
    for (const className of node.classes) {
      if (!grouped.has(className)) {
        grouped.set(className, []);
      }
      grouped.get(className)!.push(nodeId);
    }
  }
  return [...grouped.entries()].map(
    ([className, nodeIds]) => `class ${nodeIds.join(",")} ${className};`,
  );
}

function buildOutlineTree(title: string, briefHe: string): OutlineSeed[] {
  const root: OutlineSeed = {
    id: "n_root",
    label: title.trim() || "תרשים חדש",
    depth: 0,
    parentId: null,
  };

  const lines = normalizeMermaidSource(briefHe)
    .split("\n")
    .map((line) => line.replace(/\t/g, "  "))
    .filter((line) => line.trim());

  if (!lines.length) {
    return [root];
  }

  const tree: OutlineSeed[] = [root];
  const stack: Array<{ indent: number; id: string }> = [{ indent: -1, id: root.id }];
  let counter = 1;

  for (const line of lines) {
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    const label = line
      .trim()
      .replace(/^[-*•]\s*/, "")
      .replace(/^\d+[.)]\s*/, "")
      .trim();

    if (!label) {
      continue;
    }

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const item: OutlineSeed = {
      id: `n_${counter++}`,
      label,
      depth: stack.length,
      parentId: stack[stack.length - 1].id,
    };
    tree.push(item);
    stack.push({ indent, id: item.id });
  }

  return tree;
}

function parseFlowchartNodeLine(line: string): { id: string; label: string } | null {
  const trimmed = line.trim();
  if (!trimmed || CONNECTOR_PATTERN.test(trimmed) || /^style\b/i.test(trimmed)) {
    return null;
  }

  const match = trimmed.match(/^([A-Za-z_][\w-]*)\s*(.*)$/);
  if (!match || !match[2]) {
    return null;
  }

  const label = extractNodeLabel(match[2]);
  return label ? { id: match[1], label } : null;
}

function parseMindmapNodeLine(
  rawLine: string,
  counter: number,
): { id: string; label: string; indent: number; inlineClasses: string[]; nextCounter: number } | null {
  const indent = rawLine.match(/^\s*/)?.[0].length ?? 0;
  const trimmed = rawLine.trim();
  if (!trimmed || /^classDef\b/i.test(trimmed)) {
    return null;
  }

  const classMatch = trimmed.match(/:::(.+)$/);
  const inlineClasses = classMatch?.[1]?.split(/\s+/).filter(Boolean) ?? [];
  const cleaned = trimmed.replace(/:::.+$/, "").trim();
  const match = cleaned.match(/^([A-Za-z_][\w-]*)\s*(.*)$/);
  if (!match) {
    return {
      id: `n_${counter}`,
      label: cleaned,
      indent,
      inlineClasses,
      nextCounter: counter + 1,
    };
  }

  const [, idCandidate, remainder] = match;
  const label = extractNodeLabel(remainder) || cleaned;
  const hasExplicitShape = !!remainder.trim();

  return {
    id: hasExplicitShape ? idCandidate : `n_${counter}`,
    label,
    indent,
    inlineClasses,
    nextCounter: hasExplicitShape ? counter : counter + 1,
  };
}

function parseEdgeLine(line: string): MermaidEdge | null {
  const trimmed = line.trim().replace(/;$/, "");
  if (!CONNECTOR_PATTERN.test(trimmed)) {
    return null;
  }

  const tokens = [...trimmed.matchAll(ID_PATTERN)];
  if (tokens.length < 2) {
    return null;
  }

  const from = tokens[0][0];
  const to = tokens[tokens.length - 1][0];
  const fromEnd = (tokens[0].index ?? 0) + from.length;
  const toStart = tokens[tokens.length - 1].index ?? trimmed.length;
  const connector = trimmed.slice(fromEnd, toStart).trim();
  const label = connector.match(/\|([^|]+)\|/)?.[1]?.trim() ?? null;

  return {
    from,
    to,
    label,
    originalLabel: label,
    connector,
    originalRaw: trimmed,
    kind: connector.includes("~~~") ? "layout" : "directed",
  };
}

function applyClassLine(
  line: string,
  nodes: Map<string, MermaidNode>,
  nodeOrder: string[],
): void {
  const match = line.match(/^class\s+(.+?)\s+([A-Za-z_][\w-]*)\s*;?$/i);
  if (!match) {
    return;
  }

  const ids = match[1]
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  for (const id of ids) {
    ensureNode(id, nodes, nodeOrder).classes.add(match[2]);
  }
}

function extractNodeLabel(remainder: string): string | null {
  let body = remainder.replace(/:::.+$/, "").replace(/;$/, "").trim();
  if (!body) {
    return null;
  }

  for (let index = 0; index < 4; index += 1) {
    const pair = getWrapperPair(body);
    if (!pair) {
      break;
    }
    body = body.slice(pair[0].length, body.length - pair[1].length).trim();
  }

  if ((body.startsWith('"') && body.endsWith('"')) || (body.startsWith("'") && body.endsWith("'"))) {
    body = body.slice(1, -1).trim();
  }

  return body || null;
}

function getWrapperPair(value: string): [string, string] | null {
  const pairs: Array<[string, string]> = [
    ["((", "))"],
    ["[[", "]]"],
    ['["', '"]'],
    ["(", ")"],
    ["[", "]"],
    ["{", "}"],
  ];
  return pairs.find(([open, close]) => value.startsWith(open) && value.endsWith(close)) ?? null;
}

function ensureNode(
  nodeId: string,
  nodes: Map<string, MermaidNode>,
  nodeOrder: string[],
): MermaidNode {
  let node = nodes.get(nodeId);
  if (!node) {
    node = {
      id: nodeId,
      label: nodeId,
      originalLabel: nodeId,
      classes: new Set<string>(),
      inlineMindmapClasses: [],
    };
    nodes.set(nodeId, node);
    nodeOrder.push(nodeId);
  }
  return node;
}

function findRootId(nodes: Map<string, MermaidNode>, edges: MermaidEdge[]): string | null {
  const incoming = new Map<string, number>();
  for (const nodeId of nodes.keys()) {
    incoming.set(nodeId, 0);
  }
  for (const edge of edges) {
    if (edge.kind === "directed") {
      incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
    }
  }
  return [...incoming.entries()].find(([, count]) => count === 0)?.[0] ?? [...nodes.keys()][0] ?? null;
}

function findParentId(document: MermaidDocument, targetNodeId: string): string | null {
  return document.edges.find((edge) => edge.kind === "directed" && edge.to === targetNodeId)?.from ?? null;
}

function collectDescendants(document: MermaidDocument, targetNodeId: string): Set<string> {
  const adjacency = new Map<string, string[]>();
  for (const edge of document.edges) {
    if (edge.kind !== "directed") {
      continue;
    }
    if (!adjacency.has(edge.from)) {
      adjacency.set(edge.from, []);
    }
    adjacency.get(edge.from)!.push(edge.to);
  }

  const result = new Set<string>();
  const visit = (nodeId: string) => {
    if (result.has(nodeId)) {
      return;
    }
    result.add(nodeId);
    for (const childId of adjacency.get(nodeId) ?? []) {
      visit(childId);
    }
  };
  visit(targetNodeId);
  return result;
}

function createNextNodeId(nodes: Map<string, MermaidNode>): string {
  let counter = nodes.size + 1;
  while (nodes.has(`n_${counter}`)) {
    counter += 1;
  }
  return `n_${counter}`;
}

function extractRequestedLabel(instruction: string): string | null {
  const quoted = instruction.match(/"([^"]+)"/)?.[1] ?? instruction.match(/'([^']+)'/)?.[1];
  if (quoted) {
    return quoted.trim();
  }

  const markerMatch = instruction.match(/(?:בשם|לשם|לכותרת|לטקסט|ל-|ל:|:)\s*(.+)$/);
  return markerMatch?.[1]?.trim() ?? null;
}

function escapeLabel(label: string): string {
  return label.replace(/"/g, '\\"');
}
