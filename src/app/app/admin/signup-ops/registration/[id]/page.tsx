// SIGNUP-2 Phase 2D (2026-10-25) -- Operator review page.
//
// Minimal review surface for a single HOLD_FOR_REVIEW registration.
// Shows the three verification artefacts (classifier, attestation,
// standing check) + the latest OperatorVerificationRecord rows + the
// per-concept evidence forms + the final release / reject actions.
//
// Does NOT surface internal fraud / impersonation indicators to the
// applicant-facing side (Phase 2C invariant preserved).
//
// All POSTs go through the Phase 2D API routes which enforce fail-
// closed flag + permission + separation-of-duties + idempotency.

import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import {
  computeQueueState,
  latestRecord,
  readReleasePrerequisites,
} from "@/lib/signup/operator-verification";

export const dynamic = "force-dynamic";
export const metadata = { title: "Signup registration review" };

export default async function SignupOperatorReviewPage({
  params,
}: {
  params: { id: string };
}) {
  const principal = await getCurrentPrincipal().catch(() => null);
  if (!principal) redirect(`/login?next=/app/admin/signup-ops/registration/${params.id}`);
  if (!hasPermission(principal, null, "platform:signups:release")) {
    return (
      <main className="p-8">
        <p className="text-sm text-red-600" data-testid="signup-ops-review-forbidden">
          You do not have the required permission (platform:signups:release).
        </p>
      </main>
    );
  }

  const reg = await prisma.signupRegistration.findUnique({
    where: { id: params.id },
    select: {
      id: true,
      legalName: true,
      operatingName: true,
      country: true,
      provinceState: true,
      addressLine1: true,
      city: true,
      postalCode: true,
      websiteUrl: true,
      adminEmail: true,
      adminDisplayName: true,
      adminVerifiedAt: true,
      step: true,
      status: true,
      ownershipVerificationState: true,
      verificationVerdict: true,
      verificationHoldCategory: true,
      verificationDecidedAt: true,
      createdAt: true,
    },
  });
  if (!reg) notFound();

  const attestation = await prisma.subscriptionAuthorisationAttestation.findUnique({
    where: { signupRegistrationId: reg.id },
    select: {
      id: true,
      signatoryFullName: true,
      signatoryTitle: true,
      termsVersionLabel: true,
      acceptedAt: true,
    },
  });

  const standingCheck = await prisma.entityStandingCheck.findFirst({
    where: { signupRegistrationId: reg.id },
    orderBy: { fetchedAt: "desc" },
    select: {
      id: true,
      jurisdiction: true,
      standing: true,
      officerMatch: true,
      fetchedAt: true,
    },
  });

  const [standLatest, authLatest, releaseRow, rejectRow] = await Promise.all([
    latestRecord(reg.id, "STANDING"),
    latestRecord(reg.id, "AUTHORITY"),
    latestRecord(reg.id, "RELEASE"),
    latestRecord(reg.id, "REJECT"),
  ]);

  const prereq = await readReleasePrerequisites(reg.id);
  const now = Date.now();
  const standingValid =
    !!prereq.standingRecord &&
    (!prereq.standingRecord.expiresAt || prereq.standingRecord.expiresAt.getTime() >= now);
  const authorityValid =
    !!prereq.authorityRecord &&
    (!prereq.authorityRecord.expiresAt || prereq.authorityRecord.expiresAt.getTime() >= now);

  const state = computeQueueState({
    verdict: reg.verificationVerdict,
    holdCategory: reg.verificationHoldCategory,
    standingVerified: !!standLatest && standLatest.finding === "VERIFIED",
    authorityVerified: !!authLatest && authLatest.finding === "VERIFIED",
  });

  const samePersonAsApplicant =
    !!reg.adminEmail && !!principal.email &&
    reg.adminEmail.toLowerCase() === principal.email.toLowerCase();

  const canStanding =
    !samePersonAsApplicant &&
    reg.verificationVerdict === "HOLD_FOR_REVIEW" &&
    (!authLatest || authLatest.operatorUserId !== principal.id);
  const canAuthority =
    !samePersonAsApplicant &&
    reg.verificationVerdict === "HOLD_FOR_REVIEW" &&
    (!standLatest || standLatest.operatorUserId !== principal.id);
  const canRelease =
    !samePersonAsApplicant &&
    reg.verificationVerdict === "HOLD_FOR_REVIEW" &&
    standingValid && authorityValid &&
    !!standLatest && !!authLatest &&
    standLatest.operatorUserId !== authLatest.operatorUserId &&
    principal.id !== standLatest.operatorUserId &&
    principal.id !== authLatest.operatorUserId &&
    reg.verificationHoldCategory !== "CONFLICTING_EVIDENCE" &&
    reg.verificationHoldCategory !== "SUSPECTED_IMPERSONATION";
  const canReject =
    !samePersonAsApplicant && reg.verificationVerdict === "HOLD_FOR_REVIEW";

  return (
    <main className="p-8 max-w-3xl mx-auto">
      <nav className="mb-4 text-sm">
        <Link href="/app/admin/signup-ops" className="underline">&larr; Back to queue</Link>
      </nav>

      <header className="mb-6">
        <h1 className="text-xl font-semibold" data-testid="signup-ops-review-legal-name">
          {reg.legalName}
        </h1>
        <p className="text-sm text-neutral-600 mt-1">
          {reg.operatingName ? `${reg.operatingName} · ` : ""}
          {reg.country}-{reg.provinceState}
        </p>
        <p className="text-sm mt-2" data-testid="signup-ops-review-state">
          Current state: <strong>{state}</strong>
        </p>
      </header>

      <section className="mb-6 border border-neutral-200 rounded p-4">
        <h2 className="text-sm font-semibold mb-2">Applicant</h2>
        <dl className="grid grid-cols-[200px_1fr] gap-1 text-sm">
          <dt className="text-neutral-500">Admin email</dt>
          <dd data-testid="signup-ops-review-admin-email">{reg.adminEmail ?? "—"}</dd>
          <dt className="text-neutral-500">Admin display name</dt>
          <dd>{reg.adminDisplayName ?? "—"}</dd>
          <dt className="text-neutral-500">Microsoft verified at</dt>
          <dd>{reg.adminVerifiedAt ? new Date(reg.adminVerifiedAt).toISOString() : "—"}</dd>
          <dt className="text-neutral-500">Address</dt>
          <dd>{reg.addressLine1}, {reg.city} {reg.postalCode}</dd>
          <dt className="text-neutral-500">Website</dt>
          <dd>{reg.websiteUrl ?? "—"}</dd>
          <dt className="text-neutral-500">Classifier</dt>
          <dd>{reg.ownershipVerificationState}</dd>
        </dl>
      </section>

      <section className="mb-6 border border-neutral-200 rounded p-4">
        <h2 className="text-sm font-semibold mb-2">Attestation (Phase 2B)</h2>
        {attestation ? (
          <dl className="grid grid-cols-[200px_1fr] gap-1 text-sm" data-testid="signup-ops-review-attestation">
            <dt className="text-neutral-500">Signatory</dt>
            <dd>{attestation.signatoryFullName}</dd>
            <dt className="text-neutral-500">Title</dt>
            <dd>{attestation.signatoryTitle}</dd>
            <dt className="text-neutral-500">ToS version</dt>
            <dd><code>{attestation.termsVersionLabel}</code></dd>
            <dt className="text-neutral-500">Accepted at</dt>
            <dd>{new Date(attestation.acceptedAt).toISOString()}</dd>
          </dl>
        ) : (
          <p className="text-sm text-neutral-500" data-testid="signup-ops-review-no-attestation">
            No attestation recorded.
          </p>
        )}
      </section>

      <section className="mb-6 border border-neutral-200 rounded p-4">
        <h2 className="text-sm font-semibold mb-2">Entity standing check (Phase 2C)</h2>
        {standingCheck ? (
          <dl className="grid grid-cols-[200px_1fr] gap-1 text-sm" data-testid="signup-ops-review-standing-check">
            <dt className="text-neutral-500">Jurisdiction</dt>
            <dd>{standingCheck.jurisdiction}</dd>
            <dt className="text-neutral-500">Standing</dt>
            <dd>{standingCheck.standing}</dd>
            <dt className="text-neutral-500">Officer match</dt>
            <dd>{standingCheck.officerMatch ?? "—"}</dd>
            <dt className="text-neutral-500">Fetched at</dt>
            <dd>{new Date(standingCheck.fetchedAt).toISOString()}</dd>
          </dl>
        ) : (
          <p className="text-sm text-neutral-500">No standing check recorded.</p>
        )}
      </section>

      <section className="mb-6 border border-neutral-200 rounded p-4">
        <h2 className="text-sm font-semibold mb-2">
          1. Organisation standing verification
        </h2>
        {standLatest ? (
          <div className="text-sm" data-testid="signup-ops-review-standing-latest">
            <p>
              <strong>Verified</strong> by operator{" "}
              <code>{standLatest.operatorUserId.slice(-6)}</code> at{" "}
              {new Date(standLatest.verifiedAt).toISOString()}
              {standLatest.expiresAt ? ` (expires ${new Date(standLatest.expiresAt).toISOString()})` : ""}
            </p>
            <p>
              Evidence: <code>{standLatest.evidenceSource}</code> &middot;{" "}
              <code>{standLatest.evidenceReference}</code>
            </p>
          </div>
        ) : (
          <p className="text-sm text-neutral-500">No standing verification recorded.</p>
        )}
        {canStanding ? (
          <StandingForm registrationId={reg.id} />
        ) : null}
      </section>

      <section className="mb-6 border border-neutral-200 rounded p-4">
        <h2 className="text-sm font-semibold mb-2">
          2. Signing-authority verification
        </h2>
        {authLatest ? (
          <div className="text-sm" data-testid="signup-ops-review-authority-latest">
            <p>
              <strong>Verified</strong> by operator{" "}
              <code>{authLatest.operatorUserId.slice(-6)}</code> at{" "}
              {new Date(authLatest.verifiedAt).toISOString()}
            </p>
            <p>
              Evidence: <code>{authLatest.evidenceSource}</code> &middot;{" "}
              <code>{authLatest.evidenceReference}</code>
            </p>
          </div>
        ) : (
          <p className="text-sm text-neutral-500">No authority verification recorded.</p>
        )}
        {canAuthority ? (
          <AuthorityForm registrationId={reg.id} />
        ) : null}
      </section>

      <section className="mb-6 border border-neutral-200 rounded p-4">
        <h2 className="text-sm font-semibold mb-2">3. Final decision</h2>
        {releaseRow ? (
          <p className="text-sm" data-testid="signup-ops-review-release-latest">
            Released by operator <code>{releaseRow.operatorUserId.slice(-6)}</code> at{" "}
            {new Date(releaseRow.verifiedAt).toISOString()} &middot; reason:{" "}
            <em>{releaseRow.reason}</em>
          </p>
        ) : rejectRow ? (
          <p className="text-sm" data-testid="signup-ops-review-reject-latest">
            Rejected by operator <code>{rejectRow.operatorUserId.slice(-6)}</code> at{" "}
            {new Date(rejectRow.verifiedAt).toISOString()} &middot; reason:{" "}
            <em>{rejectRow.reason}</em>
          </p>
        ) : (
          <>
            {canRelease ? (
              <ReleaseForm registrationId={reg.id} />
            ) : (
              <p className="text-sm text-neutral-500" data-testid="signup-ops-review-release-blocked">
                Release not yet available.  Requires: standing + authority both
                verified by DIFFERENT operators, no conflicting-evidence or
                suspected-impersonation hold, releasing operator distinct from
                both verifiers.
              </p>
            )}
            {canReject ? (
              <RejectForm registrationId={reg.id} />
            ) : null}
          </>
        )}
      </section>

      {samePersonAsApplicant ? (
        <p
          className="text-sm text-red-700 border border-red-200 rounded p-3 bg-red-50"
          data-testid="signup-ops-review-self-approval-blocked"
        >
          Your operator email matches this registration&rsquo;s applicant.
          Self-approval is refused by Spectre&rsquo;s separation-of-duties
          policy.
        </p>
      ) : null}
    </main>
  );
}

