import type { SemanticSnapshot } from "./adapter.js";
import { SEMANTIC_MAP_LIMITS, SEMANTIC_MAP_VERSION } from "../semantic-map-build.js";

const CHANNEL = "pi-workflows-semantic-map";
const MAX_MESSAGE_BYTES = SEMANTIC_MAP_LIMITS.payloadBytes;
const ID_PATTERN = /^sm-(?:[0-9a-f]{2})+$/;
const NONCE_PATTERN = /^[0-9a-f]{64}$/;
const BUILD_PATTERN = /^[0-9a-f]{16}$/;
const PORT_MESSAGE_KEYS: Record<string, ReadonlySet<string>> = {
  ready: new Set(["type", "version", "build", "nonce", "instance", "error"]),
  ack: new Set(["type", "version", "nonce", "instance", "sequence", "epoch", "nodeIds", "error"]),
  select: new Set(["type", "version", "nonce", "instance", "nodeId", "epoch"]),
  detail: new Set(["type", "version", "nonce", "instance", "nodeId", "epoch"])
};
const encoder = new TextEncoder();

type PortEnvelope = { type: string; version: number; instance: string; nonce: string; [key: string]: unknown };
export type ParentSemanticNode = { id: string; kind: "workflow" | "task" | "agent" | "system" | "user" | "assistant" | "tool-call" | "result"; sourceRef: string };
type QueuedSnapshot = { text: string; snapshot: SemanticSnapshot; nodes: ReadonlyMap<string, ParentSemanticNode>; nodeCount: number; epoch: number };
type BridgeOptions = {
  host: HTMLElement;
  url: string;
  /** Build stamp of this parent app; the viewer must report the same build before any run data is sent. */
  build: string;
  onStatus: (status: string) => void;
  onRequest: (node: ParentSemanticNode, detail: boolean) => void;
  /** Called once per failure; the map stays closed until the user explicitly retries. */
  onFailure?: (message: string) => void;
  theme: () => "light" | "dark";
};

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function boundedBytes(value: unknown): boolean {
  try { return encoder.encode(JSON.stringify(value)).byteLength <= MAX_MESSAGE_BYTES; } catch { return false; }
}
function validEnvelope(value: unknown): value is PortEnvelope {
  if (!record(value)) return false;
  if (!boundedBytes(value)) return false;
  if (value.version !== SEMANTIC_MAP_VERSION || typeof value.type !== "string" || !PORT_MESSAGE_KEYS[value.type]) return false;
  const allowed = PORT_MESSAGE_KEYS[value.type];
  if (Object.keys(value).some((key) => !allowed?.has(key))) return false;
  return typeof value.nonce === "string" && NONCE_PATTERN.test(value.nonce) && typeof value.instance === "string" && NONCE_PATTERN.test(value.instance);
}
/**
 * Reads a readiness message that proves it comes from this bootstrap (exact nonce and instance on the private port)
 * without trusting its protocol version or build, so an incompatible viewer is reported instead of silently ignored.
 */
