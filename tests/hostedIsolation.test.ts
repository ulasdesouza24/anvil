import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { containerArgs } from "../src/runtime/sandbox.js";
import { checkContainerCreate, checkExecCreate, checkNetworkCreate, route, startDockerGuard, type GuardPolicy } from "../src/runtime/dockerGuard.js";
import { startEgressProxy } from "../src/runtime/egressProxy.js";
import { loadConfig } from "../src/core/config.js";
import { tmpDir } from "./helpers.js";

const policy: GuardPolicy = {
  image: "anvil-sandbox:py312",
  label: "anvil.sandbox",
  networks: ["anvil-sandbox-net", "anvil-gate-net"],
  createNetwork: "anvil-sandbox-net",
  runtime: "runsc",
  maxContainers: 2,
  maxMemoryBytes: 1024 * 1024 * 1024,
  maxPids: 256,
};

/** The create body that the Docker CLI sends for the sandbox arguments of Anvil. */
const sandboxBody = () => ({
  Image: "anvil-sandbox:py312",
  User: "10001:10001",
  Labels: { "anvil.sandbox": "1", "anvil.sandbox.owner": "1:x" },
  HostConfig: {
    NetworkMode: "anvil-sandbox-net",
    ReadonlyRootfs: true,
    Tmpfs: { "/work": "rw,exec,size=512m", "/tmp": "rw,size=64m" },
    Memory: 512 * 1024 * 1024,
    PidsLimit: 128,
    CapDrop: ["ALL"],
    SecurityOpt: ["no-new-privileges"],
    Runtime: "runsc",
    Init: true,
  },
});

