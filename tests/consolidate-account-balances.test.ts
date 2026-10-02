// TB-HIST-7 (2026-10-01) — presentation-time dimensional consolidation.
//
// Tests the pure `consolidateAccountBalances` helper that collapses a
// dimensional AccountBalance array (one entry per Account × Dept × Fund
// tuple as emitted by the ReportingLedgerSnapshot resolver) into one
// entry per natural account. Preserves per-dimension provenance under
// `.dimensional[]` for a future drill-down UI.

import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  consolidateAccountBalances,
  type AccountBalance,
} from "@/lib/accounting/balance";

const D = (v: string | number): Prisma.Decimal => new Prisma.Decimal(v);

function dimRow(args: {
  accountId: string;
  accountNumber: string;
  accountName: string;
  accountType: AccountBalance["accountType"];
  normalBalance: AccountBalance["normalBalance"];
  debit: number;
  credit: number;
  department: string | null;
  fund?: string | null;
  fsGroupKey?: string | null;
}): AccountBalance {
  const debit = D(args.debit);
  const credit = D(args.credit);
  const signed = debit.minus(credit);
  const normal = args.normalBalance === "DEBIT" ? signed : signed.negated();
  return {
    accountId: args.accountId,
    accountNumber: args.accountNumber,
    accountName: args.accountName,
    accountType: args.accountType,
    normalBalance: args.normalBalance,
    debitTotal: debit,
    creditTotal: credit,
    signedBalance: signed,
    naturalBalance: normal,
    fundApplicability: null,
    fsGroupKey: args.fsGroupKey ?? null,
    dimensional: [{
      department: args.department,
      fund: args.fund ?? null,
      debit, credit, signedBalance: signed, naturalBalance: normal,
    }],
  };
}

// -------------------------------------------------------------------
// A — same Account / different Department aggregates
// -------------------------------------------------------------------
describe("TB-HIST-7 §10 A — same Account / different Department aggregates", () => {
  it("6104 across ADMIN + CLUBHOUSE collapses to one row with summed amounts", () => {
    const dim = [
      dimRow({ accountId: "a1", accountNumber: "6104", accountName: "Consultant & Prof Svcs", accountType: "EXPENSE", normalBalance: "DEBIT", debit: 12000, credit: 0, department: "ADMIN" }),
      dimRow({ accountId: "a1", accountNumber: "6104", accountName: "Consultant & Prof Svcs", accountType: "EXPENSE", normalBalance: "DEBIT", debit: 4500,  credit: 0, department: "CLUBHOUSE" }),
    ];
    const out = consolidateAccountBalances(dim);
    expect(out).toHaveLength(1);
    expect(out[0].accountNumber).toBe("6104");
    expect(out[0].debitTotal.toString()).toBe("16500");
    expect(out[0].creditTotal.toString()).toBe("0");
    expect(out[0].signedBalance.toString()).toBe("16500");
    expect(out[0].dimensional).toHaveLength(2);
    expect(out[0].dimensional![0].department).toBe("ADMIN");
    expect(out[0].dimensional![1].department).toBe("CLUBHOUSE");
  });
});

// -------------------------------------------------------------------
// B — same Account / different Fund aggregates
// -------------------------------------------------------------------
describe("TB-HIST-7 §10 B — same Account / different Fund aggregates", () => {
  it("4100 across OPERATING + CAPITAL funds collapses to one row", () => {
    const dim = [
      dimRow({ accountId: "r1", accountNumber: "4100", accountName: "Member Dues", accountType: "REVENUE", normalBalance: "CREDIT", debit: 0, credit: 60000, department: null, fund: "OPERATING" }),
      dimRow({ accountId: "r1", accountNumber: "4100", accountName: "Member Dues", accountType: "REVENUE", normalBalance: "CREDIT", debit: 0, credit: 15000, department: null, fund: "CAPITAL" }),
    ];
    const out = consolidateAccountBalances(dim);
    expect(out).toHaveLength(1);
    expect(out[0].creditTotal.toString()).toBe("75000");
    expect(out[0].signedBalance.toString()).toBe("-75000");
    expect(out[0].naturalBalance.toString()).toBe("75000");
    expect(out[0].dimensional![0].fund).toBe("OPERATING");
    expect(out[0].dimensional![1].fund).toBe("CAPITAL");
  });
});

// -------------------------------------------------------------------
// C — Offsetting dimensional balances net to zero at account level
// -------------------------------------------------------------------
describe("TB-HIST-7 §10 C — offsetting dimensional rows net correctly", () => {
  it("1514 split +247,875.94 / -247,875.94 nets to $0.00", () => {
    const dim = [
      dimRow({ accountId: "a2", accountNumber: "1514", accountName: "Golf Course - Maintenance Bldg", accountType: "ASSET", normalBalance: "DEBIT", debit: 247875.94, credit: 0, department: "GROUNDS" }),
      dimRow({ accountId: "a2", accountNumber: "1514", accountName: "Golf Course - Maintenance Bldg", accountType: "ASSET", normalBalance: "DEBIT", debit: 0, credit: 247875.94, department: null }),
    ];
    const out = consolidateAccountBalances(dim);
    expect(out).toHaveLength(1);
    expect(out[0].signedBalance.toString()).toBe("0");
    expect(out[0].naturalBalance.toString()).toBe("0");
    // Classic TB "net on natural side" rule: 0 debit, 0 credit when
    // the account nets to exactly zero. (Gross sides preserved for
    // reconciliation reporting.)
    expect(out[0].debitTotal.toString()).toBe("247875.94");
    expect(out[0].creditTotal.toString()).toBe("247875.94");
  });
});

