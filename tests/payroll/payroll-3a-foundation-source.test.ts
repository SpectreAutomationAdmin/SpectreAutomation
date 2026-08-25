// Payroll-3A slice 1 (2026-08-29) — Schema + enums + permissions
// source-contract + minimal Prisma smoke test.
//
// This slice is STRUCTURAL ONLY per the Payroll-3A brief. No
// gross-to-net calculation, no CRA rates, no posting. The tests
// below prove the additive schema landed cleanly and the canonical
// separation-of-duties permission model matches §28 + §31.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { PERMISSIONS, ROLE_PERMISSIONS } from "@/lib/permissions";
import { resetDb, seedRbac } from "../util/db";

// ---------------------------------------------------------------------------
// Source-contract pins
// ---------------------------------------------------------------------------

describe("Payroll-3A · schema source-contract", () => {
  const sqliteSchema = fs.readFileSync(
    path.resolve(process.cwd(), "prisma/schema.prisma"),
    "utf8",
  );
  const pgSchema = fs.readFileSync(
    path.resolve(process.cwd(), "prisma-postgres/schema.prisma"),
    "utf8",
  );
  const pgMigration = fs.readFileSync(
    path.resolve(process.cwd(), "prisma-postgres/migrations/20260829_payroll3a_foundation/migration.sql"),
    "utf8",
  );

  const REQUIRED_MODELS = [
    "PayrollClubConfig",
    "PayrollPayGroup",
    "PayrollPayGroupMember",
    "PayrollPayPeriod",
    "PayrollBatch",
    "PayrollBatchEmployee",
    "PayrollBatchEarning",
    "PayrollBatchDeduction",
    "PayrollBatchAllowanceSnapshot",
    "PayrollApprovedTimeEntry",
  ];

  it("all canonical Payroll-3A models are defined in the SQLite schema", () => {
    for (const model of REQUIRED_MODELS) {
      expect(sqliteSchema).toMatch(new RegExp(`^model ${model} \\{`, "m"));
    }
  });

  it("all canonical Payroll-3A models are defined in the Postgres schema", () => {
    for (const model of REQUIRED_MODELS) {
      expect(pgSchema).toMatch(new RegExp(`^model ${model} \\{`, "m"));
    }
  });

  it("the Postgres migration is additive-only — no DROP / ALTER of pre-existing tables", () => {
    // Every ALTER/DROP in this migration must operate on Payroll-3A
    // tables that the same migration creates. Guards against
    // accidental touching of accepted HR-2C rows.
    const alterMatches = pgMigration.match(/ALTER TABLE\s+"([^"]+)"/g) ?? [];
    const dropMatches = pgMigration.match(/DROP\s+(TABLE|COLUMN|CONSTRAINT|INDEX)/gi) ?? [];
    for (const m of alterMatches) {
      const tableMatch = m.match(/"([^"]+)"/);
      const table = tableMatch?.[1] ?? "";
      const looksPayroll3A = table.startsWith("Payroll") &&
        REQUIRED_MODELS.some((model) => table === model);
      expect(looksPayroll3A, `ALTER TABLE ${table} — Payroll-3A migration must not modify pre-existing tables`).toBe(true);
    }
    expect(dropMatches).toEqual([]);
  });

  it("PayrollBatch carries the canonical lifecycle enum values in a comment", () => {
    const batchModel = sqliteSchema.slice(sqliteSchema.indexOf("model PayrollBatch "));
    expect(batchModel).toMatch(/DRAFT/);
    expect(batchModel).toMatch(/PREPARED/);
    expect(batchModel).toMatch(/SUBMITTED_FOR_APPROVAL/);
    expect(batchModel).toMatch(/APPROVED/);
    expect(batchModel).toMatch(/POSTED/);
    expect(batchModel).toMatch(/VOIDED/);
  });

  it("PayrollBatch links to a Work Intake item (nullable + unique)", () => {
    const batchModel = sqliteSchema.slice(
      sqliteSchema.indexOf("model PayrollBatch "),
      sqliteSchema.indexOf("model PayrollBatchEmployee "),
    );
    expect(batchModel).toMatch(/workIntakeItemId\s+String\?\s+@unique/);
  });

  it("PayrollBatchEarning preserves employmentAssignmentId (multi-role §14)", () => {
    const earningModel = sqliteSchema.slice(sqliteSchema.indexOf("model PayrollBatchEarning "));
    expect(earningModel).toMatch(/employmentAssignmentId\s+String\?/);
    expect(earningModel).toMatch(/employmentAssignment\s+EmployeeEmploymentAssignment\?\s+@relation/);
  });

  it("PayrollBatchEmployee stores readiness flags but NOT plaintext SIN or banking", () => {
    const beModel = sqliteSchema.slice(
      sqliteSchema.indexOf("model PayrollBatchEmployee "),
      sqliteSchema.indexOf("model PayrollBatchEarning "),
    );
    // Readiness flags present.
    for (const flag of [
      "bankingReady", "bankingStatus",
      "sinReady", "federalTd1Ready", "provincialTd1Ready", "compensationReady",
    ]) {
      expect(beModel).toContain(flag);
    }
    // Plaintext sensitive fields ABSENT.
    for (const forbidden of [
      "sin ", "sinPlain", "socialInsurance",
      "bankAccount ", "accountNumber ", "transitNumber ", "institutionNumber ",
    ]) {
      expect(beModel).not.toContain(forbidden);
    }
  });

  it("PayrollApprovedTimeEntry preserves employmentAssignmentId + approval state (§19-20)", () => {
    const teModel = sqliteSchema.slice(sqliteSchema.indexOf("model PayrollApprovedTimeEntry "));
    expect(teModel).toMatch(/employmentAssignmentId\s+String\?/);
    expect(teModel).toMatch(/approvalState\s+String/);
    expect(teModel).toMatch(/DRAFT/);
    expect(teModel).toMatch(/APPROVED/);
    expect(teModel).toMatch(/POSTED/);
  });

  it("Postgres migration mirrors the SQLite model set exactly (same tables created)", () => {
    for (const model of REQUIRED_MODELS) {
      expect(pgMigration).toMatch(new RegExp(`CREATE TABLE "${model}"`));
    }
  });
});

