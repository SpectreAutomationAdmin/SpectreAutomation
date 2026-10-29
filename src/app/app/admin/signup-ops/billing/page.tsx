// SIGNUP-2 M4-INT §2 (2026-10-29) -- Operator billing lifecycle hub.
//
// SUPER_ADMIN-gated server component.  Composes the existing admin
// chrome (page title + neutral table) -- NO new design system.  Does
// NOT redesign the accepted M3 interface.  Dormant-feature banner
// surfaces the live-flag state so the operator sees whether a given
// path can execute writes.
//
// This page is intentionally minimal.  The authoritative API
// surfaces for operator actions live under /api/admin/billing/*;
// a richer UI is a separate follow-up slice (see M4-INT gap register,
// P1-4 and P1-5).

import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { getStatHolidayCalendarCoverage } from "@/lib/billing/signup-2m4-retries-service";

export const dynamic = "force-dynamic";
export const metadata = { title: "Billing lifecycle operator hub" };

interface FlagLine {
  envVar: string;
  live: boolean;
  what: string;
}

function readFlagLines(): FlagLine[] {
  const read = (envVar: string, what: string): FlagLine => ({
    envVar,
    live: process.env[envVar] === "1",
    what,
  });
  return [
    read("SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION", "Global sub-create block (M3 §7)"),
    read("SPECTRE_SIGNUP_2M4_TRIGGER_LIVE", "M4-triggering (commercial authorization + payment release)"),
    read("SPECTRE_SIGNUP_2M4_SETTLEMENT_LIVE", "M4-settlement (invoice + dispute webhook writers)"),
    read("SPECTRE_SIGNUP_2M4_RETRIES_LIVE", "M4-retries (one controlled retry at 3 business days)"),
    read("SPECTRE_SIGNUP_2M4_RENEWAL_LIVE", "M4-renewal (T-45 + T-7 preflights)"),
    read("SPECTRE_SIGNUP_2M4_CANCELLATION_LIVE", "M4-cancellation (full lifecycle)"),
  ];
}

