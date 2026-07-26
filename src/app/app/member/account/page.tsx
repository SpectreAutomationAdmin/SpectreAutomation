import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { getActiveMember } from "@/lib/active-member";
import { Badge } from "@/components/Badge";
import { formatCurrency, formatDate } from "@/lib/finance";

export default async function MemberAccountPage({ searchParams }: { searchParams: { welcomeMember?: string } }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const member = await getActiveMember(user, searchParams.welcomeMember);
  if (!member) redirect(user.role === "MEMBER" ? "/login" : "/app/admin");

  const [account, charges, payments, statements, openPromise, openDispute] = await Promise.all([
    prisma.memberAccount.findUnique({ where: { memberId: member.id } }),
    prisma.charge.findMany({ where: { memberId: member.id, status: { in: ["POSTED", "REVERSED"] } }, orderBy: { transactionDate: "desc" }, take: 10 }),
    prisma.payment.findMany({ where: { memberId: member.id }, orderBy: { paymentDate: "desc" }, take: 10 }),
    prisma.statement.findMany({ where: { memberId: member.id, status: "ISSUED" }, orderBy: { issuedAt: "desc" }, take: 6 }),
    prisma.paymentPromise.findFirst({ where: { memberId: member.id, status: "ACTIVE" }, orderBy: { promisedDate: "asc" } }),
    prisma.dispute.findFirst({ where: { memberId: member.id, status: { in: ["OPEN", "UNDER_REVIEW"] } } }),
  ]);

  const aged = (account?.sixtyDayBalance ?? 0) + (account?.ninetyDayBalance ?? 0) + (account?.oneTwentyDayBalance ?? 0);

  return (
    <div>
      <h1 className="page-title">My Account</h1>
      <p className="mt-1 text-stone-500">A snapshot of your account activity at the club.</p>

      {aged > 0 && (
        <div className="mt-6 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Your account requires attention. Please update payment or contact administration.
        </div>
      )}
      {openPromise && (
        <div className="mt-6 rounded-md border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
          A payment promise of {formatCurrency(openPromise.promisedAmount)} is on file for {formatDate(openPromise.promisedDate)}.
        </div>
      )}

      <div className="mt-6 grid grid-cols-1 md:grid-cols-5 gap-4">
        <StatTile label="Current" value={formatCurrency(account?.currentBalance ?? 0)} />
        <StatTile label="30 days" value={formatCurrency(account?.thirtyDayBalance ?? 0)} />
        <StatTile label="60 days" value={formatCurrency(account?.sixtyDayBalance ?? 0)} accent={aged > 0} />
        <StatTile label="90 days" value={formatCurrency(account?.ninetyDayBalance ?? 0)} accent={aged > 0} />
        <StatTile label="120+ days" value={formatCurrency(account?.oneTwentyDayBalance ?? 0)} accent={(account?.oneTwentyDayBalance ?? 0) > 0} />
      </div>

      <div className="mt-6 card card-body flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-sm text-stone-500">Payment method status</div>
          <Badge status={member.paymentMethodStatus} />
          {account?.creditBalance ? (
            <div className="mt-1 text-xs text-club-green-700">Credit on file: {formatCurrency(account.creditBalance)}</div>
          ) : null}
        </div>
        <div className="flex gap-2">
          <Link className="btn btn-secondary" href="/app/member/payment-methods">Manage payment methods</Link>
          <button className="btn btn-primary" disabled title="Payment integration placeholder">Make a payment</button>
        </div>
      </div>

      {statements.length > 0 && (
        <div className="mt-10 card overflow-hidden">
          <div className="px-6 py-4 border-b border-stone-200 font-medium">Statements</div>
          <table className="table-base">
            <thead><tr><th>Period</th><th className="text-right">Opening</th><th className="text-right">Closing</th><th>Issued</th><th></th></tr></thead>
            <tbody>
              {statements.map((s) => (
                <tr key={s.id}>
                  <td>{formatDate(s.periodStart)} – {formatDate(s.periodEnd)}</td>
                  <td className="text-right tabular-nums">{formatCurrency(s.openingBalance)}</td>
                  <td className="text-right tabular-nums">{formatCurrency(s.closingBalance)}</td>
                  <td>{formatDate(s.issuedAt)}</td>
                  <td className="text-right"><Link className="text-xs text-club-green-700 hover:underline" href={`/app/member/account/statements/${s.id}`}>View →</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-10 grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card overflow-hidden">
          <div className="px-6 py-4 border-b border-stone-200 font-medium">Recent charges</div>
          <table className="table-base">
            <thead><tr><th>Date</th><th>Description</th><th className="text-right">Amount</th></tr></thead>
            <tbody>
              {charges.length === 0 && <tr><td colSpan={3} className="px-4 py-8 text-center text-stone-500">No charges yet.</td></tr>}
              {charges.map((c) => (
                <tr key={c.id} className={c.status === "REVERSED" ? "text-stone-400 line-through" : ""}>
                  <td>{formatDate(c.transactionDate)}</td>
                  <td>
                    <div className="font-medium">{c.description}</div>
                    <div className="text-xs text-stone-500">{c.category.replace(/_/g, " ")}{c.status === "REVERSED" ? " · reversed" : ""}</div>
                  </td>
                  <td className="text-right tabular-nums">{formatCurrency(c.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card overflow-hidden">
          <div className="px-6 py-4 border-b border-stone-200 font-medium">Recent payments</div>
          <table className="table-base">
            <thead><tr><th>Date</th><th>Method</th><th className="text-right">Amount</th><th>Status</th></tr></thead>
            <tbody>
              {payments.length === 0 && <tr><td colSpan={4} className="px-4 py-8 text-center text-stone-500">No payments yet.</td></tr>}
              {payments.map((p) => (
                <tr key={p.id}>
                  <td>{formatDate(p.paymentDate)}</td>
                  <td>{p.method.replace(/_/g, " ")}</td>
                  <td className="text-right tabular-nums">{formatCurrency(p.amount)}</td>
                  <td><Badge status={p.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {openDispute ? null : (
        <div className="mt-10 text-xs text-stone-500">
          Have a question about a charge? <Link className="text-club-green-700 hover:underline" href="/app/member/profile">Contact us via your profile</Link>.
        </div>
      )}
    </div>
  );
}

function StatTile({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={"card card-body" + (accent ? " border-l-4 border-l-amber-400" : "")}>
      <div className="card-title">{label}</div>
      <div className="stat-number">{value}</div>
    </div>
  );
}