// ---------------------------------------------------------------------------
// Permission source-contract
// ---------------------------------------------------------------------------

describe("Payroll-3A · canonical permission separation-of-duties (§28 + §31)", () => {
  const CANONICAL_KEYS = [
    "payroll:prepare",
    "payroll:edit",
    "payroll:submit",
    "payroll:post",
    "payroll:void",
    "payroll:paygroup:read",
    "payroll:paygroup:write",
    "payroll:config:read",
    "payroll:config:write",
  ] as const;

  it("every canonical Payroll-3A key exists in the PERMISSIONS catalogue", () => {
    for (const key of CANONICAL_KEYS) {
      expect(PERMISSIONS[key], `PERMISSIONS missing ${key}`).toBeDefined();
    }
  });

  it("CLUB_ADMIN holds every canonical Payroll-3A key EXCEPT payroll:post", () => {
    const grants = ROLE_PERMISSIONS.CLUB_ADMIN as readonly string[];
    for (const key of CANONICAL_KEYS) {
      if (key === "payroll:post") {
        expect(grants).not.toContain(key);
      } else {
        expect(grants, `CLUB_ADMIN must hold ${key}`).toContain(key);
      }
    }
  });

  it("CONTROLLER holds payroll:post + read-only Payroll-3A grants; NO prepare/edit/submit/void/write", () => {
    const grants = ROLE_PERMISSIONS.CONTROLLER as readonly string[];
    expect(grants).toContain("payroll:read");
    expect(grants).toContain("payroll:approve");
    expect(grants).toContain("payroll:post");
    expect(grants).toContain("payroll:paygroup:read");
    expect(grants).toContain("payroll:config:read");
    // Separation of duties — Controller does NOT prepare / edit /
    // submit / void payroll batches, and NEVER writes pay groups
    // or config.
    for (const banned of [
      "payroll:prepare", "payroll:edit", "payroll:submit", "payroll:void",
      "payroll:paygroup:write", "payroll:config:write",
    ]) {
      expect(grants, `CONTROLLER must NOT hold ${banned}`).not.toContain(banned);
    }
  });

  it("CONTROLLER never gains SIN / banking / tax reveal via Payroll-3A permissions (§31)", () => {
    const grants = ROLE_PERMISSIONS.CONTROLLER as readonly string[];
    for (const banned of [
      "hr:sin:reveal", "hr:banking:reveal", "hr:tax:reveal",
      "hr:sin:read", "hr:banking:read", "hr:tax:read",
    ]) {
      expect(grants, `CONTROLLER must NOT hold ${banned}`).not.toContain(banned);
    }
  });

  it("PAYROLL_ADMIN holds prepare/edit/submit + paygroup + config writes; NO approve/post/void", () => {
    const grants = ROLE_PERMISSIONS.PAYROLL_ADMIN as readonly string[];
    for (const required of [
      "payroll:prepare", "payroll:edit", "payroll:submit",
      "payroll:paygroup:read", "payroll:paygroup:write",
      "payroll:config:read", "payroll:config:write",
    ]) {
      expect(grants, `PAYROLL_ADMIN must hold ${required}`).toContain(required);
    }
    for (const banned of ["payroll:post", "payroll:void"]) {
      expect(grants, `PAYROLL_ADMIN must NOT hold ${banned}`).not.toContain(banned);
    }
  });

  it("GENERAL_MANAGER + AUDITOR_READ_ONLY hold read-only Payroll-3A grants only", () => {
    for (const role of ["GENERAL_MANAGER", "AUDITOR_READ_ONLY"] as const) {
      const grants = ROLE_PERMISSIONS[role] as readonly string[];
      for (const readOnly of ["payroll:paygroup:read", "payroll:config:read"]) {
        expect(grants, `${role} must hold ${readOnly}`).toContain(readOnly);
      }
      for (const banned of [
        "payroll:prepare", "payroll:edit", "payroll:submit",
        "payroll:post", "payroll:void",
        "payroll:paygroup:write", "payroll:config:write",
      ]) {
        expect(grants, `${role} must NOT hold ${banned}`).not.toContain(banned);
      }
    }
  });

  it("MEMBER / STAFF / BOARD_READ_ONLY hold ZERO canonical Payroll-3A keys", () => {
    for (const role of ["MEMBER", "STAFF", "BOARD_READ_ONLY"] as const) {
      const grants = ROLE_PERMISSIONS[role] as readonly string[];
      for (const key of CANONICAL_KEYS) {
        expect(grants, `${role} must NOT hold ${key}`).not.toContain(key);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Minimal Prisma smoke — the new models can be created + tenant-scoped
// ---------------------------------------------------------------------------

describe("Payroll-3A · minimal Prisma smoke", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); }, 60_000);
  beforeEach(async () => { await resetDb(); await seedRbac(); }, 60_000);

  it("can create a Club → PayGroup → PayPeriod → Batch → BatchEmployee tenant-scoped chain", async () => {
    const club = await prisma.club.create({
      data: { name: "3A Test", slug: `3a-test-${Date.now()}` },
    });
    const emp = await prisma.employee.create({
      data: {
        clubId: club.id,
        employeeNumber: "P3A-1",
        firstName: "Test", lastName: "Employee",
        employeeLifecycle: "ACTIVE", status: "ACTIVE",
      },
    });
    const payGroup = await prisma.payrollPayGroup.create({
      data: {
        clubId: club.id, code: "HOURLY_BW",
        name: "Hourly - Biweekly", payFrequency: "BIWEEKLY",
      },
    });
    const payPeriod = await prisma.payrollPayPeriod.create({
      data: {
        clubId: club.id, payGroupId: payGroup.id,
        sequenceInYear: 1, taxYear: 2026,
        periodStart: new Date("2026-09-01"), periodEnd: new Date("2026-09-15"),
        payDate: new Date("2026-09-19"),
      },
    });
    const batch = await prisma.payrollBatch.create({
      data: {
        clubId: club.id, payGroupId: payGroup.id, payPeriodId: payPeriod.id,
        status: "DRAFT",
      },
    });
    const batchEmp = await prisma.payrollBatchEmployee.create({
      data: {
        clubId: club.id, batchId: batch.id, employeeId: emp.id,
        jurisdictionCountry: "CA", jurisdictionProvince: "AB",
        employeeLifecycleAtPrep: "ACTIVE",
      },
    });
    expect(batchEmp.status).toBe("PENDING");
    expect(batchEmp.grossPay).toBeNull();
    expect(batchEmp.netPay).toBeNull();
    // Structural — no calculation attached at this layer.
  });

  it("PayrollBatch(clubId, payGroupId, payPeriodId, sequence) uniqueness prevents duplicate batches", async () => {
    const club = await prisma.club.create({
      data: { name: "3A Uniq", slug: `3a-uniq-${Date.now()}` },
    });
    const pg = await prisma.payrollPayGroup.create({
      data: { clubId: club.id, code: "SAL_SM", name: "Salaried SM", payFrequency: "SEMI_MONTHLY" },
    });
    const pp = await prisma.payrollPayPeriod.create({
      data: {
        clubId: club.id, payGroupId: pg.id, sequenceInYear: 1, taxYear: 2026,
        periodStart: new Date("2026-09-01"), periodEnd: new Date("2026-09-15"),
        payDate: new Date("2026-09-19"),
      },
    });
    await prisma.payrollBatch.create({
      data: { clubId: club.id, payGroupId: pg.id, payPeriodId: pp.id, sequence: 1 },
    });
    await expect(
      prisma.payrollBatch.create({
        data: { clubId: club.id, payGroupId: pg.id, payPeriodId: pp.id, sequence: 1 },
      }),
    ).rejects.toThrow();
  });

  it("PayrollBatchEmployee(batchId, employeeId) uniqueness prevents duplicate inclusion", async () => {
    const club = await prisma.club.create({
      data: { name: "3A Dedup", slug: `3a-dedup-${Date.now()}` },
    });
    const emp = await prisma.employee.create({
      data: {
        clubId: club.id, employeeNumber: "P3A-D",
        firstName: "D", lastName: "Dedup",
        employeeLifecycle: "ACTIVE", status: "ACTIVE",
      },
    });
    const pg = await prisma.payrollPayGroup.create({
      data: { clubId: club.id, code: "H_BW", name: "H BW", payFrequency: "BIWEEKLY" },
    });
    const pp = await prisma.payrollPayPeriod.create({
      data: {
        clubId: club.id, payGroupId: pg.id, sequenceInYear: 1, taxYear: 2026,
        periodStart: new Date("2026-09-01"), periodEnd: new Date("2026-09-15"),
        payDate: new Date("2026-09-19"),
      },
    });
    const batch = await prisma.payrollBatch.create({
      data: { clubId: club.id, payGroupId: pg.id, payPeriodId: pp.id },
    });
    await prisma.payrollBatchEmployee.create({
      data: {
        clubId: club.id, batchId: batch.id, employeeId: emp.id,
        jurisdictionCountry: "CA", employeeLifecycleAtPrep: "ACTIVE",
      },
    });
    await expect(
      prisma.payrollBatchEmployee.create({
        data: {
          clubId: club.id, batchId: batch.id, employeeId: emp.id,
          jurisdictionCountry: "CA", employeeLifecycleAtPrep: "ACTIVE",
        },
      }),
    ).rejects.toThrow();
  });
});
