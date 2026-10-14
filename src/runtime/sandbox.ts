import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { nanoid } from "nanoid";
import type { AnvilConfig } from "../core/config.js";
import { normalizeName, PackageGate, type GateDecision } from "./packageGate.js";

/**
 * The Python sandbox (docs/SANDBOX.md). Each agent run gets one Docker
 * container. The program of the agent runs in it with `docker exec`, and its
 * tool calls come back to the host on stdout, one JSON line each.
 */

export type SandboxConfig = AnvilConfig["sandbox"];

/** A tool call from a program. `parallel` holds the calls of tools.parallel(...). */
export interface SandboxCall {
  tool: string;
  args: Record<string, unknown>;
}

export interface SandboxCallRecord extends SandboxCall {
  ok: boolean;
  error?: string;
  durationMs: number;
}

/** One package install of a program, with the decisions of the package gate. */
export interface InstallRecord {
  packages: string[];
  ok: boolean;
  error?: string;
  decisions: GateDecision[];
  log: string;
  durationMs: number;
}

export interface SandboxExecResult {
  ok: boolean;
  result: unknown;
  stdout: string;
  error: string | null;
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
  calls: SandboxCallRecord[];
  installs: InstallRecord[];
  container: string;
}

export type CallHandler = (call: SandboxCall) => Promise<unknown>;

const LABEL = "anvil.sandbox";
/** The owner of a container: the process and the manager. Cleanup removes only containers whose owner is gone. */
const OWNER = "anvil.sandbox.owner";
/** The live managers of this process. It is on globalThis: a second copy of this module in the process (for example in a test runner) must see the same set. */
const liveManagers: Set<string> = ((globalThis as { __anvilSandboxLive?: Set<string> }).__anvilSandboxLive ??= new Set<string>());

/** The containers that this process started. When the process exits, they go away with it. */
const ownedContainers = new Set<string>();
let exitHook = false;
function track(name: string) {
  ownedContainers.add(name);
  if (!exitHook) {
    exitHook = true;
    process.once("exit", () => {
      if (ownedContainers.size) spawnSync("docker", ["rm", "-f", ...ownedContainers], { stdio: "ignore", timeout: 20_000 });
    });
  }
}
async function remove(names: string[]) {
  if (!names.length) return;
  await docker(["rm", "-f", ...names], undefined, 60_000);
  for (const n of names) ownedContainers.delete(n);
}

/** One package gate for each set of gate settings in a process. The managers of the process share it. */
const gates = new Map<string, { gate: PackageGate; port: Promise<number>; users: number; managers: Set<SandboxManager> }>();

function ownerAlive(owner: string): boolean {
  const [pid, id] = owner.split(":");
  if (Number(pid) === process.pid) return liveManagers.has(id);
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}
export const SANDBOX_NETWORK = "anvil-sandbox-net";
/** The name of the gate sidecar on the internal network. It has the port in it, so two gates can run on one machine. */
export const gateHost = (port: number) => `anvil-gate-${port}`;
/** A package spec: a name, optional extras, and an optional version rule. Nothing else reaches pip. */
const PACKAGE_SPEC = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}(\[[A-Za-z0-9,._-]{1,100}\])?((==|>=|<=|~=|!=|<|>)[A-Za-z0-9.*+!_-]{1,40})?$/;
export const MAX_PACKAGES = 10;

/** Runs a docker command and returns its output. */
export function docker(args: string[], input?: string, timeoutMs = 60_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(e) });
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    if (input !== undefined) p.stdin.end(input);
    else p.stdin.end();
  });
}

