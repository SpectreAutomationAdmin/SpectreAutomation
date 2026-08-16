// Phase 4R rev-13 (2026-08-16) — GET /api/mission-control/refresh-mailbox/status.
//
// Client-side poll target for the manual Feed Sync barrier. Returns
// the current status of one or more BackgroundJob rows keyed by
// `jobIds` query param (comma-separated). Response shape:
//   {
//     jobs: [
//       { id, kind, status, attempts, updatedAt, resultJson? },
//       ...
//     ],
//     allTerminal: boolean,
//     anyFailed: boolean,
//     summarizedAt: string
//   }
//
// A job's status is "terminal" iff status ∈ { COMPLETED, DEAD_LETTER,
// SUCCEEDED, FAILED_TERMINAL, NOT_REQUIRED, SUPERSEDED } — the client
// stops polling once allTerminal is true. If anyFailed is true the
// client renders the failure state; otherwise it fetches
// snapshot-summary and flips FEED SYNCED.
//
// Tenant-scoped: only jobs owned by the caller's active club are
// returned. Missing/invalid jobIds are silently omitted.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { isMailboxIntegrationEnabled } from "@/lib/env";
import { MAILBOX_ERROR_CODE } from "@/lib/mailbox/errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Rev-13 — a job's status is TERMINAL when the queue will not
// retry. Match src/lib/queue/index.ts: successful runs write
// COMPLETED; exhausted retries write DEAD_LETTER; manual cancels
// write CANCELLED. Nothing else is terminal.
const TERMINAL_JOB_STATUSES = new Set(["COMPLETED", "DEAD_LETTER", "CANCELLED"]);
const FAILED_JOB_STATUSES = new Set(["DEAD_LETTER", "CANCELLED"]);

export async function GET(req: NextRequest) {
  if (!isMailboxIntegrationEnabled()) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const principal = await getCurrentPrincipal();
  if (!principal) {
    return NextResponse.json({ error: MAILBOX_ERROR_CODE.UNAUTHENTICATED }, { status: 401 });
  }
  const clubId = await getActiveClubId({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    clubId: (principal as any).activeClubId ?? null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    role: (principal as any).role ?? "",
  });
  if (!clubId) {
    return NextResponse.json({ error: "no_active_club" }, { status: 400 });
  }

  const raw = req.nextUrl.searchParams.get("jobIds") ?? "";
  const jobIds = raw.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 20);
  if (jobIds.length === 0) {
    return NextResponse.json({ error: "missing_jobIds" }, { status: 400 });
  }

  const jobs = await prisma.backgroundJob.findMany({
    where: { id: { in: jobIds }, clubId },
    select: {
      id: true, kind: true, status: true,
      attempts: true, updatedAt: true, lastError: true,
    },
    orderBy: { updatedAt: "desc" },
  });

  const allTerminal = jobs.length > 0 && jobs.every((j) => TERMINAL_JOB_STATUSES.has(j.status));
  const anyFailed = jobs.some((j) => FAILED_JOB_STATUSES.has(j.status));

  return NextResponse.json({
    jobs,
    allTerminal,
    anyFailed,
    summarizedAt: new Date().toISOString(),
  });
}
