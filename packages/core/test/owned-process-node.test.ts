import { registerOwnedProcessRuntime } from "./owned-process-fixture.js";

registerOwnedProcessRuntime({ name: "Node", executable: process.execPath });
