import type { TrajectoryPublisherInput } from "./trajectory.js";

export type TrajectoryPublisherProvider = (context: unknown) => TrajectoryPublisherInput;

export type TrajectoryHost = {
  open(provider: TrajectoryPublisherProvider, context: unknown): Promise<void>;
  autoAttach(provider: TrajectoryPublisherProvider, context: { hasUI: boolean }): void;
  close(): Promise<void>;
};

const TRAJECTORY_HOST_KEY = Symbol.for("pi-extensible-workflows.trajectory-host");
const globalTrajectoryHosts = globalThis as typeof globalThis & Record<symbol, TrajectoryHost | undefined>;

export function setTrajectoryHost(host: TrajectoryHost | undefined): void { globalTrajectoryHosts[TRAJECTORY_HOST_KEY] = host; }
export function getTrajectoryHost(): TrajectoryHost | undefined { return globalTrajectoryHosts[TRAJECTORY_HOST_KEY]; }
export function clearTrajectoryHost(host: TrajectoryHost): void { if (globalTrajectoryHosts[TRAJECTORY_HOST_KEY] === host) globalTrajectoryHosts[TRAJECTORY_HOST_KEY] = undefined; }