/** The docker run arguments of a sandbox container: the limits of docs/SANDBOX.md, section 2.2. */
export function containerArgs(cfg: SandboxConfig, name: string, owner = `${process.pid}:none`, gatePort = cfg.gatePort): string[] {
  const network = cfg.network === "open" ? "bridge" : SANDBOX_NETWORK;
  // The allowlist mode: direct HTTP of the program goes through the forward proxy of the sidecar.
  const proxy = `http://${gateHost(gatePort)}:3128`;
  const proxyEnv =
    cfg.network === "allowlist"
      ? ["-e", `HTTP_PROXY=${proxy}`, "-e", `HTTPS_PROXY=${proxy}`, "-e", `http_proxy=${proxy}`, "-e", `https_proxy=${proxy}`, "-e", `NO_PROXY=${gateHost(gatePort)}`, "-e", `no_proxy=${gateHost(gatePort)}`]
      : [];
  return [
    "run",
    "-d",
    "--name",
    name,
    "--label",
    `${LABEL}=1`,
    "--label",
    `${OWNER}=${owner}`,
    "--network",
    network,
    "--read-only",
    "--tmpfs",
    "/work:rw,exec,size=512m,mode=1777",
    "--tmpfs",
    "/tmp:rw,size=64m,mode=1777",
    "--memory",
    cfg.memory,
    "--memory-swap",
    cfg.memory,
    "--cpus",
    String(cfg.cpus),
    "--pids-limit",
    "128",
    // An init process collects the processes that a program leaves. Without it, dead processes fill the process limit.
    "--init",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--user",
    "10001:10001",
    // gVisor (docs/HOSTING.md): the program talks to a kernel in user space, not to the kernel of the server.
    ...(cfg.runtime ? ["--runtime", cfg.runtime] : []),
    "-e",
    `ANVIL_MAX_OUTPUT=${cfg.maxOutputBytes}`,
    ...proxyEnv,
    cfg.image,
    "sleep",
    "infinity",
  ];
}

/**
 * The reason of a blocked install, for the program. A requested exact version
 * comes first with its own reason. Other blocked versions are only counted.
 */
export function blockedSummary(packages: string[], decisions: GateDecision[]): string | null {
  const blocked = decisions.filter((d) => d.decision === "blocked");
  if (!blocked.length) return null;
  const parts: string[] = [];
  for (const project of [...new Set(blocked.map((d) => d.project))]) {
    const mine = blocked.filter((d) => d.project === project);
    const wanted = packages.map((p) => /^([^=<>!~\[]+)(?:\[[^\]]*\])?==(.+)$/.exec(p)).find((m) => m && normalizeName(m[1]) === project)?.[2];
    const exact = wanted ? mine.find((d) => d.version === wanted) : undefined;
    const general = mine.find((d) => !d.version);
    const versions = mine.filter((d) => d.version && d !== exact).length;
    if (exact) parts.push(`${project} ${exact.version}: ${exact.reason}`);
    else if (general) parts.push(`${project}: ${general.reason}`);
    if (versions) parts.push(`${project}: ${versions} ${exact ? "other " : ""}version(s) with a known vulnerability`);
  }
  return `The package gate blocked: ${parts.join("; ")}`;
}

export class SandboxManager {
  private pool: string[] = [];
  private byRun = new Map<string, string>();
  private filling: Promise<void> | null = null;
  private ready: Promise<{ available: boolean; reason?: string }> | null = null;
  private closed = false;
  private readonly owner = `${process.pid}:${nanoid(8)}`;
  private readonly gateKey: string;
  readonly gate: PackageGate;
  /** The port of the gate. It is the configured port, or a free port when another process has it. */
  private gatePort = 0;

