// Founder rule 2026-07-01 v14.16 — Trial Balance unmatched-account
// mapping workflow.

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db, makeUser, principalFor, resetDb, seedRbac } from "./util/db";
// v14.21 — the tests below cover the permission alignment
// between COA import commit and TB mapping approval.
import { bootstrapAccountingClub } from "./util/gl";
import { createBatch, validateBatch, commitBatch } from "@/lib/imports";
import { ensureFiscalYear } from "@/lib/accounting/periods";
import {
  getUnmatchedTbAccountSuggestions,
  approveTbMappedAccounts,
} from "@/lib/imports/tb-map-accounts";

async function controllerFor(clubId: string) {
  const email = `ctrl-${Math.random().toString(36).slice(2, 10)}@example.com`;
  await makeUser({ email, role: "CONTROLLER", clubId });
  return principalFor(email);
}

// Ship a TB with two accounts the seed COA doesn't have — proves
// the suggestion + approval + re-validate loop works end-to-end.
async function commitTb(
  p: Awaited<ReturnType<typeof principalFor>>,
  clubId: string,
  asOf: Date,
  rows: Array<{ accountNumber: string; description: string; debit: string; credit: string }>,
) {
  const batch = await createBatch(p, {
    clubId, domain: "OPENING_TRIAL_BALANCE", rows,
    source: "CSV", fileName: `tb-${asOf.toISOString().slice(0, 10)}.csv`,
    options: { asOfDate: asOf.toISOString() },
  });
  await validateBatch(p, batch.id);
  return batch;
}

beforeAll(async () => { await seedRbac(); });
beforeEach(async () => { await resetDb(); await seedRbac(); });

describe("v14.16 — getUnmatchedTbAccountSuggestions surfaces per-row suggestions from the predictor", () => {
  it("returns one suggestion per ACCOUNT_NOT_FOUND row with predicted type/category/FS group", async () => {
    const club = await bootstrapAccountingClub("v14.16-Suggest");
    await ensureFiscalYear(club.id, { startYear: 2026, startMonth: 1 });
    const p = await controllerFor(club.id);
    const asOf = new Date("2026-05-31T00:00:00.000Z");
    // 9500 is not in the seed COA. 8500 also not. Use founder-flavoured
    // descriptions to prove the predictor picks reasonable defaults.
    const batch = await commitTb(p, club.id, asOf, [
      { accountNumber: "1000", description: "Cash",                 debit: "10000.00", credit: "0" },
      { accountNumber: "2000", description: "AP",                   debit: "0",        credit: "-5000.00" },
      { accountNumber: "9500", description: "Golf Cart Financing",  debit: "5000.00",  credit: "0" },  // new
      { accountNumber: "8500", description: "Late Fees Received",   debit: "0",        credit: "-5000.00" },  // new
      { accountNumber: "3100", description: "Retained Earnings",    debit: "0",        credit: "-5000.00" },
    ]);
    const suggestions = await getUnmatchedTbAccountSuggestions(p, batch.id);
    expect(suggestions.length).toBe(2);
    const byNum = new Map(suggestions.map((s) => [s.accountNumber, s]));
    // "Golf Cart Financing" is EXPENSE (bracket 8/9xxx or keyword-driven → matches expense keywords).
    const golfCart = byNum.get("9500");
    expect(golfCart).toBeTruthy();
    expect(golfCart!.description).toBe("Golf Cart Financing");
    expect(golfCart!.prediction.type).toBeTruthy();
    expect(golfCart!.prediction.fsGroupKey).toBeTruthy();
    // "Late Fees Received" → predictor should classify as REVENUE (fee keywords).
    const lateFees = byNum.get("8500");
    expect(lateFees).toBeTruthy();
    expect(lateFees!.prediction.type).toBeTruthy();
    expect(lateFees!.prediction.fsGroupKey).toBeTruthy();
  });

  it("REJECTS a non-TB batch", async () => {
    const club = await bootstrapAccountingClub("v14.16-Suggest-NonTb");
    const p = await controllerFor(club.id);
    // Fake COA batch.
    const coa = await db().importBatch.create({
      data: {
        clubId: club.id, domain: "COA", source: "CSV",
        status: "VALIDATED", fileName: "x.csv",
        totalRows: 0, validRows: 0, errorRows: 0,
        createdByUserId: p.id,
      },
    });
    await expect(getUnmatchedTbAccountSuggestions(p, coa.id)).rejects.toThrow(/Only Opening Trial Balance/);
  });

  it("suggests the account's existing mapping when it already exists (defensive edge case)", async () => {
    const club = await bootstrapAccountingClub("v14.16-Existing");
    await ensureFiscalYear(club.id, { startYear: 2026, startMonth: 1 });
    const p = await controllerFor(club.id);
    // Commit a batch with all-existing accounts → no unmatched.
    const batch = await commitTb(p, club.id, new Date("2026-05-31T00:00:00.000Z"), [
      { accountNumber: "1000", description: "Cash", debit: "100.00", credit: "0" },
      { accountNumber: "2000", description: "AP",   debit: "0",      credit: "-100.00" },
    ]);
    const suggestions = await getUnmatchedTbAccountSuggestions(p, batch.id);
    expect(suggestions.length).toBe(0);
  });
});

