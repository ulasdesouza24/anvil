import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The Docker guard of a hosted Anvil (docs/HOSTING.md). Anvil starts the containers of the Python sandbox
 * through the Docker API. The Docker socket gives root on the server, so Anvil never gets it: Anvil gets
 * a socket of this guard, and the guard alone has the real socket. The guard allows only the calls of the
 * sandbox, and only with the hardened settings:
 *  - a container of the sandbox image, with the sandbox label, a non-root user, no capabilities,
 *    no-new-privileges, a read-only root, memory and process limits, the gVisor runtime, no host mounts,
 *    no devices, no published ports, and only the sandbox networks;
 *  - start, stop, exec, inspect, and remove only for containers with the sandbox label;
 *  - an exec without privileges and not as root;
 *  - at most a fixed number of sandbox containers on the server.
 * Each other call (images, volumes, other containers, the host) gets 403.
 */

export interface GuardPolicy {
  /** The only image that a container can use. */
  image: string;
  /** The label that each sandbox container has (value "1"). */
  label: string;
  /** The networks that a sandbox container can join. */
  networks: string[];
  /** The network that the guard may create (internal only). */
  createNetwork: string;
  /** The container runtime that each container must use ("runsc"). Empty: any runtime. */
  runtime: string;
  /** The most sandbox containers on the server at one time. */
  maxContainers: number;
  /** The most memory of one container, in bytes. */
  maxMemoryBytes: number;
  /** The most processes of one container. */
  maxPids: number;
}

export type Decision = { ok: true; check?: "container" | "exec" | "create" | "connect" } | { ok: false; reason: string };

const deny = (reason: string): Decision => ({ ok: false, reason });
const ROOT_USERS = new Set(["", "0", "root", "0:0", "root:root"]);
const HOSTISH = (v: unknown) => typeof v === "string" && (v === "host" || v.startsWith("container:"));
const TMPFS_PATHS = new Set(["/work", "/tmp"]);

/** The path of a Docker API call without the version prefix (/v1.47/containers/json → /containers/json). */
export function apiPath(rawPath: string): { path: string; query: URLSearchParams } {
  const u = new URL(rawPath, "http://docker");
  return { path: decodeURIComponent(u.pathname.replace(/^\/v\d+\.\d+(?=\/)/, "")), query: u.searchParams };
}

/** The first check of a call: the method and the path. Some calls need a second check (the container, the exec, or the body). */
export function route(method: string, rawPath: string, policy: GuardPolicy): Decision {
  const { path: p, query } = apiPath(rawPath);
  const m = method.toUpperCase();
  if ((m === "GET" || m === "HEAD") && (p === "/_ping" || p === "/version")) return { ok: true };
  if (m === "GET" && p === `/images/${policy.image}/json`) return { ok: true };
  if (m === "GET" && p === "/containers/json") {
    // A list without the sandbox label would show the other containers of the server.
    return (query.get("filters") ?? "").includes(policy.label) ? { ok: true } : deny("list only the sandbox containers (filter by the sandbox label)");
  }
  if (m === "POST" && p === "/containers/create") return { ok: true, check: "create" };
  let r = /^\/containers\/([^/]+)(\/(json|start|stop|kill|wait|exec|logs))?$/.exec(p);
  if (r) {
    const action = r[3] ?? "";
    const allowed =
      (m === "GET" && (action === "json" || action === "logs")) ||
      (m === "POST" && ["start", "stop", "kill", "wait", "exec"].includes(action)) ||
      (m === "DELETE" && action === "");
    return allowed ? { ok: true, check: "container" } : deny(`${m} ${p} is not a sandbox call`);
  }
  r = /^\/exec\/([^/]+)\/(start|resize|json)$/.exec(p);
  if (r) return (m === "POST" && r[2] !== "json") || (m === "GET" && r[2] === "json") ? { ok: true, check: "exec" } : deny(`${m} ${p} is not a sandbox call`);
  r = /^\/networks\/([^/]+)(\/connect)?$/.exec(p);
  if (r && r[1] !== "create") {
    if (!policy.networks.includes(r[1])) return deny(`the network ${r[1]} is not a sandbox network`);
    if (m === "GET" && !r[2]) return { ok: true };
    if (m === "POST" && r[2]) return { ok: true, check: "connect" };
  }
  if (m === "POST" && p === "/networks/create") return { ok: true, check: "create" };
  return deny(`${m} ${p} is not a sandbox call`);
}