  constructor(
    readonly cfg: SandboxConfig,
    opts: { cacheDir?: string; osvUrl?: string } = {},
  ) {
    liveManagers.add(this.owner.split(":")[1]);
    const gateOpts = {
      index: cfg.packageIndex,
      vulnCheck: cfg.vulnCheck,
      allow: cfg.packageAllow,
      deny: cfg.packageDeny,
      cacheDir: opts.cacheDir ?? path.join(os.tmpdir(), "anvil-package-cache"),
      osvUrl: opts.osvUrl,
    };
    this.gateKey = JSON.stringify(gateOpts);
    let shared = gates.get(this.gateKey);
    if (!shared) {
      const gate = new PackageGate(gateOpts);
      const managers = new Set<SandboxManager>();
      // The gate asks each manager of the process: the one that owns the client address decides.
      gate.egressHook = (client, host, port) => {
        for (const m of managers) {
          const d = m.egressFor(client, host, port);
          if (d) return d;
        }
        return { allowed: false, reason: "the address is not a sandbox of a run" };
      };
      shared = { gate, users: 0, managers, port: gate.listen(cfg.gatePort, cfg.gateBind).catch(() => gate.listen(0, cfg.gateBind)) };
      gates.set(this.gateKey, shared);
    }
    shared.users++;
    shared.managers.add(this);
    this.gate = shared.gate;
  }

  private ipToRun = new Map<string, string>();
  private egressRules = new Map<string, (host: string, port: number) => { allowed: boolean; reason?: string }>();

  /** Sets the egress rule of a run for the allowlist mode. The tool bridge sets it before a program runs. */
  setEgress(runId: string, rule: (host: string, port: number) => { allowed: boolean; reason?: string }) {
    this.egressRules.set(runId, rule);
  }

  /** The decision for a direct request of a sandbox client, or null when the client is not one of this manager. */
  egressFor(client: string, host: string, port: number): { allowed: boolean; reason?: string } | null {
    const runId = this.ipToRun.get(client);
    if (!runId) return null;
    const rule = this.egressRules.get(runId);
    return rule ? rule(host, port) : { allowed: false, reason: "this run has no egress rule" };
  }

  /** The name of the gate sidecar of this process on the internal network. */
  get sidecar() {
    return gateHost(this.gatePort);
  }

  /** Starts the package gate on the host and its sidecar on the internal network. */
  private async startGate(): Promise<void> {
    this.gatePort = await gates.get(this.gateKey)!.port;
    // The sidecar belongs to the shared gate of the process, not to one manager.
    liveManagers.add(`gate${this.gatePort}`);
    // Reuse a running sidecar only when it runs the current image.
    const running = await docker(["inspect", "-f", "{{.State.Running}} {{.Image}}", this.sidecar], undefined, 15_000);
    const image = await docker(["image", "inspect", "-f", "{{.Id}}", this.cfg.image], undefined, 15_000);
    if (running.stdout.trim() === `true ${image.stdout.trim()}`) return;
    await docker(["rm", "-f", this.sidecar], undefined, 30_000);
    const r = await docker(
      [
        "run",
        "-d",
        "--name",
        this.sidecar,
        "--label",
        `${LABEL}=1`,
        "--label",
        `${OWNER}=${process.pid}:gate${this.gatePort}`,
        "--network",
        // With a gate network (a hosted Anvil in a container), the sidecar has no route to the internet:
        // it reaches only Anvil and the sandboxes. The allowlist mode needs the bridge network.
        this.cfg.gateNetwork && this.cfg.network !== "allowlist" ? this.cfg.gateNetwork : "bridge",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--memory",
        "128m",
        "--pids-limit",
        "128",
        "--user",
        "10001:10001",
        ...(this.cfg.runtime ? ["--runtime", this.cfg.runtime] : []),
        // On Linux, host.docker.internal needs this mapping. Docker Desktop has it already.
        // With a gate network (Anvil in a container), the sidecar reaches Anvil on that network instead.
        ...(this.cfg.gateNetwork ? [] : ["--add-host", "host.docker.internal:host-gateway"]),
        "-e",
        `ANVIL_GATE_TARGET=http://${this.cfg.gateTargetHost}:${this.gatePort}`,
        this.cfg.image,
        "python",
        "/opt/anvil/gate_proxy.py",
      ],
      undefined,
      60_000,
    );
    if (r.code !== 0) throw new Error(`the package gate sidecar did not start: ${r.stderr.trim().slice(0, 300)}`);
    track(this.sidecar);
    await docker(["network", "connect", "--alias", this.sidecar, SANDBOX_NETWORK, this.sidecar], undefined, 30_000);
    if (this.cfg.gateNetwork && this.cfg.network === "allowlist") await docker(["network", "connect", this.cfg.gateNetwork, this.sidecar], undefined, 30_000);
  }

