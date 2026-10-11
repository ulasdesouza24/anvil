import { Wrench } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { CustomClassesSection } from "../components/CustomClasses";
import { JsonBlock, Spinner } from "../components/ui";
import { api, type NodeClassInfo } from "../lib/api";
import { CATEGORY, iconFor } from "../lib/categories";

type Props = { properties?: Record<string, { type?: string | string[]; description?: string; enum?: unknown[]; default?: unknown }>; required?: string[] };

function ConfigTable({ schema }: { schema: Record<string, unknown> }) {
  const s = schema as Props;
  const entries = Object.entries(s.properties ?? {});
  if (!entries.length) return <div className="text-[11.5px] text-[var(--color-faint)]">No configuration.</div>;
  return (
    <div className="space-y-1">
      {entries.map(([k, v]) => (
        <div key={k} className="grid grid-cols-[130px_1fr] gap-3 text-[11.5px]">
          <span className="mono truncate">
            {k}
            {s.required?.includes(k) ? <span className="text-[var(--color-ember)]">*</span> : ""}
            <span className="ml-1 text-[var(--color-faint)]">{Array.isArray(v.type) ? v.type.join("|") : (v.type ?? (v.enum ? "enum" : "any"))}</span>
          </span>
          <span className="text-[var(--color-muted)]">
            {v.description ?? ""}
            {v.enum && <span className="mono ml-1 text-[var(--color-faint)]">[{v.enum.map(String).join(", ")}]</span>}
            {v.default !== undefined && <span className="mono ml-1 text-[var(--color-faint)]">= {JSON.stringify(v.default)}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}

export function LibraryPage() {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.registry>> | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const reload = useCallback(() => {
    api
      .registry()
      .then(setData)
      .catch(() => undefined);
  }, []);
  useEffect(reload, [reload]);
  if (!data)
    return (
      <div className="p-8">
        <Spinner />
      </div>
    );
  const groups = Object.keys(CATEGORY)
    .map((cat) => ({ cat, items: data.classes.filter((c) => c.category === cat && !c.custom) }))
    .filter((g) => g.items.length);

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-[1200px] px-8 py-8">
        <h1 className="text-[22px] font-bold tracking-tight">Node Library</h1>
        <p className="mt-1 max-w-[760px] text-[13px] text-[var(--color-muted)]">
          The typed classes agents are composed from. Each class declares a config schema, output schema, ports and guidance — this manifest is exactly what the builder reads when
          it designs and compiles an agent. {data.classes.filter((c) => !c.internal && !c.custom).length} built-in classes, {data.classes.filter((c) => c.custom).length} custom
          classes, {data.classes.filter((c) => c.internal).length} meta-classes used by the builder itself.
        </p>
        <CustomClassesSection onChanged={reload} />
        {groups.map(({ cat, items }) => (
          <section key={cat} className="mt-8">
            <div className="mb-3 flex items-center gap-2">
              <span className="h-2 w-2 rounded-full" style={{ background: CATEGORY[cat].color }} />
              <h2 className="text-[13px] font-semibold">{CATEGORY[cat].label}</h2>
            </div>
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {items.map((c: NodeClassInfo) => {
                const Icon = iconFor(c.type);
                const isOpen = open === c.type;
                return (
                  <div key={c.type} className="card p-4">
                    <button className="flex w-full items-start gap-3 text-left" onClick={() => setOpen(isOpen ? null : c.type)}>
                      <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg" style={{ background: CATEGORY[cat].bg, color: CATEGORY[cat].color }}>
                        <Icon size={16} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-[13.5px] font-semibold">{c.title}</span>
                          <span className="mono text-[11px] text-[var(--color-faint)]">{c.type}</span>
                        </div>
                        <p className="mt-1 text-[12px] leading-snug text-[var(--color-muted)]">{c.description}</p>
                        <p className="mt-1.5 text-[11.5px] leading-snug text-[var(--color-faint)]">
                          <span className="text-[var(--color-muted)]">When:</span> {c.whenToUse}
                        </p>
                      </div>
                    </button>
                    {isOpen && (
                      <div className="mt-3 space-y-3 border-t border-[var(--color-line)] pt-3">
                        <div>
                          <div className="label mb-1.5">Config</div>
                          <ConfigTable schema={c.configSchema} />
                        </div>
                        <div>
                          <div className="label mb-1.5">Example</div>
                          <JsonBlock value={c.example} />
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        ))}
        <section className="mt-10">
          <div className="mb-3 flex items-center gap-2">
            <Wrench size={14} className="text-[var(--color-muted)]" />
            <h2 className="text-[13px] font-semibold">Tools available to the Tool Agent node</h2>
          </div>
          <div className="card divide-y divide-[var(--color-line)]">
            {data.tools.map((t) => (
              <div key={t.name} className="flex items-baseline gap-4 px-4 py-2.5 text-[12.5px]">
                <span className="mono w-40 shrink-0">{t.name}</span>
                <span className="text-[var(--color-muted)]">{t.description}</span>
                {t.sideEffects && <span className="ml-auto shrink-0 rounded bg-[rgba(251,113,133,0.12)] px-1.5 text-[10.5px] text-[#fb7185]">side effects</span>}
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
