import { Store, X } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type StoredAgent } from "../lib/api";
import { useSession } from "../lib/session";
import { Spinner } from "./ui";

/** Shares a version of an agent in the Agent Bazaar under the username (docs/BAZAAR.md). */
export function ShareDialog({ agent, version, onClose }: { agent: StoredAgent; version: number; onClose: () => void }) {
  const nav = useNavigate();
  const { me } = useSession();
  const spec = agent.versions.find((v) => v.version === version)?.spec;
  const [title, setTitle] = useState(agent.name);
  const [description, setDescription] = useState(spec?.description ?? agent.description ?? "");
  const [tags, setTags] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const share = async () => {
    setBusy(true);
    setErr("");
    try {
      const l = await api.shareAgent({
        agentId: agent.id,
        version,
        title,
        description,
        tags: tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      });
      nav(`/bazaar/${l.id}`);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Share to the Agent Bazaar" className="card w-full max-w-[560px] p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2">
          <Store size={16} className="text-[var(--color-ember)]" />
          <h2 className="text-[15px] font-semibold">Share to the Agent Bazaar</h2>
          <button className="btn btn-ghost ml-auto" title="Close" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
        <p className="mt-2 text-[12.5px] leading-relaxed text-[var(--color-muted)]">
          Other users see v{version} under <span className="mono text-[var(--color-ember)]">@{me?.account?.username ?? "local"}</span> and can add a copy to their agents. The share
          has the steps and the library classes. It has no secrets, no tests, and no run data. A new share of this agent updates the listing.
        </p>
        <label className="mt-4 block">
          <span className="label mb-1.5 block">Title</span>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} />
        </label>
        <label className="mt-3 block">
          <span className="label mb-1.5 block">Description</span>
          <textarea
            className="input h-28"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={2000}
            placeholder="What the agent does, and what input it needs"
          />
        </label>
        <label className="mt-3 block">
          <span className="label mb-1.5 block">Tags (comma-separated)</span>
          <input className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="finance, report, email" />
        </label>
        {err && <div className="mt-3 text-[12.5px] text-[var(--color-bad)]">{err}</div>}
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || title.trim().length < 3} onClick={() => void share()}>
            {busy ? <Spinner /> : <Store size={14} />} Share
          </button>
        </div>
      </div>
    </div>
  );
}
