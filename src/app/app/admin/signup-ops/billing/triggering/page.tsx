// SIGNUP-2 M4-INT-B §1 (2026-10-29) -- Commercial authorization +
// payment release operator page.
//
// SUPER_ADMIN-gated server component.  Composes existing admin
// chrome -- no new design system.  Preserves accepted global
// navigation + top chrome.  Dormant-feature banner surfaces the
// live-flag state so the operator sees whether a release action
// can execute.

import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { isAppError } from "@/lib/errors";
import {
  evaluatePreflight,
  recordCommercialAuthorisation,
  authoriseAndReleaseFirstBilling,
} from "@/lib/billing/signup-2m4-triggering-service";

export const dynamic = "force-dynamic";
export const metadata = { title: "Commercial authorization + payment release" };

async function commercialAuthAction(formData: FormData) {
  "use server";
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  if (!hasPermission(principal, null, "platform:signups:release")) redirect("/app/admin");
  const signupRegistrationId = String(formData.get("signupRegistrationId") ?? "");
  const notes = String(formData.get("notes") ?? "") || undefined;
  try {
    await recordCommercialAuthorisation({
      signupRegistrationId,
      commercialApprovedByUserId: principal.id,
      commercialApprovalNotes: notes,
    });
    revalidatePath("/app/admin/signup-ops/billing/triggering");
    redirect("/app/admin/signup-ops/billing/triggering?ok=commercial");
  } catch (err) {
    const msg = isAppError(err) ? err.safeMessage : "service_error";
    redirect(`/app/admin/signup-ops/billing/triggering?error=${encodeURIComponent(msg)}`);
  }
}

async function releaseAction(formData: FormData) {
  "use server";
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  if (!hasPermission(principal, null, "platform:signups:release")) redirect("/app/admin");
  const signupRegistrationId = String(formData.get("signupRegistrationId") ?? "");
  const billingCycleId = String(formData.get("billingCycleId") ?? "");
  const notes = String(formData.get("notes") ?? "") || undefined;
  const idempotencyScope = String(formData.get("idempotencyScope") ?? `release:${Date.now()}`);
  try {
    await authoriseAndReleaseFirstBilling({
      signupRegistrationId,
      billingCycleId,
      releaseApprovedByUserId: principal.id,
      releaseApprovalNotes: notes,
      idempotencyScope,
    });
    revalidatePath("/app/admin/signup-ops/billing/triggering");
    redirect("/app/admin/signup-ops/billing/triggering?ok=release");
  } catch (err) {
    const msg = isAppError(err) ? err.safeMessage : "service_error";
    redirect(`/app/admin/signup-ops/billing/triggering?error=${encodeURIComponent(msg)}`);
  }
}

interface Candidate {
  billingCycleId: string;
  clubId: string;
  signupRegistrationId: string | null;
  subscriptionStatus: string;
  syntheticTestOnly: boolean;
  createdAt: Date;
}

