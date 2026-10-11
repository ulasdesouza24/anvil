import { FileSpreadsheet, FileText, FileType, Image as ImageIcon, Paperclip, X } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { api, type FileView } from "../lib/api";
import { Spinner } from "./ui";

const ICON: Record<FileView["kind"], typeof FileText> = {
  text: FileText,
  json: FileType,
  table: FileSpreadsheet,
  pdf: FileText,
  document: FileText,
  image: ImageIcon,
  other: FileType,
};

const size = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

/** What the server read from a file, in a few words. */
export function fileSummary(f: FileView): string {
  if (f.sheets?.length) return f.sheets.map((s) => `${s.totalRows} rows · ${s.columns.length} columns`).join(", ");
  if (f.note && !f.chars) return f.note;
  return `${f.chars.toLocaleString()} characters${f.pages ? ` · ${f.pages} pages` : ""}${f.truncated ? " (cut)" : ""}`;
}

export function FileChip({ f, onRemove }: { f: FileView; onRemove?: () => void }) {
  const Icon = ICON[f.kind] ?? FileType;
  const warn = !!f.note && !f.chars;
  return (
    <span
      className="inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-[11.5px]"
      style={{ borderColor: warn ? "var(--color-warn)" : "var(--color-line-2)" }}
      title={`${f.name} — ${fileSummary(f)}${f.preview ? `\n\n${f.preview}` : ""}`}
    >
      <Icon size={13} className="shrink-0 text-[var(--color-ember)]" />
      <span className="truncate">{f.name}</span>
      <span className="shrink-0 text-[var(--color-faint)]">
        {size(f.size)} · {fileSummary(f)}
      </span>
      {onRemove && (
        <button className="shrink-0 text-[var(--color-faint)] hover:text-[var(--color-bad)]" onClick={onRemove} aria-label={`Remove ${f.name}`}>
          <X size={12} />
        </button>
      )}
    </span>
  );
}

/**
 * Attach files: a button, and drop on the area that `children` shows. Each file is uploaded and read
 * at once, so the person sees what the server read (rows, characters, or why it cannot read it).
 */
export function FileAttach({
  files,
  onChange,
  multiple = true,
  children,
  actions,
  label = "Attach files",
}: {
  files: FileView[];
  onChange: (f: FileView[]) => void;
  multiple?: boolean;
  children?: ReactNode;
  actions?: ReactNode;
  label?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const add = async (list: File[]) => {
    if (!list.length) return;
    setBusy(true);
    setErr(null);
    try {
      const saved = await api.uploadFiles(multiple ? list : list.slice(0, 1));
      onChange(multiple ? [...files, ...saved] : saved);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        void add([...e.dataTransfer.files]);
      }}
      className={over ? "rounded-lg outline outline-2 outline-[var(--color-ember)]" : undefined}
    >
      {children}
      <div className="flex flex-wrap items-center gap-1.5">
        <input ref={input} type="file" multiple={multiple} className="hidden" onChange={(e) => void add([...(e.target.files ?? [])])} />
        <button type="button" className="btn !py-1 text-[12px]" disabled={busy} onClick={() => input.current?.click()}>
          {busy ? <Spinner size={12} /> : <Paperclip size={13} />} {label}
        </button>
        {actions}
        {files.map((f) => (
          <FileChip key={f.id} f={f} onRemove={() => onChange(files.filter((x) => x.id !== f.id))} />
        ))}
        {!files.length && !busy && <span className="text-[11px] text-[var(--color-faint)]">or drop files here · text, Markdown, HTML, JSON, CSV, Excel, PDF, Word</span>}
      </div>
      {err && <div className="mt-1 text-[11.5px] text-[var(--color-bad)]">{err}</div>}
    </div>
  );
}
