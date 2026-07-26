import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission, isSuperAdmin } from "@/lib/rbac";
import { listFlags, setFlag, FEATURE_FLAGS } from "@/lib/flags";
import { isAppError } from "@/lib/errors";
import { Badge } from "@/components/Badge";
import { formatDate } from "@/lib/finance";
import { prisma } from "@/lib/prisma";

async function setFlagAction(formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  try {
    const target = String(formData.get("target") ?? "");
    await setFlag(p, {
      clubId: target === "global" ? null : clubId,
      key: String(formData.get("key") ?? ""),
      name: String(formData.get("name") ?? ""),
      description: String(formData.get("description") ?? "") || null,
      isEnabled: formData.get("isEnabled") === "on",
      rolloutPercent: Number(formData.get("rolloutPercent") ?? 0),
    });
  } catch (err) { if (isAppError(err)) redirect(`/app/admin/pilot?error=${encodeURIComponent(err.safeMessage)}`); throw err; }
  revalidatePath("/app/admin/pilot");
}

export default async function PilotPage({ searchParams }: { searchParams: { error?: string } }) {
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "settings:read")) redirect("/app/admin");
  const canWrite = hasPermission(p, clubId, "settings:write");
  const isSuper = isSuperAdmin(p);

  const [flags, clubs, healthSnapshots] = await Promise.all([
    listFlags(p, clubId),
    isSuper ? prisma.club.findMany({ orderBy: { name: "asc" } }) : Promise.resolve([]),
    prisma.queueHealth.findMany({ orderBy: { observedAt: "desc" }, take: 6 }),
  ]);

  return (
    <div>
      <h1 className="page-title">Pilot & Feature Flags</h1>
      <p className="mt-1 text-stone-500">Roll out modules per club or globally. Hash-based rollout means a club always sees the same answer between requests.</p>

      {searchParams.error && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{searchParams.error}</div>
      )}

      <div className="mt-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 card overflow-hidden">
          <div className="px-6 py-4 border-b border-stone-200 font-medium">Feature flags</div>
          <table className="table-base">
            <thead><tr><th>Scope</th><th>Key</th><th>Name</th><th>Enabled</th><th>Rollout</th><th>Updated</th></tr></thead>
            <tbody>
              {flags.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-stone-500">No flags configured.</td></tr>}
              {flags.map((f) => (
                <tr key={f.id}>
                  <td className="text-xs">{f.clubId ? "club" : "global"}</td>
                  <td className="font-mono text-xs">{f.key}</td>
                  <td className="text-xs">{f.name}</td>
                  <td><Badge status={f.isEnabled ? "ENABLED" : "DISABLED"} /></td>
                  <td className="text-xs">{f.rolloutPercent}%</td>
                  <td className="text-xs">{formatDate(f.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {canWrite && (
          <form action={setFlagAction} className="card card-body space-y-3">
            <h2 className="section-title text-lg">Configure flag</h2>
            <div>
              <label className="label">Target</label>
              <select className="select" name="target" required>
                <option value="club">This club</option>
                {isSuper && <option value="global">Global (all clubs)</option>}
              </select>
            </div>
            <div>
              <label className="label">Key</label>
              <select className="select" name="key" required>
                {Object.entries(FEATURE_FLAGS).map(([label, key]) => (
                  <option key={key} value={key}>{label}</option>
                ))}
              </select>
            </div>
            <div><label className="label">Display name</label><input className="input" name="name" required /></div>
            <div><label className="label">Description</label><textarea className="input" name="description" rows={2} /></div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="isEnabled" defaultChecked /> Enabled
            </label>
            <div>
              <label className="label">Rollout %</label>
              <input className="input" type="number" min="0" max="100" name="rolloutPercent" defaultValue={100} />
            </div>
            <button className="btn btn-primary">Save flag</button>
          </form>
        )}
      </div>

      {isSuper && (
        <div className="mt-8 card overflow-hidden">
          <div className="px-6 py-4 border-b border-stone-200 font-medium">All clubs ({clubs.length})</div>
          <table className="table-base">
            <thead><tr><th>Name</th><th>Slug</th><th>Region</th><th>Created</th></tr></thead>
            <tbody>
              {clubs.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td className="text-xs font-mono">{c.slug}</td>
                  <td className="text-xs">{c.region ?? "—"}</td>
                  <td className="text-xs">{formatDate(c.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {healthSnapshots.length > 0 && (
        <div className="mt-8 card card-body">
          <h2 className="section-title text-lg">Latest queue health</h2>
          <div className="mt-3 grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
            {healthSnapshots.map((h) => (
              <div key={h.id} className="rounded-md bg-stone-50 px-3 py-2">
                <div className="font-mono text-xs">{h.queue}</div>
                <div className="text-xs text-stone-500">depth {h.queueDepth} · failed1h {h.failedLastHour} · dl {h.deadLetterCount}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

void Link;
