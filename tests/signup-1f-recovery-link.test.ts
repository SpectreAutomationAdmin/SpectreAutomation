// SIGNUP-1F (2026-10-20) — Contract tests for the dedicated
// recovery-link separation.  These tests are source-contract tests
// (readFileSync + regex) in the same shape as signup-1-contract.test.ts,
// pinning the architecture decisions that satisfy the SIGNUP-1F
// directive:
//
//   1. Email recovery credentials live in a dedicated SignupRecoveryLink
//      table, not on the SignupRegistration row.
//   2. Recovery links are short-lived, single-use, revocable.
//   3. Issuing a new link auto-supersedes any still-active prior link.
//   4. Consume path is race-safe (conditional update).
//   5. Zero raw tokens / full URLs in logs.
//   6. The fresh-link request endpoint is enumeration-safe.
//   7. The /signup/r consume endpoint sets a fresh resume cookie
//      and redirects to the status page.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const RECOVERY_LINK = readFileSync(join(ROOT, "src/lib/signup/recovery-link.ts"), "utf8");
const CALLBACK = readFileSync(join(ROOT, "src/app/api/signup/microsoft/callback/route.ts"), "utf8");
// SIGNUP-1G defect repair (2026-10-25): the GET-consume route was
// split into a read-only landing page (GET) and a child POST
// consume route to defeat email-security scanner pre-fetches.
const RECOVERY_LANDING = readFileSync(join(ROOT, "src/app/signup/r/[token]/page.tsx"), "utf8");
const CONSUME_ROUTE = readFileSync(join(ROOT, "src/app/signup/r/[token]/consume/route.ts"), "utf8");
const RESUME_REQ = readFileSync(join(ROOT, "src/app/api/signup/resume/request/route.ts"), "utf8");
const RESUME_EMAIL = readFileSync(join(ROOT, "src/lib/signup/resume-email.ts"), "utf8");
const REGISTRATION = readFileSync(join(ROOT, "src/lib/signup/registration.ts"), "utf8");
const PRISMA_SCHEMA = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8");
const PRISMA_PG_SCHEMA = readFileSync(join(ROOT, "prisma-postgres/schema.prisma"), "utf8");

