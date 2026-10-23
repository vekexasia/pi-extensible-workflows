import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ActionUi, AgentsActionProvider, AgentsActionTarget } from "../src/agents-actions-contract.js";
import { runAgentsWorkspace, type AgentsWorkspaceLoop } from "../src/agents-command.js";
import type { AgentsWorkspaceExit, AgentsWorkspaceOptions, AgentsWorkspaceState, OpenAgentsWorkspace } from "../src/agents-workspace.js";
import type { SessionTreeNode } from "../src/session-agents.js";
import { recordingUi, settle } from "./agents-workspace-harness.js";

/** The key every bundle's copy of src/agents-command.ts guards its loop with. */
const LOOP_KEY = Symbol.for("pi-extensible-workflows.agents-workspace-loop");
const RUN: AgentsActionTarget = { kind: "run", runId: "R" };
const SUBAGENT: AgentsActionTarget = { kind: "subagent", id: "s" };
function stateOf(selectedKey: string, overrides: Partial<AgentsWorkspaceState> = {}): AgentsWorkspaceState {
  return { selectedKey, row: 2, expansion: [["run:R", false]], focus: "transcript", sidebarVisible: true, toolsExpanded: true, detailsShown: true, ...overrides };
}
function exitOf(label: string, provider: AgentsActionProvider, target: AgentsActionTarget = RUN, state: AgentsWorkspaceState = stateOf("run:R")): AgentsWorkspaceExit { return { target, label, provider, state }; }
const NODE: SessionTreeNode = { key: "run:R", parentKey: undefined, depth: 0, kind: "run", label: "Workflow", state: "running", initiallyExpanded: true, line: () => "Workflow", details: () => [], title: () => "Workflow", agent: undefined, target: RUN };


/** Offers `offers(target)` now, counting the asks in `asked`; `perform` runs a label, after it is recorded as `<kind>:<label>`. */
class FakeProvider implements AgentsActionProvider {
  readonly runs: string[] = [];
  asked = 0;
  constructor(private readonly offers: (target: AgentsActionTarget) => readonly string[], private readonly perform: (label: string, ui: ActionUi) => Promise<{ readonly select?: string }> = async () => ({})) {}
  async actions(target: AgentsActionTarget): Promise<readonly { readonly label: string }[]> { this.asked += 1; return this.offers(target).map((label) => ({ label })); }
  async run(target: AgentsActionTarget, label: string, ui: ActionUi): Promise<{ readonly select?: string }> {
    this.runs.push(`${target.kind}:${label}`);
    return this.perform(label, ui);
  }
}
/** The shared recording ActionUi, whose notify and status calls are recorded in `calls`; notify also goes to the loop's onNotify. */
function loopUi(calls: string[]): AgentsWorkspaceLoop["actionUi"] {
  return (onNotify) => ({ ...recordingUi(), notify(message, level) { calls.push(`notify:${message}`); onNotify(message, level); }, status(text) { calls.push(`status:${String(text)}`); } });
}
/** A workspace that resolves each open with the next of `exits` (a function is awaited first), recording the options and "open" in `calls`. */
function opener(exits: (AgentsWorkspaceExit | undefined | (() => Promise<AgentsWorkspaceExit | undefined>))[], calls: string[] = []): { readonly open: OpenAgentsWorkspace; readonly opens: AgentsWorkspaceOptions[] } {
  const opens: AgentsWorkspaceOptions[] = [];
  return {
    opens,
    open: async (_ctx, options) => {
      opens.push(options);
      calls.push("open");
      const next = exits.shift();
      return typeof next === "function" ? next() : next;
    },
  };
}
function commandContext(notices: string[], signal?: AbortSignal): ExtensionCommandContext {
  return { cwd: "/project", signal, ui: { notify(message: string) { notices.push(message); } } } as unknown as ExtensionCommandContext;
}
/** The loop over `open` with a source listing `lists` in turn (an error rejects that list; the last one repeats). */
function loopOf(open: OpenAgentsWorkspace, providers: readonly AgentsActionProvider[], calls: string[], overrides: Partial<AgentsWorkspaceLoop> = {}, lists: (readonly SessionTreeNode[] | Error)[] = [[NODE]]): AgentsWorkspaceLoop & { readonly listed: () => number } {
  let listed = 0;
  const pending = [...lists];
  return {
    open,
    options: {
      agents: { list: async () => { listed += 1; const next = pending.length > 1 ? pending.shift() : pending[0]; if (next instanceof Error) throw next; return next ?? []; } },
      openSource: () => { throw new Error("unexpected openSource"); },
      createView: () => { throw new Error("unexpected createView"); },
      pollIntervalMs: 250,
      editorCommand: () => "vi",
    },
    providers,
    actionUi: loopUi(calls),
    hasContent: (nodes) => nodes.length > 0,
    onEmpty: () => { calls.push("empty"); },
    listed: () => listed,
    ...overrides,
  };
}