  /** The address of a container on the internal network: the gate knows the client by it. */
  private async addressOf(container: string): Promise<string> {
    const r = await docker(["inspect", "-f", `{{(index .NetworkSettings.Networks "${SANDBOX_NETWORK}").IPAddress}}`, container], undefined, 15_000);
    return r.stdout.trim();
  }

  /** Installs packages into /work/.packages of the container of a run, through the package gate. */
  async install(runId: string, packages: string[]): Promise<InstallRecord> {
    const started = Date.now();
    const fail = (error: string): InstallRecord => ({ packages, ok: false, error, decisions: [], log: "", durationMs: Date.now() - started });
    if (!packages.length) return fail("no package given");
    if (packages.length > MAX_PACKAGES) return fail(`at most ${MAX_PACKAGES} packages in one install`);
    const bad = packages.filter((p) => !PACKAGE_SPEC.test(p));
    if (bad.length) return fail(`not a valid package spec: ${bad.join(", ")}`);
    const container = await this.acquire(runId);
    const client = await this.addressOf(container);
    // The address of the sidecar, not its name: a gVisor container (docs/HOSTING.md) has no Docker DNS. /etc/hosts and IP addresses work.
    const host = (await this.addressOf(this.sidecar)) || this.sidecar;
    const r = await docker(
      [
        "exec",
        container,
        "pip",
        "install",
        "--target",
        "/work/.packages",
        "--only-binary",
        ":all:",
        "--index-url",
        `http://${host}:3141/simple`,
        "--trusted-host",
        host,
        "--no-input",
        "--progress-bar",
        "off",
        "--disable-pip-version-check",
        ...packages,
      ],
      undefined,
      180_000,
    );
    const decisions = client ? this.gate.decisionsFor(client, started) : [];
    const log = `${r.stdout}\n${r.stderr}`.trim().split("\n").slice(-15).join("\n");
    if (r.code === 0) return { packages, ok: true, decisions, log, durationMs: Date.now() - started };
    return {
      packages,
      ok: false,
      error: blockedSummary(packages, decisions) ?? `pip failed: ${log.split("\n").filter((l) => /error/i.test(l)).slice(-3).join(" ") || log.slice(-300)}`,
      decisions,
      log,
      durationMs: Date.now() - started,
    };
  }

  /** Checks Docker and the image, creates the network, and removes old containers. Runs one time. */
  status(): Promise<{ available: boolean; reason?: string }> {
    this.ready ??= (async () => {
      if (this.cfg.mode === "off") return { available: false, reason: "the sandbox is off (ANVIL_SANDBOX=off)" };
      const info = await docker(["version", "--format", "{{.Server.Version}}"], undefined, 15_000);
      if (info.code !== 0) return { available: false, reason: `Docker is not available: ${info.stderr.trim().slice(0, 200)}` };
      const image = await docker(["image", "inspect", this.cfg.image, "--format", "{{.Id}}"], undefined, 15_000);
      if (image.code !== 0) return { available: false, reason: `the image ${this.cfg.image} is not built. Run: npm run sandbox:build` };
      await this.cleanup();
      const net = await docker(["network", "inspect", SANDBOX_NETWORK], undefined, 15_000);
      // An internal network has no route to the internet.
      if (net.code !== 0) await docker(["network", "create", "--internal", "--label", `${LABEL}=1`, SANDBOX_NETWORK], undefined, 15_000);
      try {
        await this.startGate();
      } catch (e) {
        return { available: false, reason: `the package gate did not start: ${(e as Error).message}` };
      }
      return { available: true };
    })();
    return this.ready;
  }