/** The second check of a container create: each setting of the hardened sandbox. */
export function checkContainerCreate(body: Record<string, any>, policy: GuardPolicy): Decision {
  const hc = (body.HostConfig ?? {}) as Record<string, any>;
  if (body.Image !== policy.image) return deny(`only the image ${policy.image}`);
  if (body.Labels?.[policy.label] !== "1") return deny(`the container needs the label ${policy.label}=1`);
  if (ROOT_USERS.has(String(body.User ?? ""))) return deny("the container must run as a non-root user");
  if (hc.Privileged) return deny("no privileged container");
  for (const k of ["Binds", "Mounts", "Devices", "VolumesFrom", "CapAdd", "Sysctls", "ExtraHosts", "DeviceRequests", "DeviceCgroupRules", "Links", "Dns", "DnsOptions"])
    if (hc[k] && (Array.isArray(hc[k]) ? hc[k].length : Object.keys(hc[k]).length)) return deny(`no ${k}`);
  if (body.Volumes && Object.keys(body.Volumes).length) return deny("no volumes");
  if (hc.PortBindings && Object.keys(hc.PortBindings).length) return deny("no published ports");
  if (hc.PublishAllPorts) return deny("no published ports");
  if (!(hc.CapDrop ?? []).map((c: string) => c.toUpperCase()).includes("ALL")) return deny("drop all capabilities (--cap-drop ALL)");
  if (!(hc.SecurityOpt ?? []).some((o: string) => /^no-new-privileges(:true|=true)?$/.test(o))) return deny("set no-new-privileges");
  if ((hc.SecurityOpt ?? []).some((o: string) => /unconfined|apparmor|label|seccomp/i.test(o))) return deny("no changes to the security profile");
  if (!hc.ReadonlyRootfs) return deny("the root file system must be read-only");
  for (const k of ["PidMode", "IpcMode", "UTSMode", "UsernsMode", "CgroupnsMode", "NetworkMode"]) if (HOSTISH(hc[k])) return deny(`no ${k} ${hc[k]}`);
  if (!policy.networks.includes(hc.NetworkMode)) return deny(`only the networks ${policy.networks.join(", ")}`);
  for (const n of Object.keys(body.NetworkingConfig?.EndpointsConfig ?? {})) if (!policy.networks.includes(n)) return deny(`the network ${n} is not a sandbox network`);
  if (policy.runtime && hc.Runtime !== policy.runtime) return deny(`the container must use the runtime ${policy.runtime}`);
  if (!(hc.Memory > 0) || hc.Memory > policy.maxMemoryBytes) return deny(`set a memory limit of at most ${policy.maxMemoryBytes} bytes`);
  if (!(hc.PidsLimit > 0) || hc.PidsLimit > policy.maxPids) return deny(`set a process limit of at most ${policy.maxPids}`);
  if (hc.OomKillDisable) return deny("the OOM killer stays on");
  if (hc.CgroupParent) return deny("no cgroup parent");
  for (const p of Object.keys(hc.Tmpfs ?? {})) if (!TMPFS_PATHS.has(p)) return deny(`no tmpfs at ${p}`);
  return { ok: true };
}

/** The second check of a network create: only the internal sandbox network. */
export function checkNetworkCreate(body: Record<string, any>, policy: GuardPolicy): Decision {
  if (body.Name !== policy.createNetwork) return deny(`only the network ${policy.createNetwork}`);
  if (body.Internal !== true) return deny("the sandbox network must be internal (no route to the internet)");
  if (body.Driver && body.Driver !== "bridge") return deny("only a bridge network");
  return { ok: true };
}

/** The second check of an exec create: no privileges, not as root. */
export function checkExecCreate(body: Record<string, any>): Decision {
  if (body.Privileged) return deny("no privileged exec");
  if (body.User && ROOT_USERS.has(String(body.User))) return deny("no exec as root");
  return { ok: true };
}

/* ------------------------------- the proxy ------------------------------- */

interface Request {
  method: string;
  path: string;
  headers: [string, string][];
  body: Buffer;
  /** Bytes after the request (the stream of a hijacked exec). */
  rest: Buffer;
}

