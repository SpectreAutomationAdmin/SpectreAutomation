// TB-RESET-1b — Coulee Ridge fixture GL neutralization manifest.
//
// One-shot, narrowly-scoped, provenance-based reset of the 29 POSTED
// JournalEntries currently on Coulee Ridge staging (clubId
// cmrvdeny7000144372ktmmg9c). The 1a investigation (see
// test-results/tb-reset-1a-rollback-9ea0ad4.json) proved every one of
// those 29 entries was produced by Spectre staging/testing activity
// and none of it represents authoritative Jonas accounting history.
//
// Founder authorization: TB-RESET-1b brief, 2026-09-28.
//
// Method — accounting-safe reversal only:
//   - Where an original + existing SYSTEM_REVERSAL contra already net
//     to zero on the TB, leave the pair alone (PRESERVED set).
//   - Where a POSTED entry is not yet reversed AND is proven-fixture,
//     post a new SYSTEM_REVERSAL contra using the reverse() primitive
//     at src/lib/accounting/journal.ts:370.
//   - Neither JournalEntry nor JournalEntryLine is ever deleted.
//   - PayrollBatch, APInvoice, PaymentInstruction, PaymentRun business
//     records are preserved; only their linked JEs get a reversing
//     contra.
//
// This file is the authoritative manifest. Both the test suite
// (tests/accounting/tb-reset-1b.test.ts) and the execution harness
// (scripts/tb-reset-1b-execute.mjs) read from it.

/** The single Coulee Ridge staging club id. Hard-coded as a safety
 *  guard — TB-RESET-1b MUST NEVER run against any other tenant. */
export const TB_RESET_1B_COULEE_CLUB_ID = "cmrvdeny7000144372ktmmg9c";

/** The 1010-PAY1A Account row id on Coulee (proved by 1a inspection). */
export const TB_RESET_1B_PAY1A_ACCOUNT_ID = "cmuizrvru0004gmti1pc1j002";

/** The PAY-1A Simulated Operating Account BankAccount row id (proved by
 *  1a inspection). Retired via status → "INACTIVE" in slice 1b. */
export const TB_RESET_1B_PAY1A_BANK_ACCOUNT_ID = "cmuizrvw90006gmti4ounz5ix";

/** Rename target for the PAY1A account. Matches the LEGACY-3F precedent
 *  established by scripts/coulee-cleanup-execute.mjs (renamed rather
 *  than deleted so all historical FKs from PaymentInstruction /
 *  BankAccount / JournalEntryLine survive). */
export const TB_RESET_1B_PAY1A_NEW_ACCOUNT_NUMBER = "LEGACY-PAY1A";
export const TB_RESET_1B_PAY1A_NEW_ACCOUNT_NAME = "LEGACY-PAY1A · Simulated Operating Cash";

/** Rollback anchor (git SHA of the 1a evidence tree). Present in the
 *  script's confirmation-token check to make the token specific to this
 *  reset execution. */
export const TB_RESET_1B_ROLLBACK_ANCHOR_SHA = "9ea0ad4c15bd42c41158cc1e36d5102b37e62aad";
export const TB_RESET_1B_ROLLBACK_ANCHOR_FLY_RELEASE = 595;
export const TB_RESET_1B_CONFIRM_TOKEN = "COULEE-9EA0AD4";

/** REVERSAL TARGETS — 13 POSTED JournalEntries that currently
 *  contribute a non-zero balance to the derived Trial Balance and are
 *  proven Spectre-staging fixture activity by the 1a evidence.
 *
 *  Every entry here has `reversesId=null` and is not yet reversed by
 *  another entry (verified in 1a inspection). Reversing each one via
 *  the standard reverse() primitive posts a SYSTEM_REVERSAL contra
 *  with swapped DR/CR, leaving both entries POSTED and the account
 *  balances at zero.
 *
 *  Order of the list matches the accounting-narrative grouping in the
 *  1a report. Execution order in the script is chronological by
 *  entryDate.
 */
export interface TbReset1bReversalTarget {
  jeId: string;
  entryNumber: string;
  source: string;
  sourceEntityType: string;
  sourceEntityId: string;
  totalDebits: string;
  reasonGroup: string;
  reason: string;
}

