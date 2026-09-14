// Onboarding canonical Position hotfix (2026-09-13) — single source of
// truth for "what Position label do we show the employee?"
//
// Rule (§13):
//   1. Employee.orgPositionId → OrganizationalPosition.name — canonical.
//   2. Else Employee.positionId → EmployeePosition.name — legacy fallback
//      for pre-migration rows only.
//   3. Else `null` — the caller decides how to render "not provided".
//
// The About You → Employment and Review pages both consume this so they
// cannot drift apart. See docs/EMPLOYEE_POSITION_LEGACY_REMOVAL when the
// legacy fallback can be retired.

export interface EmploymentPositionSource {
  orgPosition?: { name: string } | null;
  position?: { name: string } | null;
}

export interface ResolvedEmploymentPosition {
  name: string | null;
  source: "canonical" | "legacy" | null;
}

export function resolveEmploymentPositionName(
  emp: EmploymentPositionSource,
): ResolvedEmploymentPosition {
  if (emp.orgPosition?.name) {
    return { name: emp.orgPosition.name, source: "canonical" };
  }
  if (emp.position?.name) {
    return { name: emp.position.name, source: "legacy" };
  }
  return { name: null, source: null };
}

/**
 * Neutral display label when Position is genuinely absent. §4 forbids
 * masquerading missing data as a meaningful role label — use this when
 * `resolveEmploymentPositionName` returned `{ name: null }`.
 */
export const POSITION_NOT_PROVIDED_LABEL = "Not provided";

export function formatEmploymentPositionLabel(
  emp: EmploymentPositionSource,
): string {
  return resolveEmploymentPositionName(emp).name ?? POSITION_NOT_PROVIDED_LABEL;
}