void test("an action runs with the provider of its menu entry; the loop asks no provider for labels", async () => {
  const calls: string[] = [];
  const first = new FakeProvider(() => ["Stop"]);
  const second = new FakeProvider((target) => target.kind === "run" ? ["Stop", "Pause"] : ["Retry"]);
  const { open, opens } = opener([exitOf("Stop", second), exitOf("Retry", second, SUBAGENT), exitOf("Pause", second), undefined]);
  const providers = [first, second];
  const notices: string[] = [];
  await runAgentsWorkspace(commandContext(notices), loopOf(open, providers, calls));
  assert.deepEqual(first.runs, [], "not an earlier provider that offers the label too");
  assert.deepEqual(second.runs, ["run:Stop", "subagent:Retry", "run:Pause"]);
  assert.equal(first.asked + second.asked, 0, "the provider re-checks the label itself");
  assert.equal(opens.length, 4);
  assert.ok(opens.every((options) => options.actions === providers), "every open gets the providers");
  assert.deepEqual(notices, [], "the loop itself shows nothing through Pi");
});

void test("the workspace opens again with the exit's state, the action's select as its initial key and the action's notices", async () => {
  const calls: string[] = [];
  const provider = new FakeProvider(() => ["Retry", "Pause"], async (label, ui) => {
    if (label === "Retry") { ui.notify("Retried subagent s as t.", "info"); return { select: "subagent:t" }; }
    ui.notify("Paused workflow W.");
    ui.notify("Cannot pause twice.", "warning");
    return {};
  });
  const retried = stateOf("subagent:s", { focus: "sidebar" });
  const paused = stateOf("subagent:t", { detailsShown: false });
  const { open, opens } = opener([exitOf("Retry", provider, SUBAGENT, retried), exitOf("Pause", provider, RUN, paused), undefined], calls);
  const loop = loopOf(open, [provider], calls, { initialKey: "run:R:a" });
  await runAgentsWorkspace(commandContext([]), loop);
  assert.equal(opens.length, 3);
  const [first, second, third] = opens;
  assert.ok(first && second && third);
  assert.equal(first.initialKey, "run:R:a");
  assert.equal("state" in first, false);
  assert.equal("notices" in first, false);
  assert.deepEqual(await first.agents.list(), [NODE], "the first open lists what the loop listed");
  assert.equal(first.openSource, loop.options.openSource);
  assert.equal(first.createView, loop.options.createView);
  assert.equal(first.pollIntervalMs, 250);
  assert.equal(first.editorCommand, loop.options.editorCommand);
  assert.deepEqual(second.state, retried);
  assert.equal(second.initialKey, "subagent:t", "the new run after a Retry");
  assert.deepEqual(second.notices, ["Retried subagent s as t."]);
  assert.deepEqual(await second.agents.list(), [NODE], "so does every reopen");
  assert.deepEqual(third.state, paused);
  assert.equal("initialKey" in third, false, "an action that selects nothing keeps the state's selection");
  assert.deepEqual(third.notices, ["Paused workflow W.", "Cannot pause twice."]);
  assert.deepEqual(calls, ["open", "notify:Retried subagent s as t.", "status:undefined", "open", "notify:Paused workflow W.", "notify:Cannot pause twice.", "status:undefined", "open"], "the status cleared once each action settled, before the workspace is back");
  assert.equal(loop.listed(), 3, "the source is listed before every open");
});

