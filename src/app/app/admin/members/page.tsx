import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { getActiveClubId } from "@/lib/active-club";
import { Badge } from "@/components/Badge";
import { formatCurrency } from "@/lib/finance";

export default async function MembersListPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const clubId = await getActiveClubId(user);

  const members = await prisma.member.findMany({
    where: { clubId },
    include: { account: true },
    orderBy: [{ status: "asc" }, { lastName: "asc" }],
  });

  return (
    <div>
      <div className="flex items-end justify-between">
        <div>
          <h1 className="page-title">Members</h1>
          <p className="mt-1 text-stone-500">All members of your club, with quick balance and access status.</p>
        </div>
      </div>

      <div className="card mt-6">
        <table className="table-base">
          <thead>
            <tr>
              <th>Member</th>
              <th>Number</th>
              <th>Category</th>
              <th>Status</th>
              <th>Access</th>
              <th>Payment method</th>
              <th className="text-right">Balance</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.id}>
                <td>
                  <Link href={`/app/admin/members/${m.id}`} className="font-medium text-club-ink hover:text-club-green-700">
                    {m.firstName} {m.lastName}
                  </Link>
                  <div className="text-xs text-stone-500">{m.email}</div>
                </td>
                <td className="text-stone-600">{m.memberNumber}</td>
                <td className="text-stone-600">{m.membershipCategory ?? "—"}</td>
                <td><Badge status={m.status} /></td>
                <td><Badge status={m.accessStatus} /></td>
                <td><Badge status={m.paymentMethodStatus} /></td>
                <td className="text-right tabular-nums">{formatCurrency(m.account?.currentBalance ?? 0)}</td>
              </tr>
            ))}
            {members.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-stone-500">No members yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
