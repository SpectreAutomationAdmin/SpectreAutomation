// Founder rule 2026-07-02 v15.1 — Fund Applicability UI slice.
//
// Two shapes of coverage:
//   • Source-contract file reads that lock the UI markers we
//     depend on (New Account dialog Fund field, Edit modal Fund
//     field, grid Fund column, filter chips, bulk action bar,
//     Review Accounts banner, TB Map Accounts row control).
//   • Behavioural tests running against the real DB + service
//     layer: BS accounts REJECT an explicit fund, edit-path
//     accepts null to clear the field, bulk action writes only
//     the P&L rows in a mixed selection, updateAccount honours
//     manual overrides after Slice 1's derive-default rule.

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db, makeUser, principalFor, resetDb, seedRbac } from "./util/db";
import { bootstrapAccountingClub } from "./util/gl";
import { createAccount, updateAccount } from "@/lib/accounting/coa";
import { ConflictError } from "@/lib/errors";

async function controllerFor(clubId: string) {
  const email = `ctrl-${Math.random().toString(36).slice(2, 10)}@example.com`;
  await makeUser({ email, role: "CONTROLLER", clubId });
  return principalFor(email);
}

beforeAll(async () => { await seedRbac(); });
beforeEach(async () => { await resetDb(); await seedRbac(); });

