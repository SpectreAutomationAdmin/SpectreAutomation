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
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { assertPostingAllowed } from "../posting-guard";
import { NotFoundError, ValidationError } from "../errors";

const ENTITY = "PayrollBenefitPlan";

export type BenefitPlanKind = "LTD" | "HEALTH_DENTAL" | "RRSP";
const KINDS: readonly BenefitPlanKind[] = ["LTD", "HEALTH_DENTAL", "RRSP"];

export type ElectionKind = "FIXED_AMOUNT" | "PERCENT_OF_ELIGIBLE_EARNINGS";
const ELECTION_KINDS: readonly ElectionKind[] = ["FIXED_AMOUNT", "PERCENT_OF_ELIGIBLE_EARNINGS"];

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
    orderBy: [{ kind: "asc" }, { name: "asc" }],
  });
  return rows.map(toView);
}
