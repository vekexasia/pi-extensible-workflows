import type { LiveSessionHandoff, WorkflowAgentSessionEvent } from "./types.js";
import { isTurnActivityStart, isTurnBoundaryEnd } from "./pi-runtime-adapter.js";

export function createLiveSessionHandoff(): LiveSessionHandoff {
  let state: LiveSessionHandoff["state"] = "local-running";
  let turnActive = false;
  let boundary: Promise<void> | undefined;
  let resolveBoundary: (() => void) | undefined;
  let takeover: Promise<void> | undefined;
  let resolveTakeover: (() => void) | undefined;
  let takenOver = false;
  let resume: Promise<void> | undefined;
  let resolveResume: (() => void) | undefined;
  let request: Promise<void> | undefined;

  const waitForBoundary = (): Promise<void> => {
    if (!turnActive) return Promise.resolve();
    boundary ??= new Promise<void>((resolve) => { resolveBoundary = resolve; });
    return boundary;
  };
  const finishBoundary = () => {
    turnActive = false;
    resolveBoundary?.();
    boundary = undefined;
    resolveBoundary = undefined;
  };
  const finishTakeover = () => {
    takenOver = true;
    state = "herdr-running";
    resolveTakeover?.();
    resolveTakeover = undefined;
  };
  const isReleased = (): boolean => state === "completed";

  return {
    get state() { return state; },
    get transferred() { return takenOver; },
    observe(event: WorkflowAgentSessionEvent) {
      if (isTurnActivityStart(event.type)) turnActive = true;
      if (isTurnBoundaryEnd(event.type)) finishBoundary();
    },
    async request(launch: () => Promise<void>): Promise<void> {
      if (request) return request;
      if (isReleased()) return;
      state = "handoff-pending";
      takeover = new Promise<void>((resolve) => { resolveTakeover = resolve; });
      resume = new Promise<void>((resolve) => { resolveResume = resolve; });
      request = (async () => {
        await waitForBoundary();
        if (isReleased()) return;
        state = "herdr-running";
        try {
          await launch();
        } finally {
          if (!takenOver) {
            state = "returning-local";
            resolveTakeover?.();
            resolveTakeover = undefined;
          }
          resolveResume?.();
          state = "completed";
        }
      })();
      return request;
    },
    waitForTakeover() { return takeover ?? Promise.resolve(); },
    takeover() { if (state === "herdr-running" && !takenOver) finishTakeover(); },
    waitForResume() { return resume ?? Promise.resolve(); },
    release() {
      state = "completed";
      finishBoundary();
      resolveTakeover?.();
      resolveTakeover = undefined;
      resolveResume?.();
      resolveResume = undefined;
    },
  };
}