function StandingForm({ registrationId }: { registrationId: string }) {
  return (
    <form
      className="mt-3 flex flex-col gap-2 text-sm"
      data-testid="signup-ops-standing-form"
      action={`/api/admin/signup-ops/registration/${registrationId}/standing-verified`}
      method="POST"
    >
      <label className="flex flex-col">
        <span className="text-neutral-600">Evidence source</span>
        <input
          name="evidenceSource"
          required
          maxLength={200}
          data-testid="signup-ops-standing-input-source"
          className="border rounded px-2 py-1"
          placeholder="e.g. bc-registry-cert-of-status"
        />
      </label>
      <label className="flex flex-col">
        <span className="text-neutral-600">Evidence reference (&le; 500 chars)</span>
        <input
          name="evidenceReference"
          required
          maxLength={500}
          data-testid="signup-ops-standing-input-reference"
          className="border rounded px-2 py-1"
          placeholder="confirmation #, case id, or URL"
        />
      </label>
      <label className="flex flex-col">
        <span className="text-neutral-600">Provenance (optional)</span>
        <input
          name="evidenceProvenance"
          maxLength={1000}
          data-testid="signup-ops-standing-input-provenance"
          className="border rounded px-2 py-1"
          placeholder="issuing body, document type"
        />
      </label>
      <label className="flex flex-col">
        <span className="text-neutral-600">Note (&le; 1000 chars)</span>
        <textarea
          name="reason"
          rows={3}
          maxLength={1000}
          data-testid="signup-ops-standing-input-reason"
          className="border rounded px-2 py-1"
        />
      </label>
      <button
        type="submit"
        data-testid="signup-ops-standing-submit"
        className="self-start border rounded px-3 py-1 bg-neutral-900 text-white text-sm"
      >
        Record standing verification
      </button>
    </form>
  );
}

