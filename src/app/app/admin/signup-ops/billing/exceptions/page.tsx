// SIGNUP-2 M4-INT-B §2 (2026-10-29) -- Billing exception management
// operator page.
//
// SUPER_ADMIN-gated.  Operators can view, filter, acknowledge,
// record resolution decisions, and escalate.  Does NOT allow
// deletion of any BillingExceptionCase row (schema does not expose
// the mutation path from this page or the API).

import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { isAppError } from "@/lib/errors";
import {
  acknowledgeException,
  recordExceptionResolution,
  escalateException,
  OPERATOR_RESOLUTIONS,
  type OperatorResolution,
} from "@/lib/billing/signup-2m4-exception-resolution";

export const dynamic = "force-dynamic";
export const metadata = { title: "Billing exception management" };

async function ackAction(formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  if (!hasPermission(p, null, "platform:signups:release")) redirect("/app/admin");
  try {
    await acknowledgeException({
      exceptionId: String(formData.get("id") ?? ""),
      acknowledgedByUserId: p.id,
    });
    revalidatePath("/app/admin/signup-ops/billing/exceptions");
    redirect("/app/admin/signup-ops/billing/exceptions?ok=acknowledged");
  } catch (err) {
    const msg = isAppError(err) ? err.safeMessage : "service_error";
    redirect(`/app/admin/signup-ops/billing/exceptions?error=${encodeURIComponent(msg)}`);
  }
}

async function resolveAction(formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  if (!hasPermission(p, null, "platform:signups:release")) redirect("/app/admin");
  const resolution = String(formData.get("resolution") ?? "") as OperatorResolution;
  if (!OPERATOR_RESOLUTIONS.includes(resolution)) {
    redirect("/app/admin/signup-ops/billing/exceptions?error=invalid_resolution");
  }
  try {
    await recordExceptionResolution({
      exceptionId: String(formData.get("id") ?? ""),
      resolvedByUserId: p.id,
      resolution,
      resolutionNotes: String(formData.get("notes") ?? ""),
    });
    revalidatePath("/app/admin/signup-ops/billing/exceptions");
    redirect("/app/admin/signup-ops/billing/exceptions?ok=resolved");
  } catch (err) {
    const msg = isAppError(err) ? err.safeMessage : "service_error";
    redirect(`/app/admin/signup-ops/billing/exceptions?error=${encodeURIComponent(msg)}`);
  }
}

async function escalateAction(formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  if (!hasPermission(p, null, "platform:signups:release")) redirect("/app/admin");
  try {
    await escalateException({
      exceptionId: String(formData.get("id") ?? ""),
      escalatedByUserId: p.id,
      escalationNotes: String(formData.get("escalationNotes") ?? ""),
    });
    revalidatePath("/app/admin/signup-ops/billing/exceptions");
    redirect("/app/admin/signup-ops/billing/exceptions?ok=escalated");
  } catch (err) {
    const msg = isAppError(err) ? err.safeMessage : "service_error";
    redirect(`/app/admin/signup-ops/billing/exceptions?error=${encodeURIComponent(msg)}`);
  }
}

