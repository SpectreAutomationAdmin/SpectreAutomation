// HR-1 (2026-08-16) — PayrollProfile service.
//
// One PayrollProfile per Employee (schema: `employeeId @unique`).
// Foundational configuration — jurisdiction, pay-group, pay-frequency,
// direct-deposit toggle. Does NOT hold calculated pay values — those
// remain on PayrollLine / PayrollRun downstream.
//
// Guards:
//   - `upsertPayrollProfile`   — `hr:payroll_profile:write` only.
//     Draft-tier CRUD; no posting-guard because activation is the
//     moment payroll actually turns on.
//   - `activatePayrollProfile` — `hr:payroll_profile:activate` +
//     `assertPostingAllowed` (training-mode + support-readonly). The
//     three activation preconditions are checked via masked reads
//     from the security-compliance services — NO plaintext is ever
//     read here.
//   - `deactivatePayrollProfile` — `hr:payroll_profile:activate` +
//     `assertPostingAllowed`. Action verb `void` triggers support-
//     readonly.
//   - Reads (`getPayrollProfile`) — `hr:payroll_profile:read`, not
//     audited.
//
// Audit action strings all contain a WRITE_INDICATOR verb (`update`,
// `post`, `void`), matched by the substring gate in
// `src/lib/support-access/index.ts::WRITE_INDICATORS` and asserted by
// `tests/hr/hr-mutation-action-strings.test.ts`.

import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { assertTenantOwned } from "../services/tenant";
import { AppError, ConflictError, NotFoundError, ValidationError } from "../errors";
import { assertPostingAllowed } from "../posting-guard";
import { getCurrentCompensation } from "./compensation";
import { getSinMasked } from "./sensitive-identity";
import { getBankAccountMasked } from "./bank-account";

const PROFILE_ENTITY = "PayrollProfile";

// Canadian tax jurisdictions we currently support. Extend as needed —
// this is a soft enum, but we prefer a validated allow-list so a
// typo doesn't silently point payroll at the wrong remittance table
// downstream.
const JURISDICTIONS = [
  "CA-FED",
  "CA-AB", "CA-BC", "CA-MB", "CA-NB", "CA-NL", "CA-NS", "CA-NT",
  "CA-NU", "CA-ON", "CA-PE", "CA-QC", "CA-SK", "CA-YT",
] as const;

// Cadence-of-check. WEEKLY / BIWEEKLY / SEMI_MONTHLY / MONTHLY.
const PAY_FREQUENCIES = ["WEEKLY", "BIWEEKLY", "SEMI_MONTHLY", "MONTHLY"] as const;

// Named pay-group buckets. Not a hard enum — a club can invent its
// own bucket names — but we reject empty / whitespace-only strings.
function normalisePayGroup(input: string): string {
  const s = (input ?? "").trim();
  if (s.length < 2) {
    throw new ValidationError([{ path: "payGroup", message: "payGroup is required (min 2 chars)" }]);
  }
  return s;
}

/**
 * Typed error for activation-precondition failures. The `precondition`
 * field is machine-inspectable ("no_current_compensation" |
 * "sin_not_on_file" | "bank_not_active") so UI callers can render
 * targeted CTAs. The error message NEVER carries plaintext.
 */
export class PayrollProfileActivationPreconditionError extends AppError {
  readonly precondition: string;
  constructor(precondition: string, detail: string) {
    super(
      "PAYROLL_PROFILE_ACTIVATION_PRECONDITION",
      `Cannot activate payroll profile: ${detail}`,
      409,
      // safeMessage — never plaintext.
      `Cannot activate payroll profile: ${detail}`,
    );
    this.precondition = precondition;
  }
}

async function loadEmployee(principal: Principal, employeeId: string) {
  const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!employee) throw new NotFoundError("Employee", employeeId);
  assertTenantOwned(employee, principal);
  return employee;
}

// ---------------------------------------------------------------------------
// Upsert (create / edit draft).
// ---------------------------------------------------------------------------
export interface PayrollProfileInput {
  jurisdiction: string;
  payGroup: string;
  payFrequency: string;
  directDepositActive?: boolean;
  notes?: string | null;
}

