// SIGNUP-1 (2026-10-19) — Organization verification + duplicate
// detection.
//
// Design per founder amendments:
//   - NO global uniqueness on normalized legal name.  Multiple
//     clubs can legitimately share pieces of a name (e.g. "The Golf
//     Club at X"), and blocking legitimate registrations is worse
//     than surfacing a review signal.
//   - Automated-first: domain alignment between (a) the website the
//     applicant typed, (b) the Microsoft tenant verified via OAuth,
//     and (c) the admin's email address all map to the same org.
//     When they align, status = AUTOMATED_PASSED.  When they don't,
//     NEEDS_MANUAL_REVIEW.
//   - Potential duplicates are surfaced to the review queue via
//     ownershipAutomatedCheckJson — the status endpoint NEVER
//     discloses details of another applicant's registration.
//   - No PII leakage: the applicant-facing status says only "Your
//     registration is being reviewed".

import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------
// Normalisation helpers

const CORPORATE_SUFFIXES = [
  "limited", "ltd", "ltd.", "inc", "inc.", "incorporated",
  "corp", "corporation", "co", "co.", "company",
  "llc", "l.l.c", "l.l.c.", "society", "association",
  "club", "golf", "country", "golf club", "country club",
];

export function normalizeOrgName(input: string): string {
  const trimmed = input.toLowerCase().trim();
  // Strip "the "
  let s = trimmed.replace(/^the\s+/, "");
  // Collapse whitespace
  s = s.replace(/\s+/g, " ");
  // Remove trailing corporate suffixes (one pass is enough for
  // overwhelming majority of names).
  for (const suf of CORPORATE_SUFFIXES.slice().sort((a, b) => b.length - a.length)) {
    if (s.endsWith(" " + suf)) {
      s = s.slice(0, -(suf.length + 1)).trim();
    }
  }
  // Strip punctuation except intra-word hyphens.
  s = s.replace(/[^a-z0-9\- ]/g, "").replace(/\s+/g, " ").trim();
  return s;
}

