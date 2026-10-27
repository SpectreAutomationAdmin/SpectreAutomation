// SIGNUP-2 M1b-M1d (2026-10-26 .. 2026-10-27) -- Posting-guard caller registry.
//
// Enumerates every file in `src/` that calls `assertPostingAllowed`
// (open-paren excludes string references).  Each file carries an
// explicit classification:
//
//   MIGRATED      -- the file uses withPostingGuard OR passes {tx}
//                    on every call-site.  Zero bare calls remain.
//
//   PARTIAL_MIGRATED -- at least one call-site is migrated, but one
//                       or more remain on the legacy signature.
//                       Tracked for mechanical follow-on.
//                       Zero entries at M1d close.
//
//   TX_PENDING    -- opens prisma.$transaction around its write;
//                    mechanical migration is to move the
//                    assertPostingAllowed call inside the tx + pass
//                    {tx}.  Zero entries at M1d close.
//
//   NO_TX_PENDING -- does NOT currently use a transaction; migration
//                    requires wrapping writes in withPostingGuard.
//                    Zero entries at M1d close.
//
//   ADMIN_CONFIG_LEGACY -- admin-config edit that was previously
//                          exempt.  Reassessed per founder §5 (M1d);
//                          all four prior entries now MIGRATED.
//                          Zero entries at M1d close.
//
//   READ_ADJACENT -- imports `assertPostingAllowed` but the symbol
//                    appears only in comments or docstrings; no
//                    actual call-site (grep false positive).
//                    migrationTarget = "none-required".
//
// The static regression test tests/signup-2-m1d-strict-inventory.test.ts
// reconciles this inventory against the actual grep hits in `src/`.  CI
// fails if a new unguarded caller appears without a classification.
// The acceptance doc docs/signup-2-m1d-acceptance.md is this file's
// prose counterpart.

export type LegacyCallerClassification =
  | "MIGRATED"
  | "PARTIAL_MIGRATED"
  | "TX_PENDING"
  | "NO_TX_PENDING"
  | "ADMIN_CONFIG_LEGACY"
  | "READ_ADJACENT";

export interface LegacyCallerEntry {
  path: string;
  classification: LegacyCallerClassification;
  reason: string;
  migrationTarget: "withPostingGuard" | "assertPostingAllowed({tx})" | "none-required";
  // Approximate upper-bound race window if migration has not landed.
  // Zero / undefined on MIGRATED entries.
  residualRaceMs?: number;
}

