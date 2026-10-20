// SIGNUP-1 (2026-10-19) — contract locks.  Pins the five founder-
// mandated security invariants:
//
//   §1 /api/signup/* NEVER writes to User / Club / UserClubRole /
//      ClubSubscription.  Super Admin privileges stay unreachable
//      from the signup flow.
//   §2 URL/path identifiers are opaque tokens, NOT DB ids.
//   §3 Microsoft OAuth replay rejection — state consumedAt is set,
//      replay returns STATE_REPLAY.
//   §4 Personal Microsoft accounts (idp=MSA) are rejected
//      server-side even if the authority somehow lets them through.
//   §5 Duplicate detection surfaces to the review decision WITHOUT
//      exposing other registrations' details to the applicant.
//
// Additional invariants:
//   §6 Resume tokens are stored as sha-256 hashes, never plaintext.
//   §7 Microsoft identity scope is identity-only (openid + profile
//      + email + offline_access) — no Mail / Calendars scopes.
//   §8 The $38,000 CAD annual price is preserved in commercial copy.
//   §9 Rate limiting is wired for both signup_start and
//      signup_microsoft scopes.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REG_SRV   = readFileSync(join(process.cwd(), "src/lib/signup/registration.ts"), "utf8");
const OAUTH_SRV = readFileSync(join(process.cwd(), "src/lib/signup/microsoft-oauth.ts"), "utf8");
const ORG_SRV   = readFileSync(join(process.cwd(), "src/lib/signup/org-verification.ts"), "utf8");
const START_RT  = readFileSync(join(process.cwd(), "src/app/api/signup/start/route.ts"), "utf8");
const MS_START  = readFileSync(join(process.cwd(), "src/app/api/signup/microsoft/start/route.ts"), "utf8");
const MS_CB     = readFileSync(join(process.cwd(), "src/app/api/signup/microsoft/callback/route.ts"), "utf8");
const POS_RT    = readFileSync(join(process.cwd(), "src/app/api/signup/admin-position/route.ts"), "utf8");
const PAGE_ID   = readFileSync(join(process.cwd(), "src/app/signup/page.tsx"), "utf8");
const FORM_ID   = readFileSync(join(process.cwd(), "src/app/signup/_components/SignupIdentityForm.tsx"), "utf8");
const PAGE_ADM  = readFileSync(join(process.cwd(), "src/app/signup/t/[token]/admin/page.tsx"), "utf8");
const PAGE_STA  = readFileSync(join(process.cwd(), "src/app/signup/t/[token]/status/page.tsx"), "utf8");
const GUARD     = readFileSync(join(process.cwd(), "src/lib/security/auth-guard.ts"), "utf8");
const SCHEMA_PG = readFileSync(join(process.cwd(), "prisma-postgres/schema.prisma"), "utf8");
const MARKETING = readFileSync(join(process.cwd(), "src/components/marketing/PlatformHomeFramer.tsx"), "utf8");

// Combined API-code surface for the forbidden-write scan.
const ALL_API = [START_RT, MS_START, MS_CB, POS_RT, REG_SRV, OAUTH_SRV, ORG_SRV].join("\n\n");

describe("SIGNUP-1 §1 · No User / Club / UserClubRole / ClubSubscription writes", () => {
  const FORBIDDEN = [
    /prisma\.user\.create/i,
    /prisma\.user\.upsert/i,
    /prisma\.club\.create/i,
    /prisma\.club\.upsert/i,
    /prisma\.userClubRole\.create/i,
    /prisma\.userClubRole\.upsert/i,
    /prisma\.clubSubscription\.create/i,
    /prisma\.clubSubscription\.upsert/i,
    /"SUPER_ADMIN"/i,
    /roleKey:\s*"CLUB_ADMIN"/i,
  ];
  for (const pattern of FORBIDDEN) {
    it(`no match for ${pattern.source}`, () => {
      expect(ALL_API).not.toMatch(pattern);
    });
  }
});

