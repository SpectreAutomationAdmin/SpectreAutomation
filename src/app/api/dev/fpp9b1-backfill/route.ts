// FPP-9B.1 (2026-09-22) — Fingerprint backfill + evidence route.
//
// Runs `backfillCalculationFingerprint` on a caller-supplied list of
// batch ids and returns evidence:
//   * packageChecksum per batch (statutory package identity)
//   * calculationFingerprint per batch (frozen calculation identity)
//   * action per batch (STORED_NEW / MATCHED_EXISTING / MISMATCH_LEFT_UNCHANGED)
//
// Never overwrites existing fingerprints and never mutates payroll
// amounts. Reads persisted immutable evidence only.
//
// GATED SIX WAYS (same shape as fpp9b-acceptance):
//   1. `FPP9B_ACCEPTANCE_ENABLED=1` env var.
//   2. Authenticated caller.
//   3. Caller = Marc (PA) OR Chris (Controller) on Coulee Ridge.
//   4. Every batch id must belong to Coulee Ridge.
//   5. All requested batch ids must exist.
//   6. Response shape includes distinct `packageChecksum` and
//      `calculationFingerprint` fields — the callers CANNOT ask this
//      route to mutate anything else on those batches.

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import {
  loadAndComputeFingerprintForBatch,
  backfillCalculationFingerprint,
} from "@/lib/payroll/calculation-fingerprint";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COULEE_CLUB_ID = "cmrvdeny7000144372ktmmg9c";
const MARC_PA_EMAIL = "c.s.turcato@gmail.com";
const CHRIS_CONTROLLER_EMAIL = "cturcato@spectreautomation.com";

function refuse(msg: string, status = 403) {
  return NextResponse.json({ ok: false, error: msg }, { status });
}

export async function POST(req: NextRequest) {
  if (process.env.FPP9B_ACCEPTANCE_ENABLED !== "1") {
    return refuse("Endpoint disabled (FPP9B_ACCEPTANCE_ENABLED != 1).");
  }
  const caller = await getCurrentPrincipal();
  if (!caller) return refuse("Unauthenticated.", 401);
  if (caller.email !== MARC_PA_EMAIL && caller.email !== CHRIS_CONTROLLER_EMAIL) {
    return refuse(`Only ${MARC_PA_EMAIL} or ${CHRIS_CONTROLLER_EMAIL} may invoke this endpoint.`);
  }

  let body: { batchIds?: string[] };
  try {
    body = await req.json();
  } catch {
    return refuse("Invalid JSON body.", 400);
  }
  const batchIds = Array.isArray(body.batchIds) ? body.batchIds.filter(x => typeof x === "string") : [];
  if (batchIds.length === 0) return refuse("body.batchIds must be a non-empty array.", 400);
  if (batchIds.length > 20) return refuse("body.batchIds capped at 20 per call.", 400);

  const found = await prisma.payrollBatch.findMany({
    where: { id: { in: batchIds }, clubId: COULEE_CLUB_ID },
    select: { id: true, transactionType: true, status: true, packageChecksum: true,
      calculationFingerprint: true, reversesPayrollBatchId: true, correctsPayrollBatchId: true,
      pairedReversalBatchId: true, calculationVersion: true, algorithmVersion: true,
      statutoryPackageId: true },
  });
  const foundIds = new Set(found.map(b => b.id));
  const missing = batchIds.filter(id => !foundIds.has(id));
  if (missing.length > 0) {
    return refuse(`Refusing: batches not found on Coulee Ridge: ${missing.join(", ")}`, 404);
  }

  const results = [];
  for (const b of found) {
    const backfill = await backfillCalculationFingerprint(b.id);
    // Load recomputed fingerprint (may differ from persisted if MISMATCH).
    const recomputed = await loadAndComputeFingerprintForBatch(b.id);
    const after = await prisma.payrollBatch.findUniqueOrThrow({
      where: { id: b.id }, select: { calculationFingerprint: true, packageChecksum: true },
    });
    results.push({
      batchId: b.id,
      transactionType: b.transactionType,
      status: b.status,
      calculationVersion: b.calculationVersion,
      algorithmVersion: b.algorithmVersion,
      statutoryPackageId: b.statutoryPackageId,
      packageChecksum: after.packageChecksum,
      calculationFingerprint: after.calculationFingerprint,
      recomputedFingerprintNow: recomputed.fingerprint,
      backfillAction: backfill.action,
      linkage: {
        reversesPayrollBatchId: b.reversesPayrollBatchId,
        correctsPayrollBatchId: b.correctsPayrollBatchId,
        pairedReversalBatchId: b.pairedReversalBatchId,
      },
    });
  }

  // Convenience summary for the acceptance report: is packageChecksum the
  // same across a chain, and is calculationFingerprint distinct?
  const uniqueChecksums = new Set(results.map(r => r.packageChecksum ?? "<null>"));
  const uniqueFingerprints = new Set(results.map(r => r.calculationFingerprint ?? "<null>"));
  const summary = {
    batchCount: results.length,
    uniquePackageChecksums: uniqueChecksums.size,
    uniqueCalculationFingerprints: uniqueFingerprints.size,
    allShareSamePackage: uniqueChecksums.size === 1,
    allHaveDistinctFingerprints: uniqueFingerprints.size === results.length,
  };

  return NextResponse.json({ ok: true, summary, results });
}