/** Reads one HTTP request from a socket: the head, and a body with Content-Length or chunked encoding. */
function readRequest(sock: net.Socket, maxBody = 1_000_000): Promise<Request> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const fail = (e: Error) => {
      sock.off("data", onData);
      reject(e);
    };
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) {
        if (buf.length > 64 * 1024) fail(new Error("request head too large"));
        return;
      }
      const lines = buf.subarray(0, end).toString("latin1").split("\r\n");
      const [method, p] = lines[0].split(" ");
      const headers = lines.slice(1).map((l) => {
        const i = l.indexOf(":");
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()] as [string, string];
      });
      const get = (h: string) => headers.find(([k]) => k.toLowerCase() === h)?.[1];
      let rest = buf.subarray(end + 4);
      let body = Buffer.alloc(0);
      const len = Number(get("content-length") ?? 0);
      if (/chunked/i.test(get("transfer-encoding") ?? "")) {
        // Decode the chunks: the check needs the whole JSON body.
        let pos = 0;
        const parts: Buffer[] = [];
        for (;;) {
          const nl = rest.indexOf("\r\n", pos);
          if (nl < 0) return;
          const size = parseInt(rest.subarray(pos, nl).toString(), 16);
          if (Number.isNaN(size)) return fail(new Error("bad chunk"));
          if (rest.length < nl + 2 + size + 2) return;
          if (size === 0) {
            rest = rest.subarray(nl + 4);
            break;
          }
          parts.push(rest.subarray(nl + 2, nl + 2 + size));
          pos = nl + 2 + size + 2;
        }
        body = Buffer.concat(parts);
      } else if (len > 0) {
        if (len > maxBody) return fail(new Error("request body too large"));
        if (rest.length < len) return;
        body = rest.subarray(0, len);
        rest = rest.subarray(len);
      }
      sock.off("data", onData);
      sock.pause();
      resolve({ method, path: p, headers: headers.filter(([k]) => !/^(content-length|transfer-encoding|connection)$/i.test(k)), body, rest });
    };
    sock.on("data", onData);
    sock.once("error", fail);
  });
}

/** One call to the real Docker API (for the checks of the guard). */
function upstreamJson(socketPath: string, method: string, p: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method, path: p, timeout: 15_000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let body: unknown = text;
        try {
          body = JSON.parse(text);
        } catch {
          /* not JSON */
        }
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Docker did not answer")));
    req.end();
  });
}

export interface GuardOptions {
  listen: string;
  upstream: string;
  policy: GuardPolicy;
  log?: (m: string) => void;
}

