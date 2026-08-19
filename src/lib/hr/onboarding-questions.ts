// HR-1 (2026-08-16) — EmployeeOnboardingQuestion catalogue service.
//
// This file is the ONE and ONLY place in src/** allowed to touch
// `prisma.employeeOnboardingQuestion.find*`. The pin test at
// `tests/hr/onboarding-question-canonical-reader.test.ts` enforces
// that rule with a source-scan.
//
// Why? The model has a NULLABLE clubId column so a single row can
// serve every club as a global default. A club-specific row
// (clubId=<id>) OVERRIDES the global by shared `key`. Every caller
// MUST go through `resolveEffectiveQuestions(clubId)` — a raw
// findMany would return unmerged rows and produce the wrong question
// set.
//
// Writes:
//   - `upsertOnboardingQuestion(principal, {clubId, key, ...})` accepts
//     `clubId: string | null`.
//   - Club-scoped writes require `hr:onboarding_questions:write`.
//   - Global writes (`clubId === null`) require BOTH the same
//     capability AND `isSuperAdmin(principal)`. Non-super-admin
//     callers passing `clubId: null` get a ForbiddenError before any
//     DB write.
//
// Reads:
//   - `resolveEffectiveQuestions(clubId)` merges globals + club-
//     specific rows; club-specific wins by `key`.
//   - `getQuestion(principal, id)` returns a single row with tenant
//     enforcement (a global row is readable by anyone with the
//     `hr:onboarding_questions:read` capability at their scope; a
//     club-scoped row requires the caller has access to that club).
//   - `listGlobalQuestions()` and `listClubQuestions(clubId)` are
//     helpers used by the admin catalogue UI; they DELIBERATELY do
//     not merge (the UI needs to see which rows are global vs local).

import { prisma } from "../prisma";
import { audit } from "../audit";
import { hasPermission, isSuperAdmin, requirePermission, type Principal } from "../rbac";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { assertSensitiveActionAllowed } from "../posting-guard";

const QUESTION_ENTITY = "EmployeeOnboardingQuestion";

// Allowed answerKind values. Kept in sync with the schema comment.
const ANSWER_KINDS = [
  "TEXT",
  "LONG_TEXT",
  "EMAIL",
  "PHONE",
  "DATE",
  "NUMBER",
  "BOOLEAN",
  "SINGLE_CHOICE",
  "MULTI_CHOICE",
  "FILE_UPLOAD",
  "SIGNATURE",
] as const;
export type AnswerKind = (typeof ANSWER_KINDS)[number];

// ---------------------------------------------------------------------------
// Effective-question resolver — THE canonical reader.
// ---------------------------------------------------------------------------
export interface EffectiveQuestion {
  id: string;
  clubId: string | null;
  key: string;
  section: string;
  prompt: string;
  helpText: string | null;
  answerKind: string;
  required: boolean;
  optionsJson: string | null;
  displayOrder: number;
  active: boolean;
  /** True when this row was resolved from a club-specific override,
   *  false when it came from the global catalogue. */
  isClubOverride: boolean;
}

/**
 * Return the effective set of onboarding questions for the given
 * club:
 *   - Every ACTIVE global row (clubId IS NULL).
 *   - Every ACTIVE club-specific row where clubId matches.
 * Club-specific rows OVERRIDE globals with the same `key`.
 *
 * Ordering: stable — by (displayOrder ASC, key ASC).
 */
export async function resolveEffectiveQuestions(
  clubId: string,
): Promise<EffectiveQuestion[]> {
  if (typeof clubId !== "string" || clubId.length === 0) {
    throw new ValidationError([{ path: "clubId", message: "clubId is required" }]);
  }
  const rows = await prisma.employeeOnboardingQuestion.findMany({
    where: {
      active: true,
      OR: [{ clubId: null }, { clubId }],
    },
  });
  // Merge: club-specific wins on key match.
  const byKey = new Map<string, EffectiveQuestion>();
  // Insert globals first so club-specific overrides land on top.
  for (const r of rows.filter((row) => row.clubId === null)) {
    byKey.set(r.key, toEffective(r, false));
  }
  for (const r of rows.filter((row) => row.clubId === clubId)) {
    byKey.set(r.key, toEffective(r, true));
  }
  const merged = Array.from(byKey.values());
  merged.sort((a, b) => {
    if (a.displayOrder !== b.displayOrder) return a.displayOrder - b.displayOrder;
    return a.key.localeCompare(b.key);
  });
  return merged;
}