describe("SIGNUP-1 §2 · URL identifiers are opaque tokens, not DB ids", () => {
  it("Screen 1 submits to /api/signup/start (no id in path)", () => {
    expect(FORM_ID).toMatch(/action="\/api\/signup\/start"/);
  });
  it("Resume URL is /signup/t/<token>, not /signup/<id>", () => {
    expect(START_RT).toMatch(/\/signup\/t\/\$\{encodeURIComponent\(resumeToken\)\}/);
    // Resume URL path contains the TOKEN, not the DB id.
    expect(START_RT).not.toMatch(/\/signup\/\$\{registrationId/);
  });
  it("Public pages never render the registration DB id to the DOM", () => {
    expect(PAGE_ADM).not.toMatch(/reg\.id/);
    expect(PAGE_STA).not.toMatch(/reg\.id/);
  });
  it("Public page lookups go through resolveRegistrationByToken, never findUnique(id)", () => {
    expect(PAGE_ADM).toMatch(/resolveRegistrationByToken/);
    expect(PAGE_STA).toMatch(/resolveRegistrationByToken/);
    expect(PAGE_ADM).not.toMatch(/signupRegistration\.findUnique/);
    expect(PAGE_STA).not.toMatch(/signupRegistration\.findUnique/);
  });
});

describe("SIGNUP-1 §3 · OAuth replay rejection", () => {
  it("state is unique in the schema", () => {
    expect(SCHEMA_PG).toMatch(/model\s+SignupOAuthTransaction\s*\{[\s\S]*?state\s+String\s+@unique/);
  });
  it("consumedAt is set on first use; replay returns STATE_REPLAY", () => {
    expect(OAUTH_SRV).toMatch(/if \(tx\.consumedAt\)[\s\S]*?return\s*\{\s*status:\s*"STATE_REPLAY"/);
  });
  it("markOutcome persists consumedAt + outcome atomically", () => {
    expect(OAUTH_SRV).toMatch(/signupOAuthTransaction\.update[\s\S]*?consumedAt:\s*new Date\(\)[\s\S]*?outcome/);
  });
});

describe("SIGNUP-1 §4 · Personal Microsoft accounts rejected", () => {
  it("authority uses /organizations (platform-level rejection)", () => {
    expect(OAUTH_SRV).toMatch(/authority:[\s\S]*?\/organizations/);
  });
  it("server-side rejects claims.idp === 'MSA' explicitly", () => {
    expect(OAUTH_SRV).toMatch(/claims\.idp === "MSA"/);
    expect(OAUTH_SRV).toMatch(/PERSONAL_ACCOUNT_REJECTED/);
  });
  it("Microsoft callback shows a non-disclosing error message for personal accounts", () => {
    expect(MS_CB).toMatch(/PERSONAL_ACCOUNT_REJECTED/);
    expect(MS_CB).toMatch(/work-or-school/i);
  });
});

describe("SIGNUP-1 §5 · Duplicate detection WITHOUT applicant disclosure", () => {
  it("no global uniqueness on legalName / operatingName / websiteUrl", () => {
    // The SignupRegistration block must NOT declare @unique on these columns.
    const regBlock = SCHEMA_PG.match(/model\s+SignupRegistration\s*\{[\s\S]*?^\}/m)?.[0] ?? "";
    expect(regBlock).toMatch(/legalName\s+String$/m);
    expect(regBlock).not.toMatch(/legalName\s+String\s+@unique/);
    expect(regBlock).not.toMatch(/operatingName\s+String\?\s+@unique/);
    expect(regBlock).not.toMatch(/websiteUrl\s+String\?\s+@unique/);
  });
  it("classifier returns counts, not ids or details", () => {
    expect(ORG_SRV).toMatch(/duplicateSignals:[\s\S]*?normalizedLegalNameMatches:\s*number/);
    // The decision object MUST NOT expose other registrations' ids.
    const decisionBlock = ORG_SRV.match(/export interface OrgSignalEvidence[\s\S]*?^\}/m)?.[0] ?? "";
    expect(decisionBlock).not.toMatch(/registrationId:\s*string/);
  });
  it("applicant-facing status copy never mentions duplicates / other registrations", () => {
    expect(PAGE_STA).not.toMatch(/duplicate/i);
    expect(PAGE_STA).not.toMatch(/another\s+registration/i);
  });
  it("Status page's non-disclosure path for NEEDS_MANUAL_REVIEW is generic", () => {
    const review = PAGE_STA.match(/NEEDS_MANUAL_REVIEW[\s\S]*?;/)?.[0] ?? "";
    expect(review).toMatch(/review/i);
    expect(review).not.toMatch(/duplicate/i);
    expect(review).not.toMatch(/conflict/i);
    expect(review).not.toMatch(/other\s+applicant/i);
  });
});

describe("SIGNUP-1 §6 · Resume tokens are sha-256-hashed", () => {
  it("Schema stores *_resumeTokenHash, never *_resumeToken plaintext", () => {
    const regBlock = SCHEMA_PG.match(/model\s+SignupRegistration\s*\{[\s\S]*?^\}/m)?.[0] ?? "";
    expect(regBlock).toMatch(/resumeTokenHash\s+String\s+@unique/);
    expect(regBlock).toMatch(/emailResumeTokenHash\s+String\?\s+@unique/);
    expect(regBlock).not.toMatch(/resumeToken\s+String[^H]/);
  });
  it("createRegistration hashes the token before persisting", () => {
    // Variable form: resumeTokenHash computed from sha256HashHex(resumeToken) above the create call.
    expect(REG_SRV).toMatch(/const resumeTokenHash = sha256HashHex\(resumeToken\)/);
  });
  it("resolveRegistrationByToken compares via sha256HashHex, not raw equality", () => {
    expect(REG_SRV).toMatch(/const hash = sha256HashHex\(token\)/);
    expect(REG_SRV).toMatch(/resumeTokenHash:\s*hash/);
    expect(REG_SRV).toMatch(/emailResumeTokenHash:\s*hash/);
  });
});

describe("SIGNUP-1 §7 · Microsoft identity scope is identity-only", () => {
  it("Scope list = openid + profile + email + offline_access — no Mail / Calendars", () => {
    expect(OAUTH_SRV).toMatch(/IDENTITY_SCOPES = \["openid",\s*"profile",\s*"email",\s*"offline_access"\]/);
    expect(OAUTH_SRV).not.toMatch(/"Mail\.Read"/);
    expect(OAUTH_SRV).not.toMatch(/"Mail\.ReadWrite"/);
    expect(OAUTH_SRV).not.toMatch(/"Mail\.Send"/);
    expect(OAUTH_SRV).not.toMatch(/"Calendars\.Read"/);
  });
});

describe("SIGNUP-1 §8 · Commercial copy preserves $38,000 CAD annual", () => {
  it("Screen 1 lede mentions $38,000 CAD", () => {
    expect(PAGE_ID).toMatch(/\$38,000\s*CAD/);
  });
  it("Status screen mentions $38,000 CAD annually", () => {
    expect(PAGE_STA).toMatch(/\$38,000\s*CAD/);
    expect(PAGE_STA).toMatch(/annually/i);
  });
  it("Neither screen initiates payment / stores banking info in SIGNUP-1", () => {
    expect(PAGE_ID).not.toMatch(/stripe/i);
    expect(PAGE_STA).not.toMatch(/stripe/i);
    expect(PAGE_ID).not.toMatch(/card\s+number/i);
    expect(PAGE_STA).not.toMatch(/card\s+number/i);
  });
});

describe("SIGNUP-1 §9 · Rate limiting", () => {
  it("auth-guard enumerates signup_start + signup_microsoft scopes", () => {
    expect(GUARD).toMatch(/"signup_start"/);
    expect(GUARD).toMatch(/"signup_microsoft"/);
  });
  it("Each handler calls checkAuthRateLimit before any DB write", () => {
    expect(START_RT).toMatch(/checkAuthRateLimit\(\s*"signup_start"/);
    expect(MS_START).toMatch(/checkAuthRateLimit\(\s*"signup_microsoft"/);
  });
});

describe("SIGNUP-1 · Marketing CTA wiring", () => {
  it("Sign Up pill added alongside Request a Demonstration", () => {
    expect(MARKETING).toMatch(/data-testid="marketing-cta-signup"/);
    expect(MARKETING).toMatch(/data-testid="marketing-cta-demo"/);
    expect(MARKETING).toMatch(/href="\/signup"/);
    expect(MARKETING).toMatch(/Request a Demonstration/);
  });
});

describe("SIGNUP-1 · Admin boundary explicit in copy", () => {
  it("Status screen tells the user they'll get Club-level admin, not platform SUPER_ADMIN", () => {
    expect(PAGE_STA).toMatch(/Club-level administrator/i);
    expect(PAGE_STA).not.toMatch(/SUPER_ADMIN/);
  });
});

describe("SIGNUP-1 · Non-disclosure guards", () => {
  it("[token] resumes via next/navigation.notFound() on unknown token (no disclosure)", () => {
    const RESUME = readFileSync(join(process.cwd(), "src/app/signup/t/[token]/page.tsx"), "utf8");
    expect(RESUME).toMatch(/if \(!reg\) notFound\(\)/);
  });
  it("Admin + status pages call notFound() on unknown/expired token", () => {
    expect(PAGE_ADM).toMatch(/if \(!reg\) notFound\(\)/);
    expect(PAGE_STA).toMatch(/if \(!reg\) notFound\(\)/);
  });
});

describe("SIGNUP-1 §2 (conditional) · Platform email adapter wired", () => {
  it("resume-email imports selectPlatformEmailAdapter (NOT the hardcoded dev adapter)", () => {
    const EMAIL = readFileSync(join(process.cwd(), "src/lib/signup/resume-email.ts"), "utf8");
    expect(EMAIL).toMatch(/selectPlatformEmailAdapter/);
    expect(EMAIL).not.toMatch(/import\s*\{\s*devEmailAdapter\s*\}/);
  });
  it("selectPlatformEmailAdapter is exported from integrations/email.ts", () => {
    const E = readFileSync(join(process.cwd(), "src/lib/integrations/email.ts"), "utf8");
    expect(E).toMatch(/export async function selectPlatformEmailAdapter/);
  });
  it("Diagnostic endpoint reports mode + effective adapter decision", () => {
    const D = readFileSync(join(process.cwd(), "src/app/api/admin/signup/debug/status/route.ts"), "utf8");
    expect(D).toMatch(/microsoft365Configured/);
    expect(D).toMatch(/smtpConfigured/);
    expect(D).toMatch(/effectiveAdapter/);
    // Secrets are read only as boolean coercions (`!!env.X`), never
    // placed in the response body as raw values.  The ONLY raw env
    // values that appear in the body are the FROM address (meant to
    // be visible — not sensitive) and public client-id prefixes.
    expect(D).toMatch(/microsoft365Configured[\s\S]*?!!env\.MICROSOFT_CLIENT_SECRET/);
    expect(D).toMatch(/smtpConfigured[\s\S]*?!!env\.SMTP_PORT/);
    // The actual secret must never be an unwrapped expression.
    expect(D).not.toMatch(/clientSecret:\s*env\.MICROSOFT_CLIENT_SECRET/);
    expect(D).not.toMatch(/pass:\s*env\.SMTP_PASS/);
  });
});

describe("SIGNUP-1 §4 (conditional) · Security invariants", () => {
  it("Force-verify endpoint gated by SPECTRE_ALLOW_STAGING_DEBUG", () => {
    const FV = readFileSync(join(process.cwd(), "src/app/api/admin/signup/debug/force-verify/route.ts"), "utf8");
    expect(FV).toMatch(/SPECTRE_ALLOW_STAGING_DEBUG/);
    expect(FV).toMatch(/debug_endpoint_disabled/);
  });
  it("Force-verify never grants SUPER_ADMIN or writes to User / Club / UserClubRole", () => {
    const FV = readFileSync(join(process.cwd(), "src/app/api/admin/signup/debug/force-verify/route.ts"), "utf8");
    expect(FV).not.toMatch(/prisma\.user\./);
    expect(FV).not.toMatch(/prisma\.club\./);
    expect(FV).not.toMatch(/prisma\.userClubRole\./);
    // Code (non-comment) must not reference SUPER_ADMIN as a value.
    // The doc comment "does NOT grant SUPER_ADMIN" is allowed.
    expect(FV).not.toMatch(/"SUPER_ADMIN"/);
    expect(FV).not.toMatch(/roleKey:\s*"CLUB_ADMIN"/);
  });
  it("rotateResumeToken writes a fresh hash to resumeTokenHash (SIGNUP-1F: used by /signup/r consume)", () => {
    const R = readFileSync(join(process.cwd(), "src/lib/signup/registration.ts"), "utf8");
    expect(R).toMatch(/async function rotateResumeToken[\s\S]*?resumeTokenHash:\s*hash/);
  });
  it("SIGNUP-1F · rotateEmailResumeToken is removed in favour of the dedicated SignupRecoveryLink table", () => {
    const R = readFileSync(join(process.cwd(), "src/lib/signup/registration.ts"), "utf8");
    // Comments may still reference it; the exported function must be gone.
    expect(R).not.toMatch(/export async function rotateEmailResumeToken/);
  });
  it("SIGNUP-1G · 7-day expiresAt only gates DRAFT, so VERIFIED registrations stay recoverable past 7 days", () => {
    const R = readFileSync(join(process.cwd(), "src/lib/signup/registration.ts"), "utf8");
    // The resolver's expiresAt check must be scoped to status==="DRAFT".
    expect(R).toMatch(/if \(reg\.status === "DRAFT" && reg\.expiresAt\.getTime\(\) < Date\.now\(\)\) return null/);
    // The bare unconditional-TTL check must be gone.
    expect(R).not.toMatch(/^\s*if \(reg\.expiresAt\.getTime\(\) < Date\.now\(\)\) return null;\s*$/m);
  });
  it("Abandoned registrations are inaccessible via token resume", () => {
    const R = readFileSync(join(process.cwd(), "src/lib/signup/registration.ts"), "utf8");
    expect(R).toMatch(/if \(reg\.status === "ABANDONED"\) return null/);
  });
  it("SIGNUP-1G · sweeper only abandons DRAFT (never VERIFIED / ESCALATED)", () => {
    const S = readFileSync(join(process.cwd(), "src/lib/signup/sweeper.ts"), "utf8");
    expect(S).toMatch(/status:\s*"DRAFT",\s*expiresAt:\s*\{\s*lt:\s*now\s*\}/);
    // The sweeper must not have ANY updateMany that sweeps a VERIFIED
    // or ESCALATED row to ABANDONED.
    const updates = S.match(/signupRegistration\.updateMany[\s\S]+?\}\)/g) ?? [];
    for (const u of updates) {
      expect(u).not.toMatch(/"VERIFIED"/);
      expect(u).not.toMatch(/"ESCALATED"/);
    }
  });
});

describe("SIGNUP-1E · Role prompt-submit-persist chain", () => {
  it("microsoft/start returns to /admin, NOT /status (so the position form renders after callback)", () => {
    const S = readFileSync(join(process.cwd(), "src/app/api/signup/microsoft/start/route.ts"), "utf8");
    expect(S).toMatch(/returnPath:\s*`\/signup\/t\/\$\{encodeURIComponent\(token\)\}\/admin`/);
    expect(S).not.toMatch(/returnPath:\s*`\/signup\/t\/\$\{encodeURIComponent\(token\)\}\/status`/);
  });
  it("admin page's redirect gate requires BOTH adminVerifiedAt AND adminPosition", () => {
    const A = readFileSync(join(process.cwd(), "src/app/signup/t/[token]/admin/page.tsx"), "utf8");
    expect(A).toMatch(/if \(reg\.adminVerifiedAt && reg\.adminPosition\)/);
    expect(A).toMatch(/redirect\(`\/signup\/t\/\$\{encodeURIComponent\(params\.token\)\}\/status`\)/);
  });
  it("Status page shows the actual role when adminPosition is set; shows 'Pending' only when null", () => {
    const S = readFileSync(join(process.cwd(), "src/app/signup/t/[token]/status/page.tsx"), "utf8");
    // The condition — show adminPosition if set; show Pending if null.
    expect(S).toMatch(/reg\.adminPosition\s*\?\?\s*<em[^>]*>Pending<\/em>/);
  });
});

describe("SIGNUP-1E · No sensitive data in logs", () => {
  it("Resume-email service never passes the resume URL to the logger", () => {
    const R = readFileSync(join(process.cwd(), "src/lib/signup/resume-email.ts"), "utf8");
    // Scan all logger.* calls — none may reference the body / url /
    // token.  We only log masked email + provider message id.
    const loggerCalls = R.match(/logger\.(info|warn|error)\(([\s\S]*?)\)/g) ?? [];
    for (const call of loggerCalls) {
      expect(call, `logger call must not include resumeUrl: ${call}`).not.toMatch(/resumeUrl/);
      expect(call, `logger call must not include body: ${call}`).not.toMatch(/\bbody\b/);
      expect(call, `logger call must not include args\\.resumeToken: ${call}`).not.toMatch(/args\.resumeToken/);
    }
  });
  it("Dev email adapter never prints the body (which contains the URL)", () => {
    const E = readFileSync(join(process.cwd(), "src/lib/integrations/email.ts"), "utf8");
    // The one console.log in devEmailAdapter is the subject + recipient only.
    expect(E).toMatch(/console\.log\(`\[dev:email\] → \$\{to\.email[^`]+\| \$\{subject\}`\)/);
    // No console.* call whose single-line arguments interpolate `body`.
    const lineByLine = E.split("\n");
    const consoleLines = lineByLine.filter((l) => /console\.(log|info|warn|error|debug)/.test(l));
    for (const l of consoleLines) {
      expect(l, `console line must not reference body: ${l}`).not.toMatch(/\$\{body\}|,\s*body\b/);
    }
  });
});

describe("SIGNUP-1D · Entra redirect-URI readiness check", () => {
  it("env.ts exports signupRedirectUri() with env-override support", () => {
    const E = readFileSync(join(process.cwd(), "src/lib/env.ts"), "utf8");
    expect(E).toMatch(/export function signupRedirectUri\(\): string/);
    expect(E).toMatch(/env\.MICROSOFT_SIGNUP_REDIRECT_URI/);
    expect(E).toMatch(/MICROSOFT_SIGNUP_REDIRECT_URI:\s*z\.string\(\)\.url\(\)\.optional\(\)/);
  });
  it("microsoft-oauth service routes through signupRedirectUri()", () => {
    const O = readFileSync(join(process.cwd(), "src/lib/signup/microsoft-oauth.ts"), "utf8");
    expect(O).toMatch(/signupRedirectUri/);
    expect(O).toMatch(/return signupRedirectUri\(\)/);
  });
  it("Diagnostic endpoint reports signupRedirectUri + mailboxRedirectUri + readinessNote", () => {
    const D = readFileSync(join(process.cwd(), "src/app/api/admin/signup/debug/status/route.ts"), "utf8");
    expect(D).toMatch(/signupRedirectUri:\s*signupRedirectUri\(\)/);
    expect(D).toMatch(/mailboxRedirectUri:\s*mailboxRedirectUri\(\)/);
    expect(D).toMatch(/readinessNote/);
    expect(D).toMatch(/AADSTS50011/);
  });
  it("Real-browser regression spec detects AADSTS50011 in the Microsoft page body", () => {
    const T = readFileSync(join(process.cwd(), "tests/e2e/signup-1c-ms-button-regression.staging.spec.ts"), "utf8");
    expect(T).toMatch(/AADSTS/);
    expect(T).toMatch(/page\.content\(\)/);
  });
});

describe("SIGNUP-1C · CSP form-action permits Microsoft identity navigation", () => {
  it("middleware form-action directive allows https://login.microsoftonline.com", () => {
    const MW = readFileSync(join(process.cwd(), "src/middleware.ts"), "utf8");
    // Must include login.microsoftonline.com or the browser silently
    // drops the 303 cross-origin navigation and the Microsoft button
    // appears inert.  This is the exact bug SIGNUP-1C fixed.
    expect(MW).toMatch(/form-action 'self' https:\/\/login\.microsoftonline\.com/);
  });
  it("middleware does NOT regress to the bare 'self' form-action", () => {
    const MW = readFileSync(join(process.cwd(), "src/middleware.ts"), "utf8");
    expect(MW).not.toMatch(/"form-action 'self'"/);
  });
  it("middleware does not accidentally allow personal-account endpoints (login.live.com / login.microsoft.com)", () => {
    const MW = readFileSync(join(process.cwd(), "src/middleware.ts"), "utf8");
    expect(MW).not.toMatch(/form-action[^;]*login\.live\.com/);
    expect(MW).not.toMatch(/form-action[^;]*login\.microsoft\.com\b/);
  });
});

describe("SIGNUP-1 · Canada-only launch (data model future-proof)", () => {
  it("createRegistration enum limits country to SUPPORTED_COUNTRIES = ['CA']", () => {
    expect(REG_SRV).toMatch(/export const SUPPORTED_COUNTRIES = \["CA"\] as const/);
    expect(REG_SRV).toMatch(/country:\s*z\.enum\(SUPPORTED_COUNTRIES\)/);
  });
  it("country column is a string (not an enum) — future expansion safe", () => {
    const regBlock = SCHEMA_PG.match(/model\s+SignupRegistration\s*\{[\s\S]*?^\}/m)?.[0] ?? "";
    expect(regBlock).toMatch(/country\s+String$/m);
  });
});
