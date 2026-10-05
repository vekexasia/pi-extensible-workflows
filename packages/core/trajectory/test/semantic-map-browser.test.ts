import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const chromeCandidates = [process.env.PI_TRAJECTORY_CHROME, "C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/chromium", "/usr/bin/google-chrome", "/usr/bin/chromium-browser"];
try { for (const version of readdirSync(join(homedir(), ".cache", "ms-playwright"))) chromeCandidates.push(join(homedir(), ".cache", "ms-playwright", version, "chrome-linux64", "chrome")); } catch { /* The Playwright browser cache is optional. */ }
const chrome = chromeCandidates.find((candidate) => candidate && existsSync(candidate));
const htmlAsset = readFileSync(new URL("../src/assets/semantic-map.html", import.meta.url), "utf8");
const jsAsset = readFileSync(new URL("../src/assets/semantic-map.js", import.meta.url));
const cssAsset = readFileSync(new URL("../src/assets/semantic-map.css", import.meta.url));
const fixtureScript = `<script>
document.addEventListener('DOMContentLoaded', function () {
  var scope = { publisherId: 'browser', targetKind: 'run', targetId: 'run-browser' };
  var nodes = [
    { id: 'root', name: 'Workflow root', state: 'completed', attempts: 2, attemptDetails: [{ attempt: 1, error: { code: 'RETRY' } }, { attempt: 2 }], output: { status: 'available' }, toolCalls: [{ id: 'call-1', name: 'read', state: 'running' }] },
    { id: 'child', name: '<img src=x onerror=alert(1)> javascript:alert(2)', state: 'stopped', parentId: 'root', structuralPath: ['phase', 'review'], output: { status: 'cancelled' } },
    { id: 'worker', name: 'Worker', state: 'running', output: { status: 'pending' } }
  ];
  var snapshot = { scope: scope, run: { id: 'run-browser', workflowName: 'Browser test', state: 'running', agents: nodes }, relations: [
    { kind: 'dependency', fromAgentId: 'root', toAgentId: 'child', evidence: 'recorded' },
    { kind: 'fork', fromAgentId: 'root', toAgentId: 'worker', evidence: 'recorded' },
    { kind: 'merge', fromAgentId: 'child', toAgentId: 'worker', evidence: 'recorded' }
  ] };
  var first = window.SemanticMap.render(snapshot);
  var svg = document.querySelector('.diagram-container > svg');
  var nodesNow = Array.from(svg.querySelectorAll('.semantic-map-node'));
  var edgesNow = Array.from(svg.querySelectorAll('.semantic-map-edge'));
  var geometry = nodesNow.every(function (node) { var box = node.getBBox(); return box.width > 0 && box.height > 0; }) && edgesNow.every(function (edge) { var path = edge.querySelector('path'); return path && path.getTotalLength() > 0; });
  var child = nodesNow.find(function (node) { return node.getAttribute('data-node-label').indexOf('<img') === 0; });
  var injectionSafe = Boolean(child && !child.querySelector('img,script') && child.querySelector('text').textContent.indexOf('<img') === 0);
  var noExternalLinkAttrs = nodesNow.every(function (node) { return !node.querySelector('[href],[src],[style],[onclick]'); });
  window.__semanticMapCase = { first: first, geometry: geometry, injectionSafe: injectionSafe, noExternalLinkAttrs: noExternalLinkAttrs, snapshot: snapshot, childId: child && child.getAttribute('data-node-id'), camera: Archify.view.state(), viewBox: svg.getAttribute('viewBox'), positions: Object.fromEntries(nodesNow.map(function (node) { return [node.getAttribute('data-node-id'), node.getAttribute('transform')]; })) };
}, { once: true });
</script>`;