function readyCompatibility(value: unknown, nonce: string, instance: string, build: string): "compatible" | "protocol" | "build" | "initialization" | undefined {
  if (!record(value) || value.type !== "ready" || value.nonce !== nonce || value.instance !== instance || !boundedBytes(value)) return undefined;
  if (Object.keys(value).some((key) => !PORT_MESSAGE_KEYS.ready?.has(key))) return undefined;
  if (value.version !== SEMANTIC_MAP_VERSION) return "protocol";
  if (value.error !== undefined) return value.error === "initialization" ? "initialization" : undefined;
  return typeof value.build === "string" && BUILD_PATTERN.test(value.build) && value.build === build ? "compatible" : "build";
}
function randomToken(): string {
  const bytes = new Uint8Array(32);
  try { globalThis.crypto.getRandomValues(bytes); }
  catch { throw new Error("Secure randomness is unavailable; Semantic Map could not start"); }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Lazy parent-side MessagePort bridge. No frame, listener, timer, adapter or serialization exists until open(). */
export class SemanticMapBridge {
  private active = false;
  private visible = true;
  private failed = false;
  private frame: HTMLIFrameElement | undefined;
  private windowReady: ((event: MessageEvent<unknown>) => void) | undefined;
  private assetAbort: AbortController | undefined;
  private assetGeneration = 0;
  private port: MessagePort | undefined;
  private nonce = "";
  private instance = "";
  private phase: "closed" | "loading" | "ready" | "failed" = "closed";
  private loadTimer: ReturnType<typeof setTimeout> | undefined;
  private ackTimer: ReturnType<typeof setTimeout> | undefined;
  private sendTimer: ReturnType<typeof setTimeout> | undefined;
  private lastSendAt = 0;
  private sequence = 0;
  private epoch = 0;
  private inFlight: { sequence: number; epoch: number; text: string; nodes: ReadonlyMap<string, ParentSemanticNode> } | undefined;
  private renderedNodes: ReadonlyMap<string, ParentSemanticNode> = new Map();
  private pending: QueuedSnapshot | undefined;
  private latest: QueuedSnapshot | undefined;
  private lastSentText: string | undefined;
  private scopeIdentity = "";
  private theme: "light" | "dark" = "dark";

  constructor(private readonly options: BridgeOptions) {}

  /** True after a failure until the user explicitly retries or closes the map; state updates never reopen it. */
  get failedState(): boolean { return this.failed; }

  /** Explicit user recovery after a failure: a fresh frame, port, nonce and instance. */
  retry(): void {
    if (this.active) return;
    this.failed = false;
    this.open();
  }

  open(): void {
    if (this.active || this.failed) return;
    this.active = true;
    this.failed = false;
    this.phase = "loading";
    this.pending = undefined;
    this.latest = undefined;
    this.inFlight = undefined;
    this.renderedNodes = new Map();
    this.lastSentText = undefined;
    this.scopeIdentity = "";
    this.clearTimers();
    try { this.nonce = randomToken(); this.instance = randomToken(); }
    catch (error) {
      this.failed = true;
      this.active = false;
      this.phase = "failed";
      this.options.onStatus(error instanceof Error ? error.message : "Secure Semantic Map initialization failed");
      return;
    }
    this.theme = this.options.theme();
    const frame = document.createElement("iframe");
    frame.title = "Semantic Map of the selected workflow";
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.setAttribute("aria-label", "Interactive Semantic Map");
    frame.dataset.semanticMapInstance = this.instance;
    frame.src = this.options.url;
    frame.style.cssText = "display:block;width:100%;height:100%;min-height:280px;border:0;background:transparent";
    this.frame = frame;
    // The inline child bootstrap announces its listener after DOMContentLoaded. An iframe load event alone
    // can belong to the initial about:blank document and is not proof that the real viewer is listening.
    this.windowReady = (event): void => {
      if (!this.active || this.phase !== "loading" || this.frame !== frame || event.source !== frame.contentWindow) return;
      const value = event.data;
      if (!record(value) || value.channel !== CHANNEL || value.type !== "viewer-listening" || !boundedBytes(value)
        || Object.keys(value).length !== 4 || Object.keys(value).some((key) => !["channel", "type", "version", "build"].includes(key))) return;
      if (value.version !== SEMANTIC_MAP_VERSION) { this.fail("Semantic Map protocol mismatch. Reload Trajectory, then retry."); return; }
      if (value.build !== this.options.build) { this.fail("Semantic Map build mismatch. Reload Trajectory, then retry."); return; }
      this.bootstrap(frame);
    };
    window.addEventListener("message", this.windowReady);
    this.options.host.replaceChildren(frame);
    this.options.onStatus("Loading Semantic Map…");
    this.loadTimer = setTimeout(() => { this.fail("Semantic Map did not complete its secure handshake"); }, 10_000);
  }

  update(snapshot: SemanticSnapshot | undefined, scopeIdentity: string, nodes: ReadonlyMap<string, ParentSemanticNode>, nodeCount: number): void {
    if (!this.active || this.failed) return;
    if (!snapshot) {
      this.epoch += 1;
      this.pending = undefined;
      this.latest = undefined;
      this.lastSentText = undefined;
      this.scopeIdentity = "";
      this.renderedNodes = new Map();
      this.options.onStatus("No selected workflow or subagent. Select a target, then reopen the map.");
      return;
    }
    try {
      const text = JSON.stringify(snapshot);
      if (encoder.encode(text).byteLength > MAX_MESSAGE_BYTES) throw new Error("Semantic Map snapshot exceeds the 512 KiB limit");
      if (nodes.size > SEMANTIC_MAP_LIMITS.nodes || !Number.isSafeInteger(nodeCount) || nodeCount < nodes.size || nodeCount > SEMANTIC_MAP_LIMITS.nodes) throw new Error("Invalid bounded Semantic Map node index");
      for (const [id, node] of nodes) if (!isSemanticMapNodeId(id) || id !== node.id || !["workflow", "task", "agent", "system", "user", "assistant", "tool-call", "result"].includes(node.kind) || typeof node.sourceRef !== "string" || node.sourceRef.length > 256) throw new Error("Invalid Semantic Map node index");
      const nextScope = scopeIdentity;
      if (nextScope !== this.scopeIdentity) {
        this.scopeIdentity = nextScope;
        this.epoch += 1;
        this.lastSentText = undefined;
        this.renderedNodes = new Map();
      }
      if (text === this.latest?.text && this.latest.epoch === this.epoch) return;
      if (text === this.lastSentText && !this.pending && !this.inFlight) {
        // Unchanged since the last acknowledged render (for example after the map was hidden): nothing to send, but the
        // current scope must be restored, otherwise select/detail requests from the still-rendered map are dropped.
        if (!this.latest) this.latest = { snapshot, nodes: this.renderedNodes, nodeCount: this.renderedNodes.size, text, epoch: this.epoch };
        return;
      }
      const queued = { snapshot, nodes, nodeCount, text, epoch: this.epoch };
      this.latest = queued;
      if (this.inFlight) this.pending = queued;
      else if (this.phase === "ready" && this.visible) { this.pending = queued; this.flush(); }
    } catch (error) {
      this.fail(error instanceof Error ? error.message : "Invalid Semantic Map snapshot");
    }
  }

  setTheme(theme: "light" | "dark"): void {
    this.theme = theme;
    if (this.active && this.phase === "ready") this.sendTheme();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (!visible) {
      // Hidden: no timers, no sends and no queued work. The owner projects current state again when visible.
      this.clearTimers();
      this.cancelAssetLoad();
      this.pending = undefined;
      this.latest = undefined;
      return;
    }
    if (!this.active) return;
    if (this.phase === "loading" && this.frame && this.loadTimer === undefined) {
      this.loadTimer = setTimeout(() => { this.fail("Semantic Map did not complete its secure handshake"); }, 10_000);
      if (this.port) void this.initializeViewer(this.port);
      return;
    }
    if (this.phase === "ready" && this.inFlight && this.ackTimer === undefined) {
      this.ackTimer = setTimeout(() => { this.fail("Semantic Map stopped responding"); }, 10_000);
    }
  }

  close(): void {
    this.active = false;
    this.failed = false;
    this.phase = "closed";
    this.epoch += 1;
    this.pending = undefined;
    this.latest = undefined;
    this.inFlight = undefined;
    this.renderedNodes = new Map();
    this.lastSentText = undefined;
    this.scopeIdentity = "";
    this.clearTimers();
    this.clearWindowReady();
    this.cancelAssetLoad();
    this.port?.close();
    this.port = undefined;
    this.frame?.remove();
    this.frame = undefined;
    this.options.host.replaceChildren();
    this.options.onStatus("");
  }

  private bootstrap(frame: HTMLIFrameElement): void {
    if (!this.active || this.phase !== "loading" || this.port || this.frame !== frame || !frame.contentWindow) return;
    const channel = new MessageChannel();
    this.port = channel.port1;
    channel.port1.onmessage = (event: MessageEvent<unknown>) => { this.receive(event.data); };
    channel.port1.start();
    try {
      // The wildcard window transfer still contains only handshake metadata and a private port, never run data.
      frame.contentWindow.postMessage({ channel: CHANNEL, type: "bootstrap", version: SEMANTIC_MAP_VERSION, build: this.options.build, nonce: this.nonce, instance: this.instance }, "*", [channel.port2]);
    } catch { this.fail("Semantic Map handshake could not start"); return; }
    if (this.visible) void this.initializeViewer(channel.port1);
  }

  private async initializeViewer(port: MessagePort): Promise<void> {
    if (!this.active || !this.visible || this.phase !== "loading" || this.port !== port || this.assetAbort) return;
    const controller = new AbortController();
    const generation = ++this.assetGeneration;
    this.assetAbort = controller;
    const load = async (name: string, contentType: string, maxBytes: number): Promise<string> => {
      const htmlUrl = new URL(this.options.url);
      if (htmlUrl.origin !== location.origin || htmlUrl.searchParams.get("v") !== this.options.build) throw new Error("Invalid versioned viewer asset origin");
      const url = new URL(name, htmlUrl);
      url.searchParams.set("v", this.options.build);
      // Fetch in the trusted parent origin: the opaque child never needs cross-origin script/style requests.
      const response = await fetch(url, { signal: controller.signal, mode: "same-origin", credentials: "same-origin", referrerPolicy: "no-referrer", cache: "no-store", redirect: "error" });
      if (!response.ok) throw new Error(`${name}: HTTP ${String(response.status)}`);
      const mime = (response.headers.get("content-type") ?? "").split(";", 1)[0]?.trim().toLowerCase();
      if ((mime !== contentType && !(contentType === "application/javascript" && mime === "text/javascript")) || !response.body) throw new Error(`${name}: invalid content type`);
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > maxBytes) { await reader.cancel(); throw new Error(`${name}: asset exceeds its loading budget`); }
          chunks.push(next.value);
        }
      } finally { reader.releaseLock(); }
      const data = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
      return new TextDecoder("utf-8", { fatal: true }).decode(data);
    };
    try {
      const [script, style] = await Promise.all([load("semantic-map.js", "application/javascript", 128 * 1024), load("semantic-map.css", "text/css", 32 * 1024)]);
      if (!this.isInitializationCurrent(port, generation)) return;
      // Only build-owned code/style from the exact same-origin versioned routes, never a runtime snapshot or URL.
      port.postMessage({ type: "initialize", version: SEMANTIC_MAP_VERSION, build: this.options.build, nonce: this.nonce, instance: this.instance, script, style });
    } catch (error) {
      if (!this.isInitializationCurrent(port, generation) || controller.signal.aborted) return;
      this.fail(`Semantic Map assets could not load (${error instanceof Error ? error.message : "browser request blocked"}). Reload Trajectory, then retry.`);
    } finally { if (this.assetAbort === controller) this.assetAbort = undefined; }
  }

  private isInitializationCurrent(port: MessagePort, generation: number): boolean {
    return this.active && this.visible && this.phase === "loading" && this.port === port && generation === this.assetGeneration;
  }

  private clearWindowReady(): void {
    if (this.windowReady) window.removeEventListener("message", this.windowReady);
    this.windowReady = undefined;
  }

  private cancelAssetLoad(): void {
    this.assetGeneration += 1;
    this.assetAbort?.abort();
    this.assetAbort = undefined;
  }

  private receive(value: unknown): void {
    if (!this.active) return;
    if (this.phase === "loading") {
      const compatibility = readyCompatibility(value, this.nonce, this.instance, this.options.build);
      if (compatibility === "protocol") { this.fail("Semantic Map protocol mismatch: the viewer speaks a different bridge version. Reload Trajectory, then retry."); return; }
      if (compatibility === "build") { this.fail("Semantic Map build mismatch: the viewer belongs to a different Trajectory build. Reload Trajectory, then retry."); return; }
      if (compatibility === "initialization") { this.fail("Semantic Map could not initialize its session viewer. Check browser script blocking, reload Trajectory, then retry."); return; }
      if (compatibility !== "compatible") return;
      this.phase = "ready";
      this.clearWindowReady();
      this.clearLoadTimer();
      this.options.onStatus("Semantic Map ready");
      this.sendTheme();
      if (this.visible && this.latest) { this.pending = this.latest; this.flush(); }
      return;
    }
    if (!validEnvelope(value)) return;
    if (value.instance !== this.instance || value.nonce !== this.nonce) return;
    if (this.phase !== "ready") return;
    if (value.type === "ack") {
      if (!this.inFlight || value.sequence !== this.inFlight.sequence || value.epoch !== this.inFlight.epoch) return;
      const accepted = this.inFlight;
      this.inFlight = undefined;
      this.clearAckTimer();
      if (typeof value.error === "string") { this.fail("Semantic Map could not render the current snapshot"); return; }
      if (accepted.epoch === this.epoch) {
        if (!Array.isArray(value.nodeIds) || value.nodeIds.length > SEMANTIC_MAP_LIMITS.nodes) { this.fail("Semantic Map returned an invalid node index"); return; }
        const visibleNodes = new Map<string, ParentSemanticNode>();
        for (const id of value.nodeIds) {
          if (!isSemanticMapNodeId(id)) { this.fail("Semantic Map returned an invalid node ID"); return; }
          const node = accepted.nodes.get(id);
          if (!node || visibleNodes.has(id)) { this.fail("Semantic Map returned an out-of-scope node ID"); return; }
          visibleNodes.set(id, node);
        }
        this.renderedNodes = visibleNodes;
        if (this.latest?.text === accepted.text && this.latest.epoch === this.epoch) this.latest = { ...this.latest, nodes: visibleNodes, nodeCount: visibleNodes.size };
        this.lastSentText = accepted.text;
        this.options.onStatus(`Partial graph · ${String(visibleNodes.size)} nodes`);
        if (this.pending?.text === accepted.text && this.pending.epoch === accepted.epoch) this.pending = undefined;
      }
      if (this.visible && this.pending && this.pending.epoch === this.epoch) this.flush();
      return;
    }
    if (value.type !== "select" && value.type !== "detail") return;
    const id = value.nodeId;
    if (typeof id !== "string" || id.length > 4096 || !ID_PATTERN.test(id) || value.epoch !== this.epoch || !this.latest || this.latest.epoch !== this.epoch) return;
    const node = this.renderedNodes.get(id);
    if (!node) return;
    this.options.onRequest(node, value.type === "detail");
  }

  private sendTheme(): void {
    if (!this.port || this.phase !== "ready") return;
    try { this.port.postMessage({ type: "theme", version: SEMANTIC_MAP_VERSION, nonce: this.nonce, instance: this.instance, theme: this.theme }); }
    catch { this.fail("Semantic Map theme could not be updated"); }
  }

  private flush(): void {
    if (!this.active || this.phase !== "ready" || !this.visible || this.inFlight || !this.pending || !this.port) return;
    const delay = Math.max(0, 250 - (Date.now() - this.lastSendAt));
    if (delay) {
      if (!this.sendTimer) this.sendTimer = setTimeout(() => { this.sendTimer = undefined; this.flush(); }, delay);
      return;
    }
    const next = this.pending;
    this.pending = undefined;
    const sequence = ++this.sequence;
    this.inFlight = { sequence, epoch: next.epoch, text: next.text, nodes: next.nodes };
    this.lastSendAt = Date.now();
    try {
      this.port.postMessage({ type: "snapshot", version: SEMANTIC_MAP_VERSION, nonce: this.nonce, instance: this.instance, sequence, epoch: next.epoch, snapshot: next.snapshot });
    } catch { this.fail("Semantic Map update could not be sent"); return; }
    this.options.onStatus("Rendering Semantic Map…");
    this.ackTimer = setTimeout(() => { this.fail("Semantic Map stopped responding"); }, 10_000);
  }

  private fail(message: string): void {
    if (!this.active) return;
    this.failed = true;
    this.active = false;
    this.phase = "failed";
    this.clearTimers();
    this.clearWindowReady();
    this.cancelAssetLoad();
    this.port?.close();
    this.port = undefined;
    this.frame?.remove();
    this.frame = undefined;
    this.pending = undefined;
    this.latest = undefined;
    this.inFlight = undefined;
    this.renderedNodes = new Map();
    this.lastSentText = undefined;
    this.scopeIdentity = "";
    this.options.host.replaceChildren();
    this.options.onStatus(message);
    this.options.onFailure?.(message);
  }

  private clearLoadTimer(): void { if (this.loadTimer !== undefined) clearTimeout(this.loadTimer); this.loadTimer = undefined; }
  private clearAckTimer(): void { if (this.ackTimer !== undefined) clearTimeout(this.ackTimer); this.ackTimer = undefined; }
  private clearTimers(): void {
    this.clearLoadTimer(); this.clearAckTimer();
    if (this.sendTimer !== undefined) clearTimeout(this.sendTimer);
    this.sendTimer = undefined;
  }
}

