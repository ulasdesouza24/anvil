import type { AgentSpec, JSONSchema } from "@core/types";
import { useState } from "react";
import { Link } from "react-router-dom";
import { JsonValue } from "./ConfigForm";
export function SpecSettings({ spec, onChange, onClose, readOnly }: { spec: AgentSpec; onChange: (s: AgentSpec) => void; onClose: () => void; readOnly: boolean }) {
  const [json, setJson] = useState(false);
  const schema = spec.inputSchema;
  const props = schema.properties ?? {};
  const setSchema = (s: JSONSchema) => onChange({ ...spec, inputSchema: { ...s, type: "object" } });
  const changeField = (key: string, patch: JSONSchema) => setSchema({ ...schema, properties: { ...props, [key]: { ...props[key], ...patch } } });
  return (
    <aside className="wf-settings">
      <div className="wf-row">
        <h3>Workflow settings</h3>
        <button className="btn ml-auto" onClick={onClose}>
          Close
        </button>
      </div>
      <fieldset disabled={readOnly} inert={readOnly}>
        {(["name", "description"] as const).map((k) => (
          <label className="wf-field" key={k}>
            {k}
            <input className="input" value={spec[k]} onChange={(e) => onChange({ ...spec, [k]: e.target.value })} />
          </label>
        ))}
        <h3>Input schema</h3>
        <button className="btn" onClick={() => setJson(!json)}>
          {json ? "Edit fields" : "Edit as JSON"}
        </button>
        {json ? (
          <JsonValue
            value={schema}
            onChange={(v) => {
              if (v && typeof v === "object" && !Array.isArray(v)) setSchema(v as JSONSchema);
            }}
          />
        ) : (
          <>
            {Object.entries(props).map(([key, s]) => (
              <div className="wf-subform" key={key}>
                <label>
                  Field name
                  <input
                    className="input"
                    defaultValue={key}
                    onBlur={(e) => {
                      const name = e.target.value;
                      if (!name || name === key || name in props) return;
                      const next = { ...props };
                      delete next[key];
                      next[name] = s;
                      setSchema({ ...schema, properties: next, required: schema.required?.map((k) => (k === key ? name : k)) });
                    }}
                  />
                </label>
                <select aria-label="Field type" className="input" value={String(s.type ?? "string")} onChange={(e) => changeField(key, { type: e.target.value })}>
                  {["string", "number", "integer", "boolean", "object", "array"].map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
                <label>
                  <input
                    type="checkbox"
                    checked={schema.required?.includes(key) ?? false}
                    onChange={(e) => setSchema({ ...schema, required: e.target.checked ? [...(schema.required ?? []), key] : (schema.required ?? []).filter((k) => k !== key) })}
                  />{" "}
                  Required
                </label>
                <input
                  className="input"
                  aria-label="Field description"
                  placeholder="Description"
                  value={s.description ?? ""}
                  onChange={(e) => changeField(key, { description: e.target.value })}
                />
                <label>
                  Default (JSON)
                  <JsonValue value={s.default ?? null} onChange={(v) => changeField(key, { default: v })} />
                </label>
                <label>
                  Enum values (JSON)
                  <JsonValue
                    value={s.enum ?? []}
                    onChange={(v) => {
                      if (Array.isArray(v)) changeField(key, { enum: v.length ? v : undefined });
                    }}
                  />
                </label>
                <button
                  className="btn"
                  onClick={() => {
                    const next = { ...props };
                    delete next[key];
                    setSchema({ ...schema, properties: next, required: schema.required?.filter((k) => k !== key) });
                  }}
                >
                  Remove field
                </button>
              </div>
            ))}
            <button
              className="btn"
              onClick={() => {
                let key = "field";
                while (key in props) key += "_";
                changeField(key, { type: "string" });
              }}
            >
              Add field
            </button>
          </>
        )}
        <h3>Policy</h3>
        {(["maxCostUsd", "maxNodeExecutions", "timeoutMs", "maxPaidSearches"] as const).map((k) => (
          <label className="wf-field" key={k}>
            {k}
            <input
              className="input"
              type="number"
              min={0}
              value={spec.policy[k] ?? ""}
              onChange={(e) => onChange({ ...spec, policy: { ...spec.policy, [k]: e.target.value === "" ? undefined : Number(e.target.value) } })}
            />
          </label>
        ))}
        <label>
          <input
            type="checkbox"
            checked={spec.policy.requireApprovalForSideEffects}
            onChange={(e) => onChange({ ...spec, policy: { ...spec.policy, requireApprovalForSideEffects: e.target.checked } })}
          />{" "}
          Require approval for side effects
        </label>
        <h3>Output schema</h3>
        <JsonValue
          value={spec.outputSchema ?? {}}
          onChange={(v) => {
            if (v && typeof v === "object" && !Array.isArray(v)) onChange({ ...spec, outputSchema: v as JSONSchema });
          }}
        />
        <h3>Acceptance rules</h3>
        <JsonValue
          value={spec.acceptance ?? []}
          onChange={(v) => {
            if (Array.isArray(v)) onChange({ ...spec, acceptance: v as AgentSpec["acceptance"] });
          }}
        />
      </fieldset>
      <Link className="btn mt-4" to={`/agents/${spec.id}?tab=tests`}>
        {spec.tests.length} tests · Open Tests
      </Link>
    </aside>
  );
}
