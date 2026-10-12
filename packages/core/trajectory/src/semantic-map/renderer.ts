import type { SemanticEdge, SemanticGraph, SemanticNode, SemanticRelationKind, SemanticState, SemanticUsage } from "./adapter.js";
import { SemanticAgentLayout, SEMANTIC_CARD, type SemanticAgentGroup, type SemanticSlot, type SemanticLayout } from "./layout.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const NODE_LIMIT = 500;
const EDGE_LIMIT = 1500;
const CARD_WIDTH = SEMANTIC_CARD.width;
const CARD_HEIGHT = SEMANTIC_CARD.height;
const nodeKinds = new Set(["workflow", "task", "agent", "system", "user", "assistant", "tool-call", "result"]);
const edgeKinds = new Set<SemanticRelationKind>(["contains", "invokes", "produces", "sequence", "phase", "dependency", "fork", "merge", "retry"]);
const states = new Set<SemanticState>(["running", "success", "failure", "queued", "waiting", "paused", "retrying", "cancelled", "interrupted", "unknown"]);
const safeId = /^sm-(?:[0-9a-f]{2})+$/;

export type ArchifyApi = {
  finder?: { refresh?: () => number };
  focus?: { active: () => string | string[] | null; set: (id: string, options?: Record<string, unknown>) => boolean; setMany: (ids: string[], options?: Record<string, unknown>) => boolean; clear: (options?: Record<string, unknown>) => void };
  routeProbe?: { active: () => unknown; clear: (options?: Record<string, unknown>) => void };
};
type RenderResult = { structural: boolean; nodeCount: number; edgeCount: number };
type Slot = SemanticSlot;
type GroupElements = {
  backdrop: SVGGElement; shape: SVGRectElement; label: SVGTextElement; scope: SVGTextElement; status: SVGTextElement; stats: SVGTextElement; nodes: SVGGElement;
  /** Collapsible boxes: header toggle, the summary card standing for the folded middle and its two connectors. */
  toggle: SVGTextElement; summary: SVGGElement; summaryLabel: SVGTextElement; summaryDetail: SVGTextElement; summaryIssues: SVGTextElement; links: SVGGElement;
};
type NodeElements = { group: SVGGElement; stack: SVGPathElement; shape: SVGPathElement; inner: SVGRectElement; loop: SVGPathElement; count: SVGTextElement; label: SVGTextElement; status: SVGTextElement };
/** Short "what is folded" line: assistant turns plus the most frequent tools (grouped tool cards count every call). */
function foldedSummary(nodes: readonly SemanticNode[]): { detail: string; issues: string } {
  const tools = new Map<string, number>();
  let assistants = 0, others = 0, failed = 0, running = 0;
  for (const node of nodes) {
    if (node.kind === "tool-call") tools.set(node.label, (tools.get(node.label) ?? 0) + (node.count ?? 1));
    else if (node.kind === "assistant") assistants += 1;
    else others += 1;
    failed += node.state === "failure" ? Math.max(1, node.failedCount ?? 0) : node.failedCount ?? 0;
    if (node.state === "running") running += 1;
  }
  const top = [...tools].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 2).map(([name, calls]) => `${name.length > 10 ? `${name.slice(0, 9)}…` : name} ×${String(calls)}`);
  // Fits one card line (about 24 monospace characters at the card font size).
  let detail = "";
  for (const part of [...top, ...(assistants ? [`asst ×${String(assistants)}`] : []), ...(others ? [`other ×${String(others)}`] : [])]) {
    const next = detail ? `${detail} · ${part}` : part;
    if (next.length > 26) break;
    detail = next;
  }
  return { detail, issues: [failed ? `${String(failed)} failed` : "", running ? `${String(running)} running` : ""].filter(Boolean).join(" · ") };
}

/** One outline per node kind, so agent, system, user, assistant, tool and result cards are told apart by shape. */
function shapePath(kind: SemanticNode["kind"]): string {
  const w = CARD_WIDTH, h = CARD_HEIGHT;
  switch (kind) {
    case "system": return `M 14 0 H ${String(w - 14)} L ${String(w)} ${String(h / 2)} L ${String(w - 14)} ${String(h)} H 14 L 0 ${String(h / 2)} Z`;
    case "user": return `M ${String(h / 2)} 0 H ${String(w - h / 2)} A ${String(h / 2)} ${String(h / 2)} 0 0 1 ${String(w - h / 2)} ${String(h)} H ${String(h / 2)} A ${String(h / 2)} ${String(h / 2)} 0 0 1 ${String(h / 2)} 0 Z`;
    case "assistant": return `M 10 0 H ${String(w - 10)} Q ${String(w)} 0 ${String(w)} 10 V ${String(h - 18)} Q ${String(w)} ${String(h - 8)} ${String(w - 10)} ${String(h - 8)} H 34 L 18 ${String(h)} L 22 ${String(h - 8)} H 10 Q 0 ${String(h - 8)} 0 ${String(h - 18)} V 10 Q 0 0 10 0 Z`;
    case "tool-call": return `M 14 0 H ${String(w)} L ${String(w - 14)} ${String(h)} H 0 Z`;
    case "result": return `M 0 0 H ${String(w - 16)} L ${String(w)} 16 V ${String(h)} H 0 Z M ${String(w - 16)} 0 V 16 H ${String(w)}`;
    default: return `M 8 0 H ${String(w - 8)} Q ${String(w)} 0 ${String(w)} 8 V ${String(h - 8)} Q ${String(w)} ${String(h)} ${String(w - 8)} ${String(h)} H 8 Q 0 ${String(h)} 0 ${String(h - 8)} V 8 Q 0 0 8 0 Z`;
  }
}
const labelX = (kind: SemanticNode["kind"]): number => kind === "system" || kind === "tool-call" ? 18 : kind === "user" ? 16 : 9;
const kindTag = (kind: SemanticNode["kind"]): string => kind === "tool-call" ? "tool" : kind;