// ---------------------------------------------------------------------------
// Source-contract tests — UI markers we depend on across surfaces.
// ---------------------------------------------------------------------------
describe("v15.1 UI source contract — CoA page + New page + TB Map form", () => {
  const coaPage = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/app/admin/coa/page.tsx"),
    "utf8",
  );
  // Data Workspace Foundation v1.0 (2026-07-18) — grid rendering,
  // fund column, fund filter chips, and per-row bulk checkboxes
  // moved into the workspace client component. Source-contract
  // assertions concatenate both files so the same behavioural
  // contract is proved wherever the rendering lives.
  const coaClient = fs.readFileSync(
    path.resolve(process.cwd(), "src/components/data-workspace/ChartOfAccountsClient.tsx"),
    "utf8",
  );
  const coaRendered = coaPage + "\n// ---- rendered-source separator ----\n" + coaClient;
  const coaNewPage = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/app/admin/coa/new/page.tsx"),
    "utf8",
  );
  const coaActions = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/app/admin/coa/_actions.ts"),
    "utf8",
  );
  const mapForm = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/app/admin/imports/[id]/map-accounts/MapAccountsForm.tsx"),
    "utf8",
  );
  const mapPage = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/app/admin/imports/[id]/map-accounts/page.tsx"),
    "utf8",
  );
  const importsActions = fs.readFileSync(
    path.resolve(process.cwd(), "src/app/app/admin/imports/_actions.ts"),
    "utf8",
  );

  it("CoA modal + /new form render the Fund Applicability multi-select", () => {
    expect(coaPage).toMatch(/data-testid="coa-modal-fund-applicability"/);
    // Every canonical fund key must render a checkbox in BOTH surfaces.
    expect(coaPage).toMatch(/data-testid=\{`coa-modal-fund-\$\{k\}`\}/);
    expect(coaNewPage).toMatch(/data-testid="coa-new-fund-applicability"/);
    expect(coaNewPage).toMatch(/data-testid=\{`coa-new-fund-\$\{k\}`\}/);
    // The Fund field is placed after the FS Group selector (spec).
    const fsGroupIdx = coaPage.indexOf("coa-modal-fsgroup");
    const fundIdx = coaPage.indexOf("coa-modal-fund-applicability");
    expect(fsGroupIdx).toBeGreaterThan(-1);
    expect(fundIdx).toBeGreaterThan(fsGroupIdx);
  });

  it("Edit path includes the _fundApplicabilityForm hidden sentinel so updateAccount handles the null-clear case", () => {
    // Sentinel — presence tells the update action to treat "no
    // boxes ticked" as an explicit clear vs "field omitted".
    expect(coaPage).toMatch(/name="_fundApplicabilityForm"/);
    // Action reads the sentinel.
    expect(coaActions).toMatch(/_fundApplicabilityForm/);
    // Action collects the checkbox array via fdFundApplicability.
    expect(coaActions).toMatch(/fdFundApplicability/);
  });

  it("CoA grid renders a Fund column + reports 'Unmapped' for P&L accounts with a null tag", () => {
    // The workspace table exposes a <th>Fund</th> and per-row
    // testids for the fund cell + the unmapped indicator. The
    // row carries the raw fundApplicability CSV as a data
    // attribute so tests can assert the stored value.
    expect(coaRendered).toMatch(/<th>Fund<\/th>/);
    expect(coaRendered).toMatch(/data-testid=\{`coa-account-fund-\$\{row\.accountNumber\}`\}/);
    expect(coaRendered).toMatch(/data-testid=\{`coa-account-fund-unmapped-\$\{row\.accountNumber\}`\}/);
    expect(coaRendered).toMatch(/data-fund-applicability=/);
  });

  it("Fund filter chips render All / Operating / Capital / Both / Unmapped links", () => {
    expect(coaRendered).toMatch(/data-testid="coa-fund-filter"/);
    // The workspace's chip config lists each fund key literally.
    for (const key of ["OPERATING", "CAPITAL", "BOTH", "NONE"]) {
      expect(coaRendered).toMatch(new RegExp(`key: "${key}"`));
    }
    // The dynamic testid renders `coa-fund-filter-${chip.testKey}` where
    // testKey is either "all" or the fund key.
    expect(coaRendered).toMatch(/coa-fund-filter-\$\{chip\.testKey\}/);
  });

  it("Bulk action bar renders + row checkboxes post into it via form= attribute", () => {
    // The bulk fund form remains in page.tsx so its <form> lives
    // in the server render alongside the URL grammar it
    // participates in. Row checkboxes in the workspace client
    // component carry `form="coa-bulk-fund-form"` so their
    // submission targets the same form.
    expect(coaPage).toMatch(/id="coa-bulk-fund-form"/);
    expect(coaPage).toMatch(/data-testid="coa-bulk-fund-form"/);
    expect(coaRendered).toMatch(/form:\s*"coa-bulk-fund-form"/);
    // Every fund key renders a bulk-action checkbox.
    expect(coaPage).toMatch(/data-testid=\{`coa-bulk-fund-\$\{k\}`\}/);
    // Row-level select checkboxes surface a testid per row.
    expect(coaRendered).toMatch(/data-testid":\s*`coa-bulk-select-\$\{row\.accountNumber\}`/);
    // The bulk action is wired.
    expect(coaActions).toMatch(/export async function bulkSetFundApplicabilityAction/);
  });

  it("Review Accounts banner points at the ?mode=fund&fund=NONE deep link (v15.3 — lands operators inside the assignment workflow, not just the filtered grid)", () => {
    expect(coaPage).toMatch(/data-testid="coa-banner-unmapped-fund"/);
    expect(coaPage).toMatch(/href="\/app\/admin\/coa\?mode=fund&fund=NONE"/);
    expect(coaPage).toMatch(/data-testid="coa-banner-unmapped-fund-review"/);
  });

  it("TB Map Accounts form renders per-row Fund checkboxes seeded from the predictor default", () => {
    expect(mapForm).toMatch(/data-testid=\{`tb-map-fund-\$\{s\.accountNumber\}`\}/);
    expect(mapForm).toMatch(/data-testid=\{`tb-map-fund-\$\{s\.accountNumber\}-\$\{k\}`\}/);
    // Predictor's default is threaded through the server page → client form.
    expect(mapPage).toMatch(/fundApplicability: s\.prediction\.fundApplicability/);
    // The Suggestion type carries the field.
    expect(mapForm).toMatch(/fundApplicability: string \| null/);
    // Server action collects fund tokens per row.
    expect(importsActions).toMatch(/collectFundForRow/);
    expect(importsActions).toMatch(/`\$\{prefix\}\.fundApplicability`/);
  });
});

