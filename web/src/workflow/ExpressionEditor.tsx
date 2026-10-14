import CodeMirror from "@uiw/react-codemirror";
import { autocompletion, type CompletionContext } from "@codemirror/autocomplete";
import { Decoration, EditorView, ViewPlugin } from "@codemirror/view";
import { extractRefs, parseExpr, resolveString, getPath, TEMPLATE_FILTERS, TEMPLATE_ROOTS, type Scope } from "@core/template";
import type { JSONSchema } from "@core/types";
import { useMemo, useState } from "react";
export interface ExpressionContext {
  scope: Scope;
  ancestors: Set<string>;
  schemas: Record<string, JSONSchema>;
  perItem?: boolean;
}
export const appendPath = (root: string, path: string) => root + (path.startsWith("[") ? "" : ".") + path;
export function fieldPaths(schema: JSONSchema | undefined, value: unknown, prefix = "", depth = 0): string[] {
  const keys = new Set([...Object.keys(schema?.properties ?? {}), ...(value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [])]);
  const result: string[] = [];
  if (depth > 8) return result;
  for (const k of keys) {
    const segment = /^[A-Za-z_$][\w$-]*$/.test(k) ? k : `[${JSON.stringify(k)}]`;
    const path = prefix ? appendPath(prefix, segment) : segment;
    result.push(path);
    result.push(...fieldPaths(schema?.properties?.[k], getPath(value, [k]), path, depth + 1));
  }
  if (schema?.items || Array.isArray(value)) {
    const path = `${prefix}[0]`;
    result.push(path, ...fieldPaths(schema?.items, Array.isArray(value) ? value[0] : undefined, path, depth + 1));
  }
  return result;
}
export function ExpressionEditor({
  value,
  onChange,
  context,
  multiline = false,
}: {
  value: string;
  onChange: (v: string) => void;
  context: ExpressionContext;
  multiline?: boolean;
}) {
  const [large, setLarge] = useState(false);
  const extensions = useMemo(() => {
    const options = [
      ...TEMPLATE_ROOTS.filter((r) => r === "input" || r === "nodes" || (context.perItem && (r === "item" || r === "index"))),
      ...fieldPaths(context.schemas.input, context.scope.input).map((p) => appendPath("input", p)),
    ];
    for (const id of context.ancestors) {
      options.push(`nodes.${id}`, `nodes.${id}.output`);
      const data = (context.scope.nodes as Record<string, { output: unknown }> | undefined)?.[id]?.output;
      options.push(...fieldPaths(context.schemas[id], data).map((p) => appendPath(`nodes.${id}.output`, p)));
    }
    const complete = (c: CompletionContext) => {
      const before = c.state.doc.sliceString(0, c.pos);
      if (before.lastIndexOf("{{") <= before.lastIndexOf("}}")) return null;
      const word = c.matchBefore(/[\w.\[\]]*/);
      return {
        from: word?.from ?? c.pos,
        options: (/\|\s*\w*$/.test(before) ? TEMPLATE_FILTERS : options).map((label) => ({ label, type: "variable" })).concat([{ label: '?? "fallback"', type: "keyword" }]),
      };
    };
    const marks = (view: EditorView) => {
      const text = view.state.doc.toString();
      const ranges = [];
      for (const m of text.matchAll(/\{\{[\s\S]*?\}\}/g)) {
        const bad = extractRefs(m[0]).refs.some((r) => r.nodeId && !context.ancestors.has(r.nodeId));
        ranges.push(
          Decoration.mark({ class: bad ? "wf-ref-bad" : "wf-expression", attributes: bad ? { title: "not upstream of this step" } : {} }).range(m.index!, m.index! + m[0].length),
        );
      }
      return Decoration.set(ranges);
    };
    return [
      EditorView.lineWrapping,
      autocompletion({ override: [complete] }),
      ViewPlugin.fromClass(
        class {
          decorations;
          constructor(v: EditorView) {
            this.decorations = marks(v);
          }
          update(u: import("@codemirror/view").ViewUpdate) {
            if (u.docChanged) this.decorations = marks(u.view);
          }
        },
        { decorations: (v) => v.decorations },
      ),
    ];
  }, [context]);
  let preview = "no data yet: run the workflow";
  let error = false;
  try {
    const refs = extractRefs(value);
    if (refs.issues.length) throw Error(refs.issues[0].message);
    for (const m of value.matchAll(/\{\{([\s\S]*?)\}\}/g)) parseExpr(m[1]);
    const resolved = resolveString(value, context.scope);
    if (resolved !== undefined && (!refs.refs.length || Object.keys((context.scope.nodes as object) ?? {}).length || context.scope.input !== undefined))
      preview = `${Array.isArray(resolved) ? "array" : typeof resolved}: ${(typeof resolved === "string" ? resolved : JSON.stringify(resolved))?.slice(0, 300)}`;
  } catch (e) {
    preview = (e as Error).message;
    error = true;
  }
  const editor = (expanded: boolean) => (
    <CodeMirror
      value={value}
      onChange={onChange}
      theme="dark"
      extensions={extensions}
      minHeight={expanded ? "50vh" : multiline ? "110px" : "34px"}
      basicSetup={{ lineNumbers: expanded || multiline, foldGutter: false }}
      onCreateEditor={(view) => {
        view.dom.addEventListener("drop", (e) => {
          const text = (e as DragEvent).dataTransfer?.getData("application/anvil-expression");
          if (text) {
            e.preventDefault();
            e.stopPropagation();
            const pos = view.posAtCoords({ x: (e as DragEvent).clientX, y: (e as DragEvent).clientY }) ?? view.state.selection.main.head;
            view.dispatch({ changes: { from: pos, insert: text } });
          }
        });
      }}
    />
  );
  return (
    <div>
      {editor(false)}
      <div className={error ? "wf-error" : "wf-hint"}>{preview}</div>
      <button className="btn btn-ghost" onClick={() => setLarge(true)}>
        Expand editor
      </button>
      {large && (
        <div className="wf-overlay">
          <section className="card wf-dialog">
            {editor(true)}
            <button className="btn" onClick={() => setLarge(false)}>
              Done
            </button>
          </section>
        </div>
      )}
    </div>
  );
}
