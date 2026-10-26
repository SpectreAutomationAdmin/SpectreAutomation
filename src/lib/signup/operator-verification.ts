// SIGNUP-2 Phase 2D (2026-10-25) -- Operator verification service.
//
// Centralises the service-layer logic for the four operator POST
// actions:
//   • recordStandingVerification(principal, registrationId, input)
//   • recordAuthorityVerification(principal, registrationId, input)
//   • releaseRegistration(principal, registrationId, input)
//   • rejectRegistration(principal, registrationId, input)
//
// Every entry point:
//   1. Asserts the feature flag is live (fail-closed).
//   2. Asserts the operator holds `platform:signups:release`.
//   3. Asserts self-approval and separation-of-duties rules.
//   4. Writes an immutable `OperatorVerificationRecord` row (and
//      transitions `SignupRegistration.verification*` for release /
//      reject) in a single `prisma.$transaction`.
//   5. Emits `audit()` with tails only (no raw PII).
//
// Hard non-authorisations preserved:
//   - No ClubSubscription, Club, User, UserClubRole, or Stripe write
//     anywhere in this file.
//   - No gov-ID surface.

import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/observability/logger";
import { ForbiddenError, AppError } from "@/lib/errors";
import { hasPermission, type Principal } from "@/lib/rbac";

export type VerificationConcept = "STANDING" | "AUTHORITY" | "RELEASE" | "REJECT";
export type VerificationFinding = "VERIFIED" | "NOT_VERIFIED" | "AUTHORISED" | "REJECTED";

export interface ConceptVerificationInput {
  evidenceSource: string;        // required
  evidenceProvenance?: string;   // optional detail
  evidenceReference: string;     // required; <= 500 chars
  reason?: string;               // <= 1000 chars
  verifiedAt?: Date;             // defaults to now
  expiresAt?: Date | null;       // STANDING defaults verifiedAt + 24h
  operatorIp?: string | null;
  operatorUserAgent?: string | null;
}

export interface ReleaseInput {
  reason: string;                // required for release decision
  operatorIp?: string | null;
  operatorUserAgent?: string | null;
}

export interface RejectInput {
  reason: string;                // required for reject decision
  operatorIp?: string | null;
  operatorUserAgent?: string | null;
}

const MAX_EVIDENCE_REFERENCE = 500;
const MAX_REASON = 1000;
const DEFAULT_STANDING_FRESHNESS_MS = 24 * 60 * 60 * 1000;

/** Fail-closed feature flag gate for all Phase 2D operator writes.
 *  Per founder §6 + §7: default OFF; missing or invalid fails closed. */
export function assertPhase2dOperatorFlag(): void {
  if (process.env.SPECTRE_SIGNUP_2D_OPERATOR_RELEASE_LIVE !== "1") {
    throw new ForbiddenError(
      "SIGNUP-2 Phase 2D operator release is disabled (SPECTRE_SIGNUP_2D_OPERATOR_RELEASE_LIVE != 1)",
    );
  }
}

function assertEvidenceInputShape(input: ConceptVerificationInput): void {
  if (!input.evidenceSource || typeof input.evidenceSource !== "string") {
    throw new AppError("SIGNUP_2D_MISSING_EVIDENCE_SOURCE", "Evidence source is required", 400);
  }
  if (!input.evidenceReference || typeof input.evidenceReference !== "string") {
    throw new AppError("SIGNUP_2D_MISSING_EVIDENCE_REFERENCE", "Evidence reference is required", 400);
  }
  if (input.evidenceReference.length > MAX_EVIDENCE_REFERENCE) {
    throw new AppError(
      "SIGNUP_2D_EVIDENCE_REFERENCE_TOO_LONG",
      `Evidence reference must be <= ${MAX_EVIDENCE_REFERENCE} characters`,
      400,
    );
  }
  if (input.reason && input.reason.length > MAX_REASON) {
    throw new AppError("SIGNUP_2D_REASON_TOO_LONG", `Reason must be <= ${MAX_REASON} characters`, 400);
  }
  if (input.evidenceProvenance && input.evidenceProvenance.length > MAX_REASON) {
    throw new AppError("SIGNUP_2D_PROVENANCE_TOO_LONG", "Evidence provenance too long", 400);
  }
}

