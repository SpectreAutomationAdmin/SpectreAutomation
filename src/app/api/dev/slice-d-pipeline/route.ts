// Slice D visual closeout (2026-09-19) — staging-only pipeline runner.
//
// GATED SIX WAYS:
//   1. `SLICE_D_FIXTURE_PIPELINE_ENABLED=1` env var must be set.
//   2. Called must be authenticated.
//   3. Caller must be the synthetic fixture admin email.
//   4. Target club (from query `?clubSlug=slice-c-benefits-test`) must
//      match the exact synthetic slug. No other slug is permitted.
//   5. Club must carry `stagingDataMode=SYNTHETIC_DEMO`.
//   6. The endpoint refuses if ANY payroll batch already exists for the
//      target pay period — no accidental double-post.
//
// This route MUST NEVER touch Coulee Ridge or any founder-review tenant.
//
// Purpose: produce a POSTED payroll batch on the synthetic tenant so the
// PayStatement page has a real batch to render for Slice D screenshot 12.
// It is NOT part of the founder-facing payroll surface.

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { preparePayrollBatch } from "@/lib/payroll/batch-preparation";
import { calculatePayrollBatch } from "@/lib/payroll/calculation-execute";
import { attestBatchReview } from "@/lib/payroll/batch-review";
import { submitPayrollBatch } from "@/lib/payroll/submit-payroll-batch";
import { approvePayrollBatch, postPayrollBatch } from "@/lib/payroll/approve-and-post";
import { loadPrincipalByEmail } from "@/lib/services/principal-by-email";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SYNTHETIC_CLUB_SLUG = "slice-c-benefits-test";
const SYNTHETIC_ADMIN_EMAIL = "slice-c-benefits-test-admin@fixture.spectre.test";
const SYNTHETIC_PA_EMAIL = "slice-c-benefits-test-pa@fixture.spectre.test";
const SYNTHETIC_CONTROLLER_EMAIL = "slice-c-benefits-test-controller@fixture.spectre.test";

function refuse(msg: string, status = 403) {
  return NextResponse.json({ ok: false, error: msg }, { status });
}

export async function POST(req: NextRequest) {
  if (process.env.SLICE_D_FIXTURE_PIPELINE_ENABLED !== "1") {
    return refuse("Endpoint disabled.");
  }
  const caller = await getCurrentPrincipal();
  if (!caller) return refuse("Unauthenticated.", 401);
  if (caller.email !== SYNTHETIC_ADMIN_EMAIL) {
    return refuse("Only the synthetic fixture admin may invoke this endpoint.");
  }
  const clubSlug = new URL(req.url).searchParams.get("clubSlug");
  if (clubSlug !== SYNTHETIC_CLUB_SLUG) {
    return refuse(`Refusing: clubSlug must be ${SYNTHETIC_CLUB_SLUG}, got ${clubSlug}`);
  }
  const club = await prisma.club.findFirst({ where: { slug: clubSlug } });
  if (!club) return refuse(`Synthetic club ${clubSlug} not found — run --setup first.`, 404);
  if (club.stagingDataMode !== "SYNTHETIC_DEMO") {
    return refuse(`Refusing: club.stagingDataMode must be SYNTHETIC_DEMO, got ${club.stagingDataMode}`);
  }
  if (/coulee/i.test(club.name) || /coulee/i.test(club.slug)) {
    return refuse("Refusing to run against a Coulee Ridge tenant.");
  }

  // Resolve the synthetic employee + PA + Controller principals.
  const emp = await prisma.employee.findFirst({
    where: { clubId: club.id, email: { contains: "@fixture.spectre.test" } },
  });
  if (!emp) return refuse("Fixture employee not found — run --payroll-ready first.", 404);

  const paP = await loadPrincipalByEmail(SYNTHETIC_PA_EMAIL).catch(() => null);
  const controllerP = await loadPrincipalByEmail(SYNTHETIC_CONTROLLER_EMAIL).catch(() => null);
  if (!paP || !controllerP) {
    return refuse("Synthetic PA or Controller user missing — run --payroll-ready first.", 404);
  }

  // Pick the target pay period (default sequence 18 = Sep 16 → Oct 1 payDate).
  const targetSeq = Number(new URL(req.url).searchParams.get("seq") ?? 18);
  const pg = await prisma.payrollPayGroup.findFirst({ where: { clubId: club.id, active: true } });
  if (!pg) return refuse("No active pay group on fixture club.", 404);
  const pp = await prisma.payrollPayPeriod.findFirst({
    where: { clubId: club.id, payGroupId: pg.id, sequenceInYear: targetSeq, taxYear: 2026 },
  });
  if (!pp) return refuse(`Pay period sequence ${targetSeq} not found — run --payroll-ready first.`, 404);

  // Refuse if any batch already exists for this pay period on this club.
  const existing = await prisma.payrollBatch.findFirst({
    where: { clubId: club.id, payPeriodId: pp.id },
  });
  if (existing) {
    return NextResponse.json({
      ok: true,
      message: "Batch already exists for target pay period — no re-run.",
      batchId: existing.id,
      alreadyExisted: true,
    });
  }

  // Run the pipeline.
  const prep = await preparePayrollBatch(paP, club.id, pp.id);
  const calc = await calculatePayrollBatch(paP, club.id, prep.batchId);
  if (calc.lifecycleStatus !== "CALCULATED") {
    return refuse(`Calculate did not reach CALCULATED: ${JSON.stringify(calc.blockers ?? calc)}`, 500);
  }
  await attestBatchReview(paP, club.id, prep.batchId, "CALCULATED_PAYROLL");
  await submitPayrollBatch(paP, club.id, prep.batchId);
  await approvePayrollBatch(controllerP, prep.batchId);
  const post = await postPayrollBatch(paP, prep.batchId);

  return NextResponse.json({
    ok: true,
    batchId: prep.batchId,
    journalEntryId: post.journalEntryId,
    paystubsUrl: `/app/admin/payroll/batches/${prep.batchId}/paystubs`,
    payPeriodId: pp.id,
    payDate: pp.payDate.toISOString(),
  });
}