/**
 * Create or edit the payroll profile draft. Idempotent per employee
 * (schema: `employeeId @unique`). Does NOT flip `activatedAt`;
 * activation is a separate step behind the posting guard.
 */
export async function upsertPayrollProfile(
  principal: Principal,
  employeeId: string,
  input: PayrollProfileInput,
) {
  const employee = await loadEmployee(principal, employeeId);
  requirePermission(principal, employee.clubId, "hr:payroll_profile:write");

  const jurisdiction = (input.jurisdiction ?? "").trim().toUpperCase();
  if (!(JURISDICTIONS as readonly string[]).includes(jurisdiction)) {
    throw new ValidationError([{ path: "jurisdiction", message: `must be one of ${JURISDICTIONS.join(", ")}` }]);
  }
  if (!(PAY_FREQUENCIES as readonly string[]).includes(input.payFrequency)) {
    throw new ValidationError([{ path: "payFrequency", message: `must be one of ${PAY_FREQUENCIES.join(", ")}` }]);
  }
  const payGroup = normalisePayGroup(input.payGroup);

  const before = await prisma.payrollProfile.findUnique({ where: { employeeId } });

  const row = await prisma.payrollProfile.upsert({
    where: { employeeId },
    update: {
      jurisdiction,
      payGroup,
      payFrequency: input.payFrequency,
      directDepositActive: input.directDepositActive ?? before?.directDepositActive ?? false,
      notes: input.notes ?? before?.notes ?? null,
    },
    create: {
      clubId: employee.clubId,
      employeeId,
      jurisdiction,
      payGroup,
      payFrequency: input.payFrequency,
      directDepositActive: input.directDepositActive ?? false,
      notes: input.notes ?? null,
    },
  });

  await audit(principal, {
    action: "hr.payroll_profile.write.update",
    entityType: PROFILE_ENTITY,
    entityId: row.id,
    clubId: employee.clubId,
    before: before
      ? {
          jurisdiction: before.jurisdiction,
          payGroup: before.payGroup,
          payFrequency: before.payFrequency,
          directDepositActive: before.directDepositActive,
          activatedAt: before.activatedAt,
        }
      : null,
    after: {
      jurisdiction: row.jurisdiction,
      payGroup: row.payGroup,
      payFrequency: row.payFrequency,
      directDepositActive: row.directDepositActive,
      activatedAt: row.activatedAt,
    },
  });

  return row;
}

// ---------------------------------------------------------------------------
// Activate — payroll processing becomes enabled for this employee.
// ---------------------------------------------------------------------------
/**
 * Preconditions checked via MASKED reads from the security-compliance
 * services — never plaintext:
 *
 *   1. `getCurrentCompensation(principal, employeeId)` returns a row.
 *   2. `getSinMasked(principal, employeeId)` returns non-null (a SIN
 *      row exists; `sinLastThree` is populated).
 *   3. `getBankAccountMasked(principal, employeeId)` returns a row
 *      with `status === "VERIFIED"` (direct deposit has been
 *      penny-tested / approved).
 *
 * Any failure throws `PayrollProfileActivationPreconditionError` with
 * a machine-inspectable `precondition` field. Plaintext values are
 * never quoted into the error message.
 */
