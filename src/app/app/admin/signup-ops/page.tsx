// SIGNUP-2 Phase 2D (2026-10-25) -- Operator queue page.
//
// Minimal, super-admin-gated queue of HOLD_FOR_REVIEW registrations.
// Reads via the service module (no inline Prisma) so the page is a
// thin render.  Each row links to the per-registration review page.
//
// The eight queue states correspond to the Phase 2D UI contract (§4).

import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import {
  readOperatorQueue,
  computeQueueState,
} from "@/lib/signup/operator-verification";

export const dynamic = "force-dynamic";
export const metadata = { title: "Signup verification queue" };

const STATE_COPY: Record<string, string> = {
  AWAITING_STANDING: "Awaiting organisation verification",
  AWAITING_AUTHORITY: "Awaiting signing-authority verification",
  CONFLICTING_EVIDENCE: "Conflicting evidence",
  INSUFFICIENT_EVIDENCE: "Insufficient evidence",
  SUSPECTED_IMPERSONATION: "Suspected impersonation",
  READY_FOR_RELEASE: "Ready for final release",
  RELEASED: "Released",
  REJECTED: "Rejected",
};

export default async function SignupOperatorQueuePage() {
  const principal = await getCurrentPrincipal().catch(() => null);
  if (!principal) redirect("/login?next=/app/admin/signup-ops");
  if (!hasPermission(principal, null, "platform:signups:release")) {
    return (
      <main className="p-8">
        <h1 className="text-xl font-semibold mb-2">Signup operator queue</h1>
        <p className="text-sm text-neutral-600" data-testid="signup-ops-forbidden">
          You do not have the required permission (platform:signups:release).
        </p>
      </main>
    );
  }

  const rows = await readOperatorQueue(50);

  return (
    <main className="p-8">
      <header className="mb-6">
        <h1 className="text-xl font-semibold">Signup verification queue</h1>
        <p className="text-sm text-neutral-600 mt-1">
          Registrations awaiting operator action.  Three distinct operators
          are required: organisation standing, signing authority, final release.
        </p>
      </header>
      <table className="w-full text-sm" data-testid="signup-ops-queue-table">
        <thead>
          <tr className="text-left border-b border-neutral-200">
            <th className="py-2 pr-4">Club</th>
            <th className="py-2 pr-4">Jurisdiction</th>
            <th className="py-2 pr-4">State</th>
            <th className="py-2 pr-4">Created</th>
            <th className="py-2 pr-4">Action</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={5} className="py-6 text-center text-neutral-500" data-testid="signup-ops-queue-empty">
                No registrations currently awaiting operator action.
              </td>
            </tr>
          ) : (
            rows.map((r) => {
              const state = computeQueueState({
                verdict: "HOLD_FOR_REVIEW",
                holdCategory: r.registration.verificationHoldCategory,
                standingVerified: !!r.standingLatest && r.standingLatest.finding === "VERIFIED",
                authorityVerified: !!r.authorityLatest && r.authorityLatest.finding === "VERIFIED",
              });
              return (
                <tr
                  key={r.registration.id}
                  className="border-b border-neutral-100"
                  data-testid="signup-ops-queue-row"
                  data-registration-id={r.registration.id}
                  data-state={state}
                >
                  <td className="py-3 pr-4">
                    <span className="font-medium">{r.registration.legalName}</span>
                    {r.registration.operatingName ? (
                      <span className="text-neutral-500 text-xs block">{r.registration.operatingName}</span>
                    ) : null}
                  </td>
                  <td className="py-3 pr-4 text-neutral-700">
                    {r.registration.country}-{r.registration.provinceState}
                  </td>
                  <td className="py-3 pr-4" data-testid="signup-ops-queue-state">
                    {STATE_COPY[state] ?? state}
                  </td>
                  <td className="py-3 pr-4 text-neutral-500">
                    {new Date(r.registration.createdAt).toLocaleDateString("en-CA")}
                  </td>
                  <td className="py-3 pr-4">
                    <Link
                      href={`/app/admin/signup-ops/registration/${r.registration.id}`}
                      className="text-sm underline"
                      data-testid="signup-ops-queue-review-link"
                    >
                      Review &rarr;
                    </Link>
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </main>
  );
}