function assertReasonShape(reason: string | undefined, fieldLabel: string): void {
  if (!reason || typeof reason !== "string" || reason.length === 0) {
    throw new AppError("SIGNUP_2D_REASON_REQUIRED", `${fieldLabel} reason is required`, 400);
  }
  if (reason.length > MAX_REASON) {
    throw new AppError("SIGNUP_2D_REASON_TOO_LONG", `${fieldLabel} reason too long`, 400);
  }
}

async function assertOperatorAuthorised(principal: Principal): Promise<void> {
  if (!hasPermission(principal, null, "platform:signups:release")) {
    throw new ForbiddenError("Missing permission: platform:signups:release");
  }
}

interface RegistrationForOperator {
  id: string;
  adminEmail: string | null;
  verificationVerdict: string | null;
  verificationHoldCategory: string | null;
  status: string;
}

async function loadRegistrationForOperator(registrationId: string): Promise<RegistrationForOperator> {
  const reg = await prisma.signupRegistration.findUnique({
    where: { id: registrationId },
    select: {
      id: true,
      adminEmail: true,
      verificationVerdict: true,
      verificationHoldCategory: true,
      status: true,
    },
  });
  if (!reg) {
    throw new AppError("SIGNUP_2D_REGISTRATION_NOT_FOUND", "Registration not found", 404);
  }
  return reg;
}

/** Aggressive email normalisation for the self-approval comparator.
 *  Lowercases, trims, and strips plus-tags so `foo+ops@club.com` and
 *  `foo@club.com` compare equal (same mailbox at Gmail / Outlook /
 *  most providers).  Returns null for falsy input so the comparator
 *  never silently matches null-vs-null. */
export function normaliseEmailForComparison(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  const at = trimmed.indexOf("@");
  if (at <= 0) return trimmed; // malformed -- compare as-is
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at);
  const plus = local.indexOf("+");
  const localNoTag = plus > 0 ? local.slice(0, plus) : local;
  return `${localNoTag}${domain}`;
}

function assertNotApplicant(principal: Principal, reg: RegistrationForOperator): void {
  // SIGNUP-2 Phase 2D identity-control correction (founder §3 of the
  // Phase 2E authorisation, 2026-10-26): the previous version
  // compared raw lower-cased emails.  Operators are password-
  // authenticated and do NOT carry a Microsoft `oid` / `tid` on the
  // User row today, so email remains the strongest comparator
  // available on the operator session.  (Applicants ARE Microsoft-
  // authenticated and the registration row carries the applicant's
  // `adminMicrosoftOid` + `adminMicrosoftTenantId`.)
  //
  // Phase 2D does NOT rely on tenant-ID equality anywhere (founder
  // §3A).  This function:
  //   1. Normalises both emails (lowercase + trim + plus-tag strip)
  //      so a plus-tag-aliased operator cannot bypass the check.
  //   2. Treats a missing applicant email as a hard refusal (an
  //      incomplete registration is NEVER actionable by Phase 2D).
  //
  // Forward-looking: a future Phase-2H slice can add a Microsoft
  // OIDC login path to the User model (new `microsoftOid` column),
  // at which point the comparator should prefer `principal.microsoftOid`
  // vs `reg.adminMicrosoftOid` as the primary comparison and keep
  // normalised email equality as the additional safeguard.
  const operatorEmail = normaliseEmailForComparison(principal.email);
  const applicantEmail = normaliseEmailForComparison(reg.adminEmail);
  if (!applicantEmail) {
    throw new ForbiddenError(
      "Registration has no admin email on file; refusing operator action until identity is captured",
    );
  }
  if (!operatorEmail) {
    throw new ForbiddenError(
      "Operator session has no email; refusing action",
    );
  }
  if (operatorEmail === applicantEmail) {
    throw new ForbiddenError(
      "Operator email matches applicant email (after normalisation) -- applicant self-approval refused",
    );
  }
}