describe("docker guard: the rules", () => {
  it("allows only the calls of the sandbox", () => {
    expect(route("GET", "/v1.47/_ping", policy).ok).toBe(true);
    expect(route("GET", "/v1.47/images/anvil-sandbox:py312/json", policy).ok).toBe(true);
    expect(route("GET", "/v1.47/images/ubuntu/json", policy).ok).toBe(false);
    expect(route("POST", "/v1.47/images/create?fromImage=alpine", policy).ok).toBe(false);
    expect(route("GET", "/v1.47/containers/json?all=1", policy).ok).toBe(false);
    expect(route("GET", `/v1.47/containers/json?filters=${encodeURIComponent('{"label":["anvil.sandbox=1"]}')}`, policy).ok).toBe(true);
    expect(route("POST", "/v1.47/containers/abc/start", policy)).toEqual({ ok: true, check: "container" });
    expect(route("POST", "/v1.47/containers/abc/update", policy).ok).toBe(false);
    expect(route("POST", "/v1.47/containers/abc/archive", policy).ok).toBe(false);
    expect(route("PUT", "/v1.47/containers/abc/archive", policy).ok).toBe(false);
    expect(route("POST", "/v1.47/exec/e1/start", policy)).toEqual({ ok: true, check: "exec" });
    expect(route("GET", "/v1.47/networks/deploy_default", policy).ok).toBe(false);
    expect(route("POST", "/v1.47/networks/anvil-sandbox-net/connect", policy)).toEqual({ ok: true, check: "connect" });
    expect(route("POST", "/v1.47/volumes/create", policy).ok).toBe(false);
    expect(route("POST", "/v1.47/swarm/init", policy).ok).toBe(false);
    expect(route("GET", "/v1.47/info", policy).ok).toBe(false);
  });

  it("accepts the hardened sandbox container, and refuses each weaker setting", () => {
    expect(checkContainerCreate(sandboxBody(), policy)).toEqual({ ok: true });
    const bad: [string, (b: ReturnType<typeof sandboxBody>) => void][] = [
      ["image", (b) => (b.Image = "ubuntu")],
      ["label", (b) => (b.Labels = {} as never)],
      ["root", (b) => (b.User = "0")],
      ["no user", (b) => (b.User = "" as never)],
      ["privileged", (b) => Object.assign(b.HostConfig, { Privileged: true })],
      ["bind", (b) => Object.assign(b.HostConfig, { Binds: ["/:/host"] })],
      ["mount", (b) => Object.assign(b.HostConfig, { Mounts: [{ Type: "bind", Source: "/var/run/docker.sock", Target: "/s" }] })],
      ["device", (b) => Object.assign(b.HostConfig, { Devices: [{ PathOnHost: "/dev/sda" }] })],
      ["cap add", (b) => Object.assign(b.HostConfig, { CapAdd: ["SYS_ADMIN"] })],
      ["cap drop", (b) => (b.HostConfig.CapDrop = [])],
      ["no-new-privileges", (b) => (b.HostConfig.SecurityOpt = [])],
      ["seccomp", (b) => b.HostConfig.SecurityOpt.push("seccomp=unconfined")],
      ["writable root", (b) => (b.HostConfig.ReadonlyRootfs = false)],
      ["host network", (b) => (b.HostConfig.NetworkMode = "host")],
      ["bridge network", (b) => (b.HostConfig.NetworkMode = "bridge")],
      ["covo network", (b) => (b.HostConfig.NetworkMode = "deploy_default")],
      ["host pid", (b) => Object.assign(b.HostConfig, { PidMode: "host" })],
      ["runtime", (b) => (b.HostConfig.Runtime = "runc")],
      ["memory", (b) => (b.HostConfig.Memory = 0)],
      ["too much memory", (b) => (b.HostConfig.Memory = 8 * 1024 ** 3)],
      ["pids", (b) => (b.HostConfig.PidsLimit = 0)],
      ["ports", (b) => Object.assign(b.HostConfig, { PortBindings: { "22/tcp": [{ HostPort: "2222" }] } })],
      ["extra host", (b) => Object.assign(b.HostConfig, { ExtraHosts: ["host.docker.internal:host-gateway"] })],
      ["tmpfs", (b) => (b.HostConfig.Tmpfs = { "/etc": "rw" } as never)],
      ["sysctl", (b) => Object.assign(b.HostConfig, { Sysctls: { "net.ipv4.ip_forward": "1" } })],
    ];
    for (const [name, change] of bad) {
      const b = sandboxBody();
      change(b);
      expect(checkContainerCreate(b, policy).ok, name).toBe(false);
    }
  });

  it("checks a network create and an exec create", () => {
    expect(checkNetworkCreate({ Name: "anvil-sandbox-net", Internal: true }, policy).ok).toBe(true);
    expect(checkNetworkCreate({ Name: "anvil-sandbox-net", Internal: false }, policy).ok).toBe(false);
    expect(checkNetworkCreate({ Name: "other", Internal: true }, policy).ok).toBe(false);
    expect(checkExecCreate({ Cmd: ["python"] }).ok).toBe(true);
    expect(checkExecCreate({ Cmd: ["sh"], User: "root" }).ok).toBe(false);
    expect(checkExecCreate({ Cmd: ["sh"], Privileged: true }).ok).toBe(false);
  });

  it("gives the sandbox containers of Anvil the settings that the guard needs", () => {
    const cfg = { ...loadConfig().sandbox, runtime: "runsc" };
    const args = containerArgs(cfg, "c1", "1:x", 4000);
    for (const a of ["--read-only", "--cap-drop", "ALL", "no-new-privileges", "10001:10001", "--pids-limit", "--memory"]) expect(args).toContain(a);
    expect(args.slice(args.indexOf("--runtime"), args.indexOf("--runtime") + 2)).toEqual(["--runtime", "runsc"]);
  });
});

