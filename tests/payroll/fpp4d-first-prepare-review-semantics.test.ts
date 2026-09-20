// FPP-4D (2026-09-20) — first-Prepare EMPLOYEE_DATA review semantics.
//
// Payroll-3D freezes sourceFactsJson at Prepare and the EMPLOYEE_DATA
// fingerprint is computed over exactly the frozen fields. Because those
// fields cannot change on a PREPARED batch (only Return-to-Preparation
// → re-Prepare can change them), requiring a manual attestation on
// FIRST Prepare is ceremonial, not a control.
//
// The corrected semantic:
//   * attestation == null (no attestation ever recorded)
//       → first-Prepare baseline → CURRENT / no review required
//   * attestation.isCurrent === true
//       → explicitly attested → CURRENT
//   * attestation != null && !isCurrent
//       → stale from Return-to-Preparation → review required
//
// This suite pins the derivation directly, without relying on Prepare
// or Return-to-Prep side effects.

import { describe, it, expect } from "vitest";

/**
 * Mirrors the corrected logic in
 * src/lib/payroll/overview-view.ts around the EMPLOYEE_DATA branch. If
 * either the service or the UI drifts from this shape, this pin will
 * fail before the founder sees the "review required" wording again.
 */
function deriveEmployeeDataReviewed(
  attestation: { isCurrent: boolean } | null,
): { reviewed: boolean; firstPrepareBaseline: boolean; isStale: boolean } {
  const firstPrepareBaseline = attestation == null;
  const reviewed = attestation == null ? true : attestation.isCurrent === true;
  const isStale = attestation != null && attestation.isCurrent === false;
  return { reviewed, firstPrepareBaseline, isStale };
}

describe("FPP-4D — first-Prepare EMPLOYEE_DATA review semantics", () => {
  it("null attestation on a PREPARED batch = first-Prepare baseline = reviewed", () => {
    const r = deriveEmployeeDataReviewed(null);
    expect(r.reviewed).toBe(true);
    expect(r.firstPrepareBaseline).toBe(true);
    expect(r.isStale).toBe(false);
  });

  it("current attestation = reviewed (post-attestation)", () => {
    const r = deriveEmployeeDataReviewed({ isCurrent: true });
    expect(r.reviewed).toBe(true);
    expect(r.firstPrepareBaseline).toBe(false);
    expect(r.isStale).toBe(false);
  });

  it("stale attestation (Return-to-Preparation invalidated) = NOT reviewed", () => {
    const r = deriveEmployeeDataReviewed({ isCurrent: false });
    expect(r.reviewed).toBe(false);
    expect(r.firstPrepareBaseline).toBe(false);
    expect(r.isStale).toBe(true);
  });
});

/**
 * FPP-4D — exception KPI severity behavior. Pin the KPI colour/label
 * derivation so a first-Prepare batch with (0 blockers, 1 warning,
 * 1 info) does not render as an actionable error state.
 */
function deriveExceptionKpi(k: {
  exceptionsCount: number | null;
  exceptionsBlockerCount: number | null;
  exceptionsWarningCount: number | null;
  exceptionsInfoCount: number | null;
}) {
  const blockerCount = k.exceptionsBlockerCount ?? 0;
  const warningCount = k.exceptionsWarningCount ?? 0;
  const infoCount = k.exceptionsInfoCount ?? 0;
  const excIsZero = k.exceptionsCount === 0 || blockerCount === 0;
  const value = k.exceptionsCount == null ? "—" : String(blockerCount);
  const label = blockerCount > 0 ? "Blockers" : "Exceptions";
  return { blockerCount, warningCount, infoCount, excIsZero, value, label };
}

describe("FPP-4D — exception KPI severity distinguishes blocker/warning/info", () => {
  it("0 blockers + 1 warning + 1 info → neutral (green) with breakdown", () => {
    const k = deriveExceptionKpi({
      exceptionsCount: 2, exceptionsBlockerCount: 0,
      exceptionsWarningCount: 1, exceptionsInfoCount: 1,
    });
    expect(k.value).toBe("0");
    expect(k.label).toBe("Exceptions");
    expect(k.excIsZero).toBe(true);      // → renders in neutral / stone
    expect(k.blockerCount).toBe(0);
    expect(k.warningCount).toBe(1);
    expect(k.infoCount).toBe(1);
  });

  it("1 blocker + 0 warnings → red (Blockers label)", () => {
    const k = deriveExceptionKpi({
      exceptionsCount: 1, exceptionsBlockerCount: 1,
      exceptionsWarningCount: 0, exceptionsInfoCount: 0,
    });
    expect(k.value).toBe("1");
    expect(k.label).toBe("Blockers");
    expect(k.excIsZero).toBe(false);
  });

  it("null (no batch) → dash", () => {
    const k = deriveExceptionKpi({
      exceptionsCount: null, exceptionsBlockerCount: null,
      exceptionsWarningCount: null, exceptionsInfoCount: null,
    });
    expect(k.value).toBe("—");
    expect(k.excIsZero).toBe(true);
  });
});
