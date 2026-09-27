// PAY-1C/4 (2026-09-26) — Provider adapter certification.
//
// Certification is about the PROVIDER ADAPTER (the code that speaks
// to a specific rail), NOT about a per-tenant connection's health.
// A PaymentProviderConnection in ACTIVE status is not sufficient to
// execute in PRODUCTION — the adapter itself must be certified.
//
// Readiness ladder:
//   DEVELOPMENT           — adapter exists in code, no conformance run.
//   CONFORMANCE_PASSED    — adapter passes the PAY-1B conformance suite.
//   SANDBOX_ACCEPTED      — adapter has completed the institution's
//                           sandbox acceptance (evidence recorded).
//   PRODUCTION_APPROVED   — adapter cleared for real-money execution
//                           by a founder-level approver.
//
// The simulator is intentionally excluded — it cannot be certified.
// Any code path that treats "simulator + real money enabled" as an
// approved adapter is a bug.

import { prisma } from "@/lib/prisma";

export type ProviderReadiness =
  | "DEVELOPMENT"
  | "CONFORMANCE_PASSED"
  | "SANDBOX_ACCEPTED"
  | "PRODUCTION_APPROVED";

const READINESS_ORDER: ProviderReadiness[] = [
  "DEVELOPMENT",
  "CONFORMANCE_PASSED",
  "SANDBOX_ACCEPTED",
  "PRODUCTION_APPROVED",
];

export interface CertificationEvidence {
  conformanceSuite?: { at: string; passedCount: number };
  sandboxCheckpoints?: { name: string; at: string; note?: string }[];
  productionApproval?: { at: string; by: string; note?: string };
}

export async function getProviderReadiness(
  providerType: string,
): Promise<ProviderReadiness> {
  const row = await prisma.paymentProviderCertification.findUnique({
    where: { providerType },
  });
  if (!row) return "DEVELOPMENT";
  return row.readiness as ProviderReadiness;
}

export async function markConformancePassed(
  providerType: string,
  passedCount: number,
): Promise<void> {
  const now = new Date();
  const existing = await prisma.paymentProviderCertification.findUnique({
    where: { providerType },
  });
  const evidence: CertificationEvidence = existing
    ? JSON.parse(existing.evidenceJson)
    : {};
  evidence.conformanceSuite = { at: now.toISOString(), passedCount };
  await prisma.paymentProviderCertification.upsert({
    where: { providerType },
    update: {
      readiness: bumpReadinessAtLeast(existing?.readiness as ProviderReadiness, "CONFORMANCE_PASSED"),
      conformancePassedAt: now,
      evidenceJson: JSON.stringify(evidence),
    },
    create: {
      providerType,
      readiness: "CONFORMANCE_PASSED",
      conformancePassedAt: now,
      evidenceJson: JSON.stringify(evidence),
    },
  });
}

export async function markSandboxAccepted(
  providerType: string,
  checkpoint: { name: string; note?: string },
): Promise<void> {
  const now = new Date();
  const existing = await prisma.paymentProviderCertification.findUnique({
    where: { providerType },
  });
  if (!existing) {
    throw new Error(`PAY-1C: cannot mark SANDBOX_ACCEPTED before CONFORMANCE_PASSED for ${providerType}`);
  }
  const evidence: CertificationEvidence = JSON.parse(existing.evidenceJson);
  evidence.sandboxCheckpoints = evidence.sandboxCheckpoints ?? [];
  evidence.sandboxCheckpoints.push({ ...checkpoint, at: now.toISOString() });
  await prisma.paymentProviderCertification.update({
    where: { providerType },
    data: {
      readiness: bumpReadinessAtLeast(existing.readiness as ProviderReadiness, "SANDBOX_ACCEPTED"),
      sandboxAcceptedAt: now,
      evidenceJson: JSON.stringify(evidence),
    },
  });
}

export async function markProductionApproved(
  providerType: string,
  approvedBy: string,
  note?: string,
): Promise<void> {
  const now = new Date();
  const existing = await prisma.paymentProviderCertification.findUnique({
    where: { providerType },
  });
  if (!existing) {
    throw new Error(`PAY-1C: cannot approve production before conformance for ${providerType}`);
  }
  if (existing.readiness !== "SANDBOX_ACCEPTED" && existing.readiness !== "PRODUCTION_APPROVED") {
    throw new Error(
      `PAY-1C: cannot approve production for ${providerType} — readiness=${existing.readiness}`,
    );
  }
  if (providerType === "SIMULATOR") {
    // Structural refusal — the simulator adapter must never be
    // production-approved, regardless of who calls this.
    throw new Error("PAY-1C: SIMULATOR adapter is not eligible for PRODUCTION_APPROVED");
  }
  const evidence: CertificationEvidence = JSON.parse(existing.evidenceJson);
  evidence.productionApproval = { at: now.toISOString(), by: approvedBy, note };
  await prisma.paymentProviderCertification.update({
    where: { providerType },
    data: {
      readiness: "PRODUCTION_APPROVED",
      productionApprovedAt: now,
      productionApprovedBy: approvedBy,
      evidenceJson: JSON.stringify(evidence),
    },
  });
}

function bumpReadinessAtLeast(
  current: ProviderReadiness | undefined,
  target: ProviderReadiness,
): ProviderReadiness {
  if (!current) return target;
  const ci = READINESS_ORDER.indexOf(current);
  const ti = READINESS_ORDER.indexOf(target);
  return ci >= ti ? current : target;
}
