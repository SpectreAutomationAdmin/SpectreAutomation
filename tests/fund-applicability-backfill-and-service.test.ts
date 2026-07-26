// Founder rule 2026-07-02 v15.0 — Fund Applicability service +
// migration backfill behaviour tests.
//
// End-to-end coverage:
//   • createAccount stores an explicit fundApplicability when the
//     caller supplies one.
//   • createAccount computes a default from FS Group when the
//     caller omits fundApplicability (P&L accounts).
//   • createAccount stores null for BS-side accounts.
//   • Zod rejects unknown fund tokens.
//   • backfillFundApplicabilityForClub populates every P&L
//     account and preserves already-set values.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db, makeUser, principalFor, resetDb, seedRbac } from "./util/db";
import { bootstrapAccountingClub } from "./util/gl";
import { createAccount } from "@/lib/accounting/coa";
import { backfillFundApplicabilityForClub } from "@/lib/accounting/backfill-fund-applicability";

async function controllerFor(clubId: string) {
  const email = `ctrl-${Math.random().toString(36).slice(2, 10)}@example.com`;
  await makeUser({ email, role: "CONTROLLER", clubId });
  return principalFor(email);
}

beforeAll(async () => { await seedRbac(); });
beforeEach(async () => { await resetDb(); await seedRbac(); });

describe("v15.0 createAccount: derives Fund Applicability from FS Group when omitted", () => {
  it("REVENUE account with capital FS group → fundApplicability = 'CAPITAL'", async () => {
    const club = await bootstrapAccountingClub("v15.0-Capital-Default");
    const p = await controllerFor(club.id);
    const { account } = await createAccount(p, club.id, {
      accountNumber: "9105",
      name: "Special Assessment 2026",
      type: "REVENUE",
      fsGroupKey: "IS_CAPITAL_ASSESSMENTS",
    });
    // Prisma types haven't been regenerated in every environment;
    // read the raw column via an unchecked query for portability.
    const row = await db().account.findUniqueOrThrow({ where: { id: account.id } });
    expect((row as unknown as { fundApplicability: string | null }).fundApplicability).toBe("CAPITAL");
  });

  it("REVENUE account with operating FS group → fundApplicability = 'OPERATING'", async () => {
    const club = await bootstrapAccountingClub("v15.0-Operating-Default");
    const p = await controllerFor(club.id);
    const { account } = await createAccount(p, club.id, {
      accountNumber: "4085",
      name: "Guest Dues",
      type: "REVENUE",
      fsGroupKey: "IS_MEMBERSHIP_DUES",
    });
    const row = await db().account.findUniqueOrThrow({ where: { id: account.id } });
    expect((row as unknown as { fundApplicability: string | null }).fundApplicability).toBe("OPERATING");
  });

  it("EXPENSE account defaults to OPERATING when no FS group is provided", async () => {
    const club = await bootstrapAccountingClub("v15.0-Expense-No-FSG");
    const p = await controllerFor(club.id);
    const { account } = await createAccount(p, club.id, {
      accountNumber: "6099",
      name: "Miscellaneous Grounds",
      type: "EXPENSE",
    });
    const row = await db().account.findUniqueOrThrow({ where: { id: account.id } });
    expect((row as unknown as { fundApplicability: string | null }).fundApplicability).toBe("OPERATING");
  });

  it("ASSET account defaults to null (Fund Applicability is a P&L concept)", async () => {
    const club = await bootstrapAccountingClub("v15.0-Asset-Null");
    const p = await controllerFor(club.id);
    const { account } = await createAccount(p, club.id, {
      accountNumber: "1123",
      name: "Petty Cash Drawer",
      type: "ASSET",
      fsGroupKey: "BS_CASH_EQUIVALENTS",
    });
    const row = await db().account.findUniqueOrThrow({ where: { id: account.id } });
    expect((row as unknown as { fundApplicability: string | null }).fundApplicability).toBeNull();
  });
});