export const TB_RESET_1B_REVERSAL_TARGETS: readonly TbReset1bReversalTarget[] = Object.freeze([
  // 1 · Microsoft AP staging invoice (2026-08-15)
  {
    jeId: "cmsun7a7x006w102f8i51a8hd",
    entryNumber: "JE-2026-000001",
    source: "AP_INVOICE",
    sourceEntityType: "APInvoice",
    sourceEntityId: "cmsun7a5g006s102fetrqqein",
    totalDebits: "31.29",
    reasonGroup: "MICROSOFT_AP_TEST_INVOICE",
    reason: "TB-RESET-1b: Microsoft Corporation AP-2026-000001 (E0701097E3) — staging test invoice per founder authorization",
  },
  // 2 · Known-fixture PAY1A-ACC PayrollBatch (2026-11-21)
  {
    jeId: "cmtzye888002brm2sjsgh6hc1",
    entryNumber: "JE-2026-000002",
    source: "PAYROLL",
    sourceEntityType: "PayrollBatch",
    sourceEntityId: "cmtzxy7f30006rm2s31rcv8rp",
    totalDebits: "2156.63",
    reasonGroup: "PAY1A_ACC_FIXTURE_BATCH",
    reason: "TB-RESET-1b: PAY1A-ACC known-fixture PayrollBatch (documented in coulee-cleanup-execute.mjs:16)",
  },
  // 3–8 · Six unpaired CRGCC-SM semi-monthly payroll originals
  //     (their corrected re-posts + original+REVERSAL pairs are in the PRESERVED set)
  {
    jeId: "cmubxfv2p001ewzv24y14ba81",
    entryNumber: "JE-2026-000003",
    source: "PAYROLL",
    sourceEntityType: "PayrollBatch",
    sourceEntityId: "cmual2acx002tegdvxrr4lrzo",
    totalDebits: "5236.78",
    reasonGroup: "CRGCC_SM_STAGING_PAYROLL",
    reason: "TB-RESET-1b: CRGCC-SM 2026-08-24→2026-09-15 staging payroll test batch (xrr4lrzo)",
  },
  {
    jeId: "cmuc49pe3005ac76460zu5qfu",
    entryNumber: "JE-2026-000008",
    source: "PAYROLL",
    sourceEntityType: "PayrollBatch",
    sourceEntityId: "cmuc49b5r003dc7644khl6phl",
    totalDebits: "8828.56",
    reasonGroup: "CRGCC_SM_STAGING_PAYROLL",
    reason: "TB-RESET-1b: CRGCC-SM 2026-10-01→2026-10-15 corrected re-post (4khl6phl)",
  },
  {
    jeId: "cmuc80avs001vspq0nk113sq8",
    entryNumber: "JE-2026-000013",
    source: "PAYROLL",
    sourceEntityType: "PayrollBatch",
    sourceEntityId: "cmuc7ku8z003d9w4k69s9vym7",
    totalDebits: "8789.00",
    reasonGroup: "CRGCC_SM_STAGING_PAYROLL",
    reason: "TB-RESET-1b: CRGCC-SM 2026-11-01→2026-11-13 corrected re-post (69s9vym7)",
  },
  {
    jeId: "cmuc84p2d008xspq0503y10b5",
    entryNumber: "JE-2026-000016",
    source: "PAYROLL",
    sourceEntityType: "PayrollBatch",
    sourceEntityId: "cmuc84k6q005nspq0tj7ng25v",
    totalDebits: "8789.00",
    reasonGroup: "CRGCC_SM_STAGING_PAYROLL",
    reason: "TB-RESET-1b: CRGCC-SM 2026-11-16→2026-11-30 corrected re-post (tj7ng25v)",
  },
  {
    jeId: "cmuc8l829006s4dpr72evwc5y",
    entryNumber: "JE-2026-000019",
    source: "PAYROLL",
    sourceEntityType: "PayrollBatch",
    sourceEntityId: "cmuc8l2rp003d4dpr92pfh6gn",
    totalDebits: "8622.67",
    reasonGroup: "CRGCC_SM_STAGING_PAYROLL",
    reason: "TB-RESET-1b: CRGCC-SM 2026-12-01→2026-12-15 corrected re-post (92pfh6gn)",
  },
  {
    jeId: "cmucbcg3q001i5kdjbymn5ahz",
    entryNumber: "JE-2026-000022",
    source: "PAYROLL",
    sourceEntityType: "PayrollBatch",
    sourceEntityId: "cmuca9krd003db0vb0k3d0uon",
    totalDebits: "9332.38",
    reasonGroup: "CRGCC_SM_STAGING_PAYROLL",
    reason: "TB-RESET-1b: CRGCC-SM 2026-12-16→2026-12-31 corrected re-post (0k3d0uon)",
  },
  // 9–13 · Five unpaired PAY-1A settlement JEs (the settle+return
  //       pair JE-000025+JE-000026 already nets to zero; PRESERVED)
  {
    jeId: "cmuj0p4b9001sq97nhdage3fn",
    entryNumber: "JE-2026-000023",
    source: "PAYMENTS",
    sourceEntityType: "PaymentInstruction",
    sourceEntityId: "cmuj0o2sy000kq97n191lq1mz",
    totalDebits: "3037.33",
    reasonGroup: "PAY1A_STAGING_SETTLEMENT",
    reason: "TB-RESET-1b: PAY-1A settlement staging test · instruction 191lq1mz",
  },
  {
    jeId: "cmuj0p4gz0020q97n24mlj6j4",
    entryNumber: "JE-2026-000024",
    source: "PAYMENTS",
    sourceEntityType: "PaymentInstruction",
    sourceEntityId: "cmuj0o2ux000oq97nixyg0e0u",
    totalDebits: "1543.90",
    reasonGroup: "PAY1A_STAGING_SETTLEMENT",
    reason: "TB-RESET-1b: PAY-1A settlement staging test · instruction ixyg0e0u",
  },
  {
    jeId: "cmuj2l9d3001kwkleve3t22q2",
    entryNumber: "JE-2026-000027",
    source: "PAYMENTS",
    sourceEntityType: "PaymentInstruction",
    sourceEntityId: "cmuj2kq9d000kwklehd662hn4",
    totalDebits: "250.00",
    reasonGroup: "PAY1A_STAGING_SETTLEMENT",
    reason: "TB-RESET-1b: PAY-1A settlement staging test · instruction hd662hn4",
  },
  {
    jeId: "cmuj487o5001ha5cz6fvjnzdb",
    entryNumber: "JE-2026-000028",
    source: "PAYMENTS",
    sourceEntityType: "PaymentInstruction",
    sourceEntityId: "cmuj485mz000ka5czwqgei4rz",
    totalDebits: "100.00",
    reasonGroup: "PAY1A_STAGING_SETTLEMENT",
    reason: "TB-RESET-1b: PAY-1A settlement staging test · instruction wqgei4rz",
  },
  {
    jeId: "cmuj48chm003ua5cztc009k9a",
    entryNumber: "JE-2026-000029",
    source: "PAYMENTS",
    sourceEntityType: "PaymentInstruction",
    sourceEntityId: "cmuj48aqy002xa5cz37obvhpc",
    totalDebits: "120.00",
    reasonGroup: "PAY1A_STAGING_SETTLEMENT",
    reason: "TB-RESET-1b: PAY-1A settlement staging test · instruction 37obvhpc",
  },
]);

