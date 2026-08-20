// HR-2B.4 (2026-08-19) — Onboarding requirements canonical service.
//
// Owns:
//   * OnboardingRequirement CRUD (admin config surface)
//   * `resolveApplicableRequirements(clubId, employee)` — the canonical
//     resolver that picks the subset of ACTIVE requirements applicable
//     to the given employee's department / position.
//   * `checkRequirementFulfillment(requirement, employeeId, sessionId)` —
//     the canonical resolver for whether one requirement is satisfied
//     right now, queried through EXISTING canonical rows keyed on the
//     requirement `code`. No new fulfillment table.
//
// Applicability rule:
//   * `appliesToAll = true`               → every employee in the Club.
//   * employee.positionId ∈ appliesToPositionIds → applies.
//   * employee.departmentId ∈ appliesToDeptIds   → applies.
//   * otherwise                            → does NOT apply.
//
// Fulfillment queries:
//   * DOCUMENT_UPLOAD          → EmployeeDocument.category == documentCategory
//   * CREDENTIAL_WITH_EXPIRY   → EmployeeCredential.credentialCode == code
//                                (AND expiresAt != null when requireExpiry)
//   * CONFIRMATION_ONLY        → EmployeeOnboardingAcknowledgement
//                                with kind == `requirement_confirmation:<code>`
//
// Deactivating a requirement (active=false) NEVER destroys satisfied
// rows; it only stops the requirement appearing for NEW onboardings.

import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { assertTenantOwned } from "../services/tenant";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { assertSensitiveActionAllowed } from "../posting-guard";
import type { EmployeeOnboardingActor } from "./employee-actor";

const REQ_ENTITY = "OnboardingRequirement";

export const ONBOARDING_REQUIREMENT_KINDS = [
  "DOCUMENT_UPLOAD",
  "CREDENTIAL_WITH_EXPIRY",
  "CONFIRMATION_ONLY",
] as const;
export type OnboardingRequirementKind = (typeof ONBOARDING_REQUIREMENT_KINDS)[number];

export function isKnownRequirementKind(v: string): v is OnboardingRequirementKind {
  return (ONBOARDING_REQUIREMENT_KINDS as readonly string[]).includes(v);
}

/** Requirement-code prefix used to key confirmation-only acknowledgements
 *  in EmployeeOnboardingAcknowledgement.kind. */
export function confirmationAckKind(requirementCode: string): string {
  return `requirement_confirmation:${requirementCode}`;
}

function parseIdList(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch { return []; }
}

function stringifyIdList(ids: string[] | null | undefined): string | null {
  if (!ids || ids.length === 0) return null;
  return JSON.stringify(ids.filter((v) => typeof v === "string" && v.length > 0));
}

function normaliseCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9_]+/g, "_").slice(0, 40);
}

// ---------------------------------------------------------------------------
// Admin config: CRUD.
// ---------------------------------------------------------------------------

export interface CreateOnboardingRequirementInput {
  code: string;
  displayName: string;
  explanation?: string | null;
  kind: string;
  documentCategory?: string | null;
  appliesToAll?: boolean;
  appliesToDeptIds?: string[];
  appliesToPositionIds?: string[];
  required?: boolean;
  requireExpiry?: boolean;
  active?: boolean;
  displayOrder?: number;
}