describe("v15.0 createAccount: caller-supplied Fund Applicability wins over the default", () => {
  it("explicit 'OPERATING,CAPITAL' is normalised and stored verbatim", async () => {
    const club = await bootstrapAccountingClub("v15.0-Explicit-Multi");
    const p = await controllerFor(club.id);
    const { account } = await createAccount(p, club.id, {
      accountNumber: "4901",
      name: "Interest Income (Dual Fund)",
      type: "REVENUE",
      fsGroupKey: "IS_INTEREST_INCOME",
      fundApplicability: "CAPITAL,OPERATING",
    });
    const row = await db().account.findUniqueOrThrow({ where: { id: account.id } });
    // Serialiser sorts to canonical order (OPERATING before CAPITAL).
    expect((row as unknown as { fundApplicability: string | null }).fundApplicability).toBe("OPERATING,CAPITAL");
  });

  it("REJECTS an unknown fund token (Zod refinement fails validation)", async () => {
    const club = await bootstrapAccountingClub("v15.0-Reject-Unknown");
    const p = await controllerFor(club.id);
    await expect(
      createAccount(p, club.id, {
        accountNumber: "4990",
        name: "Weird",
        type: "REVENUE",
        fundApplicability: "MYSTERY_FUND",
      }),
    ).rejects.toThrow();
  });
});

describe("v15.0 migration backfill: populates every existing P&L account from FS Group", () => {
  it("backfillFundApplicabilityForClub sets fundApplicability on every P&L account", async () => {
    const club = await bootstrapAccountingClub("v15.0-Backfill");
    // Zero out any existing fundApplicability values so we can
    // verify the backfill populates them (bootstrapAccountingClub
    // already set them via createAccount defaults during seeding).
    await db().account.updateMany({
      where: { clubId: club.id },
      data: { fundApplicability: null },
    });

    const before = await db().account.count({
      where: { clubId: club.id, type: { in: ["REVENUE", "EXPENSE"] } },
    });
    const bsBefore = await db().account.count({
      where: { clubId: club.id, type: { in: ["ASSET", "LIABILITY", "EQUITY"] } },
    });

    const result = await backfillFundApplicabilityForClub(club.id);
    expect(result.updated).toBe(before);
    expect(result.skippedNonPL).toBe(bsBefore);

    // Spot-check: every P&L account has a non-null fundApplicability
    // AFTER the backfill, and every BS account is still null.
    const plAccounts = await db().account.findMany({
      where: { clubId: club.id, type: { in: ["REVENUE", "EXPENSE"] } },
      select: { fundApplicability: true },
    });
    for (const a of plAccounts) {
      expect(a.fundApplicability).not.toBeNull();
    }
    const bsAccounts = await db().account.findMany({
      where: { clubId: club.id, type: { in: ["ASSET", "LIABILITY", "EQUITY"] } },
      select: { fundApplicability: true },
    });
    for (const a of bsAccounts) {
      expect(a.fundApplicability).toBeNull();
    }
  });

  it("backfill preserves already-set fundApplicability (idempotent for operator overrides)", async () => {
    const club = await bootstrapAccountingClub("v15.0-Backfill-Idempotent");
    const p = await controllerFor(club.id);
    // Operator sets an unusual value on an existing account.
    const { account } = await createAccount(p, club.id, {
      accountNumber: "4800",
      name: "Dual-Fund Line",
      type: "REVENUE",
      fsGroupKey: "IS_MEMBERSHIP_DUES",
      fundApplicability: "OPERATING,CAPITAL",
    });
    // Zero the rest of the club's accounts so we can measure
    // whether the operator's specific value is preserved by the
    // backfill.
    await db().account.updateMany({
      where: { clubId: club.id, NOT: { id: account.id } },
      data: { fundApplicability: null },
    });

    const result = await backfillFundApplicabilityForClub(club.id);
    expect(result.skippedAlreadySet).toBeGreaterThanOrEqual(1);

    const preserved = await db().account.findUniqueOrThrow({ where: { id: account.id } });
    expect((preserved as unknown as { fundApplicability: string | null }).fundApplicability).toBe("OPERATING,CAPITAL");
  });
});
