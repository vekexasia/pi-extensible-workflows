import assert from "node:assert/strict";
import test from "node:test";
import type { PersistedRun, RunStore } from "../src/persistence.js";
import { ForegroundDeliveryController } from "../src/host-delivery.js";

type FakeRun = {
  id: string;
  state: "running" | "completed" | "failed";
  delivery?: { mode: "foreground" | "background"; state: "attached" | "pending" | "delivered"; toolCallId?: string };
};

type FakeStore = {
  runId: string;
  updateState(update: (run: FakeRun) => FakeRun | Promise<FakeRun>): Promise<FakeRun>;
  load(): Promise<{ run: FakeRun }>;
};

type Delivery = {
  store: RunStore;
  detached: boolean;
  detach: () => Promise<{ runId: string; state: "running"; detached: true; run: PersistedRun }>;
};

const waitForTurn = async (): Promise<void> => { await new Promise<void>((resolve) => setImmediate(resolve)); };

function storeFor(runId: string, state: FakeRun["state"] = "running", delivery: FakeRun["delivery"] = { mode: "foreground", state: "attached", toolCallId: runId }): { store: RunStore; run: FakeRun } {
  let run: FakeRun = { id: runId, state, delivery };
  const fake: FakeStore = {
    runId,
    async updateState(update) { run = await update(run); return run; },
    async load() { return { run }; },
  };
  return { store: fake as unknown as RunStore, run };
}

function controllerFor(store: RunStore, delivered: string[]): ForegroundDeliveryController {
  const runs = new Map<string, { store: RunStore }>([[store.runId, { store }]]);
  return new ForegroundDeliveryController({ runs, deliver: (content: string) => { delivered.push(content); } });
}

function attach(controller: ForegroundDeliveryController, toolCallId: string, store: RunStore, overrides: Partial<Omit<Delivery, "store">> = {}): Delivery {
  const delivery: Delivery = {
    store,
    detached: false,
    detach: async () => ({ runId: store.runId, state: "running", detached: true, run: (await store.load()).run }),
    ...overrides,
  };
  controller.foregroundDeliveries.set(toolCallId, delivery);
  return delivery;
}


void test("true foreground detach uses background delivery exactly once", async () => {
  const { store } = storeFor("detached");
  const delivered: string[] = [];
  const controller = controllerFor(store, delivered);
  const delivery = attach(controller, "detached", store);
  delivery.detach = async () => {
    await store.updateState((current) => ({ ...current, delivery: { mode: "background", state: "pending", toolCallId: "detached" } }));
    delivery.detached = true;
    return { runId: "detached", state: "running", detached: true, run: (await store.load()).run };
  };

  await controller.moveForegroundToBackground("detached");
  await controller.deliverDetachedTerminal("detached", "background result");

  assert.deepEqual(delivered, ["background result"]);
  assert.equal(controller.foregroundDeliveries.has("detached"), false);
  assert.deepEqual((await store.load()).run.delivery, { mode: "background", state: "delivered", toolCallId: "detached" });
});

void test("failure delivery clears pending diagnostics and preserves failure content", async () => {
  const { store } = storeFor("failure", "failed", { mode: "background", state: "pending", toolCallId: "failure" });
  const delivered: string[] = [];
  const controller = controllerFor(store, delivered);
  attach(controller, "failure", store, { detached: true });
  (controller.pendingFailureDiagnostics as unknown as Map<string, unknown>).set("failure", { store, diagnostic: { runId: "failure" } });

  await controller.deliverDetachedTerminal("failure", "failure diagnostics", true);

  assert.deepEqual(delivered, ["failure diagnostics"]);
  assert.equal((controller.pendingFailureDiagnostics as unknown as Map<string, unknown>).has("failure"), false);
});

void test("a foreground resume claim suppresses the stale terminal delivery once", async () => {
  const { store } = storeFor("resume");
  const delivered: string[] = [];
  const controller = controllerFor(store, delivered);
  attach(controller, "resume", store);
  controller.foregroundResumeClaims.add(store);

  await controller.deliverTerminal(store, "stale completion");
  assert.deepEqual(delivered, []);
  assert.equal(controller.foregroundResumeClaims.has(store), false);
  assert.deepEqual((await store.load()).run.delivery, { mode: "foreground", state: "attached", toolCallId: "resume" });

  await controller.deliverTerminal(store, "resumed completion");
  assert.deepEqual(delivered, ["resumed completion"]);
});