function AuthorityForm({ registrationId }: { registrationId: string }) {
  return (
    <form
      className="mt-3 flex flex-col gap-2 text-sm"
      data-testid="signup-ops-authority-form"
      action={`/api/admin/signup-ops/registration/${registrationId}/authority-verified`}
      method="POST"
    >
      <label className="flex flex-col">
        <span className="text-neutral-600">Evidence source</span>
        <input
          name="evidenceSource"
          required
          maxLength={200}
          data-testid="signup-ops-authority-input-source"
          className="border rounded px-2 py-1"
          placeholder="e.g. delegation-letter, board-minutes"
        />
      </label>
      <label className="flex flex-col">
        <span className="text-neutral-600">Evidence reference (&le; 500 chars)</span>
        <input
          name="evidenceReference"
          required
          maxLength={500}
          data-testid="signup-ops-authority-input-reference"
          className="border rounded px-2 py-1"
        />
      </label>
      <label className="flex flex-col">
        <span className="text-neutral-600">Provenance (optional)</span>
        <input
          name="evidenceProvenance"
          maxLength={1000}
          data-testid="signup-ops-authority-input-provenance"
          className="border rounded px-2 py-1"
        />
      </label>
      <label className="flex flex-col">
        <span className="text-neutral-600">Note (&le; 1000 chars)</span>
        <textarea
          name="reason"
          rows={3}
          maxLength={1000}
          data-testid="signup-ops-authority-input-reason"
          className="border rounded px-2 py-1"
        />
      </label>
      <button
        type="submit"
        data-testid="signup-ops-authority-submit"
        className="self-start border rounded px-3 py-1 bg-neutral-900 text-white text-sm"
      >
        Record authority verification
      </button>
    </form>
  );
}

