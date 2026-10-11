import { createHash } from "node:crypto";
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeName, PackageGate, parseIndex, wheelVersion } from "../src/runtime/packageGate.js";
import { blockedSummary } from "../src/runtime/sandbox.js";
import { tmpDir } from "./helpers.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const FILES: Record<string, string> = {
  "demo-1.0-py3-none-any.whl": "wheel one",
  "demo-1.1-py3-none-any.whl": "wheel vulnerable",
  "demo-0.9-py3-none-any.whl": "wheel yanked",
};

/** A fake upstream index (PEP 691 JSON) and a fake OSV. */
function fakeFetch(opts: { osvDown?: boolean; tamper?: boolean } = {}) {
  const calls: string[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("osv")) {
      if (opts.osvDown) return new Response("down", { status: 503 });
      const q = JSON.parse(String(init?.body)) as { queries: { version: string }[] };
      return Response.json({ results: q.queries.map((x) => (x.version === "1.1" ? { vulns: [{ id: "GHSA-test" }] } : {})) });
    }
    if (url.endsWith("/simple/demo/"))
      return Response.json(
        {
          files: [
            ...Object.entries(FILES).map(([filename, body]) => ({ filename, url: `https://files.test/${filename}`, hashes: { sha256: sha(body) }, yanked: filename.includes("0.9") })),
            { filename: "demo-1.2.tar.gz", url: "https://files.test/demo-1.2.tar.gz", hashes: { sha256: sha("sdist") } },
          ],
        },
        { headers: { "content-type": "application/vnd.pypi.simple.v1+json" } },
      );
    if (url.startsWith("https://files.test/")) {
      const name = url.split("/").pop()!;
      return new Response(opts.tamper ? "changed" : FILES[name]);
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { f, calls };
}

const gate = (over: Partial<ConstructorParameters<typeof PackageGate>[0]> = {}, fx = fakeFetch()) =>
  new PackageGate({ index: "https://index.test/simple", vulnCheck: "osv", allow: [], deny: [], cacheDir: tmpDir(), osvUrl: "https://osv.test/querybatch", fetch: fx.f, ...over });

describe("package gate", () => {
  it("gives pip only wheels that are not yanked and have no known vulnerability", async () => {
    const g = gate();
    const page = await g.projectPage("Demo", "10.0.0.5");
    expect(page.status).toBe(200);
    expect(page.body).toContain(`/files/demo/demo-1.0-py3-none-any.whl#sha256=${sha("wheel one")}`);
    expect(page.body).not.toContain("demo-1.1");
    expect(page.body).not.toContain("tar.gz");
    expect(page.body).not.toContain("demo-0.9");
    expect(g.decisionsFor("10.0.0.5", 0)).toMatchObject([{ project: "demo", version: "1.1", decision: "blocked", reason: "OSV lists a known vulnerability for this version" }]);
  });

  it("blocks the install when OSV does not answer (fail-closed)", async () => {
    const g = gate({}, fakeFetch({ osvDown: true }));
    const page = await g.projectPage("demo", "c");
    expect(page.body).not.toContain("/files/");
    expect(g.decisions[0].reason).toMatch(/the vulnerability check is not available .* The gate blocks the install/);
  });

  it("applies the deny list and the allow list", async () => {
    expect((await gate({ deny: ["Demo"] }).projectPage("demo", "c")).status).toBe(404);
    expect((await gate({ allow: ["other"] }).projectPage("demo", "c")).status).toBe(404);
    expect((await gate({ allow: ["demo"] }).projectPage("demo", "c")).status).toBe(200);
  });

  it("checks the sha256 of each file and keeps it in a cache", async () => {
    const fx = fakeFetch();
    const g = gate({}, fx);
    expect((await g.file("demo", "demo-1.0-py3-none-any.whl", "c")).status).toBe(404); // not approved yet
    await g.projectPage("demo", "c");
    const first = await g.file("demo", "demo-1.0-py3-none-any.whl", "c");
    expect(String(first.body)).toBe("wheel one");
    const downloads = fx.calls.filter((u) => u.startsWith("https://files.test/")).length;
    await g.file("demo", "demo-1.0-py3-none-any.whl", "c");
    expect(fx.calls.filter((u) => u.startsWith("https://files.test/")).length).toBe(downloads);

    const bad = gate({}, fakeFetch({ tamper: true }));
    await bad.projectPage("demo", "c");
    expect(await bad.file("demo", "demo-1.0-py3-none-any.whl", "c")).toMatchObject({ status: 502, body: "the sha256 of the file does not agree with the index" });
  });

  it("reads a PEP 503 HTML index, as a Nexus repository gives it", () => {
    const html = `<a href="../../packages/x/demo-1.0-py3-none-any.whl#sha256=${"a".repeat(64)}" data-requires-python="&gt;=3.8">demo-1.0-py3-none-any.whl</a><a href="demo-0.1-py3-none-any.whl" data-yanked="">demo-0.1-py3-none-any.whl</a>`;
    const files = parseIndex(html, "text/html", "https://nexus.test/repository/pypi/simple/demo/");
    expect(files[0]).toMatchObject({ filename: "demo-1.0-py3-none-any.whl", url: "https://nexus.test/repository/pypi/packages/x/demo-1.0-py3-none-any.whl", sha256: "a".repeat(64), requiresPython: ">=3.8", yanked: false });
    expect(files[1].yanked).toBe(true);
    expect(wheelVersion("numpy-2.1.3-cp312-cp312-manylinux_2_17_x86_64.whl")).toBe("2.1.3");
    expect(normalizeName("Python_DateUtil")).toBe("python-dateutil");
  });

  it("serves pip over HTTP", async () => {
    const g = gate();
    const port = await g.listen(0);
    const res = await fetch(`http://127.0.0.1:${port}/simple/demo/`, { headers: { "X-Anvil-Client": "10.0.0.9" } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("demo-1.0");
    expect((await fetch(`http://127.0.0.1:${port}/simple/demo/`, { method: "POST" })).status).toBe(405);
    expect(g.decisionsFor("10.0.0.9", 0).length).toBeGreaterThan(0);
    await g.close();
    expect(fs.existsSync(tmpDir())).toBe(true);
  });
});

describe("blocked install message", () => {
  const d = (version: string | undefined, reason: string) => ({ at: 0, client: "c", project: "urllib3", version, decision: "blocked" as const, reason });
  it("names the requested version first and counts the other versions", () => {
    const decisions = [d("1.9", "OSV lists a known vulnerability for this version"), d("1.24.1", "OSV lists a known vulnerability for this version"), d("1.25", "OSV lists a known vulnerability for this version")];
    expect(blockedSummary(["urllib3==1.24.1"], decisions)).toBe(
      "The package gate blocked: urllib3 1.24.1: OSV lists a known vulnerability for this version; urllib3: 2 other version(s) with a known vulnerability",
    );
    expect(blockedSummary(["urllib3"], [d(undefined, "the project is on the deny list")])).toBe("The package gate blocked: urllib3: the project is on the deny list");
    expect(blockedSummary(["six"], [])).toBeNull();
  });
});