/** Path of scope labels (workflow excluded) that contain a node, read from recorded `contains` edges. */
function scopePath(graph: SemanticGraph, nodeId: string | undefined): string {
  if (!nodeId) return "";
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const parentOf = new Map<string, string>();
  for (const edge of graph.edges) if (edge.kind === "contains" && byId.get(edge.from)?.agentId === undefined && !parentOf.has(edge.to)) parentOf.set(edge.to, edge.from);
  const labels: string[] = [];
  for (let current = parentOf.get(nodeId), guard = 0; current && guard < 32; current = parentOf.get(current), guard += 1) {
    const node = byId.get(current); if (!node || node.kind !== "task") break; labels.unshift(node.label);
  }
  return labels.join(" › ");
}
const tokens = (value: number): string => value >= 1_000_000 ? `${(value / 1_000_000).toFixed(2)}M` : value >= 10_000 ? `${String(Math.round(value / 1_000))}k` : value >= 1_000 ? `${(value / 1_000).toFixed(1)}k` : String(value);
function usageText(usage: SemanticUsage | undefined): string {
  if (!usage) return "";
  return [`read ${tokens(usage.input)}`, `write ${tokens(usage.output)}`, `cache ${tokens(usage.cacheRead)}/${tokens(usage.cacheWrite)}`, `ctx ${usage.context === undefined ? "n/d" : tokens(usage.context)}`].join(" · ");
}

function svgElement<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] { return document.createElementNS(SVG_NS, tag); }
function validNode(value: unknown): value is SemanticNode {
  if (!value || typeof value !== "object") return false;
  const node = value as SemanticNode;
  return safeId.test(node.id) && node.id.length <= 4096 && nodeKinds.has(node.kind) && states.has(node.state) && typeof node.label === "string" && node.label.length <= 120 && typeof node.rawStatus === "string" && node.rawStatus.length <= 40;
}
function validEdge(value: unknown, ids: ReadonlySet<string>): value is SemanticEdge {
  if (!value || typeof value !== "object") return false;
  const edge = value as SemanticEdge;
  return safeId.test(edge.id) && edge.id.length <= 4096 && edgeKinds.has(edge.kind) && ids.has(edge.from) && ids.has(edge.to) && edge.from !== edge.to;
}
function validGraph(value: unknown): value is SemanticGraph {
  if (!value || typeof value !== "object") return false;
  const graph = value as SemanticGraph;
  const version: unknown = (value as { schemaVersion?: unknown }).schemaVersion;
  return version === 1 && Array.isArray(graph.nodes) && graph.nodes.length <= NODE_LIMIT && Array.isArray(graph.edges) && graph.edges.length <= EDGE_LIMIT;
}
const count = (value: number): string => String(Math.max(0, Math.round(value)));
function text(element: SVGTextElement, value: string): void { const bounded = Array.from(value).slice(0, 120).join(""); if (element.textContent !== bounded) element.textContent = bounded; }
function setAttribute(element: Element, name: string, value: string): void { if (element.getAttribute(name) !== value) element.setAttribute(name, value); }

/**
 * Inside a box the sequence runs as a serpentine: neighbours on a row are joined horizontally, row changes vertically.
 * Between boxes, arrows leave the source box bottom, travel in the gap under its stage row and enter the target box top.
 */