// ---------------------------------------------------------------------------
// Behavioural — service defaults, edits, BS-reject, bulk logic.
// ---------------------------------------------------------------------------
describe("v15.1 service defaults + Zod refinements — createAccount / updateAccount", () => {
  it("createAccount stores an explicit multi-fund value in canonical order", async () => {
    const club = await bootstrapAccountingClub("v15.1-Multi-Create");
    const p = await controllerFor(club.id);
    const { account } = await createAccount(p, club.id, {
      accountNumber: "4990",
      name: "Interest — Dual Fund",
      type: "REVENUE",
      fsGroupKey: "IS_INTEREST_INCOME",
      fundApplicability: "CAPITAL,OPERATING",
    });
    const row = await db().account.findUniqueOrThrow({ where: { id: account.id } });
    expect((row as unknown as { fundApplicability: string | null }).fundApplicability).toBe("OPERATING,CAPITAL");
  });

  it("createAccount REJECTS a Fund Applicability on a Balance-Sheet account", async () => {
    const club = await bootstrapAccountingClub("v15.1-BS-Reject-Create");
    const p = await controllerFor(club.id);
    await expect(
      createAccount(p, club.id, {
        accountNumber: "1888",
        name: "Cash — Somewhere",
        type: "ASSET",
        fsGroupKey: "BS_CASH_EQUIVALENTS",
        fundApplicability: "OPERATING",
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("updateAccount can flip an existing account from OPERATING to CAPITAL", async () => {
    const club = await bootstrapAccountingClub("v15.1-Edit-Flip");
    const p = await controllerFor(club.id);
    // Start with the default OPERATING derived from a membership FS group.
    const { account } = await createAccount(p, club.id, {
      accountNumber: "4123",
      name: "Special Line",
      type: "REVENUE",
      fsGroupKey: "IS_MEMBERSHIP_DUES",
    });
    const before = await db().account.findUniqueOrThrow({ where: { id: account.id } });
    expect((before as unknown as { fundApplicability: string | null }).fundApplicability).toBe("OPERATING");
    // Operator flips it to CAPITAL.
    const { account: updated } = await updateAccount(p, account.id, {
      fundApplicability: "CAPITAL",
    });
    const after = await db().account.findUniqueOrThrow({ where: { id: updated.id } });
    expect((after as unknown as { fundApplicability: string | null }).fundApplicability).toBe("CAPITAL");
  });

  it("updateAccount can clear the field to null when caller passes an empty CSV", async () => {
    // The `_fundApplicabilityForm` sentinel path in the server
    // action translates "no boxes ticked" → null. Simulate at
    // the service layer by passing fundApplicability: null.
    const club = await bootstrapAccountingClub("v15.1-Edit-Clear");
    const p = await controllerFor(club.id);
    const { account } = await createAccount(p, club.id, {
      accountNumber: "4995",
      name: "P&L Line",
      type: "REVENUE",
      fsGroupKey: "IS_MEMBERSHIP_DUES",
    });
    await updateAccount(p, account.id, { fundApplicability: null });
    const cleared = await db().account.findUniqueOrThrow({ where: { id: account.id } });
    expect((cleared as unknown as { fundApplicability: string | null }).fundApplicability).toBeNull();
  });

  it("updateAccount REJECTS a Fund Applicability set on a Balance-Sheet account", async () => {
    const club = await bootstrapAccountingClub("v15.1-BS-Reject-Update");
    const p = await controllerFor(club.id);
    const { account } = await createAccount(p, club.id, {
      accountNumber: "1889",
      name: "Bank",
      type: "ASSET",
      fsGroupKey: "BS_CASH_EQUIVALENTS",
    });
    await expect(
      updateAccount(p, account.id, { fundApplicability: "OPERATING" }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("updateAccount ignores fundApplicability when the field is omitted (backwards-compatible edit path)", async () => {
    // A save that doesn't include the fund fields (e.g. an older
    // form) must NOT overwrite a value the operator already
    // curated. Slice 1's derive-default is a CREATE-time rule
    // only.
    const club = await bootstrapAccountingClub("v15.1-Edit-Omitted");
    const p = await controllerFor(club.id);
    const { account } = await createAccount(p, club.id, {
      accountNumber: "4321",
      name: "Curated Line",
      type: "REVENUE",
      fsGroupKey: "IS_MEMBERSHIP_DUES",
      fundApplicability: "OPERATING,CAPITAL",
    });
    await updateAccount(p, account.id, { name: "Curated Line (renamed)" });
    const after = await db().account.findUniqueOrThrow({ where: { id: account.id } });
    expect((after as unknown as { fundApplicability: string | null }).fundApplicability).toBe("OPERATING,CAPITAL");
  });
});