  private async start(): Promise<string> {
    const name = `anvil-sbx-${nanoid(10).toLowerCase().replace(/[^a-z0-9]/g, "x")}`;
    const r = await docker(containerArgs(this.cfg, name, this.owner, this.gatePort), undefined, 60_000);
    if (r.code !== 0) throw new Error(`the sandbox container did not start: ${r.stderr.trim().slice(0, 300)}`);
    track(name);
    // In the open mode, the container also joins the internal network: packages still come through the gate.
    if (this.cfg.network === "open") await docker(["network", "connect", SANDBOX_NETWORK, name], undefined, 30_000);
    // A container that starts after close() must not stay.
    if (this.closed) {
      await remove([name]);
      throw new Error("the sandbox is closed");
    }
    return name;
  }

  /** Keeps `cfg.pool` containers ready, so a run does not wait for a start. */
  warm(): Promise<void> {
    this.filling ??= (async () => {
      try {
        if (!(await this.status()).available) return;
        while (!this.closed && this.pool.length < this.cfg.pool) this.pool.push(await this.start());
      } catch {
        /* the next acquire starts a container itself */
      } finally {
        this.filling = null;
      }
    })();
    return this.filling;
  }

  /** The container of a run. The first call takes one from the pool. */
  async acquire(runId: string): Promise<string> {
    const have = this.byRun.get(runId);
    if (have) return have;
    const st = await this.status();
    if (!st.available) throw new Error(`The Python sandbox is not available: ${st.reason}`);
    this.closed = false;
    const name = this.pool.shift() ?? (await this.start());
    this.byRun.set(runId, name);
    if (this.cfg.network === "allowlist") this.ipToRun.set(await this.addressOf(name), runId);
    void this.warm();
    return name;
  }

