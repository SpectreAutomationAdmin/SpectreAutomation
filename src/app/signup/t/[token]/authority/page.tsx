// SIGNUP-2 Phase 2B (2026-10-25) -- /signup/t/[token]/authority
//
// Signatory commercial-authority attestation surface.  Reads the
// resumed SignupRegistration, renders the attestation copy + ToS
// link + the two signatory input fields + the "I confirm" button.
// Submission POSTs to /api/signup/authority/accept.
//
// The page refuses to render the active form unless the
// SPECTRE_SIGNUP_2B_ATTESTATION_LIVE flag is "1" AND the resolved
// ToS is APPROVED.  Otherwise it shows a fail-closed disabled
// banner.  Fail-closed on every gap.
//
// Idempotent navigation: if the registration is already in
// AUTHORITY_ACCEPTED state, redirect straight to the /complete
// sibling.

import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import "@/components/marketing/web1b.css";
import "@/app/signup/signup.css";
import { Wordmark } from "@/components/marketing/Wordmark";
import { resolveRegistrationByToken } from "@/lib/signup/registration";
import { ATTESTATION_TEXT } from "@/app/api/signup/authority/accept/route";
import { readTermsOfService } from "@/lib/billing/terms-of-service";

export const dynamic = "force-dynamic";
export const metadata = { title: "Confirm your subscription authority" };

export default async function AuthorityPage({
  params,
  searchParams,
}: {
  params: { token: string };
  searchParams: { error?: string };
}) {
  const reg = await resolveRegistrationByToken(params.token);
  if (!reg) notFound();
  if (reg.status === "ABANDONED") notFound();
  if (!reg.adminVerifiedAt) {
    redirect(`/signup/t/${encodeURIComponent(params.token)}/admin`);
  }
  if (reg.step === "AUTHORITY_ACCEPTED") {
    redirect(`/signup/t/${encodeURIComponent(params.token)}/authority/complete`);
  }

  // Determine readiness.  Live form only if flag=1 + ToS=APPROVED.
  const live = process.env.SPECTRE_SIGNUP_2B_ATTESTATION_LIVE === "1";
  let tosLabel = "pending";
  let tosApproved = false;
  try {
    const doc = readTermsOfService();
    tosLabel = doc.label;
    tosApproved = doc.status === "APPROVED";
  } catch {
    tosLabel = "unavailable";
    tosApproved = false;
  }
  const formEnabled = live && tosApproved;

  return (
    <main className="signup-shell">
      <header className="signup-header">
        <Link href="/" className="signup-logo-link">
          <Wordmark />
        </Link>
      </header>
      <section className="signup-stage">
        <div className="signup-eyebrow">Spectre · Club registration</div>
        <h1 className="signup-display">Confirm your subscription authority</h1>
        <p className="signup-lede">
          You are authorising the Club&rsquo;s subscription to Spectre
          Automation on behalf of <strong>{reg.legalName}</strong>.
        </p>

        {!formEnabled ? (
          <div
            className="signup-resume-banner"
            role="status"
            data-testid="signup-authority-coming-soon"
          >
            <p>
              The subscription authorisation workflow is in final review.
              You will be notified when it is ready to accept your
              authorisation.
            </p>
          </div>
        ) : (
          <>
            <section
              className="signup-authority-attestation"
              data-testid="signup-authority-attestation-text"
            >
              <h2 className="signup-sub-display">Attestation</h2>
              <p>{ATTESTATION_TEXT}</p>
              <p className="signup-meta">
                Terms of Service version:{" "}
                <code data-testid="signup-authority-tos-label">
                  {tosLabel}
                </code>
              </p>
            </section>

            {searchParams.error ? (
              <div
                className="signup-error"
                role="alert"
                data-testid="signup-authority-error"
              >
                {decodeURIComponent(searchParams.error)}
              </div>
            ) : null}

            <form
              method="POST"
              action="/api/signup/authority/accept"
              className="signup-identity-form"
              data-testid="signup-authority-form"
            >
              <input type="hidden" name="token" value={params.token} />
              <label className="signup-field">
                <span className="signup-field-label">Your full legal name</span>
                <input
                  name="signatoryFullName"
                  type="text"
                  required
                  minLength={2}
                  maxLength={200}
                  autoComplete="name"
                  data-testid="signup-authority-input-fullName"
                  className="signup-input"
                />
              </label>
              <label className="signup-field">
                <span className="signup-field-label">
                  Your current title at the Club
                </span>
                <input
                  name="signatoryTitle"
                  type="text"
                  required
                  minLength={2}
                  maxLength={120}
                  data-testid="signup-authority-input-title"
                  className="signup-input"
                />
              </label>
              <label className="signup-checkbox-field">
                <input
                  type="checkbox"
                  name="confirmed"
                  value="1"
                  required
                  data-testid="signup-authority-input-confirmed"
                />
                <span>
                  I confirm the attestation above and acknowledge that it
                  is immutably recorded with my Microsoft-verified
                  identity.
                </span>
              </label>
              <button
                type="submit"
                className="w1b-pill-cta"
                data-testid="signup-authority-submit"
              >
                Accept and record authorisation
              </button>
            </form>
          </>
        )}
      </section>
    </main>
  );
}
