// HR-2B.2 (2026-08-18) — Employee self-service surface.
//
// This is the ONLY module in `src/lib/hr/**` whose mutations gate on
// `EmployeeOnboardingActor` instead of an administrative `Principal`.
// Every function here is a narrow, purpose-built operation the invited
// employee may perform on their OWN onboarding record.
//
// Design rules (enforced by tests):
//   • Every mutation calls `assertActorTargetsSelf` before touching
//     the DB, even when the target is derived from `actor.employeeId`.
//   • Every mutation loads its target row via a `clubId` + `id`
//     filter (never `findUnique` on id alone) so a cross-tenant cookie
//     transplant cannot address another club's rows even in the
//     theoretical case the id was leaked.
//   • Every mutation audits with `actor=null` (there is no
//     Principal), `actorSource=EMPLOYEE`, `actorEmployeeId=actor.employeeId`.
//     The audit meta payload carries actor provenance for forensics.
//   • The set of allowed identity fields is a hardcoded allowlist.
//     Anything else — compensation, payRate, status, employeeLifecycle,
//     onboardingState, payrollReadiness, hireDate, employeeNumber,
//     employmentType, activatedAt, terminationDate — is rejected at
//     the type + runtime layer.
//   • The employee CANNOT transition to APPROVED / REJECTED /
//     SUBMITTED via this module. The one transition permitted here is
//     INVITED → IN_PROGRESS, which fires implicitly on the first real
//     employee action (see `transitionSelfSessionToInProgress`).
//     SUBMITTED lives in HR-2B.5; APPROVED / REJECTED are staff-only.

import { createHash, randomUUID } from "crypto";
import { prisma } from "../prisma";
import { audit } from "../audit";
import {
  assertActorTargetsOwnClub,
  assertActorTargetsSelf,
  type EmployeeOnboardingActor,
} from "./employee-actor";
import {
  isKnownCategory,
  isSensitiveCategory,
} from "./documents";
import { resolveDocumentStorage } from "../documents/storage";
import { AppError, ConflictError, NotFoundError, ValidationError } from "../errors";
import { encryptSecret } from "../kms";
import { maskBankAccount, maskSin } from "../masking";

// ---------------------------------------------------------------------------
// Vocabulary.
// ---------------------------------------------------------------------------
/** Employee-writable Employee columns during onboarding. Everything
 *  NOT on this list is refused — compensation, payroll, status,
 *  lifecycle, employment terms, dates. */
const SELF_WRITABLE_IDENTITY_FIELDS = [
  "firstName",
  "middleName",
  "lastName",
  "preferredName",
  "personalEmail",
  "mobilePhone",
] as const;
type SelfWritableIdentityField = (typeof SELF_WRITABLE_IDENTITY_FIELDS)[number];

/** Club-authoritative employment fields the employee may FLAG for
 *  Club review but never overwrite directly. The values here are the
 *  canonical field identifiers persisted on `EmployeeOnboardingCorrection.field`
 *  — HR-2B.5's review UI reads them verbatim. */
export const CLUB_AUTHORITATIVE_EMPLOYMENT_FIELDS = [
  "positionId",
  "departmentId",
  "expectedStartDate",
  "employmentType",
] as const;
export type ClubAuthoritativeField = (typeof CLUB_AUTHORITATIVE_EMPLOYMENT_FIELDS)[number];

/** Vocabulary for `EmployeeOnboardingAcknowledgement.kind`.
 *  HR-2B.3 adds the two TD1 attestations.
 *  HR-2B.3.3 (2026-08-18) adds two About You step acknowledgements —
 *  these replace the prior implicit inference from optional
 *  identity fields (`preferredName`, `personalEmail`) which
 *  previously caused the /about-you/complete → Continue-to-payroll
 *  backward-nav bug: the resolver treated `preferredName=null` as
 *  "Name step not done" even though the employee had explicitly
 *  posted the Name form. The ack row is the SINGLE canonical signal. */
export const ONBOARDING_ACKNOWLEDGEMENT_KINDS = [
  "about_you_name_confirmation",
  "about_you_contact_confirmation",
  "employment_confirmation",
  "td1_federal_attestation",
  "td1_provincial_attestation",
] as const;
export type OnboardingAcknowledgementKind = (typeof ONBOARDING_ACKNOWLEDGEMENT_KINDS)[number];

const EMPLOYEE_ENTITY = "Employee";
const RESPONSE_ENTITY = "EmployeeOnboardingResponse";
const DOCUMENT_ENTITY = "EmployeeDocument";
const TRANSITION_ENTITY = "EmployeeOnboardingStateTransition";
const SESSION_ENTITY = "EmployeeOnboardingSession";
const ACKNOWLEDGEMENT_ENTITY = "EmployeeOnboardingAcknowledgement";
const CORRECTION_ENTITY = "EmployeeOnboardingCorrection";

// ---------------------------------------------------------------------------
// Typed error — refuse write attempts on fields outside the allowlist.
// ---------------------------------------------------------------------------
export class EmployeeSelfWriteForbiddenFieldError extends AppError {
  constructor(field: string) {
    super(
      "HR_EMPLOYEE_SELF_FORBIDDEN_FIELD",
      `Field ${field} is not employee-writable`,
      403,
      "Not permitted",
    );
  }
}

// ---------------------------------------------------------------------------
// Reads.
// ---------------------------------------------------------------------------
/**
 * Return the (safe) view of the employee's own record. Includes the
 * Club-authoritative employment fields for confirmation in the About
 * You flow, plus the current photo pointer. Deliberately excludes
 * compensation, payroll fields, and any sensitive column.
 */
export async function getSelfEmployee(actor: EmployeeOnboardingActor) {
  const row = await prisma.employee.findFirst({
    where: { id: actor.employeeId, clubId: actor.clubId },
    select: {
      id: true,
      clubId: true,
      firstName: true,
      middleName: true,
      lastName: true,
      preferredName: true,
      personalEmail: true,
      mobilePhone: true,
      expectedStartDate: true,
      employmentType: true,
      profilePhotoDocumentId: true,
      department: { select: { id: true, name: true } },
      position: { select: { id: true, name: true } },
      club: { select: { id: true, name: true } },
    },
  });
  if (!row) throw new NotFoundError(EMPLOYEE_ENTITY, actor.employeeId);
  assertActorTargetsSelf(actor, row.id);
  assertActorTargetsOwnClub(actor, row.clubId);
  return row;
}

/**
 * Return the employee's own onboarding session with light metadata for
 * the progress rail. Read-only — no state changes.
 */
export async function getSelfSession(actor: EmployeeOnboardingActor) {
  const row = await prisma.employeeOnboardingSession.findFirst({
    where: { id: actor.sessionId, employeeId: actor.employeeId, clubId: actor.clubId },
    select: {
      id: true,
      state: true,
      startedAt: true,
      submittedAt: true,
    },
  });
  if (!row) throw new NotFoundError(SESSION_ENTITY, actor.sessionId);
  return row;
}

/**
 * Return the employee's own onboarding responses (all statuses).
 */
export async function listSelfResponses(actor: EmployeeOnboardingActor) {
  return prisma.employeeOnboardingResponse.findMany({
    where: {
      sessionId: actor.sessionId,
      clubId: actor.clubId,
    },
    orderBy: { createdAt: "asc" },
  });
}

