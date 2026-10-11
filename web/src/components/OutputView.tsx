import { type ReactNode, useState } from "react";
import { CopyButton, JsonBlock } from "./ui";

/**
 * The output of a run in a form that a person can read: objects become
 * labeled fields, lists of records become tables, a map of numbers becomes a
 * bar list, and text keeps its lines and lists. The JSON view stays one click away.
 */
export function OutputView({ value, className = "" }: { value: unknown; className?: string }) {
  const [mode, setMode] = useState<"view" | "json">("view");
  const json = JSON.stringify(value, null, 2) ?? "null";
  return (
    <div className={className}>
      <div className="mb-2 flex items-center gap-1">
        {(["view", "json"] as const).map((m) => (
          <button
            key={m}
            className={`rounded-md px-2 py-0.5 text-[11px] ${mode === m ? "bg-[var(--color-panel-2)] text-[var(--color-text,#e5e7eb)]" : "text-[var(--color-muted)] hover:text-[var(--color-text,#e5e7eb)]"}`}
            onClick={() => setMode(m)}
          >
            {m === "view" ? "Readable" : "JSON"}
          </button>
        ))}
        <span className="ml-auto">
          <CopyButton text={json} label="Copy JSON" />
        </span>
      </div>
      {mode === "json" ? <JsonBlock value={value} /> : <Readable value={value} />}
    </div>
  );
}

const humanize = (k: string) => k.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isScalar = (v: unknown) => v === null || ["string", "number", "boolean"].includes(typeof v);

/** True for a list of records that fit in a table: objects with scalar (or short) fields. */
function isTable(v: unknown[]): v is Record<string, unknown>[] {
  return v.length > 0 && v.every((x) => isPlainObject(x) && Object.values(x).every((y) => isScalar(y) || (Array.isArray(y) && y.every(isScalar))));
}

function Readable({ value }: { value: unknown }) {
  // A partial result from the harness: the gaps first, then the result.
  if (isPlainObject(value) && value.status === "partial" && "result" in value) {
    const gaps = (value.gaps as unknown[]) ?? [];
    return (
      <div className="space-y-3">
        <div className="rounded-lg border border-[rgba(251,191,36,0.4)] bg-[rgba(251,191,36,0.06)] p-3 text-[12px] text-[var(--color-warn)]">
          <div className="font-semibold">Partial result</div>
          {typeof value.reason === "string" && <div className="mt-1 text-[var(--color-muted)]">{value.reason}</div>}
          {gaps.length > 0 && (
            <ul className="mt-1 list-disc pl-4">
              {gaps.map((g, i) => (
                <li key={i}>{String(g)}</li>
              ))}
            </ul>
          )}
        </div>
        <Value value={value.result} depth={0} />
      </div>
    );
  }
  return <Value value={value} depth={0} />;
}

function Value({ value, depth }: { value: unknown; depth: number }): ReactNode {
  if (value === null || value === undefined) return <span className="text-[var(--color-faint)]">—</span>;
  if (typeof value === "boolean") return <span>{value ? "Yes" : "No"}</span>;
  if (typeof value === "number") return <span className="mono">{value.toLocaleString(undefined, { maximumFractionDigits: 6 })}</span>;
  if (typeof value === "string") return <Text text={value} />;
  if (Array.isArray(value)) {
    if (!value.length) return <span className="text-[var(--color-faint)]">(empty list)</span>;
    if (isTable(value)) return <Table rows={value} />;
    if (value.every(isScalar))
      return (
        <ul className="list-disc space-y-0.5 pl-4">
          {value.map((x, i) => (
            <li key={i}>
              <Value value={x} depth={depth + 1} />
            </li>
          ))}
        </ul>
      );
    return (
      <div className="space-y-2">
        {value.map((x, i) => (
          <div key={i} className="rounded-lg border border-[var(--color-line)] p-2">
            <Value value={x} depth={depth + 1} />
          </div>
        ))}
      </div>
    );
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (!entries.length) return <span className="text-[var(--color-faint)]">(empty)</span>;
    // A map of numbers (for example counts by region) becomes a bar list.
    if (entries.length > 1 && entries.every(([, v]) => typeof v === "number")) return <Bars entries={entries as [string, number][]} />;
    return (
      <div className={depth === 0 ? "space-y-4" : "space-y-2"}>
        {entries.map(([k, v]) => (
          <div key={k}>
            <div className={`label mb-1 ${depth === 0 ? "" : "text-[10.5px]"}`}>{humanize(k)}</div>
            <div className="text-[12.5px] leading-relaxed">
              <Value value={v} depth={depth + 1} />
            </div>
          </div>
        ))}
      </div>
    );
  }
  return <span>{String(value)}</span>;
}

