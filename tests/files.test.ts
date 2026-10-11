import { describe, expect, it } from "vitest";
import { extractContent, filePreview, kindOf, parseCsv } from "../src/core/fileExtract.js";
import type { AgentSpec } from "../src/core/types.js";
import { FileService } from "../src/runtime/files.js";
import { validateSpec } from "../src/core/validator.js";
import { createRegistry } from "../src/runtime/anvil.js";
import { anvilWith, FakeClient, tmpDir } from "./helpers.js";

const limits = { maxTextChars: 10_000, maxRows: 100, maxBytes: 1024 * 1024 };

/** A minimal PDF with one line of text. */
function pdf(text: string): Buffer {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    null,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = `BT /F1 18 Tf 20 100 Td (${text}) Tj ET`;
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, "latin1");
}

describe("file content", () => {
  it("knows the kind of a file from its name and type", () => {
    expect(kindOf("a.csv")).toBe("table");
    expect(kindOf("a.XLSX")).toBe("table");
    expect(kindOf("a.pdf")).toBe("pdf");
    expect(kindOf("a.docx")).toBe("document");
    expect(kindOf("notes.md")).toBe("text");
    expect(kindOf("x", "image/png")).toBe("image");
    expect(kindOf("a.bin")).toBe("other");
  });

  it("reads CSV with quotes and separators, and makes numbers numbers", async () => {
    expect(parseCsv('a,b\n1,"x, ""y"""\n')).toEqual([
      ["a", "b"],
      ["1", 'x, "y"'],
    ]);
    expect(parseCsv("a;b\n1;2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    const c = await extractContent("prices.csv", "text/csv", Buffer.from("item,price\nbolt,0.2\nnut,0.1\n"), limits);
    expect(c.kind).toBe("table");
    expect(c.sheets?.[0]).toMatchObject({ columns: ["item", "price"], totalRows: 2, rows: [{ item: "bolt", price: 0.2 }, { item: "nut", price: 0.1 }] });
    expect(c.text).toBe("item,price\nbolt,0.2\nnut,0.1");
  });

  it("keeps at most the configured rows and characters", async () => {
    const rows = ["n", ...Array.from({ length: 50 }, (_, i) => String(i))].join("\n");
    const c = await extractContent("n.csv", "", Buffer.from(rows), { maxTextChars: 40, maxRows: 10 });
    expect(c.sheets?.[0]).toMatchObject({ totalRows: 50 });
    expect(c.sheets?.[0].rows).toHaveLength(10);
    expect(c.truncated).toBe(true);
    expect(c.text.length).toBeLessThanOrEqual(40);
  });

  it("reads Excel, JSON, HTML, and PDF files", async () => {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Rates");
    ws.addRow(["currency", "rate"]);
    ws.addRow(["USD", 1.09]);
    const xlsx = Buffer.from(await wb.xlsx.writeBuffer());
    const x = await extractContent("rates.xlsx", "", xlsx, limits);
    expect(x.sheets?.[0]).toMatchObject({ name: "Rates", columns: ["currency", "rate"], rows: [{ currency: "USD", rate: 1.09 }] });

    const j = await extractContent("a.json", "", Buffer.from('{"a":[1,2]}'), limits);
    expect(j).toMatchObject({ kind: "json", data: { a: [1, 2] } });

    const h = await extractContent("page.html", "text/html", Buffer.from("<html><body><h1>Refund policy</h1><script>x()</script><p>30 days.</p></body></html>"), limits);
    expect(h.text).toContain("Refund policy");
    expect(h.text).not.toContain("x()");

    const p = await extractContent("contract.pdf", "application/pdf", pdf("Term: 12 months"), limits);
    expect(p).toMatchObject({ kind: "pdf", pages: 1 });
    expect(p.text).toContain("Term: 12 months");
  });

  it("gives the reason instead of an error when a file cannot be read", async () => {
    const bad = await extractContent("broken.pdf", "application/pdf", Buffer.from("not a pdf"), limits);
    expect(bad).toMatchObject({ kind: "pdf", text: "" });
    expect(bad.note).toMatch(/could not be read/);
    expect((await extractContent("a.png", "image/png", Buffer.from([1, 2]), limits)).note).toMatch(/image/);
  });
});

describe("file service", () => {
  it("saves a file with its content, gives its value to agents, and has a size limit", async () => {
    const files = new FileService(tmpDir(), limits);
    const f = await files.save("../../etc/notes.txt", "text/plain", Buffer.from("Ship on Mondays."));
    expect(f.name).toBe("notes.txt");
    expect(files.value(f.id)).toMatchObject({ fileId: f.id, name: "notes.txt", kind: "text", text: "Ship on Mondays." });
    expect(files.bytes(f.id)?.toString()).toBe("Ship on Mondays.");
    expect(files.get("../x")).toBeUndefined();
    await expect(files.save("big.txt", "", Buffer.alloc(limits.maxBytes + 1))).rejects.toThrow(/limit is 1 MB/);
    expect(filePreview(f)).toMatch(/^FILE f_\w+ "notes.txt" \(text, 0 KB\)\nShip on Mondays\./);
    expect(files.delete(f.id)).toBe(true);
    expect(files.get(f.id)).toBeUndefined();
  });
});

describe("files in agents", () => {
  const spec = (nodes: AgentSpec["nodes"], inputSchema: AgentSpec["inputSchema"] = { type: "object", properties: {} }): AgentSpec => ({
    specVersion: "anvil/v1",
    id: "f",
    name: "f",
    description: "",
    version: 1,
    inputSchema,
    nodes: [{ id: "input", type: "input", config: {} }, ...nodes, { id: "output", type: "output", config: { value: "{{nodes.c.output}}" } }],
    edges: [
      { from: "input", to: nodes[0].id },
      ...(nodes.length > 1 ? [{ from: nodes[0].id, to: nodes[1].id }] : []),
      { from: nodes.at(-1)!.id, to: "output" },
    ],
    policy: { maxCostUsd: 1, maxNodeExecutions: 20, timeoutMs: 20_000, requireApprovalForSideEffects: false },
    tests: [],
    meta: {},
  });

  it("an input field with a file id gets the content of the file", async () => {
    const anvil = await anvilWith(new FakeClient());
    const f = await anvil.files.save("invoice.txt", "text/plain", Buffer.from("Total: 42 EUR"));
    const s = spec([{ id: "c", type: "code", config: { code: "return { text: input.invoice.text, name: input.invoice.name }" } }], {
      type: "object",
      properties: { invoice: { type: "object", format: "anvil-file" } },
      required: ["invoice"],
    });
    const r = await anvil.runs.run({ spec: s }, { invoice: { fileId: f.id } });
    expect(r.output).toEqual({ text: "Total: 42 EUR", name: "invoice.txt" });
    // Content that a test writes itself stays as it is.
    const own = await anvil.runs.run({ spec: s }, { invoice: { name: "x.txt", kind: "text", text: "Total: 7 EUR" } });
    expect(own.output).toEqual({ text: "Total: 7 EUR", name: "x.txt" });
    const missing = await anvil.runs.run({ spec: s }, { invoice: { fileId: "f_0000000000000000" } });
    expect(missing.error).toMatch(/file "f_0000000000000000" does not exist/);
  });

  it("a file step reads a reference file in each run", async () => {
    const anvil = await anvilWith(new FakeClient());
    const f = await anvil.files.save("prices.csv", "text/csv", Buffer.from("item,price\nbolt,0.2\n"));
    const s = spec([
      { id: "ref", type: "file", config: { fileId: f.id } },
      { id: "c", type: "code", config: { code: "return { price: nodes.ref.output.sheets[0].rows[0].price }" } },
    ]);
    const r = await anvil.runs.run({ spec: s }, {});
    expect(r.output).toEqual({ price: 0.2 });
  });

  it("the analysis sees the attached files, and gives each one a role", async () => {
    let prompt = "";
    const taskSpec = (files: unknown[]) => ({
      name: "Invoice reader",
      agentId: "invoice-reader",
      summary: "Reads invoices.",
      goal: "Read the totals of invoices.",
      inputs: [{ name: "invoice", type: "object", description: "The invoice file", required: true, file: true }],
      outputs: [{ name: "total", type: "number", description: "The total" }],
      steps: ["read"],
      constraints: [],
      successCriteria: ["The total is a number.", "The total matches the invoice."],
      assumptions: [],
      clarifyingQuestions: [],
      exampleInputs: [{ invoice: { fileId: fid } }, { invoice: { name: "b.txt", kind: "text", text: "Total: 7 EUR" } }],
      dataNeeds: [],
      trigger: { kind: "manual", description: "A person runs it." },
      files,
    });
    let first = true;
    const client = new FakeClient((req) => {
      prompt = String(req.messages.at(-1)?.content);
      // The first answer forgets the role of the file: the check asks again.
      const files = first ? [] : [{ id: fid, name: "invoice.txt", role: "sample_input", use: "an example invoice" }];
      first = false;
      return JSON.stringify(taskSpec(files));
    });
    const anvil = await anvilWith(client);
    const f = await anvil.files.save("invoice.txt", "text/plain", Buffer.from("Invoice A-77. Total: 42 EUR"));
    const fid = f.id;
    const s: AgentSpec = {
      ...spec([{ id: "c", type: "anvil_analyze", config: { request: "Read invoices like this one.", triage: { pattern: "pipeline", clarity: 1 }, files: [fid] } }]),
    };
    s.nodes[2] = { id: "output", type: "output", config: { value: "{{nodes.c.output.taskSpec}}" } };
    const r = await anvil.runs.run({ spec: s }, {});
    expect(r.error).toBeUndefined();
    expect((r.output as { files: { role: string }[] }).files[0].role).toBe("sample_input");
    const all = client.chats[0].messages.map((m) => String(m.content)).join("\n");
    expect(all).toContain(`FILE ${fid} "invoice.txt" (text, 0 KB)\nInvoice A-77. Total: 42 EUR`);
    // The first answer gave no role: the check asked for it.
    expect(prompt).toContain(`give the attached file ${fid} ("invoice.txt") a role in "files"`);
  });
});

describe("file roles in the compiler", () => {
  const base = (nodes: AgentSpec["nodes"]): AgentSpec => ({
    specVersion: "anvil/v1",
    id: "f",
    name: "f",
    description: "",
    version: 1,
    inputSchema: { type: "object", properties: { invoice: { type: "object", format: "anvil-file" } } },
    nodes: [{ id: "input", type: "input", config: {} }, ...nodes, { id: "output", type: "output", config: { value: { t: "{{input.invoice.text}}" } } }],
    edges: [{ from: "input", to: nodes[0]?.id ?? "output" }, ...nodes.map((n, i) => ({ from: n.id, to: nodes[i + 1]?.id ?? "output" }))],
    policy: { maxCostUsd: 1, maxNodeExecutions: 20, timeoutMs: 20_000, requireApprovalForSideEffects: false },
    tests: [],
    meta: {},
  });
  const files = [
    { id: "f_aaaaaaaaaaaaaaaa", name: "invoice.txt", role: "sample_input" },
    { id: "f_bbbbbbbbbbbbbbbb", name: "prices.csv", role: "reference" },
  ];
  const codes = (spec: AgentSpec) => validateSpec(spec, createRegistry(), { files }).diagnostics.filter((d) => d.code.startsWith("FILE_")).map((d) => d.code);

  it("rejects a sample input that a file step reads, and a reference file that no step reads", () => {
    expect(codes(base([{ id: "read_invoice", type: "file", config: { fileId: "f_aaaaaaaaaaaaaaaa" } }]))).toEqual(["FILE_SAMPLE_AS_STEP", "FILE_REFERENCE_MISSING"]);
    expect(codes(base([{ id: "prices", type: "file", config: { fileId: "f_bbbbbbbbbbbbbbbb" } }]))).toEqual([]);
  });

  it("reads the file roles from the task spec of a built agent", () => {
    const spec = { ...base([{ id: "prices", type: "transform", config: { value: 1 } }]), meta: { taskSpec: { files } } };
    expect(validateSpec(spec, createRegistry()).diagnostics.map((d) => d.code)).toContain("FILE_REFERENCE_MISSING");
  });
});

describe("triggers come from the request", () => {
  it("rejects a trigger that the request does not ask for, so the agent starts manually and gets its data itself", async () => {
    const spec = (trigger: unknown, inputs: unknown[]) => ({
      name: "Top stocks",
      agentId: "top-stocks",
      summary: "Finds the top stocks.",
      goal: "Find the top gainers.",
      inputs,
      outputs: [{ name: "stocks", type: "array", description: "The stocks" }],
      steps: ["read the page"],
      constraints: [],
      successCriteria: ["Five stocks.", "Sorted by change."],
      assumptions: [],
      clarifyingQuestions: [],
      exampleInputs: [{}, {}],
      dataNeeds: [],
      trigger,
    });
    let n = 0;
    const prompts: string[] = [];
    const client = new FakeClient(
      (req) => {
        prompts.push(String(req.messages.at(-1)?.content));
        n++;
        return JSON.stringify(
          n === 1
            ? spec({ kind: "poll", description: "Watch the page.", url: "https://x.test" }, [{ name: "text", type: "string", description: "The page text", required: false }])
            : spec({ kind: "manual", description: "A person runs it." }, [{ name: "url", type: "string", description: "The page", required: false }]),
        );
      },
      (id, q) => (id === "asked" ? { type: "noul", noul: 0.1 } : { type: "noul", noul: 0.9 }),
    );
    const anvil = await anvilWith(client);
    const s: AgentSpec = {
      specVersion: "anvil/v1",
      id: "a",
      name: "a",
      description: "",
      version: 1,
      inputSchema: { type: "object", properties: {} },
      nodes: [
        { id: "input", type: "input", config: {} },
        { id: "c", type: "anvil_analyze", config: { request: "Find the top 5 gainers of BIST 100 today.", triage: { pattern: "pipeline", clarity: 1 } } },
        { id: "output", type: "output", config: { value: "{{nodes.c.output.taskSpec}}" } },
      ],
      edges: [
        { from: "input", to: "c" },
        { from: "c", to: "output" },
      ],
      policy: { maxCostUsd: 1, maxNodeExecutions: 20, timeoutMs: 20_000, requireApprovalForSideEffects: false },
      tests: [],
      meta: {},
    };
    const r = await anvil.runs.run({ spec: s }, {});
    expect((r.output as { trigger: { kind: string } }).trigger.kind).toBe("manual");
    expect(prompts[1]).toContain('The request does not ask for a "poll" trigger');
  });
});

describe("tables of web pages", () => {
  it("keeps the rows and the columns of a table, in the text and as records", async () => {
    const { extractTables, htmlToText } = await import("../src/core/tools/web.js");
    const html = `<html><body><p>Prices</p><table><thead><tr><th>Hisse</th><th>Son</th><th>Fark</th></tr></thead>
      <tbody><tr><td>AKBNK</td><td>68,15</td><td>-1,94%</td></tr><tr><td><a href="/x">AKCNS</a></td><td>213,00</td><td>2,55%</td></tr></tbody></table></body></html>`;
    const text = htmlToText(html).text;
    expect(text).toContain("| Hisse | Son | Fark |\n| AKBNK | 68,15 | -1,94% |\n| AKCNS | 213,00 | 2,55% |");
    expect(extractTables(html)).toEqual([
      {
        columns: ["Hisse", "Son", "Fark"],
        rows: [
          { Hisse: "AKBNK", Son: "68,15", Fark: "-1,94%" },
          { Hisse: "AKCNS", Son: "213,00", Fark: "2,55%" },
        ],
        totalRows: 2,
      },
    ]);
    // A layout table with one row is not data.
    expect(extractTables("<table><tr><td>menu</td></tr></table>")).toEqual([]);
  });
});