describe("docker guard: the proxy", () => {
  const dir = tmpDir();
  const upstream = path.join(dir, "docker.sock");
  const guarded = path.join(dir, "guard", "docker.sock");
  const seen: string[] = [];
  const containers: Record<string, Record<string, string>> = { sbx1: { "anvil.sandbox": "1" }, covo: {} };
  // A small fake Docker API: it records each call that reaches it.
  const fake = http
    .createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      const id = /\/containers\/([^/?]+)\/json/.exec(req.url ?? "")?.[1];
      if (id) {
        if (!containers[id]) return res.writeHead(404).end("{}");
        return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ Id: id, Config: { Labels: containers[id] } }));
      }
      if (req.url?.startsWith("/containers/json")) return res.writeHead(200).end(JSON.stringify(Object.keys(containers).filter((c) => containers[c]["anvil.sandbox"])));
      res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
    })
    .listen(upstream);
  const guard = startDockerGuard({ listen: guarded, upstream, policy, log: () => undefined });
  afterAll(() => {
    guard.close();
    fake.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const call = (method: string, p: string, body?: unknown) =>
    new Promise<{ status: number; text: string }>((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request(
        { socketPath: guarded, method, path: p, headers: data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {} },
        (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
        },
      );
      req.on("error", reject);
      req.end(data);
    });

  it("forwards an allowed call and refuses the others before they reach Docker", async () => {
    await new Promise((r) => setTimeout(r, 50));
    expect((await call("GET", "/v1.47/_ping")).status).toBe(200);
    expect((await call("POST", "/v1.47/containers/sbx1/start")).status).toBe(200);
    const covo = await call("POST", "/v1.47/containers/covo/stop");
    expect(covo.status).toBe(403);
    expect(covo.text).toMatch(/not a sandbox container/);
    expect((await call("DELETE", "/v1.47/containers/covo?force=1")).status).toBe(403);
    expect((await call("POST", "/v1.47/containers/create?name=x", { ...sandboxBody(), HostConfig: { ...sandboxBody().HostConfig, Privileged: true } })).status).toBe(403);
    expect((await call("POST", "/v1.47/images/create?fromImage=alpine")).status).toBe(403);
    expect(seen.some((s) => s.includes("/containers/covo/stop") || s.includes("images/create") || s.includes("DELETE /v1.47/containers/covo"))).toBe(false);
  });

  it("refuses a new container when the server runs the most sandboxes", async () => {
    expect((await call("POST", "/v1.47/containers/create?name=n1", sandboxBody())).status).toBe(200);
    containers.sbx2 = { "anvil.sandbox": "1" };
    const full = await call("POST", "/v1.47/containers/create?name=n2", sandboxBody());
    expect(full.status).toBe(403);
    expect(full.text).toMatch(/most sandboxes/);
  });
});

describe("egress proxy of the remote browser", () => {
  const target = http.createServer((_req, res) => res.end("private data")).listen(0, "127.0.0.1");
  const targetPort = () => (target.address() as net.AddressInfo).port;
  // A test lookup: "public.test" is a public site that runs on this machine. Any other name is blocked.
  const lookup = ((host: string, _o: unknown, cb: (...a: unknown[]) => void) =>
    host === "public.test" ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(new Error(`${host} points to a private or local address`))) as never;
  let proxyPort = 0;
  const ports = [80, 443];
  const proxy = startEgressProxy({ port: 0, host: "127.0.0.1", lookup, ports });
  afterAll(() => {
    proxy.close();
    target.close();
  });

  const viaProxy = (url: string) =>
    new Promise<{ status: number; text: string }>((resolve, reject) => {
      proxyPort = (proxy.address() as net.AddressInfo).port;
      const req = http.request({ host: "127.0.0.1", port: proxyPort, method: "GET", path: url }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      });
      req.on("error", reject);
      req.end();
    });

  const connect = (hostPort: string) =>
    new Promise<string>((resolve, reject) => {
      proxyPort = (proxy.address() as net.AddressInfo).port;
      const s = net.connect(proxyPort, "127.0.0.1", () => s.write(`CONNECT ${hostPort} HTTP/1.1\r\nHost: ${hostPort}\r\n\r\n`));
      let text = "";
      s.on("data", (c) => {
        text += c;
        if (text.includes("\r\n\r\n")) {
          s.destroy();
          resolve(text.split("\r\n")[0]);
        }
      });
      s.on("error", reject);
    });

  it("blocks private addresses, metadata, and other ports, and forwards to a public name", async () => {
    await new Promise((r) => setTimeout(r, 50));
    // The test site listens on a free port: it counts as a web port here.
    ports.push(targetPort());
    expect((await viaProxy(`http://127.0.0.1:${targetPort()}/`)).status).toBe(403);
    expect((await viaProxy("http://169.254.169.254/latest/meta-data/")).status).toBe(403);
    expect((await viaProxy("http://internal.service/")).status).toBe(403);
    expect(await connect("169.254.169.254:443")).toMatch(/403/);
    expect(await connect("10.0.0.1:443")).toMatch(/403/);
    expect(await connect("public.test:22")).toMatch(/403/);
    expect(await connect(`public.test:${targetPort()}`)).toMatch(/200/);
    expect(await viaProxy(`http://public.test:${targetPort()}/`)).toEqual({ status: 200, text: "private data" });
  });
});
