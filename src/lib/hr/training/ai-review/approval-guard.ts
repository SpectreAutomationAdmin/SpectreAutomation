// EP-TRAIN-6D-4B — server-authoritative approval guard.
//
// This guard is the ONLY code path that may transition a draft to
// APPROVED_DRAFT. The UI's src/components/ai-training/approval-guard.ts
// (from 6D-3) is advisory ONLY — it disables the Approve button.
// Any API handler mutating approval state MUST call this function
// inside the transaction that would perform the mutation.
//
// Pure in the sense that it accepts plain inputs and returns a decision.
// The IO surface (loading the draft + latest validation + course version)
// is the caller's responsibility; typical flow:
//
//   await prisma.$transaction(async (tx) => {
//     const draft    = await tx.trainingQuestionAiDraft.findFirst({...});
//     const validation = draft ? await tx.trainingQuestionAiValidation.findFirst({...}) : null;
//     const version  = draft ? await tx.trainingCourseVersion.findUnique({...}) : null;
//     const decision = evaluateApprovalServerSide({
//       principal, activeClubId, draft, latestValidation: validation,
//       courseVersion: version,
//       submittedContentHash, submittedRecordVersion,
//     });
//     if (!decision.allowed) throw new ApprovalBlockedError(decision);
//     // ... proceed with writeStateTransition inside the same tx
//   });

import type { Principal } from "@/lib/rbac";
import type { LifecycleState } from "./lifecycle";

export type ServerApprovalBlockReason =
  | "DRAFT_NOT_FOUND"
  | "CROSS_TENANT"
  | "REVIEWER_LACKS_PERMISSION"
  | "CONTENT_HASH_MISMATCH"
  | "CONCURRENT_MODIFICATION"
  | "VALIDATION_MISSING"
  | "VALIDATION_SOURCE_INVALID"
  | "CANDIDATE_REJECTED"
  | "UNRESOLVED_HARD_ERRORS"
  | "SOURCE_VERSION_CHANGED"
  | "STATE_NOT_APPROVABLE"
  | "VALIDATION_SERVICE_UNAVAILABLE";

export interface ServerApprovalDecision {
  readonly allowed: boolean;
  readonly reasons: readonly ServerApprovalBlockReason[];
  readonly httpStatus: number;    // 200 | 403 | 404 | 409 | 503
  readonly message: string;       // single-line human-readable summary
  readonly auditMeta: Readonly<Record<string, unknown>>;
}

/** Minimal shape of a loaded draft the guard needs. */
export interface GuardDraftSnapshot {
  readonly id: string;
  readonly clubId: string;
  readonly courseVersionId: string;
  readonly contentHash: string;
  readonly sourceVideoSha256: string;
  readonly state: LifecycleState;
  readonly recordVersion: number;
}

/** Minimal shape of a loaded validation the guard needs. */
export interface GuardValidationSnapshot {
  readonly id: string;
  readonly draftContentHash: string;
  readonly validatorSource: string;      // only "integrated-pipeline" is approvable in production
  readonly verdict: "GROUNDED" | "REQUIRES_HUMAN_VERIFICATION" | "REJECTED";
  readonly errorsJson: string;           // JSON array; empty "[]" when none
}

/** Minimal shape of the parent course version. */
export interface GuardCourseVersionSnapshot {
  readonly id: string;
  readonly videoSha256: string | null;
  readonly state: string;                // "DRAFT" | "PUBLISHED" | "RETIRED"
  readonly retiredAt: Date | null;
}

export interface EvaluateServerApprovalArgs {
  readonly principal: Principal;
  readonly activeClubId: string;
  readonly draft: GuardDraftSnapshot | null;
  readonly latestValidation: GuardValidationSnapshot | null;
  readonly courseVersion: GuardCourseVersionSnapshot | null;
  readonly submittedContentHash: string;
  readonly submittedRecordVersion: number;
  readonly validationServiceHealthy: boolean;
  /** Function the guard calls to check permission. Injected so the
   *  function stays pure + fully unit-testable without mocking the
   *  RBAC module. */
  readonly hasPermission: (permissionKey: string) => boolean;
}

const MESSAGES: Record<ServerApprovalBlockReason, string> = {
  DRAFT_NOT_FOUND:
    "Approval blocked: draft not found.",
  CROSS_TENANT:
    "Approval blocked: draft is owned by a different tenant.",
  REVIEWER_LACKS_PERMISSION:
    "Approval blocked: reviewer lacks the hr:training:ai:approve permission for the active club.",
  CONTENT_HASH_MISMATCH:
    "Approval blocked: submitted content hash does not match the current draft. Refresh and retry.",
  CONCURRENT_MODIFICATION:
    "Approval blocked: draft was modified concurrently. Refresh and retry.",
  VALIDATION_MISSING:
    "Approval blocked: no validation exists for the current content hash. Run validation first.",
  VALIDATION_SOURCE_INVALID:
    "Approval blocked: the latest validation was produced by the fixture source, which cannot establish production approval eligibility.",
  CANDIDATE_REJECTED:
    "Approval blocked: validation verdict is REJECTED.",
  UNRESOLVED_HARD_ERRORS:
    "Approval blocked: validation carries unresolved hard errors.",
  SOURCE_VERSION_CHANGED:
    "Approval blocked: the source video SHA has changed since this draft was generated.",
  STATE_NOT_APPROVABLE:
    "Approval blocked: draft is not in a state that allows approval.",
  VALIDATION_SERVICE_UNAVAILABLE:
    "Approval blocked: the validation service is unavailable.",
};

