import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { listInvoices } from "@/lib/ap/invoices";
import { Badge } from "@/components/Badge";
import { fmtMoney } from "@/lib/accounting/format";
import { formatDate } from "@/lib/finance";

const FILTERS = [
  { v: "", l: "All" },
  { v: "DRAFT", l: "Draft" },
  { v: "PENDING_APPROVAL", l: "Pending approval" },
  { v: "APPROVED", l: "Approved" },
  { v: "POSTED", l: "Posted" },
  { v: "PARTIALLY_PAID", l: "Partially paid" },
  { v: "PAID", l: "Paid" },
  { v: "VOIDED", l: "Voided" },
  { v: "DISPUTED", l: "Disputed" },
];

export default async function InvoicesPage({ searchParams }: { searchParams: { status?: string } }) {
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "ap:invoice:view")) redirect("/app/admin");
  const canCreate = hasPermission(p, clubId, "ap:invoice:create");

  const invoices = await listInvoices(p, clubId, searchParams.status ? { status: searchParams.status } : undefined);

  return (
    <div>
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="page-title">AP Invoices</h1>
          <p className="mt-1 text-stone-500">All invoices entered or captured for your club.</p>
        </div>
        {canCreate && <Link href="/app/admin/ap/invoices/new" className="btn btn-primary">+ New invoice</Link>}
      </div>

      <div className="mt-6 flex items-center gap-2 flex-wrap">
        {FILTERS.map((f) => {
          const active = (searchParams.status ?? "") === f.v;
          const href = f.v ? `/app/admin/ap/invoices?status=${f.v}` : "/app/admin/ap/invoices";
          return (
            <Link key={f.v || "all"} href={href}
              className={"rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset " + (active ? "bg-club-green-700 text-white ring-club-green-700" : "bg-white text-stone-600 ring-stone-200 hover:bg-stone-50")}
            >
              {f.l}
            </Link>
          );
        })}
      </div>

      <div className="mt-6 card overflow-hidden">
        <table className="table-base">
          <thead>
            <tr><th>Invoice #</th><th>Vendor</th><th>Reference</th><th>Date</th><th>Due</th><th>Status</th><th className="text-right">Total</th><th className="text-right">Outstanding</th></tr>
          </thead>
          <tbody>
            {invoices.length === 0 && <tr><td colSpan={8} className="px-4 py-8 text-center text-stone-500">No invoices match.</td></tr>}
            {invoices.map((inv) => {
              const outstanding = Number(inv.total.toString()) - Number(inv.amountPaid.toString());
              return (
                <tr key={inv.id}>
                  <td className="font-mono text-xs"><Link href={`/app/admin/ap/invoices/${inv.id}`} className="hover:text-club-green-700">{inv.invoiceNumber}</Link></td>
                  <td><Link href={`/app/admin/ap/vendors/${inv.vendorId}`} className="hover:text-club-green-700">{inv.vendor.legalName}</Link></td>
                  <td className="font-mono text-xs">{inv.vendorReference ?? "—"}</td>
                  <td>{formatDate(inv.invoiceDate)}</td>
                  <td>{formatDate(inv.dueDate)}</td>
                  <td><Badge status={inv.status} /></td>
                  <td className="text-right tabular-nums">{fmtMoney(inv.total as unknown as number)}</td>
                  <td className="text-right tabular-nums">{fmtMoney(outstanding)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