/** Text with its lines. Lines that start with "- " or "* " become a list, and lines that start with "#" become headings. */
function Text({ text }: { text: string }) {
  if (/^https?:\/\/\S+$/.test(text.trim()))
    return (
      <a href={text.trim()} target="_blank" rel="noreferrer" className="break-all text-[var(--color-ember)]">
        {text.trim()}
      </a>
    );
  if (!text.includes("\n")) return <span className="whitespace-pre-wrap break-words">{text}</span>;
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length)
      blocks.push(
        <ul key={blocks.length} className="list-disc space-y-0.5 pl-4">
          {list.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>,
      );
    list = [];
  };
  for (const line of text.split("\n")) {
    const item = /^\s*[-*•]\s+(.*)$/.exec(line);
    if (item) {
      list.push(item[1]);
      continue;
    }
    flush();
    const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
    if (heading) blocks.push(<div key={blocks.length} className="font-semibold">{heading[1]}</div>);
    else if (line.trim()) blocks.push(<p key={blocks.length}>{line}</p>);
  }
  flush();
  return <div className="space-y-1.5 break-words">{blocks}</div>;
}

function Table({ rows }: { rows: Record<string, unknown>[] }) {
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v: unknown) => (Array.isArray(v) ? v.join(", ") : v === null || v === undefined ? "—" : typeof v === "number" ? v.toLocaleString(undefined, { maximumFractionDigits: 6 }) : String(v));
  return (
    <div className="overflow-auto rounded-lg border border-[var(--color-line)]">
      <table className="w-full border-collapse text-[12px]">
        <thead>
          <tr className="bg-[var(--color-panel-2)] text-left">
            <th className="px-2 py-1.5 font-medium text-[var(--color-faint)]">#</th>
            {cols.map((c) => (
              <th key={c} className="whitespace-nowrap px-2 py-1.5 font-medium text-[var(--color-muted)]">
                {humanize(c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-[var(--color-line)]">
              <td className="mono px-2 py-1 text-[var(--color-faint)]">{i + 1}</td>
              {cols.map((c) => (
                <td
                  key={c}
                  className={`px-2 py-1 align-top ${typeof r[c] === "number" ? "mono whitespace-nowrap text-right" : String(r[c] ?? "").length <= 40 ? "whitespace-nowrap" : "min-w-[220px]"}`}
                >
                  {cell(r[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Bars({ entries }: { entries: [string, number][] }) {
  const sorted = [...entries].sort((a, b) => b[1] - a[1]);
  const max = Math.max(...sorted.map(([, v]) => Math.abs(v)), 1);
  return (
    <div className="space-y-1">
      {sorted.map(([k, v]) => (
        <div key={k} className="flex items-center gap-2 text-[12px]">
          <span className="w-32 shrink-0 truncate text-[var(--color-muted)]" title={k}>
            {k}
          </span>
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--color-panel-2)]">
            <div className="h-full rounded-full bg-[var(--color-ember)]" style={{ width: `${(Math.abs(v) / max) * 100}%` }} />
          </div>
          <span className="mono w-14 text-right">{v.toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}