/** Latest record per concept.  Reads createdAt desc.  Used by both
 *  the UI (to show "ready for release") and the service (to enforce
 *  separation of duties). */
export async function latestRecord(
  registrationId: string,
  concept: VerificationConcept,
) {
  return prisma.operatorVerificationRecord.findFirst({
    where: { signupRegistrationId: registrationId, concept },
    orderBy: { createdAt: "desc" },
  });
}

/** Per-concept writer.  STANDING or AUTHORITY. */
async function writeConceptVerification(
  principal: Principal,
  registrationId: string,
  concept: "STANDING" | "AUTHORITY",
  input: ConceptVerificationInput,
) {
  assertPhase2dOperatorFlag();
  await assertOperatorAuthorised(principal);
  assertEvidenceInputShape(input);
  const reg = await loadRegistrationForOperator(registrationId);
  assertNotApplicant(principal, reg);

  if (reg.verificationVerdict && reg.verificationVerdict !== "HOLD_FOR_REVIEW") {
    // Already AUTHORISED or REJECTED -- no further per-concept writes.
    throw new AppError(
      "SIGNUP_2D_REGISTRATION_TERMINAL",
      `Registration is in terminal verdict '${reg.verificationVerdict}'; no further verification writes accepted`,
      409,
    );
  }

  // Separation-of-duties for the OTHER concept: a single operator
  // may not provide both STANDING and AUTHORITY on the same
  // registration (per founder §3A).  Check the latest row of the
  // other concept.
  const otherConcept = concept === "STANDING" ? "AUTHORITY" : "STANDING";
  const otherLatest = await latestRecord(registrationId, otherConcept);
  if (otherLatest && otherLatest.operatorUserId === principal.id) {
    throw new ForbiddenError(
      `Operator ${principal.id.slice(-6)} already signed the ${otherConcept} verification; separation-of-duties refuses the same operator for ${concept}`,
    );
  }

  const verifiedAt = input.verifiedAt ?? new Date();
  const expiresAt: Date | null =
    input.expiresAt !== undefined
      ? input.expiresAt
      : concept === "STANDING"
        ? new Date(verifiedAt.getTime() + DEFAULT_STANDING_FRESHNESS_MS)
        : null;

  const row = await prisma.operatorVerificationRecord.create({
    data: {
      signupRegistrationId: registrationId,
      concept,
      finding: "VERIFIED",
      evidenceSource: input.evidenceSource,
      evidenceProvenance: input.evidenceProvenance ?? null,
      evidenceReference: input.evidenceReference,
      reason: input.reason ?? null,
      operatorUserId: principal.id,
      operatorIp: input.operatorIp ?? null,
      operatorUserAgent: input.operatorUserAgent ?? null,
      verifiedAt,
      expiresAt,
    },
    select: { id: true },
  });

  await audit(principal, {
    action: concept === "STANDING" ? "signup.operator.standing_verified" : "signup.operator.authority_verified",
    entityType: "SignupRegistration",
    entityId: registrationId,
    clubId: null,
    meta: {
      registrationIdTail: registrationId.slice(-6),
      operatorUserIdTail: principal.id.slice(-6),
      recordIdTail: row.id.slice(-6),
      evidenceSource: input.evidenceSource,
      reasonLength: (input.reason ?? "").length,
    },
  });

  logger.info("signup.operator.verification.recorded", {
    registrationIdTail: registrationId.slice(-6),
    operatorUserIdTail: principal.id.slice(-6),
    concept,
  });

  return row;
}

export async function recordStandingVerification(
  principal: Principal,
  registrationId: string,
  input: ConceptVerificationInput,
) {
  return writeConceptVerification(principal, registrationId, "STANDING", input);
}

export async function recordAuthorityVerification(
  principal: Principal,
  registrationId: string,
  input: ConceptVerificationInput,
) {
  return writeConceptVerification(principal, registrationId, "AUTHORITY", input);
}

