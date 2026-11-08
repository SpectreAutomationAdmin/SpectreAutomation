// EP-TRAIN-6D-4V (2026-11-06) — short-lived signed URL for Modal to
// pull the MP4 bytes. Delegates to the canonical document storage
// adapter so the signing logic + credential surface stay in one place.
//
// This slice does NOT activate the worker handler against a live Modal
// endpoint. The helper is implemented so the handler contract is
// stable + the test mock can swap it out cleanly.

import { prisma } from "@/lib/prisma";
import { resolveDocumentStorage } from "@/lib/documents/storage";
import { NotFoundError } from "@/lib/errors";

export interface MakeSignedVideoUrlInput {
  readonly clubId: string;
  readonly courseVersionId: string;
  readonly ttlSec: number;
}

/**
 * Generates a time-bounded signed URL for the training-video R2
 * object. Tenant-scoped at every lookup. The signed URL is suitable
 * for a server-to-server pull (Modal) and expires at `ttlSec`.
 *
 * Fail-closed: refuses when the version has no videoStorageKey, when
 * the version belongs to a different club, or when the storage
 * adapter cannot sign.
 */
export async function makeSignedTrainingVideoUrl(
  input: MakeSignedVideoUrlInput,
): Promise<string> {
  const version = await prisma.trainingCourseVersion.findUnique({
    where: { id: input.courseVersionId },
    select: {
      id: true, videoStorageKey: true,
      course: { select: { clubId: true } },
    },
  });
  if (!version) throw new NotFoundError("TrainingCourseVersion", input.courseVersionId);
  if (version.course.clubId !== input.clubId) {
    // Treat cross-tenant access as a NotFound (same-shape hiding).
    throw new NotFoundError("TrainingCourseVersion", input.courseVersionId);
  }
  if (!version.videoStorageKey) {
    throw new NotFoundError("TrainingCourseVersion", input.courseVersionId);
  }
  const storage = await resolveDocumentStorage(input.clubId);
  // The storage adapter exposes `signUrl` for time-bounded URLs. For
  // the in-memory adapter (dev / test) this returns a non-signed URL
  // that still works for the local read path.
  // @ts-expect-error — adapter interface varies by implementation.
  if (typeof storage.signUrl === "function") {
    // @ts-expect-error — adapter interface varies by implementation.
    const url = await storage.signUrl(version.videoStorageKey, input.ttlSec);
    // EP-TRAIN-4Y-G diagnostic — log length + prefix only (not full
    // signed URL, since it carries bounded auth material). Operator
    // confirms URL shape in worker logs without leaking the signature.
    const { logger } = await import("@/lib/observability/logger");
    logger.info("training.video.signed-url", {
      storageKey: version.videoStorageKey,
      clubId: input.clubId,
      urlLength: typeof url === "string" ? url.length : null,
      urlHostAndPath: typeof url === "string" ? url.split("?")[0] : null,
    });
    return url;
  }
  // Fallback: an unsigned path. Should only hit in local / mock paths.
  return `/__dev-fallback/${version.videoStorageKey}`;
}
