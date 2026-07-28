import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { listVendors } from "@/lib/ap/vendors";
import { Badge } from "@/components/Badge";

const FILTERS = [
  { v: "", l: "All" },
  { v: "DRAFT", l: "Draft" },
  { v: "PENDING_APPROVAL", l: "Pending approval" },
  { v: "ACTIVE", l: "Active" },
  { v: "INACTIVE", l: "Inactive" },
  { v: "BLOCKED", l: "Blocked" },
];

export default async function VendorsPage({ searchParams }: { searchParams: { status?: string } }) {
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "vendor:view")) redirect("/app/admin");
  const canCreate = hasPermission(p, clubId, "vendor:create");

  const vendors = await listVendors(p, clubId, searchParams.status ? { status: searchParams.status } : undefined);

  return (
    <div>
      <div className="flex items-end justify-between">
        <div>
          <h1 className="page-title">Vendors</h1>
          <p className="mt-1 text-stone-500">All vendors who can be invoiced.</p>
        </div>
        {canCreate && <Link href="/app/admin/ap/vendors/new" className="btn btn-primary">+ New vendor</Link>}
      </div>

      <div className="mt-6 flex items-center gap-2 flex-wrap">
        {FILTERS.map((f) => {
          const active = (searchParams.status ?? "") === f.v;
          const href = f.v ? `/app/admin/ap/vendors?status=${f.v}` : "/app/admin/ap/vendors";
          return (
            <Link
              key={f.v || "all"}
              href={href}
              className={
                "rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset " +
                (active ? "bg-club-green-700 text-white ring-club-green-700" : "bg-white text-stone-600 ring-stone-200 hover:bg-stone-50")
              }
            >
              {f.l}
            </Link>
          );
        })}
      </div>

      <div className="mt-6 card overflow-hidden">
        <table className="table-base">
          <thead><tr><th>Vendor #</th><th>Legal name</th><th>Status</th><th>Default expense</th><th>Department</th><th>Terms</th></tr></thead>
          <tbody>
            {vendors.length === 0 && <tr><td colSpan={6} className="px-4 py-8 text-center text-stone-500">No vendors match.</td></tr>}
            {vendors.map((v) => (
              <tr key={v.id}>
                <td className="font-mono text-xs">{v.vendorNumber}</td>
                <td>
                  {/* 15P-7: vendor row now opens the relationship
                      timeline as the primary destination. Settings
                      remain reachable via the gear icon on the
                      timeline header. */}
                  <Link
                    href={`/app/admin/ap/vendors/${v.id}/timeline`}
                    className="font-medium hover:text-club-green-700"
                    data-testid={`vendor-row-link-${v.id}`}
                  >
                    {v.legalName}
                  </Link>
                  {v.operatingName && <div className="text-xs text-stone-500">{v.operatingName}</div>}
                </td>
                <td><Badge status={v.status} /></td>
                <td className="text-stone-600 text-xs">{v.defaultExpenseAccount ? `${v.defaultExpenseAccount.accountNumber} · ${v.defaultExpenseAccount.name}` : "—"}</td>
                <td className="text-stone-600 text-xs">{v.defaultDepartment?.name ?? "—"}</td>
                <td className="text-stone-600 text-xs">Net {v.paymentTermsDays}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
