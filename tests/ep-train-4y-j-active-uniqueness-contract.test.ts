// EP-TRAIN-4Y-J — TranscriptionJob active-uniqueness regression contract.
//
// Covers the 2026-11-07 lifecycle-correction migration:
//   `20261107_ep_train_4y_j_transcription_active_uniqueness_fix`.
//
// Pre-correction (4V): `@@unique([clubId, courseVersionId, sourceVideoSha256, state])`
// blocked a worker's `recordJobFailed()` when an earlier FAILED row
// for the same video already occupied the FAILED slot. The same
// defect surfaced on CANCELLED. This left the 2026-11-08 Silver
// Springs pilot (cmw733kz1000pu4sgxm8pjpqp) stuck in RUNNING.
//
// Post-correction: partial unique index on the active set
// (REQUESTED, QUEUED, RUNNING). Multiple FAILED, CANCELLED, AND
// COMPLETED rows allowed at the DB layer. COMPLETED idempotency
// remains enforced by `requestTranscription`.

import { describe, expect, it, beforeEach, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetDb } from "./util/db";
import {
  requestTranscription,
  markQueued,
  claimNextTranscriptionJob,
  recordJobFailed,
  cancelTranscriptionJob,
  sweepStaleLeases,
} from "@/lib/hr/training/transcription/job-service";
import type { Principal } from "@/lib/rbac";

const CLUB_ID = "club_4y_j";
const USER_ADMIN = "user_4y_j_admin";

function superAdmin(clubId = CLUB_ID): Principal {
  return {
    id: USER_ADMIN, name: "admin", email: "admin@t.local", status: "ACTIVE",
    memberships: [{ clubId: null, roleKey: "SUPER_ADMIN" }],
    activeClubId: clubId, memberId: null,
  };
}

async function seedVersion(opts: { videoSha?: string } = {}) {
  const ts = Date.now() + Math.floor(Math.random() * 1_000_000);
  await prisma.club.upsert({
    where: { id: CLUB_ID },
    create: { id: CLUB_ID, name: CLUB_ID, slug: `slug-${CLUB_ID}-${ts}`, primaryColor: "#111" },
    update: {},
  });
  await prisma.user.upsert({
    where: { id: USER_ADMIN },
    create: { id: USER_ADMIN, email: `a-${ts}@t.local`, name: "a", status: "ACTIVE", passwordHash: "x", role: "SUPER_ADMIN" },
    update: {},
  });
  const course = await prisma.trainingCourse.create({
    data: { clubId: CLUB_ID, code: `C-${ts}`, title: "T", category: "ORIENTATION" },
  });
  const version = await prisma.trainingCourseVersion.create({
    data: {
      courseId: course.id,
      version: 1,
      state: "DRAFT",
      title: "V1",
      videoSha256: opts.videoSha ?? "v".repeat(64),
      videoStorageKey: "k/v1",
      videoDurationSec: 120,
    },
  });
  return { clubId: CLUB_ID, versionId: version.id, sha: opts.videoSha ?? "v".repeat(64) };
}

async function runOneFailedCycle(args: { clubId: string; versionId: string; code: "MODAL_HTTP_ERROR" | "SHA_MISMATCH"; message: string }) {
  const r = await requestTranscription(superAdmin(args.clubId), args.clubId, { courseVersionId: args.versionId });
  await markQueued(args.clubId, r.jobId);
  const claim = await claimNextTranscriptionJob();
  await recordJobFailed({
    jobId: r.jobId,
    leaseToken: claim!.leaseToken,
    failureCode: args.code,
    failureMessage: args.message,
    retryable: false,
  });
  return r.jobId;
}

beforeEach(async () => {
  await resetDb();
  process.env.MODAL_TRANSCRIBE_URL = "https://modal.example/transcribe";
  process.env.MODAL_SPECTRE_SHARED_TOKEN = "test-token-not-real";
});
afterAll(async () => { await prisma.$disconnect(); });