// ---------------------------------------------------------------------------
// Identity update — narrow allowlist.
// ---------------------------------------------------------------------------
export type SelfIdentityPatch = Partial<Record<SelfWritableIdentityField, string | null>>;

/**
 * Update employee-writable identity fields. Refuses any key outside
 * `SELF_WRITABLE_IDENTITY_FIELDS`. Refuses attempts to touch
 * compensation, employment terms, or lifecycle state.
 *
 * Empty-string values are normalised to `null` (except firstName /
 * lastName which must remain non-empty).
 */
export async function updateSelfIdentity(
  actor: EmployeeOnboardingActor,
  patch: SelfIdentityPatch,
): Promise<void> {
  // Refuse unknown keys BEFORE the DB read so a probe attempt on a
  // sensitive field never even touches the row.
  for (const key of Object.keys(patch)) {
    if (!(SELF_WRITABLE_IDENTITY_FIELDS as readonly string[]).includes(key)) {
      throw new EmployeeSelfWriteForbiddenFieldError(key);
    }
  }
  const before = await getSelfEmployee(actor);

  const normalised: Record<string, string | null> = {};
  for (const key of Object.keys(patch) as SelfWritableIdentityField[]) {
    const raw = patch[key];
    const value = raw == null ? null : String(raw).trim();
    if (key === "firstName" || key === "lastName") {
      if (!value) {
        throw new ValidationError([{ path: key, message: `${key} is required` }]);
      }
      if (value.length > 200) {
        throw new ValidationError([{ path: key, message: `${key} must be under 200 characters` }]);
      }
      normalised[key] = value;
    } else if (key === "personalEmail") {
      const emailValue = value === "" ? null : value;
      if (emailValue !== null) {
        if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(emailValue)) {
          throw new ValidationError([{ path: key, message: "personalEmail must be a valid email address" }]);
        }
        if (emailValue.length > 320) {
          throw new ValidationError([{ path: key, message: "personalEmail is too long" }]);
        }
      }
      normalised[key] = emailValue;
    } else if (key === "mobilePhone") {
      const phone = value === "" ? null : value;
      if (phone !== null) {
        // Loose international-friendly guard — service layer stores whatever
        // the employee typed; formatting is a UI concern.
        if (phone.length > 40) {
          throw new ValidationError([{ path: key, message: "mobilePhone is too long" }]);
        }
      }
      normalised[key] = phone;
    } else {
      // middleName / preferredName — free text, nullable, length-capped.
      const text = value === "" ? null : value;
      if (text !== null && text.length > 200) {
        throw new ValidationError([{ path: key, message: `${key} must be under 200 characters` }]);
      }
      normalised[key] = text;
    }
  }

  await prisma.employee.update({
    where: { id: actor.employeeId },
    data: normalised,
  });

  await audit(null, {
    action: "hr.employee.write.update",
    entityType: EMPLOYEE_ENTITY,
    entityId: actor.employeeId,
    clubId: actor.clubId,
    before: pickBefore(before, Object.keys(normalised)),
    after: normalised,
    meta: {
      actorSource: "EMPLOYEE",
      actorEmployeeIdTail: actor.employeeId.slice(-8),
      onboardingSessionIdTail: actor.sessionId.slice(-8),
      invitationIdTail: actor.invitationId.slice(-8),
    },
  });
}

function pickBefore(row: Awaited<ReturnType<typeof getSelfEmployee>>, keys: string[]) {
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = (row as unknown as Record<string, unknown>)[k];
  return out;
}

// ---------------------------------------------------------------------------
// Employment-field correction request.
// ---------------------------------------------------------------------------
export interface EmploymentCorrectionRequest {
  /** The canonical employment field the employee is disputing. Must be
   *  one of `positionId` / `departmentId` / `expectedStartDate` /
   *  `employmentType`. The value here is persisted verbatim on
   *  `EmployeeOnboardingCorrection.field` so HR-2B.5's review UI can
   *  render per-field controls. */
   field: ClubAuthoritativeField;
  /** The value the employee believes is correct — free-text (e.g.
   *  "I was told my first day is September 21" or "Golf Shop
   *  Attendant"). Staff resolves this into the canonical FK during
   *  review, so no schema-level lookup is required at write time. */
  employeeStatedValue: string;
  /** Optional extra context. */
  note?: string | null;
}

/**
 * The employee cannot mutate Club-authoritative employment fields
 * directly. Instead, they flag one or more discrepancies — one
 * correction row per canonical field. Callers submitting multiple
 * fields (e.g. "position AND department are wrong") should call this
 * helper once per field so HR-2B.5's review UI can display each
 * flagged item independently.
 */
export async function flagEmploymentFieldForCorrection(
  actor: EmployeeOnboardingActor,
  req: EmploymentCorrectionRequest,
): Promise<void> {
  if (!(CLUB_AUTHORITATIVE_EMPLOYMENT_FIELDS as readonly string[]).includes(req.field)) {
    throw new ValidationError([{ path: "field", message: `Unknown club-authoritative field: ${req.field}` }]);
  }
  const stated = (req.employeeStatedValue ?? "").trim();
  if (!stated) {
    throw new ValidationError([{ path: "employeeStatedValue", message: "employeeStatedValue is required" }]);
  }
  if (stated.length > 500) {
    throw new ValidationError([{ path: "employeeStatedValue", message: "employeeStatedValue is too long" }]);
  }
  const note = req.note?.trim() ?? null;
  if (note !== null && note.length > 2000) {
    throw new ValidationError([{ path: "note", message: "note is too long" }]);
  }

  const created = await prisma.employeeOnboardingCorrection.create({
    data: {
      clubId: actor.clubId,
      sessionId: actor.sessionId,
      employeeId: actor.employeeId,
      field: req.field,
      employeeStatedValue: stated,
      note,
    },
  });
  await audit(null, {
    action: "hr.onboarding.correction.request.update",
    entityType: CORRECTION_ENTITY,
    entityId: created.id,
    clubId: actor.clubId,
    after: { field: req.field, employeeStatedValueLength: stated.length },
    meta: {
      actorSource: "EMPLOYEE",
      actorEmployeeIdTail: actor.employeeId.slice(-8),
      onboardingSessionIdTail: actor.sessionId.slice(-8),
    },
  });
}

// ---------------------------------------------------------------------------
// Employment acknowledgement.
// ---------------------------------------------------------------------------
/**
 * Persist an explicit "I confirm the Club-provided employment
 * information is correct" assertion by the employee. Idempotent —
 * subsequent calls update `acknowledgedAt` on the existing row (the
 * `sessionId + kind` unique index enforces one row per kind per
 * session). The progress rail reads this row directly rather than
 * inferring "employment done" from adjacent progress.
 */
// HR-2B.3.3 (2026-08-18) — Two About You step acknowledgements. Both
// follow the same shape as `acknowledgeSelfEmployment`: idempotent
// upsert on `(sessionId, kind)`, audit with EMPLOYEE actor
// provenance. See the ack-kind vocabulary comment above for the
// rationale — these replace the prior implicit inference from
// optional identity fields (which was the source of the
// /about-you/complete → Continue-to-payroll backward-navigation bug).

/** The employee posted the About You / Name form. Written by
 *  `saveNameAction` after `updateSelfIdentity` succeeds. */
export async function acknowledgeSelfNameStep(
  actor: EmployeeOnboardingActor,
): Promise<void> {
  await upsertAboutYouStepAck(actor, "about_you_name_confirmation");
}

