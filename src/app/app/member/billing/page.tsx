import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { isAppError } from "@/lib/errors";
import { getOverview, listPaymentMethods, setPrimaryPaymentMethod, removePaymentMethod, openDispute } from "@/lib/portal/billing";
import { Badge } from "@/components/Badge";
import { formatCurrency, formatDate } from "@/lib/finance";

async function setPrimaryAction(formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  try { await setPrimaryPaymentMethod(p, clubId, { paymentMethodId: String(formData.get("paymentMethodId")) }); }
  catch (err) {
    if (isAppError(err)) cookies().set("portal_error", err.safeMessage, { httpOnly: true, sameSite: "strict", maxAge: 30 });
    else throw err;
  }
  revalidatePath("/app/member/billing");
}

async function removeMethodAction(formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  try { await removePaymentMethod(p, clubId, String(formData.get("paymentMethodId"))); }
  catch (err) {
    if (isAppError(err)) cookies().set("portal_error", err.safeMessage, { httpOnly: true, sameSite: "strict", maxAge: 30 });
    else throw err;
  }
  revalidatePath("/app/member/billing");
}

async function openDisputeAction(formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  try {
    await openDispute(p, clubId, {
      chargeId: String(formData.get("chargeId")),
      reason: String(formData.get("reason") ?? ""),
    });
  } catch (err) {
    if (isAppError(err)) cookies().set("portal_error", err.safeMessage, { httpOnly: true, sameSite: "strict", maxAge: 30 });
    else throw err;
  }
  revalidatePath("/app/member/billing");
}

export default async function MemberBillingPage() {
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "self:account:read") || !p.memberId) redirect("/app");

  const [overview, methods] = await Promise.all([
    getOverview(p, clubId),
    listPaymentMethods(p, clubId),
  ]);
  const error = cookies().get("portal_error")?.value;
  if (error) cookies().delete("portal_error");

  return (
    <div>
      <h1 className="page-title">Billing</h1>
      <p className="mt-1 text-stone-500">Account balances, statements, payment methods, and disputes.</p>
      {error && <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      <div className="mt-6 grid grid-cols-2 md:grid-cols-5 gap-3">
        <div className="card card-body"><div className="text-xs uppercase text-stone-500">Current</div><div className="mt-1 text-xl font-medium">{formatCurrency(overview.balances.current)}</div></div>
        <div className="card card-body"><div className="text-xs uppercase text-stone-500">30 day</div><div className="mt-1 text-xl font-medium">{formatCurrency(overview.balances.thirtyDay)}</div></div>
        <div className="card card-body"><div className="text-xs uppercase text-stone-500">60 day</div><div className="mt-1 text-xl font-medium">{formatCurrency(overview.balances.sixtyDay)}</div></div>
        <div className="card card-body"><div className="text-xs uppercase text-stone-500">90+ day</div><div className="mt-1 text-xl font-medium">{formatCurrency(overview.balances.ninetyDay + overview.balances.oneTwentyDay)}</div></div>
        <div className="card card-body"><div className="text-xs uppercase text-stone-500">Credit</div><div className="mt-1 text-xl font-medium">{formatCurrency(overview.balances.credit)}</div></div>
      </div>

      {overview.lastStatement && (
        <div className="mt-4 card card-body flex items-center justify-between">
          <div>
            <div className="text-sm">Most recent statement</div>
            <div className="text-xs text-stone-500">{formatDate(overview.lastStatement.periodStart)} – {formatDate(overview.lastStatement.periodEnd)}</div>
          </div>
          <Link href={`/app/member/account/statements/${overview.lastStatement.id}`} className="btn btn-secondary btn-sm">View</Link>
        </div>
      )}

      <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card overflow-hidden">
          <div className="px-6 py-4 border-b border-stone-200 font-medium">Recent charges</div>
          <table className="table-base">
            <thead><tr><th>Date</th><th>Description</th><th>Amount</th><th></th></tr></thead>
            <tbody>
              {overview.recentCharges.length === 0 && <tr><td colSpan={4} className="px-4 py-6 text-center text-stone-500">No recent charges.</td></tr>}
              {overview.recentCharges.map((c) => (
                <tr key={c.id}>
                  <td className="text-xs">{formatDate(c.date)}</td>
                  <td className="text-xs">{c.description}</td>
                  <td className="text-xs">{formatCurrency(c.amount)}</td>
                  <td className="text-right">
                    <details className="inline-block">
                      <summary className="text-xs text-stone-500 cursor-pointer">Dispute</summary>
                      <form action={openDisputeAction} className="mt-1 flex flex-col gap-1">
                        <input type="hidden" name="chargeId" value={c.id} />
                        <input name="reason" placeholder="Reason" className="input text-xs" required minLength={3} />
                        <button className="btn btn-secondary btn-sm">Open</button>
                      </form>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card overflow-hidden">
          <div className="px-6 py-4 border-b border-stone-200 font-medium">Recent payments</div>
          <table className="table-base">
            <thead><tr><th>Date</th><th>Method</th><th>Amount</th><th>Status</th></tr></thead>
            <tbody>
              {overview.recentPayments.length === 0 && <tr><td colSpan={4} className="px-4 py-6 text-center text-stone-500">No recent payments.</td></tr>}
              {overview.recentPayments.map((pmt) => (
                <tr key={pmt.id}>
                  <td className="text-xs">{formatDate(pmt.date)}</td>
                  <td className="text-xs">{pmt.method}</td>
                  <td className="text-xs">{formatCurrency(pmt.amount)}</td>
                  <td className="text-xs"><Badge status={pmt.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="mt-6 card overflow-hidden">
        <div className="px-6 py-4 border-b border-stone-200 font-medium">Payment methods</div>
        <table className="table-base">
          <thead><tr><th>Type</th><th>Brand</th><th>Last 4</th><th>Status</th><th>Primary</th><th></th></tr></thead>
          <tbody>
            {methods.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-stone-500">No payment methods on file. <Link className="text-club-ink" href="/app/member/payment-methods">Add one</Link>.</td></tr>}
            {methods.map((m) => (
              <tr key={m.id}>
                <td className="text-xs">{m.type}</td>
                <td className="text-xs">{m.brand ?? "—"}</td>
                <td className="text-xs font-mono">{m.lastFour ? `•••• ${m.lastFour}` : "—"}</td>
                <td className="text-xs"><Badge status={m.status} /></td>
                <td className="text-xs">{m.isPrimary ? "✓" : ""}</td>
                <td className="text-right">
                  <div className="flex justify-end gap-2">
                    {!m.isPrimary && m.status === "ACTIVE" && (
                      <form action={setPrimaryAction}>
                        <input type="hidden" name="paymentMethodId" value={m.id} />
                        <button className="btn btn-secondary btn-sm">Make primary</button>
                      </form>
                    )}
                    {!m.isPrimary && (
                      <form action={removeMethodAction}>
                        <input type="hidden" name="paymentMethodId" value={m.id} />
                        <button className="btn btn-secondary btn-sm">Remove</button>
                      </form>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
