// Slice C (2026-09-18) — Club-level PayrollBenefitPlan CRUD.
//
// The plan is the durable Club arrangement (LTD / HEALTH_DENTAL /
// RRSP-forward). It carries NO statutory / accounting configuration
// itself — those live on the linked PayrollComponents. Spectre
// executes CONFIGURED semantics; it never infers tax law from the
// plan's kind.
//
// Permissions:
//   - Create / change / deactivate a plan → payroll:config:write
//     (held by CLUB_ADMIN + PAYROLL_ADMIN + SUPER_ADMIN today).
//   - Read → payroll:config:read (CONTROLLER + all of the above).

import { prisma } from "../prisma";
import { Prisma } from "@prisma/client";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { assertPostingAllowed } from "../posting-guard";
import { NotFoundError, ValidationError, ConflictError } from "../errors";

const ENTITY = "PayrollBenefitPlan";

export type BenefitPlanKind = "LTD" | "HEALTH_DENTAL" | "RRSP";
const KINDS: readonly BenefitPlanKind[] = ["LTD", "HEALTH_DENTAL", "RRSP"];

export type ElectionKind = "FIXED_AMOUNT" | "PERCENT_OF_ELIGIBLE_EARNINGS";
const ELECTION_KINDS: readonly ElectionKind[] = ["FIXED_AMOUNT", "PERCENT_OF_ELIGIBLE_EARNINGS"];

// Slice C closeout (2026-09-18) §17-18 — `eligibleEarningsBasis` is the
// PLAN's payroll-period earnings basis used to compute an employee percent
// election (and, for RRSP in Slice D, an employer match). It is NOT a
// contribution-room ceiling and does NOT represent a CRA RRSP deduction
// limit, YTD contribution-room, or any other regulatory maximum. Any future
// enforcement of an annual RRSP contribution limit will consume a
// separately-sourced field (not this one).
//
//   REGULAR_EARNINGS_ONLY — regular salary / hourly earnings only. Excludes
//                           bonuses, allowances, taxable benefits. Typical
//                           RRSP match basis.
//   CASH_EARNINGS         — sum of cash-effect INCREASES_NET_PAY component
//                           amounts (regular + additional earnings + cash
//                           allowances). Broader base.
export type EligibleEarningsBasis = "REGULAR_EARNINGS_ONLY" | "CASH_EARNINGS";
const BASES: readonly EligibleEarningsBasis[] = ["REGULAR_EARNINGS_ONLY", "CASH_EARNINGS"];

export interface BenefitPlanView {
  id: string;
  clubId: string;
  kind: BenefitPlanKind;
  code: string;
  name: string;
  description: string | null;
  providerName: string | null;
  active: boolean;
  effectiveFromIso: string;
  effectiveToIso: string | null;
  employeeComponentId: string | null;
  employerComponentId: string | null;
  defaultElectionKind: ElectionKind;
  eligibleEarningsBasis: EligibleEarningsBasis | null;
  employerMatchBps: number | null;
  employerMatchCapBps: number | null;
  notes: string | null;
  predecessorPlanId: string | null;
  createdAt: string;
  updatedAt: string;
}