function toEffective(
  r: {
    id: string; clubId: string | null; key: string; section: string;
    prompt: string; helpText: string | null; answerKind: string;
    required: boolean; optionsJson: string | null; displayOrder: number;
    active: boolean;
  },
  isClubOverride: boolean,
): EffectiveQuestion {
  return {
    id: r.id,
    clubId: r.clubId,
    key: r.key,
    section: r.section,
    prompt: r.prompt,
    helpText: r.helpText,
    answerKind: r.answerKind,
    required: r.required,
    optionsJson: r.optionsJson,
    displayOrder: r.displayOrder,
    active: r.active,
    isClubOverride,
  };
}

// ---------------------------------------------------------------------------
// Internal (cross-service) row fetch — no principal / permission
// gating. Callers inside src/lib/hr/** that need to validate a
// question's tenancy (e.g. `onboarding-responses.submitResponse`)
// consume this rather than a raw prisma read, so the canonical-
// reader pin test still catches raw reads elsewhere in the code
// base.
// ---------------------------------------------------------------------------
export async function findQuestionById(questionId: string) {
  return prisma.employeeOnboardingQuestion.findUnique({ where: { id: questionId } });
}

// ---------------------------------------------------------------------------
// Single-row read.
// ---------------------------------------------------------------------------
export async function getQuestion(
  principal: Principal,
  questionId: string,
) {
  const row = await prisma.employeeOnboardingQuestion.findUnique({ where: { id: questionId } });
  if (!row) throw new NotFoundError(QUESTION_ENTITY, questionId);

  if (row.clubId === null) {
    // Global rows: any caller with the read capability at ANY scope
    // (including super-admin globally) may see them.
    if (!isSuperAdmin(principal)) {
      const scopedClubs = principal.memberships
        .map((m) => m.clubId)
        .filter((c): c is string => !!c);
      const anyGrant = scopedClubs.some((cid) =>
        hasPermission(principal, cid, "hr:onboarding_questions:read"),
      );
      if (!anyGrant) throw new ForbiddenError("Missing permission: hr:onboarding_questions:read");
    }
    return row;
  }

  // Club-scoped row: standard tenant + capability check.
  requirePermission(principal, row.clubId, "hr:onboarding_questions:read");
  if (!isSuperAdmin(principal)) {
    if (!principal.memberships.some((m) => m.clubId === row.clubId)) {
      throw new ForbiddenError("Missing club access");
    }
  }
  return row;
}

// Admin-UI helpers. Deliberately do NOT merge — the catalogue view
// needs to distinguish global vs club-specific.
export async function listGlobalQuestions(principal: Principal) {
  // Global rows are visible to any caller with the read capability
  // at some scope. Super-admin sees them unconditionally.
  if (!isSuperAdmin(principal)) {
    const scopedClubs = principal.memberships
      .map((m) => m.clubId)
      .filter((c): c is string => !!c);
    const anyGrant = scopedClubs.some((cid) =>
      hasPermission(principal, cid, "hr:onboarding_questions:read"),
    );
    if (!anyGrant) throw new ForbiddenError("Missing permission: hr:onboarding_questions:read");
  }
  return prisma.employeeOnboardingQuestion.findMany({
    where: { clubId: null },
    orderBy: [{ displayOrder: "asc" }, { key: "asc" }],
  });
}

export async function listClubQuestions(principal: Principal, clubId: string) {
  requirePermission(principal, clubId, "hr:onboarding_questions:read");
  return prisma.employeeOnboardingQuestion.findMany({
    where: { clubId },
    orderBy: [{ displayOrder: "asc" }, { key: "asc" }],
  });
}

