import type { JSONSchema } from "@core/types";
import { useState } from "react";
import { JsonBlock } from "../components/ui";
import { appendPath } from "./ExpressionEditor";
export function DataView({ value, schema, root }: { value: unknown; schema?: JSONSchema; root: string }) {
  const [view, setView] = useState("Schema");
  const [copied, setCopied] = useState("");

  return (
    <div className="wf-data">
      <div className="wf-row">
        {["Schema", "Table", "JSON"].map((v) => (
          <button className="btn btn-ghost" aria-pressed={v === view} key={v} onClick={() => setView(v)}>
            {v}
          </button>
        ))}
      </div>
      {view === "JSON" ? (
        <JsonBlock value={value ?? schema ?? "No data yet"} />
      ) : view === "Table" ? (
        Array.isArray(value) && value.every((v) => v && typeof v === "object") ? (
          <div className="overflow-auto">
            <table>
              <thead>
                <tr>
                  {Object.keys(value[0] ?? {}).map((k) => (
                    <th key={k}>{k}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {value.map((row, i) => (
                  <tr key={i}>
                    {Object.keys(value[0] ?? {}).map((k) => (
                      <td key={k}>{JSON.stringify((row as Record<string, unknown>)[k])}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="wf-hint">No array of objects</p>
        )
      ) : (
        <div>
          <FieldTree schema={schema} value={value} path={root} label={root} onCopy={setCopied} />
          {copied && <p className="wf-hint">{copied === "Clipboard unavailable" ? copied : "Copied expression"}</p>}
        </div>
      )}
    </div>
  );
}

function FieldTree({
  schema,
  value,
  path,
  label,
  onCopy,
  depth = 0,
}: {
  schema?: JSONSchema;
  value: unknown;
  path: string;
  label: string;
  onCopy: (s: string) => void;
  depth?: number;
}) {
  const [open, setOpen] = useState(true);
  const object = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const keys = [...new Set([...Object.keys(schema?.properties ?? {}), ...Object.keys(object)])];
  const array = !!schema?.items || Array.isArray(value);
  const hasChildren = depth < 20 && (keys.length > 0 || array);
  const expr = `{{${path}}}`;
  const type = schema?.type ?? (array ? "array" : value === null ? "null" : typeof value === "undefined" ? "unknown" : typeof value);
  return (
    <div>
      <div className="wf-row">
        {hasChildren && (
          <button aria-label={`${open ? "Collapse" : "Expand"} ${label}`} aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? "−" : "+"}
          </button>
        )}
        <button
          className="wf-tree mono"
          draggable
          title={`Copy ${expr}`}
          onDragStart={(e) => {
            e.dataTransfer.setData("application/anvil-expression", expr);
            e.dataTransfer.setData("text/plain", expr);
          }}
          onClick={() =>
            void navigator.clipboard
              .writeText(expr)
              .then(() => onCopy(expr))
              .catch(() => onCopy("Clipboard unavailable"))
          }
        >
          {label} <span className="wf-hint">{String(type)}</span>
        </button>
      </div>
      {open && hasChildren && (
        <div style={{ paddingLeft: 16 }}>
          {keys.map((key) => (
            <FieldTree
              key={key}
              label={key}
              path={appendPath(path, /^[A-Za-z_$][\w$-]*$/.test(key) ? key : `[${JSON.stringify(key)}]`)}
              schema={schema?.properties?.[key]}
              value={object[key]}
              depth={depth + 1}
              onCopy={onCopy}
            />
          ))}
          {array && <FieldTree label="[0]" path={`${path}[0]`} schema={schema?.items} value={Array.isArray(value) ? value[0] : undefined} depth={depth + 1} onCopy={onCopy} />}
        </div>
      )}
    </div>
  );
}