export async function createOnboardingRequirement(
  principal: Principal,
  clubId: string,
  input: CreateOnboardingRequirementInput,
) {
  requirePermission(principal, clubId, "hr:employee:write");
  await assertSensitiveActionAllowed(
    principal, clubId, "hr.onboarding-requirement.write.update", REQ_ENTITY, "new",
  );

  const code = normaliseCode(input.code ?? "");
  const displayName = (input.displayName ?? "").trim();
  const kind = (input.kind ?? "").trim();
  if (!code) throw new ValidationError([{ path: "code", message: "required" }]);
  if (!displayName) throw new ValidationError([{ path: "displayName", message: "required" }]);
  if (!isKnownRequirementKind(kind)) {
    throw new ValidationError([{ path: "kind", message: `must be one of ${ONBOARDING_REQUIREMENT_KINDS.join(", ")}` }]);
  }
  const needsDocumentCategory = kind === "DOCUMENT_UPLOAD" || kind === "CREDENTIAL_WITH_EXPIRY";
  const documentCategory = (input.documentCategory ?? "").trim() || null;
  if (needsDocumentCategory && !documentCategory) {
    throw new ValidationError([{ path: "documentCategory", message: "required for DOCUMENT_UPLOAD and CREDENTIAL_WITH_EXPIRY" }]);
  }

  const appliesToAll = input.appliesToAll ?? false;
  const deptIds = input.appliesToDeptIds ?? [];
  const positionIds = input.appliesToPositionIds ?? [];
  if (!appliesToAll && deptIds.length === 0 && positionIds.length === 0) {
    throw new ValidationError([{
      path: "appliesTo",
      message: "requirement must be `appliesToAll` OR at least one dept/position",
    }]);
  }
  // Validate dept/position belong to same club.
  if (deptIds.length > 0) {
    const seen = await prisma.department.count({ where: { clubId, id: { in: deptIds } } });
    if (seen !== deptIds.length) {
      throw new ValidationError([{ path: "appliesToDeptIds", message: "one or more departments not found in this club" }]);
    }
  }
  if (positionIds.length > 0) {
    const seen = await prisma.employeePosition.count({ where: { clubId, id: { in: positionIds } } });
    if (seen !== positionIds.length) {
      throw new ValidationError([{ path: "appliesToPositionIds", message: "one or more positions not found in this club" }]);
    }
  }

  const created = await prisma.onboardingRequirement.create({
    data: {
      clubId,
      code,
      displayName,
      explanation: input.explanation ?? null,
      kind,
      documentCategory,
      appliesToAll,
      appliesToDeptIds: stringifyIdList(deptIds),
      appliesToPositionIds: stringifyIdList(positionIds),
      required: input.required ?? true,
      requireExpiry: input.requireExpiry ?? false,
      active: input.active ?? true,
      displayOrder: input.displayOrder ?? 0,
      createdByUserId: principal.id,
    },
  }).catch((err: { code?: string }) => {
    if (err && err.code === "P2002") throw new ConflictError(`Requirement code "${code}" already exists in this club`);
    throw err;
  });

  await audit(principal, {
    action: "hr.onboarding-requirement.write.update",
    entityType: REQ_ENTITY,
    entityId: created.id,
    clubId,
    after: {
      id: created.id, code: created.code, kind: created.kind,
      appliesToAll: created.appliesToAll, required: created.required, active: created.active,
    },
  });

  return created;
}

export interface UpdateOnboardingRequirementInput {
  displayName?: string;
  explanation?: string | null;
  documentCategory?: string | null;
  appliesToAll?: boolean;
  appliesToDeptIds?: string[];
  appliesToPositionIds?: string[];
  required?: boolean;
  requireExpiry?: boolean;
  active?: boolean;
  displayOrder?: number;
}