/** The employee posted the About You / Contact form. Written by
 *  `saveContactAction` after `updateSelfIdentity` succeeds. */
export async function acknowledgeSelfContactStep(
  actor: EmployeeOnboardingActor,
): Promise<void> {
  await upsertAboutYouStepAck(actor, "about_you_contact_confirmation");
}

async function upsertAboutYouStepAck(
  actor: EmployeeOnboardingActor,
  kind: "about_you_name_confirmation" | "about_you_contact_confirmation",
): Promise<void> {
  const now = new Date();
  await prisma.employeeOnboardingAcknowledgement.upsert({
    where: { sessionId_kind: { sessionId: actor.sessionId, kind } },
    create: {
      clubId: actor.clubId,
      sessionId: actor.sessionId,
      employeeId: actor.employeeId,
      kind,
      actorEmployeeId: actor.employeeId,
      acknowledgedAt: now,
    },
    update: { acknowledgedAt: now, actorEmployeeId: actor.employeeId },
  });
  await audit(null, {
    action: "hr.onboarding.acknowledgement.update",
    entityType: ACKNOWLEDGEMENT_ENTITY,
    entityId: `${actor.sessionId}:${kind}`,
    clubId: actor.clubId,
    after: { kind, acknowledgedAt: now },
    meta: {
      actorSource: "EMPLOYEE",
      actorEmployeeIdTail: actor.employeeId.slice(-8),
      onboardingSessionIdTail: actor.sessionId.slice(-8),
    },
  });
}

export async function acknowledgeSelfEmployment(
  actor: EmployeeOnboardingActor,
): Promise<void> {
  const now = new Date();
  await prisma.employeeOnboardingAcknowledgement.upsert({
    where: {
      sessionId_kind: { sessionId: actor.sessionId, kind: "employment_confirmation" },
    },
    create: {
      clubId: actor.clubId,
      sessionId: actor.sessionId,
      employeeId: actor.employeeId,
      kind: "employment_confirmation",
      actorEmployeeId: actor.employeeId,
      acknowledgedAt: now,
    },
    update: {
      acknowledgedAt: now,
      actorEmployeeId: actor.employeeId,
    },
  });
  await audit(null, {
    action: "hr.onboarding.acknowledgement.update",
    entityType: ACKNOWLEDGEMENT_ENTITY,
    entityId: `${actor.sessionId}:employment_confirmation`,
    clubId: actor.clubId,
    after: { kind: "employment_confirmation", acknowledgedAt: now },
    meta: {
      actorSource: "EMPLOYEE",
      actorEmployeeIdTail: actor.employeeId.slice(-8),
      onboardingSessionIdTail: actor.sessionId.slice(-8),
    },
  });
}

/**
 * Read the durable employment acknowledgement, if any. Returns the
 * row or null. HR-2B.2's About You layout reads this to determine
 * the employment step's done state.
 */
export async function getEmploymentAcknowledgement(actor: EmployeeOnboardingActor) {
  return prisma.employeeOnboardingAcknowledgement.findFirst({
    where: {
      sessionId: actor.sessionId,
      clubId: actor.clubId,
      kind: "employment_confirmation",
    },
    select: { id: true, acknowledgedAt: true, actorEmployeeId: true },
  });
}

/**
 * List the employee's own employment-field corrections. Rows are
 * grouped by canonical field so HR-2B.5's review UI can render each
 * discrepancy independently.
 */
export async function listSelfEmploymentCorrections(actor: EmployeeOnboardingActor) {
  return prisma.employeeOnboardingCorrection.findMany({
    where: {
      sessionId: actor.sessionId,
      clubId: actor.clubId,
      field: { in: [...CLUB_AUTHORITATIVE_EMPLOYMENT_FIELDS] },
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      field: true,
      employeeStatedValue: true,
      note: true,
      resolvedAt: true,
      createdAt: true,
    },
  });
}

// ---------------------------------------------------------------------------
// Onboarding-response submission.
// ---------------------------------------------------------------------------
/**
 * Submit / update a response to a canonical onboarding question. The
 * question must be either global (clubId=null) OR scoped to the
 * employee's club. Refuses to write a COMPLETE row — approval is
 * staff-only. Rewrites of COMPLETE rows are refused.
 */
export async function submitSelfResponse(
  actor: EmployeeOnboardingActor,
  input: { questionId: string; responseJson: string },
) {
  if (typeof input.questionId !== "string" || input.questionId.length === 0) {
    throw new ValidationError([{ path: "questionId", message: "required" }]);
  }
  if (typeof input.responseJson !== "string") {
    throw new ValidationError([{ path: "responseJson", message: "must be a string (JSON payload)" }]);
  }
  if (input.responseJson.length > 200_000) {
    throw new ValidationError([{ path: "responseJson", message: "responseJson too large" }]);
  }

  const question = await prisma.employeeOnboardingQuestion.findUnique({
    where: { id: input.questionId },
    select: { id: true, clubId: true, active: true },
  });
  if (!question || !question.active) {
    throw new NotFoundError("EmployeeOnboardingQuestion", input.questionId);
  }
  if (question.clubId != null && question.clubId !== actor.clubId) {
    throw new ValidationError([{
      path: "questionId",
      message: "question does not belong to this club",
    }]);
  }

  const now = new Date();
  const row = await prisma.$transaction(async (tx) => {
    const existing = await tx.employeeOnboardingResponse.findUnique({
      where: {
        sessionId_questionId: {
          sessionId: actor.sessionId,
          questionId: input.questionId,
        },
      },
    });
    if (!existing) {
      const created = await tx.employeeOnboardingResponse.create({
        data: {
          clubId: actor.clubId,
          sessionId: actor.sessionId,
          questionId: input.questionId,
          status: "PENDING",
        },
      });
      return tx.employeeOnboardingResponse.update({
        where: { id: created.id },
        data: {
          responseJson: input.responseJson,
          answeredAt: now,
          status: "ANSWERED",
        },
      });
    }
    if (existing.status === "COMPLETE") {
      throw new ConflictError(
        `Cannot rewrite an approved response (id=${existing.id}) — Club must reset it first`,
      );
    }
    if (existing.clubId !== actor.clubId || existing.sessionId !== actor.sessionId) {
      // Belt-and-braces — the compound key already scopes this,
      // but a defence-in-depth check documents the invariant.
      throw new ConflictError("Cross-tenant response mismatch");
    }
    return tx.employeeOnboardingResponse.update({
      where: { id: existing.id },
      data: {
        responseJson: input.responseJson,
        answeredAt: now,
        status: "ANSWERED",
      },
    });
  });

  await audit(null, {
    action: "hr.onboarding.response.update",
    entityType: RESPONSE_ENTITY,
    entityId: row.id,
    clubId: actor.clubId,
    after: { id: row.id, status: row.status, questionId: row.questionId, sessionId: row.sessionId },
    meta: {
      actorSource: "EMPLOYEE",
      actorEmployeeIdTail: actor.employeeId.slice(-8),
      onboardingSessionIdTail: actor.sessionId.slice(-8),
    },
  });
  return row;
}

// ---------------------------------------------------------------------------
// Session transition — INVITED → IN_PROGRESS on first real action.
// ---------------------------------------------------------------------------
/**
 * Transition the employee's own session from INVITED to IN_PROGRESS.
 * Idempotent: if the session is already IN_PROGRESS, this is a no-op
 * (returns the current row); if it's in any other state, refuses.
 *
 * Called by the FIRST real employee action (first identity write or
 * first response), so the state transition aligns with actual employee
 * activity rather than firing on link open.
 */