function wait(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); assert.ok(address && typeof address !== "string"); return address.port;
}
async function runChrome(url: string, profile: string, callback: (evaluate: (expression: string) => Promise<unknown>) => Promise<void>): Promise<void> {
  assert.ok(chrome);
  const portProbe = createServer(); const port = await listen(portProbe); await new Promise<void>((resolve) => { portProbe.close(() => { resolve(); }); });
  const child = spawn(chrome, ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check", `--remote-debugging-port=${String(port)}`, `--user-data-dir=${profile}`, url], { stdio: "ignore" });
  let socket: WebSocket | undefined;
  try {
    let endpoint: string | undefined;
    for (let attempt = 0; attempt < 200 && !endpoint; attempt += 1) {
      try { const pages = await (await fetch(`http://127.0.0.1:${String(port)}/json`)).json() as Array<{ type?: string; webSocketDebuggerUrl?: string }>; endpoint = pages.find((page) => page.type === "page")?.webSocketDebuggerUrl; } catch { await wait(50); }
    }
    assert.ok(endpoint, "Chrome DevTools endpoint did not start");
    socket = new WebSocket(endpoint);
    await new Promise<void>((resolve, reject) => { socket?.addEventListener("open", () => { resolve(); }, { once: true }); socket?.addEventListener("error", () => { reject(new Error("Chrome DevTools connection failed")); }, { once: true }); });
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>(); let nextId = 1;
    socket.addEventListener("message", (event) => { try { const item = JSON.parse(String(event.data)) as { id?: number; result?: { result?: { value?: unknown }; exceptionDetails?: { text?: string } }; error?: { message?: string } }; if (typeof item.id !== "number") return; const request = pending.get(item.id); if (!request) return; pending.delete(item.id); if (item.error || item.result?.exceptionDetails) request.reject(new Error(item.error?.message ?? item.result?.exceptionDetails?.text ?? "Chrome evaluation failed")); else request.resolve(item.result?.result?.value); } catch { /* Ignore non-command events. */ } });
    const evaluate = (expression: string): Promise<unknown> => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); socket?.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } })); });
    await evaluate("void 0");
    for (let attempt = 0; attempt < 100; attempt += 1) { if (await evaluate("Boolean(window.__semanticMapCase)")) break; await wait(25); }
    const result = await evaluate("window.__semanticMapCase");
    assert.ok(result && typeof result === "object");
    await callback(evaluate);
  } finally {
    socket?.close(); child.kill("SIGTERM");
    await wait(250);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* Windows Chrome may finish profile cleanup on exit. */ }
  }
}