function edgePath(from: Slot, to: Slot, groups: ReadonlyMap<string, SemanticAgentGroup>, lane: number): string {
  const n = (value: number): string => count(value);
  if (from.group === to.group) {
    if (to.slot === from.slot + 1 && to.row === from.row) {
      const y = from.y + CARD_HEIGHT / 2;
      return to.col > from.col ? `M ${n(from.x + CARD_WIDTH)} ${n(y)} H ${n(to.x)}` : `M ${n(from.x)} ${n(y)} H ${n(to.x + CARD_WIDTH)}`;
    }
    if (to.slot === from.slot + 1) return `M ${n(from.x + CARD_WIDTH / 2)} ${n(from.y + CARD_HEIGHT)} V ${n(to.y)}`;
    const gutter = from.y + CARD_HEIGHT + 9 + (lane % 3) * 2;
    const tx = to.x + CARD_WIDTH / 2;
    return to.row > from.row
      ? `M ${n(from.x + CARD_WIDTH / 2)} ${n(from.y + CARD_HEIGHT)} V ${n(gutter)} H ${n(tx)} V ${n(to.y)}`
      : `M ${n(from.x + CARD_WIDTH / 2)} ${n(from.y + CARD_HEIGHT)} V ${n(gutter)} H ${n(tx)} V ${n(to.y + CARD_HEIGHT)}`;
  }
  const source = groups.get(from.group); const target = groups.get(to.group);
  if (!source || !target) return `M ${n(from.x)} ${n(from.y)} L ${n(to.x)} ${n(to.y)}`;
  const sx = source.x + source.width / 2 + ((lane % 5) - 2) * 6;
  const tx = target.x + target.width / 2 + ((lane % 5) - 2) * 6;
  const sourceBottom = source.y + source.height;
  const belowRow = source.rowBottom + 12 + (lane % 3) * 3;
  if (target.y > source.y) {
    // Next stage: the gap under the whole source stage; same stage: the row gap just above the target.
    const channel = target.stage !== source.stage ? source.stageBottom + 18 + (lane % 4) * 7 : target.y - 12 - (lane % 3) * 3;
    // Boxes below the source inside its stage are passed through the free lane left of the source box.
    const detour = source.rowBottom < source.stageBottom || channel < sourceBottom ? ` V ${n(belowRow)} H ${n(source.laneX - (lane % 3) * 3)}` : "";
    // Boxes below the first row of the target wave are entered from the free lane left of the box, never through boxes above.
    if (!target.firstRow) return `M ${n(sx)} ${n(sourceBottom)}${detour} V ${n(channel)} H ${n(target.laneX + (lane % 3) * 3)} V ${n(target.y - 12)} H ${n(tx)} V ${n(target.y)}`;
    return `M ${n(sx)} ${n(sourceBottom)}${detour} V ${n(channel)} H ${n(tx)} V ${n(target.y)}`;
  }
  return `M ${n(sx)} ${n(sourceBottom)} V ${n(belowRow)} H ${n(tx)} V ${n(target.y + target.height)}`;
}

/** Incremental SVG renderer for the pinned Archify shell. All non-static SVG strings are text, never markup or URLs. */
export class SemanticMapRenderer {
  private readonly svg: SVGSVGElement;
  private readonly stageLayer: SVGGElement;
  private readonly groupLayer: SVGGElement;
  private readonly edgeLayer: SVGGElement;
  private readonly nodeLayer: SVGGElement;
  private readonly statsLayer: SVGGElement;
  private readonly nodeElements = new Map<string, NodeElements>();
  private readonly edgeElements = new Map<string, SVGGElement>();
  private slots = new Map<string, Slot>();
  private readonly layout = new SemanticAgentLayout();
  private arrangement: SemanticLayout | undefined;
  private readonly groupElements = new Map<string, GroupElements>();
  private readonly onClick: (event: MouseEvent) => void;
  private readonly onKeyDown: (event: KeyboardEvent) => void;
  private scopeKey = "";
  private disposed = false;
  /** Viewer-local presentation state: boxes the user expanded. Never sent to the parent. */
  private readonly expanded = new Set<string>();
  private structureKey = "";
  private lastGraph: SemanticGraph | undefined;

  constructor(private readonly archify: ArchifyApi = window.Archify as ArchifyApi) {
    const found = document.querySelector(".diagram-container > svg");
    if (!(found instanceof SVGSVGElement)) throw new Error("Archify SVG canvas is unavailable");
    this.svg = found;
    const defs = this.svg.querySelector("defs");
    const grid = this.svg.querySelector('rect[fill="url(#grid)"]');
    this.svg.replaceChildren(...[defs, grid].filter((element): element is SVGElement => element instanceof SVGElement));
    const layer = (name: string): SVGGElement => { const element = svgElement("g"); element.setAttribute("class", name); return element; };
    this.stageLayer = layer("semantic-map-stages");
    this.groupLayer = layer("semantic-map-group-backgrounds");
    this.edgeLayer = layer("semantic-map-edges");
    this.nodeLayer = layer("semantic-map-nodes");
    this.statsLayer = layer("semantic-map-canvas-stats");
    this.svg.append(this.stageLayer, this.groupLayer, this.edgeLayer, this.nodeLayer, this.statsLayer);
    this.onClick = (event) => { if (!this.toggleFromEvent(event)) this.selectFromEvent(event); };
    this.onKeyDown = (event) => { if ((event.key === "Enter" || event.key === " ") && !this.toggleFromEvent(event)) this.selectFromEvent(event); };
    this.svg.addEventListener("click", this.onClick);
    this.svg.addEventListener("keydown", this.onKeyDown);
  }

