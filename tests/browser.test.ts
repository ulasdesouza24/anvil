import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentSpec } from "../src/core/types.js";
import { BrowserService, endpointClassDraft, robotsAllows } from "../src/runtime/browser.js";
import { anvilWith, FakeClient } from "./helpers.js";

/** A small site: the data reaches the page only through JavaScript. */
const PAGE = `<!doctype html><html><head><title>Fund table</title></head><body>
<div id="status">Loading…</div><table id="funds"><tr><th>Code</th><th>Return</th></tr></table>
<script>
fetch("/api/funds?period=10y", { headers: { "x-requested-with": "XMLHttpRequest" } })
  .then((r) => r.json())
  .then((d) => {
    for (const f of d.funds) {
      const tr = document.createElement("tr");
      tr.innerHTML = "<td>" + f.code + "</td><td>" + f.ret + "</td>";
      document.getElementById("funds").appendChild(tr);
    }
    document.getElementById("status").textContent = "Loaded " + d.funds.length + " funds";
  });
</script></body></html>`;

let server: http.Server;
let base = "";
const visits: number[] = [];
beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/robots.txt") return void res.writeHead(200).end("User-agent: *\nDisallow: /private\nAllow: /private/open\n");
    if (url.pathname === "/") {
      visits.push(Date.now());
      return void res.writeHead(200, { "Content-Type": "text/html" }).end(PAGE);
    }
    if (url.pathname === "/api/funds")
      return void res.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          period: url.searchParams.get("period"),
          funds: [
            { code: "AFT", ret: 412.5 },
            { code: "TTE", ret: 380.1 },
          ],
        }),
      );
    if (url.pathname === "/waf")
      return void res
        .writeHead(200, { "Content-Type": "text/html" })
        .end(`<html><head><title>Request Rejected</title></head><body>The requested URL was rejected. Your support ID is: 123</body></html>`);
    if (url.pathname === "/captcha")
      return void res.writeHead(200, { "Content-Type": "text/html" }).end(`<html><body><div class="g-recaptcha" data-sitekey="x"></div>Please verify you are human</body></html>`);
    res.writeHead(404).end("no");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

const svc = new BrowserService({ headless: true, maxPages: 2, navTimeoutMs: 20_000, domainIntervalMs: 300, respectRobots: true });
afterAll(async () => {
  await svc.close();
  server.close();
});

describe("robots.txt", () => {
  it("uses the longest matching rule of the * group", () => {
    const txt = "User-agent: googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /private\nAllow: /private/open\nDisallow: /*.pdf$";
    expect(robotsAllows(txt, "/public")).toBe(true);
    expect(robotsAllows(txt, "/private/x")).toBe(false);
    expect(robotsAllows(txt, "/private/open/x")).toBe(true);
    expect(robotsAllows(txt, "/docs/report.pdf")).toBe(false);
    expect(robotsAllows(txt, "/docs/report.pdf.html")).toBe(true); // "$" anchors the end
    expect(robotsAllows("", "/anything")).toBe(true);
  });
});

