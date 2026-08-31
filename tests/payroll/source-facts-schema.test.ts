// Payroll-3B-5A — strict source-facts validation.

import { describe, it, expect } from "vitest";
import {
  assertValidSourceFactsV1,
  parseSourceFactsV1,
  InvalidSourceFactsError,
  type PayrollBatchSourceFactsV1,
} from "@/lib/payroll/source-facts-schema";

const validFacts: PayrollBatchSourceFactsV1 = {
  schemaVersion: 1,
  coverage: {
    membershipEffectiveFrom: "2026-01-01T00:00:00.000Z",
    membershipEffectiveTo: null,
    coverageStart: "2026-08-10T00:00:00.000Z",
    coverageEnd: "2026-08-24T00:00:00.000Z",
    coverageDays: 14,
    periodDays: 14,
    isFullPeriod: true,
  },
  assignments: [
    {
      id: "a1",
      role: "PRIMARY",
      departmentId: "d1",
      positionId: null,
      employmentType: "FULL_TIME",
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      effectiveTo: null,
    },
  ],
  compensations: [
    {
      id: "c1",
      assignmentId: "a1",
      payType: "HOURLY",
      hourlyRate: "22.50",
      annualSalary: null,
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      effectiveTo: null,
    },
  ],
  allowances: [],
};

describe("Payroll-3B-5A — PayrollBatchSourceFactsV1", () => {
  it("accepts a well-formed v1 blob", () => {
    expect(() => assertValidSourceFactsV1(validFacts)).not.toThrow();
  });

  it("rejects a blob missing schemaVersion", () => {
    const bad = { ...validFacts } as unknown as Record<string, unknown>;
    delete bad.schemaVersion;
    expect(() => assertValidSourceFactsV1(bad)).toThrow(InvalidSourceFactsError);
  });

  it("rejects a blob with the wrong schemaVersion", () => {
    const bad = { ...validFacts, schemaVersion: 2 as unknown as 1 };
    expect(() => assertValidSourceFactsV1(bad)).toThrow(InvalidSourceFactsError);
  });

  it("rejects an ISO date that fails to parse", () => {
    const bad: PayrollBatchSourceFactsV1 = {
      ...validFacts,
      coverage: { ...validFacts.coverage, coverageStart: "not-a-date" },
    };
    expect(() => assertValidSourceFactsV1(bad)).toThrow(InvalidSourceFactsError);
  });

  it("rejects a decimal string that isn't decimal", () => {
    const bad = JSON.parse(JSON.stringify(validFacts)) as PayrollBatchSourceFactsV1;
    bad.compensations[0].hourlyRate = "abc";
    expect(() => assertValidSourceFactsV1(bad)).toThrow(InvalidSourceFactsError);
  });

  it("parseSourceFactsV1 returns null for null/empty", () => {
    expect(parseSourceFactsV1(null)).toBeNull();
    expect(parseSourceFactsV1(undefined)).toBeNull();
    expect(parseSourceFactsV1("")).toBeNull();
  });

  it("parseSourceFactsV1 rejects non-JSON loudly", () => {
    expect(() => parseSourceFactsV1("not-json")).toThrow(InvalidSourceFactsError);
  });

  it("parseSourceFactsV1 rejects malformed but parseable JSON", () => {
    expect(() => parseSourceFactsV1(JSON.stringify({ schemaVersion: 1 }))).toThrow(InvalidSourceFactsError);
  });

  it("parseSourceFactsV1 round-trips a valid blob", () => {
    const roundTripped = parseSourceFactsV1(JSON.stringify(validFacts));
    expect(roundTripped).toEqual(validFacts);
  });
});
