// HR-1 cross-cutting drift-detection · half-open boundary pin for
// every effective-dated reader in `src/lib/hr/**`.
//
// Contract (documented in `src/lib/hr/employment-periods.ts` and
// `src/lib/hr/compensation.ts` file headers): every effective-dated
// row is a half-open interval `[effectiveFrom, effectiveTo)`. A row
// is ACTIVE at time `t` when
//     effectiveFrom <= t  AND  (effectiveTo IS NULL OR effectiveTo > t)
// The boundary belongs to the NEW row. At `t == B.effectiveFrom`,
// `getEmploymentAt(t)` / `getCompensationAt(t)` MUST return B (not
// A). No `-1ms` arithmetic anywhere.
//
// The per-slice tests (see
// `tests/hr/admin-workflows/employment-periods-effective-dating.test.ts`
// and `tests/hr/financial-systems/compensation-effective-dating.test.ts`)
// prove each reader in isolation. This suite is the DRIFT CHECK: it
// parameterises the same five boundary assertions over EVERY
// registered reader. When HR-2 adds a new effective-dated reader
// (e.g. a `getTaxProfileAt(...)` that becomes a service function
// instead of a helper), it MUST be registered here — otherwise the
// coverage-completeness test at the bottom fails.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import type { Principal } from "@/lib/rbac";

import { openEmploymentPeriod, closeCurrentEmploymentPeriod, getEmploymentAt } from "@/lib/hr/employment-periods";
import { changeCompensation, getCompensationAt } from "@/lib/hr/compensation";

import { resetDb, seedRbac } from "../../util/db";
import { makeAdminHrFixture } from "../admin-workflows/_helpers";

// -----------------------------------------------------------------------------
// Reader registry — every effective-dated point-in-time reader in
// `src/lib/hr/**`. To add a new one: append to this array AND to
// KNOWN_READER_NAMES in the completeness test below.
//
// Each entry provides:
//   - `name`         : human-readable label used in the test title
//   - `seedTwo`      : opens two half-open rows for the fixture Employee.
//                     Returns { periodAFrom, periodBFrom } — the boundary
//                     between A and B. Optionally closes B at closeAt.
//   - `read(t, ctx)` : invokes the reader with the fixture principal +
//                     employee + `t`; returns the ACTIVE row's id (or
//                     null when nothing is active at `t`).
// -----------------------------------------------------------------------------

interface FixtureCtx {
  principal: Principal;
  employeeId: string;
}

interface ReaderRegistration {
  name: string;
  seedTwo: (
    ctx: FixtureCtx,
    dates: { periodAFrom: Date; periodBFrom: Date; closeBAt?: Date },
  ) => Promise<void>;
  read: (t: Date, ctx: FixtureCtx) => Promise<{ id: string; from: Date; to: Date | null } | null>;
}

const READERS: ReaderRegistration[] = [
  {
    name: "getEmploymentAt",
    seedTwo: async (ctx, dates) => {
      await openEmploymentPeriod(ctx.principal, ctx.employeeId, {
        effectiveFrom: dates.periodAFrom,
        employmentType: "FULL_TIME",
        reason: "HIRE",
      });
      await openEmploymentPeriod(ctx.principal, ctx.employeeId, {
        effectiveFrom: dates.periodBFrom,
        employmentType: "PART_TIME",
        reason: "PROMOTION",
      });
      if (dates.closeBAt) {
        await closeCurrentEmploymentPeriod(ctx.principal, ctx.employeeId, dates.closeBAt);
      }
    },
    read: async (t, ctx) => {
      const row = await getEmploymentAt(ctx.principal, ctx.employeeId, t);
      if (!row) return null;
      return { id: row.id, from: row.effectiveFrom, to: row.effectiveTo };
    },
  },
  {
    name: "getCompensationAt",
    seedTwo: async (ctx, dates) => {
      await changeCompensation(ctx.principal, ctx.employeeId, {
        effectiveFrom: dates.periodAFrom,
        amount: "20.00",
        cadence: "HOURLY",
        currency: "CAD",
      });
      await changeCompensation(ctx.principal, ctx.employeeId, {
        effectiveFrom: dates.periodBFrom,
        amount: "25.00",
        cadence: "HOURLY",
        currency: "CAD",
      });
      // No public "close current" for compensation — a compensation
      // row stays open until superseded. To model the "last period is
      // closed" case, open a synthetic zero-amount row at closeBAt.
      if (dates.closeBAt) {
        await changeCompensation(ctx.principal, ctx.employeeId, {
          effectiveFrom: dates.closeBAt,
          amount: "0.00",
          cadence: "HOURLY",
          currency: "CAD",
        });
      }
    },
    read: async (t, ctx) => {
      const row = await getCompensationAt(ctx.principal, ctx.employeeId, t);
      if (!row) return null;
      return { id: row.id, from: row.effectiveFrom, to: row.effectiveTo };
    },
  },
];

