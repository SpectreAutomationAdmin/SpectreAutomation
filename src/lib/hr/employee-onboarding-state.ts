// HR-2B.2 (2026-08-18) — Onboarding-state vocabulary shared between
// the canonical (Principal-gated) service and the employee-self-
// service surface.
//
// Duplicating this union in the actor module would risk drift; keeping
// it in the canonical `onboarding-sessions.ts` would force the actor
// module to import from a file that itself imports `rbac.ts`, which
// pulls the admin authorization stack into the employee-facing bundle.
// Sharing via this tiny module keeps the two surfaces cleanly
// separated while agreeing on the same vocabulary.

export type EmployeeOnboardingState =
  | "DRAFT"
  | "INVITED"
  | "IN_PROGRESS"
  | "SUBMITTED"
  | "APPROVED"
  | "REJECTED"
  | "REVOKED";

/** States from which the employee may still legitimately continue
 *  their self-service onboarding. Any other state tombstones the
 *  employee actor and any self-service write is refused. */
export const RESUMABLE_ONBOARDING_STATES: readonly EmployeeOnboardingState[] = [
  "DRAFT",
  "INVITED",
  "IN_PROGRESS",
] as const;
