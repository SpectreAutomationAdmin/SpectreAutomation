// Slice E closeout (2026-09-19) — staging-only Prepare-only route for
// the hourly zero-hours acceptance flow. Prepares a batch that
// INCLUDES the synthetic hourly employee with zero approved hours;
// returns the resulting batchId in DRAFT state (blocker fires).
//
// Same six-way guards as the Slice D pipeline route: env var, auth,
// admin email, clubSlug, stagingDataMode, and refusal if a batch for
// the target pay period already exists.

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { preparePayrollBatch } from "@/lib/payroll/batch-preparation";
import { loadPrincipalByEmail } from "@/lib/services/principal-by-email";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SYNTHETIC_CLUB_SLUG = "slice-c-benefits-test";
const SYNTHETIC_ADMIN_EMAIL = "slice-c-benefits-test-admin@fixture.spectre.test";
const SYNTHETIC_PA_EMAIL = "slice-c-benefits-test-pa@fixture.spectre.test";

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
  if (!club) return refuse(`Synthetic club ${clubSlug} not found.`, 404);
  if (club.stagingDataMode !== "SYNTHETIC_DEMO") {
    return refuse(`Refusing: club.stagingDataMode must be SYNTHETIC_DEMO, got ${club.stagingDataMode}`);
  }

  const paP = await loadPrincipalByEmail(SYNTHETIC_PA_EMAIL).catch(() => null);
  if (!paP) return refuse("Synthetic PA user missing.", 404);

  // Fresh SM pay period seq — different from the Slice D one so both
  // pipelines can coexist on the same fixture. Sequence 20 = Oct 16 →
  // Nov 1 (payDate Oct 30).
  const targetSeq = Number(new URL(req.url).searchParams.get("seq") ?? 20);
  const pg = await prisma.payrollPayGroup.findFirst({ where: { clubId: club.id, active: true } });
  if (!pg) return refuse("No active pay group.", 404);
  const pp = await prisma.payrollPayPeriod.findFirst({
    where: { clubId: club.id, payGroupId: pg.id, sequenceInYear: targetSeq, taxYear: 2026 },
  });
  if (!pp) return refuse(`Pay period seq ${targetSeq} not found.`, 404);

  const existing = await prisma.payrollBatch.findFirst({
    where: { clubId: club.id, payPeriodId: pp.id },
  });
  if (existing) {
    return NextResponse.json({
      ok: true,
      alreadyExisted: true,
      batchId: existing.id,
      registerUrl: `/app/admin/payroll/batches/${existing.id}/register`,
      status: existing.status,
    });
  }

  // Ensure the hourly employee is in the pay group. --payroll-ready
  // enrols them; this is a defensive re-check.
  const hourly = await prisma.employee.findFirst({
    where: { clubId: club.id, email: "slice-e-hourly-zero-hours@fixture.spectre.test" },
  });
  if (!hourly) return refuse("Slice E hourly fixture employee not found — run --payroll-ready.", 404);
  const member = await prisma.payrollPayGroupMember.findFirst({
    where: { clubId: club.id, payGroupId: pg.id, employeeId: hourly.id },
  });
  if (!member) return refuse("Hourly employee not enrolled in pay group.", 404);

  const prep = await preparePayrollBatch(paP, club.id, pp.id);
  return NextResponse.json({
    ok: true,
    batchId: prep.batchId,
    registerUrl: `/app/admin/payroll/batches/${prep.batchId}/register`,
    batchUrl: `/app/admin/payroll/batches/${prep.batchId}`,
    status: prep.status,
    blockerCount: prep.blockerCount,
    warningCount: prep.warningCount,
  });
}
