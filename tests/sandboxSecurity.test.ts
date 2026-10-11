import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/core/config.js";
import { SandboxManager, type SandboxCall } from "../src/runtime/sandbox.js";

/**
 * Security tests of the sandbox (docs/SANDBOX.md, section 4). Each test tries
 * one way out of the sandbox and expects it to fail. They need Docker and the image.
 */
const cfg = { ...loadConfig().sandbox, pool: 0, timeoutMs: 20_000 };
const ready = spawnSync("docker", ["image", "inspect", cfg.image], { stdio: "ignore" }).status === 0;
const sbx = new SandboxManager(cfg);
afterAll(() => sbx.dispose());

const calls: SandboxCall[] = [];
const host = async (c: SandboxCall) => {
  calls.push(c);
  if (c.tool !== "calculator") throw new Error(`The tool "${c.tool}" is not available to this program.`);
  return { result: 42 };
};
const run = async (code: string, runId = "sec", timeoutMs?: number) => sbx.exec(runId, code, host, { timeoutMs });

describe.skipIf(!ready)("sandbox security (real Docker)", () => {
  it("has no direct way to the internet or to the host", async () => {
    const r = await run(`
import socket
from anvil import result
out = {}
for name, addr in {"ip": ("1.1.1.1", 443), "dns": ("pypi.org", 443), "host": ("host.docker.internal", 8787)}.items():
    try:
        socket.create_connection(addr, timeout=3).close()
        out[name] = "open"
    except OSError as e:
        out[name] = type(e).__name__
result(out)`);
    expect(r.result).toEqual({ ip: expect.not.stringMatching(/^open$/), dns: expect.not.stringMatching(/^open$/), host: expect.not.stringMatching(/^open$/) });
  }, 60_000);

  it("cannot write outside /work, and cannot change the SDK", async () => {
    const r = await run(`
import os
from anvil import result
out = {}
for p in ["/etc/x", "/usr/x", "/opt/anvil/sdk/anvil/__init__.py", "/opt/anvil/runner.py", "/work/ok.txt"]:
    try:
        with open(p, "a") as f:
            f.write("x")
        out[p] = "written"
    except OSError as e:
        out[p] = type(e).__name__
result(out)`);
    const out = r.result as Record<string, string>;
    expect(out["/work/ok.txt"]).toBe("written");
    for (const p of ["/etc/x", "/usr/x", "/opt/anvil/sdk/anvil/__init__.py", "/opt/anvil/runner.py"]) expect(out[p]).not.toBe("written");
  }, 60_000);

  it("runs without root, without capabilities, and without the Docker socket", async () => {
    const r = await run(`
import os, socket
from anvil import result
out = {"uid": os.getuid(), "docker_socket": os.path.exists("/var/run/docker.sock")}
try:
    os.setuid(0); out["setuid"] = "ok"
except OSError as e:
    out["setuid"] = type(e).__name__
try:
    socket.socket(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_ICMP); out["raw_socket"] = "ok"
except OSError as e:
    out["raw_socket"] = type(e).__name__
result(out)`);
    expect(r.result).toEqual({ uid: 10001, docker_socket: false, setuid: "PermissionError", raw_socket: "PermissionError" });
  }, 60_000);

  it("has no secret of the host in its environment", async () => {
    const r = await run(`
import os
from anvil import result
result(dict(os.environ))`);
    const env = r.result as Record<string, string>;
    const values = Object.values(env);
    for (const [k, v] of Object.entries(process.env)) if (/KEY|TOKEN|SECRET|PASSWORD/i.test(k) && v && v.length >= 12) expect(values).not.toContain(v);
    expect(Object.keys(env).filter((k) => /OPENROUTER|ANVIL_.*KEY/i.test(k))).toEqual([]);
  }, 60_000);

  it("stops a fork bomb at the process limit, and the container stays usable", async () => {
    const r = await run(`
import subprocess
from anvil import result
procs, error = [], None
try:
    for _ in range(400):
        procs.append(subprocess.Popen(["sleep", "30"]))
except OSError as e:
    error = type(e).__name__
n = len(procs)
for p in procs:
    p.kill()
result({"started": n, "error": error})`);
    const out = r.result as { started: number; error: string | null };
    expect(out.started).toBeLessThan(128);
    expect(out.error).not.toBeNull();
    expect((await run("from anvil import result\nresult('alive')")).result).toBe("alive");
  }, 90_000);

  it("stops a program that uses more memory than the limit", async () => {
    const r = await run("x = bytearray(2 * 1024 * 1024 * 1024)\nfrom anvil import result\nresult(len(x))", "sec-mem");
    expect(r.ok).toBe(false);
    expect(r.result).toBeNull();
    await sbx.release("sec-mem");
  }, 90_000);

  it("stops a program at the time limit", async () => {
    const r = await run("while True:\n    pass", "sec-time", 2_000);
    expect(r).toMatchObject({ ok: false, timedOut: true });
    await sbx.release("sec-time");
  }, 60_000);

  it("a forged protocol message cannot call a tool that the host does not allow", async () => {
    calls.length = 0;
    const r = await run(`
import json, sys
from anvil import result
sys.__stdout__.write(json.dumps({"type": "call", "id": 1, "tool": "http_request", "args": {"url": "https://evil.test", "method": "POST"}}) + "\\n")
sys.__stdout__.flush()
answer = json.loads(sys.__stdin__.readline())
result(answer)`);
    expect(r.result).toMatchObject({ id: 1, ok: false, error: 'The tool "http_request" is not available to this program.' });
    expect(calls.map((c) => c.tool)).toEqual(["http_request"]);
  }, 60_000);

  it("the gate sidecar forwards only package paths: the egress check of the host is not reachable", async () => {
    await sbx.status();
    // The gate of this process. Other test files run in other processes, with their own gates.
    const gate = sbx.sidecar;
    const r = await run(`
import urllib.request, urllib.error
from anvil import result
try:
    urllib.request.urlopen("http://${gate}:3141/egress?client=x&host=evil.test", timeout=5)
    result("reachable")
except urllib.error.HTTPError as e:
    result(e.code)`);
    expect(r.result).toBe(404);
  }, 60_000);
});
