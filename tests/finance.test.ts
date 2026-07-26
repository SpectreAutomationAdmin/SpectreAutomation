import { describe, it, expect } from "vitest";
import { calculateAmortization } from "@/lib/finance";

describe("Finance — amortization", () => {
  it("zeroes the balance on the final payment", () => {
    const result = calculateAmortization(20_000, 0.065, 60, new Date("2024-01-01"));
    expect(result.schedule).toHaveLength(60);
    expect(result.schedule[59].remainingBalance).toBe(0);
  });

  it("monthly payment × term ≈ principal + total interest (within $1)", () => {
    const result = calculateAmortization(20_000, 0.065, 60, new Date("2024-01-01"));
    const expectedTotal = 20_000 + result.totalInterest;
    const actualTotal = result.schedule.reduce((s, r) => s + r.paymentAmount, 0);
    expect(Math.abs(actualTotal - expectedTotal)).toBeLessThan(1);
  });

  it("handles 0% interest cleanly", () => {
    const result = calculateAmortization(12_000, 0, 12, new Date("2024-01-01"));
    expect(result.monthlyPayment).toBe(1000);
    expect(result.totalInterest).toBe(0);
    expect(result.schedule[11].remainingBalance).toBe(0);
  });
});