/** Release gate.  Enforces every §3C prerequisite atomically. */
export interface ReleasePrerequisites {
  standingRecord: { id: string; operatorUserId: string; expiresAt: Date | null } | null;
  authorityRecord: { id: string; operatorUserId: string; expiresAt: Date | null } | null;
  holdCategory: string | null;
}

export async function readReleasePrerequisites(
  registrationId: string,
): Promise<ReleasePrerequisites> {
  const [stand, auth, reg] = await Promise.all([
    prisma.operatorVerificationRecord.findFirst({
      where: { signupRegistrationId: registrationId, concept: "STANDING", finding: "VERIFIED" },
      orderBy: { createdAt: "desc" },
      select: { id: true, operatorUserId: true, expiresAt: true },
    }),
    prisma.operatorVerificationRecord.findFirst({
      where: { signupRegistrationId: registrationId, concept: "AUTHORITY", finding: "VERIFIED" },
      orderBy: { createdAt: "desc" },
      select: { id: true, operatorUserId: true, expiresAt: true },
    }),
    prisma.signupRegistration.findUnique({
      where: { id: registrationId },
      select: { verificationHoldCategory: true },
    }),
  ]);
  return {
    standingRecord: stand,
    authorityRecord: auth,
    holdCategory: reg?.verificationHoldCategory ?? null,
  };
}

/** Final release transition.  Atomic + idempotent. */
export async function releaseRegistration(
  principal: Principal,
  registrationId: string,
  input: ReleaseInput,
) {
  assertPhase2dOperatorFlag();
  await assertOperatorAuthorised(principal);
  assertReasonShape(input.reason, "Release");
  const reg = await loadRegistrationForOperator(registrationId);
  assertNotApplicant(principal, reg);

  // Idempotent-replay: already-released returns a no-op.
  if (reg.verificationVerdict === "PASS_AUTOMATED") {
    logger.info("signup.operator.release.replay", {
      registrationIdTail: registrationId.slice(-6),
    });
    return { noop: true as const, verdict: reg.verificationVerdict };
  }
  if (reg.verificationVerdict === "REJECT") {
    throw new AppError(
      "SIGNUP_2D_REGISTRATION_REJECTED",
      "Registration is in terminal REJECT state; release refused",
      409,
    );
  }

  const prereq = await readReleasePrerequisites(registrationId);

  if (!prereq.standingRecord) {
    throw new ForbiddenError("Standing verification required before release");
  }
  if (!prereq.authorityRecord) {
    throw new ForbiddenError("Authority verification required before release");
  }
  const now = new Date();
  if (prereq.standingRecord.expiresAt && prereq.standingRecord.expiresAt.getTime() < now.getTime()) {
    throw new ForbiddenError("Standing verification evidence is stale; re-verify before release");
  }
  if (prereq.authorityRecord.expiresAt && prereq.authorityRecord.expiresAt.getTime() < now.getTime()) {
    throw new ForbiddenError("Authority verification evidence is stale; re-verify before release");
  }
  if (
    prereq.holdCategory === "CONFLICTING_EVIDENCE" ||
    prereq.holdCategory === "SUSPECTED_IMPERSONATION"
  ) {
    throw new ForbiddenError(
      `Unresolved hold category ${prereq.holdCategory}; release refused`,
    );
  }

  // Three-distinct-operators rule (founder §3A).
  const standingOp = prereq.standingRecord.operatorUserId;
  const authorityOp = prereq.authorityRecord.operatorUserId;
  if (standingOp === authorityOp) {
    throw new ForbiddenError(
      "Standing and authority verifications were signed by the same operator; separation-of-duties refuses release",
    );
  }
  if (principal.id === standingOp || principal.id === authorityOp) {
    throw new ForbiddenError(
      "Releasing operator must differ from both standing and authority verifiers (three-distinct-operators rule)",
    );
  }

  // Atomic transition.  updateMany with a guard clause defeats
  // concurrent-release races: the second POST sees applied=0 and
  // short-circuits.
  const result = await prisma.$transaction(async (tx) => {
    const applied = await tx.signupRegistration.updateMany({
      where: { id: registrationId, verificationVerdict: "HOLD_FOR_REVIEW" },
      data: {
        verificationVerdict: "PASS_AUTOMATED",
        verificationDecidedAt: now,
        verificationDeciderUserId: principal.id,
        signingAuthoritySignal: "OPERATOR_RELEASE",
      },
    });
    if (applied.count === 0) {
      // Lost race.  Return existing state.
      const current = await tx.signupRegistration.findUnique({
        where: { id: registrationId },
        select: { verificationVerdict: true },
      });
      return { noop: true as const, verdict: current?.verificationVerdict ?? null };
    }
    const row = await tx.operatorVerificationRecord.create({
      data: {
        signupRegistrationId: registrationId,
        concept: "RELEASE",
        finding: "AUTHORISED",
        evidenceSource: "operator-release",
        evidenceProvenance: null,
        evidenceReference: null,
        reason: input.reason,
        operatorUserId: principal.id,
        operatorIp: input.operatorIp ?? null,
        operatorUserAgent: input.operatorUserAgent ?? null,
        verifiedAt: now,
        expiresAt: null,
      },
      select: { id: true },
    });
    return { noop: false as const, verdict: "PASS_AUTOMATED" as const, recordId: row.id };
  });

  if (!result.noop) {
    await audit(principal, {
      action: "signup.operator.released",
      entityType: "SignupRegistration",
      entityId: registrationId,
      clubId: null,
      meta: {
        registrationIdTail: registrationId.slice(-6),
        operatorUserIdTail: principal.id.slice(-6),
        standingOperatorUserIdTail: standingOp.slice(-6),
        authorityOperatorUserIdTail: authorityOp.slice(-6),
        releaseRecordIdTail: result.recordId.slice(-6),
        reasonLength: input.reason.length,
      },
    });
    logger.info("signup.operator.released", {
      registrationIdTail: registrationId.slice(-6),
      operatorUserIdTail: principal.id.slice(-6),
    });
  }

  return result;
}

