// SIGNUP-1 (2026-10-19) — Screen 1: Club Identity.
//
// Public route (no authentication required).  Reuses the WEB-1B
// marketing design language (serif display face, muted gold, dark
// forest green, cream ground) via the shared marketing CSS.
//
// Submit → POST /api/signup/start → 303 redirect to /signup/t/<token>.
// The HTTPOnly resume cookie is set by the API handler, not here.

import Link from "next/link";
import { cookies } from "next/headers";
import "@/components/marketing/web1b.css";
import "@/components/marketing/auth.css";
import "./signup.css";
import { Wordmark } from "@/components/marketing/Wordmark";
import { StepIndicator } from "./_components/StepIndicator";
import { SignupIdentityForm } from "./_components/SignupIdentityForm";
import { CA_PROVINCES } from "@/lib/signup/registration";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign up · Spectre" };

export default async function SignupLanding({
  searchParams,
}: {
  searchParams: { error?: string };
}) {
  // If a prior cookie exists, surface a "resume" affordance.
  const cookieJar = cookies();
  const resume = cookieJar.get("spectre_signup_resume")?.value;
  let resumeToken: string | null = null;
  if (resume) {
    try {
      // The cookie is just the plaintext token (HTTPOnly, same-origin).
      // We don't resolve it server-side here (that would hit the DB on
      // every landing render); the user clicks "Resume" and the next
      // page resolves it.
      resumeToken = resume;
    } catch { resumeToken = null; }
  }

  return (
    <main className="signup-shell">
      <header className="signup-header">
        <Link href="/" className="signup-logo-link"><Wordmark /></Link>
      </header>

      <section className="signup-stage">
        <div className="signup-eyebrow">Spectre · Club registration</div>
        <h1 className="signup-display">
          Begin your Club&rsquo;s Spectre registration
        </h1>
        <p className="signup-lede">
          Three steps.  You can save your progress and return at any time.
          The $38,000 CAD annual subscription is authorized in a later,
          separate step — no payment is taken today.
        </p>

        <StepIndicator current="IDENTITY" />

        {resumeToken ? (
          <div className="signup-resume-banner" role="status">
            <p>You have a registration in progress.</p>
            <Link
              href={`/signup/t/${encodeURIComponent(resumeToken)}`}
              className="w1b-pill-cta"
              data-testid="signup-resume-pill"
            >
              Resume registration
            </Link>
            <span className="signup-resume-or">— or start a new one below.</span>
          </div>
        ) : null}

        {searchParams.error ? (
          <div className="signup-error" role="alert">
            {decodeURIComponent(searchParams.error)}
          </div>
        ) : null}

        <SignupIdentityForm provinces={[...CA_PROVINCES]} />

        <footer className="signup-foot">
          <p>
            Already have an account? <Link href="/login" className="w1b-text-link">Log in</Link>.
          </p>
          <p className="signup-security-note">
            Your organization&rsquo;s identity is verified through Microsoft work-account authentication.
            We never store Microsoft passwords.
          </p>
        </footer>
      </section>
    </main>
  );
}
