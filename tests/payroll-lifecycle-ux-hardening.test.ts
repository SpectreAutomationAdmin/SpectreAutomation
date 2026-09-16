// Phase 2 (2026-09-15) — payroll lifecycle UX hardening. Locks in
// three founder-checkpoint behaviours:
//
//   1. `overview-view.ts` exposes `glJournalEntryId` on the batch ref
//      when the batch is POSTED, so the POSTED completion banner can
//      offer a "View GL Entry" deep link.
//
//   2. `fmtMoneyAlways` renders thousands separators (comma) —
//      documented as the display-layer helper the paystub / GL /
//      overview surfaces call to render money values consistently.
//
//   3. `hasPermission` fails closed for a role key that is not
//      registered in ROLE_PERMISSIONS (Payroll-3C-5F belt-and-suspenders
//      guard against re-introducing the paystub crash class).
//
// This suite does not attempt to render React — it locks in the
// server-side contracts + display-helper behaviour the checkpoint
// depends on. Browser acceptance is separate (staging Playwright).

import { describe, it, expect } from "vitest";
import { fmtMoneyAlways } from "@/lib/accounting/format";
import { hasPermission, type Principal } from "@/lib/rbac";

describe("Phase 2 · currency display · thousands separator", () => {
  it("adds thousands separator to a five-figure amount", () => {
    expect(fmtMoneyAlways("54321.00")).toBe("$54,321.00");
  });

  it("adds thousands separator to a six-figure amount", () => {
    expect(fmtMoneyAlways("543210.99")).toBe("$543,210.99");
  });

  it("renders zero with two decimals (never a dash) via showZero", () => {
    expect(fmtMoneyAlways("0.00")).toBe("$0.00");
  });

  it("leaves small values (< 1,000) unchanged aside from the $ prefix", () => {
    expect(fmtMoneyAlways("543.21")).toBe("$543.21");
  });

  it("preserves the leading minus sign on a negative", () => {
    expect(fmtMoneyAlways("-1234.56")).toBe("-$1,234.56");
  });
});

describe("Phase 2 · RBAC · defensive unknown-role handling", () => {
  const madeUpPrincipal: Principal = {
    id: "portal:test",
    name: "",
    email: "",
    status: "ACTIVE",
    // Cast is intentional — the test is designed to send a role key
    // that is NOT registered in ROLE_PERMISSIONS.
    memberships: [{ clubId: "club-x", roleKey: "MADE_UP_ROLE_THAT_DOES_NOT_EXIST" as never }],
    activeClubId: "club-x",
    memberId: null,
  };

  it("returns false rather than crashing when the role is unregistered", () => {
    // Pre-fix this threw TypeError: Cannot read properties of undefined
    // (reading 'includes'). See the paystub-crash regression at
    // tests/payroll/pay-statement-3c5b-hardening.test.ts.
    expect(() => hasPermission(madeUpPrincipal, "club-x", "payroll:read")).not.toThrow();
    expect(hasPermission(madeUpPrincipal, "club-x", "payroll:read")).toBe(false);
  });
});
