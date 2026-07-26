// Founder rule 2026-07-02 v15.2 — bulk Fund Applicability
// end-to-end regression suite.
//
// Locks the query the founder's dev server crashed on:
//
//   Invalid prisma.account.findMany() invocation
//     select: { fundApplicability: true, … }
//
// Root cause was a stale in-memory Prisma client on the running
// Next dev server (the schema push + prisma generate had already
// landed on disk; the dev server had loaded an older client at
// startup). The tests below exercise the EXACT `select` shape +
// the update loop against a fresh Prisma client, so any future
// schema/client drift surfaces here — not on the founder's dev
// server.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db, makeUser, principalFor, resetDb, seedRbac } from "./util/db";
import { bootstrapAccountingClub } from "./util/gl";
import { createAccount } from "@/lib/accounting/coa";
import { applyBulkFundApplicability } from "@/lib/accounting/bulk-fund-applicability";

async function controllerFor(clubId: string) {
  const email = `ctrl-${Math.random().toString(36).slice(2, 10)}@example.com`;
  await makeUser({ email, role: "CONTROLLER", clubId });
  return principalFor(email);
}

beforeAll(async () => { await seedRbac(); });
beforeEach(async () => { await resetDb(); await seedRbac(); });

describe("v15.2 Prisma client alignment — Account.fundApplicability is queryable", () => {
  it("select { fundApplicability: true } on Account does NOT throw (the founder's dev-server error)", async () => {
    const club = await bootstrapAccountingClub("v15.2-Prisma-Client-Alignment");
    // Direct sanity read — mirrors the shape used by
    // applyBulkFundApplicability. If the generated Prisma
    // client is out of sync with the schema, this call throws
    // "Invalid prisma.account.findMany() invocation".
    const rows = await db().account.findMany({
      where: { clubId: club.id },
      select: { id: true, type: true, accountNumber: true, fundApplicability: true },
    });
    expect(rows.length).toBeGreaterThan(0);
    // Field must be present (or explicitly null) — Prisma
    // returns undefined for fields not in the select.
    for (const r of rows.slice(0, 3)) {
      expect(Object.prototype.hasOwnProperty.call(r, "fundApplicability")).toBe(true);
    }
  });

  it("include-form Account query returns the fundApplicability column implicitly", async () => {
    // The CoA page uses `include`, not `select`, so the runtime
    // relies on the full Account row shape. This test locks the
    // fact that `fundApplicability` survives the include path.
    const club = await bootstrapAccountingClub("v15.2-Include-Path");
    const rows = await db().account.findMany({
      where: { clubId: club.id },
      include: { category: true, fsGroup: true, defaultDepartment: true, parent: true },
      take: 5,
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      // Field is part of the base Account model → present on
      // every row (nullable String).
      expect(Object.prototype.hasOwnProperty.call(r, "fundApplicability")).toBe(true);
    }
  });
});

describe("v15.2 applyBulkFundApplicability — updates P&L accounts, skips BS accounts", () => {
  it("selecting multiple P&L accounts and applying Capital updates every P&L row + returns the correct counts", async () => {
    const club = await bootstrapAccountingClub("v15.2-Bulk-PL-Only");
    const p = await controllerFor(club.id);
    // Grab a set of P&L accounts to work with.
    const plAccounts = await db().account.findMany({
      where: { clubId: club.id, type: { in: ["REVENUE", "EXPENSE"] } },
      take: 5,
      select: { id: true, accountNumber: true },
    });
    expect(plAccounts.length).toBe(5);
    const ids = plAccounts.map((a) => a.id);

    const result = await applyBulkFundApplicability(p, club.id, ids, "CAPITAL");
    expect(result.updated).toBe(5);
    expect(result.skippedBs).toBe(0);
    expect(result.requested).toBe(5);
    expect(result.fundApplicability).toBe("CAPITAL");

    // Persistence: every P&L row now reads back as CAPITAL.
    const readback = await db().account.findMany({
      where: { id: { in: ids } },
      select: { fundApplicability: true },
    });
    for (const r of readback) {
      expect(r.fundApplicability).toBe("CAPITAL");
    }
  });

  it("mixed P&L + BS selection updates only P&L rows; skippedBs counts the balance-sheet accounts silently", async () => {
    const club = await bootstrapAccountingClub("v15.2-Bulk-Mixed");
    const p = await controllerFor(club.id);
    // Grab two P&L + two BS accounts.
    const plAccounts = await db().account.findMany({
      where: { clubId: club.id, type: { in: ["REVENUE", "EXPENSE"] } },
      take: 2,
      select: { id: true, fundApplicability: true },
    });
    const bsAccounts = await db().account.findMany({
      where: { clubId: club.id, type: { in: ["ASSET", "LIABILITY", "EQUITY"] } },
      take: 2,
      select: { id: true, fundApplicability: true },
    });
    expect(plAccounts.length).toBe(2);
    expect(bsAccounts.length).toBe(2);
    // BS accounts start null; snapshot the pre-state.
    for (const a of bsAccounts) expect(a.fundApplicability).toBeNull();

    const ids = [...plAccounts.map((a) => a.id), ...bsAccounts.map((a) => a.id)];
    const result = await applyBulkFundApplicability(p, club.id, ids, "OPERATING,CAPITAL");
    expect(result.updated).toBe(2);
    expect(result.skippedBs).toBe(2);
    expect(result.requested).toBe(4);

    // P&L rows changed; BS rows unchanged.
    const readback = await db().account.findMany({
      where: { id: { in: ids } },
      select: { id: true, type: true, fundApplicability: true },
    });
    for (const r of readback) {
      if (r.type === "REVENUE" || r.type === "EXPENSE") {
        expect(r.fundApplicability).toBe("OPERATING,CAPITAL");
      } else {
        expect(r.fundApplicability).toBeNull();
      }
    }
  });

  it("emits ONE aggregate audit row per bulk operation (not one per account)", async () => {
    const club = await bootstrapAccountingClub("v15.2-Bulk-Audit");
    const p = await controllerFor(club.id);
    const plAccounts = await db().account.findMany({
      where: { clubId: club.id, type: { in: ["REVENUE", "EXPENSE"] } },
      take: 3,
      select: { id: true },
    });
    const ids = plAccounts.map((a) => a.id);
    await applyBulkFundApplicability(p, club.id, ids, "CAPITAL");

    const audits = await db().auditLog.findMany({
      where: {
        clubId: club.id,
        action: "coa.account.bulk-fund-applicability",
      },
    });
    expect(audits.length).toBe(1);
    const after = audits[0].afterJson ? JSON.parse(String(audits[0].afterJson)) : {};
    expect(after.updated).toBe(3);
    expect(after.skippedBs).toBe(0);
    expect(after.requested).toBe(3);
    expect(after.fundApplicability).toBe("CAPITAL");
  });

  it("empty accountIds is a no-op (defensive — the server action already validates non-empty)", async () => {
    const club = await bootstrapAccountingClub("v15.2-Bulk-Empty");
    const p = await controllerFor(club.id);
    const result = await applyBulkFundApplicability(p, club.id, [], "CAPITAL");
    expect(result.updated).toBe(0);
    expect(result.skippedBs).toBe(0);
    expect(result.requested).toBe(0);
  });

  it("REJECTS a caller who lacks coa:write on the club", async () => {
    const club = await bootstrapAccountingClub("v15.2-Bulk-No-Permission");
    // STAFF role has only members:read + events:read.
    const staffEmail = `staff-${Math.random().toString(36).slice(2, 10)}@example.com`;
    await makeUser({ email: staffEmail, role: "STAFF", clubId: club.id });
    const staff = await principalFor(staffEmail);
    const plAccounts = await db().account.findMany({
      where: { clubId: club.id, type: { in: ["REVENUE", "EXPENSE"] } },
      take: 1,
      select: { id: true },
    });
    await expect(
      applyBulkFundApplicability(staff, club.id, plAccounts.map((a) => a.id), "CAPITAL"),
    ).rejects.toThrow(/permission/i);
  });

  it("tenant scope — passing another club's accountIds does NOT update the other club (silently zero matches)", async () => {
    const clubA = await bootstrapAccountingClub("v15.2-Tenant-A");
    const clubB = await bootstrapAccountingClub("v15.2-Tenant-B");
    const p = await controllerFor(clubA.id);
    // Try to bulk-set fundApplicability on clubB's accounts as clubA's controller.
    const bAccounts = await db().account.findMany({
      where: { clubId: clubB.id, type: { in: ["REVENUE", "EXPENSE"] } },
      take: 3,
      select: { id: true, fundApplicability: true },
    });
    const originals = new Map(bAccounts.map((a) => [a.id, a.fundApplicability]));
    const result = await applyBulkFundApplicability(
      p,
      clubA.id,
      bAccounts.map((a) => a.id),
      "CAPITAL",
    );
    // The `where: { clubId: clubA.id }` filter on the read means
    // NO clubB rows are loaded → nothing to update.
    expect(result.updated).toBe(0);
    expect(result.skippedBs).toBe(0);
    // Verify clubB's accounts are untouched.
    const readback = await db().account.findMany({
      where: { id: { in: bAccounts.map((a) => a.id) } },
      select: { id: true, fundApplicability: true },
    });
    for (const r of readback) {
      expect(r.fundApplicability).toBe(originals.get(r.id) ?? null);
    }
  });
});

describe("v15.2 CoA-page-shape end-to-end — create P&L account, flip to CAPITAL, read back", () => {
  it("creates a REVENUE account defaulted to OPERATING, then bulk-flips it to CAPITAL, then reads it back", async () => {
    // Mirrors the exact operator flow: create → bulk update → refresh.
    const club = await bootstrapAccountingClub("v15.2-Founder-Flow");
    const p = await controllerFor(club.id);
    const { account } = await createAccount(p, club.id, {
      accountNumber: "4599",
      name: "Special Assessment 2026",
      type: "REVENUE",
      fsGroupKey: "IS_MEMBERSHIP_DUES",
    });
    // Slice 1 default landed as OPERATING.
    const created = await db().account.findUniqueOrThrow({
      where: { id: account.id },
      select: { fundApplicability: true },
    });
    expect(created.fundApplicability).toBe("OPERATING");

    // Bulk-flip using the exact helper the server action calls.
    const result = await applyBulkFundApplicability(p, club.id, [account.id], "CAPITAL");
    expect(result.updated).toBe(1);

    // "Refresh the page" — same read shape the CoA page uses
    // (findMany with include), which relies on the base Account
    // model to carry the fundApplicability field.
    const reload = await db().account.findMany({
      where: { clubId: club.id, id: account.id },
      include: { category: true, fsGroup: true, defaultDepartment: true, parent: true },
    });
    expect(reload.length).toBe(1);
    expect(reload[0].fundApplicability).toBe("CAPITAL");
  });
});
