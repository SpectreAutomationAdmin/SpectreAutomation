// Payroll Admin Slice 3B (2026-09-12) — exception translation regressions.
//
// Guards §12 (customer-facing labels not raw SCREAMING_SNAKE_CASE),
// §34 (Missing Pay Group Assignment terminology, never "Membership"),
// and §13 (remediation targets resolve to real Spectre routes).

import { describe, it, expect } from "vitest";
import {
  EXCEPTION_TRANSLATIONS,
  translateException,
  fallbackLabelForUnknownCode,
} from "@/lib/payroll/exception-translations";

const CTX = { employeeId: "emp_1", payPeriodId: "pp_1" };

describe("Payroll 3B — exception translations", () => {
  it("every mapped code returns a Title Case label (never raw SCREAMING_SNAKE_CASE)", () => {
    for (const code of Object.keys(EXCEPTION_TRANSLATIONS)) {
      const t = translateException(code);
      expect(t.label, `${code} label must not equal the raw code`).not.toBe(code);
      expect(t.label, `${code} label must not contain '_'`).not.toContain("_");
      expect(t.label.length).toBeGreaterThan(3);
    }
  });

  it("pay-group missing exception uses 'Pay Group Assignment' language (§34)", () => {
    const t = translateException("MISSING_PAY_GROUP_ASSIGNMENT");
    expect(t.label).toBe("Missing Pay Group Assignment");
    expect(t.label.toLowerCase()).not.toContain("membership");
    expect(t.label.toLowerCase()).not.toContain("club member");
  });

  it("no translated label uses 'Membership' or 'Club Member' phrasing", () => {
    for (const [code, t] of Object.entries(EXCEPTION_TRANSLATIONS)) {
      const label = t.label.toLowerCase();
      expect(label, `${code} label must not say Membership`).not.toContain("membership");
      expect(label, `${code} label must not say Club Member`).not.toContain("club member");
    }
  });

  it("MISSING_COMPENSATION resolves to the employee compensation profile", () => {
    const t = translateException("MISSING_COMPENSATION");
    expect(t.remediation.hrefFor(CTX)).toBe("/app/admin/people/employees/emp_1?tab=compensation");
  });

  it("BANKING_NOT_VERIFIED resolves to the employee banking profile", () => {
    const t = translateException("BANKING_NOT_VERIFIED");
    expect(t.remediation.hrefFor(CTX)).toBe("/app/admin/people/employees/emp_1?tab=banking");
  });

  it("TD1 resolution failure resolves to the employee tax profile", () => {
    const t = translateException("TD1_CLAIM_RESOLUTION_FAILED");
    expect(t.remediation.hrefFor(CTX)).toBe("/app/admin/people/employees/emp_1?tab=tax");
  });

  it("DRAFT_TIME_ENTRIES_PRESENT resolves to the period-scoped time approvals page", () => {
    const t = translateException("DRAFT_TIME_ENTRIES_PRESENT");
    expect(t.remediation.hrefFor(CTX)).toBe("/app/admin/payroll/time?payPeriodId=pp_1");
  });

  it("unknown code falls back to a readable pretty-printed label", () => {
    expect(fallbackLabelForUnknownCode("SOMETHING_NEW_AND_STRANGE"))
      .toBe("Something New And Strange");
    const t = translateException("SOMETHING_NEW_AND_STRANGE");
    expect(t.label).toBe("Something New And Strange");
    expect(t.remediation.kind).toBe("no-canonical-remediation");
  });
});
