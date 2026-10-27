// SIGNUP-2 M1b (2026-10-26) -- Legacy posting-guard call-site registry.
//
// Enumerates every file in `src/` that calls `assertPostingAllowed`
// without passing a `{tx}` parameter and without being wrapped in
// `withPostingGuard`.  Each file carries an explicit classification:
//
//   MIGRATED      -- the file uses withPostingGuard or passes {tx}.
//                    (These should NOT appear here; they're
//                    enumerated for documentation only.)
//
//   TX_PENDING    -- the file already opens prisma.$transaction
//                    around its write; mechanical migration is to
//                    move the assertPostingAllowed call inside the
//                    tx + pass {tx}.  Residual race window: ~ 10-500 ms
//                    between the pre-tx guard call and the tx commit.
//
//   NO_TX_PENDING -- the file does NOT currently use a transaction;
//                    migration requires wrapping writes in
//                    withPostingGuard.  Residual race window: ~ 10-100 ms.
//
//   ADMIN_CONFIG_LEGACY -- the file is an admin-config edit (STAGED-
//                          tier capable), small single-row writes;
//                          race window bounded at ms scale; bounded
//                          financial risk; migration planned but not
//                          launch-blocking.
//
//   READ_ADJACENT -- the file imports `assertPostingAllowed` but
//                    the symbol appears only in comments or docstrings;
//                    no actual call-site (grep false positive).
//
// Any file that calls `assertPostingAllowed` without `{tx}` or
// `withPostingGuard` AND is not in this registry fails the static
// guard-inventory test (`tests/signup-2-m1b-caller-inventory.test.ts`).
//
// The acceptance doc docs/signup-2-m1b-acceptance.md §2 is this
// file's prose counterpart.

export type LegacyCallerClassification =
  | "MIGRATED"
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
  residualRaceMs?: number;
}

