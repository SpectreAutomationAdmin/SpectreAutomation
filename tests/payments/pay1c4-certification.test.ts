// PAY-1C/4 — provider adapter certification.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db, resetDb, seedRbac } from "../util/db";
import {
  getProviderReadiness,
  markConformancePassed,
  markSandboxAccepted,
  markProductionApproved,
} from "@/lib/payments/certification";

describe("PAY-1C/4 · provider adapter certification", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("default readiness for an unknown provider is DEVELOPMENT", async () => {
    const r = await getProviderReadiness("TD_AFT");
    expect(r).toBe("DEVELOPMENT");
  });

  it("conformance-pass bumps readiness to CONFORMANCE_PASSED (idempotent)", async () => {
    await markConformancePassed("MOCK_CDN_RAIL", 42);
    expect(await getProviderReadiness("MOCK_CDN_RAIL")).toBe("CONFORMANCE_PASSED");
    // Second invocation is safe.
    await markConformancePassed("MOCK_CDN_RAIL", 43);
    expect(await getProviderReadiness("MOCK_CDN_RAIL")).toBe("CONFORMANCE_PASSED");
    const row = await db().paymentProviderCertification.findUniqueOrThrow({
      where: { providerType: "MOCK_CDN_RAIL" },
    });
    const ev = JSON.parse(row.evidenceJson);
    expect(ev.conformanceSuite.passedCount).toBe(43);
  });

  it("markSandboxAccepted requires prior CONFORMANCE_PASSED", async () => {
    await expect(
      markSandboxAccepted("TD_AFT", { name: "sandbox-cert" }),
    ).rejects.toThrow(/CONFORMANCE_PASSED/);
    await markConformancePassed("TD_AFT", 30);
    await markSandboxAccepted("TD_AFT", { name: "sandbox-cert", note: "TD DEV1" });
    expect(await getProviderReadiness("TD_AFT")).toBe("SANDBOX_ACCEPTED");
  });

  it("markProductionApproved requires SANDBOX_ACCEPTED (or already PRODUCTION_APPROVED)", async () => {
    await markConformancePassed("ATB_AFT", 20);
    await expect(markProductionApproved("ATB_AFT", "founder@spectre.test")).rejects.toThrow(
      /readiness=CONFORMANCE_PASSED/,
    );
    await markSandboxAccepted("ATB_AFT", { name: "sandbox-final" });
    await markProductionApproved("ATB_AFT", "founder@spectre.test", "signed off 2026-11-01");
    expect(await getProviderReadiness("ATB_AFT")).toBe("PRODUCTION_APPROVED");
  });

  it("SIMULATOR adapter is structurally refused from PRODUCTION_APPROVED", async () => {
    await markConformancePassed("SIMULATOR", 14);
    await markSandboxAccepted("SIMULATOR", { name: "not-really" });
    await expect(markProductionApproved("SIMULATOR", "founder@spectre.test")).rejects.toThrow(
      /SIMULATOR/,
    );
  });

  it("evidence trail records conformance + sandbox + production approver", async () => {
    await markConformancePassed("RBC_AFT", 55);
    await markSandboxAccepted("RBC_AFT", { name: "cert-1", note: "checkpoint-A" });
    await markSandboxAccepted("RBC_AFT", { name: "cert-2", note: "checkpoint-B" });
    await markProductionApproved("RBC_AFT", "founder@spectre.test", "post-external-review");
    const row = await db().paymentProviderCertification.findUniqueOrThrow({
      where: { providerType: "RBC_AFT" },
    });
    const ev = JSON.parse(row.evidenceJson);
    expect(ev.conformanceSuite.passedCount).toBe(55);
    expect(ev.sandboxCheckpoints).toHaveLength(2);
    expect(ev.productionApproval.by).toBe("founder@spectre.test");
    expect(row.readiness).toBe("PRODUCTION_APPROVED");
  });
});