void test("pinned Archify assets adapt and incrementally render safe bounded workflow graphs in Chromium", { skip: !chrome, timeout: 120_000 }, async () => {
  const requested: string[] = [];
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname; requested.push(path);
    const csp = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
    response.setHeader("content-security-policy", csp); response.setHeader("x-content-type-options", "nosniff"); response.setHeader("cache-control", "no-store");
    if (path === "/semantic-map.html") { response.writeHead(200, { "content-type": "text/html; charset=utf-8" }); response.end(htmlAsset.replace("</body>", `<link rel="stylesheet" href="/semantic-map.css"><script src="/semantic-map.js"></script>${fixtureScript}</body>`)); }
    else if (path === "/semantic-map.js") { response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" }); response.end(jsAsset); }
    else if (path === "/semantic-map.css") { response.writeHead(200, { "content-type": "text/css; charset=utf-8" }); response.end(cssAsset); }
    else { response.writeHead(404); response.end(); }
  });
  const port = await listen(server); const root = mkdtempSync(join(tmpdir(), "semantic-map-chrome-"));
  try {
    await runChrome(`http://127.0.0.1:${String(port)}/semantic-map.html?embed=1`, root, async (evaluate) => {
      const initial = JSON.parse(String(await evaluate("JSON.stringify(window.__semanticMapCase)"))) as { first: { nodes: unknown[]; edges: unknown[] }; geometry: boolean; injectionSafe: boolean; noExternalLinkAttrs: boolean; snapshot: { run: { agents: Array<Record<string, unknown>> } }; childId: string; camera: { scale?: number }; viewBox: string; positions: Record<string, string> };
      assert.equal(initial.first.nodes.length, 1 + 3 + 2 + 3 + 1, "workflow, agents, tasks, results and tool nodes are present; retries are counted on the agent card");
      assert.ok(initial.first.edges.some((edge) => (edge as { kind: string }).kind === "dependency"));
      assert.ok(initial.first.edges.some((edge) => (edge as { kind: string }).kind === "fork"));
      assert.ok(initial.first.edges.some((edge) => (edge as { kind: string }).kind === "merge"));
      const retried = await evaluate("(()=>{const n=[...document.querySelectorAll('.semantic-map-node[data-node-kind=agent]')].find(e=>e.getAttribute('data-node-label')==='Workflow root');return n?{cls:n.getAttribute('class'),count:n.querySelector('.semantic-map-retry-count').textContent,loop:getComputedStyle(n.querySelector('.semantic-map-retry-loop')).display,inner:getComputedStyle(n.querySelector('.semantic-map-node-inner')).display}:null})()");
      assert.deepEqual(retried, { cls: "semantic-map-node kind-agent node-had-failure node-retried", count: "x2", loop: "inline", inner: "inline" }, "one card: inner red frame for the failed attempt and a x2 retry loop");
      assert.equal(initial.geometry, true); assert.equal(initial.injectionSafe, true); assert.equal(initial.noExternalLinkAttrs, true);
      assert.ok(initial.childId.startsWith("sm-"));
      const grouped = await evaluate(`(()=>{const groups=[...document.querySelectorAll('.semantic-map-agent-group')];return {agents:groups.map(group=>group.getAttribute('data-agent-id')).sort(),owned:groups.every(group=>[...group.querySelectorAll('.semantic-map-node')].every(node=>node.getAttribute('data-agent-id')===group.getAttribute('data-agent-id'))),titles:[...document.querySelectorAll('.semantic-map-group-label')].map(node=>node.textContent),inert:document.querySelectorAll('.semantic-map-group-background img, .semantic-map-group-background script').length}})()`);
      assert.ok(grouped && typeof grouped === "object");
      const grouping = grouped as { agents: string[]; owned: boolean; titles: string[]; inert: number };
      assert.deepEqual(grouping.agents, ["child", "root", "worker"]);
      assert.equal(grouping.owned, true, "attempts, tools and results are DOM children of their recorded agent group");
      assert.ok(grouping.titles.includes("Workflow root") && grouping.titles.includes("Worker"));
      assert.equal(grouping.inert, 0);
      const childResultId = await evaluate(`(function(){ var api=Archify.finder; api.refresh(); return api.select(${JSON.stringify(initial.childId)}); })()`);
      assert.equal(childResultId, true); assert.equal(await evaluate("Archify.focus.active()"), initial.childId);
      const cameraProbe = await evaluate("(function(){var before=Archify.view.state();Archify.view.zoomIn();var zoom=Archify.view.state();Archify.view.centerAt(700,500,{scale:1.5,instant:true});window.dispatchEvent(new Event('resize'));return {before:before,zoom:Archify.view.state(),slots:Array.from(document.querySelectorAll('.semantic-map-node')).map(n=>n.getAttribute('transform')).join('|')};})()");
      assert.ok(cameraProbe && typeof cameraProbe === "object");
      const cameraState = cameraProbe as { before: { scale: number }; zoom: { scale: number }; slots: string };
      assert.ok(cameraState.zoom.scale > cameraState.before.scale);
      assert.ok(cameraState.slots.length > 0);
      const update = await evaluate(`(function(){ var s=window.__semanticMapCase.snapshot; s.run.agents[2].state='completed'; var before=document.querySelector('.diagram-container > svg').getAttribute('viewBox'); var slots=Array.from(document.querySelectorAll('.semantic-map-node')).map(n=>n.getAttribute('transform')).join('|'); var camera=Archify.view.state(); var observer=new MutationObserver(function(){}); observer.observe(document.querySelector('.diagram-container > svg'),{attributes:true,subtree:true,attributeFilter:['d','transform','viewBox']}); var g=window.SemanticMap.render(s); var geometryMutations=observer.takeRecords().length; observer.disconnect(); return {g:g, before:before, after:document.querySelector('.diagram-container > svg').getAttribute('viewBox'), slots:slots, camera:camera, afterSlots:Array.from(document.querySelectorAll('.semantic-map-node')).map(n=>n.getAttribute('transform')).join('|'),geometryMutations:geometryMutations}; })()`);
      assert.ok(update && typeof update === "object");
      const stable = update as { g: { structural: boolean }; before: string; after: string; slots: string; afterSlots: string; camera: { scale?: number }; geometryMutations: number };
      assert.equal(stable.before, stable.after); assert.equal(stable.slots, stable.afterSlots); assert.equal(stable.geometryMutations, 0);
      assert.equal(await evaluate("Archify.view.state().scale"), stable.camera.scale);
      assert.deepEqual(await evaluate("Archify.view.state()"), stable.camera);
      const insert = await evaluate(`(function(){ var s=window.__semanticMapCase.snapshot; s.run.agents.push({id:'new-agent',name:'Inserted live',state:'running',output:{status:'pending'}}); s.relations.push({kind:'dependency',fromAgentId:'root',toAgentId:'new-agent',evidence:'recorded'}); window.SemanticMap.render(s); return {nodes:document.querySelectorAll('.diagram-container svg [data-node-id]').length,finder:Archify.finder.count,camera:Archify.view.state(),stable:JSON.stringify(window.__semanticMapCase.positions)===JSON.stringify(Object.fromEntries(Array.from(document.querySelectorAll('.diagram-container svg [data-node-id]')).filter(n=>Object.hasOwn(window.__semanticMapCase.positions,n.getAttribute('data-node-id'))).map(n=>[n.getAttribute('data-node-id'),n.getAttribute('transform')]))),geometry:Array.from(document.querySelectorAll('.semantic-map-edge path')).every(p=>p.getTotalLength()>0)}; })()`);
      // Drawn cards: 4 agents, 4 results and 1 tool; workflow/scope nodes are written on the boxes instead of drawn as cards.
      assert.deepEqual(insert, { nodes: 9, finder: 9, camera: stable.camera, stable: true, geometry: true });
      const remove = await evaluate(`(function(){ var s=window.__semanticMapCase.snapshot; s.run.agents=s.run.agents.filter(a=>a.id!=='child'); window.SemanticMap.render(s); return {focus:Archify.focus.active(),found:document.querySelectorAll('.diagram-container svg [data-node-id]').length,count:Archify.finder.count,camera:Archify.view.state()}; })()`);
      assert.deepEqual(remove, { focus: null, found: 7, count: 7, camera: stable.camera }, "removing an agent removes its card and result card");
      assert.equal(await evaluate("document.querySelectorAll('.semantic-map-agent-group[data-agent-id=child]').length"), 0, "removed agents leave no group behind");
      // Long transcripts: the box starts collapsed (head, summary card, tail); the summary card expands it locally.
      const folding = await evaluate(`(function(){ var s=window.__semanticMapCase.snapshot; var events=[]; for (var i=0;i<20;i++) events.push(i%2===0?{kind:'assistant'}:{kind:'tool',id:'t'+i,name:i===7?'edit':'read',state:i===7?'failed':'completed'}); s.run.agents[0].events=events; window.SemanticMap.render(s); var cards=function(){return document.querySelectorAll('.semantic-map-node[data-agent-id=root]').length}; var summary=document.querySelector('.semantic-map-summary[data-collapse-toggle=root]:not(.is-hidden)'); var collapsed=cards(); var label=summary&&summary.textContent; summary.dispatchEvent(new MouseEvent('click',{bubbles:true})); var expanded=cards(); var toggle=document.querySelector('.semantic-map-group-toggle[data-collapse-toggle=root]'); var expandedLabel=toggle.textContent; toggle.dispatchEvent(new MouseEvent('click',{bubbles:true})); return {collapsed:collapsed,expanded:expanded,again:cards(),label:label,expandedLabel:expandedLabel,summaryHidden:!document.querySelector('.semantic-map-summary[data-collapse-toggle=root]:not(.is-hidden)')===false}; })()`);
      assert.deepEqual(folding, { collapsed: 6, expanded: 22, again: 6, label: "⋯ 16 more · show allread ×7 · edit ×11 failed", expandedLabel: "▾ collapse", summaryHidden: true }, "collapsed box shows 6 cards, expands to all 22 and collapses again");
      const orphanLinks = await evaluate(`(function(){ var s=window.__semanticMapCase.snapshot; s.run.agents=s.run.agents.filter(function(a){return a.id!=='root'}); window.SemanticMap.render(s); return {links:document.querySelectorAll('.semantic-map-summary-link').length,containers:document.querySelectorAll('.semantic-map-summary-links').length,groups:document.querySelectorAll('.semantic-map-agent-group').length}; })()`);
      assert.deepEqual(orphanLinks, { links: 0, containers: 2, groups: 2 }, "removing a collapsed box removes its summary connectors too");
    });
    const paths = requested.filter((path) => path !== "/favicon.ico");
    assert.ok(paths.includes("/semantic-map.html") && paths.includes("/semantic-map.js") && paths.includes("/semantic-map.css"));
    assert.ok(paths.every((path) => ["/semantic-map.html", "/semantic-map.js", "/semantic-map.css"].includes(path)), `unexpected local asset request(s): ${paths.join(", ")}`);
  } finally { await new Promise<void>((resolve) => { server.close(() => { resolve(); }); }); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
