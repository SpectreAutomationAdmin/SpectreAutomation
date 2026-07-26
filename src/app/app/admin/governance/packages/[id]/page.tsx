import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { isAppError } from "@/lib/errors";
import { packageService } from "@/lib/enterprise";
import { Badge } from "@/components/Badge";
import { formatDate } from "@/lib/finance";

async function addSectionAction(packageId: string, formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try {
    await packageService.addSection(p, packageId, {
      title: String(formData.get("title") ?? ""),
      kind: (formData.get("kind") as "REPORT" | "NARRATIVE" | "KPI_GRID" | "COMMENTARY") ?? "REPORT",
      reportDefinitionKey: String(formData.get("reportDefinitionKey") ?? "") || null,
      body: String(formData.get("body") ?? "") || null,
      sortOrder: Number(formData.get("sortOrder") ?? 0),
    });
  } catch (err) { if (isAppError(err)) redirect(`/app/admin/governance/packages/${packageId}?error=${encodeURIComponent(err.safeMessage)}`); throw err; }
  revalidatePath(`/app/admin/governance/packages/${packageId}`);
}

async function addCommentaryAction(packageId: string, formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try {
    await packageService.addCommentary(p, packageId, {
      subject: String(formData.get("subject") ?? ""),
      scope: (formData.get("scope") as "GENERAL" | "VARIANCE" | "DEPARTMENT" | "ACTION_PLAN" | "RISK") ?? "GENERAL",
      body: String(formData.get("body") ?? ""),
    });
  } catch (err) { if (isAppError(err)) redirect(`/app/admin/governance/packages/${packageId}?error=${encodeURIComponent(err.safeMessage)}`); throw err; }
  revalidatePath(`/app/admin/governance/packages/${packageId}`);
}

async function submitAction(packageId: string) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try { await packageService.submitForApproval(p, packageId); }
  catch (err) { if (isAppError(err)) redirect(`/app/admin/governance/packages/${packageId}?error=${encodeURIComponent(err.safeMessage)}`); throw err; }
  revalidatePath(`/app/admin/governance/packages/${packageId}`);
}

async function approveAction(packageId: string) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try { await packageService.approvePackage(p, packageId); }
  catch (err) { if (isAppError(err)) redirect(`/app/admin/governance/packages/${packageId}?error=${encodeURIComponent(err.safeMessage)}`); throw err; }
  revalidatePath(`/app/admin/governance/packages/${packageId}`);
}

async function distributeAction(packageId: string, formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try {
    await packageService.recordDistribution(p, packageId, {
      recipientName: String(formData.get("recipientName") ?? ""),
      recipientEmail: String(formData.get("recipientEmail") ?? ""),
      channel: (formData.get("channel") as "EMAIL" | "PORTAL" | "DOWNLOAD") ?? "EMAIL",
    });
  } catch (err) { if (isAppError(err)) redirect(`/app/admin/governance/packages/${packageId}?error=${encodeURIComponent(err.safeMessage)}`); throw err; }
  revalidatePath(`/app/admin/governance/packages/${packageId}`);
}

