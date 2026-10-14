import type { Diagnostic, JSONSchema } from "@core/types";
import { useEffect, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { JsonEditor } from "../components/ui";
import { ExpressionEditor, type ExpressionContext } from "./ExpressionEditor";
export function JsonValue({ value, onChange, template = false }: { value: unknown; onChange: (v: unknown) => void; template?: boolean }) {
  const [text, setText] = useState(JSON.stringify(value, null, 2) ?? "");
  const [error, setError] = useState("");
  useEffect(() => {
    setText(JSON.stringify(value, null, 2) ?? "");
  }, [value]);
  return (
    <>
      <JsonEditor
        value={text}
        height="auto"
        minHeight="80px"
        onChange={(t) => {
          setText(t);
          try {
            const v = template && t.startsWith("{{") ? t : JSON.parse(t);
            onChange(v);
            setError("");
          } catch {
            setError("Enter valid JSON");
          }
        }}
      />
      {error && <div className="wf-error">{error}</div>}
    </>
  );
}
interface Props {
  schema: JSONSchema;
  value: Record<string, unknown>;
  onChange: (v: Record<string, unknown>) => void;
  context: ExpressionContext;
  type: string;
  diagnostics: Diagnostic[];
  path: string;
  secrets: string[];
  agents: { id: string; name: string }[];
}
export function ConfigForm(p: Props) {
  const [json, setJson] = useState(false);
  const properties = p.schema.properties ?? {};
  const unknown = Object.fromEntries(Object.entries(p.value).filter(([k]) => !Object.hasOwn(properties, k)));
  return (
    <div>
      <button className="btn mb-3" onClick={() => setJson(!json)}>
        {json ? "Form" : "JSON"}
      </button>
      {json ? (
        <JsonValue
          value={p.value}
          onChange={(v) => {
            if (v && typeof v === "object" && !Array.isArray(v)) p.onChange(v as Record<string, unknown>);
          }}
        />
      ) : (
        <>
          {Object.entries(properties).map(([name, schema]) => (
            <Field
              key={name}
              {...p}
              name={name}
              schema={schema}
              value={p.value[name]}
              required={p.schema.required?.includes(name)}
              onChange={(v) => p.onChange({ ...p.value, [name]: v })}
              path={`${p.path}/${name.replace(/~/g, "~0").replace(/\//g, "~1")}`}
            />
          ))}
          {Object.keys(unknown).length > 0 && (
            <details>
              <summary>Other keys</summary>
              <p className="wf-error">These keys are not in the config schema.</p>
              <JsonValue
                value={unknown}
                onChange={(v) => {
                  if (v && typeof v === "object" && !Array.isArray(v))
                    p.onChange({ ...Object.fromEntries(Object.entries(p.value).filter(([k]) => Object.hasOwn(properties, k))), ...v });
                }}
              />
            </details>
          )}
        </>
      )}
    </div>
  );
}
function Field(p: Omit<Props, "value" | "onChange"> & { name: string; value: unknown; onChange: (v: unknown) => void; required?: boolean }) {
  const { name, schema, value, onChange } = p;
  const detected = typeof value === "string" && value.includes("{{");
  const [mode, setMode] = useState(detected);
  useEffect(() => {
    if (detected) setMode(true);
  }, [detected]);
  const text = typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value);
  const type = schema.type;
  const object = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const perItem = p.type === "map" && ["prompt", "agentInput", "nodeConfig", "code"].includes(name);
  let control;
  if (mode) control = <ExpressionEditor value={text} onChange={onChange} context={{ ...p.context, perItem }} multiline={/prompt|system|task|instructions|text|body/.test(name)} />;
  else if (name === "code" && ["code", "map"].includes(p.type))
    control = (
      <>
        <p className="wf-hint">Read data as nodes.&lt;id&gt;.output.&lt;field&gt; and input.&lt;field&gt;</p>
        <CodeMirror theme="dark" value={text} onChange={onChange} extensions={[javascript()]} minHeight="180px" />
      </>
    );
  else if (schema.enum)
    control = (
      <select className="input" aria-label={name} value={JSON.stringify(value) ?? ""} onChange={(e) => onChange(JSON.parse(e.target.value))}>
        <option value="" disabled>
          Select a value
        </option>
        {schema.enum.map((v) => (
          <option key={JSON.stringify(v)} value={JSON.stringify(v)}>
            {String(v)}
          </option>
        ))}
      </select>
    );
  else if (type === "boolean")
    control = (
      <label>
        <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} /> {name}
      </label>
    );
  else if (type === "number" || type === "integer")
    control = (
      <input
        className="input"
        aria-label={name}
        type="number"
        min={schema.minimum as number}
        max={schema.maximum as number}
        step={type === "integer" ? 1 : "any"}
        value={value === undefined ? "" : String(value)}
        onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
      />
    );
  else if (type === "array") {
    const list = Array.isArray(value) ? value : [];
    control = (
      <div>
        {list.map((v, i) => (
          <div className="wf-subform" key={i}>
            <Field
              {...p}
              name={`${name} ${i + 1}`}
              schema={schema.items ?? {}}
              value={v}
              path={`${p.path}/${i}`}
              onChange={(next) => onChange(list.map((x, j) => (i === j ? next : x)))}
            />
            <div className="wf-row">
              <button className="btn" onClick={() => onChange(list.filter((_, j) => i !== j))}>
                Remove
              </button>
              {[-1, 1].map((d) => (
                <button
                  key={d}
                  className="btn"
                  disabled={i + d < 0 || i + d >= list.length}
                  onClick={() => {
                    const next = [...list];
                    [next[i], next[i + d]] = [next[i + d], next[i]];
                    onChange(next);
                  }}
                >
                  {d === -1 ? "Move up" : "Move down"}
                </button>
              ))}
            </div>
          </div>
        ))}
        <button className="btn" onClick={() => onChange([...list, schema.items?.default ?? (schema.items?.type === "object" ? {} : schema.items?.type === "number" ? 0 : "")])}>
          Add item
        </button>
      </div>
    );
  } else if (type === "object" && schema.properties)
    control = (
      <div className="wf-subform">
        {Object.entries(schema.properties).map(([k, s]) => (
          <Field
            {...p}
            key={k}
            name={k}
            schema={s}
            value={object[k]}
            required={schema.required?.includes(k)}
            path={`${p.path}/${k}`}
            onChange={(v) => onChange({ ...object, [k]: v })}
          />
        ))}
      </div>
    );
  else if (type === "object" && schema.additionalProperties)
    control = (
      <div>
        {Object.entries(object).map(([k, v]) => (
          <div className="wf-subform" key={k}>
            <div className="wf-row">
              <input
                className="input"
                aria-label="Key"
                defaultValue={k}
                onBlur={(e) => {
                  if (e.target.value === k) return;
                  const next = { ...object };
                  delete next[k];
                  next[e.target.value] = v;
                  onChange(next);
                }}
              />
              <button
                className="btn"
                onClick={() => {
                  const next = { ...object };
                  delete next[k];
                  onChange(next);
                }}
              >
                Remove
              </button>
            </div>
            <Field
              {...p}
              name={k}
              schema={typeof schema.additionalProperties === "object" ? schema.additionalProperties : {}}
              value={v}
              path={`${p.path}/${k}`}
              onChange={(v) => onChange({ ...object, [k]: v })}
            />
          </div>
        ))}
        <button
          className="btn"
          onClick={() => {
            let k = "key";
            while (k in object) k += "_";
            onChange({ ...object, [k]: "" });
          }}
        >
          Add key
        </button>
      </div>
    );
  else if (type === "string") {
    const list = /Secret$/.test(name) || name === "smtp" ? p.secrets : name === "agentId" ? p.agents.map((a) => a.id) : [];
    control = list.length ? (
      <>
        <input className="input" aria-label={name} list={`choices-${p.path}`} value={text} onChange={(e) => onChange(e.target.value)} />
        <datalist id={`choices-${p.path}`}>
          {list.map((v) => (
            <option key={v} value={v} />
          ))}
        </datalist>
      </>
    ) : /text|body|content|message|email|document|notes|description|prompt|context|html|question|request|review|feedback|system|task|instructions/i.test(
        `${name} ${schema.description}`,
      ) || text.length > 80 ? (
      <textarea className="input" aria-label={name} rows={4} value={text} onChange={(e) => onChange(e.target.value)} />
    ) : (
      <input className="input" aria-label={name} value={text} onChange={(e) => onChange(e.target.value)} />
    );
  } else control = <JsonValue value={value} onChange={onChange} template />;
  return (
    <div
      className="wf-field"
      data-field-path={p.path}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        const t = e.dataTransfer.getData("application/anvil-expression");
        if (!t) return;
        e.preventDefault();
        e.stopPropagation();
        const target = e.target as HTMLInputElement;
        const pos = typeof target.selectionStart === "number" ? target.selectionStart : text.length;
        onChange(text.slice(0, pos) + t + text.slice(pos));
        setMode(true);
      }}
    >
      <div className="wf-row">
        <label className="mono">
          {name}
          {p.required && <span title="Required"> *</span>}
        </label>
        <button
          className="btn btn-ghost ml-auto"
          onClick={() => {
            if (mode) {
              let fixed: unknown = text;
              try {
                if (type !== "string") fixed = JSON.parse(text);
                if (typeof fixed === "string" && fixed.includes("{{")) throw Error();
              } catch {
                if (!confirm("Keep this expression as a fixed value?")) return;
              }
              onChange(fixed);
            } else onChange(text);
            setMode(!mode);
          }}
        >
          {mode ? "Expression" : "Fixed"}
        </button>
      </div>
      {control}
      {schema.description && <p className="wf-hint">{schema.description}</p>}
      {p.diagnostics
        .filter((d) => d.path === p.path || d.path?.startsWith(p.path + "/"))
        .map((d, i) => (
          <p key={i} className={d.severity === "error" ? "wf-error" : "wf-hint"}>
            {d.message}
          </p>
        ))}
    </div>
  );
}