describe("EP-TRAIN-4Y-J — active-uniqueness invariant", () => {
  // ─── FAILED retry history ─────────────────────────────────────────

  it("J1 recordJobFailed does NOT collide with an earlier FAILED row for the same video", async () => {
    const s = await seedVersion();

    // First attempt fails terminally.
    const firstId = await runOneFailedCycle({
      clubId: s.clubId, versionId: s.versionId,
      code: "MODAL_HTTP_ERROR", message: "first attempt",
    });
    const first = await prisma.trainingTranscriptionJob.findUnique({ where: { id: firstId } });
    expect(first?.state).toBe("FAILED");

    // Second attempt should be creatable and also able to transition to FAILED.
    const secondId = await runOneFailedCycle({
      clubId: s.clubId, versionId: s.versionId,
      code: "SHA_MISMATCH", message: "second attempt",
    });
    expect(secondId).not.toBe(firstId);
    const second = await prisma.trainingTranscriptionJob.findUnique({ where: { id: secondId } });
    expect(second?.state).toBe("FAILED");

    // Both FAILED rows preserved.
    const failedRows = await prisma.trainingTranscriptionJob.findMany({
      where: { clubId: s.clubId, courseVersionId: s.versionId, sourceVideoSha256: s.sha, state: "FAILED" },
      orderBy: { createdAt: "asc" },
    });
    expect(failedRows.length).toBe(2);
    expect(failedRows[0].failureCode).toBe("MODAL_HTTP_ERROR");
    expect(failedRows[1].failureCode).toBe("SHA_MISMATCH");
    // Terminal history preserved — different IDs + distinct failureMessages.
    expect(failedRows[0].id).toBe(firstId);
    expect(failedRows[1].id).toBe(secondId);
  });

  it("J2 cancelTranscriptionJob does NOT collide with an earlier CANCELLED row for the same video", async () => {
    const s = await seedVersion();

    // First attempt cancelled while RUNNING.
    const r1 = await requestTranscription(superAdmin(), s.clubId, { courseVersionId: s.versionId });
    await markQueued(s.clubId, r1.jobId);
    await claimNextTranscriptionJob();
    const c1 = await cancelTranscriptionJob(superAdmin(), s.clubId, r1.jobId);
    expect(c1.state).toBe("CANCELLED");

    // Second attempt also cancelled.
    const r2 = await requestTranscription(superAdmin(), s.clubId, { courseVersionId: s.versionId });
    expect(r2.jobId).not.toBe(r1.jobId);
    await markQueued(s.clubId, r2.jobId);
    await claimNextTranscriptionJob();
    const c2 = await cancelTranscriptionJob(superAdmin(), s.clubId, r2.jobId);
    expect(c2.state).toBe("CANCELLED");

    const cancelled = await prisma.trainingTranscriptionJob.findMany({
      where: { clubId: s.clubId, courseVersionId: s.versionId, sourceVideoSha256: s.sha, state: "CANCELLED" },
      orderBy: { createdAt: "asc" },
    });
    expect(cancelled.length).toBe(2);
    // Both rows preserved under distinct IDs.
    expect(cancelled[0].id).toBe(r1.jobId);
    expect(cancelled[1].id).toBe(r2.jobId);
  });

  it("J3 FAILED + CANCELLED history can coexist with a retry that proceeds to active", async () => {
    const s = await seedVersion();

    // One FAILED, one CANCELLED.
    await runOneFailedCycle({ clubId: s.clubId, versionId: s.versionId, code: "MODAL_HTTP_ERROR", message: "attempt-1 failed" });
    const r2 = await requestTranscription(superAdmin(), s.clubId, { courseVersionId: s.versionId });
    await cancelTranscriptionJob(superAdmin(), s.clubId, r2.jobId);

    // Now a third attempt proceeds into REQUESTED.
    const r3 = await requestTranscription(superAdmin(), s.clubId, { courseVersionId: s.versionId });
    expect(r3.state).toBe("REQUESTED");
    expect(r3.idempotent).toBe(false);

    const all = await prisma.trainingTranscriptionJob.findMany({
      where: { clubId: s.clubId, courseVersionId: s.versionId, sourceVideoSha256: s.sha },
      orderBy: { createdAt: "asc" },
    });
    expect(all.length).toBe(3);
    const states = all.map(x => x.state).sort();
    expect(states).toEqual(["CANCELLED", "FAILED", "REQUESTED"]);
  });

  // ─── ACTIVE invariant preserved ───────────────────────────────────

  it("J4 at most ONE row in {REQUESTED, QUEUED, RUNNING} per video (concurrent request returns the winner)", async () => {
    const s = await seedVersion();
    const r1 = await requestTranscription(superAdmin(), s.clubId, { courseVersionId: s.versionId });
    const r2 = await requestTranscription(superAdmin(), s.clubId, { courseVersionId: s.versionId });
    // Idempotent: second returns the same row, not a new one.
    expect(r2.jobId).toBe(r1.jobId);
    expect(r2.idempotent).toBe(true);

    // Only one row across active states.
    const active = await prisma.trainingTranscriptionJob.count({
      where: {
        clubId: s.clubId, courseVersionId: s.versionId, sourceVideoSha256: s.sha,
        state: { in: ["REQUESTED", "QUEUED", "RUNNING"] },
      },
    });
    expect(active).toBe(1);
  });

  it("J5 requesting while an earlier FAILED row exists proceeds into a NEW REQUESTED row", async () => {
    const s = await seedVersion();

    // Attempt 1 → FAILED.
    await runOneFailedCycle({ clubId: s.clubId, versionId: s.versionId, code: "MODAL_HTTP_ERROR", message: "boot failure" });

    // A second request succeeds (not blocked by the earlier FAILED).
    const r2 = await requestTranscription(superAdmin(), s.clubId, { courseVersionId: s.versionId });
    expect(r2.state).toBe("REQUESTED");
    expect(r2.idempotent).toBe(false);

    const rows = await prisma.trainingTranscriptionJob.findMany({
      where: { clubId: s.clubId, courseVersionId: s.versionId, sourceVideoSha256: s.sha },
    });
    expect(rows.length).toBe(2);
    expect(rows.find(r => r.state === "FAILED")).toBeDefined();
    expect(rows.find(r => r.state === "REQUESTED")).toBeDefined();
  });

  // ─── Expired-lease exhaustion unblocked ───────────────────────────

  it("J6 sweepStaleLeases EXHAUSTED branch transitions RUNNING → FAILED even when a prior FAILED row exists", async () => {
    // This is exactly the 2026-11-08 Silver Springs pilot scenario:
    //   prior attempt → FAILED (from 4Y-G R2 404)
    //   next attempt → RUNNING with expired lease at attempts=maxAttempts
    //   sweep's exhausted branch must transition to FAILED without P2002.
    const s = await seedVersion();

    // Seed a prior FAILED row via the service.
    await runOneFailedCycle({
      clubId: s.clubId, versionId: s.versionId,
      code: "MODAL_HTTP_ERROR", message: "first-attempt",
    });

    // Create a NEW active row and drive it to RUNNING with attempts=maxAttempts + expired lease.
    const r = await requestTranscription(superAdmin(), s.clubId, { courseVersionId: s.versionId });
    await markQueued(s.clubId, r.jobId);
    const claim = await claimNextTranscriptionJob();
    expect(claim?.jobId).toBe(r.jobId);
    // Force attempts to maxAttempts + expire the lease — mirrors the live defect.
    await prisma.trainingTranscriptionJob.update({
      where: { id: r.jobId },
      data: { attempts: 2, maxAttempts: 2, leaseExpiresAt: new Date(Date.now() - 1000) },
    });

    const sweep = await sweepStaleLeases();
    expect(sweep.exhausted).toBe(1);

    const row = await prisma.trainingTranscriptionJob.findUnique({ where: { id: r.jobId } });
    expect(row?.state).toBe("FAILED");
    expect(row?.failureCode).toBe("MODAL_TIMEOUT");
    // Two FAILED rows now coexist — THIS is the invariant 4Y-J corrects.
    const failed = await prisma.trainingTranscriptionJob.count({
      where: { clubId: s.clubId, courseVersionId: s.versionId, sourceVideoSha256: s.sha, state: "FAILED" },
    });
    expect(failed).toBe(2);
  });

  it("J7 recordJobFailed with the ORIGINAL lease token transitions RUNNING → FAILED even when a prior FAILED row exists", async () => {
    // This is the recovery path for cmw733kz1: the worker still holds the lease
    // in-memory (or persisted in the DB). `recordJobFailed` must succeed under
    // the new partial-unique index.
    const s = await seedVersion();
    await runOneFailedCycle({
      clubId: s.clubId, versionId: s.versionId,
      code: "MODAL_HTTP_ERROR", message: "prior attempt",
    });

    const r = await requestTranscription(superAdmin(), s.clubId, { courseVersionId: s.versionId });
    await markQueued(s.clubId, r.jobId);
    const claim = await claimNextTranscriptionJob();
    expect(claim).toBeTruthy();

    const result = await recordJobFailed({
      jobId: r.jobId,
      leaseToken: claim!.leaseToken,
      failureCode: "MODAL_HTTP_ERROR",
      failureMessage: "Modal Transcriber boot ModuleNotFoundError — fixed in Modal transcribe v8",
      retryable: false,
    });
    expect(result.finalState).toBe("FAILED");

    const row = await prisma.trainingTranscriptionJob.findUnique({ where: { id: r.jobId } });
    expect(row?.state).toBe("FAILED");
    expect(row?.failureMessage).toMatch(/ModuleNotFoundError/);
  });

  // ─── Attempts/maxAttempts still enforced ──────────────────────────

  it("J8 after a FAILED terminal, attempts budget still resets per new row (each new row has its own maxAttempts)", async () => {
    const s = await seedVersion();

    // First FAILED cycle.
    const id1 = await runOneFailedCycle({ clubId: s.clubId, versionId: s.versionId, code: "MODAL_HTTP_ERROR", message: "1st" });
    const first = await prisma.trainingTranscriptionJob.findUnique({ where: { id: id1 } });
    expect(first?.attempts).toBe(1);

    // Second cycle — a fresh request + claim + fail. Its attempts counter starts at 0 and increments to 1.
    const id2 = await runOneFailedCycle({ clubId: s.clubId, versionId: s.versionId, code: "SHA_MISMATCH", message: "2nd" });
    const second = await prisma.trainingTranscriptionJob.findUnique({ where: { id: id2 } });
    expect(second?.attempts).toBe(1);
    expect(second?.maxAttempts).toBe(2);
  });

  // ─── Idempotent COMPLETED (app-layer) ─────────────────────────────

  it("J9 a video with an existing COMPLETED transcript is still idempotent at the app layer (no new row)", async () => {
    const s = await seedVersion();
    // Directly seed a COMPLETED row (bypassing the normal lifecycle so we can
    // assert idempotency independent of the lifecycle path).
    const existing = await prisma.trainingTranscriptionJob.create({
      data: {
        clubId: s.clubId,
        courseVersionId: s.versionId,
        sourceVideoSha256: s.sha,
        state: "COMPLETED",
        completedAt: new Date(),
      },
      select: { id: true },
    });
    const r = await requestTranscription(superAdmin(), s.clubId, { courseVersionId: s.versionId });
    expect(r.jobId).toBe(existing.id);
    expect(r.state).toBe("COMPLETED");
    expect(r.idempotent).toBe(true);
    const count = await prisma.trainingTranscriptionJob.count({
      where: { clubId: s.clubId, courseVersionId: s.versionId, sourceVideoSha256: s.sha },
    });
    expect(count).toBe(1);
  });
});