export const LEGACY_POSTING_GUARD_CALLERS: Readonly<LegacyCallerEntry[]> = [
  // ====================================================================
  // FINANCIAL POSTING SURFACES -- high-priority, money-moving writes.
  // ====================================================================
  { path: "src/lib/accounting/journal.ts", classification: "MIGRATED", reason: "post + voidDraft + reverse + createPostedFromAdapter all run inside a tx with assertPostingAllowed({tx}) or withPostingGuard (M1b + M1d).", migrationTarget: "withPostingGuard" },
  { path: "src/lib/ap/invoices.ts", classification: "MIGRATED", reason: "postInvoice + reverseInvoice migrated to withPostingGuard (M1c).", migrationTarget: "withPostingGuard" },
  { path: "src/lib/ap/payments.ts", classification: "MIGRATED", reason: "processPayment + voidPayment migrated to withPostingGuard (M1c + M1d); payInvoice delegates to processPayment (pre-tx bare guard removed in M1d).", migrationTarget: "withPostingGuard" },
  { path: "src/lib/opening-balance/index.ts", classification: "MIGRATED", reason: "post function uses assertPostingAllowed({tx}) inside prisma.$transaction (M1c).", migrationTarget: "assertPostingAllowed({tx})" },
  { path: "src/lib/imports/index.ts", classification: "MIGRATED", reason: "void function + commitBatch COA branch + commitBatch OPENING_TRIAL_BALANCE branch each run assertPostingAllowed({tx}) inside their respective txs (M1c + M1d).  Non-financial branches (members/vendors/employees) are admin-config writes without posting-guard enforcement needed.", migrationTarget: "assertPostingAllowed({tx})" },
  { path: "src/lib/services/ar.ts", classification: "MIGRATED", reason: "postCharge/voidCharge/postPayment/voidPayment/postAdjustment/voidAdjustment wrap in withPostingGuard; reverseCharge uses assertPostingAllowed({tx}) inside existing tx (M1d).", migrationTarget: "withPostingGuard" },
  { path: "src/lib/payroll/approve-and-post.ts", classification: "MIGRATED", reason: "approvePayrollBatch wraps the CAS updateMany in withPostingGuard; postPayrollBatch runs assertPostingAllowed({tx}) inside both the REVERSAL-branch tx and the STANDARD-branch tx (M1d).", migrationTarget: "withPostingGuard" },
  { path: "src/lib/pos/checks.ts", classification: "MIGRATED", reason: "settleCheck: both branch point-of-no-return pOSCheck.update calls (CLOSED + PAYMENT_PENDING) wrapped in withPostingGuard; email + reservation calls deliberately kept OUTSIDE the guard'd tx (no external network calls while locks held) (M1d).", migrationTarget: "withPostingGuard" },
  { path: "src/lib/pos/index.ts", classification: "MIGRATED", reason: "completeSale + refundSale + voidSale (money-moving POS writes) each wrapped in withPostingGuard; inventory posting (via createPostedFromAdapter) stays outside the outer tx (M1d).", migrationTarget: "withPostingGuard" },
  { path: "src/lib/pos/lounge.ts", classification: "MIGRATED", reason: "ringUpLoungeSale wrapped in withPostingGuard; delegates to completeSale which re-acquires the lock atomically (M1d).", migrationTarget: "withPostingGuard" },
  // ====================================================================
  // HR + PAYROLL CONFIG + ADMIN WRITES -- state transitions that feed
  // future posting runs.  All migrated so a suspended tenant cannot
  // modify configuration that would unblock itself.
  // ====================================================================
  { path: "src/lib/hr/compensation.ts", classification: "MIGRATED", reason: "changeCompensation runs assertPostingAllowed({tx}) inside existing tx (M1d).", migrationTarget: "assertPostingAllowed({tx})" },
  { path: "src/lib/hr/employment-assignments.ts", classification: "MIGRATED", reason: "addAssignment uses assertPostingAllowed({tx}) inside existing tx; endAssignment wrapped in withPostingGuard (M1d).", migrationTarget: "withPostingGuard" },
  { path: "src/lib/hr/allowances.ts", classification: "MIGRATED", reason: "addAllowance + endAllowance wrapped in withPostingGuard (M1d).", migrationTarget: "withPostingGuard" },
  { path: "src/lib/hr/payroll-profile.ts", classification: "MIGRATED", reason: "activate + deactivate updates wrapped in withPostingGuard (M1d).", migrationTarget: "withPostingGuard" },
  { path: "src/lib/hr/training/courses.ts", classification: "MIGRATED", reason: "createCourse/publishDraft/startNewDraft/retireCourse use assertPostingAllowed({tx}) inside existing tx; updateDraft wrapped in withPostingGuard (M1d).", migrationTarget: "withPostingGuard" },
  { path: "src/lib/hr/training/questions.ts", classification: "MIGRATED", reason: "createQuestion/updateQuestion/reorderQuestions use assertPostingAllowed({tx}) inside existing tx; deleteQuestion wrapped in withPostingGuard (M1d).", migrationTarget: "withPostingGuard" },
  { path: "src/lib/hr/training/assignments.ts", classification: "MIGRATED", reason: "add: idempotency findFirst moved INSIDE the create tx; delete wrapped (M1d).", migrationTarget: "withPostingGuard" },
  { path: "src/lib/hr/training/video.ts", classification: "MIGRATED", reason: "DB row create wrapped in withPostingGuard; storage.put stays outside the lock (M1d).", migrationTarget: "withPostingGuard" },
  { path: "src/lib/employee-portal/quick-links.ts", classification: "MIGRATED", reason: "All CRUD + attach-file wrapped in withPostingGuard; storage.put stays outside the lock (M1d).", migrationTarget: "withPostingGuard" },
  { path: "src/lib/announcements.ts", classification: "MIGRATED", reason: "create/update/delete each wrap the single prisma write; audit stays outside (M1d).", migrationTarget: "withPostingGuard" },
  // Payroll (deep sub-tree) -- every file carries at least one guarded path.
  { path: "src/lib/payroll/batch-preparation.ts", classification: "MIGRATED", reason: "preparePayrollBatch + voidPayrollBatch + discardPreparedPayrollBatch move assertPostingAllowed into their respective existing txs (M1d).", migrationTarget: "assertPostingAllowed({tx})" },
  { path: "src/lib/payroll/batch-review.ts", classification: "MIGRATED", reason: "Attestation guard moved into existing tx (M1d).", migrationTarget: "assertPostingAllowed({tx})" },
  { path: "src/lib/payroll/benefit-enrolments.ts", classification: "MIGRATED", reason: "enrolEmployeeInBenefitPlan guard moved into existing tx (M1d).", migrationTarget: "assertPostingAllowed({tx})" },
  { path: "src/lib/payroll/benefit-plans.ts", classification: "MIGRATED", reason: "createBenefitPlan wrapped in withPostingGuard; changeBenefitPlanConfiguration guard moved into existing tx (M1d).", migrationTarget: "withPostingGuard" },
  { path: "src/lib/payroll/club-config.ts", classification: "MIGRATED", reason: "upsert + activate + deactivate wrapped in withPostingGuard.  Reclassified from ADMIN_CONFIG_LEGACY per founder §5 (M1d).", migrationTarget: "withPostingGuard" },
  { path: "src/lib/payroll/correction.ts", classification: "MIGRATED", reason: "initiate + patch moved guard into existing txs (M1d).", migrationTarget: "assertPostingAllowed({tx})" },
  { path: "src/lib/payroll/cpp-election.ts", classification: "MIGRATED", reason: "stop + revocation wrapped in withPostingGuard (M1d).", migrationTarget: "withPostingGuard" },
  { path: "src/lib/payroll/department-approval.ts", classification: "MIGRATED", reason: "approval upsert/update wrapped in withPostingGuard (M1d).", migrationTarget: "withPostingGuard" },
  { path: "src/lib/payroll/freeze-service.ts", classification: "MIGRATED", reason: "Freeze guard moved into existing tx (M1d).", migrationTarget: "assertPostingAllowed({tx})" },
  { path: "src/lib/payroll/late-time-service.ts", classification: "MIGRATED", reason: "Late-time guard moved into existing tx after the OPEN->resolved CAS (M1d).", migrationTarget: "assertPostingAllowed({tx})" },
  { path: "src/lib/payroll/opening-balance.ts", classification: "MIGRATED", reason: "6 call-sites: 2 moved into existing txs with {tx}, 4 wrapped in withPostingGuard; findFirst dedupe checks moved INSIDE the guarded tx so they serialise against suspension (M1d).", migrationTarget: "withPostingGuard" },
  { path: "src/lib/payroll/opening-balance-import.ts", classification: "MIGRATED", reason: "Pre-tx bare guard removed; function delegates to createDraftOpeningBalance per row, each with its own guard (M1d).", migrationTarget: "none-required" },
  { path: "src/lib/payroll/pay-group-auto-assign.ts", classification: "MIGRATED", reason: "Create wrapped in withPostingGuard; SKIPPED-outcome branches short-circuit above the guard (M1d).", migrationTarget: "withPostingGuard" },
  { path: "src/lib/payroll/pay-group-members.ts", classification: "MIGRATED", reason: "assignMembership + endMembership wrapped in withPostingGuard; transferMembership moved guard into existing tx (M1d).", migrationTarget: "withPostingGuard" },
  { path: "src/lib/payroll/pay-groups.ts", classification: "MIGRATED", reason: "createPayGroup + updatePayGroup wrapped in withPostingGuard.  Reclassified from ADMIN_CONFIG_LEGACY per founder §5 (M1d).", migrationTarget: "withPostingGuard" },
  { path: "src/lib/payroll/pay-periods.ts", classification: "MIGRATED", reason: "generatePayPeriods moved guard into existing tx; updateFuturePayPeriodBoundaries + updatePayGroupPeriodBoundaryStrategy wrapped in withPostingGuard (M1d).", migrationTarget: "withPostingGuard" },
  { path: "src/lib/payroll/approved-time.ts", classification: "MIGRATED", reason: "create/update/delete each wrap the single prisma write; pre-reads stay outside (M1d).", migrationTarget: "withPostingGuard" },
  { path: "src/lib/payroll/return-payroll-batch.ts", classification: "MIGRATED", reason: "Return guard moved into existing tx after the SUBMITTED_FOR_APPROVAL->RETURNED CAS (M1d).", migrationTarget: "assertPostingAllowed({tx})" },
  { path: "src/lib/payroll/return-to-preparation.ts", classification: "MIGRATED", reason: "Guard moved into existing tx (M1d).", migrationTarget: "assertPostingAllowed({tx})" },
  { path: "src/lib/payroll/reversal.ts", classification: "MIGRATED", reason: "Reversal guard moved into existing tx (M1d).", migrationTarget: "assertPostingAllowed({tx})" },
  { path: "src/lib/payroll/scheduled-one-time-earning.ts", classification: "MIGRATED", reason: "Resurrect-vs-create branch + edit + cancel each wrapped in withPostingGuard (M1d).", migrationTarget: "withPostingGuard" },
  { path: "src/lib/payroll/submit-payroll-batch.ts", classification: "MIGRATED", reason: "Submit guard moved into existing tx after the CALCULATED->SUBMITTED CAS (M1d).", migrationTarget: "assertPostingAllowed({tx})" },
  { path: "src/lib/payroll/zero-hours-acknowledgement.ts", classification: "MIGRATED", reason: "Ack upsert + PayrollBatchException.updateMany wrapped atomically in withPostingGuard (M1d).", migrationTarget: "withPostingGuard" },
  // Non-payroll operational.
  { path: "src/lib/ops/inventory.ts", classification: "MIGRATED", reason: "postReceiving uses assertPostingAllowed({tx}) inside existing tx; postAdjustment + postSale wrapped in withPostingGuard; GL adapter stays outside the guard'd tx (M1d).", migrationTarget: "withPostingGuard" },
  { path: "src/lib/timesheets/manager-approval.ts", classification: "MIGRATED", reason: "approveTimesheetScope guard moved into existing tx (M1d).", migrationTarget: "assertPostingAllowed({tx})" },
  { path: "src/lib/club/media.ts", classification: "MIGRATED", reason: "setClubMedia + clearClubMedia + updateClubMediaFraming + resetClubMediaFraming wrapped in withPostingGuard; storage.put stays outside the lock.  Reclassified from ADMIN_CONFIG_LEGACY per founder §5 (M1d).", migrationTarget: "withPostingGuard" },
  // ====================================================================
  // READ_ADJACENT -- grep false positives (symbol in comments only).
  // ====================================================================
  { path: "src/lib/hr/sensitive-identity.ts", classification: "READ_ADJACENT", reason: "Imports symbol only in comment (SIN reveal is NOT a financial posting).  No runtime call-site.", migrationTarget: "none-required" },
  { path: "src/lib/permissions.ts", classification: "READ_ADJACENT", reason: "Legacy registry comment only; no runtime call-site to assertPostingAllowed.", migrationTarget: "none-required" },
];

/** The set of paths currently permitted to call assertPostingAllowed
 *  without `{tx}` or `withPostingGuard`.  At M1d close this is empty
 *  except for the two READ_ADJACENT entries whose "calls" are comment-only. */
export const LEGACY_EXEMPT_PATHS: ReadonlySet<string> = new Set(
  LEGACY_POSTING_GUARD_CALLERS
    .filter((e) => e.classification !== "MIGRATED")
    .map((e) => e.path),
);