void test("the workspace opens again only once a pending action (a Foreground resume) settled", async () => {
  const calls: string[] = [];
  let release = (): void => {};
  const provider = new FakeProvider(() => ["Resume"], (_label, ui) => new Promise((resolve) => {
    release = () => { ui.notify("Workflow W completed."); resolve({}); };
  }));
  const { open, opens } = opener([exitOf("Resume", provider), undefined], calls);
  const running = runAgentsWorkspace(commandContext([]), loopOf(open, [provider], calls));
  await settle();
  assert.deepEqual(provider.runs, ["run:Resume"]);
  assert.equal(opens.length, 1, "the workspace stays closed while the run goes on");
  assert.deepEqual(calls, ["open"], "and its status stays");
  release();
  await running;
  assert.equal(opens.length, 2);
  assert.deepEqual(calls, ["open", "notify:Workflow W completed.", "status:undefined", "open"]);
  assert.deepEqual(opens[1]?.notices, ["Workflow W completed."]);
});

void test("an abort while an action runs, or while the workspace is open, opens it no more", async () => {
  const calls: string[] = [];
  const controller = new AbortController();
  let release = (): void => {};
  const provider = new FakeProvider(() => ["Resume"], () => new Promise((resolve) => { release = () => { resolve({}); }; }));
  const { open, opens } = opener([exitOf("Resume", provider), exitOf("Resume", provider)], calls);
  const running = runAgentsWorkspace(commandContext([], controller.signal), loopOf(open, [provider], calls));
  await settle();
  controller.abort();
  release();
  await running;
  assert.equal(opens.length, 1, "no reopen after the abort");
  assert.deepEqual(calls, ["open", "status:undefined"], "the action's status is still cleared");

  const late = new AbortController();
  const lateCalls: string[] = [];
  const lateProvider = new FakeProvider(() => ["Resume"]);
  const lateOpen = opener([async () => { late.abort(); return exitOf("Resume", lateProvider); }], lateCalls);
  await runAgentsWorkspace(commandContext([], late.signal), loopOf(lateOpen.open, [lateProvider], lateCalls));
  assert.deepEqual(lateProvider.runs, [], "an exit that comes with the abort runs nothing");
  assert.equal(lateOpen.opens.length, 1);
});

void test("every open gets the shutdown signal, and a shutdown while an action runs lists and opens the workspace no more", async () => {
  const calls: string[] = [];
  const shutdown = new AbortController();
  let release = (): void => {};
  const provider = new FakeProvider(() => ["Resume"], () => new Promise((resolve) => { release = () => { resolve({}); }; }));
  const { open, opens } = opener([exitOf("Resume", provider), undefined], calls);
  const loop = loopOf(open, [provider], calls);
  const running = runAgentsWorkspace(commandContext([]), { ...loop, options: { ...loop.options, shutdown: shutdown.signal } });
  await settle();
  assert.equal(opens[0]?.shutdown, shutdown.signal);
  shutdown.abort();
  release();
  await running;
  assert.equal(opens.length, 1, "no reopen after the shutdown");
  assert.equal(loop.listed(), 1, "nor another list");
});