// -------------------------------------------------------------------
// D — Consolidated BS/IS has no duplicate natural-account lines
// -------------------------------------------------------------------
describe("TB-HIST-7 §10 D-E — no duplicate natural-account lines", () => {
  it("6098 appearing in 4 departments collapses to a single consolidated line", () => {
    const dim = [
      dimRow({ accountId: "e1", accountNumber: "6098", accountName: "Payroll Allocation", accountType: "EXPENSE", normalBalance: "DEBIT", debit: 50000, credit: 0, department: "GROUNDS" }),
      dimRow({ accountId: "e1", accountNumber: "6098", accountName: "Payroll Allocation", accountType: "EXPENSE", normalBalance: "DEBIT", debit: 30000, credit: 0, department: "ADMIN" }),
      dimRow({ accountId: "e1", accountNumber: "6098", accountName: "Payroll Allocation", accountType: "EXPENSE", normalBalance: "DEBIT", debit: 20000, credit: 0, department: "F&B" }),
      dimRow({ accountId: "e1", accountNumber: "6098", accountName: "Payroll Allocation", accountType: "EXPENSE", normalBalance: "DEBIT", debit: 10000, credit: 0, department: "CLUBHOUSE" }),
    ];
    const out = consolidateAccountBalances(dim);
    expect(out).toHaveLength(1);
    expect(out[0].debitTotal.toString()).toBe("110000");
    expect(out[0].dimensional).toHaveLength(4);
    expect(out[0].dimensional!.map((d) => d.department)).toEqual(["GROUNDS", "ADMIN", "F&B", "CLUBHOUSE"]);
  });
});

// -------------------------------------------------------------------
// F — Dimensional preservation for drill-down
// -------------------------------------------------------------------
describe("TB-HIST-7 §10 F-G — dimensional detail preserved for drill-down", () => {
  it("consolidated row keeps dimensional per-(dept,fund) breakdown", () => {
    const dim = [
      dimRow({ accountId: "x1", accountNumber: "4000", accountName: "Rev", accountType: "REVENUE", normalBalance: "CREDIT", debit: 0, credit: 100, department: "F&B",   fund: "OPERATING" }),
      dimRow({ accountId: "x1", accountNumber: "4000", accountName: "Rev", accountType: "REVENUE", normalBalance: "CREDIT", debit: 0, credit: 200, department: "ADMIN", fund: "OPERATING" }),
      dimRow({ accountId: "x1", accountNumber: "4000", accountName: "Rev", accountType: "REVENUE", normalBalance: "CREDIT", debit: 0, credit:  50, department: "F&B",   fund: "CAPITAL" }),
    ];
    const out = consolidateAccountBalances(dim);
    expect(out).toHaveLength(1);
    const d = out[0].dimensional!;
    expect(d).toHaveLength(3);
    // Three (dept, fund) tuples preserved verbatim.
    expect(d.map((e) => `${e.department}/${e.fund}`)).toEqual(["F&B/OPERATING", "ADMIN/OPERATING", "F&B/CAPITAL"]);
    expect(out[0].creditTotal.toString()).toBe("350");
  });
});

// -------------------------------------------------------------------
// Account ordering preserved (first-occurrence stable sort)
// -------------------------------------------------------------------
describe("TB-HIST-7 — stable ordering (first occurrence wins)", () => {
  it("account 1000 placed first, 2000 placed second, interleaved dims", () => {
    const dim = [
      dimRow({ accountId: "a-1000", accountNumber: "1000", accountName: "Cash",   accountType: "ASSET", normalBalance: "DEBIT", debit: 100, credit: 0, department: "ADMIN" }),
      dimRow({ accountId: "b-2000", accountNumber: "2000", accountName: "AP",     accountType: "LIABILITY", normalBalance: "CREDIT", debit: 0, credit: 50, department: null }),
      dimRow({ accountId: "a-1000", accountNumber: "1000", accountName: "Cash",   accountType: "ASSET", normalBalance: "DEBIT", debit: 200, credit: 0, department: "F&B" }),
    ];
    const out = consolidateAccountBalances(dim);
    expect(out).toHaveLength(2);
    expect(out[0].accountNumber).toBe("1000");
    expect(out[0].debitTotal.toString()).toBe("300");
    expect(out[1].accountNumber).toBe("2000");
  });
});

// -------------------------------------------------------------------
// Operational-ledger passthrough — rows without `.dimensional` are
// still consolidated (one entry per accountId already).
// -------------------------------------------------------------------
describe("TB-HIST-7 — operational-ledger rows (no dimensional field) pass through", () => {
  it("one accountId → one output row, dimensional synthesised from the top-level balance", () => {
    const dim: AccountBalance[] = [{
      accountId: "op1",
      accountNumber: "1000",
      accountName: "Cash",
      accountType: "ASSET",
      normalBalance: "DEBIT",
      debitTotal: D(500),
      creditTotal: D(0),
      signedBalance: D(500),
      naturalBalance: D(500),
      fundApplicability: null,
      fsGroupKey: null,
      // dimensional NOT provided
    }];
    const out = consolidateAccountBalances(dim);
    expect(out).toHaveLength(1);
    expect(out[0].debitTotal.toString()).toBe("500");
    expect(out[0].dimensional).toHaveLength(1);
    expect(out[0].dimensional![0].department).toBeNull();
  });
});