const STATUS: Record<ServerApprovalBlockReason, number> = {
  DRAFT_NOT_FOUND: 404,
  CROSS_TENANT: 404,                  // same-shape 404 — no cross-tenant enumeration signal
  REVIEWER_LACKS_PERMISSION: 403,
  CONTENT_HASH_MISMATCH: 409,
  CONCURRENT_MODIFICATION: 409,
  VALIDATION_MISSING: 409,
  VALIDATION_SOURCE_INVALID: 409,
  CANDIDATE_REJECTED: 409,
  UNRESOLVED_HARD_ERRORS: 409,
  SOURCE_VERSION_CHANGED: 409,
  STATE_NOT_APPROVABLE: 409,
  VALIDATION_SERVICE_UNAVAILABLE: 503,
};

export function evaluateApprovalServerSide(args: EvaluateServerApprovalArgs): ServerApprovalDecision {
  const reasons: ServerApprovalBlockReason[] = [];
  const meta: Record<string, unknown> = {
    principalId: args.principal?.id ?? null,
    activeClubId: args.activeClubId,
  };

  // Pre-DB-fetch checks the caller can satisfy before loading the draft.
  if (!args.validationServiceHealthy) {
    reasons.push("VALIDATION_SERVICE_UNAVAILABLE");
  }

  // Draft not loaded → either genuinely missing OR cross-tenant.
  // Either way: 404 same-shape (CROSS_TENANT and DRAFT_NOT_FOUND both
  // map to 404 so an attacker cannot distinguish).
  if (!args.draft) {
    reasons.push("DRAFT_NOT_FOUND");
    return finalise(reasons, meta);
  }

  meta.draftId = args.draft.id;
  meta.draftContentHashCurrent = args.draft.contentHash;
  meta.draftRecordVersionCurrent = args.draft.recordVersion;
  meta.draftState = args.draft.state;
  meta.submittedContentHash = args.submittedContentHash;
  meta.submittedRecordVersion = args.submittedRecordVersion;

  // Tenant isolation — defence-in-depth against a caller that bypassed
  // the API handler's `tenantWhere` filter.
  if (args.draft.clubId !== args.activeClubId) {
    reasons.push("CROSS_TENANT");
    return finalise(reasons, meta);
  }

  // Permission
  if (!args.hasPermission("hr:training:ai:approve")) {
    reasons.push("REVIEWER_LACKS_PERMISSION");
    return finalise(reasons, meta);
  }

  // Content hash + optimistic concurrency
  if (args.draft.contentHash !== args.submittedContentHash) {
    reasons.push("CONTENT_HASH_MISMATCH");
  }
  if (args.draft.recordVersion !== args.submittedRecordVersion) {
    reasons.push("CONCURRENT_MODIFICATION");
  }
  // If either hash or record-version failed, further checks are moot.
  if (reasons.length > 0) return finalise(reasons, meta);

  // Validation presence + binding
  if (!args.latestValidation) {
    reasons.push("VALIDATION_MISSING");
    return finalise(reasons, meta);
  }
  meta.validationId = args.latestValidation.id;
  meta.validatorSource = args.latestValidation.validatorSource;

  if (args.latestValidation.validatorSource !== "integrated-pipeline") {
    reasons.push("VALIDATION_SOURCE_INVALID");
  }
  if (args.latestValidation.draftContentHash !== args.draft.contentHash) {
    reasons.push("VALIDATION_MISSING");  // same code — "no validation matching the CURRENT content"
  }

  if (args.latestValidation.verdict === "REJECTED") {
    reasons.push("CANDIDATE_REJECTED");
  }
  // Parse errorsJson safely; bad JSON treated as "has errors" (fail closed).
  let parsedErrors: unknown[] = [];
  try {
    const p = JSON.parse(args.latestValidation.errorsJson);
    if (!Array.isArray(p)) parsedErrors = [p];
    else parsedErrors = p;
  } catch {
    parsedErrors = [{ code: "ERRORS_JSON_UNPARSABLE" }];
  }
  if (parsedErrors.length > 0 && !reasons.includes("CANDIDATE_REJECTED")) {
    reasons.push("UNRESOLVED_HARD_ERRORS");
  }

  // Source-version binding
  if (!args.courseVersion) {
    reasons.push("SOURCE_VERSION_CHANGED");  // version row disappeared
  } else {
    meta.courseVersionState = args.courseVersion.state;
    if (args.courseVersion.videoSha256 !== args.draft.sourceVideoSha256) {
      reasons.push("SOURCE_VERSION_CHANGED");
    }
    if (args.courseVersion.retiredAt !== null) {
      // Retired courses do not accept new approvals.
      reasons.push("SOURCE_VERSION_CHANGED");
    }
  }

  // State check — approval is only legal from REQUIRES_HUMAN_REVIEW.
  if (args.draft.state !== "REQUIRES_HUMAN_REVIEW") {
    reasons.push("STATE_NOT_APPROVABLE");
  }

  return finalise(reasons, meta);
}

function finalise(
  reasons: ServerApprovalBlockReason[],
  auditMeta: Record<string, unknown>,
): ServerApprovalDecision {
  if (reasons.length === 0) {
    return { allowed: true, reasons: [], httpStatus: 200, message: "", auditMeta };
  }
  const primary = reasons[0];
  return {
    allowed: false,
    reasons,
    httpStatus: STATUS[primary],
    message: MESSAGES[primary],
    auditMeta: { ...auditMeta, reasons },
  };
}
