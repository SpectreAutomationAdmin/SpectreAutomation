import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { isAppError } from "@/lib/errors";
import { packageService } from "@/lib/enterprise";
import { Badge } from "@/components/Badge";
import { formatDate } from "@/lib/finance";

async function createPackageAction(formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  try {
    await packageService.createPackage(p, clubId, {
      name: String(formData.get("name") ?? ""),
      periodLabel: String(formData.get("periodLabel") ?? ""),
      asOfDate: String(formData.get("asOfDate") ?? ""),
      audience: (formData.get("audience") as "BOARD" | "FINANCE_COMMITTEE" | "INTERNAL") ?? "BOARD",
      executiveSummary: String(formData.get("executiveSummary") ?? ""),
    });
  } catch (err) { if (isAppError(err)) redirect(`/app/admin/governance/packages?error=${encodeURIComponent(err.safeMessage)}`); throw err; }
  revalidatePath("/app/admin/governance/packages");
}

export default async function PackagesPage({ searchParams }: { searchParams: { error?: string } }) {
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "packages:read")) redirect("/app/admin");
  const canCreate = hasPermission(p, clubId, "packages:write");

  const packages = await packageService.listPackages(p, clubId);

  return (
    <div>
      <Link href="/app/admin/governance" className="text-sm text-stone-500 hover:text-club-ink">← Governance</Link>
      <h1 className="mt-3 page-title">Board & Finance Committee Packages</h1>
      <p className="mt-1 text-stone-500">Monthly governance packages with executive summary, sectioned reports, and management commentary.</p>

      {searchParams.error && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{searchParams.error}</div>
      )}

      <div className="mt-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 card overflow-hidden">
          <div className="px-6 py-4 border-b border-stone-200 font-medium">Packages ({packages.length})</div>
          <table className="table-base">
            <thead><tr><th>Name</th><th>Period</th><th>Audience</th><th>Status</th><th>Sections</th><th>Distributed</th><th></th></tr></thead>
            <tbody>
              {packages.length === 0 && <tr><td colSpan={7} className="px-4 py-6 text-center text-stone-500">No packages yet.</td></tr>}
              {packages.map((pkg) => (
                <tr key={pkg.id}>
                  <td><Link href={`/app/admin/governance/packages/${pkg.id}`} className="hover:text-club-green-700">{pkg.name} <span className="text-xs text-stone-500">v{pkg.version}</span></Link></td>
                  <td className="font-mono text-xs">{pkg.periodLabel}</td>
                  <td className="text-xs">{pkg.audience}</td>
                  <td><Badge status={pkg.status} /></td>
                  <td className="text-xs">{pkg.sections.length}</td>
                  <td className="text-xs">{pkg.distributions.length}</td>
                  <td className="text-right text-xs"><Link href={`/app/admin/governance/packages/${pkg.id}`} className="text-club-green-700 hover:underline">Open →</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {canCreate && (
          <form action={createPackageAction} className="card card-body h-fit space-y-3">
            <h2 className="section-title text-lg">New package</h2>
            <div>
              <label className="label">Name</label>
              <input className="input" name="name" required placeholder="Board Package" maxLength={120} />
            </div>
            <div>
              <label className="label">Period label</label>
              <input className="input font-mono" name="periodLabel" required placeholder="2026-04" maxLength={40} />
            </div>
            <div>
              <label className="label">As of</label>
              <input className="input" type="date" name="asOfDate" required defaultValue={new Date().toISOString().slice(0, 10)} />
            </div>
            <div>
              <label className="label">Audience</label>
              <select className="select" name="audience">
                <option value="BOARD">Board of Directors</option>
                <option value="FINANCE_COMMITTEE">Finance Committee</option>
                <option value="INTERNAL">Internal Leadership</option>
              </select>
            </div>
            <div>
              <label className="label">Executive summary</label>
              <textarea className="input" name="executiveSummary" rows={4} placeholder="Headline narrative for the period…" />
            </div>
            <button className="btn btn-primary">Create</button>
          </form>
        )}
      </div>
    </div>
  );
}

void formatDate;
