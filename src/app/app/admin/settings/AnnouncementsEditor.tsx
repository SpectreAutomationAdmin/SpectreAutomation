"use client";

// Announcements admin editor (2026-08-27) — Add / edit / publish /
// pin / unpublish / delete / audience. Calls the canonical
// /api/clubs/[id]/announcements endpoints so authorization + audit
// flow through the service layer.

import { useCallback, useState } from "react";
import type { AnnouncementView, AnnouncementAudience } from "@/lib/announcements";

interface Props {
  clubId: string;
  initialAnnouncements: AnnouncementView[];
}

export default function AnnouncementsEditor({ clubId, initialAnnouncements }: Props) {
  const [rows, setRows] = useState<AnnouncementView[]>(initialAnnouncements);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ tone: "ok" | "err" | "idle"; text: string }>({ tone: "idle", text: "" });
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const api = useCallback((path: string) => `/api/clubs/${clubId}/announcements${path}`, [clubId]);

  const refresh = async () => {
    const res = await fetch(api(""));
    if (!res.ok) return;
    const body = (await res.json()) as { announcements: AnnouncementView[] };
    setRows(body.announcements);
  };

  const create = async () => {
    setBusy(true);
    setStatus({ tone: "idle", text: "" });
    try {
      const res = await fetch(api(""), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audience: "EMPLOYEE",
          title: "New announcement",
          body: "Draft — update the title and body, then publish.",
          isPublished: false,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const created = (await res.json()) as { announcement: AnnouncementView };
      await refresh();
      setExpandedId(created.announcement.id);
      setStatus({ tone: "ok", text: "Draft created." });
    } catch (err) {
      setStatus({ tone: "err", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const patch = async (
    id: string,
    patch: {
      title?: string;
      body?: string;
      audience?: AnnouncementAudience;
      isPublished?: boolean;
      isPinned?: boolean;
      publishedAt?: string | null;
      expiresAt?: string | null;
    },
  ) => {
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
    if (!confirm("Remove this announcement? This cannot be undone.")) return;
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

  const publishedLabel = (a: AnnouncementView) => {
    if (!a.isPublished) return "Draft";
    if (a.publishedAt && a.publishedAt > new Date()) return `Scheduled ${formatDate(a.publishedAt)}`;
    if (a.expiresAt && a.expiresAt < new Date()) return `Expired ${formatDate(a.expiresAt)}`;
    return "Published";
  };

  return (
    <div className="space-y-4" data-testid="announcements-editor">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-serif text-lg text-club-ink">Fore! Announcements</h3>
          <p className="text-sm text-stone-600 mt-1">
            Post announcements to the Employee Portal Fore! card. Drafts are hidden until published;
            expired items disappear automatically. Pin an item to force it above other announcements.
          </p>
        </div>
        <button
          type="button"
          onClick={create}
          disabled={busy}
          className="spectre-btn spectre-btn-primary"
          data-testid="announcements-add"
        >
          + Add Announcement
        </button>
      </div>

      {rows.length === 0 && (
        <div className="text-sm text-stone-600" data-testid="announcements-empty">
          No announcements yet. When you publish one, employees will see it in the Fore! card on the Employee Portal.
        </div>
      )}

      <ul className="divide-y divide-stone-200/70">
        {rows.map((a) => (
          <li key={a.id} className="py-3" data-testid={`announcement-row-${a.id}`}>
            <div className="flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2 flex-wrap">
                  <button
                    type="button"
                    className="font-serif text-base text-club-ink hover:underline text-left truncate"
                    onClick={() => setExpandedId(expandedId === a.id ? null : a.id)}
                    data-testid={`announcement-toggle-${a.id}`}
                  >
                    {a.title || <span className="text-stone-400">Untitled</span>}
                  </button>
                  <StatusPill label={publishedLabel(a)} isDraft={!a.isPublished} isExpired={!!(a.expiresAt && a.expiresAt < new Date())} />
                  {a.isPinned && <span className="text-[10px] uppercase tracking-widest text-club-green-700 border border-club-green-700/40 rounded px-1.5 py-0.5">Pinned</span>}
                  <span className="text-[11px] text-stone-500">{audienceLabel(a.audience)}</span>
                </div>
                <p className="text-xs text-stone-500 mt-1">
                  Created {formatDateTime(a.createdAt)} · Last updated {formatDateTime(a.updatedAt)}
                </p>

                {expandedId === a.id && (
                  <div className="mt-3 space-y-3" data-testid={`announcement-form-${a.id}`}>
                    <label className="block text-sm">
                      <span className="text-club-ink">Title</span>
                      <input
                        type="text"
                        defaultValue={a.title}
                        className="spectre-input w-full mt-1"
                        onBlur={(e) => e.target.value.trim() !== a.title && patch(a.id, { title: e.target.value })}
                        data-testid={`announcement-title-${a.id}`}
                        maxLength={120}
                      />
                    </label>
                    <label className="block text-sm">
                      <span className="text-club-ink">Message</span>
                      <textarea
                        defaultValue={a.body}
                        className="spectre-input w-full mt-1 min-h-[100px]"
                        onBlur={(e) => e.target.value.trim() !== a.body && patch(a.id, { body: e.target.value })}
                        data-testid={`announcement-body-${a.id}`}
                        maxLength={4000}
                      />
                      <span className="text-[11px] text-stone-500">
                        Plain text. Line breaks are preserved on the portal card.
                      </span>
                    </label>
                    <div className="grid grid-cols-2 gap-3 text-sm">
                      <label className="block">
                        <span className="text-club-ink">Audience</span>
                        <select
                          className="spectre-input w-full mt-1"
                          defaultValue={a.audience}
                          onChange={(e) => patch(a.id, { audience: e.target.value as AnnouncementAudience })}
                          data-testid={`announcement-audience-${a.id}`}
                        >
                          <option value="EMPLOYEE">Employees</option>
                          <option value="MEMBER">Members</option>
                          <option value="BOTH">Employees &amp; Members</option>
                        </select>
                      </label>
                      <label className="block">
                        <span className="text-club-ink">Expires</span>
                        <input
                          type="date"
                          defaultValue={a.expiresAt ? toDateInput(a.expiresAt) : ""}
                          className="spectre-input w-full mt-1"
                          onBlur={(e) => {
                            const v = e.target.value;
                            if (!v) return patch(a.id, { expiresAt: null });
                            return patch(a.id, { expiresAt: new Date(v + "T23:59:59").toISOString() });
                          }}
                          data-testid={`announcement-expires-${a.id}`}
                        />
                        <span className="text-[11px] text-stone-500">
                          Optional. Blank = never expires.
                        </span>
                      </label>
                    </div>
                    <div className="flex items-center gap-3 flex-wrap">
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          className="spectre-check"
                          defaultChecked={a.isPinned}
                          onChange={(e) => patch(a.id, { isPinned: e.target.checked })}
                          data-testid={`announcement-pinned-${a.id}`}
                        />
                        <span>Pin to top</span>
                      </label>
                      {a.isPublished ? (
                        <button
                          type="button"
                          onClick={() => patch(a.id, { isPublished: false })}
                          disabled={busy}
                          className="spectre-btn spectre-btn--secondary"
                          data-testid={`announcement-unpublish-${a.id}`}
                        >
                          Unpublish
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => patch(a.id, { isPublished: true })}
                          disabled={busy}
                          className="spectre-btn spectre-btn-primary"
                          data-testid={`announcement-publish-${a.id}`}
                        >
                          Publish
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => remove(a.id)}
                disabled={busy}
                className="text-sm text-red-700 hover:underline shrink-0"
                data-testid={`announcement-remove-${a.id}`}
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
          data-testid="announcements-status"
        >
          {status.text}
        </div>
      )}
    </div>
  );
}

function StatusPill({ label, isDraft, isExpired }: { label: string; isDraft: boolean; isExpired: boolean }) {
  const color = isExpired
    ? "bg-stone-100 text-stone-500 border-stone-300"
    : isDraft
      ? "bg-amber-50 text-amber-800 border-amber-300"
      : "bg-emerald-50 text-emerald-800 border-emerald-300";
  return (
    <span className={`text-[10px] uppercase tracking-widest rounded px-1.5 py-0.5 border ${color}`}>
      {label}
    </span>
  );
}

function audienceLabel(a: AnnouncementAudience) {
  if (a === "EMPLOYEE") return "Employees";
  if (a === "MEMBER") return "Members";
  return "Employees & Members";
}

function formatDate(d: Date) {
  return new Date(d).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
function formatDateTime(d: Date) {
  return new Date(d).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}
function toDateInput(d: Date | string) {
  const dt = new Date(d);
  const yyyy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