describe("SIGNUP-1F · Dedicated SignupRecoveryLink table", () => {
  it("model exists in both Prisma schemas with the required fields", () => {
    for (const schema of [PRISMA_SCHEMA, PRISMA_PG_SCHEMA]) {
      expect(schema).toMatch(/model SignupRecoveryLink \{/);
      expect(schema).toMatch(/registrationId\s+String/);
      expect(schema).toMatch(/tokenHash\s+String\s+@unique/);
      expect(schema).toMatch(/issuedAt\s+DateTime/);
      expect(schema).toMatch(/expiresAt\s+DateTime/);
      expect(schema).toMatch(/consumedAt\s+DateTime\?/);
      expect(schema).toMatch(/revokedAt\s+DateTime\?/);
      expect(schema).toMatch(/revokeReason\s+String\?/);
      expect(schema).toMatch(/issuedToEmail\s+String/);
    }
  });

  it("cascades on registration delete + indexes the hot lookup paths", () => {
    for (const schema of [PRISMA_SCHEMA, PRISMA_PG_SCHEMA]) {
      // SQLite uses `references: [id], onDelete: Cascade` inside the
      // relation; Postgres uses the same form.
      expect(schema).toMatch(/registration\s+SignupRegistration @relation\(fields:\s*\[registrationId\],\s*references:\s*\[id\],\s*onDelete:\s*Cascade\)/);
      expect(schema).toMatch(/@@index\(\[registrationId, issuedAt\]\)/);
      expect(schema).toMatch(/@@index\(\[expiresAt\]\)/);
    }
  });

  it("SignupRegistration no longer writes emailResumeTokenHash via rotateEmailResumeToken", () => {
    // The function is removed; the column remains for backward
    // compat with any email already in flight at deploy time.
    expect(REGISTRATION).not.toMatch(/export async function rotateEmailResumeToken/);
    // The recovery-link service may MENTION the column in comments
    // but must not write it in a Prisma call.
    const nonComment = RECOVERY_LINK.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(nonComment).not.toMatch(/emailResumeTokenHash\s*:/);
    expect(nonComment).not.toMatch(/data:\s*\{[\s\S]*?emailResumeTokenHash/);
  });
});

describe("SIGNUP-1F · issueRecoveryLink", () => {
  it("writes a sha-256 hash — never the plaintext token — to the DB", () => {
    expect(RECOVERY_LINK).toMatch(/const token = generateOpaqueToken\(32\)/);
    expect(RECOVERY_LINK).toMatch(/const tokenHash = sha256HashHex\(token\)/);
    // The create call uses tokenHash, not token.
    expect(RECOVERY_LINK).toMatch(/prisma\.signupRecoveryLink\.create\([\s\S]*?tokenHash,\s*issuedAt/);
    // The function body must not persist `token:` as a column.
    expect(RECOVERY_LINK).not.toMatch(/data:\s*\{[\s\S]*?token:\s*token/);
  });

  it("sets expiresAt from issuedAt + TTL (default 30 min; env override allowed)", () => {
    expect(RECOVERY_LINK).toMatch(/RECOVERY_LINK_TTL_MS\s*=\s*Number\(/);
    // SIGNUP-1F adjustment (2026-10-20): default is 30 min, NOT 24h.
    expect(RECOVERY_LINK).toMatch(/30\s*\*\s*60\s*\*\s*1000/);
    expect(RECOVERY_LINK).not.toMatch(/24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
    expect(RECOVERY_LINK).toMatch(/SIGNUP_RECOVERY_LINK_TTL_MS/);
    expect(RECOVERY_LINK).toMatch(/expiresAt\s*=\s*new Date\(now\.getTime\(\)\s*\+\s*\(args\.ttlMs\s*\?\?\s*RECOVERY_LINK_TTL_MS\)\)/);
  });

  it("auto-supersedes any still-active prior link for the same registration", () => {
    // updateMany with the right where clause BEFORE the create — any
    // still-active link gets revokedAt=now, revokeReason=SUPERSEDED.
    expect(RECOVERY_LINK).toMatch(/supersede\s*=\s*await prisma\.signupRecoveryLink\.updateMany/);
    expect(RECOVERY_LINK).toMatch(/consumedAt:\s*null,\s*revokedAt:\s*null,\s*expiresAt:\s*\{\s*gt:\s*now\s*\}/);
    expect(RECOVERY_LINK).toMatch(/revokeReason:\s*"SUPERSEDED"/);
  });

  it("logs issue with masked email + tails, NEVER the token or full email", () => {
    // The success log line
    expect(RECOVERY_LINK).toMatch(/logger\.info\("signup\.recovery_link\.issued"/);
    // Must mask email and registration id — no raw full email, no token.
    expect(RECOVERY_LINK).toMatch(/emailMasked:\s*maskEmail\(/);
    expect(RECOVERY_LINK).toMatch(/registrationIdTail:/);
    expect(RECOVERY_LINK).toMatch(/linkIdTail:/);
    // Never interpolates the token into a logger call.
    const logCalls = RECOVERY_LINK.match(/logger\.(?:info|warn|error)\([^)]*\)/gs) ?? [];
    for (const call of logCalls) {
      expect(call, `logger call contains raw token reference: ${call}`).not.toMatch(/\btoken\b(?!Hash)/);
    }
  });
});

describe("SIGNUP-1F · consumeRecoveryLink (single-use)", () => {
  it("classifies the four failure modes before touching the row", () => {
    expect(RECOVERY_LINK).toMatch(/return \{ status: "NOT_FOUND" \}/);
    expect(RECOVERY_LINK).toMatch(/return \{ status: "ALREADY_CONSUMED" \}/);
    expect(RECOVERY_LINK).toMatch(/return \{ status: "REVOKED" \}/);
    expect(RECOVERY_LINK).toMatch(/return \{ status: "EXPIRED" \}/);
  });

  it("conditional update ensures exactly-once semantics (race-safe)", () => {
    // updateMany + where constrains to still-consumable + checks count
    expect(RECOVERY_LINK).toMatch(/applied\s*=\s*await prisma\.signupRecoveryLink\.updateMany/);
    expect(RECOVERY_LINK).toMatch(/consumedAt:\s*null,\s*revokedAt:\s*null,\s*expiresAt:\s*\{\s*gt:\s*now\s*\}/);
    expect(RECOVERY_LINK).toMatch(/if \(applied\.count === 0\)/);
    expect(RECOVERY_LINK).toMatch(/\{ status: "ALREADY_CONSUMED" \}/);
  });

  it("hashes before lookup — never queries by plaintext token", () => {
    expect(RECOVERY_LINK).toMatch(/const tokenHash = sha256HashHex\(t\)/);
    expect(RECOVERY_LINK).toMatch(/prisma\.signupRecoveryLink\.findUnique\([\s\S]*?where:\s*\{\s*tokenHash\s*\}/);
    // No raw-token lookup allowed.
    expect(RECOVERY_LINK).not.toMatch(/where:\s*\{[\s\S]*?token:\s*args\.token/);
  });

  it("length-gates the token before hashing (rejects obvious garbage)", () => {
    expect(RECOVERY_LINK).toMatch(/t\.length < 20 \|\| t\.length > 200/);
  });

  it("records consumedByIp for audit — but still no plaintext in logs", () => {
    expect(RECOVERY_LINK).toMatch(/consumedByIp:\s*args\.consumedByIp/);
    const consumedLog = RECOVERY_LINK.match(/signup\.recovery_link\.consumed[\s\S]{0,300}/);
    expect(consumedLog, "consume log line must exist").not.toBeNull();
    expect(consumedLog![0]).not.toMatch(/\btoken\b(?!Hash)/);
  });
});

describe("SIGNUP-1F · revokeAllForRegistration (operator revoke)", () => {
  it("marks every active link revoked with the supplied reason", () => {
    expect(RECOVERY_LINK).toMatch(/export async function revokeAllForRegistration/);
    expect(RECOVERY_LINK).toMatch(/consumedAt:\s*null,\s*revokedAt:\s*null/);
    expect(RECOVERY_LINK).toMatch(/revokeReason:\s*args\.reason/);
  });

  it("logs the operator revoke event (masked)", () => {
    expect(RECOVERY_LINK).toMatch(/logger\.info\("signup\.recovery_link\.revoked_all"/);
    expect(RECOVERY_LINK).toMatch(/registrationIdTail:\s*args\.registrationId\.slice/);
  });
});

describe("SIGNUP-1F · findRegistrationIdByAdminEmail (fresh-link path)", () => {
  it("only matches verified-admin, non-abandoned registrations", () => {
    expect(RECOVERY_LINK).toMatch(/adminVerifiedAt:\s*\{\s*not:\s*null\s*\}/);
    expect(RECOVERY_LINK).toMatch(/status:\s*\{\s*not:\s*"ABANDONED"\s*\}/);
  });

  it("lowercases the email before lookup (case-insensitive match)", () => {
    expect(RECOVERY_LINK).toMatch(/email\s*=\s*adminEmail\.trim\(\)\.toLowerCase\(\)/);
  });
});

describe("SIGNUP-1F · Microsoft callback issues via the new table", () => {
  it("imports issueRecoveryLink + no longer imports rotateEmailResumeToken", () => {
    expect(CALLBACK).toMatch(/import \{ issueRecoveryLink \} from "@\/lib\/signup\/recovery-link"/);
    expect(CALLBACK).not.toMatch(/rotateEmailResumeToken/);
  });

  it("calls issueRecoveryLink with the Microsoft-verified email + IP", () => {
    expect(CALLBACK).toMatch(/const \{ token: recoveryToken \} = await issueRecoveryLink\(\{[\s\S]*?toEmail:\s*outcome\.identity\.email/);
    expect(CALLBACK).toMatch(/issuedByIp:\s*ip/);
  });

  it("passes the fresh plaintext token to sendResumeEmail, nowhere else", () => {
    expect(CALLBACK).toMatch(/await sendResumeEmail\(\{[\s\S]*?resumeToken:\s*recoveryToken/);
    // The plaintext token must not appear in any logger call.
    const logs = CALLBACK.match(/logger\.(?:info|warn|error)\([^)]*\)/g) ?? [];
    for (const l of logs) expect(l).not.toMatch(/recoveryToken/);
  });
});

describe("SIGNUP-1F · /signup/r consume route (POST-only, post-SIGNUP-1G repair)", () => {
  it("exports ONLY a POST handler — no GET handler on the consume route", () => {
    // The parent segment's page.tsx is the GET surface.  A GET on
    // the consume route is impossible (Next.js returns 405).  This
    // is the invariant that defeats email-security scanner pre-fetches.
    expect(CONSUME_ROUTE).toMatch(/export async function POST\(/);
    expect(CONSUME_ROUTE).not.toMatch(/export async function GET\(/);
    expect(CONSUME_ROUTE).not.toMatch(/export async function HEAD\(/);
  });

  it("rate-limits by IP + token-prefix on the public consume endpoint", () => {
    expect(CONSUME_ROUTE).toMatch(/checkAuthRateLimit\("signup_recovery_consume",\s*token\.slice\(0,\s*8\),\s*ip\s*\?\?\s*"unknown"\)/);
  });

  it("consumes the link exactly once and redirects on each failure mode", () => {
    expect(CONSUME_ROUTE).toMatch(/consumeRecoveryLink\(\{\s*token,\s*consumedByIp:\s*ip\s*\}\)/);
    expect(CONSUME_ROUTE).toMatch(/case "ALREADY_CONSUMED":[\s\S]*?already_used/);
    expect(CONSUME_ROUTE).toMatch(/case "EXPIRED":[\s\S]*?expired/);
    expect(CONSUME_ROUTE).toMatch(/case "REVOKED":[\s\S]*?revoked/);
    expect(CONSUME_ROUTE).toMatch(/case "NOT_FOUND":[\s\S]*?unknown_link/);
  });

  it("on SUCCESS rotates the resume token + sets a fresh HTTPOnly cookie", () => {
    expect(CONSUME_ROUTE).toMatch(/const resumeToken = await rotateResumeToken\(outcome\.registrationId\)/);
    expect(CONSUME_ROUTE).toMatch(/res\.cookies\.set\(RESUME_COOKIE,\s*resumeToken,\s*\{/);
    expect(CONSUME_ROUTE).toMatch(/httpOnly:\s*true/);
    expect(CONSUME_ROUTE).toMatch(/sameSite:\s*"lax"/);
    expect(CONSUME_ROUTE).toMatch(/path:\s*"\/signup"/);
  });

  it("does NOT log the token or the full URL path", () => {
    const logs = CONSUME_ROUTE.match(/logger\.(?:info|warn|error)\([^)]*\)/g) ?? [];
    for (const l of logs) {
      expect(l).not.toMatch(/\btoken\b(?!Hash)/);
      expect(l).not.toMatch(/req\.url/);
      expect(l).not.toMatch(/params\.token/);
    }
  });
});

describe("SIGNUP-1G repair · /signup/r/[token] landing page defeats scanner pre-fetch", () => {
  it("renders a page.tsx (not a route.ts) at /signup/r/[token]", () => {
    // The landing-page MUST be a server component (default export
    // of page.tsx), not a route handler.  A route handler at this
    // segment would re-introduce the GET-consume defect.
    expect(RECOVERY_LANDING).toMatch(/export default function RecoveryLinkLandingPage/);
    expect(RECOVERY_LANDING).not.toMatch(/export async function GET\(/);
    expect(RECOVERY_LANDING).not.toMatch(/export async function POST\(/);
  });

  it("the landing page performs ZERO database access -- it is a pure render", () => {
    // Scanners GET this URL; it must never touch the DB.
    expect(RECOVERY_LANDING).not.toMatch(/prisma\./);
    expect(RECOVERY_LANDING).not.toMatch(/consumeRecoveryLink/);
    expect(RECOVERY_LANDING).not.toMatch(/resolveRegistrationByToken/);
    expect(RECOVERY_LANDING).not.toMatch(/findRegistrationIdByAdminEmail/);
    // No logger either — a scanner hit is not a user action.
    expect(RECOVERY_LANDING).not.toMatch(/logger\./);
  });

  it("the landing page discloses NO registration identity (no club, email, legal name, or expiry)", () => {
    expect(RECOVERY_LANDING).not.toMatch(/legalName/);
    expect(RECOVERY_LANDING).not.toMatch(/adminEmail/);
    expect(RECOVERY_LANDING).not.toMatch(/adminDisplayName/);
    expect(RECOVERY_LANDING).not.toMatch(/expiresAt/);
    expect(RECOVERY_LANDING).not.toMatch(/registrationId/);
  });

  it("sends search engines / scanners a noindex metadata hint", () => {
    expect(RECOVERY_LANDING).toMatch(/robots:\s*\{\s*index:\s*false/);
  });

  it("has a form whose action is the sibling consume POST", () => {
    expect(RECOVERY_LANDING).toMatch(/method="POST"/);
    expect(RECOVERY_LANDING).toMatch(/action=\{`\/signup\/r\/\$\{encodeURIComponent\(token\)\}\/consume`\}/);
    expect(RECOVERY_LANDING).toMatch(/data-testid="signup-recovery-confirm-form"/);
    expect(RECOVERY_LANDING).toMatch(/data-testid="signup-recovery-confirm-submit"/);
  });

  it("offers a fresh-link escape hatch in case the user doesn't recognise the request", () => {
    expect(RECOVERY_LANDING).toMatch(/href="\/signup\/resume"/);
    expect(RECOVERY_LANDING).toMatch(/data-testid="signup-recovery-request-fresh-link"/);
  });
});

describe("SIGNUP-1F · /api/signup/resume/request (fresh-link endpoint)", () => {
  it("is enumeration-safe: identical response on match and non-match", () => {
    // The success path redirects to the same ack location.
    const sentRedirect = /redirectTo\("\/signup\/resume\?sent=1"\)/g;
    const matches = RESUME_REQ.match(sentRedirect) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(1);
    // No user-visible redirect may surface the match classification.
    // (Internal log tokens like "signup.recovery.request.no_match" are
    //  server-side only.)  Scan only redirectTo() argument strings.
    const redirects = RESUME_REQ.match(/redirectTo\("[^"]+"\)/g) ?? [];
    for (const r of redirects) {
      expect(r).not.toMatch(/no_match|not_found/);
    }
  });

  it("rate-limits by IP + email-prefix", () => {
    expect(RESUME_REQ).toMatch(/checkAuthRateLimit\("signup_recovery_request"/);
  });

  it("logs the match/no-match classification server-side (for operator triage) with no raw email", () => {
    expect(RESUME_REQ).toMatch(/signup\.recovery\.request\.sent/);
    expect(RESUME_REQ).toMatch(/signup\.recovery\.request\.no_match/);
    const logs = RESUME_REQ.match(/logger\.(?:info|warn|error)\([^)]*\)/g) ?? [];
    for (const l of logs) {
      expect(l).not.toMatch(/\btoken\b/);
      // The resume-request handler lowercases the local-scope `email`
      // variable; it must never interpolate that raw string into a
      // log line.
      expect(l).not.toMatch(/,\s*email\b/);
      expect(l).not.toMatch(/\$\{email\}/);
    }
  });

  it("input-validates email shape before hitting the DB", () => {
    expect(RESUME_REQ).toMatch(/email\.length < 3 \|\| email\.length > 320 \|\| !email\.includes\("@"\)/);
  });
});

describe("SIGNUP-1F · Email body + log safety", () => {
  it("resume email body links the recipient to /signup/r/<token>, not /signup/t/<token>/status", () => {
    expect(RESUME_EMAIL).toMatch(/\/signup\/r\/\$\{encodeURIComponent\(args\.resumeToken\)\}/);
    expect(RESUME_EMAIL).not.toMatch(/\/signup\/t\/\$\{encodeURIComponent\(args\.resumeToken\)\}\/status/);
  });

  it("email body renders TTL in minutes + points to /signup/resume for a fresh link", () => {
    expect(RESUME_EMAIL).toMatch(/single-use and expires in\s*\$\{ttl\}\s*minutes/);
    expect(RESUME_EMAIL).not.toMatch(/single-use and expires in\s*\$\{ttl\}\s*hours/);
    expect(RESUME_EMAIL).toMatch(/\/signup\/resume/);
    // The default TTL hint passed through is now minutes-shaped.
    expect(RESUME_EMAIL).toMatch(/args\.ttlMinutes\s*\?\?\s*30/);
  });

  it("sendResumeEmail logs mask the recipient and never emit the token", () => {
    const logs = RESUME_EMAIL.match(/logger\.(?:info|warn|error)\([^)]*\)/g) ?? [];
    for (const l of logs) {
      expect(l).not.toMatch(/resumeUrl/);
      expect(l).not.toMatch(/\bresumeToken\b/);
      // Full body may contain the URL; it must not be in log args.
      expect(l).not.toMatch(/,\s*body\b/);
      expect(l).not.toMatch(/\$\{body\}/);
    }
  });
});

describe("SIGNUP-1F · AuthScope has the new buckets", () => {
  it("auth-guard.ts registers signup_recovery_consume + signup_recovery_request", () => {
    const G = readFileSync(join(ROOT, "src/lib/security/auth-guard.ts"), "utf8");
    expect(G).toMatch(/"signup_recovery_consume"/);
    expect(G).toMatch(/"signup_recovery_request"/);
  });
});
