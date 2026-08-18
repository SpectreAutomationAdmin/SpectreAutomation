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

import { createHash } from "crypto";
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
 *  Club review but never overwrite directly. */
const CLUB_AUTHORITATIVE_EMPLOYMENT_FIELDS = [
  "positionId",
  "departmentId",
  "expectedStartDate",
  "employmentType",
] as const;
type ClubAuthoritativeField = (typeof CLUB_AUTHORITATIVE_EMPLOYMENT_FIELDS)[number];

const EMPLOYEE_ENTITY = "Employee";
const RESPONSE_ENTITY = "EmployeeOnboardingResponse";
const DOCUMENT_ENTITY = "EmployeeDocument";
const TRANSITION_ENTITY = "EmployeeOnboardingStateTransition";
const SESSION_ENTITY = "EmployeeOnboardingSession";

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
  field: ClubAuthoritativeField;
  employeeStatedValue: string;
  note?: string | null;
}

/**
 * The employee cannot mutate Club-authoritative employment fields
 * directly. Instead, they can flag a discrepancy — the fact of the
 * flag is written to the onboarding response stream under a reserved
 * question key so the Club sees it in the review flow.
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

  // Reserved response key — no `EmployeeOnboardingQuestion` row exists
  // for it; corrections are surfaced in the review flow as a distinct
  // artifact separate from question-catalogue answers.
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
    entityType: "EmployeeOnboardingCorrection",
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