export default async function PackageDetailPage({ params, searchParams }: { params: { id: string }; searchParams: { error?: string } }) {
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  let pkg;
  try { pkg = await packageService.getPackage(p, params.id); }
  catch { notFound(); }
  const canWrite = hasPermission(p, pkg.clubId, "packages:write") && (pkg.status === "DRAFT" || pkg.status === "IN_REVIEW");
  const canApprove = hasPermission(p, pkg.clubId, "packages:approve");
  const canDistribute = hasPermission(p, pkg.clubId, "packages:distribute");

  return (
    <div>
      <Link href="/app/admin/governance/packages" className="text-sm text-stone-500 hover:text-club-ink">← Packages</Link>
      <div className="mt-3 flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="page-title">{pkg.name} <span className="text-base text-stone-500 font-normal">v{pkg.version}</span></h1>
          <div className="mt-2 flex items-center gap-2 text-sm">
            <Badge status={pkg.status} /> · {pkg.periodLabel} · as of {formatDate(pkg.asOfDate)} · {pkg.audience}
          </div>
        </div>
        <div className="text-right text-sm space-x-2">
          {canWrite && pkg.status === "DRAFT" && (
            <form action={submitAction.bind(null, pkg.id)} className="inline"><button className="btn btn-secondary">Submit for approval</button></form>
          )}
          {canApprove && (pkg.status === "IN_REVIEW" || pkg.status === "DRAFT") && (
            <form action={approveAction.bind(null, pkg.id)} className="inline"><button className="btn btn-primary">Approve & finalize</button></form>
          )}
        </div>
      </div>

      {searchParams.error && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{searchParams.error}</div>
      )}

      {pkg.executiveSummary && (
        <div className="mt-6 card card-body">
          <h2 className="section-title text-lg">Executive Summary</h2>
          <p className="mt-2 whitespace-pre-wrap text-stone-700">{pkg.executiveSummary}</p>
        </div>
      )}

      <div className="mt-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <div className="card overflow-hidden">
            <div className="px-6 py-4 border-b border-stone-200 font-medium">Sections ({pkg.sections.length})</div>
            <div className="divide-y divide-stone-200">
              {pkg.sections.length === 0 && <div className="px-6 py-6 text-center text-stone-500">No sections yet.</div>}
              {pkg.sections.map((s) => (
                <div key={s.id} className="px-6 py-4">
                  <div className="flex items-center justify-between">
                    <div className="font-medium">{s.title}</div>
                    <div className="text-xs text-stone-500">{s.kind}{s.reportRun ? ` · ${s.reportRun.definition.name}` : ""}</div>
                  </div>
                  {s.body && <p className="mt-2 text-sm text-stone-600 whitespace-pre-wrap">{s.body}</p>}
                  {s.reportRun && (
                    <div className="mt-2 text-xs text-stone-500">
                      Snapshot: {s.reportRun.rowCount} rows · run at {formatDate(s.reportRun.startedAt)} · status {s.reportRun.status}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="card overflow-hidden">
            <div className="px-6 py-4 border-b border-stone-200 font-medium">Management commentary ({pkg.commentaries.length})</div>
            <div className="divide-y divide-stone-200">
              {pkg.commentaries.length === 0 && <div className="px-6 py-6 text-center text-stone-500">No commentary yet.</div>}
              {pkg.commentaries.map((c) => (
                <div key={c.id} className="px-6 py-4">
                  <div className="flex items-center justify-between">
                    <div className="font-medium">{c.subject}</div>
                    <div className="text-xs text-stone-500">{c.scope} · {c.status}</div>
                  </div>
                  <p className="mt-2 text-sm text-stone-700 whitespace-pre-wrap">{c.body}</p>
                  {c.followUpDate && <div className="mt-2 text-xs text-amber-700">Follow-up: {formatDate(c.followUpDate)}</div>}
                </div>
              ))}
            </div>
          </div>

          <div className="card overflow-hidden">
            <div className="px-6 py-4 border-b border-stone-200 font-medium">Distribution ({pkg.distributions.length})</div>
            <table className="table-base">
              <thead><tr><th>Recipient</th><th>Channel</th><th>Status</th><th>Sent</th></tr></thead>
              <tbody>
                {pkg.distributions.length === 0 && <tr><td colSpan={4} className="px-4 py-6 text-center text-stone-500">Not yet distributed.</td></tr>}
                {pkg.distributions.map((d) => (
                  <tr key={d.id}>
                    <td>{d.recipientName} <span className="text-xs text-stone-500">· {d.recipientEmail}</span></td>
                    <td className="text-xs">{d.channel}</td>
                    <td className="text-xs"><Badge status={d.status} /></td>
                    <td className="text-xs">{d.sentAt ? formatDate(d.sentAt) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="space-y-4">
          {canWrite && (
            <form action={addSectionAction.bind(null, pkg.id)} className="card card-body space-y-3">
              <h2 className="section-title text-lg">Add section</h2>
              <div><label className="label">Title</label><input className="input" name="title" required maxLength={160} /></div>
              <div>
                <label className="label">Kind</label>
                <select className="select" name="kind">
                  <option value="REPORT">Report snapshot</option>
                  <option value="NARRATIVE">Narrative</option>
                  <option value="KPI_GRID">KPI grid</option>
                  <option value="COMMENTARY">Commentary block</option>
                </select>
              </div>
              <div>
                <label className="label">Report key (if REPORT)</label>
                <select className="select" name="reportDefinitionKey">
                  <option value="">— None —</option>
                  <option value="trial_balance">Trial Balance</option>
                  <option value="balance_sheet">Balance Sheet</option>
                  <option value="income_statement">Income Statement</option>
                  <option value="department_pnl">Department P&L</option>
                  <option value="ap_aging">AP Aging</option>
                  <option value="ar_aging">AR Aging</option>
                  <option value="membership_statistics">Membership Statistics</option>
                  <option value="inventory_valuation">Inventory Valuation</option>
                </select>
              </div>
              <div><label className="label">Body (if narrative)</label><textarea className="input" name="body" rows={3} /></div>
              <div><label className="label">Sort order</label><input className="input" type="number" name="sortOrder" defaultValue={pkg.sections.length} /></div>
              <button className="btn btn-primary">Add section</button>
            </form>
          )}

          {canWrite && (
            <form action={addCommentaryAction.bind(null, pkg.id)} className="card card-body space-y-3">
              <h2 className="section-title text-lg">Add commentary</h2>
              <div><label className="label">Subject</label><input className="input" name="subject" required maxLength={160} placeholder="Variance — F&B" /></div>
              <div>
                <label className="label">Scope</label>
                <select className="select" name="scope">
                  <option value="GENERAL">General</option>
                  <option value="VARIANCE">Variance</option>
                  <option value="DEPARTMENT">Department</option>
                  <option value="ACTION_PLAN">Action plan</option>
                  <option value="RISK">Risk</option>
                </select>
              </div>
              <div><label className="label">Body</label><textarea className="input" name="body" required rows={5} /></div>
              <button className="btn btn-primary">Add commentary</button>
            </form>
          )}

          {canDistribute && (pkg.status === "APPROVED" || pkg.status === "DISTRIBUTED") && (
            <form action={distributeAction.bind(null, pkg.id)} className="card card-body space-y-3">
              <h2 className="section-title text-lg">Distribute</h2>
              <div><label className="label">Recipient name</label><input className="input" name="recipientName" required /></div>
              <div><label className="label">Email</label><input className="input" type="email" name="recipientEmail" required /></div>
              <div>
                <label className="label">Channel</label>
                <select className="select" name="channel">
                  <option value="EMAIL">Email</option>
                  <option value="PORTAL">Portal</option>
                  <option value="DOWNLOAD">Download link</option>
                </select>
              </div>
              <button className="btn btn-primary">Record distribution</button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
