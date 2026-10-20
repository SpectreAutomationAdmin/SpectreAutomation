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
import "../../signup.css";
import { Wordmark } from "@/components/marketing/Wordmark";
import { StepIndicator } from "@/app/signup/_components/StepIndicator";
import { resolveRegistrationByToken } from "@/lib/signup/registration";

export const dynamic = "force-dynamic";
export const metadata = { title: "Registration saved · Spectre" };

export default async function StatusScreen({
  params,
}: {
  params: { token: string };
}) {
  const reg = await resolveRegistrationByToken(params.token);
  if (!reg) notFound();

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
