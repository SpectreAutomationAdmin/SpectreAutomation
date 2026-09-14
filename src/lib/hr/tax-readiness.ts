// Payroll-readiness hotfix (2026-09-14) §7 — canonical Employee TD1 tax
// readiness resolver. Single source of truth for "is this Employee's TD1
// completed?" across:
//
//   * Employee Profile → Payroll tab (Federal + Provincial TD1 panels)
//   * Prepare Payroll (batch preparation federalTd1Ready/provincialTd1Ready)
//   * Employee approval readiness (approveAndActivateEmployee readiness)
//
// The founder-visible bug that motivated this: onboarding writes to TWO
// tables at TD1 submit — canonical `EmployeeTaxProfile` (with the KMS-
// encrypted claim amounts + form version + province) and per-jurisdiction
// `EmployeeOnboardingAcknowledgement` rows (kind = `td1_federal_attestation`
// / `td1_provincial_attestation`). The Payroll tab used to read only the
// acknowledgements, GATED by `hr:onboarding:read`. Batch preparation +
// approval used the tax profile. The three surfaces could disagree.
//
// This resolver reads the CANONICAL `EmployeeTaxProfile` and uses
// acknowledgements only to enrich the completed-at timestamp for display.
// Callers can render "Completed <date>" with the enriched timestamp when
// available; otherwise they fall back to `EmployeeTaxProfile.effectiveFrom`.

import { prisma } from "../prisma";

export type Td1Status =
  | { ready: false; reason: "NO_TAX_PROFILE" }
  | { ready: false; reason: "NO_PROVINCE" }
  | { ready: true; completedAt: Date; td1FormVersion: string; province: string };

export interface EmployeeTaxReadiness {
  federal: Td1Status;
  provincial: Td1Status;
  taxProfileExists: boolean;
  taxProfileId: string | null;
  province: string | null;
  td1FormVersion: string | null;
  effectiveFrom: Date | null;
  federalCompletedAt: Date | null;
  provincialCompletedAt: Date | null;
}

const FED_KIND = "td1_federal_attestation";
const PROV_KIND = "td1_provincial_attestation";

/**
 * Compute Employee TD1 readiness for both federal and provincial TD1
 * jurisdictions. Never throws; always returns a shape callers can render.
 * Reads two tables:
 *   * `EmployeeTaxProfile` — the canonical row that carries the KMS-encrypted
 *     claim amounts. Its presence proves onboarding TD1 was submitted.
 *   * `EmployeeOnboardingAcknowledgement` — provides the per-jurisdiction
 *     completed-at timestamps for display, when available.
 */
export async function getEmployeeTaxReadiness(
  clubId: string,
  employeeId: string,
): Promise<EmployeeTaxReadiness> {
  const [taxProfile, acks] = await Promise.all([
    prisma.employeeTaxProfile.findFirst({
      where: { clubId, employeeId, effectiveTo: null },
      orderBy: { effectiveFrom: "desc" },
      select: {
        id: true,
        province: true,
        td1FormVersion: true,
        effectiveFrom: true,
      },
    }),
    prisma.employeeOnboardingAcknowledgement.findMany({
      where: { clubId, employeeId, kind: { in: [FED_KIND, PROV_KIND] } },
      select: { kind: true, acknowledgedAt: true },
      orderBy: { acknowledgedAt: "desc" },
    }),
  ]);

  const federalCompletedAt = acks.find((a) => a.kind === FED_KIND)?.acknowledgedAt ?? null;
  const provincialCompletedAt = acks.find((a) => a.kind === PROV_KIND)?.acknowledgedAt ?? null;
  const effectiveFrom = taxProfile?.effectiveFrom ?? null;
  const td1FormVersion = taxProfile?.td1FormVersion ?? null;
  const province = taxProfile?.province ?? null;

  const federal: Td1Status = !taxProfile
    ? { ready: false, reason: "NO_TAX_PROFILE" }
    : {
        ready: true,
        completedAt: federalCompletedAt ?? effectiveFrom ?? new Date(0),
        td1FormVersion: taxProfile.td1FormVersion,
        province: taxProfile.province,
      };
  const provincial: Td1Status = !taxProfile
    ? { ready: false, reason: "NO_TAX_PROFILE" }
    : !taxProfile.province
      ? { ready: false, reason: "NO_PROVINCE" }
      : {
          ready: true,
          completedAt: provincialCompletedAt ?? effectiveFrom ?? new Date(0),
          td1FormVersion: taxProfile.td1FormVersion,
          province: taxProfile.province,
        };

  return {
    federal,
    provincial,
    taxProfileExists: taxProfile !== null,
    taxProfileId: taxProfile?.id ?? null,
    province,
    td1FormVersion,
    effectiveFrom,
    federalCompletedAt,
    provincialCompletedAt,
  };
}
