(function () {
  "use strict";
  var ns = "http://www.w3.org/2000/svg";
  var svg = document.querySelector(".diagram-container > svg");
  var edgeLayer = document.createElementNS(ns, "g");
  var nodeLayer = document.createElementNS(ns, "g");
  edgeLayer.setAttribute("data-profile-layer", "edges");
  nodeLayer.setAttribute("data-profile-layer", "nodes");
  svg.append(edgeLayer, nodeLayer);
  var slots = new Map();
  var graph = { nodes: [
    { id: "workflow", label: "Workflow", kind: "workflow", status: "running" },
    { id: "task-a", label: "Prepare inputs", kind: "task", status: "completed" },
    { id: "task-b", label: "Review inputs", kind: "task", status: "completed" },
    { id: "agent-call", label: "Review agent", kind: "agent", status: "running" },
    { id: "tool-call", label: "Read source", kind: "tool", status: "running" },
    { id: "result", label: "Review result", kind: "result", status: "partial" }
  ], edges: [
    { id: "fork-a", from: "workflow", to: "task-a", relation: "dependency" },
    { id: "fork-b", from: "workflow", to: "task-b", relation: "dependency" },
    { id: "agent-a", from: "task-a", to: "agent-call", relation: "dependency" },
    { id: "agent-b", from: "task-b", to: "agent-call", relation: "dependency" },
    { id: "tool", from: "agent-call", to: "tool-call", relation: "invokes" },
    { id: "result", from: "tool-call", to: "result", relation: "produces" }
  ] };
  var port = null;
  var sequence = 0;
  var cspViolations = [];
  function position(id) {
    if (!slots.has(id)) slots.set(id, slots.size);
    var slot = slots.get(id);
    if (slot >= 30) throw new Error("bounded profile exceeds 30 stable slots");
    return { x: 30 + (slot % 5) * 190, y: 32 + Math.floor(slot / 5) * 100 };
  }
  function visibleBox(element) {
    var box = element.getBBox();
    return [box.x, box.y, box.width, box.height].every(Number.isFinite) && box.width > 0 && box.height > 0;
  }
  function render(next, structural) {
    if (!next || !Array.isArray(next.nodes) || !Array.isArray(next.edges) || next.nodes.length > 30 || next.edges.length > 100) throw new Error("invalid bounded profile snapshot");
    var ids = new Set();
    next.nodes.forEach(function (node) {
      if (!node || typeof node.id !== "string" || node.id.length > 128 || ids.has(node.id)) throw new Error("invalid or duplicate node id");
      ids.add(node.id);
    });
    next.edges.forEach(function (edge) { if (!ids.has(edge.from) || !ids.has(edge.to) || typeof edge.id !== "string") throw new Error("relation endpoint missing"); });
    var focused = Archify.focus.active();
    var before = Archify.view.state();
    var edgeItems = document.createDocumentFragment();
    next.edges.forEach(function (edge) {
      var from = position(edge.from), to = position(edge.to);
      var sx = from.x + 90, sy = from.y + 36, tx = to.x + 90, ty = to.y + 36, mid = Math.round((sx + tx) / 2);
      var group = document.createElementNS(ns, "g");
      group.setAttribute("class", "semantic-map-profile-edge");
      group.setAttribute("data-edge-id", edge.id);
      group.setAttribute("data-edge-key", "profile:" + edge.id);
      group.setAttribute("data-edge-from", edge.from);
      group.setAttribute("data-edge-to", edge.to);
      group.setAttribute("data-edge-label", edge.relation);
      group.setAttribute("data-edge-type", edge.relation);
      var path = document.createElementNS(ns, "path");
      path.setAttribute("d", "M " + sx + " " + sy + " L " + mid + " " + sy + " L " + mid + " " + ty + " L " + tx + " " + ty);
      group.append(path);
      edgeItems.append(group);
    });
    var nodeItems = document.createDocumentFragment();
    next.nodes.forEach(function (item) {
      var at = position(item.id), group = document.createElementNS(ns, "g");
      group.setAttribute("class", "semantic-map-profile-node");
      group.setAttribute("data-node-id", item.id);
      group.setAttribute("data-node-label", item.label);
      group.setAttribute("data-node-kind", item.kind);
      group.setAttribute("data-node-status", item.status);
      group.setAttribute("data-profile-x", String(at.x));
      group.setAttribute("data-profile-y", String(at.y));
      group.setAttribute("transform", "translate(" + at.x + " " + at.y + ")");
      group.setAttribute("tabindex", "0");
      group.setAttribute("role", "button");
      group.setAttribute("aria-label", item.label + ", " + item.status);
      group.setAttribute("aria-pressed", "false");
      var box = document.createElementNS(ns, "rect");
      box.setAttribute("width", "180"); box.setAttribute("height", "72"); box.setAttribute("rx", "8");
      var label = document.createElementNS(ns, "text");
      label.setAttribute("x", "12"); label.setAttribute("y", "27"); label.textContent = item.label;
      var status = document.createElementNS(ns, "text");
      status.setAttribute("class", "semantic-map-profile-status");
      status.setAttribute("x", "12"); status.setAttribute("y", "54"); status.textContent = item.status;
      group.append(box, label, status);
      nodeItems.append(group);
    });
    edgeLayer.replaceChildren(edgeItems);
    nodeLayer.replaceChildren(nodeItems);
    graph = { nodes: next.nodes.map(function (node) { return Object.assign({}, node); }), edges: next.edges.map(function (edge) { return Object.assign({}, edge); }) };
    if (structural) {
      if (Archify.routeProbe.active()) Archify.routeProbe.clear({ updateUrl: false, preserveView: true, restoreFocus: false });
      if (focused) {
        var selected = Array.isArray(focused) ? focused : [focused];
        var survivors = selected.filter(function (id) { return ids.has(id); });
        if (survivors.length !== selected.length) {
          if (survivors.length) Archify.focus.setMany(survivors, { toggle: false, updateUrl: false, preserveRoute: true });
          else Archify.focus.clear({ preserveView: true });
        }
      }
      Archify.finder.refresh();
    }
    return { previousView: before, currentView: Archify.view.state(), focused: Archify.focus.active() };
  }
  function metrics() {
    var nodes = Array.from(svg.querySelectorAll("[data-profile-layer='nodes'] [data-node-id]"));
    var edges = Array.from(svg.querySelectorAll("[data-profile-layer='edges'] [data-edge-from]"));
    return {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      nodeGeometry: nodes.every(visibleBox),
      edgeGeometry: edges.every(function (edge) { var path = edge.querySelector("path"); return Boolean(path && path.getTotalLength() > 0 && Number.isFinite(path.getTotalLength())); }),
      slots: Object.fromEntries(nodes.map(function (node) { return [node.getAttribute("data-node-id"), [node.getAttribute("data-profile-x"), node.getAttribute("data-profile-y")]]; })),
      relationTypes: Array.from(new Set(edges.map(function (edge) { return edge.getAttribute("data-edge-type"); }))),
      routeDisabledInEmbed: Archify.routeProbe.begin() === false && Archify.routeProbe.active() === null,
      viewBox: svg.getAttribute("viewBox"),
      camera: Archify.view.state(),
      viewBox: svg.getAttribute("viewBox")
    };
  }
  function send(type, data) { if (port) port.postMessage(Object.assign({ type: type, sequence: ++sequence }, data || {})); }
  function findAndSelect(id) {
    Archify.finder.refresh(); Archify.finder.open();
    var input = document.getElementById("node-finder-input");
    input.value = id; input.dispatchEvent(new Event("input", { bubbles: true }));
    var count = document.querySelectorAll("#node-finder-results .node-finder-result").length;
    var selected = Archify.finder.select(id);
    return { count: count, selected: selected, focus: Archify.focus.active(), focusMatches: svg.querySelectorAll("[data-focus-match]").length, camera: Archify.view.state() };
  }
  function setStatus() {
    var node = svg.querySelector('[data-node-id="tool-call"]');
    node.setAttribute("data-node-status", "completed");
    node.setAttribute("aria-label", "Read source, completed");
    node.querySelector(".semantic-map-profile-status").textContent = "completed";
  }
  window.addEventListener("securitypolicyviolation", function (event) {
    cspViolations.push({ directive: event.violatedDirective, blocked: event.blockedURI });
    send("csp-violation", cspViolations[cspViolations.length - 1]);
  });
  window.addEventListener("message", function (event) {
    if (port || event.source !== parent || event.data?.channel !== "semantic-map-e0-profile" || event.data?.nonce !== "semantic-map-e0-profile-fixture" || event.ports.length !== 1) return;
    port = event.ports[0];
    port.onmessage = function (message) {
      var action = message.data?.action;
      if (action === "metrics") send("metrics", metrics());
      else if (action === "status") { var before = metrics(); var oldStroke = getComputedStyle(svg.querySelector('[data-node-id="tool-call"] rect')).stroke; setStatus(); send("status", { before: before, after: metrics(), oldStroke: oldStroke, newStroke: getComputedStyle(svg.querySelector('[data-node-id="tool-call"] rect')).stroke, statusText: svg.querySelector('[data-node-id="tool-call"] .semantic-map-profile-status').textContent }); }
      else if (action === "insert") {
        var next = { nodes: graph.nodes.concat([{ id: "new-task", label: "New task", kind: "task", status: "pending" }]), edges: graph.edges.concat([{ id: "new-dependency", from: "workflow", to: "new-task", relation: "dependency" }]) };
        var state = render(next, true);
        send("insert", { previousView: state.previousView, currentView: state.currentView, metrics: metrics() });
      } else if (action === "select") send("select", findAndSelect("new-task"));
      else if (action === "remove-selected") {
        var before = metrics();
        var next = { nodes: graph.nodes.filter(function (node) { return node.id !== "new-task"; }), edges: graph.edges.filter(function (edge) { return edge.from !== "new-task" && edge.to !== "new-task"; }) };
        var state = render(next, true);
        Archify.finder.open();
        var input = document.getElementById("node-finder-input"); input.value = "new-task"; input.dispatchEvent(new Event("input", { bubbles: true }));
        var searchCount = document.querySelectorAll("#node-finder-results .node-finder-result").length;
        Archify.finder.close({ restoreFocus: false });
        send("remove-selected", { before: before, after: metrics(), previousView: state.previousView, currentView: state.currentView, active: Archify.focus.active(), finderCount: Archify.finder.count, searchCount: searchCount, focusMarkers: svg.querySelectorAll("[data-focus-selected], [data-focus-match], [data-focus-active]").length, chipHidden: document.querySelector(".focus-chip").hidden, hash: location.hash, route: Archify.routeProbe.active() });
      } else if (action === "pan-zoom") {
        var before = Archify.view.state();
        Archify.view.zoomIn();
        var afterZoom = Archify.view.state();
        Archify.view.centerAt(700, 500, { scale: 1.5, instant: true });
        send("pan-zoom", { before: before, afterZoom: afterZoom, afterPan: Archify.view.state() });
      }
    };
    port.start();
    send("ready", { origin: self.origin, externalScript: Array.from(document.scripts).some(function (script) { return script.src.endsWith("/live-profile.js"); }), externalStyle: Array.from(document.styleSheets).some(function (sheet) { return sheet.href && sheet.href.endsWith("/live-profile.css"); }), cspViolations: cspViolations.slice() });
    send("initial", render(graph, true));
  });
})();
