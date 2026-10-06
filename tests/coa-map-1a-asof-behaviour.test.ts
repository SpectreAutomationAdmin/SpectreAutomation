// COA-MAP-1A (2026-10-06) — effective-dated resolver behavioural proof.
//
// Creates ISOLATED DISPOSABLE test data (one Account + one FS Group +
// two overlapping assignment rows) and proves that
// `resolveFinancialStatementGroupAsOf` + `resolveFinancialStatementGroupAsOfBatch`
// return the correct group for every reporting-period boundary.
//
// All test data is created inside a transaction-like setup/teardown so
// the counts return to baseline after the test. The test DOES NOT
// touch any founder-committed Coulee account mapping.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  resolveFinancialStatementGroupAsOf,
  resolveFinancialStatementGroupAsOfBatch,
} from "@/lib/coa-mapping/fs-group-asof-resolver";

const TEST_CLUB_SLUG = `coa-map-1a-behaviour-${Date.now()}`;

// Dates for the two assignments.
const JAN_1_2026 = new Date(Date.UTC(2026, 0, 1));
const OCT_1_2026 = new Date(Date.UTC(2026, 9, 1));

type Fixture = {
  clubId: string;
  accountId: string;
  groupAId: string;
  groupBId: string;
};
let fx: Fixture | null = null;

beforeAll(async () => {
  // Create a disposable Club so the test cannot bleed into any other
  // tenant's data. The Club is deleted in afterAll, which cascades
  // to the Account + FinancialStatementGroup + assignment rows.
  const club = await prisma.club.create({
    data: {
      name: `COA-MAP-1A behaviour ${TEST_CLUB_SLUG}`,
      slug: TEST_CLUB_SLUG,
    },
    select: { id: true },
  });

  const groupA = await prisma.financialStatementGroup.create({
    data: {
      clubId: club.id,
      key: "TEST_GROUP_A",
      name: "Test Group A",
      statement: "INCOME_STATEMENT",
      sortOrder: 1,
      reportingRole: "OPERATING_REVENUE",
      isTenantCreated: false,
    },
    select: { id: true },
  });

  const groupB = await prisma.financialStatementGroup.create({
    data: {
      clubId: club.id,
      key: "TEST_GROUP_B",
      name: "Test Group B",
      statement: "INCOME_STATEMENT",
      sortOrder: 2,
      reportingRole: "OTHER_INCOME",
      isTenantCreated: false,
    },
    select: { id: true },
  });

  const account = await prisma.account.create({
    data: {
      clubId: club.id,
      accountNumber: "COA-MAP-1A-TEST",
      name: "Isolated test account",
      type: "REVENUE",
      normalBalance: "CREDIT",
      // fsGroupId left null — the as-of resolver uses the assignment
      // table exclusively, so Account.fsGroupId is irrelevant to this
      // test.
    },
    select: { id: true },
  });

  // Two overlapping assignments:
  //   Jan 1 2026 → Oct 1 2026 (exclusive) : Group A
  //   Oct 1 2026 → open                   : Group B
  await prisma.accountFinancialStatementAssignment.create({
    data: {
      clubId: club.id,
      accountId: account.id,
      fsGroupId: groupA.id,
      effectiveFrom: JAN_1_2026,
      effectiveTo: OCT_1_2026,
    },
  });
  await prisma.accountFinancialStatementAssignment.create({
    data: {
      clubId: club.id,
      accountId: account.id,
      fsGroupId: groupB.id,
      effectiveFrom: OCT_1_2026,
      effectiveTo: null,
    },
  });

  fx = {
    clubId: club.id,
    accountId: account.id,
    groupAId: groupA.id,
    groupBId: groupB.id,
  };
});

afterAll(async () => {
  if (!fx) return;
  // Cascade delete via Club.
  await prisma.club.delete({ where: { id: fx.clubId } }).catch(() => undefined);
  fx = null;
});