export async function updateOnboardingRequirement(
  principal: Principal,
  requirementId: string,
  input: UpdateOnboardingRequirementInput,
) {
  const row = await prisma.onboardingRequirement.findUnique({ where: { id: requirementId } });
  if (!row) throw new NotFoundError(REQ_ENTITY, requirementId);
  assertTenantOwned(row, principal);
  requirePermission(principal, row.clubId, "hr:employee:write");
  await assertSensitiveActionAllowed(
    principal, row.clubId, "hr.onboarding-requirement.write.update", REQ_ENTITY, requirementId,
  );

  const data: Record<string, unknown> = {};
  if (input.displayName !== undefined) data.displayName = input.displayName.trim();
  if (input.explanation !== undefined) data.explanation = input.explanation;
  if (input.documentCategory !== undefined) data.documentCategory = input.documentCategory;
  if (input.appliesToAll !== undefined) data.appliesToAll = input.appliesToAll;
  if (input.appliesToDeptIds !== undefined) data.appliesToDeptIds = stringifyIdList(input.appliesToDeptIds);
  if (input.appliesToPositionIds !== undefined) data.appliesToPositionIds = stringifyIdList(input.appliesToPositionIds);
  if (input.required !== undefined) data.required = input.required;
  if (input.requireExpiry !== undefined) data.requireExpiry = input.requireExpiry;
  if (input.active !== undefined) data.active = input.active;
  if (input.displayOrder !== undefined) data.displayOrder = input.displayOrder;

  const updated = await prisma.onboardingRequirement.update({ where: { id: requirementId }, data });

  await audit(principal, {
    action: "hr.onboarding-requirement.write.update",
    entityType: REQ_ENTITY,
    entityId: requirementId,
    clubId: row.clubId,
    before: { active: row.active, required: row.required, appliesToAll: row.appliesToAll },
    after: { active: updated.active, required: updated.required, appliesToAll: updated.appliesToAll },
  });

  return updated;
}

export async function listClubOnboardingRequirements(
  principal: Principal,
  clubId: string,
  opts: { includeInactive?: boolean } = {},
) {
  requirePermission(principal, clubId, "hr:directory:view");
  const where: Record<string, unknown> = { clubId };
  if (!opts.includeInactive) where.active = true;
  return prisma.onboardingRequirement.findMany({
    where,
    orderBy: [{ displayOrder: "asc" }, { displayName: "asc" }],
  });
}

// ---------------------------------------------------------------------------
// Applicability + fulfillment (canonical, employee-facing).
// ---------------------------------------------------------------------------

export interface ApplicableEmployeeContext {
  clubId: string;
  employeeId: string;
  departmentId: string | null;
  positionId: string | null;
}

/**
 * Return the ACTIVE `OnboardingRequirement` rows that apply to this
 * employee. Server-only; the calling UI/action already trusts the
 * actor.employeeId + actor.clubId to be canonical.
 */
export async function resolveApplicableRequirements(ctx: ApplicableEmployeeContext) {
  const all = await prisma.onboardingRequirement.findMany({
    where: { clubId: ctx.clubId, active: true },
    orderBy: [{ displayOrder: "asc" }, { displayName: "asc" }],
  });
  const applicable = all.filter((r) => {
    if (r.appliesToAll) return true;
    const deptIds = parseIdList(r.appliesToDeptIds);
    if (ctx.departmentId && deptIds.includes(ctx.departmentId)) return true;
    const positionIds = parseIdList(r.appliesToPositionIds);
    if (ctx.positionId && positionIds.includes(ctx.positionId)) return true;
    return false;
  });
  return applicable;
}

export interface RequirementFulfillment {
  requirementId: string;
  code: string;
  satisfied: boolean;
  /** For CREDENTIAL_WITH_EXPIRY: the persisted expiry date, if any. */
  expiresAt?: Date | null;
  /** For DOCUMENT_UPLOAD / CREDENTIAL_WITH_EXPIRY: the linked document row id. */
  documentId?: string | null;
  /** For CONFIRMATION_ONLY: when the ack was recorded. */
  acknowledgedAt?: Date | null;
}

/**
 * Query the CANONICAL fulfillment source for one requirement + employee.
 * Never mutates anything. Callers use the return to (a) render a
 * satisfied checkmark and (b) drive the completion gate.
 */