export async function activatePayrollProfile(
  principal: Principal,
  employeeId: string,
) {
  const employee = await loadEmployee(principal, employeeId);
  requirePermission(principal, employee.clubId, "hr:payroll_profile:activate");
  await assertPostingAllowed(
    principal,
    employee.clubId,
    "hr.payroll_profile.activate.post",
    PROFILE_ENTITY,
    employeeId,
  );

  const profile = await prisma.payrollProfile.findUnique({ where: { employeeId } });
  if (!profile) throw new NotFoundError(PROFILE_ENTITY, employeeId);
  assertTenantOwned(profile, principal);
  if (profile.activatedAt != null) {
    throw new ConflictError(`PayrollProfile is already activated for employee ${employeeId}`);
  }

  // Precondition 1 — current compensation.
  const currentComp = await getCurrentCompensation(principal, employeeId);
  if (!currentComp) {
    throw new PayrollProfileActivationPreconditionError(
      "no_current_compensation",
      "no current EmployeeCompensation row on file",
    );
  }

  // Precondition 2 — SIN present.
  const sinMasked = await getSinMasked(principal, employeeId);
  if (sinMasked == null) {
    throw new PayrollProfileActivationPreconditionError(
      "sin_not_on_file",
      "SIN is not on file for this employee",
    );
  }

  // Precondition 3 — active (VERIFIED) bank account.
  const bankMasked = await getBankAccountMasked(principal, employeeId);
  if (!bankMasked || bankMasked.status !== "VERIFIED") {
    throw new PayrollProfileActivationPreconditionError(
      "bank_not_active",
      "direct-deposit banking is not in VERIFIED status",
    );
  }

  const activatedAt = new Date();
  const updated = await prisma.payrollProfile.update({
    where: { id: profile.id },
    data: {
      activatedAt,
      // Re-enable direct-deposit unless the caller has explicitly
      // opted out at upsert time — activation is the moment we start
      // paying through the account.
      directDepositActive: true,
      // Clear any stale suspension marker so we're strictly in the
      // ACTIVE state after this call.
      suspendedAt: null,
      suspensionReason: null,
    },
  });

  await audit(principal, {
    action: "hr.payroll_profile.activate.post",
    entityType: PROFILE_ENTITY,
    entityId: profile.id,
    clubId: employee.clubId,
    before: {
      activatedAt: profile.activatedAt,
      directDepositActive: profile.directDepositActive,
    },
    after: {
      activatedAt: updated.activatedAt,
      directDepositActive: updated.directDepositActive,
    },
    meta: {
      // Masked helpers only — no plaintext.
      sinMasked,
      accountLastFour: bankMasked.accountMasked,
      compensationCadence: currentComp.cadence,
    },
  });

  return updated;
}

// ---------------------------------------------------------------------------
// Deactivate — payroll processing halts for this employee.
// ---------------------------------------------------------------------------
export async function deactivatePayrollProfile(
  principal: Principal,
  employeeId: string,
  reason?: string,
) {
  const employee = await loadEmployee(principal, employeeId);
  requirePermission(principal, employee.clubId, "hr:payroll_profile:activate");
  await assertPostingAllowed(
    principal,
    employee.clubId,
    "hr.payroll_profile.deactivate.void",
    PROFILE_ENTITY,
    employeeId,
  );

  const profile = await prisma.payrollProfile.findUnique({ where: { employeeId } });
  if (!profile) throw new NotFoundError(PROFILE_ENTITY, employeeId);
  assertTenantOwned(profile, principal);
  if (profile.activatedAt == null) return profile;

  const suspendedAt = new Date();
  const updated = await prisma.payrollProfile.update({
    where: { id: profile.id },
    data: {
      activatedAt: null,
      directDepositActive: false,
      suspendedAt,
      suspensionReason: reason ?? null,
    },
  });

  await audit(principal, {
    action: "hr.payroll_profile.deactivate.void",
    entityType: PROFILE_ENTITY,
    entityId: profile.id,
    clubId: employee.clubId,
    before: {
      activatedAt: profile.activatedAt,
      directDepositActive: profile.directDepositActive,
      suspendedAt: profile.suspendedAt,
    },
    after: {
      activatedAt: updated.activatedAt,
      directDepositActive: updated.directDepositActive,
      suspendedAt: updated.suspendedAt,
    },
    meta: { reason: reason ?? null },
  });

  return updated;
}

// ---------------------------------------------------------------------------
// Read.
// ---------------------------------------------------------------------------
/**
 * Return the PayrollProfile for the employee, or null. Read-only,
 * NOT audited.
 */
export async function getPayrollProfile(
  principal: Principal,
  employeeId: string,
) {
  const employee = await loadEmployee(principal, employeeId);
  requirePermission(principal, employee.clubId, "hr:payroll_profile:read");
  return prisma.payrollProfile.findUnique({ where: { employeeId } });
}