void test("a source with nothing to show calls onEmpty and opens nothing, before the first open and before reopening; a list that fails still opens", async () => {
  const calls: string[] = [];
  const provider = new FakeProvider(() => ["Delete"]);
  const { open, opens } = opener([exitOf("Delete", provider), exitOf("Delete", provider)], calls);
  await runAgentsWorkspace(commandContext([]), loopOf(open, [provider], calls, {}, [[NODE], []]));
  assert.deepEqual(provider.runs, ["run:Delete"]);
  assert.equal(opens.length, 1, "the last run deleted: no reopen");
  assert.deepEqual(calls, ["open", "status:undefined", "empty"]);

  const emptyCalls: string[] = [];
  const empty = opener([undefined], emptyCalls);
  await runAgentsWorkspace(commandContext([]), loopOf(empty.open, [provider], emptyCalls, {}, [[]]));
  assert.deepEqual(emptyCalls, ["empty"], "nothing to show at first: no open");

  const failingCalls: string[] = [];
  const failing = opener([exitOf("Delete", provider), undefined], failingCalls);
  await runAgentsWorkspace(commandContext([]), loopOf(failing.open, [provider], failingCalls, {}, [new Error("unreadable")]));
  assert.deepEqual(failingCalls, ["open", "status:undefined", "open"], "a list that fails opens the workspace, whose title says why");
});

void test("the list that decided whether to open is the workspace's first list; a list that failed, and every later one, goes to the source", async () => {
  const later: SessionTreeNode = { ...NODE, key: "run:L", title: () => "Later" };
  const seen: (readonly string[])[] = [];
  const reading: OpenAgentsWorkspace = async (_ctx, options) => {
    seen.push([(await options.agents.list()).map((node) => node.key).join(), (await options.agents.list()).map((node) => node.key).join()].filter(Boolean));
    return undefined;
  };
  const seeded = loopOf(reading, [], [], {}, [[NODE], [later]]);
  await runAgentsWorkspace(commandContext([]), seeded);
  assert.deepEqual(seen, [["run:R", "run:L"]]);
  assert.equal(seeded.listed(), 2, "the check, then the open's second list; its first list was the check's");
  const failing = loopOf(reading, [], [], {}, [new Error("locked"), [later]]);
  seen.length = 0;
  await runAgentsWorkspace(commandContext([]), failing);
  assert.deepEqual(seen, [["run:L", "run:L"]], "a failed list is not seeded: the workspace lists itself");
  assert.equal(failing.listed(), 3, "the check failed; the open listed twice itself");
});

void test("one loop at a time across bundles: a second one says the workspace is already opening or open and opens nothing", async () => {
  const calls: string[] = [];
  let leave = (): void => {};
  const { open, opens } = opener([() => new Promise((resolve) => { leave = () => { resolve(undefined); }; })], calls);
  const running = runAgentsWorkspace(commandContext([]), loopOf(open, [], calls));
  await settle();
  assert.equal(opens.length, 1);
  assert.equal("actions" in (opens[0] ?? {}), false, "without providers the workspace gets no actions");
  const notices: string[] = [];
  const second = opener([undefined]);
  const secondLoop = loopOf(second.open, [], []);
  await runAgentsWorkspace(commandContext(notices), secondLoop);
  assert.deepEqual(notices, ["The agents workspace is already opening or open."]);
  assert.equal(second.opens.length, 0);
  assert.equal(secondLoop.listed(), 0, "not even listed");
  leave();
  await running;

  // Another bundle's copy of this module holds the same key.
  Reflect.set(globalThis, LOOP_KEY, true);
  const other: string[] = [];
  try { await runAgentsWorkspace(commandContext(other), loopOf(second.open, [], [])); } finally { Reflect.deleteProperty(globalThis, LOOP_KEY); }
  assert.deepEqual(other, ["The agents workspace is already opening or open."]);
  assert.equal(second.opens.length, 0);

  // A loop that ends with a throw lets the next one run.
  const failing: OpenAgentsWorkspace = () => Promise.reject(new Error("boom"));
  const failed: string[] = [];
  const levels: string[] = [];
  const failingContext = { cwd: "/project", ui: { notify(message: string, level?: string) { failed.push(message); levels.push(String(level)); } } } as unknown as ExtensionCommandContext;
  await runAgentsWorkspace(failingContext, loopOf(failing, [], []));
  assert.deepEqual(failed, ["agents workspace failed: boom"], "a rejected opener is reported, not thrown");
  assert.deepEqual(levels, ["error"]);
  await runAgentsWorkspace(commandContext([]), loopOf(second.open, [], []));
  assert.equal(second.opens.length, 1);
});

