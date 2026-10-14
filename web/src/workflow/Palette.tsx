import { useEffect, useMemo, useState } from "react";
import { Lock, X } from "lucide-react";
import type { NodeClassInfo } from "../lib/api";
import { CATEGORY, iconFor } from "../lib/categories";
export function Palette({ classes, onAdd, onClose }: { classes: NodeClassInfo[]; onAdd: (c: NodeClassInfo) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const items = useMemo(
    () =>
      classes
        .filter((c) => !c.internal && !c.type.startsWith("anvil_") && c.type !== "input" && `${c.type} ${c.title} ${c.description}`.toLowerCase().includes(query.toLowerCase()))
        .sort((a, b) => a.category.localeCompare(b.category)),
    [classes, query],
  );
  useEffect(() => {
    document.querySelector(".wf-palette [aria-selected=true]")?.scrollIntoView({ block: "nearest" });
  }, [index]);
  return (
    <aside className="wf-palette card" aria-label="Step palette">
      <div className="wf-row">
        <strong>Add a step</strong>
        <button className="btn ml-auto" title="Close palette" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      <input
        autoFocus
        className="input my-3"
        placeholder="Search steps"
        aria-label="Search steps"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setIndex(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setIndex((i) => Math.max(0, Math.min(items.length - 1, i + (e.key === "ArrowDown" ? 1 : -1))));
          }
          if (e.key === "Enter" && items[index]) onAdd(items[index]);
          if (e.key === "Escape") onClose();
        }}
      />
      <div role="listbox">
        {items.map((c, i) => {
          const Icon = iconFor(c.type);
          const cat = CATEGORY[c.category] ?? CATEGORY.custom;
          return (
            <div key={c.type}>
              {(i === 0 || items[i - 1].category !== c.category) && (
                <div className="label mt-3 mb-2" style={{ color: cat.color }}>
                  {cat.label}
                </div>
              )}
              <button
                role="option"
                aria-selected={index === i}
                className={`wf-palette-item ${index === i ? "active" : ""}`}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData("application/anvil-class", c.type);
                  e.dataTransfer.effectAllowed = "copy";
                }}
                onClick={() => onAdd(c)}
                title={[c.description, c.whenToUse].filter(Boolean).join("\n")}
              >
                <Icon size={17} style={{ color: cat.color }} />
                <span>
                  <strong>{c.title}</strong>
                  <small className="block wf-hint wf-clamp">{c.description}</small>
                </span>
                {c.custom && <small>library</small>}
                {c.custom?.approved === false && c.sideEffects && (
                  <span title="Approve it in the Node Library first">
                    <Lock size={13} />
                  </span>
                )}
              </button>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