  render(graph: SemanticGraph): RenderResult {
    if (this.disposed) throw new Error("Semantic map renderer is disposed");
    if (!validGraph(graph)) throw new Error("Invalid bounded semantic graph");
    const ids = new Set<string>();
    for (const item of graph.nodes) {
      if (!validNode(item) || ids.has(item.id)) throw new Error("Invalid or duplicate semantic node");
      ids.add(item.id);
    }
    const edges = graph.edges.filter((item) => validEdge(item, ids));
    if (edges.length !== graph.edges.length) throw new Error("Invalid semantic relation endpoint or identifier");
    const nextScope = JSON.stringify(graph.scope);
    if (this.scopeKey && nextScope !== this.scopeKey) this.clearGraph();
    this.scopeKey = nextScope;
    // Workflow and scope nodes stay in the graph (identity, scope breadcrumbs, status) but are not drawn as cards.
    const candidates = graph.nodes.filter((item) => item.agentId !== undefined);
    const candidateKey = JSON.stringify([candidates.map((node) => [node.id, node.agentId, node.order ?? 0]), edges.map((edge) => edge.id), [...this.expanded].sort()]);
    const structural = candidateKey !== this.structureKey || !this.arrangement;
    this.structureKey = candidateKey;
    if (structural || !this.arrangement) {
      this.arrangement = this.layout.arrange(graph, (agentId) => this.expanded.has(agentId));
      this.slots = this.arrangement.slots;
      setAttribute(this.svg, "viewBox", `0 0 ${String(this.arrangement.width)} ${String(this.arrangement.height)}`);
      // CSSOM sizing (not a style attribute): large maps keep a readable scale and the embedded page scrolls instead.
      this.svg.style.minWidth = `${count(this.arrangement.width * 0.82)}px`;
      this.renderStages(this.arrangement);
    }
    // Cards folded into a collapsed box's summary have no slot and are not drawn.
    const drawn = candidates.filter((item) => this.slots.has(item.id));
    const nextNodes = new Map(drawn.map((item) => [item.id, item]));
    const drawnEdges = edges.filter((item) => nextNodes.has(item.from) && nextNodes.has(item.to));
    const nextEdges = new Map(drawnEdges.map((item) => [item.id, item]));
    const active = this.archify.focus?.active() ?? null;
    const activeIds = Array.isArray(active) ? active : active ? [active] : [];
    const removed = activeIds.some((id) => !nextNodes.has(id));
    for (const [id, entry] of this.nodeElements) if (!nextNodes.has(id)) { entry.group.remove(); this.nodeElements.delete(id); }
    for (const [id, entry] of this.edgeElements) if (!nextEdges.has(id)) { entry.remove(); this.edgeElements.delete(id); }
    this.lastGraph = graph;
    const groupsById = new Map(this.arrangement.groups.map((group) => [group.id, group]));
    for (const [id, entry] of this.groupElements) if (!groupsById.has(id)) { entry.backdrop.remove(); entry.nodes.remove(); entry.links.remove(); this.groupElements.delete(id); }
    for (const group of this.arrangement.groups) this.renderGroup(graph, group);

    setAttribute(this.nodeLayer, "class", drawn.length > 150 ? "semantic-map-nodes semantic-map-dense" : "semantic-map-nodes");
    for (const item of drawn) this.renderNode(item, activeIds);
    let lane = 0;
    for (const item of drawnEdges) {
      let group = this.edgeElements.get(item.id);
      if (!group) {
        group = svgElement("g"); group.setAttribute("class", "semantic-map-edge");
        const path = svgElement("path"); path.setAttribute("class", "semantic-map-edge-path"); path.setAttribute("marker-end", "url(#arrowhead)"); group.append(path);
        this.edgeLayer.append(group); this.edgeElements.set(item.id, group);
      }
      const from = this.slots.get(item.from); const to = this.slots.get(item.to); const path = group.firstElementChild;
      if (!from || !to || !(path instanceof SVGPathElement)) throw new Error("Semantic edge geometry is unavailable");
      setAttribute(group, "data-edge-id", item.id); setAttribute(group, "data-edge-key", item.id);
      setAttribute(group, "data-edge-from", item.from); setAttribute(group, "data-edge-to", item.to);
      setAttribute(group, "data-edge-type", item.kind); setAttribute(group, "data-edge-label", item.kind);
      // Phase hand-overs share one bus (lane 0): arrows from one phase merge into a single line per target box.
      if (structural || !path.hasAttribute("d")) setAttribute(path, "d", edgePath(from, to, groupsById, from.group === to.group || item.kind === "phase" ? 0 : ++lane));
      setAttribute(path, "class", `semantic-map-edge-path relation-${item.kind}${from.group === to.group ? "" : " relation-between-agents"}`);
    }
    this.renderCanvasStats(graph);
    if (removed) {
      const survivors = activeIds.filter((id) => nextNodes.has(id));
      if (survivors.length) this.archify.focus?.setMany(survivors, { toggle: false, updateUrl: false, preserveRoute: true });
      else this.archify.focus?.clear({ preserveView: true, updateUrl: false });
    }
    if (structural) {
      if (this.archify.routeProbe?.active()) this.archify.routeProbe.clear({ updateUrl: false, preserveView: true, restoreFocus: false });
      this.archify.finder?.refresh?.();
    }
    return { structural, nodeCount: graph.nodes.length, edgeCount: edges.length };
  }

