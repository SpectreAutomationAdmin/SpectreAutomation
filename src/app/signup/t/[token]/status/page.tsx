// SIGNUP-1 (2026-10-19) — Screen 3: Registration Status.
//
// Shows:
//   • Verified identity (name + email + position).
//   • Saved club identity summary.
//   • Organization verification state (applicant-friendly copy,
//     NEVER discloses review-signal details).
//   • Clear "what's next" copy: subscription authorization comes
//     later, after Spectre reviews.
//
// No forms, no money, no provisioned tenant.  Pure confirmation.

import { notFound } from "next/navigation";
import Link from "next/link";
import "@/components/marketing/web1b.css";
import "@/app/signup/signup.css";
import { Wordmark } from "@/components/marketing/Wordmark";
import { StepIndicator } from "@/app/signup/_components/StepIndicator";
import { resolveRegistrationByToken } from "@/lib/signup/registration";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const metadata = { title: "Registration saved · Spectre" };

export default async function StatusScreen({
  params,
}: {
  params: { token: string };
}) {
  const reg = await resolveRegistrationByToken(params.token);
  if (!reg) notFound();

  // SIGNUP-2 M3B (2026-10-27, founder §3): club-facing bank-verification
  // banner is derived EXCLUSIVELY from authoritative server-side state --
  // the BillingCycle's subscriptionStatus column.  Query parameters do
  // NOT (and cannot) override this.  The webhook dispatcher
  // (onSetupIntentEvent in signup-2e-webhook-dispatch.ts) is the only
  // writer of these states, driven by signed Stripe events.
  //
  // Lookup path: BillingCycle links to OperatorVerificationRecord via
  // releasedByOperatorRecordId; that record carries signupRegistrationId.
  // We cannot rely on `clubId === reg.id` because the pre-Phase-2G
  // placeholder is cleared once provisioning rewrites clubId to the
  // real Club FK.
  const cycle = await prisma.billingCycle.findFirst({
    where: {
      source: "STRIPE_ACSS",
      releasedByOperatorRecord: { signupRegistrationId: reg.id },
    },
    orderBy: { createdAt: "desc" },
    select: {
      subscriptionStatus: true,
      bankVerificationHostedUrl: true,
      bankVerificationExpiresAt: true,
      bankVerificationFailureReason: true,
      bankVerificationMethod: true,
    },
  });
  const bankVerificationBanner = (() => {
    if (!cycle) return null;
    const s = cycle.subscriptionStatus;
    if (s === "BANK_VERIFICATION_PENDING") {
      return {
        tone: "info" as const,
        title: "Bank verification pending",
        body:
          "You chose to verify your bank account by microdeposit. Within 1-2 business days you'll receive an email from Stripe with two small deposit amounts to confirm. Please follow that email to complete verification. No funds will be debited until verification is complete.",
      };
    }
    if (s === "BANK_VERIFIED") {
      const method = cycle.bankVerificationMethod === "MICRODEPOSITS"
        ? "after microdeposit confirmation"
        : "instantly";
      return {
        tone: "ok" as const,
        title: "Bank account verified",
        body: `Your bank account was verified ${method}. Spectre will proceed with the annual subscription on the schedule outlined in your enrolment letter.`,
      };
    }
    if (s === "BANK_VERIFICATION_FAILED") {
      return {
        tone: "error" as const,
        title: "Bank verification could not complete",
        body:
          "Stripe was not able to verify your bank account. This can happen when details are entered incorrectly or when the account cannot accept pre-authorized debits. Please re-start the mandate step to enter a new account. No funds have been debited.",
      };
    }
    return null;
  })();

  // Determine applicant-friendly ownership verification message.
  // Never discloses dup signals; only the decision axis.
  const ownershipMsg = (() => {
    switch (reg.ownershipVerificationState) {
      case "AUTOMATED_PASSED":
        return "Verified automatically.";
      case "NEEDS_MANUAL_REVIEW":
        return "Under review — Spectre will reach out directly if additional information is needed.";
      case "ESCALATED":
        return "Spectre is confirming details directly with you.";
      case "OVERRIDDEN":
        return "Verified by Spectre.";
      default:
        return "Pending.";
    }
  })();

  return (
    <main className="signup-shell">
      <header className="signup-header">
        <Link href="/" className="signup-logo-link"><Wordmark /></Link>
      </header>
      <section className="signup-stage">
        <div className="signup-eyebrow">Spectre · Club registration</div>
        <h1 className="signup-display">Your registration is saved</h1>
        <p className="signup-lede">
          {reg.adminVerifiedAt
            ? "Your administrator identity is verified. Your Club's registration is securely saved."
            : "Your Club's identity is saved. Your administrator's identity is still pending verification."
          }
        </p>

        <StepIndicator current="STATUS" />

        {bankVerificationBanner ? (
          <div
            data-testid={`signup-bank-verification-${bankVerificationBanner.tone}`}
            style={{
              margin: "16px 0 24px",
              padding: "16px 20px",
              borderRadius: 10,
              borderLeft:
                bankVerificationBanner.tone === "ok"
                  ? "4px solid #276749"
                  : bankVerificationBanner.tone === "error"
                    ? "4px solid #9b2c2c"
                    : "4px solid #b7791f",
              background:
                bankVerificationBanner.tone === "ok"
                  ? "#f0fdf4"
                  : bankVerificationBanner.tone === "error"
                    ? "#fef2f2"
                    : "#fffbeb",
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 6 }}>{bankVerificationBanner.title}</div>
            <div style={{ fontSize: 14, lineHeight: 1.5 }}>{bankVerificationBanner.body}</div>
          </div>
        ) : null}

        <div className="signup-status-card" data-testid="signup-status-card">
          <h2 style={{ margin: "0 0 16px", fontSize: 18 }}>Club</h2>
          <div className="signup-status-row">
            <span className="signup-status-label">Legal name</span>
            <span className="signup-status-value">{reg.legalName}</span>
          </div>
          {reg.operatingName ? (
            <div className="signup-status-row">
              <span className="signup-status-label">Operating as</span>
              <span className="signup-status-value">{reg.operatingName}</span>
            </div>
          ) : null}
          <div className="signup-status-row">
            <span className="signup-status-label">Address</span>
            <span className="signup-status-value">
              {reg.addressLine1}, {reg.city}, {reg.provinceState} {reg.postalCode}
            </span>
          </div>
          {reg.websiteUrl ? (
            <div className="signup-status-row">
              <span className="signup-status-label">Website</span>
              <span className="signup-status-value">{reg.websiteUrl}</span>
            </div>
          ) : null}

          <h2 style={{ margin: "24px 0 16px", fontSize: 18 }}>Founding administrator</h2>
          {reg.adminVerifiedAt ? (
            <>
              <div className="signup-status-row">
                <span className="signup-status-label">Verified identity</span>
                <span className="signup-status-value" data-testid="signup-status-admin-name">
                  {reg.adminDisplayName ?? reg.adminEmail}
                </span>
              </div>
              <div className="signup-status-row">
                <span className="signup-status-label">Microsoft email</span>
                <span className="signup-status-value">{reg.adminEmail}</span>
              </div>
              <div className="signup-status-row">
                <span className="signup-status-label">Role</span>
                <span className="signup-status-value">
                  {reg.adminPosition ?? <em style={{ color: "#67715f" }}>Pending</em>}
                </span>
              </div>
              <div className="signup-status-row">
                <span className="signup-status-label">Verified at</span>
                <span className="signup-status-value">
                  {new Date(reg.adminVerifiedAt).toLocaleString("en-CA", { dateStyle: "long", timeStyle: "short" })}
                </span>
              </div>
            </>
          ) : (
            <div className="signup-status-row">
              <span className="signup-status-label">Status</span>
              <span className="signup-status-value muted">Pending Microsoft verification</span>
            </div>
          )}

          <h2 style={{ margin: "24px 0 16px", fontSize: 18 }}>Organization verification</h2>
          <div className="signup-status-row">
            <span className="signup-status-label">Status</span>
            <span className="signup-status-value" data-testid="signup-status-ownership">{ownershipMsg}</span>
          </div>
        </div>

        <div className="signup-notice" role="status" data-testid="signup-status-nextsteps">
          <h2 style={{ margin: "0 0 8px", fontSize: 16 }}>What happens next</h2>
          <p style={{ margin: "0 0 8px" }}>
            Your registration is securely saved and no payment has been taken.
          </p>
          <p style={{ margin: "0 0 8px" }}>
            In the next step, Spectre will send you a secure link to authorize your
            Club&rsquo;s subscription — <strong>$38,000 CAD annually</strong>. Until that
            authorization is complete, no tenant is provisioned and no administrator
            privileges are granted.
          </p>
          <p style={{ margin: 0 }}>
            {reg.adminEmail ? (
              <>We&rsquo;ve sent a resume link to <strong>{reg.adminEmail}</strong>. You can resume this registration from any device using that link.</>
            ) : (
              <>Keep this browser session to continue your registration.</>
            )}
          </p>
        </div>

        {/*
          SIGNUP-2 Phase 2B (2026-10-25) -- "Continue to authorisation"
          affordance.  Gated by the SPECTRE_SIGNUP_2B_ATTESTATION_LIVE
          flag.  Legacy and pre-live users see the existing "what
          happens next" copy and nothing else.  When the flag is "1",
          the button appears but the attestation page itself ALSO
          checks the flag + ToS-approved state and only renders the
          live form if both pass.
         */}
        {process.env.SPECTRE_SIGNUP_2B_ATTESTATION_LIVE === "1" && reg.adminVerifiedAt ? (
          <div
            className="signup-authority-cta"
            data-testid="signup-status-authority-cta"
          >
            <Link
              href={`/signup/t/${encodeURIComponent(params.token)}/authority`}
              className="w1b-pill-cta"
              data-testid="signup-status-authority-link"
            >
              Continue to subscription authorisation
            </Link>
          </div>
        ) : null}

        <footer className="signup-foot">
          <p>
            Questions?  <a className="w1b-text-link" href="mailto:hello@spectreautomation.com?subject=Spectre%20Registration">Email the Spectre team</a>.
          </p>
          <p className="signup-security-note">
            Your administrator will receive <strong>Club-level administrator</strong> authority
            on your tenant — not platform-level Spectre privileges — once provisioning completes.
          </p>
        </footer>
      </section>
    </main>
  );
}
