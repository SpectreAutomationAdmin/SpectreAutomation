// HR-2C §7 (2026-08-20) — Training video upload service.
//
// Reuses the canonical Club document-storage adapter — no isolated
// media stack. Videos live under `clubs/{clubId}/training/{courseId}/
// {version}/{sha256}` and stream back through the same-origin proxy
// route in `src/app/api/hr/training/versions/[id]/video/route.ts`.
// Tenant isolation is enforced at every read.

import { createHash } from "node:crypto";
import { prisma } from "../../prisma";
import { audit } from "../../audit";
import { requirePermission, type Principal } from "../../rbac";
import { withPostingGuard } from "../../posting-guard";
import { ConflictError, NotFoundError, ValidationError } from "../../errors";
import { resolveDocumentStorage } from "../../documents/storage";
import { remuxToFastStart } from "./video-remux";

const VERSION_ENTITY = "TrainingCourseVersion";

// Sensible pilot ceiling; the canonical adapter has no multipart path
// so oversized files would OOM the route handler. Founder-mandated
// small pilot; big libraries can revisit once we grow.
export const TRAINING_VIDEO_MAX_BYTES = 200 * 1024 * 1024; // 200 MiB
export const TRAINING_VIDEO_ACCEPTED_MIME = new Set<string>([
  "video/mp4",
  "video/webm",
  "video/quicktime", // browsers vary; QT often shows up on Apple uploads
]);

export interface UploadTrainingVideoInput {
  bytes: Buffer | Uint8Array;
  mimeType: string;
  displayName?: string | null;
  /** Optional duration in seconds (extracted client-side or by a
   *  later probe pass). Never trusted for completion — only surfaced
   *  as metadata + used by the client `<video>` element. */
  durationSec?: number | null;
}

export async function uploadTrainingVideo(
  principal: Principal,
  versionId: string,
  input: UploadTrainingVideoInput,
): Promise<{ storageKey: string; sizeBytes: number; sha256: string }> {
  const version = await prisma.trainingCourseVersion.findUnique({
    where: { id: versionId },
    include: { course: { select: { id: true, clubId: true } } },
  });
  if (!version) throw new NotFoundError(VERSION_ENTITY, versionId);
  const clubId = version.course.clubId;
  if (version.state !== "DRAFT") {
    throw new ConflictError(`Cannot replace video on a ${version.state} version.`);
  }
  requirePermission(principal, clubId, "hr:training:write");

  const mimeType = (input.mimeType || "").toLowerCase();
  if (!TRAINING_VIDEO_ACCEPTED_MIME.has(mimeType)) {
    throw new ValidationError([{
      path: "mimeType",
      message: `Video must be one of ${[...TRAINING_VIDEO_ACCEPTED_MIME].join(", ")}.`,
    }]);
  }
  const buf = Buffer.isBuffer(input.bytes) ? input.bytes : Buffer.from(input.bytes);
  if (buf.length === 0) throw new ValidationError([{ path: "bytes", message: "Video file is empty." }]);
  if (buf.length > TRAINING_VIDEO_MAX_BYTES) {
    throw new ValidationError([{
      path: "bytes",
      message: `Video exceeds ${Math.round(TRAINING_VIDEO_MAX_BYTES / (1024 * 1024))} MiB limit.`,
    }]);
  }
  if (input.durationSec !== null && input.durationSec !== undefined) {
    if (!Number.isFinite(input.durationSec) || input.durationSec < 0 || input.durationSec > 8 * 3600) {
      throw new ValidationError([{ path: "durationSec", message: "durationSec must be 0-28800." }]);
    }
  }

  // EP-TRAIN-3 Slice 3B/3C (2026-10-30) -- fast-start remux BEFORE
  // storage so the browser can begin decode after a single Range
  // request instead of downloading the full file to find moov.
  //
  // Slice 3C fail-closed: if the file IS an MP4 that needs
  // remuxing AND ffmpeg is unavailable OR the remux failed, REFUSE
  // the upload rather than silently accepting a non-fast-start video.
  // Non-MP4 videos (WebM, QuickTime containers that don't carry a
  // moov) + already-fast-start MP4s + successfully-remuxed MP4s are
  // all accepted. The manager's work is preserved client-side -- the
  // browser retains the <File> object until they navigate away, so
  // they can retry.
  const remux = await remuxToFastStart(buf, mimeType);
  if (remux.state === "ffmpeg-missing" || remux.state === "remux-failed") {
    throw new ConflictError(
      `Video optimization failed (${remux.state}). ${remux.note}. ` +
      `Please contact support if this persists; the file has NOT been saved.`,
    );
  }
  const bytesToStore = remux.bytes;
  const sha256 = createHash("sha256").update(bytesToStore).digest("hex");
  const storageKey = `clubs/${clubId}/training/${version.course.id}/${version.version}/${sha256}`;
  const storage = await resolveDocumentStorage({ clubId });
  // External storage write happens OUTSIDE the posting-guard tx — holding a
  // FOR UPDATE lock across a network upload would stall every other write
  // for the duration of the transfer.
  await storage.put({ storageKey, body: bytesToStore, mimeType });

  // M1d (2026-10-27) -- withPostingGuard holds FOR UPDATE on ClubSubscription for the write.
  await withPostingGuard(
    principal,
    clubId,
    "hr.training.video.upload",
    async (tx) => tx.trainingCourseVersion.update({
      where: { id: versionId },
      data: {
        videoStorageKey: storageKey,
        videoMimeType: mimeType,
        videoSizeBytes: bytesToStore.length,
        videoSha256: sha256,
        videoDurationSec: input.durationSec ?? null,
      },
    }),
    { entityType: VERSION_ENTITY, entityId: versionId },
  );
  await audit(principal, {
    action: "hr.training.video.upload",
    entityType: VERSION_ENTITY,
    entityId: versionId,
    clubId,
    after: {
      sha256,
      sizeBytes: bytesToStore.length,
      mimeType,
      durationSec: input.durationSec ?? null,
      faststart: remux.state,
      faststartNote: remux.note,
    },
  });
  return { storageKey, sizeBytes: bytesToStore.length, sha256 };
}

