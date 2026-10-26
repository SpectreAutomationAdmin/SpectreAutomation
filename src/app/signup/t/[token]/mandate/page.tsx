// SIGNUP-2 Phase 2E (2026-10-26) -- /signup/t/[token]/mandate
//
// Applicant-facing mandate-collection landing page.  Gated by:
//   - Phase 2E flag ON.
//   - Phase 2D verdict is MANUAL_RELEASE (manual three-operator
//     release) or PASS_AUTOMATED (future automated path).
//   - Phase 2B attestation + APPROVED ToS (via the mandate service).
//
// Rendering layer only.  The submit button POSTs to
// /api/signup/mandate/initiate which does the full gate check +
// Stripe Checkout session create.

import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import "@/components/marketing/web1b.css";
import "@/app/signup/signup.css";
import { Wordmark } from "@/components/marketing/Wordmark";
import { resolveRegistrationByToken } from "@/lib/signup/registration";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const metadata = { title: "Authorise your Club's subscription payment" };

export default async function MandatePage({
  params,
}: {
  params: { token: string };
}) {
  const reg = await resolveRegistrationByToken(params.token);
  if (!reg) notFound();
  if (reg.status === "ABANDONED") notFound();

  const live = process.env.SPECTRE_SIGNUP_2E_PAYMENT_LIVE === "1";

  const verdictRow = await prisma.signupRegistration.findUnique({
    where: { id: reg.id },
    select: { verificationVerdict: true },
  });
  const authorised =
    verdictRow?.verificationVerdict === "MANUAL_RELEASE" ||
    verdictRow?.verificationVerdict === "PASS_AUTOMATED";

  if (!authorised) {
    redirect(`/signup/t/${encodeURIComponent(params.token)}/status`);
  }

  return (
    <main className="signup-shell">
      <header className="signup-header">
        <Link href="/" className="signup-logo-link">
          <Wordmark />
        </Link>
      </header>
      <section className="signup-stage">
        <div className="signup-eyebrow">Spectre &middot; Subscription payment</div>
        <h1 className="signup-display">Authorise your Club&rsquo;s annual subscription</h1>
        <p className="signup-lede">
          Your Club has been verified by Spectre.  The next step is a
          secure <strong>Pre-Authorised Debit (PAD) mandate</strong>
          for the CAD&nbsp;$38,000 annual subscription.  You will be
          handed off to Stripe to sign the mandate.  No funds are
          moved today.
        </p>

        {!live ? (
          <div
            className="signup-resume-banner"
            role="status"
            data-testid="signup-mandate-coming-soon"
          >
            <p>
              The subscription-payment workflow is in final review.
              You will be notified when it is ready to accept your
              mandate.
            </p>
          </div>
        ) : (
          <form
            method="POST"
            action="/api/signup/mandate/initiate"
            className="signup-identity-form"
            data-testid="signup-mandate-form"
          >
            <input type="hidden" name="token" value={params.token} />
            <p className="signup-meta">
              The next click opens Stripe&rsquo;s hosted mandate-signing
              page in a new window.  Please have your Club&rsquo;s
              banking information on hand.
            </p>
            <button
              type="submit"
              className="w1b-pill-cta"
              data-testid="signup-mandate-submit"
            >
              Continue to Stripe to sign the PAD mandate
            </button>
          </form>
        )}

        <footer className="signup-foot">
          <p className="signup-security-note">
            Stripe sends you the required debit-notification email
            after you sign the mandate.  The first annual payment is
            drawn on the schedule Stripe confirms.  Any question before
            you sign:{" "}
            <a className="w1b-text-link" href="mailto:hello@spectreautomation.com?subject=Spectre%20subscription%20mandate">
              hello@spectreautomation.com
            </a>
            .
          </p>
        </footer>
      </section>
    </main>
  );
}