// -----------------------------------------------------------------------------
// Parameterised boundary contract.
// -----------------------------------------------------------------------------
describe("HR-1 cross-cutting · half-open boundary — every effective-dated reader", () => {
  beforeAll(async () => {
    await resetDb();
    await seedRbac();
  });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  for (const reader of READERS) {
    describe(`reader: ${reader.name}`, () => {
      it("reader(periodA.effectiveFrom) returns periodA (boundary belongs to the STARTING row)", async () => {
        const fx = await makeAdminHrFixture();
        const ctx: FixtureCtx = { principal: fx.clubAdmin, employeeId: fx.employee.id };
        const A = new Date("2024-01-01T00:00:00.000Z");
        const B = new Date("2024-06-01T00:00:00.000Z");
        await reader.seedTwo(ctx, { periodAFrom: A, periodBFrom: B });
        const readOut = await reader.read(A, ctx);
        expect(readOut).not.toBeNull();
        expect(readOut!.from.getTime()).toBe(A.getTime());
      });

      it("reader(periodB.effectiveFrom) returns periodB — NOT periodA (the boundary hands off cleanly)", async () => {
        const fx = await makeAdminHrFixture();
        const ctx: FixtureCtx = { principal: fx.clubAdmin, employeeId: fx.employee.id };
        const A = new Date("2024-01-01T00:00:00.000Z");
        const B = new Date("2024-06-01T00:00:00.000Z");
        await reader.seedTwo(ctx, { periodAFrom: A, periodBFrom: B });
        const readOut = await reader.read(B, ctx);
        expect(readOut).not.toBeNull();
        expect(
          readOut!.from.getTime(),
          `${reader.name} at t == periodB.effectiveFrom must resolve to periodB (from=${B.toISOString()}), got from=${readOut!.from.toISOString()}`,
        ).toBe(B.getTime());
      });

      it("reader(periodB.effectiveFrom - 1ms) returns periodA (still inside period A's half-open window)", async () => {
        const fx = await makeAdminHrFixture();
        const ctx: FixtureCtx = { principal: fx.clubAdmin, employeeId: fx.employee.id };
        const A = new Date("2024-01-01T00:00:00.000Z");
        const B = new Date("2024-06-01T00:00:00.000Z");
        await reader.seedTwo(ctx, { periodAFrom: A, periodBFrom: B });
        const oneMsBeforeB = new Date(B.getTime() - 1);
        const readOut = await reader.read(oneMsBeforeB, ctx);
        expect(readOut).not.toBeNull();
        expect(readOut!.from.getTime()).toBe(A.getTime());
      });

      it("reader(t) after ALL periods when the last period is CLOSED returns null", async () => {
        const fx = await makeAdminHrFixture();
        const ctx: FixtureCtx = { principal: fx.clubAdmin, employeeId: fx.employee.id };
        const A = new Date("2024-01-01T00:00:00.000Z");
        const B = new Date("2024-06-01T00:00:00.000Z");
        const closeAt = new Date("2024-12-31T00:00:00.000Z");
        await reader.seedTwo(ctx, { periodAFrom: A, periodBFrom: B, closeBAt: closeAt });
        // For readers that use "insert a synthetic row" to close (like
        // compensation), `closeAt` becomes the effectiveFrom of the
        // synthetic row; reader(closeAt) returns the synthetic row.
        // What we care about here is "well after the last period is
        // closed": pick t = closeAt + 1yr. Note that compensation's
        // synthetic zero-row is still open at closeAt+1yr — so this
        // assertion holds only for the employment-period path. Skip
        // for compensation because compensation has no "hard close"
        // primitive (documented in seedTwo above).
        if (reader.name === "getCompensationAt") {
          // For compensation, the "close" is a superseding zero row.
          // Test point: reader(closeAt) returns the synthetic row, NOT
          // the prior row.
          const readOut = await reader.read(closeAt, ctx);
          expect(readOut).not.toBeNull();
          expect(readOut!.from.getTime()).toBe(closeAt.getTime());
          return;
        }
        const wayAfter = new Date(closeAt.getTime() + 365 * 24 * 3_600_000);
        const readOut = await reader.read(wayAfter, ctx);
        expect(readOut).toBeNull();
      });

      it("reader(t) after all periods when the LAST period is OPEN returns that period", async () => {
        const fx = await makeAdminHrFixture();
        const ctx: FixtureCtx = { principal: fx.clubAdmin, employeeId: fx.employee.id };
        const A = new Date("2024-01-01T00:00:00.000Z");
        const B = new Date("2024-06-01T00:00:00.000Z");
        await reader.seedTwo(ctx, { periodAFrom: A, periodBFrom: B });
        const wayAfter = new Date("2030-01-01T00:00:00.000Z");
        const readOut = await reader.read(wayAfter, ctx);
        expect(readOut).not.toBeNull();
        expect(readOut!.from.getTime()).toBe(B.getTime());
        expect(readOut!.to).toBeNull();
      });
    });
  }
});

