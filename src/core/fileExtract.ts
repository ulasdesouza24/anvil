import { htmlToText } from "./tools/web.js";

/**
 * The content of an attached file (docs/FILES.md). An agent and the builder read
 * this content, not the bytes: the text of a document, or the rows of a table.
 */
export type FileKind = "text" | "table" | "json" | "pdf" | "document" | "image" | "other";

export interface FileSheet {
  name: string;
  columns: string[];
  rows: Record<string, unknown>[];
  /** The number of rows in the file. `rows` can have fewer (a limit). */
  totalRows: number;
}

export interface FileContent {
  kind: FileKind;
  /** The text of the file (for a table: a CSV view of the first rows). */
  text: string;
  /** For a table: each sheet with its columns and rows. */
  sheets?: FileSheet[];
  /** For JSON: the parsed value. */
  data?: unknown;
  pages?: number;
  /** The limits cut the content. */
  truncated: boolean;
  /** Why the content is empty or partial. */
  note?: string;
}

export interface ExtractLimits {
  maxTextChars: number;
  maxRows: number;
}

const ext = (name: string) => (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? "").toLowerCase();

export function kindOf(name: string, mime = ""): FileKind {
  const e = ext(name);
  if (["csv", "tsv", "xlsx", "xlsm"].includes(e) || /spreadsheet|csv/.test(mime)) return "table";
  if (e === "json" || /json/.test(mime)) return "json";
  if (e === "pdf" || mime === "application/pdf") return "pdf";
  if (["docx"].includes(e) || /wordprocessingml/.test(mime)) return "document";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(e) || mime.startsWith("image/")) return "image";
  if (["txt", "md", "markdown", "html", "htm", "xml", "log", "yaml", "yml", "ini", "rtf", "eml"].includes(e) || mime.startsWith("text/")) return "text";
  return "other";
}

/** CSV with quotes (RFC 4180). The separator is a comma, a semicolon, or a tab: the one that the first line uses most. */
export function parseCsv(text: string, separator?: string): string[][] {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const sep = separator ?? [",", ";", "\t"].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === sep) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((c) => c !== "")) rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c !== "")) rows.push(row);
  return rows;
}

/** A number in a cell becomes a number. Other values stay text. */
const cellValue = (v: string): unknown => (/^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : v);

function sheetFrom(name: string, grid: unknown[][], limits: ExtractLimits): FileSheet {
  const header = (grid[0] ?? []).map((h, i) => String(h ?? "").trim() || `column_${i + 1}`);
  const body = grid.slice(1);
  const rows = body.slice(0, limits.maxRows).map((r) => Object.fromEntries(header.map((h, i) => [h, typeof r[i] === "string" ? cellValue(r[i] as string) : (r[i] ?? null)])));
  return { name, columns: header, rows, totalRows: body.length };
}

/** A CSV view of the first rows of each sheet: the text of a table for a model. */
function tableText(sheets: FileSheet[], maxChars: number): string {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return sheets
    .map((s) => `${sheets.length > 1 ? `# ${s.name}\n` : ""}${[s.columns.map(esc).join(","), ...s.rows.map((r) => s.columns.map((c) => esc(r[c])).join(","))].join("\n")}`)
    .join("\n\n")
    .slice(0, maxChars);
}

function cut(text: string, limits: ExtractLimits): { text: string; truncated: boolean } {
  return text.length > limits.maxTextChars ? { text: text.slice(0, limits.maxTextChars), truncated: true } : { text, truncated: false };
}

/** Reads the content of a file. A parser error gives an empty content with the reason, not an exception. */
export async function extractContent(name: string, mime: string, bytes: Buffer, limits: ExtractLimits): Promise<FileContent> {
  const kind = kindOf(name, mime);
  try {
    if (kind === "table") {
      let sheets: FileSheet[];
      if (["xlsx", "xlsm"].includes(ext(name)) || /spreadsheetml/.test(mime)) {
        const ExcelJS = (await import("exceljs")).default;
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(bytes as unknown as ArrayBuffer);
        sheets = wb.worksheets.map((ws) => {
          const grid: unknown[][] = [];
          ws.eachRow({ includeEmpty: false }, (row) => {
            const values = (row.values as unknown[]).slice(1);
            grid.push(
              values.map((v) => {
                if (v && typeof v === "object") {
                  const o = v as { result?: unknown; text?: unknown; richText?: { text: string }[] };
                  if (o.result !== undefined) return o.result;
                  if (o.richText) return o.richText.map((x) => x.text).join("");
                  if (o.text !== undefined) return o.text;
                  if (v instanceof Date) return v.toISOString().slice(0, 10);
                }
                return v;
              }),
            );
          });
          return sheetFrom(ws.name, grid, limits);
        });
      } else sheets = [sheetFrom(name, parseCsv(bytes.toString("utf8"), ext(name) === "tsv" ? "\t" : undefined), limits)];
      const text = tableText(sheets, limits.maxTextChars);
      return { kind, text, sheets, truncated: sheets.some((s) => s.rows.length < s.totalRows) };
    }
    if (kind === "json") {
      const raw = bytes.toString("utf8");
      const data = JSON.parse(raw);
      return { kind, data, ...cut(raw, limits) };
    }
    if (kind === "pdf") {
      const { extractText, getDocumentProxy } = await import("unpdf");
      const pdf = await getDocumentProxy(new Uint8Array(bytes));
      const r = await extractText(pdf, { mergePages: true });
      const text = String(r.text ?? "").trim();
      return { kind, pages: r.totalPages, ...cut(text, limits), ...(text ? {} : { note: "The PDF has no text layer (for example a scan)." }) };
    }
    if (kind === "document") {
      const mammoth = await import("mammoth");
      const r = await (mammoth.default ?? mammoth).extractRawText({ buffer: bytes });
      return { kind, ...cut(r.value.trim(), limits) };
    }
    if (kind === "text") {
      const raw = bytes.toString("utf8");
      const text = /\.(html?|xml)$/i.test(name) || /^\s*<(!doctype|html)/i.test(raw) ? htmlToText(raw).text : raw;
      return { kind, ...cut(text, limits) };
    }
    if (kind === "image") return { kind, text: "", truncated: false, note: "An image: the agent gets its name and type, not its content." };
    return { kind, text: "", truncated: false, note: "Anvil cannot read this file type." };
  } catch (e) {
    return { kind, text: "", truncated: false, note: `The file could not be read: ${(e as Error).message.slice(0, 200)}` };
  }
}

/** A short view of a file for a prompt: its kind, its size, and the start of its content. */
export function filePreview(f: { id: string; name: string; size: number; content: FileContent }, chars = 1200): string {
  const c = f.content;
  const head = `FILE ${f.id} "${f.name}" (${c.kind}, ${Math.round(f.size / 1024)} KB${c.pages ? `, ${c.pages} pages` : ""})`;
  if (c.sheets?.length)
    return `${head}\n${c.sheets.map((s) => `sheet "${s.name}": ${s.totalRows} rows, columns: ${s.columns.join(", ")}\nfirst rows: ${JSON.stringify(s.rows.slice(0, 3)).slice(0, chars)}`).join("\n")}`;
  if (c.note && !c.text) return `${head}\n${c.note}`;
  return `${head}\n${c.text.slice(0, chars)}${c.text.length > chars ? "…" : ""}`;
}
