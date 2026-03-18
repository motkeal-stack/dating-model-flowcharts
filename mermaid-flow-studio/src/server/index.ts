import express from "express";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  applyPatch,
  createDiagramSource,
  createSnapshot,
  detectDiagramType,
  lintAndRepairSource,
} from "../shared/flow-engine.js";
import {
  CreateDiagramInput,
  DiagramType,
  ExportDiagramInput,
  ExportPayload,
  FlowListItem,
  FlowSnapshot,
  LintAndRepairInput,
  PatchSubtreeInput,
} from "../shared/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_DIR = path.resolve(__dirname, "..", "..");
const DIST_WEB_DIR = path.join(APP_DIR, "dist", "web");
const WIDGET_URI = "ui://flow-studio/editor-v1.html";
const APP_NAME = "mermaid-flow-studio";
const PORT = Number(process.env.PORT ?? 3210);
const HOST = process.env.HOST ?? "127.0.0.1";
const IGNORED_DIRS = new Set([".git", "dist", "node_modules", "src", "mermaid-flow-studio"]);
const ROOT_DIR = resolveFlowsRoot();

type ToolEnvelope =
  | { kind: "snapshot"; snapshot: FlowSnapshot }
  | { kind: "flow-list"; items: FlowListItem[] }
  | { kind: "export"; exportPayload: ExportPayload };

function resolveFlowsRoot(): string {
  const configured = process.env.FLOW_STUDIO_FLOWS_ROOT?.trim();
  if (configured) {
    return path.resolve(configured);
  }

  const parentDir = path.resolve(APP_DIR, "..");
  if (path.basename(parentDir).toLowerCase() === "personal-flows") {
    return parentDir;
  }

  const siblingFlows = path.join(parentDir, "personal-flows");
  if (existsSync(siblingFlows)) {
    return siblingFlows;
  }

  return parentDir;
}

const app = createMcpExpressApp({ host: HOST });
app.use(express.json({ limit: "2mb" }));
app.use("/static", express.static(DIST_WEB_DIR));

app.get("/", async (_req, res) => {
  res.type("html").send(createStandaloneHtml());
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, port: PORT });
});

app.get("/api/flows", async (_req, res) => {
  res.json({ items: await listFlows() });
});

app.get("/api/flow", async (req, res) => {
  const flowId = String(req.query.flowId ?? "").trim();
  if (!flowId) {
    res.status(400).json({ error: "Missing flowId" });
    return;
  }
  res.json(await loadFlow(flowId));
});

app.post("/api/create", async (req, res) => {
  res.json(await createDiagram(req.body as CreateDiagramInput));
});

app.post("/api/patch", async (req, res) => {
  res.json(await patchSubtree(req.body as PatchSubtreeInput));
});

app.post("/api/lint", async (req, res) => {
  res.json(await lintAndRepair(req.body as LintAndRepairInput));
});

app.post("/api/export", async (req, res) => {
  res.json(await exportDiagram(req.body as ExportDiagramInput));
});