export async function transitionSelfSessionToInProgress(actor: EmployeeOnboardingActor) {
  const session = await prisma.employeeOnboardingSession.findFirst({
    where: { id: actor.sessionId, employeeId: actor.employeeId, clubId: actor.clubId },
    select: { id: true, state: true },
  });
  if (!session) throw new NotFoundError(SESSION_ENTITY, actor.sessionId);
  if (session.state === "IN_PROGRESS") return session;
  if (session.state !== "INVITED") {
    throw new ConflictError(
      `Cannot transition session from ${session.state} to IN_PROGRESS via employee actor`,
    );
  }

  const now = new Date();
  const updated = await prisma.employeeOnboardingSession.update({
    where: { id: session.id },
    data: { state: "IN_PROGRESS" },
  });
  await prisma.employee.update({
    where: { id: actor.employeeId },
    data: { onboardingState: "IN_PROGRESS" },
  });
  const transition = await prisma.employeeOnboardingStateTransition.create({
    data: {
      clubId: actor.clubId,
      employeeId: actor.employeeId,
      sessionId: actor.sessionId,
      fromState: "INVITED",
      toState: "IN_PROGRESS",
      actorSource: "EMPLOYEE",
      actorEmployeeId: actor.employeeId,
      actorUserId: null,
      reason: null,
      at: now,
    },
  });
  await audit(null, {
    action: "hr.onboarding.state.update",
    entityType: TRANSITION_ENTITY,
    entityId: transition.id,
    clubId: actor.clubId,
    before: { state: "INVITED" },
    after: { state: "IN_PROGRESS", sessionId: actor.sessionId, transitionId: transition.id },
    meta: {
      actorSource: "EMPLOYEE",
      actorEmployeeIdTail: actor.employeeId.slice(-8),
    },
  });
  return updated;
}

// ---------------------------------------------------------------------------
// Photo upload.
// ---------------------------------------------------------------------------
export interface SelfPhotoUploadInput {
  bytes: Uint8Array | Buffer;
  mimeType: string;
  displayName?: string | null;
}

/**
 * Employee uploads their own profile photo. Persists to blob storage
 * via the canonical `resolveDocumentStorage({clubId})` adapter, creates
 * an EmployeeDocument row in category `profile_photo`, points
 * `Employee.profilePhotoDocumentId` at it. Any prior photo pointer is
 * replaced (the old document row remains for evidentiary purposes).
 *
 * Refuses any category the caller might attempt via a future overload;
 * this function ONLY writes `profile_photo`.
 */
export async function uploadSelfPhoto(
  actor: EmployeeOnboardingActor,
  input: SelfPhotoUploadInput,
) {
  const mimeType = (input.mimeType ?? "").trim().toLowerCase();
  if (!mimeType.startsWith("image/")) {
    throw new ValidationError([{ path: "mimeType", message: "photo must be an image" }]);
  }
  if (mimeType.length > 200) {
    throw new ValidationError([{ path: "mimeType", message: "mimeType too long" }]);
  }
  const bytes = Buffer.isBuffer(input.bytes) ? input.bytes : Buffer.from(input.bytes);
  if (bytes.length === 0) {
    throw new ValidationError([{ path: "bytes", message: "photo is empty" }]);
  }
  // Cap ~ 10 MiB — a shoulders-up photo has no legitimate need for
  // more, and this prevents an authenticated employee from filling
  // the Club's storage bucket.
  const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
  if (bytes.length > MAX_PHOTO_BYTES) {
    throw new ValidationError([{ path: "bytes", message: "photo exceeds 10 MiB limit" }]);
  }

  // Belt-and-braces: `profile_photo` MUST be a known non-sensitive
  // category. If the doc-category enum ever changes, this fails fast.
  if (!isKnownCategory("profile_photo")) {
    throw new AppError("HR_CATEGORY_ENUM_DRIFT", "profile_photo category missing", 500, "Server error");
  }
  if (isSensitiveCategory("profile_photo")) {
    throw new AppError("HR_CATEGORY_ENUM_DRIFT", "profile_photo unexpectedly sensitive", 500, "Server error");
  }

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const storage = await resolveDocumentStorage({ clubId: actor.clubId });
  const storageKey = `hr/employees/${actor.employeeId}/profile_photo/${sha256}`;
  await storage.put({ storageKey, body: bytes, mimeType });

  // Write the document row + photo pointer atomically so a crash
  // between the two can't leave `Employee.profilePhotoDocumentId`
  // pointing at a row we failed to create.
  const now = new Date();
  const result = await prisma.$transaction(async (tx) => {
    const employee = await tx.employee.findFirst({
      where: { id: actor.employeeId, clubId: actor.clubId },
      select: { id: true, profilePhotoDocumentId: true },
    });
    if (!employee) throw new NotFoundError(EMPLOYEE_ENTITY, actor.employeeId);
    const created = await tx.employeeDocument.create({
      data: {
        clubId: actor.clubId,
        employeeId: actor.employeeId,
        storageKey,
        contentSha256: sha256,
        sizeBytes: bytes.length,
        mimeType,
        category: "profile_photo",
        sensitivity: "STANDARD",
        displayName: input.displayName ?? null,
        uploadedByUserId: null,
        uploadedAt: now,
      },
    });
    const updated = await tx.employee.update({
      where: { id: actor.employeeId },
      data: { profilePhotoDocumentId: created.id },
      select: { id: true, profilePhotoDocumentId: true },
    });
    return { document: created, previousPhotoId: employee.profilePhotoDocumentId, employee: updated };
  });

  await audit(null, {
    action: "hr.document.upload.create",
    entityType: DOCUMENT_ENTITY,
    entityId: result.document.id,
    clubId: actor.clubId,
    after: {
      id: result.document.id,
      category: result.document.category,
      sensitivity: result.document.sensitivity,
      sizeBytes: result.document.sizeBytes,
      contentSha256Prefix: sha256.slice(0, 12),
    },
    meta: {
      actorSource: "EMPLOYEE",
      actorEmployeeIdTail: actor.employeeId.slice(-8),
      previousPhotoIdTail: result.previousPhotoId?.slice(-8) ?? null,
    },
  });
  await audit(null, {
    action: "hr.employee.write.update",
    entityType: EMPLOYEE_ENTITY,
    entityId: actor.employeeId,
    clubId: actor.clubId,
    before: { profilePhotoDocumentId: result.previousPhotoId },
    after: { profilePhotoDocumentId: result.document.id },
    meta: { actorSource: "EMPLOYEE" },
  });
  return result.document;
}

// ---------------------------------------------------------------------------
// HR-2B.3 (2026-08-19) — Sensitive payroll surface.
//
// SIN, direct-deposit banking, void-cheque supporting document, and
// federal/provincial TD1 profiles. Every function mirrors the
// canonical HR-1 service's encryption + audit shape (never delegates
// to a Principal-gated call) so the employee actor NEVER indirectly
// becomes a Principal. The plaintext never leaves the encrypt/persist
// scope; audit payloads carry only masked helpers or the "hasClaim"
// booleans; no sensitive value ever traverses a redirect URL, cookie,
// or server-render payload.
// ---------------------------------------------------------------------------