describe("v14.16 — approveTbMappedAccounts creates accounts + re-validates + preserves audit trail", () => {
  it("creates approved accounts using the same createAccount() as manual COA maintenance (v13 validation)", async () => {
    const club = await bootstrapAccountingClub("v14.16-Approve");
    await ensureFiscalYear(club.id, { startYear: 2026, startMonth: 1 });
    const p = await controllerFor(club.id);
    const asOf = new Date("2026-05-31T00:00:00.000Z");
    const batch = await commitTb(p, club.id, asOf, [
      { accountNumber: "1000", description: "Cash",                debit: "10000.00", credit: "0" },
      { accountNumber: "9500", description: "Golf Cart Financing", debit: "5000.00",  credit: "0" },
      { accountNumber: "8500", description: "Late Fees Received",  debit: "0",        credit: "-10000.00" },
      { accountNumber: "2000", description: "AP",                  debit: "0",        credit: "-5000.00" },
    ]);
    // Before approval: 2 unmatched, batch cannot commit.
    const beforeErrors = await db().importError.count({ where: { batchId: batch.id, code: "ACCOUNT_NOT_FOUND" } });
    expect(beforeErrors).toBe(2);
    // Approve both.
    const result = await approveTbMappedAccounts(p, batch.id, [
      {
        accountNumber: "9500", name: "Golf Cart Financing",
        type: "EXPENSE", categoryKey: "OTHER_EXPENSES",
        fsGroupKey: "IS_OTHER_EXPENSES", defaultDepartmentCode: null,
      },
      {
        accountNumber: "8500", name: "Late Fees Received",
        type: "REVENUE", categoryKey: "OTHER_REVENUE",
        fsGroupKey: "IS_OTHER_REVENUE", defaultDepartmentCode: null,
      },
    ]);
    expect(result.created).toBe(2);
    expect(result.failed).toEqual([]);
    // Accounts appear in the live COA.
    const created = await db().account.findMany({
      where: { clubId: club.id, accountNumber: { in: ["9500", "8500"] } },
      orderBy: { accountNumber: "asc" },
    });
    expect(created.length).toBe(2);
    expect(created[0].name).toBe("Late Fees Received");
    // Batch re-validated automatically → ACCOUNT_NOT_FOUND errors cleared.
    const afterErrors = await db().importError.count({ where: { batchId: batch.id, code: "ACCOUNT_NOT_FOUND" } });
    expect(afterErrors).toBe(0);
    expect(result.errorRows).toBe(0);
    // Audit trail carries the batch link.
    const audits = await db().auditLog.findMany({
      where: { clubId: club.id, action: "import.tb.map-account.create" },
      orderBy: { entityId: "asc" },
    });
    expect(audits.length).toBe(2);
    for (const a of audits) {
      const after = a.afterJson ? JSON.parse(String(a.afterJson)) : {};
      expect(after.batchId).toBe(batch.id);
    }
  });

  it("skips accounts that already exist by the time approval runs (spec item: race safety)", async () => {
    const club = await bootstrapAccountingClub("v14.16-Skip-Existing");
    await ensureFiscalYear(club.id, { startYear: 2026, startMonth: 1 });
    const p = await controllerFor(club.id);
    const asOf = new Date("2026-05-31T00:00:00.000Z");
    const batch = await commitTb(p, club.id, asOf, [
      { accountNumber: "1000", description: "Cash",                debit: "10000.00", credit: "0" },
      { accountNumber: "9500", description: "Golf Cart Financing", debit: "0",        credit: "-10000.00" },
    ]);
    // Simulate another operator having created 9500 already.
    const { createAccount } = await import("@/lib/accounting/coa");
    await createAccount(p, club.id, {
      accountNumber: "9500", name: "Pre-existing account", type: "LIABILITY",
    });
    // Now approve the mapping → skip, don't overwrite.
    const result = await approveTbMappedAccounts(p, batch.id, [
      {
        accountNumber: "9500", name: "Golf Cart Financing",
        type: "EXPENSE", categoryKey: "OTHER_EXPENSES",
        fsGroupKey: "IS_OTHER_EXPENSES", defaultDepartmentCode: null,
      },
    ]);
    expect(result.created).toBe(0);
    expect(result.skippedExisting).toBe(1);
    // Original name preserved (not overwritten).
    const acct = await db().account.findFirstOrThrow({
      where: { clubId: club.id, accountNumber: "9500" },
    });
    expect(acct.name).toBe("Pre-existing account");
  });

  it("after all unmatched accounts are approved, the batch is commit-ready (errorRows: 0)", async () => {
    const club = await bootstrapAccountingClub("v14.16-Commit-After");
    await ensureFiscalYear(club.id, { startYear: 2026, startMonth: 1 });
    const p = await controllerFor(club.id);
    const asOf = new Date("2026-05-31T00:00:00.000Z");
    const batch = await commitTb(p, club.id, asOf, [
      { accountNumber: "1000", description: "Cash",                debit: "10000.00", credit: "0" },
      { accountNumber: "9500", description: "Golf Cart Financing", debit: "0",        credit: "-10000.00" },
    ]);
    // Approve → creates 9500 + re-validates.
    const result = await approveTbMappedAccounts(p, batch.id, [
      {
        accountNumber: "9500", name: "Golf Cart Financing",
        type: "LIABILITY", categoryKey: "LONG_TERM_LIABILITIES",
        fsGroupKey: "BS_LONG_TERM_DEBT", defaultDepartmentCode: null,
      },
    ]);
    expect(result.errorRows).toBe(0);
    // User can now commit the batch directly (no re-upload).
    const committed = await commitBatch(p, { batchId: batch.id });
    expect(committed.status).toBe("COMMITTED");
  });

  it("REJECTS approval on a committed batch (data integrity guard)", async () => {
    const club = await bootstrapAccountingClub("v14.16-Committed-Reject");
    await ensureFiscalYear(club.id, { startYear: 2026, startMonth: 1 });
    const p = await controllerFor(club.id);
    const asOf = new Date("2026-05-31T00:00:00.000Z");
    const batch = await commitTb(p, club.id, asOf, [
      { accountNumber: "1000", description: "Cash", debit: "100.00", credit: "0" },
      { accountNumber: "2000", description: "AP",   debit: "0",      credit: "-100.00" },
    ]);
    await commitBatch(p, { batchId: batch.id });
    await expect(
      approveTbMappedAccounts(p, batch.id, [
        {
          accountNumber: "9500", name: "any",
          type: "EXPENSE", categoryKey: null, fsGroupKey: null, defaultDepartmentCode: null,
        },
      ]),
    ).rejects.toThrow(/committed/i);
  });
});

