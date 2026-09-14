// Onboarding canonical Position display hotfix (2026-09-13) — §14 A-G.
//
// The About You → Employment and Review onboarding pages must project
// Employee Position from the CANONICAL orgPositionId (OrganizationalPosition)
// when present, fall back to the legacy positionId (EmployeePosition) only
// for pre-migration rows, and never masquerade a missing value as a
// meaningful role label ("your role"). Both screens share the resolver
// defined in `src/lib/hr/employment-position.ts` so they cannot drift.

import { describe, it, expect } from "vitest";
import {
  resolveEmploymentPositionName,
  formatEmploymentPositionLabel,
  POSITION_NOT_PROVIDED_LABEL,
} from "@/lib/hr/employment-position";

describe("resolveEmploymentPositionName · canonical Position projection", () => {
  // §14 A + B — canonical wins; both onboarding screens read the same name.
  it("returns the canonical OrganizationalPosition name when orgPosition is set", () => {
    const result = resolveEmploymentPositionName({
      orgPosition: { name: "Payroll Administrator" },
      position: null,
    });
    expect(result).toEqual({ name: "Payroll Administrator", source: "canonical" });
    expect(formatEmploymentPositionLabel({
      orgPosition: { name: "Payroll Administrator" },
      position: null,
    })).toBe("Payroll Administrator");
  });

  // §14 C — canonical present, legacy null.
  it("returns the canonical name when legacy positionId is null", () => {
    const result = resolveEmploymentPositionName({
      orgPosition: { name: "Controller / CFO" },
      position: null,
    });
    expect(result.name).toBe("Controller / CFO");
    expect(result.source).toBe("canonical");
  });

  // §14 D — canonical wins over stale legacy value.
  it("prefers canonical Position when legacy positionId points elsewhere", () => {
    const result = resolveEmploymentPositionName({
      orgPosition: { name: "Payroll Administrator" },
      position: { name: "Golf Shop Attendant" },
    });
    expect(result).toEqual({ name: "Payroll Administrator", source: "canonical" });
  });

  // §14 E — legacy fallback for pre-migration records.
  it("falls back to legacy Position name when orgPosition is null", () => {
    const result = resolveEmploymentPositionName({
      orgPosition: null,
      position: { name: "Legacy Grounds Keeper" },
    });
    expect(result).toEqual({ name: "Legacy Grounds Keeper", source: "legacy" });
    expect(formatEmploymentPositionLabel({
      orgPosition: null,
      position: { name: "Legacy Grounds Keeper" },
    })).toBe("Legacy Grounds Keeper");
  });

  // §14 F — both null: neutral "Not provided" — never "your role" or "—".
  it("returns null (Not provided) when neither Position is set", () => {
    const result = resolveEmploymentPositionName({
      orgPosition: null,
      position: null,
    });
    expect(result).toEqual({ name: null, source: null });
    expect(formatEmploymentPositionLabel({
      orgPosition: null,
      position: null,
    })).toBe(POSITION_NOT_PROVIDED_LABEL);
    expect(formatEmploymentPositionLabel({
      orgPosition: null,
      position: null,
    })).not.toBe("your role");
    expect(formatEmploymentPositionLabel({
      orgPosition: null,
      position: null,
    })).not.toBe("—");
  });

  // Undefined (schema omitted the relation) is treated the same as null.
  it("treats undefined relations the same as null", () => {
    expect(resolveEmploymentPositionName({}).name).toBeNull();
    expect(formatEmploymentPositionLabel({})).toBe(POSITION_NOT_PROVIDED_LABEL);
  });

  // Empty-string names must NOT be shown as a valid role label.
  it("does not accept an empty-string canonical name as a valid label", () => {
    const result = resolveEmploymentPositionName({
      orgPosition: { name: "" },
      position: { name: "Legacy Fallback" },
    });
    // Empty canonical → fall through to legacy.
    expect(result).toEqual({ name: "Legacy Fallback", source: "legacy" });
  });

  // §14 G — correction requests preserve the current canonical value as
  // the "clubValue" the employee is disputing. The projection function
  // returns the exact string the About You form passes to
  // EmploymentField.clubValue for field="positionId".
  it("gives the correction form the current canonical Position as clubValue", () => {
    const currentCanonical = "Payroll Administrator";
    const label = formatEmploymentPositionLabel({
      orgPosition: { name: currentCanonical },
      position: null,
    });
    // What the About You page uses to build the correction request DTO —
    // must equal what the employee saw, not a placeholder.
    expect(label).toBe(currentCanonical);
    expect(label).not.toBe("your role");
  });
});
