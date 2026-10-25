// SIGNUP-2 Phase 2C (2026-10-25) -- Registration verification pipeline.
//
// Entry point: runRegistrationVerification({registrationId, …})
//
// Called by the Phase 2B attestation POST handler AFTER the attestation
// row is persisted + the step transitions to AUTHORITY_ACCEPTED.  Runs
// through:
//
//   1. Resolve the SignupRegistration row (identity + classifier +
//      jurisdiction + abuse flag).
//   2. resolveAdapter(jurisdiction).fetch(...)  → EntityStandingResult.
//   3. Persist the EntityStandingCheck row (REDACTED payload).
//   4. corroborateAuthority(classifier, standing, officerMatch,
//      standingFromLiveAdapter, impersonationFlag) → verdict.
//   5. Transaction: update SignupRegistration.verification* columns +
//      transition .step to AUTHORISED or HOLD_FOR_REVIEW or REJECTED
//      (status += ABANDONED on REJECT).
//   6. Emit audit() events for each state change (tails only; no PII).
//
// The pipeline NEVER:
//   - calls Stripe,
//   - creates a ClubSubscription,
//   - creates a Club / User / UserClubRole,
//   - logs raw tokens or raw registry payloads,
//   - trusts client-supplied inputs (every classification input is
//     either server-read from the DB or returned by the adapter).

import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/observability/logger";
import { resolveAdapter } from "./entity-registry";
import type { EntityStandingResult } from "./entity-registry/types";
import {
  corroborateAuthority,
  type CorroboratorInputs,
  type CorroboratorVerdict,
  type Verdict,
  type HoldCategory,
  type SigningAuthoritySignal,
  type ClassifierDecision,
} from "./authority-corroborator";

export interface RunVerificationInput {
  registrationId: string;
  /** Correlation id -- short, non-PII, for log tracing. */
  correlationId: string;
}

export interface RunVerificationResult {
  verdict: Verdict;
  holdCategory: HoldCategory | null;
  signingAuthoritySignal: SigningAuthoritySignal;
  verificationDecidedAt: Date;
}

/** Jurisdiction-code normaliser.  The signup form captures a 2-letter
 *  provinceState; the registry adapter expects "CA-ON" / "CA-BC" etc.
 *  Phase 2C maps the three priority jurisdictions and falls through to
 *  the manual-review stub for everything else (the stub ignores the
 *  jurisdiction tail anyway). */
export function jurisdictionCodeForRegistration(country: string, provinceState: string): string {
  const c = (country || "").toUpperCase();
  const p = (provinceState || "").toUpperCase();
  if (c === "CA" && p.length === 2) return `CA-${p}`;
  return `${c || "CA"}-${p || "UNKNOWN"}`;
}

/** Redact a registry adapter's result for persistence.  Phase 2C
 *  rule: never persist the raw registry payload; only persist the
 *  classification outputs.  The registryPayloadJson column is thus
 *  reserved for a server-side-written redacted summary. */
function buildRedactedRegistryPayload(res: EntityStandingResult): string {
  return JSON.stringify({
    schema: "phase-2c.v1",
    jurisdiction: res.jurisdiction,
    standing: res.standing,
    officerMatch: res.officerMatch,
    evidenceSource: res.evidenceSource,
    fetchedAt: res.fetchedAt.toISOString(),
    // Explicit: no raw registry fields, no director names, no
    // personal addresses.  businessNumber IS persisted on the row
    // directly (not here), so this JSON blob is purely a redacted
    // mirror of the classification.
  });
}