function ReleaseForm({ registrationId }: { registrationId: string }) {
  return (
    <form
      className="mt-3 flex flex-col gap-2 text-sm"
      data-testid="signup-ops-release-form"
      action={`/api/admin/signup-ops/registration/${registrationId}/release`}
      method="POST"
    >
      <label className="flex flex-col">
        <span className="text-neutral-600">Release reason (required, &le; 1000 chars)</span>
        <textarea
          name="reason"
          rows={3}
          maxLength={1000}
          required
          data-testid="signup-ops-release-input-reason"
          className="border rounded px-2 py-1"
        />
      </label>
      <button
        type="submit"
        data-testid="signup-ops-release-submit"
        className="self-start border rounded px-3 py-1 bg-emerald-700 text-white text-sm"
      >
        Release to AUTHORISED
      </button>
    </form>
  );
}

function RejectForm({ registrationId }: { registrationId: string }) {
  return (
    <form
      className="mt-6 flex flex-col gap-2 text-sm"
      data-testid="signup-ops-reject-form"
      action={`/api/admin/signup-ops/registration/${registrationId}/reject`}
      method="POST"
    >
      <label className="flex flex-col">
        <span className="text-neutral-600">Reject reason (required, &le; 1000 chars)</span>
        <textarea
          name="reason"
          rows={3}
          maxLength={1000}
          required
          data-testid="signup-ops-reject-input-reason"
          className="border rounded px-2 py-1"
        />
      </label>
      <button
        type="submit"
        data-testid="signup-ops-reject-submit"
        className="self-start border rounded px-3 py-1 bg-red-700 text-white text-sm"
      >
        Reject
      </button>
    </form>
  );
}