/** Child-side opaque-window bootstrap and strict MessagePort client, appended by the maintainer build. */
export const SEMANTIC_MAP_BRIDGE_CLIENT = `(()=>{
  const channelName="pi-workflows-semantic-map",maxBytes=512*1024,noncePattern=/^[0-9a-f]{64}$/,buildPattern=/^[0-9a-f]{16}$/,idPattern=/^sm-(?:[0-9a-f]{2})+$/;
  const encoder=new TextEncoder(),htmlBuild=document.querySelector('meta[name="semantic-map-build"]')?.content;
  let initialized=false,viewerReady=false,port,nonce,instance,epoch=-1,lastSequence=0,nodeIds=new Set();
  const record=value=>value!==null&&typeof value==="object"&&!Array.isArray(value);
  const bytes=value=>{try{return encoder.encode(JSON.stringify(value)).byteLength}catch{return maxBytes+1}};
  const send=value=>{if(!port)return;try{port.postMessage({...value,version:1,nonce,instance})}catch{}};
  const request=(event,type)=>{if(!viewerReady||!nodeIds.size)return;const target=event.target instanceof Element?event.target.closest("[data-node-id]"):null;const id=target?.getAttribute("data-node-id");if(typeof id!=="string"||id.length>4096||!idPattern.test(id)||!nodeIds.has(id))return;send({type,nodeId:id,epoch})};
  const accept=event=>{
    const data=event.data;
    if(initialized||event.source!==parent||!record(data)||Object.keys(data).length!==6||Object.keys(data).some(key=>!["channel","type","version","build","nonce","instance"].includes(key))||data.channel!==channelName||data.type!=="bootstrap"||!Number.isSafeInteger(data.version)||typeof data.build!=="string"||!buildPattern.test(data.build)||typeof data.nonce!=="string"||!noncePattern.test(data.nonce)||typeof data.instance!=="string"||!noncePattern.test(data.instance)||event.ports.length!==1)return;
    initialized=true;nonce=data.nonce;instance=data.instance;port=event.ports[0];window.removeEventListener("message",accept);
    if(data.version!==1||data.build!==htmlBuild){port.start();send({type:"ready",build:htmlBuild});return}
    const svg=document.querySelector(".diagram-container > svg");
    const click=event=>request(event,"select"),detail=event=>request(event,"detail"),key=event=>{if(event.key==="Enter"&&event.shiftKey){event.preventDefault();request(event,"detail")}else if(event.key==="Enter"||event.key===" "){event.preventDefault();request(event,"select")}};
    port.onmessage=message=>{
      const next=message.data;
      if(!record(next)||bytes(next)>maxBytes||next.version!==1||next.nonce!==nonce||next.instance!==instance)return;
      if(next.type==="initialize"){
        if(viewerReady||Object.keys(next).some(key=>!["type","version","build","nonce","instance","script","style"].includes(key))||next.build!==htmlBuild||typeof next.script!=="string"||typeof next.style!=="string"||encoder.encode(next.script).byteLength>128*1024||encoder.encode(next.style).byteLength>32*1024)return;
        try{
          // The private parent port supplies only verified, build-owned same-origin assets; snapshots are never code.
          const style=document.createElement("style");style.textContent=next.style;document.head.append(style);
          const script=document.createElement("script");script.textContent=next.script;document.body.append(script);
          const viewer=window.SemanticMap,build=viewer&&typeof viewer.build==="string"&&buildPattern.test(viewer.build)?viewer.build:null;
          if(!viewer){send({type:"ready",build:htmlBuild,error:"initialization"});return}
          if(viewer.version!==1||build!==htmlBuild){send({type:"ready",build});return}
          viewerReady=true;if(svg){svg.addEventListener("click",click);svg.addEventListener("dblclick",detail);svg.addEventListener("keydown",key)}
          send({type:"ready",build});
        }catch{send({type:"ready",build:htmlBuild,error:"initialization"})}
        return;
      }
      if(!viewerReady)return;
      if(next.type==="theme"){if(Object.keys(next).some(key=>!["type","version","nonce","instance","theme"].includes(key))||next.theme!=="light"&&next.theme!=="dark")return;document.documentElement.setAttribute("data-theme",next.theme);return}
      if(next.type!=="snapshot"||Object.keys(next).some(key=>!["type","version","nonce","instance","sequence","epoch","snapshot"].includes(key))||!Number.isSafeInteger(next.sequence)||next.sequence<=lastSequence||!Number.isSafeInteger(next.epoch)||!record(next.snapshot))return;
      lastSequence=next.sequence;const seq=next.sequence,incomingEpoch=next.epoch;
      if(incomingEpoch<epoch){send({type:"ack",sequence:seq,epoch:incomingEpoch,nodeIds:Array.from(nodeIds)});return}
      try{const graph=window.SemanticMap.render(next.snapshot);epoch=incomingEpoch;nodeIds=new Set(graph.nodes.map(node=>node.id));send({type:"ack",sequence:seq,epoch:incomingEpoch,nodeIds:Array.from(nodeIds)})}catch(error){send({type:"ack",sequence:seq,epoch:incomingEpoch,error:(error instanceof Error?error.message:"render failed").slice(0,200)})}
    };
    port.start();
  };
  window.addEventListener("message",accept);
  const announce=()=>{if(typeof htmlBuild==="string"&&buildPattern.test(htmlBuild))parent.postMessage({channel:channelName,type:"viewer-listening",version:1,build:htmlBuild},"*")};
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",announce,{once:true});else announce();
})();`;

export const SEMANTIC_MAP_BRIDGE_LIMITS = Object.freeze({ messageBytes: MAX_MESSAGE_BYTES, messagesPerSecond: 4 });
export function isValidSemanticMapBridgeEnvelope(value: unknown): boolean { return validEnvelope(value); }
export function isSemanticMapNodeId(value: unknown): value is string { return typeof value === "string" && value.length <= 4096 && ID_PATTERN.test(value); }