export const LEGACY_POSTING_GUARD_CALLERS: Readonly<LegacyCallerEntry[]> = [
  // ---- MIGRATED (reference) ----
  {
    path: "src/lib/accounting/journal.ts",
    classification: "MIGRATED",
    reason: "post + voidDraft migrated to withPostingGuard (M1b).",
    migrationTarget: "withPostingGuard",
  },
  // ---- TX_PENDING (29 files) ----
  { path: "src/lib/ap/invoices.ts", classification: "TX_PENDING", reason: "AP invoice post + reverse already open prisma.$transaction; mechanical migration.", migrationTarget: "assertPostingAllowed({tx})", residualRaceMs: 200 },
  { path: "src/lib/employee-portal/quick-links.ts", classification: "TX_PENDING", reason: "Employee-portal quick-links CRUD; small tx scope.", migrationTarget: "assertPostingAllowed({tx})", residualRaceMs: 50 },
  { path: "src/lib/hr/compensation.ts", classification: "TX_PENDING", reason: "HR compensation changes; audit + employee row update inside existing tx.", migrationTarget: "assertPostingAllowed({tx})", residualRaceMs: 100 },
  { path: "src/lib/hr/employment-assignments.ts", classification: "TX_PENDING", reason: "Employment assignment add/end; tx-bound.", migrationTarget: "assertPostingAllowed({tx})", residualRaceMs: 100 },
  { path: "src/lib/hr/training/courses.ts", classification: "TX_PENDING", reason: "Training course publish + version update; tx-bound.", migrationTarget: "assertPostingAllowed({tx})", residualRaceMs: 100 },
  { path: "src/lib/hr/training/questions.ts", classification: "TX_PENDING", reason: "Training question edits; tx-bound.", migrationTarget: "assertPostingAllowed({tx})", residualRaceMs: 50 },
  { path: "src/lib/imports/index.ts", classification: "TX_PENDING", reason: "ImportBatch commit + void; large tx (COA, opening balance).  High priority.", migrationTarget: "assertPostingAllowed({tx})", residualRaceMs: 2000 },
  { path: "src/lib/opening-balance/index.ts", classification: "TX_PENDING", reason: "Opening balance post; tx-bound.", migrationTarget: "assertPostingAllowed({tx})", residualRaceMs: 500 },
  { path: "src/lib/ops/inventory.ts", classification: "TX_PENDING", reason: "Inventory receive + adjust; tx-bound.", migrationTarget: "assertPostingAllowed({tx})", residualRaceMs: 100 },
  { path: "src/lib/payroll/approve-and-post.ts", classification: "TX_PENDING", reason: "Payroll batch approve + post; large tx with JE write.  High priority.", migrationTarget: "assertPostingAllowed({tx})", residualRaceMs: 2000 },
  { path: "src/lib/payroll/batch-preparation.ts", classification: "TX_PENDING", reason: "Batch preparation state advances; tx-bound.", migrationTarget: "assertPostingAllowed({tx})", residualRaceMs: 100 },
  { path: "src/lib/payroll/batch-review.ts", classification: "TX_PENDING", reason: "Batch review state advance; tx-bound.", migrationTarget: "assertPostingAllowed({tx})", residualRaceMs: 100 },
  { path: "src/lib/payroll/benefit-enrolments.ts", classification: "TX_PENDING", reason: "Benefit enrolment CRUD; tx-bound.", migrationTarget: "assertPostingAllowed({tx})", residualRaceMs: 100 },
  { path: "src/lib/payroll/benefit-plans.ts", classification: "TX_PENDING", reason: "Benefit plan CRUD; tx-bound.", migrationTarget: "assertPostingAllowed({tx})", residualRaceMs: 100 },
  { path: "src/lib/payroll/correction.ts", classification: "TX_PENDING", reason: "Payroll correction batch creation; tx-bound.", migrationTarget: "assertPostingAllowed({tx})", residualRaceMs: 200 },
  { path: "src/lib/payroll/freeze-service.ts", classification: "TX_PENDING", reason: "Payroll period freeze; tx-bound.", migrationTarget: "assertPostingAllowed({tx})", residualRaceMs: 100 },
  { path: "src/lib/payroll/late-time-service.ts", classification: "TX_PENDING", reason: "Late-time entry adjustments; tx-bound.", migrationTarget: "assertPostingAllowed({tx})", residualRaceMs: 100 },
  { path: "src/lib/payroll/opening-balance.ts", classification: "TX_PENDING", reason: "Payroll YTD opening balance writes; tx-bound.", migrationTarget: "assertPostingAllowed({tx})", residualRaceMs: 500 },
  { path: "src/lib/payroll/pay-group-members.ts", classification: "TX_PENDING", reason: "Pay-group member add/remove; tx-bound.", migrationTarget: "assertPostingAllowed({tx})", residualRaceMs: 100 },
  { path: "src/lib/payroll/pay-periods.ts", classification: "TX_PENDING", reason: "Pay period create/close; tx-bound.", migrationTarget: "assertPostingAllowed({tx})", residualRaceMs: 100 },
  { path: "src/lib/payroll/return-payroll-batch.ts", classification: "TX_PENDING", reason: "Return payroll batch state advance; tx-bound.", migrationTarget: "assertPostingAllowed({tx})", residualRaceMs: 100 },
  { path: "src/lib/payroll/return-to-preparation.ts", classification: "TX_PENDING", reason: "Return-to-preparation state advance; tx-bound.", migrationTarget: "assertPostingAllowed({tx})", residualRaceMs: 100 },
  { path: "src/lib/payroll/reversal.ts", classification: "TX_PENDING", reason: "Payroll reversal; tx-bound.", migrationTarget: "assertPostingAllowed({tx})", residualRaceMs: 500 },
  { path: "src/lib/payroll/submit-payroll-batch.ts", classification: "TX_PENDING", reason: "Submit payroll batch; tx-bound.", migrationTarget: "assertPostingAllowed({tx})", residualRaceMs: 100 },
  { path: "src/lib/pos/checks.ts", classification: "TX_PENDING", reason: "POS check settlement; tx-bound.", migrationTarget: "assertPostingAllowed({tx})", residualRaceMs: 300 },
  { path: "src/lib/services/ar.ts", classification: "TX_PENDING", reason: "AR charge/payment/adjustment post + void; tx-bound.  High priority.", migrationTarget: "assertPostingAllowed({tx})", residualRaceMs: 500 },
  { path: "src/lib/timesheets/manager-approval.ts", classification: "TX_PENDING", reason: "Timesheet manager approval state advance; tx-bound.", migrationTarget: "assertPostingAllowed({tx})", residualRaceMs: 100 },
  // ---- NO_TX_PENDING (20 files) ----
  { path: "src/lib/announcements.ts", classification: "NO_TX_PENDING", reason: "Announcement create; single-row admin write; small race window.", migrationTarget: "withPostingGuard", residualRaceMs: 50 },
  { path: "src/lib/ap/payments.ts", classification: "NO_TX_PENDING", reason: "AP payment pay/process; needs tx wrapping.  High priority (money movement).", migrationTarget: "withPostingGuard", residualRaceMs: 500 },
  { path: "src/lib/club/media.ts", classification: "ADMIN_CONFIG_LEGACY", reason: "Club media CRUD (logo/cover upload); admin-config write; bounded ms race; low financial risk.", migrationTarget: "withPostingGuard", residualRaceMs: 50 },
  { path: "src/lib/hr/allowances.ts", classification: "NO_TX_PENDING", reason: "Allowance add/end; HR write.", migrationTarget: "withPostingGuard", residualRaceMs: 100 },
  { path: "src/lib/hr/payroll-profile.ts", classification: "NO_TX_PENDING", reason: "Payroll profile upsert/void; HR write.", migrationTarget: "withPostingGuard", residualRaceMs: 100 },
  { path: "src/lib/hr/sensitive-identity.ts", classification: "READ_ADJACENT", reason: "Imports symbol only in comment (SIN reveal is NOT a financial posting; see file comment).  No call-site.", migrationTarget: "none-required" },
  { path: "src/lib/hr/training/assignments.ts", classification: "NO_TX_PENDING", reason: "Training assignment add/update; HR write.", migrationTarget: "withPostingGuard", residualRaceMs: 100 },
  { path: "src/lib/hr/training/video.ts", classification: "NO_TX_PENDING", reason: "Training video upload; admin-config write.", migrationTarget: "withPostingGuard", residualRaceMs: 100 },
  { path: "src/lib/payroll/approved-time.ts", classification: "NO_TX_PENDING", reason: "Time entry create; small single-row write.", migrationTarget: "withPostingGuard", residualRaceMs: 100 },
  { path: "src/lib/payroll/club-config.ts", classification: "ADMIN_CONFIG_LEGACY", reason: "Payroll club config edits; admin-config write.", migrationTarget: "withPostingGuard", residualRaceMs: 50 },
  { path: "src/lib/payroll/cpp-election.ts", classification: "NO_TX_PENDING", reason: "CPP election set/clear; small single-row write.", migrationTarget: "withPostingGuard", residualRaceMs: 50 },
  { path: "src/lib/payroll/department-approval.ts", classification: "NO_TX_PENDING", reason: "Department approval advance; state write.", migrationTarget: "withPostingGuard", residualRaceMs: 100 },
  { path: "src/lib/payroll/opening-balance-import.ts", classification: "NO_TX_PENDING", reason: "Payroll opening balance import kickoff; needs tx wrapping.", migrationTarget: "withPostingGuard", residualRaceMs: 500 },
  { path: "src/lib/payroll/pay-group-auto-assign.ts", classification: "NO_TX_PENDING", reason: "Pay-group auto-assign; small single-row write.", migrationTarget: "withPostingGuard", residualRaceMs: 100 },
  { path: "src/lib/payroll/pay-groups.ts", classification: "ADMIN_CONFIG_LEGACY", reason: "Pay-group CRUD; admin-config write.", migrationTarget: "withPostingGuard", residualRaceMs: 50 },
  { path: "src/lib/payroll/scheduled-one-time-earning.ts", classification: "NO_TX_PENDING", reason: "Scheduled one-time earning create/edit; HR write.", migrationTarget: "withPostingGuard", residualRaceMs: 100 },
  { path: "src/lib/payroll/zero-hours-acknowledgement.ts", classification: "NO_TX_PENDING", reason: "Zero-hours ack write; small single-row write.", migrationTarget: "withPostingGuard", residualRaceMs: 50 },
  { path: "src/lib/permissions.ts", classification: "READ_ADJACENT", reason: "Legacy registry comment only; no runtime call-site to assertPostingAllowed.", migrationTarget: "none-required" },
  { path: "src/lib/pos/index.ts", classification: "ADMIN_CONFIG_LEGACY", reason: "POS admin / server index; config edits; bounded ms race.", migrationTarget: "withPostingGuard", residualRaceMs: 50 },
  { path: "src/lib/pos/lounge.ts", classification: "ADMIN_CONFIG_LEGACY", reason: "Lounge POS config; admin-config write.", migrationTarget: "withPostingGuard", residualRaceMs: 50 },
];

/** The set of paths currently permitted to call assertPostingAllowed
 *  without `{tx}` or `withPostingGuard`.  Any file not in this set
 *  AND not already migrated fails the static inventory test. */
export const LEGACY_EXEMPT_PATHS: ReadonlySet<string> = new Set(
  LEGACY_POSTING_GUARD_CALLERS
    .filter((e) => e.classification !== "MIGRATED")
    .map((e) => e.path),
);
