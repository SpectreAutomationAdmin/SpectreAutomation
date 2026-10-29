// SIGNUP-2 M4-INT-B §3 (2026-10-29) -- Renewal review operator page.
//
// SUPER_ADMIN-gated.  Lists preflights that need operator attention
// (non-READY outcome, un-reviewed) with the specific reason: pricing
// drift, mandate invalidated, missing contract evidence, tax
// treatment changes.  Operator records APPROVED / REJECTED /
// RETURN_FOR_CORRECTION with notes.
//
// Routine renewals (READY outcome) do NOT appear here -- they do
// not require operator approval when all authorized terms are
// unchanged.  §3 of the directive: "Routine renewals should not
// require unnecessary manual approval when all authorized terms
// remain unchanged."

import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { isAppError } from "@/lib/errors";
import {
  listPreflightsAwaitingReview,
  recordRenewalReview,
  RENEWAL_REVIEW_OUTCOMES,
  type RenewalReviewOutcome,
} from "@/lib/billing/signup-2m4-renewal-review";

export const dynamic = "force-dynamic";
export const metadata = { title: "Renewal review" };

async function reviewAction(formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  if (!hasPermission(p, null, "platform:signups:release")) redirect("/app/admin");
  const outcome = String(formData.get("outcome") ?? "") as RenewalReviewOutcome;
  if (!RENEWAL_REVIEW_OUTCOMES.includes(outcome)) {
    redirect("/app/admin/signup-ops/billing/renewal-review?error=invalid_outcome");
  }
  try {
    await recordRenewalReview({
      preflightId: String(formData.get("id") ?? ""),
      reviewedByUserId: p.id,
      outcome,
      reviewNotes: String(formData.get("notes") ?? ""),
    });
    revalidatePath("/app/admin/signup-ops/billing/renewal-review");
    redirect(`/app/admin/signup-ops/billing/renewal-review?ok=${outcome}`);
  } catch (err) {
    const msg = isAppError(err) ? err.safeMessage : "service_error";
    redirect(`/app/admin/signup-ops/billing/renewal-review?error=${encodeURIComponent(msg)}`);
  }
}

const OUTCOME_HINT: Record<string, string> = {
  MANDATE_EXPIRED: "The ACSS debit mandate is no longer valid.  Request a fresh mandate before renewal.",
  PRICING_CHANGED: "Pricing drift detected between the authorized subscription and current pricing table.  Do not silently apply changed pricing — issue a new commercial authorization or return for correction.",
  TAX_TREATMENT_CHANGED: "Tax treatment / rate has changed since authorization.  Confirm the correct treatment before approving.",
  CYCLE_NOT_FOUND: "The underlying BillingCycle could not be loaded.  Investigate before approving.",
  ERROR: "Preflight execution raised an unexpected error.  Review the preflight log.",
};

export default async function RenewalReviewPage({
  searchParams,
}: {
  searchParams: { ok?: string; error?: string };
}) {
  const p = await getCurrentPrincipal().catch(() => null);
  if (!p) redirect("/login?next=/app/admin/signup-ops/billing/renewal-review");
  if (!hasPermission(p, null, "platform:signups:release")) {
    return (
      <main className="p-8">
        <h1 className="text-xl font-semibold mb-2">Renewal review</h1>
        <p className="text-sm text-neutral-600" data-testid="renewal-review-forbidden">
          You do not have the required permission (platform:signups:release).
        </p>
      </main>
    );
  }

  const rows = await listPreflightsAwaitingReview(50);

  return (
    <main className="p-8">
      <header className="mb-6">
        <div className="text-xs text-neutral-500 mb-1">
          <Link href="/app/admin/signup-ops/billing" className="underline">
            Billing lifecycle hub
          </Link>
          {" / "}
          Renewal review
        </div>
        <h1 className="text-xl font-semibold">Renewal review</h1>
        <p className="text-sm text-neutral-600 mt-1">
          Preflights whose outcome requires human attention
          (<code className="text-xs">PRICING_CHANGED</code>, {" "}
          <code className="text-xs">MANDATE_EXPIRED</code>, {" "}
          <code className="text-xs">TAX_TREATMENT_CHANGED</code>, etc.).
          Routine READY preflights do not appear here -- they advance
          automatically.
        </p>
      </header>

      {searchParams.ok && (
        <div className="mb-4 rounded-md border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          Recorded operator decision: <strong>{searchParams.ok}</strong>.
        </div>
      )}
      {searchParams.error && (
        <div className="mb-4 rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          {searchParams.error}
        </div>
      )}

      {rows.length === 0 ? (
        <p className="text-sm text-neutral-500" data-testid="renewal-review-empty">
          No renewal preflights currently need operator review.
        </p>
      ) : (
        <div className="space-y-4" data-testid="renewal-review-list">
          {rows.map((r) => {
            const hint = OUTCOME_HINT[r.outcome ?? ""] ?? null;
            return (
              <div key={r.id} className="rounded-md border border-neutral-200 bg-white p-4">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="inline-block rounded px-2 py-0.5 text-xs font-medium bg-neutral-200 text-neutral-800">
                        {r.checkpointLabel}
                      </span>
                      <span className="inline-block rounded px-2 py-0.5 text-xs font-medium bg-amber-100 text-amber-800">
                        {r.outcome ?? "UNKNOWN"}
                      </span>
                      {r.renewalPricingDriftDetected && (
                        <span className="inline-block rounded px-2 py-0.5 text-xs font-medium bg-red-100 text-red-800">
                          PRICING_DRIFT
                        </span>
                      )}
                      {r.mandateStillValid === false && (
                        <span className="inline-block rounded px-2 py-0.5 text-xs font-medium bg-red-100 text-red-800">
                          MANDATE_INVALID
                        </span>
                      )}
                      {r.syntheticTestOnly && (
                        <span className="inline-block rounded px-2 py-0.5 text-xs font-medium bg-neutral-100 text-neutral-700">
                          SYNTHETIC
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-neutral-500 mt-1">
                      Preflight <code>{r.id.slice(-6)}</code>
                      {" / "} Cycle <code>{r.billingCycleId.slice(-6)}</code>
                      {" / "} Club <code>{r.clubId.slice(-6)}</code>
                    </div>
                    <div className="text-xs text-neutral-500">
                      Scheduled {r.scheduledFor.toISOString()}
                      {" / "} Executed {r.executedAt?.toISOString() ?? "(pending)"}
                    </div>
                    {hint && (
                      <p className="text-xs text-amber-800 mt-2"><em>{hint}</em></p>
                    )}
                  </div>
                </div>
                <form action={reviewAction} className="mt-4 rounded border border-neutral-200 bg-neutral-50 p-3">
                  <input type="hidden" name="id" value={r.id} />
                  <div className="flex items-center gap-2 mb-2">
                    <label className="text-xs font-semibold text-neutral-700">Decision</label>
                    <select name="outcome" defaultValue="RETURN_FOR_CORRECTION"
                            className="text-xs border border-neutral-300 rounded px-2 py-1">
                      {RENEWAL_REVIEW_OUTCOMES.map((o) => (<option key={o} value={o}>{o}</option>))}
                    </select>
                  </div>
                  <textarea name="notes" placeholder="Review notes (required)"
                            required
                            className="w-full text-xs border border-neutral-300 rounded px-2 py-1 h-16" />
                  <button type="submit"
                          className="mt-2 w-full rounded bg-neutral-800 text-white text-xs py-1.5">
                    Record decision
                  </button>
                </form>
              </div>
            );
          })}
        </div>
      )}
    </main>
  );
}
