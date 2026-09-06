// Payroll-3C-5B (2026-09-04) — Sam sequential YTD from persisted rows.
//
// Covers §10 legacy allowance no-double-count + §29 sequential Sam
// history validation + §30 Sam YTD arithmetic derived from actual
// POSTED rows rather than multiplication shortcuts.
//
// Uses the dev fixture database (Coulee Ridge + Sam Complex). To run:
//   1. `npm run fixture:payroll-founder-preview`
//   2. `npm run fixture:payroll-3c1-components`
//   3. `npx tsx scripts/payroll-3c3d1-sam-reset-history.ts`
//   4. `npx vitest run tests/payroll/sam-ytd-persistence-3c5b.local.test.ts`
//
// Skips (with a console warning) when the fixture isn't present so
// the test is safe to include in the general `vitest` sweep.

import { describe, it, expect } from "vitest";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// -------------------------------------------------------------------
// §10 · Legacy allowance no-double-count
// -------------------------------------------------------------------
describe("Payroll-3C-5B · §10 legacy allowance no-double-count (Sam Complex fixture)", () => {
  it("Sam Complex has ZERO EmployeeAllowance rows — all comp flows through PayrollComponent snapshots", async () => {
    const club = await prisma.club.findFirst({ where: { slug: "coulee-ridge" } });
    if (!club) { console.warn("SKIP — no coulee-ridge in dev DB"); return; }
    const sam = await prisma.employee.findFirst({
      where: { clubId: club.id, email: "complex.pay@preview.spectre.test" },
    });
    if (!sam) { console.warn("SKIP — no Sam Complex"); return; }

    // If any EmployeeAllowance row exists for Sam AND he also has a
    // recurring PayrollComponent assignment that overlaps its
    // effective window, double-count is possible in the calculator.
    const allowances = await prisma.employeeAllowance.findMany({
      where: { clubId: club.id, employeeId: sam.id },
    });
    expect(allowances.length).toBe(0);

    // Belt-and-suspenders — verify no historical allowance-snapshot
    // row shipped through the legacy path for Sam either.
    const shippedLegacy = await prisma.payrollBatchAllowanceSnapshot.findMany({
      where: { clubId: club.id, employeeId: sam.id },
    });
    expect(shippedLegacy.length).toBe(0);

    await prisma.$disconnect();
  });
});