export default async function BillingOperatorHubPage() {
  const principal = await getCurrentPrincipal().catch(() => null);
  if (!principal) redirect("/login?next=/app/admin/signup-ops/billing");
  if (!hasPermission(principal, null, "platform:signups:release")) {
    return (
      <main className="p-8">
        <h1 className="text-xl font-semibold mb-2">Billing lifecycle operator hub</h1>
        <p className="text-sm text-neutral-600" data-testid="billing-ops-forbidden">
          You do not have the required permission (platform:signups:release).
        </p>
      </main>
    );
  }

  // Read-only observability queries.  No writes.
  const [
    openCancellations,
    pendingCommands,
    openExceptions,
    duePreflights,
  ] = await Promise.all([
    prisma.billingCancellationRequest.count({
      where: { state: { in: ["REQUESTED", "AUTHORIZED", "SCHEDULED"] } },
    }),
    prisma.billingCommand.count({ where: { state: "PENDING" } }),
    prisma.billingExceptionCase.count({ where: { requiresOperatorAction: true, operatorAcknowledgedAt: null } }),
    prisma.billingRenewalPreflight.count({
      where: { executedAt: null, scheduledFor: { lte: new Date() } },
    }),
  ]);

  const flags = readFlagLines();
  const anyLive = flags.some((f) => f.live);
  const coverage = getStatHolidayCalendarCoverage();
  const yearsRemainingInCoverage = coverage.latestCoveredYear - new Date().getUTCFullYear();

  return (
    <main className="p-8">
      <header className="mb-6">
        <h1 className="text-xl font-semibold">Billing lifecycle operator hub</h1>
        <p className="text-sm text-neutral-600 mt-1">
          Platform-level operator view of the signup-to-active-tenant
          billing journey.  Shows aggregate counts + flag state; use the
          API routes under <code className="text-xs">/api/admin/billing/*</code>
          to invoke operator actions.  All writes are gated by the
          per-slice live flag; GETs are always permitted.
        </p>
      </header>

      {!anyLive && (
        <div className="mb-6 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800"
             data-testid="billing-ops-dormant-banner">
          <strong>Dormant.</strong>{" "}
          Every M4 live flag is OFF on this environment.  Operator write
          actions will refuse with a <code>ForbiddenError</code>.  Read /
          observability endpoints remain available.
        </div>
      )}

      <section className="mb-8" data-testid="billing-ops-counts">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500 mb-3">
          Lifecycle observability
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard label="Open cancellation requests" value={openCancellations} />
          <StatCard label="Pending billing commands" value={pendingCommands} />
          <StatCard label="Exceptions needing action" value={openExceptions} />
          <StatCard label="Due renewal preflights" value={duePreflights} />
        </div>
      </section>

      <section className="mb-8" data-testid="billing-ops-flags">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500 mb-3">
          Live-flag state
        </h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left border-b border-neutral-200">
              <th className="py-2 pr-4 font-medium">Flag</th>
              <th className="py-2 pr-4 font-medium">What it gates</th>
              <th className="py-2 pr-4 font-medium">State</th>
            </tr>
          </thead>
          <tbody>
            {flags.map((f) => (
              <tr key={f.envVar} className="border-b border-neutral-100">
                <td className="py-2 pr-4 text-xs font-mono text-neutral-700">{f.envVar}</td>
                <td className="py-2 pr-4 text-neutral-700">{f.what}</td>
                <td className="py-2 pr-4">
                  {f.live ? (
                    <span className="inline-block rounded px-2 py-0.5 text-xs font-medium bg-emerald-100 text-emerald-800">
                      LIVE
                    </span>
                  ) : (
                    <span className="inline-block rounded px-2 py-0.5 text-xs font-medium bg-neutral-200 text-neutral-700">
                      OFF
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="mb-8" data-testid="billing-ops-calendar">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500 mb-3">
          Canadian stat-holiday calendar coverage (fail-closed for retries)
        </h2>
        <p className="text-sm text-neutral-700">
          Covers through <strong>{coverage.latestCoveredYear}</strong>{" "}
          ({coverage.totalEntries} entries).{" "}
          {yearsRemainingInCoverage >= 1
            ? `${yearsRemainingInCoverage} year${yearsRemainingInCoverage === 1 ? "" : "s"} of forward coverage.`
            : <strong className="text-red-700">Coverage is at or past the current year -- extend before next renewal flag flip.</strong>}
        </p>
        <p className="text-xs text-neutral-500 mt-2">
          Retries that compute a date in an uncovered year are now
          <strong> refused </strong>at scheduling time (M4-INT §5 correction).
        </p>
      </section>

      <section className="mb-8" data-testid="billing-ops-workflows">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500 mb-3">
          Operator workflows
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Link href="/app/admin/signup-ops/billing/triggering"
                className="block rounded-md border border-neutral-200 bg-white p-4 hover:border-neutral-400"
                data-testid="link-triggering">
            <div className="text-sm font-semibold text-neutral-800">Commercial authorization + payment release</div>
            <div className="text-xs text-neutral-500 mt-1">
              Operator A records commercial authorization; operator B records payment release (SoD enforced).
            </div>
          </Link>
          <Link href="/app/admin/signup-ops/billing/exceptions"
                className="block rounded-md border border-neutral-200 bg-white p-4 hover:border-neutral-400"
                data-testid="link-exceptions">
            <div className="text-sm font-semibold text-neutral-800">Billing exception management</div>
            <div className="text-xs text-neutral-500 mt-1">
              Acknowledge, resolve, escalate. {openExceptions} open exception{openExceptions === 1 ? "" : "s"} needing action.
            </div>
          </Link>
          <Link href="/app/admin/signup-ops/billing/renewal-review"
                className="block rounded-md border border-neutral-200 bg-white p-4 hover:border-neutral-400"
                data-testid="link-renewal-review">
            <div className="text-sm font-semibold text-neutral-800">Renewal review</div>
            <div className="text-xs text-neutral-500 mt-1">
              Review preflights with pricing drift, invalid mandate, or missing evidence.  Routine READY preflights do not appear here.
            </div>
          </Link>
          <Link href="/app/admin/signup-ops/billing/cancellation"
                className="block rounded-md border border-neutral-200 bg-white p-4 hover:border-neutral-400"
                data-testid="link-cancellation">
            <div className="text-sm font-semibold text-neutral-800">Cancellation lifecycle</div>
            <div className="text-xs text-neutral-500 mt-1">
              Request → authorize → schedule → effective → cancelled.  SoD on authorize + reverse.  {openCancellations} open request{openCancellations === 1 ? "" : "s"}.
            </div>
          </Link>
        </div>
      </section>

      <section data-testid="billing-ops-links">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500 mb-3">
          Operator API endpoints (direct)
        </h2>
        <ul className="text-sm space-y-1 text-neutral-700">
          <li>
            <code className="text-xs font-mono">POST /api/admin/billing/triggering</code>{" "}
            — {`{ action: "record-commercial-auth" | "release" | "drain" }`}.
          </li>
          <li>
            <code className="text-xs font-mono">GET /api/admin/billing/exceptions</code>
            {" / "}
            <code className="text-xs font-mono">POST /api/admin/billing/exceptions</code>{" "}
            — {`{ action: "acknowledge" | "resolve" | "escalate" }`}.
          </li>
          <li>
            <code className="text-xs font-mono">GET /api/admin/billing/renewal-review</code>
            {" / "}
            <code className="text-xs font-mono">POST /api/admin/billing/renewal-review</code>{" "}
            — {`{ action: "review", outcome: "APPROVED" | "REJECTED" | "RETURN_FOR_CORRECTION" }`}.
          </li>
          <li>
            <code className="text-xs font-mono">GET / POST /api/admin/billing/cancellation</code>{" "}
            — see cancellation page.
          </li>
          <li>
            <code className="text-xs font-mono">POST /api/admin/billing/email-adapter-probe</code>{" "}
            — safe (non-collection) delivery probe through Microsoft 365.
          </li>
          <li>
            <code className="text-xs font-mono">GET  /api/admin/billing/renewal-preflight-probe</code>{" "}
            — read preflight pipeline health + calendar coverage.
          </li>
          <li>
            <code className="text-xs font-mono">POST /api/admin/billing/renewal-preflight-probe</code>{" "}
            — invoke the recovery sweep (dry-run when the renewal flag is OFF).
          </li>
        </ul>
        <p className="mt-4 text-xs text-neutral-500">
          See{" "}
          <Link href="/app/admin/signup-ops" className="underline">
            the signup verification queue
          </Link>
          {" "}for the registration-side operator workflow.
        </p>
      </section>
    </main>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-neutral-200 bg-white px-4 py-3">
      <div className="text-xs text-neutral-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}