  private renderStages(arrangement: SemanticLayout): void {
    while (this.stageLayer.childElementCount > arrangement.stages.length) this.stageLayer.lastElementChild?.remove();
    while (this.stageLayer.childElementCount < arrangement.stages.length) { const line = svgElement("text"); line.setAttribute("class", "semantic-map-stage-label"); this.stageLayer.append(line); }
    arrangement.stages.forEach((stage, index) => {
      const line = this.stageLayer.children[index];
      if (!(line instanceof SVGTextElement)) return;
      setAttribute(line, "x", String(stage.x)); setAttribute(line, "y", String(stage.y));
      // Recorded phase number (not the position on this page), so page 2 continues the numbering of page 1.
      text(line, stage.label !== undefined && stage.phase !== undefined ? `PHASE ${String(stage.phase + 1)} · ${stage.label}` : "");
    });
  }

  private renderGroup(graph: SemanticGraph, group: SemanticAgentGroup): void {
    let entry = this.groupElements.get(group.id);
    if (!entry) {
      const backdrop = svgElement("g"), shape = svgElement("rect"), label = svgElement("text"), scope = svgElement("text"), status = svgElement("text"), stats = svgElement("text"), nodes = svgElement("g");
      const toggle = svgElement("text"), summary = svgElement("g"), summaryShape = svgElement("path"), summaryLabel = svgElement("text"), summaryDetail = svgElement("text"), summaryIssues = svgElement("text"), links = svgElement("g");
      toggle.setAttribute("class", "semantic-map-group-toggle"); toggle.setAttribute("text-anchor", "end"); toggle.setAttribute("role", "button"); toggle.setAttribute("tabindex", "0");
      summary.setAttribute("class", "semantic-map-summary"); summary.setAttribute("role", "button"); summary.setAttribute("tabindex", "0");
      summaryShape.setAttribute("class", "semantic-map-summary-shape"); summaryShape.setAttribute("d", `M 6 0 H ${String(CARD_WIDTH - 6)} Q ${String(CARD_WIDTH)} 0 ${String(CARD_WIDTH)} 6 V ${String(CARD_HEIGHT - 6)} Q ${String(CARD_WIDTH)} ${String(CARD_HEIGHT)} ${String(CARD_WIDTH - 6)} ${String(CARD_HEIGHT)} H 6 Q 0 ${String(CARD_HEIGHT)} 0 ${String(CARD_HEIGHT - 6)} V 6 Q 0 0 6 0 Z`);
      summaryLabel.setAttribute("class", "semantic-map-summary-label"); summaryLabel.setAttribute("x", "9"); summaryLabel.setAttribute("y", "17");
      summaryDetail.setAttribute("class", "semantic-map-summary-detail"); summaryDetail.setAttribute("x", "9"); summaryDetail.setAttribute("y", "31");
      summaryIssues.setAttribute("class", "semantic-map-summary-issues"); summaryIssues.setAttribute("x", "9"); summaryIssues.setAttribute("y", "44");
      summary.append(summaryShape, summaryLabel, summaryDetail, summaryIssues);
      links.setAttribute("class", "semantic-map-summary-links"); this.edgeLayer.append(links);
      backdrop.setAttribute("class", "semantic-map-group-background");
      shape.setAttribute("class", "semantic-map-group-shape"); shape.setAttribute("rx", "10");
      label.setAttribute("class", "semantic-map-group-label"); status.setAttribute("class", "semantic-map-group-status"); status.setAttribute("text-anchor", "end");
      scope.setAttribute("class", "semantic-map-group-scope");
      stats.setAttribute("class", "semantic-map-group-stats"); stats.setAttribute("text-anchor", "end");
      nodes.setAttribute("class", "semantic-map-agent-group"); nodes.setAttribute("role", "group");
      backdrop.append(shape, label, scope, status, stats); this.groupLayer.append(backdrop); nodes.append(toggle, summary); this.nodeLayer.append(nodes);
      entry = { backdrop, shape, label, scope, status, stats, nodes, toggle, summary, summaryLabel, summaryDetail, summaryIssues, links }; this.groupElements.set(group.id, entry);
    }
    const primary = graph.nodes.find((node) => node.agentId === group.agentId && node.kind === "agent");
    const label = primary?.label ?? group.label;
    const rawStatus = primary?.rawStatus ?? group.status;
    const members = graph.nodes.filter((node) => node.agentId === group.agentId);
    const running = members.some((node) => node.state === "running");
    setAttribute(entry.nodes, "data-agent-id", group.agentId ?? "");
    setAttribute(entry.nodes, "aria-label", `${label}, ${String(members.length)} nodes${rawStatus ? `, ${rawStatus}` : ""}`);
    setAttribute(entry.backdrop, "data-agent-id", group.agentId ?? "");
    setAttribute(entry.backdrop, "class", `semantic-map-group-background agent-color-${String(group.colorIndex)}${running ? " group-running" : ""}`);
    for (const [name, value] of Object.entries({ x: group.x, y: group.y, width: group.width, height: group.height })) setAttribute(entry.shape, name, String(value));
    setAttribute(entry.label, "x", String(group.x + 12)); setAttribute(entry.label, "y", String(group.y + 21));
    // Scope sits in the footer (left), so the header keeps room for the retry curl of the agent card.
    setAttribute(entry.scope, "x", String(group.x + 12)); setAttribute(entry.scope, "y", String(group.y + group.height - 7));
    setAttribute(entry.status, "x", String(group.x + group.width - 12)); setAttribute(entry.status, "y", String(group.y + 21));
    text(entry.label, label.length > 40 ? `${label.slice(0, 39)}…` : label);
    const scope = scopePath(graph, primary?.id);
    text(entry.scope, scope ? `in ${scope.length > 26 ? `${scope.slice(0, 25)}…` : scope}` : "");
    text(entry.status, `${rawStatus ? `${rawStatus} · ` : ""}${String(members.length)} nodes`);
    const usage = graph.usage?.agents.find((item) => item.agentId === group.agentId)?.usage;
    setAttribute(entry.stats, "x", String(group.x + group.width - 12)); setAttribute(entry.stats, "y", String(group.y + group.height - 7));
    text(entry.stats, usageText(usage));
    // Collapsible boxes: header toggle and, while collapsed, one summary card for the folded middle of the sequence.
    setAttribute(entry.toggle, "data-collapse-toggle", group.agentId ?? "");
    setAttribute(entry.toggle, "aria-expanded", String(group.collapsible && !group.collapsed));
    setAttribute(entry.toggle, "x", String(group.x + group.width - 12)); setAttribute(entry.toggle, "y", String(group.y + 37));
    setAttribute(entry.toggle, "class", group.collapsible ? "semantic-map-group-toggle" : "semantic-map-group-toggle is-hidden");
    text(entry.toggle, group.collapsible ? group.collapsed ? `▸ show all ${String(group.count)} cards` : "▾ collapse" : "");
    const at = group.summarySlot;
    setAttribute(entry.summary, "class", at ? "semantic-map-summary" : "semantic-map-summary is-hidden");
    setAttribute(entry.summary, "data-collapse-toggle", group.agentId ?? "");
    setAttribute(entry.summary, "aria-expanded", "false");
    entry.links.replaceChildren();
    if (!at || !this.arrangement) return;
    const folded = members.filter((node) => group.hidden.includes(node.id));
    const summary = foldedSummary(folded);
    setAttribute(entry.summary, "transform", `translate(${String(at.x)} ${String(at.y)})`);
    setAttribute(entry.summary, "aria-label", `${String(folded.length)} folded cards: ${summary.detail}${summary.issues ? `, ${summary.issues}` : ""}. Activate to show all.`);
    text(entry.summaryLabel, `⋯ ${String(folded.length)} more · show all`);
    text(entry.summaryDetail, summary.detail);
    text(entry.summaryIssues, summary.issues);
    setAttribute(entry.summaryIssues, "class", summary.issues.includes("failed") ? "semantic-map-summary-issues has-failure" : "semantic-map-summary-issues");
    // Connectors keep the sequence readable through the folded part: previous card → summary → next card.
    const slots = [...this.slots.values()].filter((slot) => slot.group === group.id);
    const before = slots.find((slot) => slot.slot === at.slot - 1); const after = slots.find((slot) => slot.slot === at.slot + 1);
    const groups = new Map(this.arrangement.groups.map((item) => [item.id, item]));
    for (const [from, to] of [[before, at], [at, after]] as const) {
      if (!from || !to) continue;
      const path = svgElement("path"); path.setAttribute("class", "semantic-map-edge-path relation-sequence semantic-map-summary-link"); path.setAttribute("marker-end", "url(#arrowhead)");
      path.setAttribute("d", edgePath(from, to, groups, 0)); entry.links.append(path);
    }
  }