// -------------------------------------------------------------------
// §29 · Sequential Sam history validation
// §30 · Sam YTD arithmetic from persisted rows
// -------------------------------------------------------------------
describe("Payroll-3C-5B · §29 + §30 Sam sequential YTD from persisted rows", () => {
  it("13 POSTED batches for Sam; Federal/Alberta/Net YTD equals sum of persisted rows", async () => {
    const club = await prisma.club.findFirst({ where: { slug: "coulee-ridge" } });
    if (!club) { console.warn("SKIP — no coulee-ridge in dev DB"); return; }
    const sam = await prisma.employee.findFirst({
      where: { clubId: club.id, email: "complex.pay@preview.spectre.test" },
    });
    if (!sam) { console.warn("SKIP — no Sam Complex"); return; }
    const pg = await prisma.payrollPayGroup.findFirst({
      where: { clubId: club.id, code: "SAL-SM-COMPLEX" },
    });
    if (!pg) { console.warn("SKIP — no SAL-SM-COMPLEX pay group"); return; }

    const bes = await prisma.payrollBatchEmployee.findMany({
      where: {
        clubId: club.id, employeeId: sam.id,
        batch: { status: "POSTED", payGroupId: pg.id, payPeriod: { taxYear: 2026 } },
      },
      include: { batch: { include: { payPeriod: true } } },
      orderBy: { batch: { payPeriod: { payDate: "asc" } } },
    });
    expect(bes.length).toBe(13);

    // Sum every column from the persisted rows — no multiplication.
    let fedYtd = 0, abYtd = 0, netYtd = 0, cppYtd = 0, eiYtd = 0;
    for (const be of bes) {
      fedYtd += Number(be.deductionFederalTax);
      abYtd  += Number(be.deductionProvincialTax);
      netYtd += Number(be.netPay);
      cppYtd += Number(be.deductionCppEeCombined);
      eiYtd  += Number(be.deductionEiEe);
    }

    // §29 — are all 13 periods actually identical?
    const distinctFed = new Set(bes.map((b) => Number(b.deductionFederalTax).toFixed(2)));
    const distinctAb  = new Set(bes.map((b) => Number(b.deductionProvincialTax).toFixed(2)));
    // We EXPECT them to be identical because the production CRA YTD
    // credit method with a fully-contributing employee (D=0 at start
    // of year, uniform gross, uniform benefits) produces a stable
    // per-period tax. If this ever splits, it means either PM/PR
    // math shifted or a per-period statutory input changed — either
    // is a genuine regression worth investigating.
    expect(distinctFed.size).toBe(1);
    expect(distinctAb.size).toBe(1);

    // Report the numbers so the founder can eyeball them in the log.
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      count:            bes.length,
      federalPerPay:    Number(bes[0].deductionFederalTax).toFixed(2),
      albertaPerPay:    Number(bes[0].deductionProvincialTax).toFixed(2),
      netPerPay:        Number(bes[0].netPay).toFixed(2),
      federalYtdSum:    fedYtd.toFixed(2),
      albertaYtdSum:    abYtd.toFixed(2),
      netYtdSum:        netYtd.toFixed(2),
      cppYtdSum:        cppYtd.toFixed(2),
      eiYtdSum:         eiYtd.toFixed(2),
    }, null, 2));

    // Sanity: each per-pay tax matches the frozen 3C-3D.7 baseline.
    expect(Number(bes[0].deductionFederalTax).toFixed(2)).toBe("651.67");
    expect(Number(bes[0].deductionProvincialTax).toFixed(2)).toBe("317.38");
    expect(Number(bes[0].netPay).toFixed(2)).toBe("3037.85");

    // YTD sums equal 13 × per-pay because per-pay is stable.
    expect(fedYtd.toFixed(2)).toBe((651.67 * 13).toFixed(2));
    expect(abYtd.toFixed(2)).toBe((317.38 * 13).toFixed(2));
    expect(netYtd.toFixed(2)).toBe((3037.85 * 13).toFixed(2));

    await prisma.$disconnect();
  });

  it("chronological ordering: 13 payDates correspond to seq 4-16 semi-monthly EOM/15th policy", async () => {
    const club = await prisma.club.findFirst({ where: { slug: "coulee-ridge" } });
    if (!club) { console.warn("SKIP — no coulee-ridge in dev DB"); return; }
    const pg = await prisma.payrollPayGroup.findFirst({
      where: { clubId: club.id, code: "SAL-SM-COMPLEX" },
    });
    if (!pg) return;

    const batches = await prisma.payrollBatch.findMany({
      where: { clubId: club.id, payGroupId: pg.id, status: "POSTED" },
      include: { payPeriod: true },
      orderBy: { payPeriod: { payDate: "asc" } },
    });
    const sequence = batches.map((b) => ({
      seq: b.payPeriod.sequenceInYear,
      payDate: b.payPeriod.payDate.toISOString().slice(0, 10),
    }));

    // Assert the actual seq range (4-16) — Sam was hired 2026-02-02
    // so seq 3 is skipped and seq 16 is the current flagship.
    expect(sequence.map((r) => r.seq)).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    // Assert seq 16 flagship pays on Aug 31 (semi-monthly EOM policy).
    expect(sequence[sequence.length - 1].payDate).toBe("2026-08-31");
    // Assert seq 15 (Aug 15 raw = Saturday) adjusts to Fri Aug 14.
    expect(sequence.find((r) => r.seq === 15)?.payDate).toBe("2026-08-14");

    await prisma.$disconnect();
  });
});