// ---------------------------------------------------------------------------
// EP-TRAIN-3 Slice 3B: legacy-video remediation
// ---------------------------------------------------------------------------

/** Re-fast-starts an EXISTING TrainingCourseVersion's video. Preserves
 *  the original storage object until the remuxed object is verified +
 *  the DB row updated. Idempotent: if the current object is already
 *  fast-start, returns {ok:true, state:"already-fast-start"}. Audited.
 *  Permission: hr:training:write on the version's clubId. */
export async function remediateVideoFastStart(
  principal: Principal,
  versionId: string,
): Promise<{
  ok: boolean;
  state: string;
  previousStorageKey: string;
  newStorageKey: string | null;
  previousSizeBytes: number;
  newSizeBytes: number | null;
  previousSha256: string | null;
  newSha256: string | null;
  note: string;
}> {
  const version = await prisma.trainingCourseVersion.findUnique({
    where: { id: versionId },
    include: { course: { select: { id: true, clubId: true } } },
  });
  if (!version) throw new NotFoundError(VERSION_ENTITY, versionId);
  const clubId = version.course.clubId;
  requirePermission(principal, clubId, "hr:training:write");
  if (!version.videoStorageKey || !version.videoMimeType) {
    throw new ConflictError("Version has no video attached.");
  }

  const storage = await resolveDocumentStorage({ clubId });
  const original = await storage.get({ storageKey: version.videoStorageKey });
  if (!original) throw new NotFoundError("TrainingVideoBytes", version.videoStorageKey);
  const originalBuf = Buffer.isBuffer(original) ? original : Buffer.from(original);

  const remux = await remuxToFastStart(originalBuf, version.videoMimeType);
  if (remux.state === "already-fast-start") {
    await audit(principal, {
      action: "hr.training.video.optimize",
      entityType: VERSION_ENTITY,
      entityId: versionId,
      clubId,
      after: { state: "already-fast-start", storageKey: version.videoStorageKey },
    });
    return {
      ok: true,
      state: "already-fast-start",
      previousStorageKey: version.videoStorageKey,
      newStorageKey: version.videoStorageKey,
      previousSizeBytes: originalBuf.length,
      newSizeBytes: originalBuf.length,
      previousSha256: version.videoSha256,
      newSha256: version.videoSha256,
      note: remux.note,
    };
  }
  if (remux.state !== "remuxed") {
    throw new ConflictError(`Could not remux video: ${remux.note}`);
  }

  const newSha256 = createHash("sha256").update(remux.bytes).digest("hex");
  const newStorageKey = `clubs/${clubId}/training/${version.course.id}/${version.version}/${newSha256}`;
  // Write the remuxed object under a new key (original key untouched
  // until the DB row updates). This preserves the invariant that
  // storageKey + sha256 are tied; the previous object survives
  // for rollback.
  await storage.put({ storageKey: newStorageKey, body: remux.bytes, mimeType: version.videoMimeType });

  await withPostingGuard(
    principal,
    clubId,
    "hr.training.video.optimize",
    async (tx) => tx.trainingCourseVersion.update({
      where: { id: versionId },
      data: {
        videoStorageKey: newStorageKey,
        videoSizeBytes: remux.bytes.length,
        videoSha256: newSha256,
      },
    }),
    { entityType: VERSION_ENTITY, entityId: versionId },
  );
  await audit(principal, {
    action: "hr.training.video.optimize",
    entityType: VERSION_ENTITY,
    entityId: versionId,
    clubId,
    before: {
      storageKey: version.videoStorageKey,
      sizeBytes: originalBuf.length,
      sha256: version.videoSha256,
    },
    after: {
      storageKey: newStorageKey,
      sizeBytes: remux.bytes.length,
      sha256: newSha256,
      faststartNote: remux.note,
    },
  });
  return {
    ok: true,
    state: "remuxed",
    previousStorageKey: version.videoStorageKey,
    newStorageKey,
    previousSizeBytes: originalBuf.length,
    newSizeBytes: remux.bytes.length,
    previousSha256: version.videoSha256,
    newSha256,
    note: remux.note,
  };
}

/** Read video bytes for streaming. Tenant-scoped by clubId. Called
 *  by the proxy route which authenticates the caller (admin with
 *  hr:training:read OR same-club employee-portal principal with an
 *  applicable published version). */
export async function readTrainingVideoBytes(
  clubId: string,
  versionId: string,
): Promise<{ bytes: Buffer; mimeType: string; sha256: string } | null> {
  const v = await prisma.trainingCourseVersion.findFirst({
    where: { id: versionId, course: { clubId } },
    select: { videoStorageKey: true, videoMimeType: true, videoSha256: true },
  });
  if (!v || !v.videoStorageKey || !v.videoMimeType) return null;
  const storage = await resolveDocumentStorage({ clubId });
  const bytes = await storage.get({ storageKey: v.videoStorageKey });
  if (!bytes) return null;
  return {
    bytes: Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes),
    mimeType: v.videoMimeType,
    sha256: v.videoSha256 ?? "",
  };
}