const SIN_ENTITY = "EmployeeSensitiveIdentity";
const BANK_ENTITY = "EmployeeBankAccount";
const TAX_ENTITY = "EmployeeTaxProfile";

// -- SIN --------------------------------------------------------------------

/**
 * Canadian SIN Luhn checksum. Reject 9-digit numbers that pass length
 * but fail the well-known validation rule. Applied after the digit-
 * strip so `123 456 782` and `123-456-782` reach the same result.
 * See CRA / Government of Canada SIN validation reference.
 */
function isValidSinChecksum(digits: string): boolean {
  if (!/^\d{9}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    const d = digits.charCodeAt(i) - 48;
    if (i % 2 === 0) {
      sum += d;
    } else {
      const doubled = d * 2;
      sum += doubled > 9 ? doubled - 9 : doubled;
    }
  }
  return sum % 10 === 0;
}

function normaliseSin(input: string): string {
  if (typeof input !== "string") {
    throw new ValidationError([{ path: "sin", message: "SIN must be a string" }]);
  }
  const stripped = input.replace(/[\s\-]/g, "");
  if (!/^\d{9}$/.test(stripped)) {
    throw new ValidationError([{
      path: "sin",
      message: "That doesn't look like a valid Social Insurance Number. Check the number and try again.",
    }]);
  }
  if (!isValidSinChecksum(stripped)) {
    // Employee-facing copy — deliberately generic; NEVER echoes the
    // entered SIN back into the error message (§7).
    throw new ValidationError([{
      path: "sin",
      message: "That doesn't look like a valid Social Insurance Number. Check the number and try again.",
    }]);
  }
  return stripped;
}

function sinKmsRef(employeeId: string) { return `sin:${employeeId}`; }

/**
 * Persist the employee's own SIN. Encrypts plaintext under KMS scope="HR",
 * stores ciphertext + sinLastThree ONLY. Audit carries only the masked
 * suffix; plaintext never enters the audit payload, error messages, or
 * any return value. Returns the masked helper only.
 */
export async function submitSelfSin(
  actor: EmployeeOnboardingActor,
  plaintextSin: string,
): Promise<{ sinMasked: string; sinLastThree: string }> {
  const normalised = normaliseSin(plaintextSin);
  const sinLastThree = normalised.slice(-3);

  const employee = await prisma.employee.findFirst({
    where: { id: actor.employeeId, clubId: actor.clubId },
    select: { id: true, clubId: true },
  });
  if (!employee) throw new NotFoundError(EMPLOYEE_ENTITY, actor.employeeId);
  assertActorTargetsSelf(actor, employee.id);
  assertActorTargetsOwnClub(actor, employee.clubId);

  const ciphertext = await encryptSecret({
    scope: "HR",
    secretReference: sinKmsRef(actor.employeeId),
    plaintext: normalised,
    clubId: actor.clubId,
    actorUserId: null,
  });

  const before = await prisma.employeeSensitiveIdentity.findUnique({
    where: { employeeId: actor.employeeId },
    select: { sinLastThree: true },
  });

  const updated = await prisma.employeeSensitiveIdentity.upsert({
    where: { employeeId: actor.employeeId },
    update: { sinSecretRef: ciphertext, sinLastThree },
    create: {
      clubId: actor.clubId,
      employeeId: actor.employeeId,
      sinSecretRef: ciphertext,
      sinLastThree,
    },
  });

  await audit(null, {
    action: "hr.sin.write.update",
    entityType: SIN_ENTITY,
    entityId: updated.id,
    clubId: actor.clubId,
    before: before ? { sinLastThree: before.sinLastThree } : null,
    after: { sinLastThree: updated.sinLastThree },
    meta: {
      actorSource: "EMPLOYEE",
      actorEmployeeIdTail: actor.employeeId.slice(-8),
      onboardingSessionIdTail: actor.sessionId.slice(-8),
    },
  });
  return { sinMasked: maskSin(sinLastThree), sinLastThree };
}

/**
 * Return the masked SIN ("XXX XXX 123") or null. Read-only, not audited.
 * The plaintext is NEVER rehydrated to the caller.
 */
export async function getSelfSinMasked(
  actor: EmployeeOnboardingActor,
): Promise<string | null> {
  const row = await prisma.employeeSensitiveIdentity.findFirst({
    where: { employeeId: actor.employeeId, clubId: actor.clubId },
    select: { sinLastThree: true },
  });
  if (!row || !row.sinLastThree) return null;
  return maskSin(row.sinLastThree);
}

/**
 * Clear the SIN on file. Used by the "Change SIN" replacement flow:
 * the UI clears the existing row, then the employee is presented with
 * a blank secure entry. The replacement `submitSelfSin` call then
 * writes the new value.
 */
export async function clearSelfSin(actor: EmployeeOnboardingActor): Promise<void> {
  const existing = await prisma.employeeSensitiveIdentity.findFirst({
    where: { employeeId: actor.employeeId, clubId: actor.clubId },
  });
  if (!existing) return;
  await prisma.employeeSensitiveIdentity.delete({ where: { employeeId: actor.employeeId } });
  await audit(null, {
    action: "hr.sin.write.delete",
    entityType: SIN_ENTITY,
    entityId: existing.id,
    clubId: actor.clubId,
    before: { sinLastThree: existing.sinLastThree },
    after: null,
    meta: { actorSource: "EMPLOYEE", actorEmployeeIdTail: actor.employeeId.slice(-8) },
  });
}

// -- Banking ----------------------------------------------------------------

const BANKING_NON_TERMINAL_STATUSES = ["PENDING_PENNY_TEST", "VERIFIED"] as const;

function bankInstitutionRef(employeeId: string) { return `bank:${employeeId}:institution`; }
function bankTransitRef(employeeId: string) { return `bank:${employeeId}:transit`; }
function bankAccountRef(employeeId: string) { return `bank:${employeeId}:account`; }

function normaliseDigitsExact(input: string, expected: number, field: string): string {
  if (typeof input !== "string") {
    throw new ValidationError([{ path: field, message: `${field} must be a string` }]);
  }
  const stripped = input.replace(/[\s\-]/g, "");
  if (!/^\d+$/.test(stripped)) {
    throw new ValidationError([{ path: field, message: `${field} must be digits only` }]);
  }
  if (stripped.length !== expected) {
    throw new ValidationError([{ path: field, message: `${field} must be exactly ${expected} digits` }]);
  }
  return stripped;
}

function normaliseDigitsRange(input: string, min: number, max: number, field: string): string {
  if (typeof input !== "string") {
    throw new ValidationError([{ path: field, message: `${field} must be a string` }]);
  }
  const stripped = input.replace(/[\s\-]/g, "");
  if (!/^\d+$/.test(stripped)) {
    throw new ValidationError([{ path: field, message: `${field} must be digits only` }]);
  }
  if (stripped.length < min || stripped.length > max) {
    throw new ValidationError([{ path: field, message: `${field} must be ${min}-${max} digits` }]);
  }
  return stripped;
}

export interface SelfBankAccountInput {
  holderName: string;
  institutionNumber: string;
  transitNumber: string;
  accountNumber: string;
}