describe("browser service (real headless Chromium)", () => {
  it("reads JavaScript-rendered content and captures the API of the page", async () => {
    const r = await svc.browse({ url: `${base}/`, waitFor: "#funds tr:nth-child(3)", captureNetwork: true });
    expect(r.status).toBe(200);
    expect(r.title).toBe("Fund table");
    expect(r.text).toContain("Loaded 2 funds");
    expect(r.tables[0]).toEqual([
      ["Code", "Return"],
      ["AFT", "412.5"],
      ["TTE", "380.1"],
    ]);
    expect(r.blocked).toBeNull();
    const api = r.network.find((n) => n.url.includes("/api/funds"));
    expect(api).toMatchObject({ method: "GET", status: 200 });
    expect((api!.sample as { funds: unknown[] }).funds).toHaveLength(2);
    expect(api!.headers["x-requested-with"]).toBe("XMLHttpRequest");
  }, 60_000);

  it("turns a captured endpoint that works without the browser into a tested http class", async () => {
    const r = await svc.browse({ url: `${base}/`, waitFor: "#funds tr:nth-child(3)", captureNetwork: true });
    const api = r.network.find((n) => n.url.includes("/api/funds"))!;
    const replay = await svc.replay(api);
    expect(replay.ok).toBe(true);

    const anvil = await anvilWith(new FakeClient());
    const draft = endpointClassDraft(api, { type: "x_local_funds", title: "Local funds", description: "Fund returns from the local test site." });
    const saved = await anvil.classes.save(draft, { brain: anvil.runs.brain });
    expect(saved.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(saved.def?.status).toBe("passed");
    expect(saved.def?.configSchema).toMatchObject({ properties: { period: { default: "10y" } } });
  }, 60_000);

  it("reports CAPTCHA pages and robots.txt rules as blocked, and does not solve them", async () => {
    const c = await svc.browse({ url: `${base}/captcha` });
    expect(c.blocked?.reason).toBe("reCAPTCHA");
    const w = await svc.browse({ url: `${base}/waf` });
    expect(w.status).toBe(200); // a firewall can answer 200
    expect(w.blocked?.reason).toBe("web application firewall");
    const p = await svc.browse({ url: `${base}/private/data` });
    expect(p.blocked?.reason).toMatch(/robots\.txt/);
    expect(p.status).toBe(0); // no request went to the page
  }, 60_000);

  it("waits between two visits to the same domain", async () => {
    visits.length = 0;
    await Promise.all([svc.browse({ url: `${base}/` }), svc.browse({ url: `${base}/` })]);
    expect(visits).toHaveLength(2);
    expect(Math.abs(visits[1] - visits[0])).toBeGreaterThanOrEqual(250);
  }, 60_000);
});

describe("browser in agents", () => {
  const agent = (nodes: AgentSpec["nodes"]): AgentSpec => ({
    specVersion: "anvil/v1",
    id: "b",
    name: "b",
    description: "",
    version: 1,
    inputSchema: { type: "object", properties: { url: { type: "string" } } },
    nodes: [{ id: "input", type: "input", config: {} }, ...nodes, { id: "output", type: "output", config: { value: "{{nodes.page.output}}" } }],
    edges: [
      { from: "input", to: "page" },
      { from: "page", to: "output" },
    ],
    policy: { maxCostUsd: 1, maxNodeExecutions: 20, timeoutMs: 120_000, requireApprovalForSideEffects: false },
    tests: [],
    meta: {},
  });

  it("the browser node runs inside an agent", async () => {
    const anvil = await anvilWith(new FakeClient());
    const r = await anvil.runs.run({ spec: agent([{ id: "page", type: "browser", config: { url: "{{input.url}}", waitFor: "#funds tr:nth-child(3)" } }]) }, { url: `${base}/` });
    expect(r.status).toBe("completed");
    expect((r.output as { tables: string[][][] }).tables[0][1]).toEqual(["AFT", "412.5"]);
    await anvil.browser.close();
  }, 60_000);

  it("the browse tool gives a tool agent the page and its API", async () => {
    let step = 0;
    const client = new FakeClient((req) => {
      step++;
      if (step === 1)
        return {
          content: "",
          toolCalls: [{ id: "c1", type: "function", function: { name: "browse", arguments: JSON.stringify({ url: `${base}/`, waitFor: "#funds tr:nth-child(3)" }) } }],
        };
      const tool = JSON.parse(String(req.messages.find((m) => m.role === "tool")?.content));
      return `top fund ${tool.tables[0][1][0]}, api ${tool.network[0].url.includes("/api/funds")}`;
    });
    const anvil = await anvilWith(client);
    const r = await anvil.runs.run({ spec: agent([{ id: "page", type: "agent", config: { task: "Find the top fund", tools: ["browse"] } }]) }, {});
    expect((r.output as { answer: string }).answer).toBe("top fund AFT, api true");
    await anvil.browser.close();
  }, 60_000);

  it("a browser class reads a page and shapes it with a transform", async () => {
    const anvil = await anvilWith(new FakeClient());
    const saved = await anvil.classes.save(
      {
        type: "x_fund_page",
        title: "Fund page",
        category: "tool",
        description: "Reads the fund table from the local site.",
        whenToUse: "Fund returns.",
        configSchema: { type: "object", properties: { path: { type: "string", default: "" } } },
        outputSchema: { type: "object", properties: { codes: { type: "array" } }, required: ["codes"] },
        impl: { kind: "browser", url: `${base}/{{config.path}}`, waitFor: "#funds tr:nth-child(3)", transform: "return { codes: page.tables[0].slice(1).map((r) => r[0]) };" },
        tests: [{ name: "reads codes", config: {}, checks: [{ path: "codes", op: "contains", value: "TTE" }] }],
      },
      { brain: anvil.runs.brain },
    );
    expect(saved.def?.status).toBe("passed");
    await anvil.browser.close();
  }, 60_000);
});