// ---------------------------------------------------------------------------
// Write.
// ---------------------------------------------------------------------------
export interface UpsertQuestionInput {
  clubId: string | null;
  key: string;
  section: string;
  prompt: string;
  helpText?: string | null;
  answerKind: AnswerKind | string;
  required?: boolean;
  optionsJson?: string | null;
  displayOrder?: number;
  active?: boolean;
}

/**
 * Create or update an onboarding question. Uniqueness key is
 * (clubId, key). Global writes (clubId === null) require BOTH the
 * capability AND super-admin.
 */
export async function upsertOnboardingQuestion(
  principal: Principal,
  input: UpsertQuestionInput,
) {
  const { clubId, key } = input;

  if (typeof key !== "string" || key.length === 0) {
    throw new ValidationError([{ path: "key", message: "key is required" }]);
  }
  if (typeof input.section !== "string" || input.section.length === 0) {
    throw new ValidationError([{ path: "section", message: "section is required" }]);
  }
  if (typeof input.prompt !== "string" || input.prompt.length === 0) {
    throw new ValidationError([{ path: "prompt", message: "prompt is required" }]);
  }
  if (!(ANSWER_KINDS as readonly string[]).includes(input.answerKind)) {
    throw new ValidationError([{
      path: "answerKind",
      message: `answerKind must be one of ${(ANSWER_KINDS as readonly string[]).join(", ")}`,
    }]);
  }

  if (clubId === null) {
    // Global write path — super-admin only.
    if (!isSuperAdmin(principal)) {
      throw new ForbiddenError("Global onboarding questions require super-admin");
    }
    // Also require the write capability (super-admin has everything,
    // but this documents the intent).
    // We check at the caller's active club so requirePermission has
    // a scope; super-admin short-circuits. Fall back to the platform-
    // global check if the principal has no scoped club (rare).
    const scopeForCheck = principal.activeClubId ?? null;
    if (scopeForCheck) {
      requirePermission(principal, scopeForCheck, "hr:onboarding_questions:write");
    }
    // Sensitive-action guard needs SOME clubId; use the caller's
    // active club when available, else this is genuinely a global
    // super-admin write and no tenant to log against.
    const guardClub = principal.activeClubId ?? null;
    if (guardClub) {
      await assertSensitiveActionAllowed(
        principal,
        guardClub,
        "hr.onboarding.question.update",
        QUESTION_ENTITY,
        `${key}@global`,
      );
    }
  } else {
    // Club-scoped write.
    requirePermission(principal, clubId, "hr:onboarding_questions:write");
    await assertSensitiveActionAllowed(
      principal,
      clubId,
      "hr.onboarding.question.update",
      QUESTION_ENTITY,
      `${key}@${clubId}`,
    );
  }

  const existing = await prisma.employeeOnboardingQuestion.findFirst({
    where: { clubId, key },
  });

  const data = {
    section: input.section,
    prompt: input.prompt,
    helpText: input.helpText ?? null,
    answerKind: input.answerKind,
    required: input.required ?? false,
    optionsJson: input.optionsJson ?? null,
    displayOrder: input.displayOrder ?? 0,
    active: input.active ?? true,
  };

  const row = existing
    ? await prisma.employeeOnboardingQuestion.update({
        where: { id: existing.id },
        data,
      })
    : await prisma.employeeOnboardingQuestion.create({
        data: { clubId, key, ...data },
      });

  await audit(principal, {
    action: "hr.onboarding.question.update",
    entityType: QUESTION_ENTITY,
    entityId: row.id,
    clubId: clubId ?? null,
    before: existing
      ? {
          key: existing.key,
          section: existing.section,
          prompt: existing.prompt,
          answerKind: existing.answerKind,
          required: existing.required,
          active: existing.active,
        }
      : null,
    after: {
      key: row.key,
      section: row.section,
      prompt: row.prompt,
      answerKind: row.answerKind,
      required: row.required,
      active: row.active,
      scope: clubId === null ? "global" : "club",
    },
  });

  return row;
}