/**
 * Submit / update the employee's direct-deposit banking.
 *
 * HR-1H history semantics mirrored EXACTLY (see bank-account.ts):
 *   • no current row → create fresh PENDING_PENNY_TEST.
 *   • current row PENDING_PENNY_TEST → update in place.
 *   • current row VERIFIED → move to INACTIVE + create NEW PENDING_PENNY_TEST.
 *
 * The employee CANNOT set status=VERIFIED — that is a
 * `hr:banking:approve` action, and this module never fabricates that
 * grant. The DB partial unique index enforces the invariant even if
 * the code drifted.
 */
export async function submitSelfBankAccount(
  actor: EmployeeOnboardingActor,
  input: SelfBankAccountInput,
): Promise<{ id: string; accountMasked: string; holderName: string; status: string }> {
  const employee = await prisma.employee.findFirst({
    where: { id: actor.employeeId, clubId: actor.clubId },
    select: { id: true, clubId: true },
  });
  if (!employee) throw new NotFoundError(EMPLOYEE_ENTITY, actor.employeeId);
  assertActorTargetsSelf(actor, employee.id);
  assertActorTargetsOwnClub(actor, employee.clubId);

  const institution = normaliseDigitsExact(input.institutionNumber, 3, "institutionNumber");
  const transit = normaliseDigitsExact(input.transitNumber, 5, "transitNumber");
  const account = normaliseDigitsRange(input.accountNumber, 7, 12, "accountNumber");
  const holderName = (input.holderName ?? "").trim();
  if (!holderName || holderName.length < 2) {
    throw new ValidationError([{ path: "holderName", message: "Please enter the name on the account (minimum 2 characters)." }]);
  }
  if (holderName.length > 200) {
    throw new ValidationError([{ path: "holderName", message: "holderName is too long" }]);
  }
  const accountLastFour = account.slice(-4);

  const before = await prisma.employeeBankAccount.findFirst({
    where: { employeeId: actor.employeeId, status: { in: [...BANKING_NON_TERMINAL_STATUSES] } },
    orderBy: { updatedAt: "desc" },
  });

  const institutionCipher = await encryptSecret({
    scope: "HR",
    secretReference: bankInstitutionRef(actor.employeeId),
    plaintext: institution,
    clubId: actor.clubId,
    actorUserId: null,
  });
  const transitCipher = await encryptSecret({
    scope: "HR",
    secretReference: bankTransitRef(actor.employeeId),
    plaintext: transit,
    clubId: actor.clubId,
    actorUserId: null,
  });
  const accountCipher = await encryptSecret({
    scope: "HR",
    secretReference: bankAccountRef(actor.employeeId),
    plaintext: account,
    clubId: actor.clubId,
    actorUserId: null,
  });

  const updated = await (async () => {
    if (!before) {
      return prisma.employeeBankAccount.create({
        data: {
          clubId: actor.clubId,
          employeeId: actor.employeeId,
          institutionSecretRef: institutionCipher,
          transitSecretRef: transitCipher,
          accountSecretRef: accountCipher,
          accountLastFour,
          holderName,
          status: "PENDING_PENNY_TEST",
        },
      });
    }
    if (before.status === "PENDING_PENNY_TEST") {
      return prisma.employeeBankAccount.update({
        where: { id: before.id },
        data: {
          institutionSecretRef: institutionCipher,
          transitSecretRef: transitCipher,
          accountSecretRef: accountCipher,
          accountLastFour,
          holderName,
        },
      });
    }
    // before.status === "VERIFIED" → history preservation.
    return prisma.$transaction(async (tx) => {
      await tx.employeeBankAccount.update({
        where: { id: before.id },
        data: { status: "INACTIVE" },
      });
      return tx.employeeBankAccount.create({
        data: {
          clubId: actor.clubId,
          employeeId: actor.employeeId,
          institutionSecretRef: institutionCipher,
          transitSecretRef: transitCipher,
          accountSecretRef: accountCipher,
          accountLastFour,
          holderName,
          status: "PENDING_PENNY_TEST",
        },
      });
    });
  })();

  await audit(null, {
    action: "hr.bank.write.update",
    entityType: BANK_ENTITY,
    entityId: updated.id,
    clubId: actor.clubId,
    before: before
      ? {
          accountLastFour: before.accountLastFour,
          holderName: before.holderName,
          status: before.status,
          replacedRowId: before.id !== updated.id ? before.id : null,
        }
      : null,
    after: {
      accountLastFour: updated.accountLastFour,
      holderName: updated.holderName,
      status: updated.status,
    },
    meta: {
      actorSource: "EMPLOYEE",
      actorEmployeeIdTail: actor.employeeId.slice(-8),
    },
  });

  return {
    id: updated.id,
    accountMasked: maskBankAccount(updated.accountLastFour ?? accountLastFour),
    holderName: updated.holderName,
    status: updated.status,
  };
}

export async function getSelfBankAccountMasked(actor: EmployeeOnboardingActor): Promise<
  | { id: string; accountMasked: string; holderName: string; status: string }
  | null
> {
  const row = await prisma.employeeBankAccount.findFirst({
    where: {
      employeeId: actor.employeeId,
      clubId: actor.clubId,
      status: { in: [...BANKING_NON_TERMINAL_STATUSES] },
    },
    orderBy: { updatedAt: "desc" },
  });
  if (!row || !row.accountLastFour) return null;
  return {
    id: row.id,
    accountMasked: maskBankAccount(row.accountLastFour),
    holderName: row.holderName,
    status: row.status,
  };
}

// -- Void cheque / direct-deposit supporting document ----------------------

export type SelfBankingDocumentCategory = "void_cheque" | "direct_deposit_form";

export interface SelfBankingDocumentInput {
  bytes: Uint8Array | Buffer;
  mimeType: string;
  category: SelfBankingDocumentCategory;
  displayName?: string | null;
}

const BANKING_DOC_ALLOWED_MIMES = new Set<string>([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/heif",
]);
const MAX_BANKING_DOC_BYTES = 15 * 1024 * 1024;

/**
 * Upload a banking supporting document (void cheque or completed direct-
 * deposit form). Sensitivity is auto-set to `RESTRICTED` via the
 * canonical `isSensitiveCategory` mapping — these documents will NOT
 * appear in ordinary employee-document reads.
 *
 * IMPORTANT: this is supporting evidence, NOT authoritative banking
 * data (see §9 / §14). Authoritative banking submission remains
 * `submitSelfBankAccount`. HR-2B.3 does NOT OCR the cheque.
 */
