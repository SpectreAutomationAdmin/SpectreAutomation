import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import {
  PRODUCED_DRAFT_STATES,
  composeDraftPlacementsFromRuns,
  destinationKindForGroup,
  resolveByDraftLineage,
} from "./destination-resolver";

const CHECKPOINT_ENTITY = "TrainingCheckpoint";
const AUTO_CREATE_ACTION = "hr.training.checkpoint.auto_create";
const DEFAULT_MAX_RETRIES = 3;

interface DraftRow {
  readonly id: string;
  readonly state: string;
  readonly contentHash: string;
  readonly supersedesDraftId: string | null;
  readonly promotion: { readonly destination: string } | null;
}

/** Adds the TrainingCheckpoint rows that checkpoint drafts awaiting
 *  review need before they can sit on the video timeline and be
 *  accepted. A draft already accepted into the course is skipped: it is
 *  bound to the checkpoint it was accepted into, which need not be the
 *  planned one. `existing` counts wanted seconds already occupied. */
export async function ensureCheckpointEventsForVersion(
  args: {
    readonly clubId: string;
    readonly courseVersionId: string;
    readonly actorUserId: string | null;
  },
  opts?: { prisma?: PrismaClient },
): Promise<{ readonly created: number; readonly existing: number }> {
  const db = opts?.prisma ?? defaultPrisma;
  const { clubId, courseVersionId, actorUserId } = args;

  const version = await db.trainingCourseVersion.findFirst({
    where: { id: courseVersionId, course: { clubId } },
    select: { id: true, state: true, videoDurationSec: true },
  });
  if (!version || version.state !== "DRAFT") return { created: 0, existing: 0 };

  const runs = await db.trainingQuestionAiGenerationRun.findMany({
    where: { clubId, courseVersionId },
    orderBy: [{ requestedAt: "asc" }, { id: "asc" }],
    select: { shortfallReasonJson: true, assessmentPlanJson: true },
  });
  if (runs.length === 0) return { created: 0, existing: 0 };
  const placements = composeDraftPlacementsFromRuns(runs);
  if (placements.size === 0) return { created: 0, existing: 0 };

  const drafts: DraftRow[] = await db.trainingQuestionAiDraft.findMany({
    where: { clubId, courseVersionId },
    select: {
      id: true,
      state: true,
      contentHash: true,
      supersedesDraftId: true,
      promotion: { select: { destination: true } },
    },
  });
  const draftById = new Map(drafts.map((d) => [d.id, d] as const));

  const wantedSeconds = new Set<number>();
  for (const draft of drafts) {
    if (!PRODUCED_DRAFT_STATES.has(draft.state) || draft.promotion) continue;
    const placement = resolveByDraftLineage(draft, draftById, placements);
    if (!placement || placement.atSec === null) continue;
    if (destinationKindForGroup(placement.group) !== "CHECKPOINT") continue;
    const atSecond = Math.round(placement.atSec);
    if (atSecond < 0) continue;
    if (version.videoDurationSec !== null && atSecond > version.videoDurationSec) continue;
    wantedSeconds.add(atSecond);
  }
  if (wantedSeconds.size === 0) return { created: 0, existing: 0 };
  const wanted = Array.from(wantedSeconds).sort((a, b) => a - b);

  const isPostgres = (process.env.DATABASE_URL ?? "").startsWith("postgres");
  const lockKey = `training-checkpoint-events:${clubId}:${courseVersionId}`;

  const outcome = await db.$transaction(
    async (tx) => {
      // Serializes concurrent callers so the check below cannot race
      // into two rows at one second. SQLite is single-writer already.
      if (isPostgres) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
      }
      const createdRows: Array<{ id: string; atSecond: number }> = [];
      let existing = 0;
      const stillDraft = await tx.trainingCourseVersion.findFirst({
        where: { id: courseVersionId, state: "DRAFT", course: { clubId } },
        select: { id: true },
      });
      if (!stillDraft) return { createdRows, existing };
      const siblings = await tx.trainingCheckpoint.findMany({
        where: { courseVersionId, courseVersion: { course: { clubId } } },
        select: { atSecond: true, displayOrder: true },
      });
      const occupied = new Set(siblings.map((s) => s.atSecond));
      let nextOrder = siblings.reduce((max, s) => Math.max(max, s.displayOrder), -1) + 1;
      for (const atSecond of wanted) {
        if (occupied.has(atSecond)) {
          existing++;
          continue;
        }
        const checkpoint = await tx.trainingCheckpoint.create({
          data: {
            courseVersionId,
            atSecond,
            label: null,
            requiredToProceed: true,
            maxRetries: DEFAULT_MAX_RETRIES,
            displayOrder: nextOrder,
          },
          select: { id: true },
        });
        occupied.add(atSecond);
        nextOrder++;
        createdRows.push({ id: checkpoint.id, atSecond });
      }
      return { createdRows, existing };
    },
    { timeout: 15_000, maxWait: 10_000 },
  );

  const actor = actorUserId ? { id: actorUserId } : null;
  for (const row of outcome.createdRows) {
    await audit(actor, {
      action: AUTO_CREATE_ACTION,
      entityType: CHECKPOINT_ENTITY,
      entityId: row.id,
      clubId,
      after: {
        versionId: courseVersionId,
        atSecond: row.atSecond,
        requiredToProceed: true,
        maxRetries: DEFAULT_MAX_RETRIES,
      },
    });
  }
  return { created: outcome.createdRows.length, existing: outcome.existing };
}
