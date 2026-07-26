import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { getActiveClubId } from "@/lib/active-club";
import { StatCard } from "@/components/StatCard";
import { formatCurrency, formatDate } from "@/lib/finance";

export default async function FinanceDashboardPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const clubId = await getActiveClubId(user);

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const [accountAgg, financing, mtdCharges, mtdPayments, failedPayments, missingPayment, oldestBalances, creditBalances] = await Promise.all([
    prisma.memberAccount.aggregate({
      where: { clubId },
      _sum: { currentBalance: true, thirtyDayBalance: true, sixtyDayBalance: true, ninetyDayBalance: true, creditBalance: true },
    }),
    prisma.financingAgreement.aggregate({ where: { clubId, status: "ACTIVE" }, _sum: { principalAmount: true } }),
    prisma.charge.aggregate({ where: { clubId, transactionDate: { gte: monthStart } }, _sum: { amount: true }, _count: true }),
    prisma.payment.aggregate({ where: { clubId, paymentDate: { gte: monthStart }, status: "SUCCESS" }, _sum: { amount: true }, _count: true }),
    prisma.payment.findMany({ where: { clubId, status: "FAILED" }, include: { member: true }, orderBy: { paymentDate: "desc" }, take: 5 }),
    prisma.member.count({ where: { clubId, paymentMethodStatus: "NONE", status: "ACTIVE" } }),
    prisma.memberAccount.findMany({
      where: { clubId, ninetyDayBalance: { gt: 0 } },
      include: { member: true },
      orderBy: { ninetyDayBalance: "desc" },
      take: 5,
    }),
    prisma.memberAccount.findMany({ where: { clubId, creditBalance: { gt: 0 } }, include: { member: true }, take: 5 }),
  ]);

  const over90Members = await prisma.member.count({ where: { clubId, account: { ninetyDayBalance: { gt: 0 } } } });

  return (
    <div>
      <div>
        <h1 className="page-title">Finance Dashboard</h1>
        <p className="mt-1 text-stone-500">Controller-grade view of AR, financing, and recent activity.</p>
      </div>

      <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
        <StatCard title="Total member AR" value={formatCurrency(accountAgg._sum.currentBalance ?? 0)} />
        <StatCard title="AR 30 days" value={formatCurrency(accountAgg._sum.thirtyDayBalance ?? 0)} />
        <StatCard title="AR 60 days" value={formatCurrency(accountAgg._sum.sixtyDayBalance ?? 0)} tone={(accountAgg._sum.sixtyDayBalance ?? 0) > 0 ? "warning" : "default"} />
        <StatCard title="AR 90+ days" value={formatCurrency(accountAgg._sum.ninetyDayBalance ?? 0)} tone={(accountAgg._sum.ninetyDayBalance ?? 0) > 0 ? "danger" : "default"} />
        <StatCard title="Financing receivable" value={formatCurrency(financing._sum.principalAmount ?? 0)} />
        <StatCard title="Credit balances" value={formatCurrency(accountAgg._sum.creditBalance ?? 0)} />
        <StatCard title="MTD charges" value={formatCurrency(mtdCharges._sum.amount ?? 0)} subtitle={`${mtdCharges._count} charges`} />
        <StatCard title="MTD payments" value={formatCurrency(mtdPayments._sum.amount ?? 0)} subtitle={`${mtdPayments._count} payments`} tone="success" />
      </div>

      <div className="mt-10 grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 card overflow-hidden">
          <div className="px-6 py-4 border-b border-stone-200 font-medium">Oldest balances</div>
          <table className="table-base">
            <thead><tr><th>Member</th><th>Last payment</th><th className="text-right">90+ days</th><th className="text-right">Current</th></tr></thead>
            <tbody>
              {oldestBalances.length === 0 && <tr><td colSpan={4} className="px-4 py-8 text-center text-stone-500">No aged balances.</td></tr>}
              {oldestBalances.map((a) => (
                <tr key={a.id}>
                  <td><Link href={`/app/admin/members/${a.memberId}`} className="font-medium hover:text-club-green-700">{a.member.firstName} {a.member.lastName}</Link></td>
                  <td>{formatDate(a.lastPaymentDate)}</td>
                  <td className="text-right tabular-nums">{formatCurrency(a.ninetyDayBalance)}</td>
                  <td className="text-right tabular-nums">{formatCurrency(a.currentBalance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card card-body">
          <h3 className="section-title text-lg">AI Insights</h3>
          <p className="text-xs text-stone-500">Placeholder — future AI commentary module.</p>
          <ul className="mt-4 space-y-3 text-sm">
            <li>· {over90Members} member{over90Members === 1 ? "" : "s"} {over90Members === 1 ? "has" : "have"} balances over 90 days.</li>
            <li>· {failedPayments.length} failed payment{failedPayments.length === 1 ? "" : "s"} require{failedPayments.length === 1 ? "s" : ""} follow-up.</li>
            <li>· {creditBalances.length} member{creditBalances.length === 1 ? "" : "s"} {creditBalances.length === 1 ? "has" : "have"} a credit balance that should be reviewed.</li>
            <li>· Financing receivable balance is trending as expected.</li>
            <li>· {missingPayment} active member{missingPayment === 1 ? "" : "s"} {missingPayment === 1 ? "is" : "are"} missing a payment method.</li>
          </ul>
        </div>
      </div>

      <div className="mt-10 grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card overflow-hidden">
          <div className="px-6 py-4 border-b border-stone-200 font-medium">Failed payments</div>
          <table className="table-base">
            <thead><tr><th>Member</th><th>Date</th><th className="text-right">Amount</th></tr></thead>
            <tbody>
              {failedPayments.length === 0 && <tr><td colSpan={3} className="px-4 py-8 text-center text-stone-500">No failed payments.</td></tr>}
              {failedPayments.map((p) => (
                <tr key={p.id}>
                  <td><Link href={`/app/admin/members/${p.memberId}`} className="font-medium hover:text-club-green-700">{p.member.firstName} {p.member.lastName}</Link></td>
                  <td>{formatDate(p.paymentDate)}</td>
                  <td className="text-right tabular-nums">{formatCurrency(p.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card overflow-hidden">
          <div className="px-6 py-4 border-b border-stone-200 font-medium">Credit balances</div>
          <table className="table-base">
            <thead><tr><th>Member</th><th className="text-right">Credit balance</th></tr></thead>
            <tbody>
              {creditBalances.length === 0 && <tr><td colSpan={2} className="px-4 py-8 text-center text-stone-500">None.</td></tr>}
              {creditBalances.map((a) => (
                <tr key={a.id}>
                  <td><Link href={`/app/admin/members/${a.memberId}`} className="font-medium hover:text-club-green-700">{a.member.firstName} {a.member.lastName}</Link></td>
                  <td className="text-right tabular-nums">{formatCurrency(a.creditBalance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