export default async function ExceptionsPage({
  searchParams,
}: {
  searchParams: { ok?: string; error?: string; state?: string; category?: string; severity?: string };
}) {
  const p = await getCurrentPrincipal().catch(() => null);
  if (!p) redirect("/login?next=/app/admin/signup-ops/billing/exceptions");
  if (!hasPermission(p, null, "platform:signups:release")) {
    return (
      <main className="p-8">
        <h1 className="text-xl font-semibold mb-2">Billing exceptions</h1>
        <p className="text-sm text-neutral-600" data-testid="exceptions-forbidden">
          You do not have the required permission (platform:signups:release).
        </p>
      </main>
    );
  }

  const stateFilter = searchParams.state ?? "open";
  const categoryFilter = searchParams.category;
  const severityFilter = searchParams.severity;
  const whereBase: {
    billingCycle?: { clubId: string };
    category?: string;
    severity?: string;
    operatorAcknowledgedAt?: null;
    requiresOperatorAction?: boolean;
  } = {};
  if (categoryFilter) whereBase.category = categoryFilter;
  if (severityFilter) whereBase.severity = severityFilter;
  if (stateFilter === "open") {
    whereBase.operatorAcknowledgedAt = null;
    whereBase.requiresOperatorAction = true;
  }
  const rows = await prisma.billingExceptionCase.findMany({
    where: whereBase,
    orderBy: [{ severity: "asc" }, { createdAt: "desc" }],
    take: 50,
    select: {
      id: true, billingCycleId: true, category: true, severity: true,
      stripeEventId: true, stripeResourceId: true, requiresOperatorAction: true,
      operatorAcknowledgedByUserId: true, operatorAcknowledgedAt: true,
      operatorResolution: true, operatorResolutionNotes: true,
      syntheticTestOnly: true, createdAt: true,
      billingCycle: { select: { clubId: true } },
    },
  });

  const openCount = await prisma.billingExceptionCase.count({
    where: { operatorAcknowledgedAt: null, requiresOperatorAction: true },
  });

  return (
    <main className="p-8">
      <header className="mb-6">
        <div className="text-xs text-neutral-500 mb-1">
          <Link href="/app/admin/signup-ops/billing" className="underline">
            Billing lifecycle hub
          </Link>
          {" / "}
          Exceptions
        </div>
        <h1 className="text-xl font-semibold">Billing exception management</h1>
        <p className="text-sm text-neutral-600 mt-1">
          Payment failures, disputes, refunds, returned debits, renewal
          failures, and mandate invalidations.  Operators acknowledge
          an exception, record a resolution decision, and escalate for
          re-review as needed.  <strong>No row is ever deleted</strong>
          — historical financial evidence is preserved verbatim.
        </p>
      </header>

      <section className="mb-4 flex items-center gap-4" data-testid="exceptions-filters">
        <form className="flex items-center gap-2">
          <label className="text-xs text-neutral-500">State</label>
          <select name="state" defaultValue={stateFilter}
                  className="text-xs border border-neutral-300 rounded px-2 py-1">
            <option value="open">Open (requires action)</option>
            <option value="all">All</option>
          </select>
          <label className="text-xs text-neutral-500 ml-2">Category</label>
          <input name="category" defaultValue={categoryFilter ?? ""} placeholder="any"
                 className="text-xs border border-neutral-300 rounded px-2 py-1 w-40" />
          <label className="text-xs text-neutral-500 ml-2">Severity</label>
          <input name="severity" defaultValue={severityFilter ?? ""} placeholder="any"
                 className="text-xs border border-neutral-300 rounded px-2 py-1 w-28" />
          <button type="submit" className="text-xs rounded bg-neutral-800 text-white px-3 py-1">
            Filter
          </button>
        </form>
        <span className="ml-auto text-xs text-neutral-500">
          {openCount} open exception{openCount === 1 ? "" : "s"}
        </span>
      </section>

      {searchParams.ok && (
        <div className="mb-4 rounded-md border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          Action recorded ({searchParams.ok}).
        </div>
      )}
      {searchParams.error && (
        <div className="mb-4 rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          {searchParams.error}
        </div>
      )}

      {rows.length === 0 ? (
        <p className="text-sm text-neutral-500" data-testid="exceptions-empty">
          No exceptions match the current filter.
        </p>
      ) : (
        <div className="space-y-4" data-testid="exceptions-list">
          {rows.map((e) => (
            <div key={e.id} className="rounded-md border border-neutral-200 bg-white p-4">
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="inline-block rounded px-2 py-0.5 text-xs font-medium bg-neutral-200 text-neutral-800">
                      {e.category}
                    </span>
                    <span className="inline-block rounded px-2 py-0.5 text-xs font-medium bg-amber-100 text-amber-800">
                      {e.severity}
                    </span>
                    {e.syntheticTestOnly && (
                      <span className="inline-block rounded px-2 py-0.5 text-xs font-medium bg-neutral-100 text-neutral-700">
                        SYNTHETIC
                      </span>
                    )}
                    {e.operatorResolution && (
                      <span className="inline-block rounded px-2 py-0.5 text-xs font-medium bg-emerald-100 text-emerald-800">
                        {e.operatorResolution}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-neutral-500 mt-1">
                    Exception <code>{e.id.slice(-6)}</code>
                    {" / "}
                    Cycle <code>{e.billingCycleId.slice(-6)}</code>
                    {" / "}
                    Club <code>{e.billingCycle?.clubId.slice(-6) ?? "?"}</code>
                    {e.stripeEventId && <> {" / "} Stripe event <code>{e.stripeEventId.slice(-10)}</code></>}
                  </div>
                  <div className="text-xs text-neutral-500">
                    Raised {new Date(e.createdAt).toISOString()}
                    {e.operatorAcknowledgedAt
                      && <> {" / "} Acknowledged {new Date(e.operatorAcknowledgedAt).toISOString()}</>}
                  </div>
                  {e.operatorResolutionNotes && (
                    <p className="text-xs text-neutral-700 mt-2 whitespace-pre-wrap">
                      {e.operatorResolutionNotes}
                    </p>
                  )}
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-4">
                <form action={ackAction} className="rounded border border-neutral-200 bg-neutral-50 p-3">
                  <div className="text-xs font-semibold text-neutral-700 mb-1">1. Acknowledge</div>
                  <input type="hidden" name="id" value={e.id} />
                  <button type="submit"
                          disabled={!!e.operatorAcknowledgedAt}
                          className="w-full rounded bg-neutral-800 text-white text-xs py-1.5 disabled:opacity-50">
                    {e.operatorAcknowledgedAt ? "Already acknowledged" : "Acknowledge"}
                  </button>
                </form>
                <form action={resolveAction} className="rounded border border-neutral-200 bg-neutral-50 p-3">
                  <div className="text-xs font-semibold text-neutral-700 mb-1">2. Resolve</div>
                  <input type="hidden" name="id" value={e.id} />
                  <select name="resolution" defaultValue="NO_ACTION"
                          className="w-full text-xs border border-neutral-300 rounded px-2 py-1 mb-1">
                    {OPERATOR_RESOLUTIONS.map((r) => (<option key={r} value={r}>{r}</option>))}
                  </select>
                  <textarea name="notes" placeholder="Resolution notes"
                            className="w-full text-xs border border-neutral-300 rounded px-2 py-1 h-10" />
                  <button type="submit"
                          disabled={!e.operatorAcknowledgedAt}
                          className="mt-1 w-full rounded bg-emerald-700 text-white text-xs py-1.5 disabled:opacity-50">
                    Record resolution
                  </button>
                </form>
                <form action={escalateAction} className="rounded border border-neutral-200 bg-neutral-50 p-3">
                  <div className="text-xs font-semibold text-neutral-700 mb-1">3. Escalate</div>
                  <input type="hidden" name="id" value={e.id} />
                  <textarea name="escalationNotes" placeholder="Escalation reason"
                            className="w-full text-xs border border-neutral-300 rounded px-2 py-1 h-10" />
                  <button type="submit"
                          className="mt-1 w-full rounded bg-amber-700 text-white text-xs py-1.5">
                    Re-open for action
                  </button>
                </form>
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