export async function uploadSelfBankingDocument(
  actor: EmployeeOnboardingActor,
  input: SelfBankingDocumentInput,
) {
  const mimeType = (input.mimeType ?? "").trim().toLowerCase();
  if (!BANKING_DOC_ALLOWED_MIMES.has(mimeType)) {
    throw new ValidationError([{
      path: "mimeType",
      message: "Please upload a PDF or image (JPG, PNG, or HEIC).",
    }]);
  }
  if (input.category !== "void_cheque" && input.category !== "direct_deposit_form") {
    throw new ValidationError([{
      path: "category",
      message: "Banking document category must be void_cheque or direct_deposit_form",
    }]);
  }
  if (!isKnownCategory(input.category)) {
    throw new AppError("HR_CATEGORY_ENUM_DRIFT", "banking document category missing from canonical enum", 500, "Server error");
  }
  if (!isSensitiveCategory(input.category)) {
    throw new AppError("HR_CATEGORY_ENUM_DRIFT", "banking document unexpectedly non-sensitive", 500, "Server error");
  }
  const bytes = Buffer.isBuffer(input.bytes) ? input.bytes : Buffer.from(input.bytes);
  if (bytes.length === 0) {
    throw new ValidationError([{ path: "bytes", message: "The uploaded file is empty." }]);
  }
  if (bytes.length > MAX_BANKING_DOC_BYTES) {
    throw new ValidationError([{ path: "bytes", message: "File exceeds 15 MB limit." }]);
  }

  const employee = await prisma.employee.findFirst({
    where: { id: actor.employeeId, clubId: actor.clubId },
    select: { id: true },
  });
  if (!employee) throw new NotFoundError(EMPLOYEE_ENTITY, actor.employeeId);

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const storage = await resolveDocumentStorage({ clubId: actor.clubId });
  const storageKey = `hr/employees/${actor.employeeId}/${input.category}/${sha256}`;
  await storage.put({ storageKey, body: bytes, mimeType });

  const created = await prisma.employeeDocument.create({
    data: {
      clubId: actor.clubId,
      employeeId: actor.employeeId,
      storageKey,
      contentSha256: sha256,
      sizeBytes: bytes.length,
      mimeType,
      category: input.category,
      sensitivity: "RESTRICTED",
      displayName: input.displayName ?? null,
      uploadedByUserId: null,
    },
  });

  await audit(null, {
    action: "hr.document.upload.create",
    entityType: DOCUMENT_ENTITY,
    entityId: created.id,
    clubId: actor.clubId,
    after: {
      id: created.id,
      category: created.category,
      sensitivity: created.sensitivity,
      sizeBytes: created.sizeBytes,
      contentSha256Prefix: sha256.slice(0, 12),
    },
    meta: {
      actorSource: "EMPLOYEE",
      actorEmployeeIdTail: actor.employeeId.slice(-8),
      onboardingSessionIdTail: actor.sessionId.slice(-8),
    },
  });
  return created;
}

/**
 * Return the most-recent banking supporting document for the actor's
 * session, if any. Returns non-sensitive metadata (no storageKey).
 */
export async function getSelfBankingDocument(actor: EmployeeOnboardingActor): Promise<
  | { id: string; category: string; uploadedAt: Date; sizeBytes: number; mimeType: string; displayName: string | null }
  | null
> {
  const row = await prisma.employeeDocument.findFirst({
    where: {
      employeeId: actor.employeeId,
      clubId: actor.clubId,
      category: { in: ["void_cheque", "direct_deposit_form"] },
    },
    orderBy: { uploadedAt: "desc" },
    select: {
      id: true, category: true, uploadedAt: true, sizeBytes: true, mimeType: true, displayName: true,
    },
  });
  return row;
}

// -- TD1 tax profile --------------------------------------------------------

export type TaxJurisdiction = "federal" | "provincial";

export interface SelfTaxProfileInput {
  /** ISO-3166-2 subdivision code (e.g. "AB"). Persisted to the row as
   *  the province of employment. */
  province: string;
  /** Form-version identifier from `td1-forms.ts`, e.g. "TD1-2026". */
  td1FormVersion: string;
  /** Applicable-from date (start of tax year, hire date, etc.). */
  effectiveFrom: Date | string;
  /** Fixed-2 decimal string for total federal claim amount. */
  federalClaim: string;
  /** Fixed-2 decimal string for total provincial claim amount. */
  provincialClaim: string;
  /** Optional additional per-pay deduction the employee requests. */
  additionalDeductions?: string | null;
}

function normaliseMoney(input: string, field: string): string {
  if (typeof input !== "string") {
    throw new ValidationError([{ path: field, message: `${field} must be a string` }]);
  }
  const trimmed = input.trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(trimmed)) {
    throw new ValidationError([{ path: field, message: `${field} must be a decimal amount` }]);
  }
  const num = Number(trimmed);
  if (!Number.isFinite(num)) {
    throw new ValidationError([{ path: field, message: `${field} is not a finite number` }]);
  }
  if (num < 0) {
    throw new ValidationError([{ path: field, message: `${field} must be zero or positive` }]);
  }
  return num.toFixed(2);
}

const TAX_PROVINCE_CODES = new Set([
  "AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT",
]);

/**
 * Persist the employee's own TD1 tax profile row for the given
 * effectiveFrom. Sensitive claim amounts are KMS-encrypted; the audit
 * payload carries province + td1FormVersion + effectiveFrom + a
 * `hasAdditionalDeductions` boolean — NEVER the dollar values.
 */
export async function submitSelfTaxProfile(
  actor: EmployeeOnboardingActor,
  input: SelfTaxProfileInput,
): Promise<{ id: string; province: string; td1FormVersion: string; effectiveFrom: Date }> {
  const employee = await prisma.employee.findFirst({
    where: { id: actor.employeeId, clubId: actor.clubId },
    select: { id: true, clubId: true },
  });
  if (!employee) throw new NotFoundError(EMPLOYEE_ENTITY, actor.employeeId);
  assertActorTargetsSelf(actor, employee.id);
  assertActorTargetsOwnClub(actor, employee.clubId);

  const province = (input.province ?? "").trim().toUpperCase();
  if (!TAX_PROVINCE_CODES.has(province)) {
    throw new ValidationError([{ path: "province", message: "Choose the province where you'll be working." }]);
  }
  const td1FormVersion = (input.td1FormVersion ?? "").trim();
  if (!td1FormVersion || td1FormVersion.length < 3) {
    throw new ValidationError([{ path: "td1FormVersion", message: "td1FormVersion is required" }]);
  }
  const effectiveFrom = input.effectiveFrom instanceof Date
    ? input.effectiveFrom
    : new Date(input.effectiveFrom);
  if (Number.isNaN(effectiveFrom.getTime())) {
    throw new ValidationError([{ path: "effectiveFrom", message: "effectiveFrom is not a valid date" }]);
  }

  const federalClaim = normaliseMoney(input.federalClaim, "federalClaim");
  const provincialClaim = normaliseMoney(input.provincialClaim, "provincialClaim");
  const additionalDeductions = input.additionalDeductions == null
    ? null
    : normaliseMoney(input.additionalDeductions, "additionalDeductions");

  const existing = await prisma.employeeTaxProfile.findFirst({
    where: { employeeId: actor.employeeId, effectiveFrom },
  });
  const rowId = existing?.id ?? randomUUID();

  const federalCipher = await encryptSecret({
    scope: "HR",
    secretReference: `tax:${rowId}:federal`,
    plaintext: federalClaim,
    clubId: actor.clubId,
    actorUserId: null,
  });
  const provincialCipher = await encryptSecret({
    scope: "HR",
    secretReference: `tax:${rowId}:provincial`,
    plaintext: provincialClaim,
    clubId: actor.clubId,
    actorUserId: null,
  });
  const additionalCipher = additionalDeductions == null
    ? null
    : await encryptSecret({
        scope: "HR",
        secretReference: `tax:${rowId}:additional`,
        plaintext: additionalDeductions,
        clubId: actor.clubId,
        actorUserId: null,
      });

  const beforeMasked = existing
    ? {
        province: existing.province,
        td1FormVersion: existing.td1FormVersion,
        effectiveFrom: existing.effectiveFrom,
        hasAdditionalDeductions: existing.additionalDeductionSecretRef != null,
      }
    : null;

  let row: { id: string; effectiveFrom: Date; province: string; td1FormVersion: string };
  if (existing) {
    const updated = await prisma.employeeTaxProfile.update({
      where: { id: existing.id },
      data: {
        province,
        td1FormVersion,
        federalClaimSecretRef: federalCipher,
        provincialClaimSecretRef: provincialCipher,
        additionalDeductionSecretRef: additionalCipher,
      },
    });
    row = { id: updated.id, effectiveFrom: updated.effectiveFrom, province: updated.province, td1FormVersion: updated.td1FormVersion };
  } else {
    const created = await prisma.employeeTaxProfile.create({
      data: {
        id: rowId,
        clubId: actor.clubId,
        employeeId: actor.employeeId,
        province,
        td1FormVersion,
        effectiveFrom,
        effectiveTo: null,
        federalClaimSecretRef: federalCipher,
        provincialClaimSecretRef: provincialCipher,
        additionalDeductionSecretRef: additionalCipher,
        notes: null,
      },
    });
    row = { id: created.id, effectiveFrom: created.effectiveFrom, province: created.province, td1FormVersion: created.td1FormVersion };
  }

  await audit(null, {
    action: "hr.tax.write.update",
    entityType: TAX_ENTITY,
    entityId: row.id,
    clubId: actor.clubId,
    before: beforeMasked,
    // No numeric claim values in audit payload — the generic redactor
    // does not cover these keys; keep the write path explicit.
    after: {
      province,
      td1FormVersion,
      effectiveFrom,
      hasAdditionalDeductions: additionalCipher != null,
    },
    meta: {
      actorSource: "EMPLOYEE",
      actorEmployeeIdTail: actor.employeeId.slice(-8),
      onboardingSessionIdTail: actor.sessionId.slice(-8),
    },
  });
  return row;
}