// -----------------------------------------------------------------------------
// Completeness sanity check — a static grep so future readers get
// forced onto the registry above rather than silently escaping the
// boundary contract.
// -----------------------------------------------------------------------------
describe("HR-1 cross-cutting · effective-dated reader completeness", () => {
  it("every SINGLE-ROW reader named `get<Something>At` in src/lib/hr/** is registered above", () => {
    const HR_ROOT = resolve(__dirname, "..", "..", "..", "src", "lib", "hr");
    const files = readdirSync(HR_ROOT).filter((f) => f.endsWith(".ts"));
    const AT_READER = /export\s+(?:async\s+)?function\s+(get[A-Z][A-Za-z0-9]*At)\s*\(/g;
    const found = new Set<string>();
    for (const f of files) {
      const src = readFileSync(join(HR_ROOT, f), "utf-8");
      for (const m of src.matchAll(AT_READER)) {
        found.add(m[1]);
      }
    }
    // Exemptions: readers that follow the `get<Something>At` naming
    // convention but do NOT match the single-row half-open shape
    // this boundary test protects. Each entry MUST document why the
    // reader belongs to a different pattern.
    const NON_HALF_OPEN_EXEMPT: string[] = [
      // HR-2C Employment (2026-08-24) — returns MULTIPLE
      // EmployeeEmploymentAssignment rows active at t (PRIMARY +
      // every ADDITIONAL), not a single half-open row. The multi-
      // role model deliberately allows concurrent assignments, so
      // the "single-row-at-t" invariant does not apply. Each
      // assignment row is independently effective-dated and reads
      // that need a single-row answer (e.g. current PRIMARY) filter
      // the multi-row result rather than using a different reader.
      "getActiveAssignmentsAt",
    ];
    const registered = new Set(READERS.map((r) => r.name));
    const missing = Array.from(found).filter(
      (name) => !registered.has(name) && !NON_HALF_OPEN_EXEMPT.includes(name),
    );
    expect(
      missing,
      `New single-row effective-dated reader(s) detected in src/lib/hr/** but not registered in the boundary drift check:\n  - ${missing.join(
        "\n  - ",
      )}\nAdd each to the READERS array in this test file so the half-open contract is enforced, OR — if the reader is deliberately multi-row / not effective-dated in the half-open sense — add it to NON_HALF_OPEN_EXEMPT with a one-line rationale.`,
    ).toEqual([]);
  });
});