/** Final reject transition.  Does NOT require standing + authority
 *  records -- operators may reject early when evidence is clear
 *  (e.g., suspected impersonation detected before verification). */
export async function rejectRegistration(
  principal: Principal,
  registrationId: string,
  input: RejectInput,
) {
  assertPhase2dOperatorFlag();
  await assertOperatorAuthorised(principal);
  assertReasonShape(input.reason, "Reject");
  const reg = await loadRegistrationForOperator(registrationId);
  assertNotApplicant(principal, reg);

  if (reg.verificationVerdict === "REJECT") {
    logger.info("signup.operator.reject.replay", {
      registrationIdTail: registrationId.slice(-6),
    });
    return { noop: true as const, verdict: reg.verificationVerdict };
  }
  if (reg.verificationVerdict === "PASS_AUTOMATED") {
    throw new AppError(
      "SIGNUP_2D_REGISTRATION_AUTHORISED",
      "Registration is already AUTHORISED; reject refused",
      409,
    );
  }

  const now = new Date();
  const result = await prisma.$transaction(async (tx) => {
    const applied = await tx.signupRegistration.updateMany({
      where: { id: registrationId, verificationVerdict: "HOLD_FOR_REVIEW" },
      data: {
        verificationVerdict: "REJECT",
        verificationDecidedAt: now,
        verificationDeciderUserId: principal.id,
        status: "ABANDONED",
      },
    });
    if (applied.count === 0) {
      const current = await tx.signupRegistration.findUnique({
        where: { id: registrationId },
        select: { verificationVerdict: true },
      });
      return { noop: true as const, verdict: current?.verificationVerdict ?? null };
    }
    const row = await tx.operatorVerificationRecord.create({
      data: {
        signupRegistrationId: registrationId,
        concept: "REJECT",
        finding: "REJECTED",
        evidenceSource: "operator-reject",
        evidenceProvenance: null,
        evidenceReference: null,
        reason: input.reason,
        operatorUserId: principal.id,
        operatorIp: input.operatorIp ?? null,
        operatorUserAgent: input.operatorUserAgent ?? null,
        verifiedAt: now,
        expiresAt: null,
      },
      select: { id: true },
    });
    return { noop: false as const, verdict: "REJECT" as const, recordId: row.id };
  });

  if (!result.noop) {
    await audit(principal, {
      action: "signup.operator.rejected",
      entityType: "SignupRegistration",
      entityId: registrationId,
      clubId: null,
      meta: {
        registrationIdTail: registrationId.slice(-6),
        operatorUserIdTail: principal.id.slice(-6),
        rejectRecordIdTail: result.recordId.slice(-6),
        reasonLength: input.reason.length,
      },
    });
    logger.info("signup.operator.rejected", {
      registrationIdTail: registrationId.slice(-6),
      operatorUserIdTail: principal.id.slice(-6),
    });
  }

  return result;
}