export async function checkRequirementFulfillment(args: {
  requirement: {
    id: string; code: string; kind: string;
    documentCategory: string | null; requireExpiry: boolean;
  };
  employeeId: string;
  sessionId: string | null;
}): Promise<RequirementFulfillment> {
  const { requirement, employeeId, sessionId } = args;
  switch (requirement.kind) {
    case "DOCUMENT_UPLOAD": {
      if (!requirement.documentCategory) {
        return { requirementId: requirement.id, code: requirement.code, satisfied: false };
      }
      const doc = await prisma.employeeDocument.findFirst({
        where: { employeeId, category: requirement.documentCategory },
        orderBy: { uploadedAt: "desc" },
        select: { id: true },
      });
      return { requirementId: requirement.id, code: requirement.code, satisfied: !!doc, documentId: doc?.id ?? null };
    }
    case "CREDENTIAL_WITH_EXPIRY": {
      const cred = await prisma.employeeCredential.findFirst({
        where: { employeeId, credentialCode: requirement.code },
        orderBy: { updatedAt: "desc" },
        select: { id: true, expiresAt: true, documentId: true },
      });
      if (!cred) return { requirementId: requirement.id, code: requirement.code, satisfied: false };
      if (requirement.requireExpiry && !cred.expiresAt) {
        // Row exists but expiry is missing → still unsatisfied.
        return {
          requirementId: requirement.id, code: requirement.code,
          satisfied: false, expiresAt: cred.expiresAt, documentId: cred.documentId,
        };
      }
      return {
        requirementId: requirement.id, code: requirement.code,
        satisfied: true, expiresAt: cred.expiresAt, documentId: cred.documentId,
      };
    }
    case "CONFIRMATION_ONLY": {
      if (!sessionId) {
        return { requirementId: requirement.id, code: requirement.code, satisfied: false };
      }
      const ack = await prisma.employeeOnboardingAcknowledgement.findFirst({
        where: { sessionId, employeeId, kind: confirmationAckKind(requirement.code) },
        orderBy: { acknowledgedAt: "desc" },
        select: { acknowledgedAt: true },
      });
      return {
        requirementId: requirement.id, code: requirement.code,
        satisfied: !!ack, acknowledgedAt: ack?.acknowledgedAt ?? null,
      };
    }
    default:
      return { requirementId: requirement.id, code: requirement.code, satisfied: false };
  }
}

/**
 * Composite: for an employee-onboarding actor, return the applicable
 * requirement list + fulfillment status for each. Used by the
 * Documents & Credentials page + the canonical continuation resolver.
 */
export async function resolveRequirementStatus(actor: EmployeeOnboardingActor) {
  const employee = await prisma.employee.findFirst({
    where: { id: actor.employeeId, clubId: actor.clubId },
    select: { id: true, clubId: true, departmentId: true, positionId: true },
  });
  if (!employee) {
    return { requirements: [] as Array<{
      requirement: Awaited<ReturnType<typeof resolveApplicableRequirements>>[number];
      fulfillment: RequirementFulfillment;
    }> };
  }
  const requirements = await resolveApplicableRequirements({
    clubId: employee.clubId,
    employeeId: employee.id,
    departmentId: employee.departmentId,
    positionId: employee.positionId,
  });
  const rows = await Promise.all(
    requirements.map(async (req) => ({
      requirement: req,
      fulfillment: await checkRequirementFulfillment({
        requirement: req,
        employeeId: employee.id,
        sessionId: actor.sessionId,
      }),
    })),
  );
  return { requirements: rows };
}

/**
 * Whether Documents is CANONICALLY complete. Only REQUIRED applicable
 * active requirements block completion; optional ones do not.
 */
export async function isDocumentsSectionComplete(actor: EmployeeOnboardingActor): Promise<boolean> {
  const { requirements } = await resolveRequirementStatus(actor);
  for (const { requirement, fulfillment } of requirements) {
    if (!requirement.required) continue;
    if (!fulfillment.satisfied) return false;
  }
  return true;
}

/** Emergency contact is CANONICALLY complete iff a primary contact
 *  row exists with name+relation+phone all non-empty. */
export async function isEmergencySectionComplete(actor: EmployeeOnboardingActor): Promise<boolean> {
  const primary = await prisma.employeeEmergencyContact.findFirst({
    where: { employeeId: actor.employeeId, clubId: actor.clubId, isPrimary: true },
    select: { name: true, relation: true, phone: true },
  });
  if (!primary) return false;
  return !!(primary.name?.trim() && primary.relation?.trim() && primary.phone?.trim());
}