app.post("/mcp", async (req, res) => {
  const server = await createMcpServer();
  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on("close", () => {
      transport.close().catch(() => undefined);
      server.close().catch(() => undefined);
    });
  } catch (error) {
    console.error("MCP request failed", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

app.get("/mcp", (_req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
});

app.delete("/mcp", (_req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
});

app.listen(PORT, HOST, () => {
  console.log(`Flow Studio listening on http://${HOST}:${PORT}`);
  console.log(`Standalone UI: http://${HOST}:${PORT}/`);
  console.log(`MCP endpoint: http://${HOST}:${PORT}/mcp`);
});

async function createMcpServer(): Promise<McpServer> {
  const server = new McpServer({ name: APP_NAME, version: "0.1.0" });
  const assets = await readBuiltAssets();

  registerAppResource(server, "Flow Studio Widget", WIDGET_URI, {}, async () => ({
    contents: [
      {
        uri: WIDGET_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: createWidgetHtml(assets.js, assets.css),
        _meta: {
          ui: {
            prefersBorder: true,
            csp: {
              connectDomains: [],
              resourceDomains: [],
            },
          },
        },
      },
    ],
  }));

  registerAppTool(
    server,
    "create_diagram",
    {
      title: "Create diagram",
      description: "Use this when you want to create a new Hebrew Mermaid flow from a short brief.",
      inputSchema: {
        title: z.string().min(1),
        diagramType: z.enum(["flowchart", "mindmap"]),
        briefHe: z.string(),
        stylePreset: z.enum(["clean", "focus", "warm"]).optional(),
      },
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
      },
      _meta: {
        ui: { resourceUri: WIDGET_URI },
        "openai/toolInvocation/invoking": "יוצר תרשים חדש...",
        "openai/toolInvocation/invoked": "התרשים נוצר.",
      },
    },
    async (input) => snapshotResult(await createDiagram(input), "יצרתי תרשים חדש."),
  );

  registerAppTool(
    server,
    "load_flow",
    {
      title: "Load flow",
      description: "Use this when you want to open an existing Mermaid flow by its flowId.",
      inputSchema: {
        flowId: z.string().min(1),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
      _meta: {
        ui: { resourceUri: WIDGET_URI },
        "openai/toolInvocation/invoking": "טוען את התרשים...",
        "openai/toolInvocation/invoked": "התרשים נטען.",
      },
    },
    async ({ flowId }) => snapshotResult(await loadFlow(flowId), `התרשים ${flowId} נטען.`),
  );

  registerAppTool(
    server,
    "patch_subtree",
    {
      title: "Patch subtree",
      description:
        "Use this when you want to change only one branch, node, or sub-tree in the current Mermaid flow.",
      inputSchema: {
        flowId: z.string().min(1),
        targetNodeId: z.string().min(1),
        instructionHe: z.string().min(1),
        mode: z.enum(["chat", "code", "visual"]),
      },
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: true,
      },
      _meta: {
        ui: { resourceUri: WIDGET_URI },
        "openai/toolInvocation/invoking": "מעדכן את הענף שנבחר...",
        "openai/toolInvocation/invoked": "הענף עודכן.",
      },
    },
    async (input) => snapshotResult(await patchSubtree(input), "עדכנתי את התרשים."),
  );

  registerAppTool(
    server,
    "lint_and_repair",
    {
      title: "Lint and repair",
      description: "Use this when the Mermaid source is broken and you want a safe repair pass.",
      inputSchema: {
        flowId: z.string().min(1),
      },
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
      },
      _meta: {
        ui: { resourceUri: WIDGET_URI },
        "openai/toolInvocation/invoking": "מתקן את קוד Mermaid...",
        "openai/toolInvocation/invoked": "קוד Mermaid תוקן.",
      },
    },
    async ({ flowId }) => snapshotResult(await lintAndRepair({ flowId }), "עברתי על הקוד ותיקנתי אותו."),
  );

  registerAppTool(
    server,
    "export_diagram",
    {
      title: "Export diagram",
      description: "Use this when you want to export the current flow as mmd, svg, or png.",
      inputSchema: {
        flowId: z.string().min(1),
        format: z.enum(["mmd", "svg", "png"]),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
      _meta: {
        ui: { resourceUri: WIDGET_URI },
        "openai/toolInvocation/invoking": "מכין ייצוא...",
        "openai/toolInvocation/invoked": "הייצוא מוכן.",
      },
    },
    async (input) => exportResult(await exportDiagram(input)),
  );

  registerAppTool(
    server,
    "list_flows",
    {
      title: "List flows",
      description: "List available local Mermaid flows for the widget.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
      _meta: {
        ui: {
          resourceUri: WIDGET_URI,
          visibility: ["app"],
        },
      },
    },
    async () => listResult(await listFlows()),
  );

  return server;
}

async function listFlows(): Promise<FlowListItem[]> {
  const files = await walkForFlows(ROOT_DIR);
  const items = await Promise.all(
    files.map(async (relativePath) => {
      const source = await fs.readFile(path.join(ROOT_DIR, relativePath), "utf8");
      const flowId = toFlowId(relativePath);
      const snapshot = createSnapshot(flowId, source);
      return {
        flowId,
        title: snapshot.title,
        diagramType: snapshot.diagramType,
        fileName: path.basename(relativePath),
      } satisfies FlowListItem;
    }),
  );

  return items.sort((left, right) => left.title.localeCompare(right.title, "he"));
}

async function loadFlow(flowId: string): Promise<FlowSnapshot> {
  const { source } = await readFlowSource(flowId);
  return createSnapshot(flowId, source);
}

async function createDiagram(input: CreateDiagramInput): Promise<FlowSnapshot> {
  const flowId = await createUniqueFlowId(input.title);
  const filePath = path.join(ROOT_DIR, `${flowId}.mmd`);
  const source = createDiagramSource(input);
  await fs.writeFile(filePath, `${source}\n`, "utf8");
  return createSnapshot(flowId, source);
}

async function patchSubtree(input: PatchSubtreeInput): Promise<FlowSnapshot> {
  const { filePath, source } = await readFlowSource(input.flowId);
  const nextSource = applyPatch(source, input.targetNodeId, input.instructionHe, input.mode);
  await fs.writeFile(filePath, `${nextSource}\n`, "utf8");
  return createSnapshot(input.flowId, nextSource, input.targetNodeId);
}

async function lintAndRepair(input: LintAndRepairInput): Promise<FlowSnapshot> {
  const { filePath, source } = await readFlowSource(input.flowId);
  const nextSource = lintAndRepairSource(source, input.flowId);
  await fs.writeFile(filePath, `${nextSource}\n`, "utf8");
  return createSnapshot(input.flowId, nextSource);
}

async function exportDiagram(input: ExportDiagramInput): Promise<ExportPayload> {
  const { source } = await readFlowSource(input.flowId);
  const diagramType = detectDiagramType(source) ?? "flowchart";
  const fileName = `${path.basename(input.flowId)}.${input.format}`;

  if (input.format === "mmd") {
    return {
      flowId: input.flowId,
      format: input.format,
      fileName,
      mimeType: "text/plain;charset=utf-8",
      textContent: source,
      source,
      diagramType,
      renderedClientSide: false,
    };
  }

  return {
    flowId: input.flowId,
    format: input.format,
    fileName,
    mimeType: input.format === "svg" ? "image/svg+xml" : "image/png",
    source,
    diagramType,
    renderedClientSide: true,
  };
}

async function readFlowSource(flowId: string): Promise<{ filePath: string; source: string }> {
  const filePath = await resolveFlowPath(flowId);
  const source = await fs.readFile(filePath, "utf8");
  return { filePath, source };
}

async function resolveFlowPath(flowId: string): Promise<string> {
  const directCandidate = path.join(ROOT_DIR, `${flowId}.mmd`);
  if (await fileExists(directCandidate)) {
    return directCandidate;
  }

  const files = await walkForFlows(ROOT_DIR);
  const exact = files.find((relativePath) => toFlowId(relativePath) === flowId);
  if (exact) {
    return path.join(ROOT_DIR, exact);
  }

  const byBaseName = files.find((relativePath) => path.basename(relativePath, ".mmd") === flowId);
  if (byBaseName) {
    return path.join(ROOT_DIR, byBaseName);
  }

  throw new Error(`Flow "${flowId}" was not found.`);
}

async function walkForFlows(dirPath: string, prefix = ""): Promise<string[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const results: string[] = [];

  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) {
      continue;
    }

    const relativePath = prefix ? path.join(prefix, entry.name) : entry.name;
    const absolutePath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await walkForFlows(absolutePath, relativePath)));
      continue;
    }

    if (entry.isFile() && entry.name.toLowerCase().endsWith(".mmd")) {
      results.push(relativePath);
    }
  }

  return results;
}