void test("a shutdown during the listing opens nothing, and a failing open after it shows nothing on the stale context", async () => {
  const shutdown = new AbortController();
  const opened: string[] = [];
  const open: OpenAgentsWorkspace = () => { opened.push("open"); return Promise.reject(new Error("stale")); };
  const stale = { cwd: "/project", ui: { notify() { throw new Error("stale ctx"); } } } as unknown as ExtensionCommandContext;
  const base = loopOf(open, [], []);
  const loop = { ...base, options: { ...base.options, shutdown: shutdown.signal, agents: { list: async () => { shutdown.abort(); return [NODE]; } } } };
  await runAgentsWorkspace(stale, loop);
  assert.deepEqual(opened, []);
  const late = new AbortController();
  const failing: OpenAgentsWorkspace = () => { late.abort(); return Promise.reject(new Error("stale")); };
  await runAgentsWorkspace(stale, { ...base, open: failing, options: { ...base.options, shutdown: late.signal } });
});

void test("a shutdown, with the stale context's signal throwing when read, reads no signal: not with the exit, not after the action", async () => {
  const staleCtx = { cwd: "/project", get signal(): AbortSignal { throw new Error("stale ctx"); }, ui: { notify() {} } } as unknown as ExtensionCommandContext;
  const early = new AbortController();
  const earlyProvider = new FakeProvider(() => ["Resume"]);
  const earlyOpen = opener([async () => { early.abort(); return exitOf("Resume", earlyProvider); }]);
  const earlyLoop = loopOf(earlyOpen.open, [earlyProvider], []);
  await runAgentsWorkspace(staleCtx, { ...earlyLoop, options: { ...earlyLoop.options, shutdown: early.signal } });
  assert.deepEqual(earlyProvider.runs, [], "an exit that comes with the shutdown runs nothing");

  const late = new AbortController();
  const lateProvider = new FakeProvider(() => ["Resume"], async () => { late.abort(); return {}; });
  const open = opener([exitOf("Resume", lateProvider), exitOf("Resume", lateProvider)]);
  const lateLoop = loopOf(open.open, [lateProvider], []);
  const live = { cwd: "/project", ui: { notify() {} } } as unknown as ExtensionCommandContext;
  Object.defineProperty(live, "signal", { get() { if (late.signal.aborted) throw new Error("stale ctx"); return undefined; } });
  await runAgentsWorkspace(live, { ...lateLoop, options: { ...lateLoop.options, shutdown: late.signal } });
  assert.equal(open.opens.length, 1, "no reopen after the shutdown");
});

void test("a working message set while the workspace is closed is cleared in Pi when the workspace reopens, and later updates go to the workspace only", async () => {
  const calls: string[] = [];
  const owner = {};
  let ui: ActionUi | undefined;
  const provider = new FakeProvider(() => ["Run"], async (_label, given) => { ui = given; given.setWorkingMessage("queued", owner); return {}; });
  const actionUi: AgentsWorkspaceLoop["actionUi"] = () => ({ ...recordingUi(), setWorkingMessage(message) { calls.push(`pi:${String(message)}`); } });
  const exits = [exitOf("Run", provider), undefined];
  const open: OpenAgentsWorkspace = async (_ctx, options) => {
    calls.push("open");
    const release = options.detached?.({ working: (message) => { calls.push(`sink:${String(message)}`); }, notice() {} });
    if (calls.filter((call) => call === "open").length === 2) { ui?.setWorkingMessage("running", owner); ui?.setWorkingMessage(undefined, owner); }
    release?.();
    return exits.shift();
  };
  await runAgentsWorkspace(commandContext([]), loopOf(open, [provider], calls, { actionUi }));
  assert.deepEqual(calls, ["open", "sink:undefined", "pi:queued", "open", "pi:undefined", "sink:queued", "sink:running", "sink:undefined"]);
});
