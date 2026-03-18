import React, { startTransition, useDeferredValue, useEffect, useId, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import mermaid from "mermaid";
import Panzoom from "@panzoom/panzoom";
import { App, useApp } from "@modelcontextprotocol/ext-apps/react";
import {
  createSnapshot,
  detectDiagramType,
  normalizeMermaidSource,
} from "../shared/flow-engine.js";
import {
  CreateDiagramInput,
  ExportPayload,
  FlowListItem,
  FlowSnapshot,
  OutlineNode,
  PatchSubtreeInput,
} from "../shared/types.js";
import "./styles.css";

type BootstrapMode = "standalone" | "widget";

type Bootstrap = {
  mode: BootstrapMode;
  apiBaseUrl: string;
  appName: string;
};

type ToolEnvelope =
  | { kind: "snapshot"; snapshot: FlowSnapshot }
  | { kind: "flow-list"; items: FlowListItem[] }
  | { kind: "export"; exportPayload: ExportPayload };

type FlowAdapter = {
  mode: BootstrapMode;
  listFlows(): Promise<FlowListItem[]>;
  loadFlow(flowId: string): Promise<FlowSnapshot>;
  createDiagram(input: CreateDiagramInput): Promise<FlowSnapshot>;
  patchSubtree(input: PatchSubtreeInput): Promise<FlowSnapshot>;
  lintAndRepair(flowId: string): Promise<FlowSnapshot>;
  exportDiagram(flowId: string, format: "mmd" | "svg" | "png"): Promise<ExportPayload>;
  requestFullscreen?(): Promise<void>;
};

declare global {
  interface Window {
    __FLOW_STUDIO_BOOTSTRAP__?: Bootstrap;
  }
}

const bootstrap = window.__FLOW_STUDIO_BOOTSTRAP__ ?? {
  mode: "standalone",
  apiBaseUrl: "",
  appName: "Mermaid Flow Studio",
};

let mermaidInitialized = false;

function ensureMermaidInitialized() {
  if (mermaidInitialized) {
    return;
  }

  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "loose",
    flowchart: {
      useMaxWidth: false,
      htmlLabels: false,
      nodeSpacing: 40,
      rankSpacing: 45,
    },
    theme: "base",
    themeVariables: {
      fontFamily: "Assistant, Heebo, Segoe UI, sans-serif",
      fontSize: "16px",
      primaryColor: "#ffffff",
      primaryBorderColor: "#cbd5e1",
      primaryTextColor: "#1f2937",
      lineColor: "#64748b",
      secondaryColor: "#f8fafc",
      tertiaryColor: "#e5e7eb",
      edgeLabelBackground: "#ffffff",
    },
  });

  mermaidInitialized = true;
}

function WidgetRoot() {
  const [incomingEnvelope, setIncomingEnvelope] = useState<ToolEnvelope | null>(null);
  const { app, isConnected, error } = useApp({
    appInfo: { name: "flow-studio-widget", version: "0.1.0" },
    capabilities: {},
    onAppCreated: (createdApp) => {
      createdApp.ontoolresult = (result) => {
        const payload = result.structuredContent as ToolEnvelope | undefined;
        if (!payload) {
          return;
        }
        startTransition(() => {
          setIncomingEnvelope(payload);
        });
      };
    },
  });

  if (error) {
    return <StatusScreen title="שגיאת חיבור" body={error.message} />;
  }

  if (!isConnected || !app) {
    return <StatusScreen title="מתחבר ל-ChatGPT" body="הווידג'ט נטען ומחכה לנתונים מהשיחה." />;
  }

  return <FlowStudio adapter={createWidgetAdapter(app)} incomingEnvelope={incomingEnvelope} />;
}

function StandaloneRoot() {
  return <FlowStudio adapter={createStandaloneAdapter(bootstrap.apiBaseUrl)} incomingEnvelope={null} />;
}