function toFlowId(relativePath: string): string {
  return relativePath.replace(/\\/g, "/").replace(/\.mmd$/i, "");
}

async function createUniqueFlowId(title: string): Promise<string> {
  const base = sanitizeTitleToFlowId(title);
  let candidate = base;
  let counter = 2;
  while (await fileExists(path.join(ROOT_DIR, `${candidate}.mmd`))) {
    candidate = `${base}-${counter}`;
    counter += 1;
  }
  return candidate;
}

function sanitizeTitleToFlowId(title: string): string {
  const normalized = title
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .trim();
  return normalized || "flow";
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readBuiltAssets(): Promise<{ js: string; css: string }> {
  const [js, css] = await Promise.all([
    fs.readFile(path.join(DIST_WEB_DIR, "flow-studio.js"), "utf8"),
    fs.readFile(path.join(DIST_WEB_DIR, "flow-studio.css"), "utf8"),
  ]);
  return { js, css };
}

function snapshotResult(snapshot: FlowSnapshot, narration: string) {
  const payload: ToolEnvelope = { kind: "snapshot", snapshot };
  return {
    structuredContent: payload,
    content: [{ type: "text" as const, text: narration }],
    _meta: payload,
  };
}

function listResult(items: FlowListItem[]) {
  const payload: ToolEnvelope = { kind: "flow-list", items };
  return {
    structuredContent: payload,
    content: [{ type: "text" as const, text: `מצאתי ${items.length} תרשימים זמינים.` }],
    _meta: payload,
  };
}

function exportResult(exportPayload: ExportPayload) {
  const payload: ToolEnvelope = { kind: "export", exportPayload };
  return {
    structuredContent: payload,
    content: [
      {
        type: "text" as const,
        text: `הייצוא ${exportPayload.fileName} מוכן ${exportPayload.renderedClientSide ? "ב־UI" : "להורדה"}.`,
      },
    ],
    _meta: payload,
  };
}

function createStandaloneHtml(): string {
  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Mermaid Flow Studio</title>
    <link rel="stylesheet" href="/static/flow-studio.css" />
  </head>
  <body>
    <div id="root"></div>
    <script>
      window.__FLOW_STUDIO_BOOTSTRAP__ = {
        mode: "standalone",
        apiBaseUrl: "",
        appName: "Mermaid Flow Studio"
      };
    </script>
    <script type="module" src="/static/flow-studio.js"></script>
  </body>
</html>`;
}

function createWidgetHtml(js: string, css: string): string {
  return `<div id="root"></div>
<style>${css}</style>
<script>
  window.__FLOW_STUDIO_BOOTSTRAP__ = {
    mode: "widget",
    apiBaseUrl: "",
    appName: "Mermaid Flow Studio"
  };
</script>
<script type="module">${js}</script>`;
}
