import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission, isSuperAdmin } from "@/lib/rbac";
import { isAppError } from "@/lib/errors";
import { listIncidents, openIncident, listTickets, openTicket, listKnownIssues } from "@/lib/incidents";
import { Badge } from "@/components/Badge";
import { formatDate } from "@/lib/finance";

async function openIncidentAction(formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  try {
    await openIncident(p, {
      clubId,
      title: String(formData.get("title") ?? ""),
      severity: String(formData.get("severity") ?? "SEV3") as "SEV1" | "SEV2" | "SEV3" | "SEV4",
      description: String(formData.get("description") ?? "") || undefined,
    });
  } catch (err) {
    if (isAppError(err)) cookies().set("spectre_support_error", err.safeMessage, { httpOnly: true, sameSite: "strict", maxAge: 30 });
    else throw err;
  }
  revalidatePath("/app/admin/support");
}

async function openTicketAction(formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  try {
    await openTicket(p, {
      clubId,
      title: String(formData.get("title") ?? ""),
      severity: String(formData.get("severity") ?? "NORMAL") as "LOW" | "NORMAL" | "HIGH" | "URGENT",
      category: String(formData.get("category") ?? "") || undefined,
      description: String(formData.get("description") ?? "") || undefined,
    });
  } catch (err) {
    if (isAppError(err)) cookies().set("spectre_support_error", err.safeMessage, { httpOnly: true, sameSite: "strict", maxAge: 30 });
    else throw err;
  }
  revalidatePath("/app/admin/support");
}

export default async function SupportPage() {
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "system:audit:read")) redirect("/app/admin");
  const [incidents, tickets, knownIssues] = await Promise.all([
    listIncidents(p, clubId).catch(() => []),
    listTickets(p, clubId).catch(() => []),
    listKnownIssues(),
  ]);
  const error = cookies().get("spectre_support_error")?.value;
  if (error) cookies().delete("spectre_support_error");

  return (
    <div>
      <h1 className="page-title">Support &amp; incidents</h1>
      <p className="mt-1 text-stone-500">Track incidents, support tickets, and platform-wide known issues.</p>
      {error && <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      {knownIssues.length > 0 && (
        <div className="mt-4 card card-body bg-amber-50 border-amber-200">
          <h2 className="section-title text-base text-amber-900">Platform notices</h2>
          <ul className="mt-2 text-sm space-y-1">
            {knownIssues.map((k) => (
              <li key={k.id}><Badge status={k.severity} /> <span className="font-medium">{k.title}</span> — {k.description}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card overflow-hidden">
          <div className="px-6 py-4 border-b border-stone-200 flex items-center justify-between">
            <div className="font-medium">Incidents</div>
            <details>
              <summary className="text-xs text-stone-500 cursor-pointer">+ Open</summary>
              <form action={openIncidentAction} className="mt-2 flex flex-col gap-1">
                <input name="title" required maxLength={200} placeholder="Title" className="input text-xs" />
                <select name="severity" className="input text-xs"><option>SEV1</option><option>SEV2</option><option defaultValue="SEV3">SEV3</option><option>SEV4</option></select>
                <textarea name="description" maxLength={8000} placeholder="Description" className="input text-xs" rows={2} />
                <button className="btn btn-primary btn-sm">Open</button>
              </form>
            </details>
          </div>
          <table className="table-base">
            <thead><tr><th>Title</th><th>Sev</th><th>Status</th><th>Detected</th></tr></thead>
            <tbody>
              {incidents.length === 0 && <tr><td colSpan={4} className="px-4 py-6 text-center text-stone-500">No incidents.</td></tr>}
              {incidents.map((i) => (
                <tr key={i.id}>
                  <td>{i.title}</td>
                  <td className="text-xs">{i.severity}</td>
                  <td><Badge status={i.status} /></td>
                  <td className="text-xs">{formatDate(i.detectedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card overflow-hidden">
          <div className="px-6 py-4 border-b border-stone-200 flex items-center justify-between">
            <div className="font-medium">Support tickets</div>
            <details>
              <summary className="text-xs text-stone-500 cursor-pointer">+ Open</summary>
              <form action={openTicketAction} className="mt-2 flex flex-col gap-1">
                <input name="title" required maxLength={200} placeholder="Title" className="input text-xs" />
                <select name="severity" className="input text-xs"><option>LOW</option><option defaultValue="NORMAL">NORMAL</option><option>HIGH</option><option>URGENT</option></select>
                <input name="category" placeholder="Category (optional)" className="input text-xs" />
                <textarea name="description" maxLength={8000} placeholder="Description" className="input text-xs" rows={2} />
                <button className="btn btn-primary btn-sm">Open</button>
              </form>
            </details>
          </div>
          <table className="table-base">
            <thead><tr><th>Title</th><th>Severity</th><th>Status</th><th>Opened</th></tr></thead>
            <tbody>
              {tickets.length === 0 && <tr><td colSpan={4} className="px-4 py-6 text-center text-stone-500">No tickets.</td></tr>}
              {tickets.map((t) => (
                <tr key={t.id}>
                  <td>{t.title}</td>
                  <td className="text-xs">{t.severity}</td>
                  <td><Badge status={t.status} /></td>
                  <td className="text-xs">{formatDate(t.openedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {isSuperAdmin(p) && (
        <div className="mt-6 text-sm">
          <Link href="/app/admin/support/access" className="text-club-ink hover:underline">Support access grants →</Link>
        </div>
      )}
    </div>
  );
}
