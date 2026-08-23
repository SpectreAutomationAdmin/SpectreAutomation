// HR-2C B4 (2026-08-23) — Canonical scheduling-eligibility guard.
//
// A single reusable service that answers "may this employee provide
// availability / be scheduled right now?" and — when the answer is
// no — throws a typed domain error carrying the outstanding-training
// list. Both the Availability write path AND the (future) scheduling
// write path must call `assertSchedulingEligibility(employeeId)`
// immediately before persisting any row.
//
// Design invariants
//   - Eligibility is DERIVED. There is no `Employee.trainingComplete`
//     / `Employee.canBeScheduled` / any equivalent sticky boolean, and
//     this file never writes one. The B1 resolver is the single
//     authority.
//   - Optional applicable courses NEVER block. `outstandingTraining`
//     only surfaces required + not-completed items.
//   - Reads are cheap and non-audited. Writes remain audited via the
//     service that called us — this file does not itself emit audit
//     rows.
//   - The error carries display metadata (course titles) but never
//     internal course codes / version ids, so a UI translation can
//     surface it directly without stripping fields.

import {
  resolveEmployeeSchedulingEligibility,
  type OutstandingTrainingItem,
} from "./training/applicability";
import { AppError } from "../errors";

/** Display-safe outstanding-training item — no course codes, no
 *  version ids, no internal enums. */
export interface OutstandingTrainingTitle {
  courseId: string;
  title: string;
  category: string;
}

/** Thrown when a mutation requires the employee to be
 *  scheduling-eligible and the resolver says otherwise. HTTP 409. */
export class SchedulingIneligibleError extends AppError {
  readonly outstanding: OutstandingTrainingTitle[];
  readonly outstandingCount: number;

  constructor(outstanding: OutstandingTrainingItem[]) {
    const clean: OutstandingTrainingTitle[] = outstanding.map((o) => ({
      courseId: o.courseId,
      title: o.title,
      category: o.category,
    }));
    const n = clean.length;
    const safe = n === 1
      ? "Complete your required Safety & Training before this action."
      : `Complete ${n} required Safety & Training courses before this action.`;
    super("SCHEDULING_INELIGIBLE_TRAINING", safe, 409, safe);
    this.outstanding = clean;
    this.outstandingCount = n;
  }
}

/** Refuse the caller if the employee has any outstanding REQUIRED
 *  applicable training. Reads only — never mutates DB state. */
export async function assertSchedulingEligibility(employeeId: string): Promise<void> {
  const result = await resolveEmployeeSchedulingEligibility(employeeId);
  if (!result.eligible) {
    throw new SchedulingIneligibleError(result.outstandingTraining);
  }
}

/** Boolean form for surfaces that want to render an "eligible" branch
 *  vs an "ineligible" branch without a try/catch. Keep the guard
 *  above as the enforcement path. */
export async function isSchedulingEligible(employeeId: string): Promise<boolean> {
  const result = await resolveEmployeeSchedulingEligibility(employeeId);
  return result.eligible;
}

/** Convenience for surfaces that want both flags AND the outstanding
 *  list in one round-trip — e.g. the Availability page's ineligible
 *  banner. Returns display-safe titles only. */
export async function getSchedulingEligibilitySummary(
  employeeId: string,
): Promise<{ eligible: boolean; outstanding: OutstandingTrainingTitle[] }> {
  const result = await resolveEmployeeSchedulingEligibility(employeeId);
  return {
    eligible: result.eligible,
    outstanding: result.outstandingTraining.map((o) => ({
      courseId: o.courseId,
      title: o.title,
      category: o.category,
    })),
  };
}
