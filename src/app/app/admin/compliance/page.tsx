import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { isAppError } from "@/lib/errors";
import { listReviews, startReview, listEvidence, generateEvidence } from "@/lib/compliance";
import { Badge } from "@/components/Badge";
import { formatDate } from "@/lib/finance";

async function startReviewAction(formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  try {
    await startReview(p, {
      clubId,
      scope: String(formData.get("scope")),
      title: String(formData.get("title") ?? `Access review — ${new Date().toISOString().slice(0, 10)}`),
    });
  } catch (err) {
    if (isAppError(err)) cookies().set("spectre_compliance_error", err.safeMessage, { httpOnly: true, sameSite: "strict", maxAge: 30 });
    else throw err;
  }
  revalidatePath("/app/admin/compliance");
}

async function generateEvidenceAction(formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  const periodEnd = new Date();
  const periodStart = new Date(periodEnd.getTime() - 30 * 86400_000);
  try {
    await generateEvidence(p, {
      clubId,
      kind: String(formData.get("kind")),
      label: `${formData.get("kind")} – last 30d`,
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
    });
  } catch (err) {
    if (isAppError(err)) cookies().set("spectre_compliance_error", err.safeMessage, { httpOnly: true, sameSite: "strict", maxAge: 30 });
    else throw err;
  }
  revalidatePath("/app/admin/compliance");
}

export default async function CompliancePage() {
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "users:roles:write") && !hasPermission(p, clubId, "system:audit:read")) {
    redirect("/app/admin");
  }
  const canRun = hasPermission(p, clubId, "users:roles:write");

  const [reviews, evidence] = await Promise.all([
    hasPermission(p, clubId, "users:roles:write") ? listReviews(p, clubId) : Promise.resolve([] as Awaited<ReturnType<typeof listReviews>>),
    hasPermission(p, clubId, "system:audit:read") ? listEvidence(p, clubId) : Promise.resolve([] as Awaited<ReturnType<typeof listEvidence>>),
  ]);
  const error = cookies().get("spectre_compliance_error")?.value;
  if (error) cookies().delete("spectre_compliance_error");

  return (
    <div>
      <h1 className="page-title">Compliance</h1>
      <p className="mt-1 text-stone-500">Periodic access reviews and audit-evidence snapshots for SOC 2 readiness.</p>
      {error && <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card overflow-hidden">
          <div className="px-6 py-4 border-b border-stone-200 flex items-center justify-between">
            <div className="font-medium">Access reviews</div>
            {canRun && (
              <form action={startReviewAction} className="flex items-center gap-2">
                <select name="scope" className="input text-xs">
                  <option value="USERS">USERS</option>
                  <option value="ROLES">ROLES</option>
                  <option value="API_KEYS">API_KEYS</option>
                  <option value="INSTALLED_APPS">INSTALLED_APPS</option>
                  <option value="SSO_PROVIDERS">SSO_PROVIDERS</option>
                </select>
                <input name="title" placeholder="Title" className="input text-xs" />
                <button className="btn btn-primary btn-sm">Start</button>
              </form>
            )}
          </div>
          <table className="table-base">
            <thead><tr><th>Title</th><th>Scope</th><th>Status</th><th>Items</th><th>Started</th><th></th></tr></thead>
            <tbody>
              {reviews.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-stone-500">No reviews yet.</td></tr>}
              {reviews.map((r) => (
                <tr key={r.id}>
                  <td>{r.title}</td>
                  <td className="text-xs">{r.scope}</td>
                  <td><Badge status={r.status} /></td>
                  <td className="text-xs">{r._count?.items ?? 0}</td>
                  <td className="text-xs">{formatDate(r.startedAt)}</td>
                  <td className="text-right">
                    <Link href={`/app/admin/compliance/${r.id}`} className="text-xs text-club-ink hover:underline">Open</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card overflow-hidden">
          <div className="px-6 py-4 border-b border-stone-200 flex items-center justify-between">
            <div className="font-medium">Compliance evidence (last 30d)</div>
            {hasPermission(p, clubId, "system:audit:read") && (
              <form action={generateEvidenceAction} className="flex items-center gap-2">
                <select name="kind" className="input text-xs">
                  <option value="AUDIT_LOG">AUDIT_LOG</option>
                  <option value="AUTH_ATTEMPT">AUTH_ATTEMPT</option>
                  <option value="ACCESS_REVIEW">ACCESS_REVIEW</option>
                  <option value="WEBHOOK_DELIVERY">WEBHOOK_DELIVERY</option>
                </select>
                <button className="btn btn-primary btn-sm">Generate</button>
              </form>
            )}
          </div>
          <table className="table-base">
            <thead><tr><th>Label</th><th>Kind</th><th>Rows</th><th>Generated</th></tr></thead>
            <tbody>
              {evidence.length === 0 && <tr><td colSpan={4} className="px-4 py-6 text-center text-stone-500">No evidence captured yet.</td></tr>}
              {evidence.map((e) => (
                <tr key={e.id}>
                  <td>{e.label}</td>
                  <td className="text-xs">{e.kind}</td>
                  <td className="text-xs">{e.rowCount}</td>
                  <td className="text-xs">{formatDate(e.generatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