void test("recorded-delivered foreground completion is not redelivered during recovery", async () => {
  const { store } = storeFor("recovered", "completed", { mode: "foreground", state: "delivered", toolCallId: "recovered" });
  const delivered: string[] = [];
  const controller = controllerFor(store, delivered);

  await controller.deliverTerminal(store, "recovered completion");

  assert.deepEqual(delivered, []);
  assert.deepEqual((await store.load()).run.delivery, { mode: "foreground", state: "delivered", toolCallId: "recovered" });
});

void test("foreground candidates and detach state track only attached runs", async () => {
  const { store: attachedStore } = storeFor("attached");
  const delivered: string[] = [];
  const runs = new Map<string, { store: RunStore }>([[attachedStore.runId, { store: attachedStore }]]);
  const controller = new ForegroundDeliveryController({ runs, deliver: (content: string) => { delivered.push(content); } });
  const attached = attach(controller, "attached", attachedStore);

  assert.equal(controller.isForegroundAttached("attached"), true);
  assert.equal(controller.foregroundDeliveryCandidates("attached").length, 1);
  attached.detach = async () => {
    await attachedStore.updateState((current) => ({ ...current, delivery: { mode: "background", state: "pending" } }));
    attached.detached = true;
    return { runId: "attached", state: "running", detached: true, run: (await attachedStore.load()).run };
  };
  const result = await controller.moveForegroundToBackground("attached");

  assert.deepEqual(result, { runId: "attached", state: "running", detached: true, run: (await attachedStore.load()).run });
  assert.equal(controller.isForegroundAttached("attached"), false);
});

void test("terminal deliveries for one store are serialized and only the first claim sends", async () => {
  const { store } = storeFor("lane");
  const delivered: string[] = [];
  const controller = controllerFor(store, delivered);
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const first = controller.deliverTerminal(store, async () => { await hold; return "first"; });
  const second = controller.deliverTerminal(store, "second");

  await waitForTurn();
  assert.deepEqual(delivered, []);
  release();
  await Promise.all([first, second]);

  assert.deepEqual(delivered, ["first"]);
});

void test("terminal claim and detach race has exactly one winner", async () => {
  for (const detachFirst of [false, true]) {
    const { store } = storeFor(`race-${String(detachFirst)}`);
    const delivered: string[] = [];
    const controller = controllerFor(store, delivered);
    const delivery = attach(controller, store.runId, store);
    delivery.detach = async () => {
      let moved: boolean | undefined;
      await store.updateState((current) => {
        if (current.delivery?.mode !== "foreground" || current.delivery.state !== "attached") return current;
        moved = true;
        return { ...current, delivery: { mode: "background", state: "pending", toolCallId: store.runId } };
      });
      if (moved !== true) throw new Error("already claimed");
      delivery.detached = true;
      return { runId: store.runId, state: "running", detached: true, run: (await store.load()).run };
    };
    const claim = async (): Promise<"inline" | "detached"> => (await controller.claimForegroundDelivery(store, store.runId)) === "claimed" ? "inline" : "detached";
    const deliverDetached = async (): Promise<"follow-up" | "lost"> => { try { await controller.moveForegroundToBackground(store.runId); await controller.deliverDetachedTerminal(store.runId, "detached result"); return "follow-up"; } catch { return "lost"; } };
    let inline: Promise<"inline" | "detached">;
    let detached: Promise<"follow-up" | "lost">;
    if (detachFirst) {
      detached = deliverDetached();
      inline = Promise.resolve().then(claim);
    } else {
      inline = claim();
      detached = Promise.resolve().then(deliverDetached);
    }
    const [inlineResult, detachedResult] = await Promise.all([inline, detached]);
    assert.equal(inlineResult, detachFirst ? "detached" : "inline");
    assert.equal(detachedResult, detachFirst ? "follow-up" : "lost");
    assert.equal(delivered.length, detachFirst ? 1 : 0);
  }
});
