import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { getActiveClubId } from "@/lib/active-club";
import { Badge } from "@/components/Badge";
import { formatCurrency, formatDate } from "@/lib/finance";

export default async function FinancingListPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const clubId = await getActiveClubId(user);

  const agreements = await prisma.financingAgreement.findMany({
    where: { clubId },
    include: { member: true, schedule: true },
    orderBy: { startDate: "desc" },
  });

  return (
    <div>
      <h1 className="page-title">Financing</h1>
      <p className="mt-1 text-stone-500">Active and historical share-purchase financing agreements.</p>

      <div className="mt-6 card overflow-hidden">
        <table className="table-base">
          <thead>
            <tr>
              <th>Member</th>
              <th className="text-right">Principal</th>
              <th>Term</th>
              <th>Rate</th>
              <th className="text-right">Monthly</th>
              <th>Start</th>
              <th>Status</th>
              <th>Remaining</th>
            </tr>
          </thead>
          <tbody>
            {agreements.length === 0 && <tr><td colSpan={8} className="px-4 py-8 text-center text-stone-500">No financing agreements.</td></tr>}
            {agreements.map((a) => {
              const remaining = a.schedule.filter((s) => s.status !== "PAID").reduce((sum, s) => sum + s.paymentAmount, 0);
              return (
                <tr key={a.id}>
                  <td><Link href={`/app/admin/members/${a.memberId}`} className="font-medium hover:text-club-green-700">{a.member.firstName} {a.member.lastName}</Link></td>
                  <td className="text-right tabular-nums">{formatCurrency(a.principalAmount)}</td>
                  <td>{a.termMonths} mo</td>
                  <td>{(a.interestRate * 100).toFixed(2)}%</td>
                  <td className="text-right tabular-nums">{formatCurrency(a.monthlyPayment)}</td>
                  <td>{formatDate(a.startDate)}</td>
                  <td><Badge status={a.status} /></td>
                  <td className="text-right tabular-nums">{formatCurrency(remaining)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
