"use client";

// Employee Portal Quick Links admin editor (2026-08-27) — Add / edit
// / delete / reorder + upload PDF. Calls the canonical
// `/api/clubs/[id]/employee-portal-quick-links` endpoints so
// authorization + audit flow through the service layer.

import { useCallback, useState } from "react";
import type { QuickLinkView } from "@/lib/employee-portal/quick-links";

interface Props {
  clubId: string;
  initialLinks: QuickLinkView[];
}

export default function QuickLinksEditor({ clubId, initialLinks }: Props) {
  const [links, setLinks] = useState<QuickLinkView[]>(initialLinks);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ tone: "ok" | "err" | "idle"; text: string }>({ tone: "idle", text: "" });

  const api = useCallback((path: string) => `/api/clubs/${clubId}/employee-portal-quick-links${path}`, [clubId]);

  const refresh = async () => {
    const res = await fetch(api(""));
    if (!res.ok) return;
    const body = (await res.json()) as { links: QuickLinkView[] };
    setLinks(body.links);
  };

  const create = async () => {
    setBusy(true);
    setStatus({ tone: "idle", text: "" });
    try {
      const res = await fetch(api(""), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "New Quick Link", destinationType: "url", url: "https://example.com" }),
      });
      if (!res.ok) throw new Error(await res.text());
      await refresh();
      setStatus({ tone: "ok", text: "Added." });
    } catch (err) {
      setStatus({ tone: "err", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const patch = async (id: string, patch: Partial<QuickLinkView> & { url?: string | null }) => {
    setBusy(true);
    setStatus({ tone: "idle", text: "" });
    try {
      const res = await fetch(api(`/${id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(await res.text());
      await refresh();
      setStatus({ tone: "ok", text: "Saved." });
    } catch (err) {
      setStatus({ tone: "err", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    if (!confirm("Remove this Quick Link?")) return;
    setBusy(true);
    try {
      const res = await fetch(api(`/${id}`), { method: "DELETE" });
      if (!res.ok) throw new Error(await res.text());
      await refresh();
      setStatus({ tone: "ok", text: "Removed." });
    } catch (err) {
      setStatus({ tone: "err", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const move = async (id: string, dir: -1 | 1) => {
    const idx = links.findIndex((l) => l.id === id);
    if (idx < 0) return;
    const swap = idx + dir;
    if (swap < 0 || swap >= links.length) return;
    const next = [...links];
    [next[idx], next[swap]] = [next[swap]!, next[idx]!];
    setLinks(next);
    setBusy(true);
    try {
      const res = await fetch(api("/reorder"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderedIds: next.map((l) => l.id) }),
      });
      if (!res.ok) throw new Error(await res.text());
      await refresh();
    } catch (err) {
      setStatus({ tone: "err", text: (err as Error).message });
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const uploadFile = async (id: string, file: File) => {
    setBusy(true);
    try {
      const fd = new FormData();
      fd.set("file", file);
      const res = await fetch(api(`/${id}`), { method: "PUT", body: fd });
      if (!res.ok) throw new Error(await res.text());
      await refresh();
      setStatus({ tone: "ok", text: "File uploaded." });
    } catch (err) {
      setStatus({ tone: "err", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4" data-testid="quick-links-editor">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-serif text-lg text-club-ink">Quick Links</h3>
          <p className="text-sm text-stone-600 mt-1">
            Add up to 10 destinations that appear in the Employee Portal right rail (desktop) and mobile Quick Links strip.
          </p>
        </div>
        <button
          type="button"
          onClick={create}
          disabled={busy || links.length >= 10}
          className="spectre-btn spectre-btn-primary"
          data-testid="quick-links-add"
        >
          + Add Quick Link
        </button>
      </div>

      {links.length === 0 && (
        <div className="text-sm text-stone-600" data-testid="quick-links-empty">
          No Quick Links configured. The Employee Portal Quick Links card is hidden until at least one link is saved.
        </div>
      )}

      <ul className="divide-y divide-stone-200/70">
        {links.map((l, i) => (
          <li key={l.id} className="py-3" data-testid={`quick-link-row-${l.id}`}>
            <div className="flex items-start gap-3">
              <div className="flex flex-col gap-1">
                <button
                  type="button"
                  onClick={() => move(l.id, -1)}
                  disabled={busy || i === 0}
                  className="text-xs text-stone-500 hover:text-club-ink disabled:opacity-30"
                  aria-label="Move up"
                >▲</button>
                <button
                  type="button"
                  onClick={() => move(l.id, 1)}
                  disabled={busy || i === links.length - 1}
                  className="text-xs text-stone-500 hover:text-club-ink disabled:opacity-30"
                  aria-label="Move down"
                >▼</button>
              </div>
              <div className="flex-1 min-w-0 space-y-2">
                <label className="block text-sm">
                  <span className="text-club-ink">Label</span>
                  <input
                    type="text"
                    defaultValue={l.label}
                    className="spectre-input w-full mt-1"
                    onBlur={(e) => e.target.value !== l.label && patch(l.id, { label: e.target.value })}
                    data-testid={`quick-link-label-${l.id}`}
                  />
                </label>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <label className="block">
                    <span className="text-club-ink">Destination type</span>
                    <select
                      className="spectre-input w-full mt-1"
                      defaultValue={l.destinationType}
                      onChange={(e) => patch(l.id, { destinationType: e.target.value as "url" | "file" })}
                      data-testid={`quick-link-type-${l.id}`}
                    >
                      <option value="url">Web Link (URL)</option>
                      <option value="file">Uploaded PDF</option>
                    </select>
                  </label>
                  {l.destinationType === "url" ? (
                    <label className="block">
                      <span className="text-club-ink">URL</span>
                      <input
                        type="url"
                        defaultValue={l.url ?? ""}
                        placeholder="https://…  or  /internal/path"
                        className="spectre-input w-full mt-1"
                        onBlur={(e) => e.target.value !== l.url && patch(l.id, { url: e.target.value })}
                        data-testid={`quick-link-url-${l.id}`}
                      />
                    </label>
                  ) : (
                    <label className="block">
                      <span className="text-club-ink">
                        PDF file {l.fileOriginalName ? <span className="text-stone-500">({l.fileOriginalName})</span> : null}
                      </span>
                      <input
                        type="file"
                        accept="application/pdf"
                        onChange={(e) => e.target.files?.[0] && uploadFile(l.id, e.target.files[0])}
                        className="block w-full mt-1 text-sm"
                        data-testid={`quick-link-file-${l.id}`}
                      />
                    </label>
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={() => remove(l.id)}
                disabled={busy}
                className="text-sm text-red-700 hover:underline"
                data-testid={`quick-link-remove-${l.id}`}
              >
                Remove
              </button>
            </div>
          </li>
        ))}
      </ul>

      {status.text && (
        <div
          role={status.tone === "err" ? "alert" : "status"}
          className={"text-sm " + (status.tone === "ok" ? "text-emerald-700" : status.tone === "err" ? "text-red-700" : "text-stone-500")}
          data-testid="quick-links-status"
        >
          {status.text}
        </div>
      )}
    </div>
  );
}