export default async function TriggeringPage({
  searchParams,
}: {
  searchParams: { ok?: string; error?: string };
}) {
  const principal = await getCurrentPrincipal().catch(() => null);
  if (!principal) redirect("/login?next=/app/admin/signup-ops/billing/triggering");
  if (!hasPermission(principal, null, "platform:signups:release")) {
    return (
      <main className="p-8">
        <h1 className="text-xl font-semibold mb-2">Commercial authorization + payment release</h1>
        <p className="text-sm text-neutral-600" data-testid="triggering-forbidden">
          You do not have the required permission (platform:signups:release).
        </p>
      </main>
    );
  }

  const triggerLive = process.env.SPECTRE_SIGNUP_2M4_TRIGGER_LIVE === "1";
  const paymentInitiationLive = process.env.SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION === "1";

  // Candidate cycles that are ready for the commercial authorization +
  // release step (bank-verified, no existing release / command).
  const candidateRows = await prisma.billingCycle.findMany({
    where: { subscriptionStatus: "BANK_VERIFIED" },
    orderBy: { createdAt: "desc" },
    take: 25,
    select: {
      id: true, clubId: true, subscriptionStatus: true, syntheticTestOnly: true,
      createdAt: true,
      releasedByOperatorRecord: { select: { signupRegistrationId: true } },
    },
  });

  // Preflight each candidate (pure read).  Shows refusal reason so
  // the operator sees what to fix.
  const candidates: Array<Candidate & {
    preflightOk: boolean;
    preflightReason?: string | null;
    preflightDetail?: string | null;
    commercialAuthRecorded?: boolean;
  }> = [];
  for (const r of candidateRows) {
    const signupRegistrationId = r.releasedByOperatorRecord?.signupRegistrationId ?? null;
    if (!signupRegistrationId) {
      candidates.push({
        billingCycleId: r.id, clubId: r.clubId, signupRegistrationId: null,
        subscriptionStatus: r.subscriptionStatus, syntheticTestOnly: r.syntheticTestOnly,
        createdAt: r.createdAt, preflightOk: false,
        preflightReason: "NO_LINKED_REGISTRATION",
      });
      continue;
    }
    let preflight: Awaited<ReturnType<typeof evaluatePreflight>> | null = null;
    try {
      preflight = await evaluatePreflight({ signupRegistrationId, billingCycleId: r.id });
    } catch { /* swallow -- display as unknown */ }
    // Secondary read: has commercial authorization been recorded?
    const auth = await prisma.clubPaymentAuthorisation.findUnique({
      where: { signupRegistrationId },
      select: { id: true },
    });
    candidates.push({
      billingCycleId: r.id,
      clubId: r.clubId,
      signupRegistrationId,
      subscriptionStatus: r.subscriptionStatus,
      syntheticTestOnly: r.syntheticTestOnly,
      createdAt: r.createdAt,
      preflightOk: preflight?.ok ?? false,
      preflightReason: preflight?.reason ?? null,
      preflightDetail: preflight?.detail ?? null,
      commercialAuthRecorded: !!auth,
    });
  }

  return (
    <main className="p-8">
      <header className="mb-6">
        <div className="text-xs text-neutral-500 mb-1">
          <Link href="/app/admin/signup-ops/billing" className="underline">
            Billing lifecycle hub
          </Link>
          {" / "}
          Commercial authorization + payment release
        </div>
        <h1 className="text-xl font-semibold">Commercial authorization + payment release</h1>
        <p className="text-sm text-neutral-600 mt-1">
          Operator A records the commercial authorization.  Operator B
          (different user) records the payment release and the system
          enqueues a durable BillingCommand for the Stripe subscription
          create.  No Stripe call fires until the drain worker runs
          AND both live flags are ON.
        </p>
      </header>

      {!triggerLive && (
        <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800"
             data-testid="triggering-dormant-banner">
          <strong>Dormant.</strong>{" "}
          <code className="text-xs">SPECTRE_SIGNUP_2M4_TRIGGER_LIVE</code> is OFF.
          Commercial authorization + release server actions will refuse.
        </div>
      )}
      {triggerLive && !paymentInitiationLive && (
        <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800"
             data-testid="triggering-payment-init-off">
          <strong>Partially dormant.</strong>{" "}
          Trigger flag is ON but <code className="text-xs">SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION</code>
          {" "}is OFF.  Releases will be recorded but the drain worker will refuse to call the payment processor.
        </div>
      )}
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

      <section data-testid="triggering-candidates">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500 mb-3">
          Bank-verified cycles awaiting authorization + release ({candidates.length})
        </h2>
        {candidates.length === 0 ? (
          <p className="text-sm text-neutral-500">
            No bank-verified cycles are currently awaiting commercial authorization or payment release.
          </p>
        ) : (
          <div className="space-y-4">
            {candidates.map((c) => (
              <div key={c.billingCycleId} className="rounded-md border border-neutral-200 bg-white p-4">
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <div className="text-xs text-neutral-500">
                      Cycle <code>{c.billingCycleId.slice(-6)}</code>
                      {" / "}
                      Club <code>{c.clubId.slice(-6)}</code>
                      {c.signupRegistrationId
                        ? <> {" / "} Reg <code>{c.signupRegistrationId.slice(-6)}</code></>
                        : null}
                      {c.syntheticTestOnly && (
                        <span className="ml-2 inline-block rounded px-2 py-0.5 text-xs font-medium bg-neutral-200 text-neutral-700">
                          SYNTHETIC
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-neutral-500 mt-0.5">
                      Created {new Date(c.createdAt).toISOString()}
                    </div>
                  </div>
                  <div>
                    {c.preflightOk ? (
                      <span className="inline-block rounded px-2 py-0.5 text-xs font-medium bg-emerald-100 text-emerald-800">
                        READY
                      </span>
                    ) : (
                      <span className="inline-block rounded px-2 py-0.5 text-xs font-medium bg-amber-100 text-amber-800">
                        {c.preflightReason ?? "NOT_READY"}
                      </span>
                    )}
                  </div>
                </div>
                {c.preflightDetail && (
                  <p className="text-xs text-neutral-600 mb-2"><em>{c.preflightDetail}</em></p>
                )}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-3">
                  <form action={commercialAuthAction} className="rounded-md border border-neutral-200 bg-neutral-50 p-3">
                    <div className="text-xs font-semibold text-neutral-700 mb-2">Operator A — commercial authorization</div>
                    <input type="hidden" name="signupRegistrationId" value={c.signupRegistrationId ?? ""} />
                    {c.commercialAuthRecorded && (
                      <div className="mb-2 text-xs text-emerald-700">✓ already recorded</div>
                    )}
                    <textarea
                      name="notes"
                      placeholder="Approval notes (optional)"
                      className="w-full text-xs border border-neutral-300 rounded px-2 py-1 h-16"
                      disabled={c.commercialAuthRecorded}
                    />
                    <button
                      type="submit"
                      disabled={!c.signupRegistrationId || !triggerLive || c.commercialAuthRecorded}
                      className="mt-2 w-full rounded bg-neutral-800 text-white text-xs py-1.5 disabled:opacity-50">
                      Record commercial authorization
                    </button>
                  </form>
                  <form action={releaseAction} className="rounded-md border border-neutral-200 bg-neutral-50 p-3">
                    <div className="text-xs font-semibold text-neutral-700 mb-2">Operator B — payment release (SoD)</div>
                    <input type="hidden" name="signupRegistrationId" value={c.signupRegistrationId ?? ""} />
                    <input type="hidden" name="billingCycleId" value={c.billingCycleId} />
                    <input type="hidden" name="idempotencyScope" value={`release:${c.billingCycleId}:v1`} />
                    <textarea
                      name="notes"
                      placeholder="Release notes (optional)"
                      className="w-full text-xs border border-neutral-300 rounded px-2 py-1 h-16"
                      disabled={!c.preflightOk}
                    />
                    <button
                      type="submit"
                      disabled={!c.preflightOk || !triggerLive}
                      className="mt-2 w-full rounded bg-emerald-700 text-white text-xs py-1.5 disabled:opacity-50">
                      Record payment release
                    </button>
                  </form>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
