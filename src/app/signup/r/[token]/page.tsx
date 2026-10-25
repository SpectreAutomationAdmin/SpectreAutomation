// SIGNUP-1G defect repair (2026-10-25) -- Recovery-link landing page.
//
// Why this page exists:
//
//   Microsoft Defender Safe Links (and every other corporate
//   email-security scanner) issues a GET on every URL that lands
//   in a mailbox, BEFORE the human clicks.  The previous route
//   consumed the single-use recovery token in that GET.  Result:
//   the scanner redeemed the token and the human arrived at an
//   "already used" error.
//
//   This page is the fix.  The GET is now a stateless landing
//   page that touches no database.  It renders a "Continue to
//   resume registration" form which POSTs to /signup/r/[token].
//   The POST is the real consume -- single-use + atomic +
//   race-safe, exactly as before.
//
//   Scanners never POST forms, so the token survives inspection.
//
// This is the SAME security posture as every other sensitive
// single-use link in the industry (GitHub login-via-email,
// Google confirmation emails, Microsoft account recovery, every
// bank magic link).  We moved to it after proving the scanner
// behaviour via staging logs on 2026-10-25.
//
// The landing page itself discloses NOTHING about the registration:
// no club name, no admin email, no legal name, no expiry.  It is
// identical for every token, including malformed ones and ones
// that are already consumed.  A visitor who guesses or scans a
// bogus token sees the same page; the POST classifies.

import Link from "next/link";
import "@/components/marketing/web1b.css";
import "@/app/signup/signup.css";
import { Wordmark } from "@/components/marketing/Wordmark";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Confirm to resume your registration",
  // Scanners should ignore this page's URL to the extent robots-meta
  // can convince them.  The real belt-and-suspenders is that the
  // page performs no state change.
  robots: { index: false, follow: false },
};

export default function RecoveryLinkLandingPage({
  params,
}: {
  params: { token: string };
}) {
  const token = params.token;

  return (
    <main className="signup-shell">
      <header className="signup-header">
        <Link href="/" className="signup-logo-link">
          <Wordmark />
        </Link>
      </header>
      <section className="signup-stage">
        <div className="signup-eyebrow">Spectre &middot; Resume your registration</div>
        <h1 className="signup-display">You&rsquo;re one tap away</h1>
        <p className="signup-lede">
          For your security, we ask you to confirm this is really you.
          Tap the button below to open your in-progress Club registration.
        </p>

        <form
          method="POST"
          action={`/signup/r/${encodeURIComponent(token)}/consume`}
          className="signup-recovery-confirm"
          data-testid="signup-recovery-confirm-form"
        >
          <button
            type="submit"
            className="w1b-pill-cta"
            data-testid="signup-recovery-confirm-submit"
          >
            Continue to Spectre
          </button>
        </form>

        <p className="signup-meta" style={{ marginTop: 24 }}>
          Didn&rsquo;t request this?{" "}
          <Link
            href="/signup/resume"
            className="w1b-text-link"
            data-testid="signup-recovery-request-fresh-link"
          >
            Request a fresh link
          </Link>
          .
        </p>

        <footer className="signup-foot">
          <p className="signup-security-note">
            Links expire 30 minutes after they&rsquo;re sent and can only
            be used once.  Automated email-security systems that preview
            links will not use up your link.
          </p>
        </footer>
      </section>
    </main>
  );
}
