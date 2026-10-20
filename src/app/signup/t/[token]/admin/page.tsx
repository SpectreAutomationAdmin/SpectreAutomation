// SIGNUP-1 — Screen 2: Founding administrator (Microsoft auth +
// position).
//
// Shows the saved identity from Screen 1 (summary), the Microsoft
// sign-in button, and (post-verify, before continuing) a position
// field.  The Microsoft button POSTs to /api/signup/microsoft/start
// which redirects to Microsoft.
//
// Non-disclosure: never discloses details that only a Super Admin
// should see (duplicate signals, org verification reasoning).  The
// applicant sees only: "Your identity is verified" or "A review is
// pending".

import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import "@/components/marketing/web1b.css";
import "@/components/marketing/auth.css";
import "@/app/signup/signup.css";
import { Wordmark } from "@/components/marketing/Wordmark";
import { StepIndicator } from "@/app/signup/_components/StepIndicator";
import { AdminPositionForm } from "@/app/signup/_components/AdminPositionForm";
import { resolveRegistrationByToken } from "@/lib/signup/registration";

export const dynamic = "force-dynamic";
export const metadata = { title: "Verify administrator · Spectre" };

export default async function AdminScreen({
  params,
  searchParams,
}: {
  params: { token: string };
  searchParams: { error?: string };
}) {
  const reg = await resolveRegistrationByToken(params.token);
  if (!reg) notFound();
  if (reg.step === "ADMIN_VERIFIED" || reg.status === "VERIFIED") {
    redirect(`/signup/t/${encodeURIComponent(params.token)}/status`);
  }

  const alreadyVerified = !!reg.adminVerifiedAt;

  return (
    <main className="signup-shell">
      <header className="signup-header">
        <Link href="/" className="signup-logo-link"><Wordmark /></Link>
      </header>
      <section className="signup-stage">
        <div className="signup-eyebrow">Spectre · Club registration</div>
        <h1 className="signup-display">
          Verify the founding administrator
        </h1>
        <p className="signup-lede">
          The founding administrator becomes the Club&rsquo;s first
          Spectre user.  We verify their identity through their
          Microsoft work-or-school account.  No passwords are stored.
        </p>

        <StepIndicator current="ADMIN" />

        {searchParams.error ? (
          <div className="signup-error" role="alert">
            {decodeURIComponent(searchParams.error)}
          </div>
        ) : null}

        <div className="signup-status-card" data-testid="signup-identity-summary">
          <h2 style={{ margin: 0, fontSize: 16 }}>{reg.legalName}</h2>
          {reg.operatingName ? <p style={{ margin: "4px 0 16px", color: "#67715f" }}>Operating as {reg.operatingName}</p> : null}
          <div className="signup-status-row">
            <span className="signup-status-label">Country</span>
            <span className="signup-status-value">{reg.country === "CA" ? "Canada" : reg.country}</span>
          </div>
          <div className="signup-status-row">
            <span className="signup-status-label">Province</span>
            <span className="signup-status-value">{reg.provinceState}</span>
          </div>
          <div className="signup-status-row">
            <span className="signup-status-label">Address</span>
            <span className="signup-status-value">
              {reg.addressLine1}{reg.addressLine2 ? `, ${reg.addressLine2}` : ""}, {reg.city}, {reg.provinceState} {reg.postalCode}
            </span>
          </div>
          {reg.websiteUrl ? (
            <div className="signup-status-row">
              <span className="signup-status-label">Website</span>
              <span className="signup-status-value">{reg.websiteUrl}</span>
            </div>
          ) : null}
        </div>

        {alreadyVerified ? (
          // Admin identity captured — collect position + continue.
          <>
            <div className="signup-notice" role="status" data-testid="signup-ms-verified">
              <strong>Microsoft identity verified</strong> — {reg.adminDisplayName ?? reg.adminEmail}
            </div>
            <AdminPositionForm
              token={params.token}
              existingPosition={reg.adminPosition}
            />
          </>
        ) : (
          <form
            method="POST"
            action="/api/signup/microsoft/start"
            data-testid="signup-ms-form"
          >
            <input type="hidden" name="token" value={params.token} />
            <button
              type="submit"
              className="signup-ms-button"
              data-testid="signup-ms-button"
            >
              <MicrosoftLogo />
              Sign in with Microsoft work-or-school account
            </button>
            <p className="signup-hint" style={{ marginTop: 12 }}>
              Personal Microsoft accounts (@outlook.com, @hotmail.com) are not accepted.
            </p>
          </form>
        )}

        <footer className="signup-foot">
          <p>
            <Link href="/signup" className="w1b-text-link">← Edit your Club&rsquo;s identity</Link>
          </p>
          <p className="signup-security-note">
            Spectre requests only identity information (openid, profile, email).
            Mailbox integration is set up later during Club implementation.
          </p>
        </footer>
      </section>
    </main>
  );
}

function MicrosoftLogo() {
  return (
    <svg className="signup-ms-logo" viewBox="0 0 23 23" aria-hidden="true">
      <path fill="#f25022" d="M1 1h10v10H1z"/>
      <path fill="#7fba00" d="M12 1h10v10H12z"/>
      <path fill="#00a4ef" d="M1 12h10v10H1z"/>
      <path fill="#ffb900" d="M12 12h10v10H12z"/>
    </svg>
  );
}