export async function runRegistrationVerification(
  input: RunVerificationInput,
): Promise<RunVerificationResult> {
  const reg = await prisma.signupRegistration.findUnique({
    where: { id: input.registrationId },
    select: {
      id: true,
      legalName: true,
      country: true,
      provinceState: true,
      adminMicrosoftOid: true,
      ownershipVerificationState: true,
      verificationVerdict: true,
      status: true,
    },
  });
  if (!reg) {
    throw new Error("signup-2-phase-2c: registration not found");
  }

  // Idempotent-replay guard.  If the registration already has a
  // verdict, return it; the pipeline is single-shot per registration.
  // Phase 2H operator overrides go through a different path.
  if (reg.verificationVerdict) {
    const decidedAt = (
      await prisma.signupRegistration.findUnique({
        where: { id: reg.id },
        select: { verificationDecidedAt: true, verificationHoldCategory: true, signingAuthoritySignal: true },
      })
    )!;
    return {
      verdict: reg.verificationVerdict as Verdict,
      holdCategory: (decidedAt.verificationHoldCategory as HoldCategory | null) ?? null,
      signingAuthoritySignal: (decidedAt.signingAuthoritySignal as SigningAuthoritySignal) ?? "NONE",
      verificationDecidedAt: decidedAt.verificationDecidedAt ?? new Date(),
    };
  }

  const jurisdiction = jurisdictionCodeForRegistration(reg.country, reg.provinceState);
  const adapter = resolveAdapter(jurisdiction);

  // Step 1 fetch (adapter encapsulates error handling and returns
  // MANUAL_REVIEW_REQUIRED on any failure path).
  let standingResult: EntityStandingResult;
  try {
    standingResult = await adapter.fetch({
      legalName: reg.legalName,
      signatoryFullName: null, // read from attestation if we need directors list match in future
      jurisdiction,
      correlationId: input.correlationId,
    });
  } catch (err) {
    logger.warn("signup.verification.adapter_error", {
      registrationIdTail: reg.id.slice(-6),
      jurisdiction,
      errorClass: err instanceof Error ? err.constructor.name : "Unknown",
    });
    // Treat ANY adapter crash as MANUAL_REVIEW_REQUIRED.  Adapters
    // are supposed to catch internally; this is belt-and-suspenders.
    standingResult = {
      jurisdiction,
      businessNumber: null,
      standing: "MANUAL_REVIEW_REQUIRED",
      officerMatch: null,
      evidenceSource: "adapter-crash",
      operatorHint: "Adapter raised an unexpected exception.",
      fetchedAt: new Date(),
    };
  }

  // Step 2: pull signatory match from attestation IF the adapter
  // returned an officers list.  For Phase 2C baseline (all adapters
  // return officerMatch=null), this branch is a no-op.
  const officerMatch = standingResult.officerMatch;

  // Step 3: corroborator inputs.  classifier read from the DB;
  // impersonation flag reserved for future lookup -- Phase 2C ships
  // with the hook always returning false.
  const classifier = normalizeClassifier(reg.ownershipVerificationState);
  const impersonationFlag = await lookupImpersonationFlag(reg.adminMicrosoftOid);

  const corroboratorInputs: CorroboratorInputs = {
    classifier,
    standing: standingResult.standing,
    officerMatch,
    standingFromLiveAdapter: adapter.isLive,
    impersonationFlag,
  };

  const verdict: CorroboratorVerdict = corroborateAuthority(corroboratorInputs);
  const now = new Date();

  // Step 4: persist EntityStandingCheck + SignupRegistration update
  // in one transaction.
  await prisma.$transaction(async (tx) => {
    await tx.entityStandingCheck.create({
      data: {
        signupRegistrationId: reg.id,
        clubId: null, // no Club shell exists in Phase 2C
        jurisdiction: standingResult.jurisdiction,
        businessNumber: standingResult.businessNumber,
        standing: standingResult.standing,
        officerMatch: standingResult.officerMatch,
        registryPayloadJson: buildRedactedRegistryPayload(standingResult),
        fetchedAt: standingResult.fetchedAt,
      },
    });

    await tx.signupRegistration.update({
      where: { id: reg.id },
      data: {
        verificationVerdict: verdict.verdict,
        verificationDecidedAt: now,
        verificationDeciderUserId: null, // automatic decision
        verificationHoldCategory: verdict.holdCategory,
        signingAuthoritySignal: verdict.signingAuthoritySignal,
        // Status side-effect on REJECT -- registration is terminal.
        ...(verdict.verdict === "REJECT" ? { status: "ABANDONED" } : {}),
      },
    });
  });

  await audit(null, {
    action: "signup.verification.decided",
    entityType: "SignupRegistration",
    entityId: reg.id,
    clubId: null,
    meta: {
      registrationIdTail: reg.id.slice(-6),
      jurisdiction,
      standing: standingResult.standing,
      verdict: verdict.verdict,
      holdCategory: verdict.holdCategory,
      signingAuthoritySignal: verdict.signingAuthoritySignal,
      rationale: verdict.rationale,
      adapterIsLive: adapter.isLive,
      evidenceSource: standingResult.evidenceSource,
    },
  });

  logger.info("signup.verification.decided", {
    registrationIdTail: reg.id.slice(-6),
    verdict: verdict.verdict,
    holdCategory: verdict.holdCategory,
    rationale: verdict.rationale,
  });

  return {
    verdict: verdict.verdict,
    holdCategory: verdict.holdCategory,
    signingAuthoritySignal: verdict.signingAuthoritySignal,
    verificationDecidedAt: now,
  };
}

function normalizeClassifier(raw: string | null | undefined): ClassifierDecision {
  switch (raw) {
    case "AUTOMATED_PASSED":
    case "NEEDS_MANUAL_REVIEW":
    case "ESCALATED":
    case "OVERRIDDEN":
    case "NOT_STARTED":
      return raw;
    default:
      return "NOT_STARTED";
  }
}

/** Reserved hook for a future impersonation / abuse signal store.
 *  Phase 2C ships with it always returning false; a later slice
 *  can replace the implementation without touching the orchestrator. */
async function lookupImpersonationFlag(_microsoftOid: string | null): Promise<boolean> {
  return false;
}
