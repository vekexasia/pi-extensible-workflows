import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { canonicalPath } from "./paths.js";
import { executeOwnedCommand } from "./owned-process.js";
import { WorkflowError, type LeaseCommandOptions } from "./types.js";
import { validateLeaseCommandOptions } from "./validation.js";
import { object } from "./utils.js";

// The generic client is embedded for source-loaded, bundled and packed runtimes.
const clientSource = String.raw`
"use strict";
const fs = require("node:fs");
const net = require("node:net");
const ticket = globalThis.__piLeaseTicket;
delete globalThis.__piLeaseTicket;
const socket = net.createConnection(ticket.socket);
let buffered = "", done = false;
const fail = () => { socket.destroy(); process.exitCode = 1; };
socket.on("connect", () => socket.write(JSON.stringify({id:ticket.id, secret:ticket.secret}) + "\n"));
socket.on("data", chunk => {
  buffered += chunk.toString("utf8");
  let end;
  while ((end = buffered.indexOf("\n")) >= 0) {
    const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
    if (line.length > 65536) { fail(); return; }
    let message;
    try { message = JSON.parse(line); } catch { fail(); return; }
    if (message.type === "stdout" || message.type === "stderr") process[message.type].write(Buffer.from(message.data, "base64"));
    else if (message.type === "result") { done = true; process.exitCode = Number.isInteger(message.exitCode) && message.exitCode >= 0 && message.exitCode <= 255 ? message.exitCode : 1; socket.end(); }
    else { fail(); return; }
  }
  if (buffered.length > 65536) fail();
});
socket.on("error", fail);
socket.on("close", () => { if (!done) process.exitCode = 1; });
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { socket.destroy(); process.exit(signal === "SIGTERM" ? 143 : 130); });
process.stdout.on("error", fail);
process.stderr.on("error", fail);
`;

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
type Ticket = { secret: string; command: string; options: LeaseCommandOptions; used: boolean; active: boolean; failed: boolean };
export class LeaseCommandBroker {
  #server: Server;
  #tickets = new Map<string, Ticket>();
  #sockets = new Set<Socket>();
  #open = true;
  #counter = 0;
  private constructor(readonly directory: string, private readonly cwd: string, private readonly signal: AbortSignal, private readonly execute: (work: () => Promise<number | null>) => Promise<number | null>, private readonly taint: (error: Error) => void) {
    this.#server = createServer((socket) => { this.#accept(socket); });
    this.#server.maxConnections = 32;
  }
  static async create(cwd: string, signal: AbortSignal, execute: (work: () => Promise<number | null>) => Promise<number | null>, taint: (error: Error) => void): Promise<LeaseCommandBroker> {
    // Deliberately bounded POSIX temp root, independent of long launch cwd/TMPDIR.
    const directory = canonicalPath(await mkdtemp("/tmp/pi-lt-"));
    const broker = new LeaseCommandBroker(directory, cwd, signal, execute, taint);
    try {
      await writeFile(join(directory, "client.cjs"), clientSource, { mode: 0o600 });
      await new Promise<void>((resolve, reject) => { broker.#server.once("error", reject); broker.#server.listen(join(directory, "s"), () => { broker.#server.removeListener("error", reject); resolve(); }); });
      return broker;
    } catch (error) { broker.#server.close(); await rm(directory, { recursive: true, force: true }); throw error; }
  }
  #assertOpen(): void { if (!this.#open || this.signal.aborted) throw new WorkflowError("WORKTREE_FAILED", "Lease command admission is closed"); }
  async ticket(command: string, rawOptions: LeaseCommandOptions): Promise<string> {
    const options = validateLeaseCommandOptions(rawOptions);
    this.#assertOpen();
    const id = String(++this.#counter);
    const secret = randomUUID();
    this.#tickets.set(id, { secret, command, options: structuredClone(options), used: false, active: false, failed: false });
    const file = join(this.directory, `ticket-${id}.json`);
    const material = JSON.stringify({ id, secret, socket: join(this.directory, "s") });
    await writeFile(file, material, { flag: "wx", mode: 0o600 });
    this.#assertOpen();
    const digest = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
    // Authenticate and execute the same buffers. Digests are in the host-returned launcher, not mutable ticket material.
    const launcher = `const fs=require("node:fs"),hash=b=>require("node:crypto").createHash("sha256").update(b).digest("hex");const client=fs.readFileSync(process.argv[1]),ticket=fs.readFileSync(process.argv[2]);if(hash(client)!==${JSON.stringify(digest(clientSource))}||hash(ticket)!==${JSON.stringify(digest(material))})throw Error("Lease client material changed");globalThis.__piLeaseTicket=JSON.parse(ticket);eval(client.toString("utf8"));`;
    return `exec ${process.versions.bun ? "env BUN_BE_BUN=1 " : ""}${quote(process.execPath)} -e ${quote(launcher)} ${quote(join(this.directory, "client.cjs"))} ${quote(file)}`;
  }
  closeAdmission(): void { this.#open = false; this.#server.close(); }
  async dispose(): Promise<void> {
    this.closeAdmission();
    for (const socket of this.#sockets) socket.destroy();
    await rm(this.directory, { recursive: true, force: true });
  }
  #accept(socket: Socket): void {
    if (!this.#open) { socket.destroy(); return; }
    this.#sockets.add(socket);
    socket.on("error", () => undefined);
    socket.once("close", () => { this.#sockets.delete(socket); });
    socket.setTimeout(1000, () => { socket.destroy(); });
    let header = "";
    const receive = (chunk: Buffer) => {
      header += chunk.toString("utf8");
      if (header.length > 4096) { socket.destroy(); return; }
      const end = header.indexOf("\n");
      if (end < 0) return;
      socket.removeListener("data", receive);
      let request: unknown;
      try { request = JSON.parse(header.slice(0, end)); } catch { socket.destroy(); return; }
      if (!this.#open || this.signal.aborted || !object(request) || Object.keys(request).sort().join(",") !== "id,secret" || typeof request.id !== "string") { socket.destroy(); return; }
      const ticket = this.#tickets.get(request.id);
      if (!ticket || ticket.active || ticket.failed || ticket.used && ticket.options.reuse !== "sequential" || request.secret !== ticket.secret || header.slice(end + 1).length > 0) { socket.destroy(); return; }
      ticket.used = true;
      ticket.active = true;
      const executionId = randomUUID();
      socket.setTimeout(0);
      const controller = new AbortController();
      const signal = AbortSignal.any([this.signal, controller.signal]);
      let completed = false;
      socket.once("close", () => {
        if (completed) return;
        ticket.failed = true;
        this.taint(new WorkflowError("SHELL_FAILED", "Lease command client disconnected"));
        controller.abort();
      });
      // No replacement command protocol exists after the fixed-binding private header.
      socket.on("data", () => { ticket.failed = true; this.taint(new WorkflowError("SHELL_FAILED", "Lease command protocol violation")); controller.abort(); });
      void this.execute(async () => {
        let bytes = 0;
        return executeOwnedCommand(ticket.command, ticket.options, signal, this.cwd, (target, chunk) => {
          bytes += chunk.byteLength;
          if (bytes > 10 * 1024 * 1024) throw new WorkflowError("RPC_LIMIT_EXCEEDED", "Lease command output exceeds the 10 MB boundary");
          for (let offset = 0; offset < chunk.length; offset += 16 * 1024) socket.write(`${JSON.stringify({ type: target, data: chunk.subarray(offset, offset + 16 * 1024).toString("base64") })}\n`);
        });
      }).then((exitCode) => {
        completed = true;
        ticket.active = false;
        if (exitCode === null) { ticket.failed = true; this.taint(new WorkflowError("SHELL_FAILED", "Lease command terminated by signal")); }
        if (!socket.destroyed) socket.end(`${JSON.stringify({ type: "result", exitCode, executionId })}\n`);
      }, (error: unknown) => {
        completed = true;
        ticket.active = false;
        ticket.failed = true;
        this.taint(error instanceof Error ? error : new WorkflowError("SHELL_FAILED", String(error)));
        if (!socket.destroyed) socket.end(`${JSON.stringify({ type: "result", exitCode: 1, executionId })}\n`);
      });
    };
    socket.on("data", receive);
  }
}