/** PRESERVED — 16 POSTED JournalEntries that already net to zero
 *  (either an original + existing SYSTEM_REVERSAL pair, or a
 *  settle+return pair on 1010-PAY1A). Documented for audit; the
 *  execution harness explicitly asserts none of these appear in the
 *  reversal set, per founder rule "do not create unnecessary
 *  additional reversals that would reintroduce a balance."
 */
export const TB_RESET_1B_PRESERVED_PAIRED_JES: readonly {
  jeId: string;
  entryNumber: string;
  pairKind: "PAYROLL_ORIGINAL_AND_REVERSAL" | "PAY1A_SETTLE_AND_RETURN";
  pairedWith: string;
}[] = Object.freeze([
  // Seven CRGCC-SM payroll original+REVERSAL pairs
  { jeId: "cmuc2ve2s0022xhieylcrhq65", entryNumber: "JE-2026-000004", pairKind: "PAYROLL_ORIGINAL_AND_REVERSAL", pairedWith: "JE-2026-000005" },
  { jeId: "cmuc2vo64003nxhieczh500fk", entryNumber: "JE-2026-000005", pairKind: "PAYROLL_ORIGINAL_AND_REVERSAL", pairedWith: "JE-2026-000004" },
  { jeId: "cmuc497n60022c764wkf7lp43", entryNumber: "JE-2026-000006", pairKind: "PAYROLL_ORIGINAL_AND_REVERSAL", pairedWith: "JE-2026-000007" },
  { jeId: "cmuc49fqm003wc764hw7q4on4", entryNumber: "JE-2026-000007", pairKind: "PAYROLL_ORIGINAL_AND_REVERSAL", pairedWith: "JE-2026-000006" },
  { jeId: "cmuc785l10022882jexa1ldwd", entryNumber: "JE-2026-000009", pairKind: "PAYROLL_ORIGINAL_AND_REVERSAL", pairedWith: "JE-2026-000010" },
  { jeId: "cmuc787bw004a882jky79fsrk", entryNumber: "JE-2026-000010", pairKind: "PAYROLL_ORIGINAL_AND_REVERSAL", pairedWith: "JE-2026-000009" },
  { jeId: "cmuc7ktbb00229w4kyc6rryo8", entryNumber: "JE-2026-000011", pairKind: "PAYROLL_ORIGINAL_AND_REVERSAL", pairedWith: "JE-2026-000012" },
  { jeId: "cmuc7kv3d004a9w4knzcifd5x", entryNumber: "JE-2026-000012", pairKind: "PAYROLL_ORIGINAL_AND_REVERSAL", pairedWith: "JE-2026-000011" },
  { jeId: "cmuc84j96004cspq0bu1l9f74", entryNumber: "JE-2026-000014", pairKind: "PAYROLL_ORIGINAL_AND_REVERSAL", pairedWith: "JE-2026-000015" },
  { jeId: "cmuc84l0s006kspq0xmj6ma2z", entryNumber: "JE-2026-000015", pairKind: "PAYROLL_ORIGINAL_AND_REVERSAL", pairedWith: "JE-2026-000014" },
  { jeId: "cmuc8kylf000g4dpr4odi1qoo", entryNumber: "JE-2026-000017", pairKind: "PAYROLL_ORIGINAL_AND_REVERSAL", pairedWith: "JE-2026-000018" },
  { jeId: "cmuc8l2di002k4dpr4v9rjvqk", entryNumber: "JE-2026-000018", pairKind: "PAYROLL_ORIGINAL_AND_REVERSAL", pairedWith: "JE-2026-000017" },
  { jeId: "cmuca9gui000gb0vbmf4m393z", entryNumber: "JE-2026-000020", pairKind: "PAYROLL_ORIGINAL_AND_REVERSAL", pairedWith: "JE-2026-000021" },
  { jeId: "cmuca9kd6002kb0vbk0cfw4cb", entryNumber: "JE-2026-000021", pairKind: "PAYROLL_ORIGINAL_AND_REVERSAL", pairedWith: "JE-2026-000020" },
  // One PAY-1A settle+return pair on the same PaymentInstruction
  { jeId: "cmuj17nu50025expe35pxr6my", entryNumber: "JE-2026-000025", pairKind: "PAY1A_SETTLE_AND_RETURN", pairedWith: "JE-2026-000026" },
  { jeId: "cmuj17oez002gexpec96eckya", entryNumber: "JE-2026-000026", pairKind: "PAY1A_SETTLE_AND_RETURN", pairedWith: "JE-2026-000025" },
]);

