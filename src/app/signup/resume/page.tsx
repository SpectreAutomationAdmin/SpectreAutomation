// SIGNUP-1F (2026-10-20) — Public recovery-request page.
//
// Applicant lands here when:
//   - They clicked an expired or already-used recovery link.
//   - They lost the email entirely and need a fresh link.
//   - A prior browser's cookie is stale.
//
// The form asks for the Microsoft-verified admin email.  Submission
// is enumeration-safe: the response is identical whether the email
// matches a verified registration or not.  If a match exists, a
// fresh single-use recovery link is sent to it.

import Link from "next/link";
import "@/components/marketing/web1b.css";
import "@/app/signup/signup.css";
import { Wordmark } from "@/components/marketing/Wordmark";

export const dynamic = "force-dynamic";
export const metadata = { title: "Resume your Spectre registration" };

const ERROR_COPY: Record<string, string> = {
  invalid_link: "That recovery link is not valid.",
  unknown_link: "We can't find that recovery link.  It may have been revoked.",
  already_used: "That recovery link has already been used.  You can request a fresh one below.",
  revoked: "That recovery link has been revoked.  You can request a fresh one below.",
  expired: "That recovery link has expired.  You can request a fresh one below.",
  rate_limited: "Too many attempts.  Please wait a moment and try again.",
};

export default async function ResumePage({
  searchParams,
}: {
  searchParams: { error?: string; sent?: string };
}) {
  const errorKey = searchParams.error ?? "";
  const errorCopy = ERROR_COPY[errorKey] ?? "";
  const sent = searchParams.sent === "1";

  return (
    <main className="signup-shell">
      <header className="signup-header">
        <Link href="/" className="signup-logo-link"><Wordmark /></Link>
      </header>
      <section className="signup-stage">
        <div className="signup-eyebrow">Spectre · Club registration</div>
        <h1 className="signup-display">Resume your registration</h1>
        <p className="signup-lede">
          Enter the email address you verified with Microsoft.  If it
          matches a registration, we&rsquo;ll send a fresh single-use
          recovery link.
        </p>

        {errorCopy ? (
          <div className="signup-error" role="alert" data-testid="signup-resume-error">
            {errorCopy}
          </div>
        ) : null}

        {sent ? (
          <div className="signup-resume-banner" role="status" data-testid="signup-resume-sent">
            <p>
              If the email you entered matches a registration, we just
              sent a fresh recovery link.  Please check your inbox.
            </p>
          </div>
        ) : null}

        <form
          method="POST"
          action="/api/signup/resume/request"
          className="signup-identity-form"
          data-testid="signup-resume-form"
        >
          <label className="signup-field">
            <span className="signup-field-label">Verified Microsoft email</span>
            <input
              name="email"
              type="email"
              required
              autoComplete="email"
              maxLength={320}
              data-testid="signup-resume-input-email"
              className="signup-input"
            />
          </label>
          <button
            type="submit"
            className="w1b-pill-cta"
            data-testid="signup-resume-submit"
          >
            Send a fresh recovery link
          </button>
        </form>
      </section>
    </main>
  );
}
