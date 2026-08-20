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
import { assertPostingAllowed } from "../../posting-guard";
import { ConflictError, NotFoundError, ValidationError } from "../../errors";
import { resolveDocumentStorage } from "../../documents/storage";

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
  await assertPostingAllowed(principal, clubId, "hr.training.video.upload", VERSION_ENTITY, versionId);

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

  const sha256 = createHash("sha256").update(buf).digest("hex");
  const storageKey = `clubs/${clubId}/training/${version.course.id}/${version.version}/${sha256}`;
  const storage = await resolveDocumentStorage({ clubId });
  await storage.put({ storageKey, body: buf, mimeType });

  await prisma.trainingCourseVersion.update({
    where: { id: versionId },
    data: {
      videoStorageKey: storageKey,
      videoMimeType: mimeType,
      videoSizeBytes: buf.length,
      videoSha256: sha256,
      videoDurationSec: input.durationSec ?? null,
    },
  });
  await audit(principal, {
    action: "hr.training.video.upload",
    entityType: VERSION_ENTITY,
    entityId: versionId,
    clubId,
    after: { sha256, sizeBytes: buf.length, mimeType, durationSec: input.durationSec ?? null },
  });
  return { storageKey, sizeBytes: buf.length, sha256 };
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