export function extractDomain(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.startsWith("http") ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

export function extractEmailDomain(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return null;
  return email.slice(at + 1).toLowerCase();
}

// ---------------------------------------------------------------------
// Signals

export interface OrgSignals {
  websiteDomain: string | null;
  adminEmailDomain: string | null;
  // The Microsoft tenant id (verified).  Used as a cross-check — two
  // separate registrations with the SAME tenantId and website domain
  // are likely the same org claiming twice; two with DIFFERENT
  // tenantIds for the same website are a conflict review signal.
  microsoftTenantId: string | null;
  // Duplicate-registration signals.
  normalizedLegalName: string;
  normalizedOperatingName: string | null;
}

export interface OrgSignalEvidence {
  websiteDomain: string | null;
  adminEmailDomain: string | null;
  microsoftTenantId: string | null;
  domainAlignment:
    | "ALL_MATCH"             // website domain == admin email domain
    | "WEBSITE_MISSING"       // no website; cannot compare
    | "ADMIN_EMAIL_MISMATCH"  // website domain != admin email domain
    | "ADMIN_EMAIL_MISSING";
  duplicateSignals: {
    normalizedLegalNameMatches: number;
    normalizedOperatingNameMatches: number;
    sameTenantOtherRegistrationIds: number;
  };
  decision:
    | "AUTOMATED_PASSED"
    | "NEEDS_MANUAL_REVIEW"
    | "ESCALATED";
  reasons: string[];
}

export interface ClassifyArgs {
  registrationId: string; // excluded from duplicate scan
  websiteUrl: string | null;
  adminEmail: string;
  microsoftTenantId: string;
  legalName: string;
  operatingName: string | null;
}

/** Pure classifier — no DB writes.  Returns the decision + evidence. */
export async function classifyOrganization(args: ClassifyArgs): Promise<OrgSignalEvidence> {
  const websiteDomain = extractDomain(args.websiteUrl);
  const adminEmailDomain = extractEmailDomain(args.adminEmail);
  const normalizedLegal = normalizeOrgName(args.legalName);
  const normalizedOperating = args.operatingName ? normalizeOrgName(args.operatingName) : null;

  // Domain alignment.
  let domainAlignment: OrgSignalEvidence["domainAlignment"];
  if (!websiteDomain) domainAlignment = "WEBSITE_MISSING";
  else if (!adminEmailDomain) domainAlignment = "ADMIN_EMAIL_MISSING";
  else if (websiteDomain === adminEmailDomain) domainAlignment = "ALL_MATCH";
  else domainAlignment = "ADMIN_EMAIL_MISMATCH";

  // Duplicate signals — count potential matches on normalized name
  // + tenant match for OTHER non-abandoned registrations.
  // IMPORTANT: we return COUNTS, never ids or details.  Status
  // endpoint only sees the decision; SpectreAdmin dashboard sees
  // the evidence separately.
  const sameTenant = await prisma.signupRegistration.count({
    where: {
      id: { not: args.registrationId },
      adminMicrosoftTenantId: args.microsoftTenantId,
      status: { in: ["DRAFT", "VERIFIED"] },
    },
  });

  // Normalised-name matches via exact equality on the normalised
  // columns (populated at insert time by registration.ts).  Cross-DB
  // safe — no `mode: "insensitive"` dependency.
  const nameSameLegal = normalizedLegal
    ? await prisma.signupRegistration.count({
        where: {
          id: { not: args.registrationId },
          status: { in: ["DRAFT", "VERIFIED"] },
          legalNameNormalized: normalizedLegal,
        },
      })
    : 0;
  const nameSameOperating = normalizedOperating
    ? await prisma.signupRegistration.count({
        where: {
          id: { not: args.registrationId },
          status: { in: ["DRAFT", "VERIFIED"] },
          operatingNameNormalized: normalizedOperating,
        },
      })
    : 0;

  const reasons: string[] = [];
  if (sameTenant > 0) reasons.push(`sameMicrosoftTenant:${sameTenant}`);
  if (nameSameLegal > 0) reasons.push(`legalNameMatch:${nameSameLegal}`);
  if (nameSameOperating > 0) reasons.push(`operatingNameMatch:${nameSameOperating}`);
  if (domainAlignment === "ADMIN_EMAIL_MISMATCH") reasons.push("adminEmailDomainMismatch");
  if (domainAlignment === "WEBSITE_MISSING") reasons.push("websiteDomainMissing");

  // Decision:
  //   AUTOMATED_PASSED  — zero duplicate signals AND
  //                       (ALL_MATCH OR WEBSITE_MISSING-but-no-dup).
  //   NEEDS_MANUAL_REVIEW — any duplicate signal OR domain mismatch.
  //   ESCALATED         — only set by human review via the admin
  //                       dashboard; not here.
  let decision: OrgSignalEvidence["decision"];
  const hasAnyDupSignal = sameTenant > 0 || nameSameLegal > 0 || nameSameOperating > 0;
  if (!hasAnyDupSignal && (domainAlignment === "ALL_MATCH" || domainAlignment === "WEBSITE_MISSING")) {
    decision = "AUTOMATED_PASSED";
  } else {
    decision = "NEEDS_MANUAL_REVIEW";
  }

  return {
    websiteDomain,
    adminEmailDomain,
    microsoftTenantId: args.microsoftTenantId,
    domainAlignment,
    duplicateSignals: {
      normalizedLegalNameMatches: nameSameLegal,
      normalizedOperatingNameMatches: nameSameOperating,
      sameTenantOtherRegistrationIds: sameTenant,
    },
    decision,
    reasons,
  };
}

/** Apply the decision to the registration row.  Does NOT disclose
 *  evidence to the applicant-facing projection. */
export async function recordOrganizationDecision(
  registrationId: string,
  evidence: OrgSignalEvidence,
): Promise<void> {
  await prisma.signupRegistration.update({
    where: { id: registrationId },
    data: {
      ownershipVerificationState: evidence.decision,
      ownershipAutomatedCheckJson: JSON.stringify({
        at: new Date().toISOString(),
        ...evidence,
      }),
    },
  });
}