function FlowStudio({
  adapter,
  incomingEnvelope,
}: {
  adapter: FlowAdapter;
  incomingEnvelope: ToolEnvelope | null;
}) {
  const [flows, setFlows] = useState<FlowListItem[]>([]);
  const [currentFlow, setCurrentFlow] = useState<FlowSnapshot | null>(null);
  const [draftSource, setDraftSource] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [statusText, setStatusText] = useState("טוען...");
  const [chatInstruction, setChatInstruction] = useState("");
  const [renameValue, setRenameValue] = useState("");
  const [childValue, setChildValue] = useState("");
  const [siblingValue, setSiblingValue] = useState("");
  const [createTitle, setCreateTitle] = useState("תרשים חדש");
  const [createType, setCreateType] = useState<"flowchart" | "mindmap">("flowchart");
  const [createBrief, setCreateBrief] = useState("");
  const [activeTab, setActiveTab] = useState<"outline" | "code">("outline");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [renderError, setRenderError] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const items = await adapter.listFlows();
      if (cancelled) {
        return;
      }
      setFlows(items);
      const requestedFlowId = new URLSearchParams(window.location.search).get("flowId");
      const initialFlowId =
        (requestedFlowId && items.find((item) => item.flowId === requestedFlowId)?.flowId) ??
        items[0]?.flowId;

      if (initialFlowId) {
        const snapshot = await adapter.loadFlow(initialFlowId);
        if (!cancelled) {
          applySnapshot(snapshot);
        }
      } else {
        setStatusText("אין עדיין תרשימים. אפשר ליצור אחד חדש מהטופס.");
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [adapter]);

  useEffect(() => {
    if (!incomingEnvelope) {
      return;
    }
    if (incomingEnvelope.kind === "snapshot") {
      applySnapshot(incomingEnvelope.snapshot);
      return;
    }
    if (incomingEnvelope.kind === "flow-list") {
      setFlows(incomingEnvelope.items);
      return;
    }
    if (incomingEnvelope.kind === "export") {
      void triggerExport(incomingEnvelope.exportPayload);
    }
  }, [incomingEnvelope]);

  useEffect(() => {
    if (!currentFlow || draftSource === currentFlow.source) {
      return;
    }

    setSaveState("saving");
    const timeout = window.setTimeout(async () => {
      try {
        const snapshot = await adapter.patchSubtree({
          flowId: currentFlow.flowId,
          targetNodeId: currentFlow.rootId ?? "n_root",
          instructionHe: draftSource,
          mode: "code",
        });
        applySnapshot(snapshot);
        setSaveState("saved");
      } catch (error) {
        setSaveState("error");
        setStatusText(error instanceof Error ? error.message : "שמירת הקוד נכשלה.");
      }
    }, 650);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [adapter, currentFlow, draftSource]);

  function applySnapshot(snapshot: FlowSnapshot) {
    startTransition(() => {
      setCurrentFlow(snapshot);
      setDraftSource(snapshot.source);
      setSelectedNodeId(snapshot.selectedNodeId ?? snapshot.rootId);
      const selectedNode =
        snapshot.outline.find((item) => item.id === (snapshot.selectedNodeId ?? snapshot.rootId)) ??
        snapshot.outline[0];
      setRenameValue(selectedNode?.label ?? "");
      setFlows((previous) => upsertFlow(previous, snapshot));
      setStatusText(`התרשים ${snapshot.flowId} נטען ומוכן לעריכה.`);
      setSaveState("idle");
    });
  }

  async function openFlow(flowId: string) {
    const snapshot = await adapter.loadFlow(flowId);
    applySnapshot(snapshot);
  }

  async function sendChatPatch() {
    if (!currentFlow || !chatInstruction.trim()) {
      return;
    }
    const snapshot = await adapter.patchSubtree({
      flowId: currentFlow.flowId,
      targetNodeId: selectedNodeId ?? currentFlow.rootId ?? "n_root",
      instructionHe: chatInstruction,
      mode: "chat",
    });
    setChatInstruction("");
    applySnapshot(snapshot);
  }

  async function sendVisualPatch(operation: string, label?: string) {
    if (!currentFlow || !selectedNodeId) {
      return;
    }
    const snapshot = await adapter.patchSubtree({
      flowId: currentFlow.flowId,
      targetNodeId: selectedNodeId,
      instructionHe: JSON.stringify({ operation, label }),
      mode: "visual",
    });
    applySnapshot(snapshot);
  }

  async function createFlow() {
    const snapshot = await adapter.createDiagram({
      title: createTitle,
      diagramType: createType,
      briefHe: createBrief,
      stylePreset: "focus",
    });
    setCreateBrief("");
    applySnapshot(snapshot);
  }

  async function runLint() {
    if (!currentFlow) {
      return;
    }
    const snapshot = await adapter.lintAndRepair(currentFlow.flowId);
    applySnapshot(snapshot);
  }

  async function requestExport(format: "mmd" | "svg" | "png") {
    if (!currentFlow) {
      return;
    }
    const payload = await adapter.exportDiagram(currentFlow.flowId, format);
    await triggerExport(payload);
  }

  async function triggerExport(payload: ExportPayload) {
    if (payload.format === "mmd" && payload.textContent) {
      downloadText(payload.fileName, payload.textContent, payload.mimeType);
      setStatusText(`הקובץ ${payload.fileName} הורד.`);
      return;
    }

    if (!svgRef.current) {
      setStatusText("עוד לא נוצר SVG זמין לייצוא.");
      return;
    }

    if (payload.format === "svg") {
      downloadSvg(payload.fileName, svgRef.current);
      setStatusText(`הקובץ ${payload.fileName} הורד.`);
      return;
    }

    await downloadPng(payload.fileName, svgRef.current);
    setStatusText(`הקובץ ${payload.fileName} הורד.`);
  }

  const selectedNode =
    currentFlow?.outline.find((item) => item.id === selectedNodeId) ??
    currentFlow?.outline[0] ??
    null;
  const previewSource = useDeferredValue(draftSource || currentFlow?.source || "");

  return (
    <div className="studio-shell">
      <aside className="sidebar">
        <section className="panel">
          <div className="panel-header">
            <h2>תרשימים</h2>
            <span className="chip">{adapter.mode === "widget" ? "ChatGPT" : "Local"}</span>
          </div>
          <div className="flow-list">
            {flows.map((item) => (
              <button
                key={item.flowId}
                className={`flow-row ${currentFlow?.flowId === item.flowId ? "active" : ""}`}
                onClick={() => void openFlow(item.flowId)}
                type="button"
              >
                <strong>{item.title}</strong>
                <span>{item.diagramType}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <h2>תרשים חדש</h2>
          </div>
          <label className="field">
            <span>כותרת</span>
            <input value={createTitle} onChange={(event) => setCreateTitle(event.target.value)} />
          </label>
          <label className="field">
            <span>סוג</span>
            <select value={createType} onChange={(event) => setCreateType(event.target.value as "flowchart" | "mindmap")}>
              <option value="flowchart">Flowchart</option>
              <option value="mindmap">Mindmap</option>
            </select>
          </label>
          <label className="field">
            <span>בריף</span>
            <textarea
              rows={6}
              value={createBrief}
              onChange={(event) => setCreateBrief(event.target.value)}
              placeholder={"כותרת עליונה\n  נושא ראשון\n  נושא שני\n    תת נושא"}
            />
          </label>
          <button className="primary" onClick={() => void createFlow()} type="button">
            צור תרשים
          </button>
        </section>
      </aside>

      <main className="main-grid">
        <section className="preview-panel">
          <header className="preview-toolbar">
            <div>
              <h1>{currentFlow?.title ?? bootstrap.appName}</h1>
              <p>{statusText}</p>
            </div>
            <div className="toolbar-actions">
              <button onClick={() => void requestExport("mmd")} type="button">MMD</button>
              <button onClick={() => void requestExport("svg")} type="button">SVG</button>
              <button onClick={() => void requestExport("png")} type="button">PNG</button>
              <button onClick={() => void runLint()} type="button">Repair</button>
              {adapter.requestFullscreen ? (
                <button onClick={() => void adapter.requestFullscreen?.()} type="button">Fullscreen</button>
              ) : null}
            </div>
          </header>

          <MermaidPreview
            outline={currentFlow?.outline ?? []}
            selectedNodeId={selectedNodeId}
            source={previewSource}
            onSelectNode={(nodeId) => {
              setSelectedNodeId(nodeId);
              const node = currentFlow?.outline.find((item) => item.id === nodeId);
              setRenameValue(node?.label ?? "");
            }}
            onSvgReady={(svg) => {
              svgRef.current = svg;
            }}
            onError={(message) => {
              setRenderError(message);
            }}
          />
          {renderError ? <div className="error-banner">{renderError}</div> : null}
        </section>

        <section className="right-rail">
          <section className="panel">
            <div className="panel-header tab-strip">
              <button className={activeTab === "outline" ? "active" : ""} onClick={() => setActiveTab("outline")} type="button">
                Outline
              </button>
              <button className={activeTab === "code" ? "active" : ""} onClick={() => setActiveTab("code")} type="button">
                Code
              </button>
              <span className={`chip save-${saveState}`}>{saveState}</span>
            </div>

            {activeTab === "outline" ? (
              <div className="outline-list">
                {(currentFlow?.outline ?? []).map((item) => (
                  <button
                    key={item.id}
                    className={`outline-row ${selectedNodeId === item.id ? "active" : ""}`}
                    style={{ paddingInlineStart: `${12 + item.depth * 18}px` }}
                    onClick={() => {
                      setSelectedNodeId(item.id);
                      setRenameValue(item.label);
                    }}
                    type="button"
                  >
                    <span>{item.label}</span>
                    <small>{item.id}</small>
                  </button>
                ))}
              </div>
            ) : (
              <textarea
                className="code-pane"
                value={draftSource}
                onChange={(event) => {
                  const nextSource = event.target.value;
                  setDraftSource(nextSource);
                  const flowId = currentFlow?.flowId ?? "טיוטה";
                  const nextSnapshot = createSnapshot(flowId, nextSource, selectedNodeId);
                  if (nextSnapshot.outline.length) {
                    setCurrentFlow(nextSnapshot);
                  }
                }}
                spellCheck={false}
              />
            )}
          </section>

          <section className="panel">
            <div className="panel-header">
              <h2>עריכה נקודתית</h2>
              {selectedNode ? <span className="chip">{selectedNode.id}</span> : null}
            </div>
            {selectedNode ? (
              <>
                <label className="field">
                  <span>שם הצומת</span>
                  <input value={renameValue} onChange={(event) => setRenameValue(event.target.value)} />
                </label>
                <div className="button-row">
                  <button onClick={() => void sendVisualPatch("rename", renameValue)} type="button">שנה שם</button>
                  <button onClick={() => void sendVisualPatch("highlight")} type="button">הדגש</button>
                  <button onClick={() => void sendVisualPatch("clear-highlight")} type="button">נקה הדגשה</button>
                </div>
                <label className="field">
                  <span>ילד חדש</span>
                  <input value={childValue} onChange={(event) => setChildValue(event.target.value)} />
                </label>
                <div className="button-row">
                  <button onClick={() => void sendVisualPatch("add-child", childValue)} type="button">הוסף ילד</button>
                  <button onClick={() => void sendVisualPatch("add-sibling", siblingValue)} type="button">הוסף אח</button>
                </div>
                <label className="field">
                  <span>אח חדש</span>
                  <input value={siblingValue} onChange={(event) => setSiblingValue(event.target.value)} />
                </label>
                <button className="danger" onClick={() => void sendVisualPatch("delete")} type="button">
                  מחק ענף
                </button>
              </>
            ) : (
              <p className="muted">בחר צומת מתוך התרשים או ה-outline.</p>
            )}
          </section>

          <section className="panel">
            <div className="panel-header">
              <h2>Chat Patch</h2>
            </div>
            <textarea
              rows={5}
              value={chatInstruction}
              onChange={(event) => setChatInstruction(event.target.value)}
              placeholder='למשל: הוסף ילד בשם "צוואר בקבוק חדש"'
            />
            <button className="primary" onClick={() => void sendChatPatch()} type="button">
              שלח הוראה
            </button>
          </section>
        </section>
      </main>
    </div>
  );
}

function MermaidPreview({
  source,
  outline,
  selectedNodeId,
  onSelectNode,
  onSvgReady,
  onError,
}: {
  source: string;
  outline: OutlineNode[];
  selectedNodeId: string | null;
  onSelectNode(nodeId: string): void;
  onSvgReady(svg: SVGSVGElement | null): void;
  onError(message: string | null): void;
}) {
  const viewportId = useId();
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const panzoomRef = useRef<ReturnType<typeof Panzoom> | null>(null);

  useEffect(() => {
    ensureMermaidInitialized();
  }, []);

  useEffect(() => {
    let active = true;
    const render = async () => {
      if (!viewportRef.current) {
        return;
      }
      if (!normalizeMermaidSource(source)) {
        viewportRef.current.innerHTML = "<div class='empty-state'>אין כרגע Mermaid source להצגה.</div>";
        onSvgReady(null);
        return;
      }

      try {
        const { svg } = await mermaid.render(`flow-studio-${viewportId}`, source);
        if (!active || !viewportRef.current) {
          return;
        }
        viewportRef.current.innerHTML = svg;
        const svgElement = viewportRef.current.querySelector("svg");
        onSvgReady(svgElement);
        bindSvgSelection(viewportRef.current, outline, selectedNodeId, onSelectNode);
        if (panzoomRef.current?.destroy) {
          panzoomRef.current.destroy();
        }
        if (svgElement) {
          panzoomRef.current = Panzoom(svgElement, {
            maxScale: 6,
            minScale: 0.25,
            contain: "outside",
          });
        }
        onError(null);
      } catch (error) {
        if (!active || !viewportRef.current) {
          return;
        }
        viewportRef.current.innerHTML = "<div class='empty-state error'>Mermaid לא הצליח לרנדר את הקוד הנוכחי.</div>";
        onSvgReady(null);
        onError(error instanceof Error ? error.message : "שגיאת Mermaid");
      }
    };

    void render();
    return () => {
      active = false;
    };
  }, [onError, onSelectNode, onSvgReady, outline, selectedNodeId, source, viewportId]);

  return <div className="preview-surface" ref={viewportRef} />;
}

function bindSvgSelection(
  root: HTMLElement,
  outline: OutlineNode[],
  selectedNodeId: string | null,
  onSelectNode: (nodeId: string) => void,
) {
  const nodes = Array.from(root.querySelectorAll<SVGGElement>("g.node"));
  for (const element of nodes) {
    const matched = matchNodeElement(element, outline);
    element.classList.toggle("is-selected", matched?.id === selectedNodeId);
    if (!matched) {
      continue;
    }
    element.style.cursor = "pointer";
    element.onclick = () => onSelectNode(matched.id);
  }
}

function matchNodeElement(element: SVGGElement, outline: OutlineNode[]): OutlineNode | null {
  const rawId = element.getAttribute("id") ?? "";
  const labelText = element.textContent?.replace(/\s+/g, " ").trim() ?? "";
  return (
    outline.find((item) => rawId.includes(item.id)) ??
    outline.find((item) => item.label.replace(/\s+/g, " ").trim() === labelText) ??
    null
  );
}

function createStandaloneAdapter(apiBaseUrl: string): FlowAdapter {
  const request = async <T,>(url: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(`${apiBaseUrl}${url}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    if (!response.ok) {
      throw new Error(await response.text());
    }
    return (await response.json()) as T;
  };

  return {
    mode: "standalone",
    async listFlows() {
      const response = await request<{ items: FlowListItem[] }>("/api/flows");
      return response.items;
    },
    async loadFlow(flowId) {
      return request<FlowSnapshot>(`/api/flow?flowId=${encodeURIComponent(flowId)}`);
    },
    async createDiagram(input) {
      return request<FlowSnapshot>("/api/create", { method: "POST", body: JSON.stringify(input) });
    },
    async patchSubtree(input) {
      return request<FlowSnapshot>("/api/patch", { method: "POST", body: JSON.stringify(input) });
    },
    async lintAndRepair(flowId) {
      return request<FlowSnapshot>("/api/lint", {
        method: "POST",
        body: JSON.stringify({ flowId }),
      });
    },
    async exportDiagram(flowId, format) {
      return request<ExportPayload>("/api/export", {
        method: "POST",
        body: JSON.stringify({ flowId, format }),
      });
    },
  };
}

function createWidgetAdapter(app: App): FlowAdapter {
  const call = async (name: string, args: object): Promise<ToolEnvelope> => {
    const result = await app.callServerTool({
      name,
      arguments: args as Record<string, unknown>,
    });
    const payload = result.structuredContent as ToolEnvelope | undefined;
    if (!payload) {
      throw new Error(`Tool ${name} did not return structured content.`);
    }
    return payload;
  };

  return {
    mode: "widget",
    async listFlows() {
      const payload = await call("list_flows", {});
      return payload.kind === "flow-list" ? payload.items : [];
    },
    async loadFlow(flowId) {
      const payload = await call("load_flow", { flowId });
      if (payload.kind !== "snapshot") {
        throw new Error("Expected snapshot payload.");
      }
      return payload.snapshot;
    },
    async createDiagram(input) {
      const payload = await call("create_diagram", input);
      if (payload.kind !== "snapshot") {
        throw new Error("Expected snapshot payload.");
      }
      return payload.snapshot;
    },
    async patchSubtree(input) {
      const payload = await call("patch_subtree", input);
      if (payload.kind !== "snapshot") {
        throw new Error("Expected snapshot payload.");
      }
      return payload.snapshot;
    },
    async lintAndRepair(flowId) {
      const payload = await call("lint_and_repair", { flowId });
      if (payload.kind !== "snapshot") {
        throw new Error("Expected snapshot payload.");
      }
      return payload.snapshot;
    },
    async exportDiagram(flowId, format) {
      const payload = await call("export_diagram", { flowId, format });
      if (payload.kind !== "export") {
        throw new Error("Expected export payload.");
      }
      return payload.exportPayload;
    },
    async requestFullscreen() {
      await app.requestDisplayMode({ mode: "fullscreen" });
    },
  };
}

function upsertFlow(existing: FlowListItem[], snapshot: FlowSnapshot): FlowListItem[] {
  const next = existing.filter((item) => item.flowId !== snapshot.flowId);
  next.push({
    flowId: snapshot.flowId,
    title: snapshot.title,
    diagramType: snapshot.diagramType,
    fileName: `${snapshot.flowId}.mmd`,
  });
  return next.sort((left, right) => left.title.localeCompare(right.title, "he"));
}

function downloadText(fileName: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  downloadBlob(fileName, blob);
}

function downloadSvg(fileName: string, svg: SVGSVGElement) {
  const serialized = new XMLSerializer().serializeToString(svg);
  const blob = new Blob([serialized], { type: "image/svg+xml;charset=utf-8" });
  downloadBlob(fileName, blob);
}

async function downloadPng(fileName: string, svg: SVGSVGElement) {
  const serialized = new XMLSerializer().serializeToString(svg);
  const blob = new Blob([serialized], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  try {
    const image = await loadImage(url);
    const width = Number(svg.getAttribute("width")) || svg.viewBox.baseVal.width || image.width || 1600;
    const height = Number(svg.getAttribute("height")) || svg.viewBox.baseVal.height || image.height || 900;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Canvas context is unavailable.");
    }
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    const pngBlob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((result) => {
        if (result) {
          resolve(result);
          return;
        }
        reject(new Error("Canvas export failed."));
      }, "image/png");
    });
    downloadBlob(fileName, pngBlob);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function downloadBlob(fileName: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Image load failed."));
    image.src = url;
  });
}

function StatusScreen({ title, body }: { title: string; body: string }) {
  return (
    <div className="status-screen">
      <h1>{title}</h1>
      <p>{body}</p>
    </div>
  );
}

const rootElement = document.getElementById("root");
if (rootElement) {
  createRoot(rootElement).render(
    <React.StrictMode>{bootstrap.mode === "widget" ? <WidgetRoot /> : <StandaloneRoot />}</React.StrictMode>,
  );
}