/** Queue read.  Returns up to `limit` oldest HOLD_FOR_REVIEW
 *  registrations with the latest concept records attached. */
export async function readOperatorQueue(limit = 50) {
  const regs = await prisma.signupRegistration.findMany({
    where: { verificationVerdict: "HOLD_FOR_REVIEW" },
    orderBy: { verificationDecidedAt: "asc" },
    take: Math.max(1, Math.min(200, limit)),
    select: {
      id: true,
      legalName: true,
      operatingName: true,
      country: true,
      provinceState: true,
      verificationHoldCategory: true,
      verificationDecidedAt: true,
      createdAt: true,
    },
  });
  // Attach latest STANDING + AUTHORITY per registration.
  const ids = regs.map((r) => r.id);
  const records = ids.length
    ? await prisma.operatorVerificationRecord.findMany({
        where: {
          signupRegistrationId: { in: ids },
          concept: { in: ["STANDING", "AUTHORITY"] },
        },
        orderBy: { createdAt: "desc" },
        select: {
          signupRegistrationId: true,
          concept: true,
          operatorUserId: true,
          createdAt: true,
          expiresAt: true,
          finding: true,
        },
      })
    : [];
  const latestByRegConcept = new Map<string, typeof records[number]>();
  for (const r of records) {
    const key = `${r.signupRegistrationId}:${r.concept}`;
    if (!latestByRegConcept.has(key)) latestByRegConcept.set(key, r);
  }
  return regs.map((r) => {
    const stand = latestByRegConcept.get(`${r.id}:STANDING`) ?? null;
    const auth = latestByRegConcept.get(`${r.id}:AUTHORITY`) ?? null;
    return { registration: r, standingLatest: stand, authorityLatest: auth };
  });
}

/** Compute the display state the UI should render for a registration. */
export function computeQueueState(args: {
  verdict: string | null;
  holdCategory: string | null;
  standingVerified: boolean;
  authorityVerified: boolean;
}): string {
  if (args.verdict === "PASS_AUTOMATED") return "RELEASED";
  if (args.verdict === "REJECT") return "REJECTED";
  if (args.holdCategory === "SUSPECTED_IMPERSONATION") return "SUSPECTED_IMPERSONATION";
  if (args.holdCategory === "CONFLICTING_EVIDENCE") return "CONFLICTING_EVIDENCE";
  if (args.holdCategory === "INSUFFICIENT_EVIDENCE") return "INSUFFICIENT_EVIDENCE";
  if (args.standingVerified && args.authorityVerified) return "READY_FOR_RELEASE";
  if (args.holdCategory === "SIGNING_AUTHORITY_VERIFICATION" || !args.authorityVerified) {
    return args.standingVerified ? "AWAITING_AUTHORITY" : "AWAITING_STANDING";
  }
  if (args.holdCategory === "ENTITY_VERIFICATION" || !args.standingVerified) return "AWAITING_STANDING";
  return "AWAITING_STANDING";
}