function toView(row: Awaited<ReturnType<typeof prisma.payrollBenefitPlan.findUnique>>): BenefitPlanView {
  if (!row) throw new NotFoundError(ENTITY, "(null)");
  return {
    id: row.id,
    clubId: row.clubId,
    kind: row.kind as BenefitPlanKind,
    code: row.code,
    name: row.name,
    description: row.description,
    providerName: row.providerName,
    active: row.active,
    effectiveFromIso: row.effectiveFrom.toISOString(),
    effectiveToIso: row.effectiveTo?.toISOString() ?? null,
    employeeComponentId: row.employeeComponentId,
    employerComponentId: row.employerComponentId,
    defaultElectionKind: row.defaultElectionKind as ElectionKind,
    eligibleEarningsBasis: (row.eligibleEarningsBasis as EligibleEarningsBasis | null) ?? null,
    employerMatchBps: row.employerMatchBps,
    employerMatchCapBps: row.employerMatchCapBps,
    notes: row.notes,
    predecessorPlanId: row.predecessorPlanId ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface CreatePlanInput {
  kind: BenefitPlanKind;
  code: string;
  name: string;
  description?: string | null;
  providerName?: string | null;
  effectiveFrom: Date | string;
  effectiveTo?: Date | string | null;
  employeeComponentId?: string | null;
  employerComponentId?: string | null;
  defaultElectionKind?: ElectionKind;
  eligibleEarningsBasis?: EligibleEarningsBasis | null;
  // RRSP-only (Slice D). Slice C ignores these on LTD / HEALTH_DENTAL.
  employerMatchBps?: number | null;
  employerMatchCapBps?: number | null;
  notes?: string | null;
}

function toDate(v: Date | string): Date {
  if (v instanceof Date) return v;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return new Date(`${v}T00:00:00.000Z`);
  return new Date(v);
}

async function assertComponentExists(clubId: string, componentId: string, path: string) {
  const c = await prisma.payrollComponent.findFirst({
    where: { id: componentId, clubId },
    select: { id: true, side: true, active: true },
  });
  if (!c) throw new ValidationError([{ path, message: `Referenced component ${componentId} not found in this Club.` }]);
  if (!c.active) throw new ValidationError([{ path, message: `Referenced component ${componentId} is inactive.` }]);
}

export async function createBenefitPlan(
  principal: Principal,
  clubId: string,
  input: CreatePlanInput,
): Promise<BenefitPlanView> {
  requirePermission(principal, clubId, "payroll:config:write");
  await assertPostingAllowed(principal, clubId, "payroll.benefit_plan.create", ENTITY, clubId);

  if (!KINDS.includes(input.kind)) {
    throw new ValidationError([{ path: "kind", message: `kind must be one of ${KINDS.join(", ")}; got ${input.kind}` }]);
  }
  const electionKind = input.defaultElectionKind ?? "FIXED_AMOUNT";
  if (!ELECTION_KINDS.includes(electionKind)) {
    throw new ValidationError([{ path: "defaultElectionKind", message: `must be one of ${ELECTION_KINDS.join(", ")}` }]);
  }
  if (electionKind === "PERCENT_OF_ELIGIBLE_EARNINGS") {
    if (!input.eligibleEarningsBasis) {
      throw new ValidationError([{ path: "eligibleEarningsBasis", message: "Required when defaultElectionKind is PERCENT_OF_ELIGIBLE_EARNINGS." }]);
    }
    if (!BASES.includes(input.eligibleEarningsBasis)) {
      throw new ValidationError([{ path: "eligibleEarningsBasis", message: `must be one of ${BASES.join(", ")}` }]);
    }
  }

  if (!input.employeeComponentId && !input.employerComponentId) {
    throw new ValidationError([{
      path: "employeeComponentId|employerComponentId",
      message: "A plan must link to at least one payroll component (employee-side, employer-side, or both).",
    }]);
  }
  if (input.employeeComponentId) await assertComponentExists(clubId, input.employeeComponentId, "employeeComponentId");
  if (input.employerComponentId) await assertComponentExists(clubId, input.employerComponentId, "employerComponentId");

  const effectiveFrom = toDate(input.effectiveFrom);
  const effectiveTo = input.effectiveTo ? toDate(input.effectiveTo) : null;
  if (effectiveTo && effectiveTo <= effectiveFrom) {
    throw new ValidationError([{ path: "effectiveTo", message: "effectiveTo must be after effectiveFrom." }]);
  }

  const row = await prisma.payrollBenefitPlan.create({
    data: {
      clubId,
      kind: input.kind,
      code: input.code.trim(),
      name: input.name.trim(),
      description: input.description ?? null,
      providerName: input.providerName ?? null,
      active: true,
      effectiveFrom,
      effectiveTo,
      employeeComponentId: input.employeeComponentId ?? null,
      employerComponentId: input.employerComponentId ?? null,
      defaultElectionKind: electionKind,
      eligibleEarningsBasis: input.eligibleEarningsBasis ?? null,
      employerMatchBps: input.employerMatchBps ?? null,
      employerMatchCapBps: input.employerMatchCapBps ?? null,
      notes: input.notes ?? null,
      createdByUserId: principal.id,
    },
  });

  await audit(principal, {
    action: "payroll.benefit_plan.create",
    entityType: ENTITY, entityId: row.id, clubId,
    after: { kind: row.kind, code: row.code, name: row.name },
  });
  return toView(row);
}

export async function deactivateBenefitPlan(
  principal: Principal,
  clubId: string,
  planId: string,
): Promise<BenefitPlanView> {
  requirePermission(principal, clubId, "payroll:config:write");
  const existing = await prisma.payrollBenefitPlan.findFirst({ where: { id: planId, clubId } });
  if (!existing) throw new NotFoundError(ENTITY, planId);
  const row = await prisma.payrollBenefitPlan.update({
    where: { id: planId }, data: { active: false, effectiveTo: new Date() },
  });
  await audit(principal, {
    action: "payroll.benefit_plan.deactivate",
    entityType: ENTITY, entityId: row.id, clubId,
    before: { active: existing.active },
    after: { active: false },
  });
  return toView(row);
}

export async function listBenefitPlans(
  principal: Principal,
  clubId: string,
  opts: { includeInactive?: boolean } = {},
): Promise<BenefitPlanView[]> {
  requirePermission(principal, clubId, "payroll:config:read");
  const rows = await prisma.payrollBenefitPlan.findMany({
    where: { clubId, ...(opts.includeInactive ? {} : { active: true }) },
    orderBy: [{ kind: "asc" }, { name: "asc" }, { effectiveFrom: "desc" }],
  });
  return rows.map(toView);
}

// ---------------------------------------------------------------------
// Slice C final UI acceptance (2026-09-18) — Change Plan
//
// Two-tier semantics:
//
//   1. METADATA update (in-place, safe): name / description / providerName /
//      notes. None of these participate in payroll calculation, GL routing,
//      pensionable/taxable/insurable bases, or election math. Editing them
//      does not alter historical or future payroll.
//
//   2. CONFIGURATION change (effective-dated, non-destructive):
//      employeeComponentId / employerComponentId / defaultElectionKind /
//      eligibleEarningsBasis / employerMatchBps / employerMatchCapBps.
//      These CAN change tax / pensionable / GL treatment or election math,
//      so mutating them in place would silently rewrite the meaning of any
//      historical enrolment that still points at this row. Instead:
//        a. Predecessor plan: set `active=false` and `effectiveTo=cutover`.
//           Row retained AS-IS for audit + Prepare-time exclusion after
//           cutover.
//        b. Successor plan: new row inserted with cutover as effectiveFrom,
//           new configuration, code auto-suffixed to satisfy the (clubId,
//           code) unique constraint, and `predecessorPlanId` set to the
//           predecessor for lineage.
//        c. Every ACTIVE enrolment on the predecessor is closed at the
//           cutover (ENDED, effectiveTo=cutover) and a matching successor
//           enrolment is opened at cutover on the new plan with the same
//           election. Frozen POSTED snapshots are untouched — they carry
//           their own `sourceEnrolmentId` + `sourceComponentId`.
// ---------------------------------------------------------------------

export interface UpdatePlanMetadataInput {
  name?: string;
  description?: string | null;
  providerName?: string | null;
  notes?: string | null;
}

export async function updateBenefitPlanMetadata(
  principal: Principal,
  clubId: string,
  planId: string,
  input: UpdatePlanMetadataInput,
): Promise<BenefitPlanView> {
  requirePermission(principal, clubId, "payroll:config:write");
  const existing = await prisma.payrollBenefitPlan.findFirst({ where: { id: planId, clubId } });
  if (!existing) throw new NotFoundError(ENTITY, planId);

  const patch: Prisma.PayrollBenefitPlanUpdateInput = {};
  if (input.name !== undefined) {
    const n = input.name.trim();
    if (!n) throw new ValidationError([{ path: "name", message: "name cannot be blank" }]);
    patch.name = n;
  }
  if (input.description !== undefined) patch.description = input.description;
  if (input.providerName !== undefined) patch.providerName = input.providerName;
  if (input.notes !== undefined) patch.notes = input.notes;
  if (Object.keys(patch).length === 0) return toView(existing);

  const row = await prisma.payrollBenefitPlan.update({ where: { id: planId }, data: patch });
  await audit(principal, {
    action: "payroll.benefit_plan.metadata_update",
    entityType: ENTITY, entityId: row.id, clubId,
    before: {
      name: existing.name, description: existing.description,
      providerName: existing.providerName, notes: existing.notes,
    },
    after: {
      name: row.name, description: row.description,
      providerName: row.providerName, notes: row.notes,
    },
  });
  return toView(row);
}

export interface ChangePlanConfigurationInput {
  cutover: Date | string;              // effectiveFrom of the successor
  employeeComponentId?: string | null;
  employerComponentId?: string | null;
  defaultElectionKind?: ElectionKind;
  eligibleEarningsBasis?: EligibleEarningsBasis | null;
  employerMatchBps?: number | null;
  employerMatchCapBps?: number | null;
}

/** Next successor code — appends `-r<N>` where N counts the depth from the
 *  original plan (predecessor chain length + 1). Guarantees uniqueness under
 *  `@@unique([clubId, code])`. */
async function nextSuccessorCode(clubId: string, baseCode: string): Promise<string> {
  const existing = await prisma.payrollBenefitPlan.findMany({
    where: { clubId, code: { startsWith: baseCode } },
    select: { code: true },
  });
  const suffixes = existing
    .map((r) => r.code)
    .map((c) => (c === baseCode ? 0 : (c.match(new RegExp(`^${baseCode.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-r(\\d+)$`)) ?? [])[1]))
    .filter(Boolean)
    .map((n) => Number(n));
  const max = suffixes.length > 0 ? Math.max(0, ...suffixes) : 0;
  return `${baseCode}-r${max + 1}`;
}

export async function changeBenefitPlanConfiguration(
  principal: Principal,
  clubId: string,
  planId: string,
  input: ChangePlanConfigurationInput,
): Promise<{ predecessor: BenefitPlanView; successor: BenefitPlanView; migratedEnrolmentCount: number }> {
  requirePermission(principal, clubId, "payroll:config:write");
  await assertPostingAllowed(principal, clubId, "payroll.benefit_plan.change", ENTITY, planId);

  const existing = await prisma.payrollBenefitPlan.findFirst({ where: { id: planId, clubId } });
  if (!existing) throw new NotFoundError(ENTITY, planId);
  if (!existing.active) throw new ConflictError(`Plan ${existing.code} is already inactive — cannot change.`);

  const cutover = toDate(input.cutover);
  if (cutover <= existing.effectiveFrom) {
    throw new ValidationError([{ path: "cutover", message: "cutover must be strictly after the current plan's effectiveFrom" }]);
  }
  if (existing.effectiveTo && cutover >= existing.effectiveTo) {
    throw new ValidationError([{ path: "cutover", message: "cutover must fall inside the current plan's effective window" }]);
  }

  // Merge existing + input to produce successor configuration.
  const nextEmployeeComponentId = input.employeeComponentId !== undefined ? input.employeeComponentId : existing.employeeComponentId;
  const nextEmployerComponentId = input.employerComponentId !== undefined ? input.employerComponentId : existing.employerComponentId;
  const nextElectionKind = (input.defaultElectionKind ?? (existing.defaultElectionKind as ElectionKind)) as ElectionKind;
  const nextBasis = input.eligibleEarningsBasis !== undefined ? input.eligibleEarningsBasis : (existing.eligibleEarningsBasis as EligibleEarningsBasis | null);
  const nextMatchBps = input.employerMatchBps !== undefined ? input.employerMatchBps : existing.employerMatchBps;
  const nextMatchCapBps = input.employerMatchCapBps !== undefined ? input.employerMatchCapBps : existing.employerMatchCapBps;

  if (!nextEmployeeComponentId && !nextEmployerComponentId) {
    throw new ValidationError([{
      path: "employeeComponentId|employerComponentId",
      message: "Successor plan must link to at least one payroll component.",
    }]);
  }
  if (nextEmployeeComponentId) await assertComponentExists(clubId, nextEmployeeComponentId, "employeeComponentId");
  if (nextEmployerComponentId) await assertComponentExists(clubId, nextEmployerComponentId, "employerComponentId");
  if (!ELECTION_KINDS.includes(nextElectionKind)) {
    throw new ValidationError([{ path: "defaultElectionKind", message: `must be one of ${ELECTION_KINDS.join(", ")}` }]);
  }
  if (nextElectionKind === "PERCENT_OF_ELIGIBLE_EARNINGS") {
    if (!nextBasis) throw new ValidationError([{ path: "eligibleEarningsBasis", message: "Required for PERCENT election" }]);
    if (!BASES.includes(nextBasis)) throw new ValidationError([{ path: "eligibleEarningsBasis", message: `must be one of ${BASES.join(", ")}` }]);
  }

  const successorCode = await nextSuccessorCode(clubId, existing.code);

  const result = await prisma.$transaction(async (tx) => {
    // 1. Close predecessor at cutover.
    await tx.payrollBenefitPlan.update({
      where: { id: existing.id },
      data: { active: false, effectiveTo: cutover },
    });
    // 2. Create successor.
    const successor = await tx.payrollBenefitPlan.create({
      data: {
        clubId,
        kind: existing.kind,
        code: successorCode,
        name: existing.name,
        description: existing.description,
        providerName: existing.providerName,
        active: true,
        effectiveFrom: cutover,
        effectiveTo: existing.effectiveTo,
        employeeComponentId: nextEmployeeComponentId,
        employerComponentId: nextEmployerComponentId,
        defaultElectionKind: nextElectionKind,
        eligibleEarningsBasis: nextBasis,
        employerMatchBps: nextMatchBps,
        employerMatchCapBps: nextMatchCapBps,
        notes: existing.notes,
        predecessorPlanId: existing.id,
        createdByUserId: principal.id,
      },
    });
    // 3. Migrate ACTIVE enrolments: end at cutover on predecessor +
    //    open successor at cutover on the new plan.
    const active = await tx.employeeBenefitPlanEnrolment.findMany({
      where: { clubId, planId: existing.id, status: "ACTIVE" },
    });
    for (const e of active) {
      // Cutover must fall within the enrolment's own effective window.
      if (cutover <= e.effectiveFrom) continue;
      if (e.effectiveTo && cutover >= e.effectiveTo) continue;
      await tx.employeeBenefitPlanEnrolment.update({
        where: { id: e.id },
        data: { status: "ENDED", effectiveTo: cutover, changedByUserId: principal.id },
      });
      await tx.employeeBenefitPlanEnrolment.create({
        data: {
          clubId,
          employeeId: e.employeeId,
          planId: successor.id,
          status: "ACTIVE",
          effectiveFrom: cutover,
          effectiveTo: e.effectiveTo,
          electionKind: e.electionKind,
          amount: e.amount,
          percentBps: e.percentBps,
          notes: e.notes,
          enteredByUserId: principal.id,
          changedByUserId: principal.id,
        },
      });
    }
    return { successor, migratedCount: active.length };
  });

  await audit(principal, {
    action: "payroll.benefit_plan.change",
    entityType: ENTITY, entityId: result.successor.id, clubId,
    before: {
      planId: existing.id, code: existing.code,
      employeeComponentId: existing.employeeComponentId,
      employerComponentId: existing.employerComponentId,
      defaultElectionKind: existing.defaultElectionKind,
      eligibleEarningsBasis: existing.eligibleEarningsBasis,
      employerMatchBps: existing.employerMatchBps,
      employerMatchCapBps: existing.employerMatchCapBps,
    },
    after: {
      successorPlanId: result.successor.id,
      cutover: cutover.toISOString(),
      code: successorCode,
      employeeComponentId: nextEmployeeComponentId,
      employerComponentId: nextEmployerComponentId,
      defaultElectionKind: nextElectionKind,
      eligibleEarningsBasis: nextBasis,
      employerMatchBps: nextMatchBps,
      employerMatchCapBps: nextMatchCapBps,
      migratedEnrolments: result.migratedCount,
    },
  });

  const predecessor = await prisma.payrollBenefitPlan.findUniqueOrThrow({ where: { id: existing.id } });
  return {
    predecessor: toView(predecessor),
    successor: toView(result.successor),
    migratedEnrolmentCount: result.migratedCount,
  };
}
