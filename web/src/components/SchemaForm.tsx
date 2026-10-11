import type { JSONSchema } from "@core/types";
import { useEffect, useState } from "react";
import { api, type FileView } from "../lib/api";
import { FileAttach } from "./FileAttach";

type Props = {
  schema: JSONSchema;
  value: Record<string, unknown>;
  onChange: (v: Record<string, unknown>) => void;
};

function longText(name: string, s: JSONSchema) {
  const d = `${name} ${s.description ?? ""}`.toLowerCase();
  return /text|body|content|message|email|document|posting|notes|description|article|transcript|policy|prompt|context|html|code|question|request|review|feedback/.test(d);
}

/** Renders an input form from the agent's inputSchema. */
export function SchemaForm({ schema, value, onChange }: Props) {
  const props = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const keys = Object.keys(props);
  if (!keys.length) return <div className="text-xs text-[var(--color-muted)]">This agent takes no input.</div>;
  return (
    <div className="space-y-3">
      {keys.map((k) => (
        <Field key={k} name={k} schema={props[k]} required={required.has(k)} value={value[k]} onChange={(v) => onChange({ ...value, [k]: v })} />
      ))}
    </div>
  );
}

function Field({ name, schema, required, value, onChange }: { name: string; schema: JSONSchema; required: boolean; value: unknown; onChange: (v: unknown) => void }) {
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  const label = (
    <div className="mb-1 flex items-baseline gap-2">
      <span className="mono text-[12px] font-medium">{name}</span>
      {required && <span className="text-[10px] text-[var(--color-ember)]">required</span>}
      <span className="mono text-[10px] text-[var(--color-faint)]">{type}</span>
      {schema.description && <span className="truncate text-[11px] text-[var(--color-muted)]">{schema.description}</span>}
    </div>
  );

  if (schema.enum) {
    return (
      <div>
        {label}
        <select className="input" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)}>
          <option value="">—</option>
          {schema.enum.map((o) => (
            <option key={String(o)} value={String(o)}>
              {String(o)}
            </option>
          ))}
        </select>
      </div>
    );
  }
  if (type === "boolean") {
    return (
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} className="accent-[var(--color-ember)]" />
        {label}
      </label>
    );
  }
  if (type === "number" || type === "integer") {
    return (
      <div>
        {label}
        <input
          className="input mono"
          type="number"
          value={value === undefined || value === null ? "" : String(value)}
          onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
        />
      </div>
    );
  }
  // A file field (docs/FILES.md): the person attaches a file, and the run gets its content.
  if (schema.format === "anvil-file") {
    const v = value as { fileId?: string; name?: string } | undefined;
    return (
      <div>
        {label}
        <FileField value={v} onChange={onChange} />
      </div>
    );
  }
  if (type === "array" || type === "object") return <JsonField label={label} value={value} onChange={onChange} placeholder={type === "array" ? "[ ]" : "{ }"} />;
  const long = longText(name, schema) || String(value ?? "").length > 80;
  return (
    <div>
      {label}
      {long ? (
        <textarea className="input min-h-[110px] resize-y leading-relaxed" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input className="input" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} />
      )}
    </div>
  );
}

function FileField({ value, onChange }: { value: { fileId?: string; name?: string } | undefined; onChange: (v: unknown) => void }) {
  const [files, setFiles] = useState<FileView[]>([]);
  // A value from an earlier run (or a test) has only the id: load its view once.
  useEffect(() => {
    if (value?.fileId && !files.some((f) => f.id === value.fileId))
      api
        .file(value.fileId)
        .then((f) => setFiles([f]))
        .catch(() => undefined);
  }, [value?.fileId]);
  return (
    <FileAttach
      files={value?.fileId ? files.filter((f) => f.id === value.fileId) : []}
      multiple={false}
      label={value?.fileId ? "Replace file" : "Attach a file"}
      onChange={(list) => {
        setFiles(list);
        onChange(list[0] ? { fileId: list[0].id, name: list[0].name } : undefined);
      }}
    />
  );
}

function JsonField({ label, value, onChange, placeholder }: { label: React.ReactNode; value: unknown; onChange: (v: unknown) => void; placeholder: string }) {
  const [text, setText] = useState(value === undefined ? "" : JSON.stringify(value, null, 2));
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setText(value === undefined ? "" : JSON.stringify(value, null, 2));
  }, [JSON.stringify(value)]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div>
      {label}
      <textarea
        className="input mono min-h-[90px] resize-y text-[12px]"
        placeholder={placeholder}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          if (!e.target.value.trim()) {
            setErr(null);
            onChange(undefined);
            return;
          }
          try {
            onChange(JSON.parse(e.target.value));
            setErr(null);
          } catch {
            setErr("invalid JSON");
          }
        }}
      />
      {err && <div className="mt-1 text-[11px] text-[var(--color-bad)]">{err}</div>}
    </div>
  );
}