/** Non-sensitive tax profile metadata. Never returns claim amounts. */
export async function getSelfTaxProfileMasked(
  actor: EmployeeOnboardingActor,
  asOf: Date = new Date(),
): Promise<
  | {
      id: string;
      province: string;
      td1FormVersion: string;
      effectiveFrom: Date;
      hasAdditionalDeductions: boolean;
    }
  | null
> {
  const row = await prisma.employeeTaxProfile.findFirst({
    where: { employeeId: actor.employeeId, clubId: actor.clubId, effectiveFrom: { lte: asOf } },
    orderBy: { effectiveFrom: "desc" },
  });
  if (!row) return null;
  return {
    id: row.id,
    province: row.province,
    td1FormVersion: row.td1FormVersion,
    effectiveFrom: row.effectiveFrom,
    hasAdditionalDeductions: row.additionalDeductionSecretRef != null,
  };
}

// -- Attestations -----------------------------------------------------------

/**
 * Record the employee's federal or provincial TD1 attestation. Idempotent
 * per (sessionId, kind). Provenance carries actorEmployeeId.
 */
export async function attestSelfTd1(
  actor: EmployeeOnboardingActor,
  jurisdiction: TaxJurisdiction,
  td1FormVersion: string,
): Promise<void> {
  const kind: OnboardingAcknowledgementKind =
    jurisdiction === "federal" ? "td1_federal_attestation" : "td1_provincial_attestation";
  const now = new Date();
  await prisma.employeeOnboardingAcknowledgement.upsert({
    where: {
      sessionId_kind: { sessionId: actor.sessionId, kind },
    },
    create: {
      clubId: actor.clubId,
      sessionId: actor.sessionId,
      employeeId: actor.employeeId,
      kind,
      actorEmployeeId: actor.employeeId,
      acknowledgedAt: now,
    },
    update: {
      acknowledgedAt: now,
      actorEmployeeId: actor.employeeId,
    },
  });
  await audit(null, {
    action: "hr.onboarding.acknowledgement.update",
    entityType: ACKNOWLEDGEMENT_ENTITY,
    entityId: `${actor.sessionId}:${kind}`,
    clubId: actor.clubId,
    after: { kind, td1FormVersion, acknowledgedAt: now },
    meta: {
      actorSource: "EMPLOYEE",
      actorEmployeeIdTail: actor.employeeId.slice(-8),
    },
  });
}

/** Read TD1 attestation state for either jurisdiction. */
export async function getSelfTd1Attestation(
  actor: EmployeeOnboardingActor,
  jurisdiction: TaxJurisdiction,
) {
  const kind = jurisdiction === "federal" ? "td1_federal_attestation" : "td1_provincial_attestation";
  return prisma.employeeOnboardingAcknowledgement.findFirst({
    where: { sessionId: actor.sessionId, clubId: actor.clubId, kind },
    select: { id: true, acknowledgedAt: true, actorEmployeeId: true },
  });
}

// -- Payroll section canonical completion ----------------------------------

/**
 * Return the canonical payroll completion state for the actor's
 * onboarding session. Payroll is COMPLETE iff:
 *   • SIN is on file (row exists, sinLastThree populated).
 *   • Banking is on file in a non-terminal status.
 *   • Federal TD1 profile row exists.
 *   • Provincial TD1 profile row exists (implied by the single
 *     `EmployeeTaxProfile` row that carries both jurisdictions'
 *     claim amounts — HR-2B.3 combines them per Canadian TD1
 *     structure).
 *   • Federal TD1 attestation acknowledgement exists.
 *   • Provincial TD1 attestation acknowledgement exists.
 */
export async function getPayrollCompletion(actor: EmployeeOnboardingActor): Promise<{
  sin: boolean;
  banking: boolean;
  taxProfile: boolean;
  federalAttestation: boolean;
  provincialAttestation: boolean;
  bankingDocument: boolean;
  complete: boolean;
}> {
  const [sinRow, bankRow, taxRow, fedAtt, provAtt, docRow] = await Promise.all([
    prisma.employeeSensitiveIdentity.findFirst({
      where: { employeeId: actor.employeeId, clubId: actor.clubId },
      select: { sinLastThree: true },
    }),
    prisma.employeeBankAccount.findFirst({
      where: {
        employeeId: actor.employeeId,
        clubId: actor.clubId,
        status: { in: [...BANKING_NON_TERMINAL_STATUSES] },
      },
      select: { id: true },
    }),
    prisma.employeeTaxProfile.findFirst({
      where: { employeeId: actor.employeeId, clubId: actor.clubId },
      select: { id: true },
    }),
    prisma.employeeOnboardingAcknowledgement.findFirst({
      where: { sessionId: actor.sessionId, clubId: actor.clubId, kind: "td1_federal_attestation" },
      select: { id: true },
    }),
    prisma.employeeOnboardingAcknowledgement.findFirst({
      where: { sessionId: actor.sessionId, clubId: actor.clubId, kind: "td1_provincial_attestation" },
      select: { id: true },
    }),
    prisma.employeeDocument.findFirst({
      where: {
        employeeId: actor.employeeId,
        clubId: actor.clubId,
        category: { in: ["void_cheque", "direct_deposit_form"] },
      },
      select: { id: true },
    }),
  ]);
  const sin = Boolean(sinRow && sinRow.sinLastThree);
  const banking = Boolean(bankRow);
  const taxProfile = Boolean(taxRow);
  const federalAttestation = Boolean(fedAtt);
  const provincialAttestation = Boolean(provAtt);
  const bankingDocument = Boolean(docRow);
  const complete = sin && banking && taxProfile && federalAttestation && provincialAttestation;
  return { sin, banking, taxProfile, federalAttestation, provincialAttestation, bankingDocument, complete };
}