  /** Header toggles and summary cards expand/collapse one box locally; the graph and parent bridge are unaffected. */
  private toggleFromEvent(event: Event): boolean {
    const target = event.target;
    if (!(target instanceof Element)) return false;
    const toggle = target.closest<SVGElement>("[data-collapse-toggle]");
    const agentId = toggle?.getAttribute("data-collapse-toggle");
    if (!toggle || !agentId || toggle.classList.contains("is-hidden")) return false;
    if (event instanceof KeyboardEvent) event.preventDefault();
    if (this.expanded.has(agentId)) this.expanded.delete(agentId); else this.expanded.add(agentId);
    if (this.lastGraph) this.render(this.lastGraph);
    return true;
  }

  private renderNode(item: SemanticNode, activeIds: readonly string[]): void {
    let entry = this.nodeElements.get(item.id);
    if (!entry) {
      const group = svgElement("g"); group.setAttribute("class", "semantic-map-node"); group.setAttribute("tabindex", "0"); group.setAttribute("role", "button");
      const shape = svgElement("path"); shape.setAttribute("class", "semantic-map-node-shape"); shape.setAttribute("d", shapePath(item.kind));
      // Grouped tool calls are drawn as a small stack of cards behind the front card.
      const stack = svgElement("path"); stack.setAttribute("class", "semantic-map-node-stack"); stack.setAttribute("d", shapePath(item.kind)); stack.setAttribute("transform", "translate(5 -5)");
      // Retry presentation on the agent card: inner red frame = a failed attempt, curl arrow back into the card = ×N tries.
      const inner = svgElement("rect"); inner.setAttribute("class", "semantic-map-node-inner"); inner.setAttribute("x", "4"); inner.setAttribute("y", "4"); inner.setAttribute("width", String(CARD_WIDTH - 8)); inner.setAttribute("height", String(CARD_HEIGHT - 8)); inner.setAttribute("rx", "5");
      const loop = svgElement("path"); loop.setAttribute("class", "semantic-map-retry-loop"); loop.setAttribute("d", `M ${String(CARD_WIDTH - 44)} 0 C ${String(CARD_WIDTH - 44)} -24 ${String(CARD_WIDTH + 14)} -26 ${String(CARD_WIDTH)} 12`); loop.setAttribute("marker-end", "url(#arrowhead)");
      const counter = svgElement("text"); counter.setAttribute("class", "semantic-map-retry-count"); counter.setAttribute("x", String(CARD_WIDTH - 6)); counter.setAttribute("y", "-12");
      const label = svgElement("text"); label.setAttribute("class", "semantic-map-node-label"); label.setAttribute("x", String(labelX(item.kind))); label.setAttribute("y", "19");
      const status = svgElement("text"); status.setAttribute("class", "semantic-map-node-status"); status.setAttribute("x", String(labelX(item.kind))); status.setAttribute("y", "35");
      group.append(stack, shape, inner, loop, label, status, counter);
      entry = { group, stack, shape, inner, loop, count: counter, label, status }; this.nodeElements.set(item.id, entry);
    }
    const at = this.slots.get(item.id);
    if (!at) throw new Error("Semantic node has no stable layout slot");
    const parent = this.groupElements.get(at.group)?.nodes;
    if (!parent) throw new Error("Semantic node has no agent group");
    if (entry.group.parentNode !== parent) parent.append(entry.group);
    setAttribute(entry.group, "data-agent-id", item.agentId ?? "");
    setAttribute(entry.group, "data-node-id", item.id);
    setAttribute(entry.group, "data-node-kind", item.kind);
    setAttribute(entry.group, "data-node-order", String(item.order ?? 0));
    setAttribute(entry.group, "data-node-label", item.label);
    setAttribute(entry.group, "data-node-status", item.state);
    setAttribute(entry.group, "data-node-sublabel", item.rawStatus);
    setAttribute(entry.group, "data-profile-x", String(at.x));
    setAttribute(entry.group, "data-profile-y", String(at.y));
    const tries = item.kind === "agent" && (item.attempts ?? 1) > 1 ? item.attempts ?? 1 : 0;
    const failed = item.kind === "agent" ? item.failedAttempts ?? 0 : 0;
    const calls = item.kind === "tool-call" && (item.count ?? 1) > 1 ? item.count ?? 1 : 0;
    const failedCalls = calls ? item.failedCount ?? 0 : 0;
    setAttribute(entry.group, "aria-label", `${kindTag(item.kind)} ${item.label}, ${item.rawStatus}${tries ? `, ${String(tries)} attempts` : ""}${failed ? `, ${String(failed)} failed` : ""}${calls ? `, ${String(calls)} consecutive calls${failedCalls ? `, ${String(failedCalls)} failed` : ""}` : ""}`);
    setAttribute(entry.group, "aria-pressed", activeIds.includes(item.id) ? "true" : "false");
    setAttribute(entry.group, "transform", `translate(${String(at.x)} ${String(at.y)})`);
    setAttribute(entry.group, "class", `semantic-map-node kind-${kindTag(item.kind)}${item.state === "running" ? " node-running" : ""}${failed ? " node-had-failure" : ""}${tries ? " node-retried" : ""}${calls ? " node-stacked" : ""}${failedCalls ? " node-stack-failure" : ""}`);
    setAttribute(entry.shape, "class", `semantic-map-node-shape state-${item.state}`);
    text(entry.count, tries ? `x${String(tries)}` : calls ? `×${String(calls)}` : "");
    text(entry.label, item.label.length > 21 ? `${item.label.slice(0, 20)}…` : item.label);
    text(entry.status, item.kind === "agent" || item.kind === "result" ? item.rawStatus : calls ? `${String(calls)} calls · ${failedCalls ? `${String(failedCalls)} failed` : item.rawStatus}` : `${kindTag(item.kind)} · ${item.rawStatus}`);
    setAttribute(entry.status, "class", `semantic-map-node-status status-${item.state}`);
  }

