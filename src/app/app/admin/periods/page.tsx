import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { setPeriodStatus } from "@/lib/accounting/periods";
import { hasPermission } from "@/lib/rbac";
import { isAppError } from "@/lib/errors";
import { Badge } from "@/components/Badge";
import { formatDate } from "@/lib/finance";

async function transitionAction(periodId: string, next: string) {
  "use server";
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  try {
    await setPeriodStatus(p, periodId, next as "OPEN" | "SOFT_LOCKED" | "HARD_LOCKED" | "CLOSED");
  } catch (err) {
    if (isAppError(err)) redirect(`/app/admin/periods?error=${encodeURIComponent(err.safeMessage)}`);
    throw err;
  }
  revalidatePath("/app/admin/periods");
}

export default async function PeriodsPage({ searchParams }: { searchParams: { error?: string } }) {
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "gl:read")) redirect("/app/admin");
  const canClose = hasPermission(p, clubId, "gl:close_period");

  const years = await prisma.fiscalYear.findMany({
    where: { clubId },
    include: { periods: { orderBy: { sequence: "asc" } } },
    orderBy: { startDate: "desc" },
  });

  return (
    <div>
      <h1 className="page-title">Fiscal Periods</h1>
      <p className="mt-1 text-stone-500">Manage your fiscal year and monthly period status.</p>

      {searchParams.error && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{searchParams.error}</div>
      )}

      <div className="mt-6 space-y-8">
        {years.map((fy) => (
          <section key={fy.id} className="card overflow-hidden">
            <div className="px-6 py-4 border-b border-stone-200 flex items-center justify-between">
              <div>
                <div className="font-serif text-lg">{fy.label}</div>
                <div className="text-xs text-stone-500">{formatDate(fy.startDate)} — {formatDate(fy.endDate)}</div>
              </div>
              <Badge status={fy.status} />
            </div>
            <table className="table-base">
              <thead><tr><th>Period</th><th>Range</th><th>Status</th><th>Closed by</th><th></th></tr></thead>
              <tbody>
                {fy.periods.map((per) => (
                  <tr key={per.id}>
                    <td className="font-mono text-xs">{per.label}</td>
                    <td>{formatDate(per.startDate)} — {formatDate(per.endDate)}</td>
                    <td><Badge status={per.status} /></td>
                    <td className="text-xs text-stone-500">{per.closedAt ? formatDate(per.closedAt) : "—"}</td>
                    <td className="text-right space-x-2">
                      {canClose && per.status !== "OPEN" && (
                        <form action={transitionAction.bind(null, per.id, "OPEN")} className="inline">
                          <button className="text-xs text-club-green-700 hover:underline">Reopen</button>
                        </form>
                      )}
                      {canClose && per.status === "OPEN" && (
                        <form action={transitionAction.bind(null, per.id, "SOFT_LOCKED")} className="inline">
                          <button className="text-xs text-amber-700 hover:underline">Soft lock</button>
                        </form>
                      )}
                      {canClose && per.status !== "HARD_LOCKED" && per.status !== "CLOSED" && (
                        <form action={transitionAction.bind(null, per.id, "HARD_LOCKED")} className="inline">
                          <button className="text-xs text-red-600 hover:underline">Hard lock</button>
                        </form>
                      )}
                      {canClose && per.status !== "CLOSED" && (
                        <form action={transitionAction.bind(null, per.id, "CLOSED")} className="inline">
                          <button className="text-xs text-stone-700 hover:underline">Close</button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
        {years.length === 0 && (
          <div className="text-stone-500">No fiscal years configured.</div>
        )}
      </div>
    </div>
  );
}