/** Every POSTED JournalEntry on Coulee at rollback-anchor SHA
 *  9ea0ad4. Manifest sanity: the union of REVERSAL_TARGETS and
 *  PRESERVED_PAIRED_JES equals this exact set (proved by unit test).
 *  Membership here is documentation-only.
 */
export const TB_RESET_1B_ALL_29_JES_AT_ANCHOR: readonly string[] = Object.freeze([
  ...TB_RESET_1B_REVERSAL_TARGETS.map((t) => t.jeId),
  ...TB_RESET_1B_PRESERVED_PAIRED_JES.map((p) => p.jeId),
]);

/** Exhaustive post-condition specification. The harness (and the
 *  final vitest e2e-against-staging integration test, once ready)
 *  verify these hold after commit. */
export const TB_RESET_1B_ACCEPTANCE_SPEC = Object.freeze({
  derivedTb: { debit: "0.00", credit: "0.00", difference: "0.00" },
  activeLegitimateAccountCount: 237,
  inactiveAccountsMustInclude: Object.freeze([
    "2100", "2110", "2120", "2130", "2140", "5100", "5110", "5120", // LEGACY-3F
    "LEGACY-PAY1A", // the renamed 1010-PAY1A
  ]),
  pay1a: {
    accountNumber: "LEGACY-PAY1A",
    name: "LEGACY-PAY1A · Simulated Operating Cash",
    isActive: false,
    bankAccountStatus: "INACTIVE",
  },
  reversalContrasCreated: 13,
  originalPOSTEDCount: 29, // originals still POSTED (never deleted)
  totalPOSTEDCountAfter: 42, // 29 originals + 13 new SYSTEM_REVERSAL contras
});