  /** Workflow-wide statistics written on the canvas background, bottom right. Counts come from the projected graph only. */
  private renderCanvasStats(graph: SemanticGraph): void {
    if (!this.arrangement) return;
    const agents = graph.nodes.filter((node) => node.kind === "agent");
    const byState = (state: SemanticNode["state"]): number => agents.filter((node) => node.state === state).length;
    // Whole-workflow figures come from the parent summary (every recorded agent and call, every page); the drawn
    // graph is only the fallback for standalone subagents.
    const summary = graph.summary;
    const tools = summary?.toolCalls ?? graph.nodes.reduce((sum, node) => sum + (node.kind === "tool-call" ? node.count ?? 1 : 0), 0);
    const retries = summary?.retries ?? agents.reduce((sum, node) => sum + Math.max(0, (node.attempts ?? 1) - 1), 0);
    const total = summary?.usage ?? graph.usage?.total;
    const lines = [
      graph.scope.targetKind === "run" ? "WORKFLOW TOTAL" : "SUBAGENT TOTAL",
      summary ? `agents ${String(summary.agents)} · running ${String(summary.running)} · completed ${String(summary.completed)} · failed ${String(summary.failed)}` : `agents ${String(agents.length)} · running ${String(byState("running"))} · completed ${String(byState("success"))} · failed ${String(byState("failure"))}`,
      `tool calls ${summary?.toolCallsPartial ? "≥" : ""}${String(tools)} · retries ${String(retries)}${summary && summary.pages > 1 ? ` · page ${String(summary.page + 1)}/${String(summary.pages)}` : ""}`,
      total ? `read ${tokens(total.input)} · write ${tokens(total.output)} · cache ${tokens(total.cacheRead)}/${tokens(total.cacheWrite)}` : "tokens n/d",
      total?.cost === undefined ? "" : `cost $${total.cost.toFixed(3)}`
    ].filter(Boolean);
    while (this.statsLayer.childElementCount > lines.length) this.statsLayer.lastElementChild?.remove();
    while (this.statsLayer.childElementCount < lines.length) { const line = svgElement("text"); line.setAttribute("text-anchor", "end"); this.statsLayer.append(line); }
    const x = this.arrangement.width - 20; const bottom = this.arrangement.height - 14;
    lines.forEach((value, index) => {
      const line = this.statsLayer.children[index];
      if (!(line instanceof SVGTextElement)) return;
      setAttribute(line, "class", index === 0 ? "semantic-map-canvas-stats-title" : "semantic-map-canvas-stats-line");
      setAttribute(line, "x", String(x)); setAttribute(line, "y", String(bottom - (lines.length - 1 - index) * 15));
      text(line, value);
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.svg.removeEventListener("click", this.onClick);
    this.svg.removeEventListener("keydown", this.onKeyDown);
    this.clearGraph();
    this.stageLayer.remove(); this.groupLayer.remove(); this.edgeLayer.remove(); this.nodeLayer.remove(); this.statsLayer.remove();
  }

  private clearGraph(): void {
    const active = this.archify.focus?.active() ?? null;
    if (active) this.archify.focus?.clear({ preserveView: true, updateUrl: false });
    this.nodeElements.clear(); this.edgeElements.clear(); this.slots.clear();
    this.groupElements.clear(); this.layout.clear(); this.arrangement = undefined;
    this.expanded.clear(); this.structureKey = ""; this.lastGraph = undefined;
    this.stageLayer.replaceChildren(); this.groupLayer.replaceChildren(); this.edgeLayer.replaceChildren(); this.nodeLayer.replaceChildren(); this.statsLayer.replaceChildren();
  }

  private selectFromEvent(event: Event): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const node = target.closest<SVGGElement>("[data-node-id]");
    const id = node?.getAttribute("data-node-id");
    if (!node || !id || !safeId.test(id)) return;
    if (event instanceof KeyboardEvent && event.key !== "Enter" && event.key !== " ") return;
    if (event instanceof KeyboardEvent) event.preventDefault();
    this.archify.focus?.set(id, { updateUrl: false });
  }
}