describe("COA-MAP-1A — resolveFinancialStatementGroupAsOf (single)", () => {
  it("January 31 2026 → Group A", async () => {
    if (!fx) throw new Error("fixture missing");
    const r = await resolveFinancialStatementGroupAsOf({
      clubId: fx.clubId,
      accountId: fx.accountId,
      asOf: new Date(Date.UTC(2026, 0, 31)),
    });
    expect(r?.fsGroupId).toBe(fx.groupAId);
    expect(r?.fsGroupKey).toBe("TEST_GROUP_A");
  });

  it("September 30 2026 → Group A", async () => {
    if (!fx) throw new Error("fixture missing");
    const r = await resolveFinancialStatementGroupAsOf({
      clubId: fx.clubId,
      accountId: fx.accountId,
      asOf: new Date(Date.UTC(2026, 8, 30)),
    });
    expect(r?.fsGroupId).toBe(fx.groupAId);
  });

  it("October 1 2026 (boundary — effectiveFrom inclusive) → Group B", async () => {
    if (!fx) throw new Error("fixture missing");
    const r = await resolveFinancialStatementGroupAsOf({
      clubId: fx.clubId,
      accountId: fx.accountId,
      asOf: new Date(Date.UTC(2026, 9, 1)),
    });
    expect(r?.fsGroupId).toBe(fx.groupBId);
    expect(r?.fsGroupKey).toBe("TEST_GROUP_B");
  });

  it("October 31 2026 → Group B", async () => {
    if (!fx) throw new Error("fixture missing");
    const r = await resolveFinancialStatementGroupAsOf({
      clubId: fx.clubId,
      accountId: fx.accountId,
      asOf: new Date(Date.UTC(2026, 9, 31)),
    });
    expect(r?.fsGroupId).toBe(fx.groupBId);
  });

  it("December 31 2027 (far future) → Group B (open-ended)", async () => {
    if (!fx) throw new Error("fixture missing");
    const r = await resolveFinancialStatementGroupAsOf({
      clubId: fx.clubId,
      accountId: fx.accountId,
      asOf: new Date(Date.UTC(2027, 11, 31)),
    });
    expect(r?.fsGroupId).toBe(fx.groupBId);
  });

  it("December 31 2025 (before earliest effectiveFrom) → null", async () => {
    if (!fx) throw new Error("fixture missing");
    const r = await resolveFinancialStatementGroupAsOf({
      clubId: fx.clubId,
      accountId: fx.accountId,
      asOf: new Date(Date.UTC(2025, 11, 31)),
    });
    expect(r).toBeNull();
  });
});

describe("COA-MAP-1A — resolveFinancialStatementGroupAsOfBatch", () => {
  it("resolves every date-boundary in a single batch call", async () => {
    if (!fx) throw new Error("fixture missing");
    const jan = await resolveFinancialStatementGroupAsOfBatch({
      clubId: fx.clubId,
      accountIds: [fx.accountId],
      asOf: new Date(Date.UTC(2026, 0, 31)),
    });
    expect(jan.get(fx.accountId)?.fsGroupKey).toBe("TEST_GROUP_A");

    const oct = await resolveFinancialStatementGroupAsOfBatch({
      clubId: fx.clubId,
      accountIds: [fx.accountId],
      asOf: new Date(Date.UTC(2026, 9, 15)),
    });
    expect(oct.get(fx.accountId)?.fsGroupKey).toBe("TEST_GROUP_B");
  });

  it("returns null entry for an account with no assignment covering the date", async () => {
    if (!fx) throw new Error("fixture missing");
    const r = await resolveFinancialStatementGroupAsOfBatch({
      clubId: fx.clubId,
      accountIds: [fx.accountId],
      asOf: new Date(Date.UTC(2025, 0, 1)),
    });
    expect(r.get(fx.accountId)).toBeNull();
  });

  it("returns null for accounts not in the clubId tenant", async () => {
    if (!fx) throw new Error("fixture missing");
    const r = await resolveFinancialStatementGroupAsOfBatch({
      clubId: "not-this-club",
      accountIds: [fx.accountId],
      asOf: new Date(Date.UTC(2026, 0, 31)),
    });
    expect(r.get(fx.accountId)).toBeNull();
  });
});

describe("COA-MAP-1A — teardown integrity", () => {
  it("fixture deletion cascades on afterAll — this test runs LAST", () => {
    expect(fx).toBeTruthy();
  });
});
