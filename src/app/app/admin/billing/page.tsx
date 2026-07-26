import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { ensureBillingCustomer, getBillingSnapshot } from "@/lib/billing";
import { isAppError } from "@/lib/errors";
import { Badge } from "@/components/Badge";
import { fmtMoney } from "@/lib/accounting/format";
import { formatDate } from "@/lib/finance";

async function createCustomerAction(formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  try { await ensureBillingCustomer(p, clubId, { email: String(formData.get("email") ?? "") }); }
  catch (err) { if (isAppError(err)) redirect(`/app/admin/billing?error=${encodeURIComponent(err.safeMessage)}`); throw err; }
  revalidatePath("/app/admin/billing");
}

export default async function BillingPage({ searchParams }: { searchParams: { error?: string } }) {
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "settings:read")) redirect("/app/admin");
  const canWrite = hasPermission(p, clubId, "settings:write");

  const snap = await getBillingSnapshot(p, clubId);

  return (
    <div>
      <h1 className="page-title">SaaS Billing</h1>
      <p className="mt-1 text-stone-500">Spectre&apos;s billing relationship with this club. Configure a Stripe (or mock) customer to start tracking subscriptions, invoices, and payment status.</p>

      {searchParams.error && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{searchParams.error}</div>
      )}

      <div className="mt-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          {!snap.customer && canWrite && (
            <form action={createCustomerAction} className="card card-body space-y-3">
              <h2 className="section-title text-lg">Create billing customer</h2>
              <p className="text-xs text-stone-500">When SPECTRE_BILLING_PROVIDER=stripe is set, this calls Stripe&apos;s API. Otherwise the mock adapter records a local-only customer for testing.</p>
              <div><label className="label">Contact email</label><input className="input" type="email" name="email" required /></div>
              <button className="btn btn-primary">Create</button>
            </form>
          )}
          {snap.customer && (
            <div className="card card-body">
              <h2 className="section-title text-lg">Customer</h2>
              <div className="mt-3 text-sm space-y-1">
                <div><span className="text-stone-500">Provider:</span> <span className="font-mono">{snap.customer.provider}</span></div>
                <div><span className="text-stone-500">External ID:</span> <span className="font-mono text-xs">{snap.customer.externalId}</span></div>
                <div><span className="text-stone-500">Email:</span> {snap.customer.email ?? "—"}</div>
              </div>
            </div>
          )}

          <div className="card overflow-hidden">
            <div className="px-6 py-4 border-b border-stone-200 font-medium">Subscriptions ({snap.subscriptions.length})</div>
            <table className="table-base">
              <thead><tr><th>Provider</th><th>External ID</th><th>Status</th><th>Current period</th></tr></thead>
              <tbody>
                {snap.subscriptions.length === 0 && <tr><td colSpan={4} className="px-4 py-6 text-center text-stone-500">No subscriptions yet.</td></tr>}
                {snap.subscriptions.map((s) => (
                  <tr key={s.id}>
                    <td className="text-xs font-mono">{s.provider}</td>
                    <td className="text-xs font-mono">{s.externalId}</td>
                    <td><Badge status={s.status} /></td>
                    <td className="text-xs">{s.currentPeriodStart ? `${formatDate(s.currentPeriodStart)} – ${s.currentPeriodEnd ? formatDate(s.currentPeriodEnd) : "—"}` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card overflow-hidden">
            <div className="px-6 py-4 border-b border-stone-200 font-medium">Invoices</div>
            <table className="table-base">
              <thead><tr><th>Number</th><th className="text-right">Amount</th><th>Status</th><th>Period</th><th></th></tr></thead>
              <tbody>
                {snap.invoices.length === 0 && <tr><td colSpan={5} className="px-4 py-6 text-center text-stone-500">No invoices.</td></tr>}
                {snap.invoices.map((i) => (
                  <tr key={i.id}>
                    <td className="text-xs">{i.number ?? "—"}</td>
                    <td className="text-right tabular-nums">{fmtMoney(i.amountDue as unknown as number, { showZero: true })}</td>
                    <td><Badge status={i.status} /></td>
                    <td className="text-xs">{i.periodStart ? `${formatDate(i.periodStart)} – ${i.periodEnd ? formatDate(i.periodEnd) : "—"}` : "—"}</td>
                    <td className="text-right text-xs">{i.hostedUrl ? <a className="text-club-green-700 hover:underline" href={i.hostedUrl}>Open</a> : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card overflow-hidden">
          <div className="px-6 py-4 border-b border-stone-200 font-medium">Recent webhooks</div>
          <ul className="divide-y divide-stone-200 max-h-[60vh] overflow-y-auto">
            {snap.recentWebhooks.length === 0 && <li className="px-6 py-6 text-center text-stone-500">No webhook events yet.</li>}
            {snap.recentWebhooks.map((w) => (
              <li key={w.id} className="px-6 py-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs">{w.eventType}</span>
                  <Badge status={w.status} />
                </div>
                <div className="mt-1 text-xs text-stone-500">{formatDate(w.receivedAt)}</div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

void Link;