describe("v14.16 — UI source-contract: entry point + review page + form action", () => {
  const detail = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/app/admin/imports/[id]/page.tsx"),
    "utf8",
  );
  const mapPage = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/app/admin/imports/[id]/map-accounts/page.tsx"),
    "utf8",
  );
  // v14.17 — interactive form moved to a Client Component; source-
  // contract assertions now target that file.
  const mapForm = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/app/admin/imports/[id]/map-accounts/MapAccountsForm.tsx"),
    "utf8",
  );
  const actions = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/app/admin/imports/_actions.ts"),
    "utf8",
  );

  it("batch detail page: 'Map / Add accounts' link points to the review route", () => {
    expect(detail).toMatch(/data-testid="tb-map-accounts-link"/);
    expect(detail).toMatch(/\/app\/admin\/imports\/\$\{batch\.id\}\/map-accounts/);
  });

  it("map-accounts form (Client Component): renders per-row form fields + bulk-approve helper + submit button", () => {
    expect(mapForm).toMatch(/data-testid="tb-map-form"/);
    expect(mapForm).toMatch(/data-testid="tb-map-bulk-approve-high"/);
    expect(mapForm).toMatch(/data-testid=\{`tb-map-approve-\$\{s\.accountNumber\}`\}/);
    expect(mapForm).toMatch(/data-testid=\{`tb-map-name-\$\{s\.accountNumber\}`\}/);
    expect(mapForm).toMatch(/data-testid=\{`tb-map-type-\$\{s\.accountNumber\}`\}/);
    expect(mapForm).toMatch(/data-testid=\{`tb-map-fsgroup-\$\{s\.accountNumber\}`\}/);
    expect(mapForm).toMatch(/data-testid="tb-map-submit"/);
  });

  it("map-accounts form: high-confidence rows default to checked; already-existing rows disabled + tinted", () => {
    expect(mapForm).toMatch(/defaultChecked=\{s\.prediction\.confidence === "high" && !s\.alreadyExists\}/);
    expect(mapForm).toMatch(/disabled=\{s\.alreadyExists\}/);
    expect(mapForm).toMatch(/s\.alreadyExists \? "bg-stone-50 text-stone-400" : ""/);
  });

  it("map-accounts form: form action wired to approveTbMappingsAction (Server Action is passable across the boundary)", () => {
    expect(mapForm).toMatch(/^"use client"/);
    expect(mapForm).toMatch(/import \{ approveTbMappingsAction \} from "\.\.\/\.\.\/_actions"/);
    expect(mapForm).toMatch(/action=\{approveTbMappingsAction\}/);
  });

  it("map-accounts page (Server Component): fetches data + renders <MapAccountsForm/>, holds NO onChange handlers", () => {
    // Page is server-only: no "use client" directive.
    expect(mapPage).not.toMatch(/^"use client"/);
    // Delegates the form to the client component.
    expect(mapPage).toMatch(/import \{ MapAccountsForm \} from "\.\/MapAccountsForm"/);
    expect(mapPage).toMatch(/<MapAccountsForm/);
    // Zero onChange in the server page (the crash root cause).
    expect(mapPage).not.toMatch(/onChange=/);
  });

  it("_actions.ts: approveTbMappingsAction requires per-row approved checkbox + required fields", () => {
    expect(actions).toMatch(/export async function approveTbMappingsAction/);
    // Loops on `.approved` suffix.
    expect(actions).toMatch(/key\.endsWith\("\.approved"\)/);
    // Required-field guard (number + name + type).
    expect(actions).toMatch(/if \(!num \|\| !name \|\| !type\) continue/);
    // Calls the backend service.
    expect(actions).toMatch(/approveTbMappedAccounts\(principal, batchId, approved\)/);
  });

  // Founder rule 2026-07-01 v14.19 — the batch-detail page must
  // render the notice cookie AND the action must route failures
  // to the error cookie (with per-row detail) rather than a
  // silent notice the detail page never displayed.
  it("v14.19 detail page: reads + displays spectre_import_notice cookie so operator sees 'N created' feedback", () => {
    // Reads the cookie.
    expect(detail).toMatch(/const notice = cookies\(\)\.get\("spectre_import_notice"\)\?\.value/);
    // Renders it as a visible banner with a stable testid.
    expect(detail).toMatch(/data-testid="batch-detail-notice"/);
    expect(detail).toMatch(/\{notice\}/);
  });

  // Founder rule 2026-07-01 v14.20 — Next.js prohibits cookie
  // mutation inside a Server Component render. The batch-detail
  // page reads three flash cookies (error / success / notice)
  // and MUST delegate deletion to the <FlashClear/> client
  // component + /clear-flash Route Handler pair. Regressing this
  // would crash the page with the exact error the founder saw.
  it("v14.20 detail page: contains NO cookies().delete calls (deletion is delegated to the Route Handler)", () => {
    expect(detail).not.toMatch(/cookies\(\)\.delete\(/);
  });

  it("v14.20 detail page: mounts <FlashClear/> when any flash cookie is present", () => {
    // Imports the same FlashClear component the imports index uses.
    expect(detail).toMatch(/import \{ FlashClear \} from "\.\.\/FlashClear"/);
    // Conditional render — only when there IS a flash to clear so
    // we don't fire a needless POST on every navigation.
    expect(detail).toMatch(/\{\(error \|\| success \|\| notice\) && <FlashClear \/>\}/);
  });

  it("v14.20 clear-flash route handler: clears every flash cookie the batch-detail page reads", () => {
    const clearFlash = fs.readFileSync(
      path.resolve(process.cwd(), "src/app/app/admin/imports/clear-flash/route.ts"),
      "utf8",
    );
    // Must handle all three flash cookies the batch-detail page
    // reads — error / notice / success. Missing any one would
    // strand it until the 30 s maxAge expires.
    expect(clearFlash).toMatch(/spectre_import_error/);
    expect(clearFlash).toMatch(/spectre_import_notice/);
    expect(clearFlash).toMatch(/spectre_import_success/);
  });

  it("v14.19 action: on failure, uses setError with per-row accountNumber + reason (not the silent notice)", () => {
    // The action must build per-row rendered failure detail.
    expect(actions).toMatch(/result\.failed\.length > 0/);
    // The rendered form must be accountNumber (reason) separated
    // by "; " so operators can spot the offending accounts.
    expect(actions).toMatch(/\$\{f\.accountNumber\} \(\$\{f\.error\}\)/);
    // And it must route to setError, not setNotice, for failures.
    expect(actions).toMatch(/setError\(`\$\{summary\} Failed rows: \$\{rendered\}`\)/);
    // Success (no failures) still uses setNotice — keeps the
    // clean-batch case unchanged.
    expect(actions).toMatch(/setNotice\(summary\)/);
  });
});