  /** Runs one program in the container of the run. Tool calls go to `onCall`. */
  async exec(runId: string, code: string, onCall: CallHandler, opts: { timeoutMs?: number; data?: Record<string, unknown> } = {}): Promise<SandboxExecResult> {
    const container = await this.acquire(runId);
    const timeoutMs = opts.timeoutMs ?? this.cfg.timeoutMs;
    const started = Date.now();
    const calls: SandboxCallRecord[] = [];
    const installs: InstallRecord[] = [];
    // `timeout` in the container stops the program, also when the host connection breaks.
    const p = spawn("docker", ["exec", "-i", container, "timeout", "-s", "KILL", String(Math.ceil(timeoutMs / 1000)), "python", "/opt/anvil/runner.py"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    p.stderr.on("data", (d) => (stderr += d));
    const hostTimer = setTimeout(() => p.kill("SIGKILL"), timeoutMs + 5_000);
    const write = (m: unknown) => {
      if (!p.stdin.destroyed) p.stdin.write(`${JSON.stringify(m)}\n`);
    };
    const runCall = async (c: SandboxCall): Promise<{ ok: boolean; value?: unknown; error?: string }> => {
      const t0 = Date.now();
      try {
        const value = await onCall(c);
        calls.push({ ...c, ok: true, durationMs: Date.now() - t0 });
        return { ok: true, value };
      } catch (e) {
        const error = (e as Error).message;
        calls.push({ ...c, ok: false, error, durationMs: Date.now() - t0 });
        return { ok: false, error };
      }
    };
    write({ code, data: opts.data ?? {} });

    type Done = { result?: unknown; stdout?: string; error?: string | null; truncated?: boolean };
    let done = null as Done | null;
    const lines = createInterface({ input: p.stdout });
    for await (const line of lines) {
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(line);
      } catch {
        continue; // not a protocol line
      }
      if (m.type === "call") {
        const r = await runCall({ tool: String(m.tool), args: (m.args as Record<string, unknown>) ?? {} });
        write({ id: m.id, ...r });
      } else if (m.type === "parallel") {
        const items = ((m.calls as SandboxCall[]) ?? []).map((c) => ({ tool: String(c.tool), args: c.args ?? {} }));
        const results = await Promise.all(items.map(runCall));
        // tools.parallel returns one entry for each call: the value, or {"error": ...}.
        write({ id: m.id, ok: true, value: results.map((r) => (r.ok ? r.value : { error: r.error })) });
      } else if (m.type === "install") {
        const rec = await this.install(runId, ((m.packages as unknown[]) ?? []).map(String));
        installs.push(rec);
        write(rec.ok ? { id: m.id, ok: true, value: { installed: rec.packages, decisions: rec.decisions.map((d) => `${d.project} ${d.version ?? ""} ${d.decision}: ${d.reason}`) } } : { id: m.id, ok: false, error: rec.error });
      } else if (m.type === "done") {
        done = m as Done;
        break;
      }
    }
    const exit = await new Promise<number>((resolve) => (p.exitCode !== null ? resolve(p.exitCode) : p.on("close", (c) => resolve(c ?? -1))));
    clearTimeout(hostTimer);
    const durationMs = Date.now() - started;
    if (!done) {
      // No done line: the program ran out of time, memory, or processes.
      const timedOut = exit === 137 || exit === 124 || durationMs >= timeoutMs;
      return {
        ok: false,
        result: null,
        stdout: "",
        error: timedOut ? `The program stopped: the time limit (${Math.round(timeoutMs / 1000)} s) or the memory limit was reached.` : `The program stopped (exit ${exit}). ${stderr.trim().slice(0, 500)}`,
        truncated: false,
        timedOut,
        durationMs,
        calls,
        installs,
        container,
      };
    }
    return {
      ok: !done.error,
      result: done.result ?? null,
      stdout: done.stdout ?? "",
      error: done.error ?? null,
      truncated: !!done.truncated,
      timedOut: false,
      durationMs,
      calls,
      installs,
      container,
    };
  }

  /** Removes the container of a run. */
  async release(runId: string): Promise<void> {
    const name = this.byRun.get(runId);
    this.egressRules.delete(runId);
    for (const [ip, r] of this.ipToRun) if (r === runId) this.ipToRun.delete(ip);
    if (!name) return;
    this.byRun.delete(runId);
    await remove([name]);
  }

  /** Removes the sandbox containers whose owner is gone (for example from a server that stopped). */
  async cleanup(): Promise<void> {
    const r = await docker(["ps", "-a", "--filter", `label=${LABEL}=1`, "--format", `{{.ID}} {{.Label "${OWNER}"}}`], undefined, 15_000);
    const dead = r.stdout
      .split("\n")
      .map((l) => l.trim().split(" "))
      .filter(([id, owner]) => id && !ownerAlive(owner ?? ""))
      .map(([id]) => id);
    if (dead.length) await docker(["rm", "-f", ...dead], undefined, 60_000);
  }

  /** Removes the pool and the containers of all runs. A later acquire opens the sandbox again. */
  async close(): Promise<void> {
    this.closed = true;
    await this.filling?.catch(() => undefined);
    const names = [...this.pool, ...this.byRun.values()];
    this.pool = [];
    this.byRun.clear();
    await remove(names);
  }

  /** Closes the sandbox for good: a later cleanup of another manager can remove its containers. */
  async dispose(): Promise<void> {
    await this.close();
    const shared = gates.get(this.gateKey);
    shared?.managers.delete(this);
    if (shared && --shared.users <= 0) {
      if (this.gatePort) await remove([this.sidecar]);
      await this.gate.close();
      gates.delete(this.gateKey);
      liveManagers.delete(`gate${this.gatePort}`);
    }
    this.ready = null;
    liveManagers.delete(this.owner.split(":")[1]);
  }
}
