import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { StatCard } from "@/components/StatCard";
import { fmtMoney } from "@/lib/accounting/format";
import { totalInventoryValuation, lowStockItems } from "@/lib/ops/inventory";

export default async function OperationsHubPage() {
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "inventory:view") && !hasPermission(p, clubId, "payroll:read") && !hasPermission(p, clubId, "assets:read")) {
    redirect("/app/admin");
  }

  const [inventoryValue, lowStock, openLessons, pendingPayables, activeAssets, pendingBookings, budgetCount] = await Promise.all([
    totalInventoryValuation(clubId).catch(() => null),
    lowStockItems(clubId).catch(() => []),
    prisma.lessonBooking.count({ where: { clubId, status: { in: ["SCHEDULED", "INSTRUCTOR_CONFIRMED"] } } }),
    prisma.lessonPayable.count({ where: { clubId, status: "ACCRUED" } }),
    prisma.capitalAsset.count({ where: { clubId, status: "ACTIVE" } }),
    prisma.privateEventBooking.count({ where: { clubId, status: { in: ["DRAFT", "CONFIRMED"] } } }),
    prisma.budget.count({ where: { clubId, status: { in: ["DRAFT", "UNDER_REVIEW", "APPROVED", "ACTIVE"] } } }),
  ]);

  return (
    <div>
      <div className="flex items-end justify-between">
        <div>
          <h1 className="page-title">Operations</h1>
          <p className="mt-1 text-stone-500">Inventory, events, lessons, payroll, capital assets, and budgets.</p>
        </div>
      </div>

      <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
        <StatCard title="Inventory value" value={inventoryValue ? fmtMoney(inventoryValue as unknown as number, { showZero: true }) : "—"} href="/app/admin/ops/inventory" />
        <StatCard title="Low stock items" value={lowStock.length} tone={lowStock.length > 0 ? "warning" : "default"} href="/app/admin/ops/inventory" />
        <StatCard title="Private bookings" value={pendingBookings} href="/app/admin/ops/private-events" />
        <StatCard title="Open lessons" value={openLessons} href="/app/admin/ops/lessons" />
        <StatCard title="Accrued lesson payables" value={pendingPayables} tone={pendingPayables > 0 ? "warning" : "default"} href="/app/admin/ops/lessons" />
        <StatCard title="Active assets" value={activeAssets} href="/app/admin/ops/assets" />
        <StatCard title="Budgets in flight" value={budgetCount} href="/app/admin/ops/budgets" />
      </div>

      <div className="mt-10 grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card href="/app/admin/hospitality" title="Hospitality" body="Lounge reservations, walk-ins, the visual floor map, and member feedback." />
        <Card href="/app/admin/hospitality/reservations/floor" title="Point of Sale (Floor Map)" body="Server workflow: pick a table on the floor map, mark seated with a primary member, work the check seat-by-seat, settle by split bill." />
        <Card href="/app/admin/ops/floor-plans" title="Floor Plans" body="Design and edit the Lounge and Patio floor layouts. Save drafts as you go; publish to push to the live POS floor map servers use." />
        <Card href="/app/admin/ops/pos/lounge" title="Quick Sale / Bar" body="Tableless ringup for bar, to-go, or no-table transactions." />
        <Card href="/app/admin/ops/inventory" title="Inventory" body="Items, receivings, counts, transfers, and valuation." />
        <Card href="/app/admin/ops/private-events" title="Private Events" body="Inquiries, bookings, deposits, and final billing." />
        <Card href="/app/admin/ops/lessons" title="Lessons" body="Bookings, instructor confirmation, Head Pro approval, and payables." />
        <Card href="/app/admin/ops/payroll" title="Payroll" body="Employees, timesheets, payroll runs, and remittances." />
        <Card href="/app/admin/ops/assets" title="Capital Assets" body="Register, depreciation, and disposal." />
        <Card href="/app/admin/ops/budgets" title="Budgets &amp; Forecasts" body="Annual budgets, variance, and forecasting." />
      </div>
    </div>
  );
}

function Card({ href, title, body }: { href: string; title: string; body: string }) {
  return (
    <Link href={href} className="card card-body hover:shadow-elevated transition-shadow">
      <div className="font-serif text-xl">{title}</div>
      <p className="mt-2 text-sm text-stone-600">{body}</p>
      <span className="mt-3 text-sm text-club-green-700">Open →</span>
    </Link>
  );
}