// ---------------------------------------------------------------------------
// Founder rule 2026-07-01 v14.19 — approval failure surfacing.
//
// The reported bug: 31 approved mappings, batch still shows "31 accounts
// not found in Chart of Accounts". Root cause was that createAccount
// failures for rows with unknown FS Group / Category / Department keys
// went into result.failed but the notice cookie set by the server
// action was never rendered on the batch detail page — the operator
// had no way to see WHY the rows didn't land.
//
// This suite locks the fixed behaviour:
//   • approveTbMappedAccounts still writes per-row failure detail into
//     result.failed WITH the createAccount error message.
//   • validateBatch still runs even when 0 rows succeeded — so the
//     ACCOUNT_NOT_FOUND panel reconciles with reality.
// ---------------------------------------------------------------------------
describe("v14.19 — createAccount failures are surfaced with per-row detail", () => {
  it("bad fsGroupKey → result.failed carries the exact reason so the action can render it", async () => {
    const club = await bootstrapAccountingClub("v14.19-Failure-Surfacing");
    await ensureFiscalYear(club.id, { startYear: 2026, startMonth: 1 });
    const p = await controllerFor(club.id);
    const asOf = new Date("2026-05-31T00:00:00.000Z");
    const batch = await commitTb(p, club.id, asOf, [
      { accountNumber: "1000", description: "Cash",                debit: "10000.00", credit: "0" },
      { accountNumber: "9500", description: "Golf Cart Financing", debit: "0",        credit: "-10000.00" },
    ]);
    // Approve 9500 with an FS group key the club's COA does NOT
    // have — the createAccount ConflictError must be captured
    // per-row (not thrown), so the operator can see "9500 (Unknown
    // FS group: NOT_A_REAL_KEY)" in the batch detail error banner.
    const result = await approveTbMappedAccounts(p, batch.id, [
      {
        accountNumber: "9500", name: "Golf Cart Financing",
        type: "LIABILITY", categoryKey: "LONG_TERM_LIABILITIES",
        fsGroupKey: "NOT_A_REAL_KEY", defaultDepartmentCode: null,
      },
    ]);
    expect(result.created).toBe(0);
    expect(result.failed.length).toBe(1);
    expect(result.failed[0].accountNumber).toBe("9500");
    // The reason is passed through — the action renders this
    // verbatim so the operator sees the exact createAccount error.
    expect(result.failed[0].error).toMatch(/Unknown FS group/i);
    expect(result.failed[0].error).toMatch(/NOT_A_REAL_KEY/);
    // The batch was still re-validated even though no rows landed.
    // The ACCOUNT_NOT_FOUND row for 9500 persists (which is
    // correct — the account doesn't exist yet).
    const afterErrors = await db().importError.findMany({
      where: { batchId: batch.id, code: "ACCOUNT_NOT_FOUND" },
    });
    expect(afterErrors.length).toBe(1);
    expect(afterErrors[0].rowNumber).toBeGreaterThan(0);
  });

  it("mixed success + failure → the successful row lands, the failed row's ACCOUNT_NOT_FOUND persists", async () => {
    const club = await bootstrapAccountingClub("v14.19-Mixed");
    await ensureFiscalYear(club.id, { startYear: 2026, startMonth: 1 });
    const p = await controllerFor(club.id);
    const asOf = new Date("2026-05-31T00:00:00.000Z");
    const batch = await commitTb(p, club.id, asOf, [
      { accountNumber: "1000", description: "Cash",                debit: "10000.00", credit: "0" },
      { accountNumber: "9500", description: "Golf Cart Financing", debit: "5000.00",  credit: "0" },
      { accountNumber: "9600", description: "Broken Suggestion",   debit: "0",        credit: "-5000.00" },
    ]);
    const result = await approveTbMappedAccounts(p, batch.id, [
      {
        accountNumber: "9500", name: "Golf Cart Financing",
        type: "EXPENSE", categoryKey: "OTHER_EXPENSES",
        fsGroupKey: "IS_OTHER_EXPENSES", defaultDepartmentCode: null,
      },
      {
        accountNumber: "9600", name: "Broken Suggestion",
        type: "REVENUE", categoryKey: "OTHER_REVENUE",
        fsGroupKey: "STILL_NOT_A_REAL_KEY", defaultDepartmentCode: null,
      },
    ]);
    expect(result.created).toBe(1);
    expect(result.failed.length).toBe(1);
    expect(result.failed[0].accountNumber).toBe("9600");
    // Live COA has 9500 but not 9600.
    const live = await db().account.findMany({
      where: { clubId: club.id, accountNumber: { in: ["9500", "9600"] } },
    });
    expect(live.map((a) => a.accountNumber).sort()).toEqual(["9500"]);
    // ACCOUNT_NOT_FOUND panel: only 9600 remains after re-validation.
    // (This is the exact "batch preview should show the *remaining*
    // unmatched, not the pre-approval count" invariant.)
    const errs = await db().importError.findMany({
      where: { batchId: batch.id, code: "ACCOUNT_NOT_FOUND" },
    });
    expect(errs.length).toBe(1);
    // The 9500 row's ACCOUNT_NOT_FOUND was cleared by validateBatch.
    const cleared9500 = errs.find((e) => e.message.includes("9500"));
    expect(cleared9500).toBeUndefined();
    const remaining9600 = errs.find((e) => e.message.includes("9600"));
    expect(remaining9600).toBeTruthy();
  });

  // Founder rule 2026-07-01 v14.21 — CLUB_ADMIN can approve TB
  // mappings even though the role does not carry `coa:write`.
  // The COA IMPORT COMMIT path already permits Club Admins to
  // create accounts (it upserts under a `settings:write` gate);
  // TB mapping is the same class of bulk data-import operation,
  // so it now goes through `upsertAccountInternal` at the same
  // trust level. Manual COA maintenance stays gated on
  // `coa:write`.
  it("v14.21 CLUB_ADMIN can approve TB mappings (permission path aligned with COA import commit)", async () => {
    const club = await bootstrapAccountingClub("v14.21-ClubAdmin-Approve");
    await ensureFiscalYear(club.id, { startYear: 2026, startMonth: 1 });
    // Provision a Club Admin — this role has settings:write but
    // NOT coa:write per role config.
    const adminEmail = `admin-${Math.random().toString(36).slice(2, 10)}@example.com`;
    await makeUser({ email: adminEmail, role: "CLUB_ADMIN", clubId: club.id });
    const admin = await principalFor(adminEmail);
    const asOf = new Date("2026-05-31T00:00:00.000Z");
    const batch = await commitTb(admin, club.id, asOf, [
      { accountNumber: "1000", description: "Cash",                debit: "10000.00", credit: "0" },
      { accountNumber: "9500", description: "Golf Cart Financing", debit: "0",        credit: "-10000.00" },
    ]);
    // The reported bug: this call used to throw "Missing
    // permission: coa:write". After v14.21 the batch-service's
    // settings:write gate is the authorization boundary and
    // the account creation succeeds.
    const result = await approveTbMappedAccounts(admin, batch.id, [
      {
        accountNumber: "9500", name: "Golf Cart Financing",
        type: "LIABILITY", categoryKey: "LONG_TERM_LIABILITIES",
        fsGroupKey: "BS_LONG_TERM_DEBT", defaultDepartmentCode: null,
      },
    ]);
    expect(result.created).toBe(1);
    expect(result.failed).toEqual([]);
    // Batch cleared of ACCOUNT_NOT_FOUND — panel disappears.
    const errs = await db().importError.count({
      where: { batchId: batch.id, code: "ACCOUNT_NOT_FOUND" },
    });
    expect(errs).toBe(0);
  });

  // Security invariant: users without settings:write still can't
  // approve TB mappings. Founder acceptance criterion #4.
  it("v14.21 users without settings:write are still rejected (security invariant preserved)", async () => {
    const club = await bootstrapAccountingClub("v14.21-No-Settings-Write");
    await ensureFiscalYear(club.id, { startYear: 2026, startMonth: 1 });
    const p = await controllerFor(club.id);
    const asOf = new Date("2026-05-31T00:00:00.000Z");
    const batch = await commitTb(p, club.id, asOf, [
      { accountNumber: "1000", description: "Cash",                debit: "10000.00", credit: "0" },
      { accountNumber: "9500", description: "Golf Cart Financing", debit: "0",        credit: "-10000.00" },
    ]);
    // STAFF role has only members:read + events:read — NO
    // settings:write, so approvals must be rejected. Locks the
    // v14.21 security invariant: expanding the permission gate
    // to `settings:write` didn't accidentally open a hole for
    // low-trust roles.
    const guestEmail = `guest-${Math.random().toString(36).slice(2, 10)}@example.com`;
    await makeUser({ email: guestEmail, role: "STAFF", clubId: club.id });
    const guest = await principalFor(guestEmail);
    await expect(
      approveTbMappedAccounts(guest, batch.id, [
        {
          accountNumber: "9500", name: "Golf Cart Financing",
          type: "LIABILITY", categoryKey: "LONG_TERM_LIABILITIES",
          fsGroupKey: "BS_LONG_TERM_DEBT", defaultDepartmentCode: null,
        },
      ]),
    ).rejects.toThrow(/permission/i);
  });

  // Manual COA maintenance stays locked down — the v13.2 rule
  // that CLUB_ADMIN is read-only on standalone `createAccount`
  // has not changed.
  it("v14.21 manual createAccount() still requires coa:write (v13.2 rule unchanged)", async () => {
    const club = await bootstrapAccountingClub("v14.21-Manual-Coa-Locked");
    await ensureFiscalYear(club.id, { startYear: 2026, startMonth: 1 });
    const adminEmail = `admin2-${Math.random().toString(36).slice(2, 10)}@example.com`;
    await makeUser({ email: adminEmail, role: "CLUB_ADMIN", clubId: club.id });
    const admin = await principalFor(adminEmail);
    const { createAccount } = await import("@/lib/accounting/coa");
    await expect(
      createAccount(admin, club.id, {
        accountNumber: "9500", name: "Manual create", type: "EXPENSE",
      }),
    ).rejects.toThrow(/coa:write/i);
  });

  it("all-success path → ACCOUNT_NOT_FOUND fully cleared and batch is commit-ready", async () => {
    // This is the founder's expected outcome for a clean approval run
    // — locked so the "31 approved / 31 clear" flow can never
    // regress silently.
    const club = await bootstrapAccountingClub("v14.19-All-Clear");
    await ensureFiscalYear(club.id, { startYear: 2026, startMonth: 1 });
    const p = await controllerFor(club.id);
    const asOf = new Date("2026-05-31T00:00:00.000Z");
    const batch = await commitTb(p, club.id, asOf, [
      { accountNumber: "1000", description: "Cash",                debit: "10000.00", credit: "0" },
      { accountNumber: "9500", description: "Golf Cart Financing", debit: "0",        credit: "-10000.00" },
    ]);
    const result = await approveTbMappedAccounts(p, batch.id, [
      {
        accountNumber: "9500", name: "Golf Cart Financing",
        type: "LIABILITY", categoryKey: "LONG_TERM_LIABILITIES",
        fsGroupKey: "BS_LONG_TERM_DEBT", defaultDepartmentCode: null,
      },
    ]);
    expect(result.created).toBe(1);
    expect(result.failed).toEqual([]);
    // Panel is empty — the batch reads as "ready to commit".
    const errs = await db().importError.count({
      where: { batchId: batch.id, code: "ACCOUNT_NOT_FOUND" },
    });
    expect(errs).toBe(0);
    expect(result.errorRows).toBe(0);
  });
});