/** Starts the guard on a unix socket. Gives the server, so a test can close it. */
export function startDockerGuard(opts: GuardOptions): net.Server {
  const { policy, upstream } = opts;
  const log = opts.log ?? ((m: string) => console.log(m));

  const isSandboxContainer = async (id: string): Promise<boolean> => {
    const r = await upstreamJson(upstream, "GET", `/containers/${encodeURIComponent(id)}/json`);
    return r.status === 200 && r.body?.Config?.Labels?.[policy.label] === "1";
  };

  const second = async (req: Request, d: Extract<Decision, { ok: true }>): Promise<Decision> => {
    const { path: p } = apiPath(req.path);
    let body: Record<string, any> = {};
    if (req.body.length) {
      try {
        body = JSON.parse(req.body.toString("utf8"));
      } catch {
        return deny("the body is not JSON");
      }
    }
    if (d.check === "create" && p === "/networks/create") return checkNetworkCreate(body, policy);
    if (d.check === "create") {
      const c = checkContainerCreate(body, policy);
      if (!c.ok) return c;
      const list = await upstreamJson(upstream, "GET", `/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify({ label: [`${policy.label}=1`] }))}`);
      if (Array.isArray(list.body) && list.body.length >= policy.maxContainers)
        return deny(`the server runs the most sandboxes now (${policy.maxContainers}). Try again in a minute.`);
      return c;
    }
    if (d.check === "container") {
      const id = /^\/containers\/([^/]+)/.exec(p)![1];
      if (!(await isSandboxContainer(id))) return deny(`${id} is not a sandbox container`);
      if (/\/exec$/.test(p)) return checkExecCreate(body);
      return { ok: true };
    }
    if (d.check === "exec") {
      const id = /^\/exec\/([^/]+)/.exec(p)![1];
      const r = await upstreamJson(upstream, "GET", `/exec/${encodeURIComponent(id)}/json`);
      if (r.status !== 200) return deny("no such exec");
      const pc = r.body?.ProcessConfig ?? {};
      // An empty user is the user of the container (non-root).
      if (pc.privileged || (pc.user && ROOT_USERS.has(String(pc.user)))) return deny("no privileged or root exec");
      return (await isSandboxContainer(r.body?.ContainerID)) ? { ok: true } : deny("the exec is not in a sandbox container");
    }
    if (d.check === "connect") return (await isSandboxContainer(String(body.Container ?? ""))) ? { ok: true } : deny("only a sandbox container can join a sandbox network");
    return { ok: true };
  };

  const refuse = (sock: net.Socket, status: number, message: string) => {
    const payload = JSON.stringify({ message: `anvil docker guard: ${message}` });
    sock.end(`HTTP/1.1 ${status} Forbidden\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\nConnection: close\r\n\r\n${payload}`);
  };

  const server = net.createServer(async (client) => {
    client.on("error", () => undefined);
    let req: Request;
    try {
      req = await readRequest(client);
    } catch (e) {
      return refuse(client, 400, (e as Error).message);
    }
    let d = route(req.method, req.path, policy);
    if (d.ok && d.check) d = await second(req, d).catch((e) => deny(`check failed: ${(e as Error).message}`));
    if (!d.ok) {
      log(`[docker-guard] denied ${req.method} ${apiPath(req.path).path}: ${d.reason}`);
      return refuse(client, 403, d.reason);
    }
    const upgrade = req.headers.some(([k, v]) => k.toLowerCase() === "upgrade" || (k.toLowerCase() === "connection" && /upgrade/i.test(v)));
    const up = net.connect(upstream);
    up.on("error", () => client.destroy());
    client.on("close", () => up.destroy());
    up.on("close", () => client.destroy());
    // One request for each connection: Docker closes it after the answer, so a second request cannot pass the check.
    const head = [
      `${req.method} ${req.path} HTTP/1.1`,
      ...req.headers.map(([k, v]) => `${k}: ${v}`),
      ...(req.body.length ? [`Content-Length: ${req.body.length}`] : []),
      upgrade ? "Connection: Upgrade" : "Connection: close",
      "",
      "",
    ].join("\r\n");
    up.write(head);
    if (req.body.length) up.write(req.body);
    // Only the stream of a hijacked exec continues after the request.
    if (upgrade && req.rest.length) up.write(req.rest);
    up.pipe(client);
    if (upgrade) client.pipe(up);
    client.resume();
  });

  fs.mkdirSync(path.dirname(opts.listen), { recursive: true });
  fs.rmSync(opts.listen, { force: true });
  server.listen(opts.listen, () => {
    // Anvil runs as another user: it needs to write to the socket. Only containers that mount it can reach it.
    fs.chmodSync(opts.listen, 0o666);
    log(`[docker-guard] ${opts.listen} → ${upstream} (image ${policy.image}, runtime ${policy.runtime || "default"}, at most ${policy.maxContainers} containers)`);
  });
  return server;
}

/** The policy from the environment of the guard container. */
export function policyFromEnv(env = process.env): GuardPolicy {
  return {
    image: env.ANVIL_GUARD_IMAGE || "anvil-sandbox:py312",
    label: "anvil.sandbox",
    networks: (env.ANVIL_GUARD_NETWORKS || "anvil-sandbox-net")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
    createNetwork: env.ANVIL_GUARD_CREATE_NETWORK || "anvil-sandbox-net",
    runtime: env.ANVIL_GUARD_RUNTIME ?? "runsc",
    maxContainers: Number(env.ANVIL_GUARD_MAX_CONTAINERS || 8),
    maxMemoryBytes: Number(env.ANVIL_GUARD_MAX_MEMORY_BYTES || 1024 * 1024 * 1024),
    maxPids: Number(env.ANVIL_GUARD_MAX_PIDS || 256),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  startDockerGuard({
    listen: process.env.ANVIL_GUARD_LISTEN || "/run/anvil-docker/docker.sock",
    upstream: process.env.ANVIL_GUARD_UPSTREAM || "/var/run/docker.sock",
    policy: policyFromEnv(),
  });
}
