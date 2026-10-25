// SIGNUP-2 Phase 2B (2026-10-25) -- /signup/t/[token]/authority/complete
//
// Dead-end "your authorisation is recorded" page.  Reached after
// POST /api/signup/authority/accept succeeds, or if the signatory
// returns to the authority surface after already accepting.
//
// Deliberately a dead-end in Phase 2B -- the next step (Stripe
// mandate collection) lands in Phase 2E.

import { notFound } from "next/navigation";
import Link from "next/link";
import "@/components/marketing/web1b.css";
import "@/app/signup/signup.css";
import { Wordmark } from "@/components/marketing/Wordmark";
import { resolveRegistrationByToken } from "@/lib/signup/registration";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const metadata = { title: "Authorisation recorded" };

export default async function AuthorityCompletePage({
  params,
}: {
  params: { token: string };
}) {
  const reg = await resolveRegistrationByToken(params.token);
  if (!reg) notFound();

  const attestation = await prisma.subscriptionAuthorisationAttestation.findUnique({
    where: { signupRegistrationId: reg.id },
    select: {
      id: true,
      acceptedAt: true,
      signatoryFullName: true,
      signatoryTitle: true,
      termsVersionLabel: true,
    },
  });

  // SIGNUP-2 Phase 2C (2026-10-25) -- verification state surface.
  // Gated by SPECTRE_SIGNUP_2C_VERIFICATION_LIVE; default OFF (fail-
  // closed per founder §6).  The pipeline still writes the verdict
  // server-side even when the flag is off -- only the applicant-facing
  // disclosure is gated.
  const verificationLive = process.env.SPECTRE_SIGNUP_2C_VERIFICATION_LIVE === "1";
  const verification = verificationLive
    ? await prisma.signupRegistration.findUnique({
        where: { id: reg.id },
        select: { verificationVerdict: true, verificationDecidedAt: true },
      })
    : null;

  if (!attestation) {
    // Someone navigated here without actually completing the
    // attestation; bounce them back to the entry.
    return (
      <main className="signup-shell">
        <header className="signup-header">
          <Link href="/" className="signup-logo-link">
            <Wordmark />
          </Link>
        </header>
        <section className="signup-stage">
          <h1 className="signup-display">No authorisation recorded yet</h1>
          <p className="signup-lede">
            Return to the authorisation page to complete your attestation.
          </p>
          <Link
            href={`/signup/t/${encodeURIComponent(params.token)}/authority`}
            className="w1b-pill-cta"
            data-testid="signup-authority-return"
          >
            Return to the authorisation page
          </Link>
        </section>
      </main>
    );
  }

  return (
    <main className="signup-shell">
      <header className="signup-header">
        <Link href="/" className="signup-logo-link">
          <Wordmark />
        </Link>
      </header>
      <section className="signup-stage">
        <div className="signup-eyebrow">Spectre · Club registration</div>
        <h1 className="signup-display">Your authorisation is recorded</h1>
        <p className="signup-lede">
          Thank you, {attestation.signatoryFullName}.  Your attestation on
          behalf of {reg.legalName} is immutably recorded.
        </p>
        <div
          className="signup-authority-receipt"
          data-testid="signup-authority-receipt"
        >
          <p>
            Signatory title: <strong>{attestation.signatoryTitle}</strong>
          </p>
          <p>
            Terms of Service version:{" "}
            <code>{attestation.termsVersionLabel}</code>
          </p>
          <p>
            Accepted at:{" "}
            <time dateTime={attestation.acceptedAt.toISOString()}>
              {attestation.acceptedAt.toISOString()}
            </time>
          </p>
        </div>
        {verificationLive ? (
          <div
            className="signup-verification-state"
            role="status"
            data-testid="signup-verification-state"
          >
            {!verification || !verification.verificationVerdict ? (
              <p data-testid="signup-verification-pending">
                Verification is in progress.  We&rsquo;re confirming the
                Club&rsquo;s standing and your authority to authorise this
                subscription.  We&rsquo;ll be in touch when the next step is
                ready.
              </p>
            ) : verification.verificationVerdict === "PASS_AUTOMATED" ? (
              <p data-testid="signup-verification-pass">
                Verification is complete.  The next step &mdash; secure
                collection of the pre-authorised debit mandate &mdash; is
                being prepared.  Spectre will contact you when it is available.
              </p>
            ) : verification.verificationVerdict === "HOLD_FOR_REVIEW" ? (
              <p data-testid="signup-verification-hold">
                Your registration is under review by Spectre.  Reviews
                typically complete within one business day.  We&rsquo;ll
                reach out directly if we need any additional information.
              </p>
            ) : (
              <p data-testid="signup-verification-reject">
                We weren&rsquo;t able to complete verification.  Please
                contact{" "}
                <a
                  className="w1b-text-link"
                  href="mailto:hello@spectreautomation.com?subject=Spectre%20Registration"
                >
                  hello@spectreautomation.com
                </a>
                .
              </p>
            )}
          </div>
        ) : (
          <p className="signup-meta">
            The next step &mdash; secure collection of the pre-authorised debit
            mandate &mdash; is being prepared.  Spectre will contact you when
            it is available.  Until then, your Club&rsquo;s registration is
            saved; no payment has been collected and no subscription has been
            activated.
          </p>
        )}
      </section>
    </main>
  );
}
