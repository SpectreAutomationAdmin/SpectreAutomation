/**
 * EP-TRAIN-4Y-BE — checkpoint events for generated checkpoint drafts.
 *
 * A generated checkpoint question can only be shown on the review
 * timeline and accepted once a TrainingCheckpoint exists at its planned
 * second. `ensureCheckpointEventsForVersion` creates the missing rows.
 * These tests drive it against an in-memory stand-in for Prisma so the
 * tenant scope, idempotency and "never touch an existing row" rules are
 * pinned without a database.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PrismaClient } from "@prisma/client";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));

import { audit } from "@/lib/audit";
import { ensureCheckpointEventsForVersion } from "@/lib/hr/training/generation/checkpoint-events";
import {
  DRAFT_LINEAGE_MAX_DEPTH,
  composeDraftPlacementsFromRuns,
  composeGroupMapsFromRuns,
  parsePlanCheckpointGroupAtSec,
  resolveByDraftLineage,
  type DraftLineageNode,
} from "@/lib/hr/training/generation/destination-resolver";

const CLUB = "club-a";
const VERSION = "ver-a";

interface SeedCheckpoint {
  id: string;
  courseVersionId: string;
  atSecond: number;
  label: string | null;
  requiredToProceed: boolean;
  maxRetries: number;
  displayOrder: number;
}

interface Seed {
  version: { id: string; clubId: string; state: string; videoDurationSec: number | null } | null;
  runs: Array<{ shortfallReasonJson: string | null; assessmentPlanJson: string | null }>;
  drafts: Array<{
    id: string;
    state: string;
    contentHash: string;
    supersedesDraftId: string | null;
    promotion: { destination: string } | null;
  }>;
  checkpoints: SeedCheckpoint[];
}

function plan(groups: Array<{ id: string; atSec: number }>): string {
  return JSON.stringify({ proposedCheckpointGroups: groups });
}

function shortfall(kept: Array<{ group: string; hash: string }>): string {
  return JSON.stringify({
    schemaVersion: "shortfall-v2",
    dedupDecisions: kept.map((k) => ({ group: k.group, candidateContentHash: k.hash, kept: true })),
  });
}

function makeDb(seed: Seed) {
  let nextId = 1;
  const db = {
    trainingCourseVersion: {
      findFirst: async (q: { where: { id: string; state?: string; course: { clubId: string } } }) => {
        const v = seed.version;
        if (!v || v.id !== q.where.id || v.clubId !== q.where.course.clubId) return null;
        if (q.where.state !== undefined && v.state !== q.where.state) return null;
        return { id: v.id, state: v.state, videoDurationSec: v.videoDurationSec };
      },
    },
    trainingQuestionAiGenerationRun: {
      findMany: async (q: { where: { clubId: string; courseVersionId: string } }) =>
        q.where.clubId === CLUB && q.where.courseVersionId === VERSION ? seed.runs : [],
    },
    trainingQuestionAiDraft: {
      findMany: async (q: { where: { clubId: string; courseVersionId: string } }) =>
        q.where.clubId === CLUB && q.where.courseVersionId === VERSION ? seed.drafts : [],
    },
    trainingCheckpoint: {
      findMany: async (q: { where: { courseVersionId: string } }) =>
        seed.checkpoints
          .filter((c) => c.courseVersionId === q.where.courseVersionId)
          .map((c) => ({ atSecond: c.atSecond, displayOrder: c.displayOrder })),
      create: async (q: { data: Omit<SeedCheckpoint, "id"> }) => {
        const row: SeedCheckpoint = { id: `cp-new-${nextId++}`, ...q.data };
        seed.checkpoints.push(row);
        return { id: row.id };
      },
    },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(db),
  };
  return db as unknown as PrismaClient;
}

function baseSeed(): Seed {
  return {
    version: { id: VERSION, clubId: CLUB, state: "DRAFT", videoDurationSec: 720 },
    runs: [
      {
        assessmentPlanJson: plan([
          { id: "cg-1", atSec: 111.66 },
          { id: "cg-2", atSec: 240.2 },
          { id: "cg-3", atSec: 365 },
        ]),
        shortfallReasonJson: shortfall([
          { group: "cg-1", hash: "h1" },
          { group: "cg-2", hash: "h2" },
          { group: "fa-1", hash: "h9" },
        ]),
      },
    ],
    drafts: [
      { id: "d1", state: "REQUIRES_HUMAN_REVIEW", contentHash: "h1", supersedesDraftId: null, promotion: null },
      { id: "d2", state: "APPROVED_DRAFT", contentHash: "h2", supersedesDraftId: null, promotion: null },
      { id: "d9", state: "REQUIRES_HUMAN_REVIEW", contentHash: "h9", supersedesDraftId: null, promotion: null },
    ],
    checkpoints: [],
  };
}

const ARGS = { clubId: CLUB, courseVersionId: VERSION, actorUserId: "user-1" };

beforeEach(() => {
  vi.mocked(audit).mockClear();
});

describe("EP-TRAIN-4Y-BE — draft placements across runs", () => {
  it("reads each draft's timestamp from the plan of the run that produced it", () => {
    const runs = [
      { assessmentPlanJson: plan([{ id: "cg-1", atSec: 100 }]), shortfallReasonJson: shortfall([{ group: "cg-1", hash: "a" }]) },
      { assessmentPlanJson: plan([{ id: "cg-1", atSec: 300 }]), shortfallReasonJson: shortfall([{ group: "cg-1", hash: "b" }]) },
    ];
    const placements = composeDraftPlacementsFromRuns(runs);
    expect(placements.get("a")).toEqual({ group: "cg-1", atSec: 100 });
    expect(placements.get("b")).toEqual({ group: "cg-1", atSec: 300 });
  });

  it("first run wins per content hash and agrees with composeGroupMapsFromRuns", () => {
    const runs = [
      { assessmentPlanJson: plan([{ id: "cg-1", atSec: 100 }]), shortfallReasonJson: shortfall([{ group: "cg-1", hash: "a" }]) },
      { assessmentPlanJson: plan([{ id: "cg-2", atSec: 300 }]), shortfallReasonJson: shortfall([{ group: "cg-2", hash: "a" }]) },
    ];
    const placements = composeDraftPlacementsFromRuns(runs);
    const groups = composeGroupMapsFromRuns(runs.map((r) => r.shortfallReasonJson));
    expect(placements.get("a")).toEqual({ group: "cg-1", atSec: 100 });
    expect(groups.get("a")).toBe(placements.get("a")?.group);
  });

  it("final-assessment groups and unreadable plans carry no timestamp", () => {
    const placements = composeDraftPlacementsFromRuns([
      { assessmentPlanJson: plan([{ id: "cg-1", atSec: 100 }]), shortfallReasonJson: shortfall([{ group: "fa-1", hash: "f" }]) },
      { assessmentPlanJson: "}{", shortfallReasonJson: shortfall([{ group: "cg-1", hash: "c" }]) },
      { assessmentPlanJson: null, shortfallReasonJson: null },
    ]);
    expect(placements.get("f")).toEqual({ group: "fa-1", atSec: null });
    expect(placements.get("c")).toEqual({ group: "cg-1", atSec: null });
    expect(parsePlanCheckpointGroupAtSec(JSON.stringify({ proposedCheckpointGroups: [{ id: "cg-1", atSec: "x" }] })).size).toBe(0);
  });
});

describe("EP-TRAIN-4Y-BE — a question keeps its place through manager edits", () => {
  function lineage(nodes: DraftLineageNode[]): Map<string, DraftLineageNode> {
    return new Map(nodes.map((n) => [n.id, n] as const));
  }
  const original: DraftLineageNode = { id: "d2", contentHash: "h2", supersedesDraftId: null, promotion: null };
  const firstEdit: DraftLineageNode = { id: "d2-e1", contentHash: "h2-e1", supersedesDraftId: "d2", promotion: null };
  const secondEdit: DraftLineageNode = { id: "d2-e2", contentHash: "h2-e2", supersedesDraftId: "d2-e1", promotion: null };
  const groups = composeGroupMapsFromRuns([shortfall([{ group: "cg-2", hash: "h2" }])]);

  it("uses the draft's own content hash when a run names it", () => {
    expect(resolveByDraftLineage(original, lineage([original]), groups)).toBe("cg-2");
  });

  it("an edited question still counts for its plan group, through more than one edit", () => {
    const byId = lineage([original, firstEdit, secondEdit]);
    expect(groups.get(firstEdit.contentHash)).toBeUndefined();
    expect(resolveByDraftLineage(firstEdit, byId, groups)).toBe("cg-2");
    expect(resolveByDraftLineage(secondEdit, byId, groups)).toBe("cg-2");
  });

  it("resolves a placement the same way", () => {
    const placements = composeDraftPlacementsFromRuns([
      { assessmentPlanJson: plan([{ id: "cg-2", atSec: 240.2 }]), shortfallReasonJson: shortfall([{ group: "cg-2", hash: "h2" }]) },
    ]);
    expect(resolveByDraftLineage(firstEdit, lineage([original, firstEdit]), placements)).toEqual({
      group: "cg-2",
      atSec: 240.2,
    });
  });

  it("inherits nothing through an ancestor that was accepted into the course", () => {
    const accepted: DraftLineageNode = {
      id: "d5",
      contentHash: "h5-not-in-any-run",
      supersedesDraftId: "d2",
      promotion: { destination: "CHECKPOINT" },
    };
    const editOfAccepted: DraftLineageNode = { id: "d5-e", contentHash: "h5-e", supersedesDraftId: "d5", promotion: null };
    expect(resolveByDraftLineage(editOfAccepted, lineage([original, accepted, editOfAccepted]), groups)).toBeNull();
  });

  it("returns null for an unknown ancestor and stops on a cycle or an over-long chain", () => {
    const orphan: DraftLineageNode = { id: "o", contentHash: "ho", supersedesDraftId: "gone", promotion: null };
    expect(resolveByDraftLineage(orphan, lineage([orphan]), groups)).toBeNull();

    const a: DraftLineageNode = { id: "a", contentHash: "ha", supersedesDraftId: "b", promotion: null };
    const b: DraftLineageNode = { id: "b", contentHash: "hb", supersedesDraftId: "a", promotion: null };
    expect(resolveByDraftLineage(a, lineage([a, b]), groups)).toBeNull();

    const chain: DraftLineageNode[] = [original];
    for (let i = 1; i <= DRAFT_LINEAGE_MAX_DEPTH + 1; i++) {
      chain.push({ id: `c${i}`, contentHash: `hc${i}`, supersedesDraftId: i === 1 ? "d2" : `c${i - 1}`, promotion: null });
    }
    const byId = lineage(chain);
    expect(resolveByDraftLineage(chain[DRAFT_LINEAGE_MAX_DEPTH], byId, groups)).toBe("cg-2");
    expect(resolveByDraftLineage(chain[DRAFT_LINEAGE_MAX_DEPTH + 1], byId, groups)).toBeNull();
  });
});

describe("EP-TRAIN-4Y-BE — no checkpoint question is left without a way to be accepted", () => {
  const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
  const REVIEW_DIR = "src/app/app/admin/people/safety-training/[courseId]/[versionId]";

  it("correcting a rejected checkpoint proposal saves its checkpoint afterwards", () => {
    const src = read("src/app/api/admin/ai-training/runs/[runId]/recover-rejected-proposal/route.ts");
    const recovered = src.indexOf("await recoverRejectedProposal(");
    const ensured = src.indexOf("await ensureCheckpointEventsForVersion(");
    expect(recovered).toBeGreaterThan(-1);
    expect(ensured).toBeGreaterThan(recovered);
  });

  it("the restore route is write-gated, tenant-scoped, draft-only and guarded before it writes", () => {
    const src = read("src/app/api/admin/ai-training/versions/[versionId]/checkpoint-events/route.ts");
    expect(src).toContain('hasPermission(principal, clubId, "hr:training:write")');
    expect(src).toContain("where: { id: versionId, course: { clubId } }");
    expect(src).toContain('version.state !== "DRAFT"');
    const guarded = src.indexOf("await withPostingGuard(");
    expect(guarded).toBeGreaterThan(-1);
    expect(src.indexOf("await ensureCheckpointEventsForVersion(")).toBeGreaterThan(guarded);
    expect(src).toContain("courseVersion: { course: { clubId } }");
  });

  it("accepting a checkpoint question with no checkpoint restores it, and never promotes without one", () => {
    const src = read(`${REVIEW_DIR}/review/ManagerReviewClient.tsx`);
    expect(src).toContain("/checkpoint-events");
    expect(src).toContain("if (!destination) throw new Error(noDestinationMessage);");
    expect(src).not.toContain("Refresh the page and try again");
  });

  it("a manager question at a moment that already has a checkpoint joins it, even an empty one", () => {
    const page = read(`${REVIEW_DIR}/review/page.tsx`);
    const client = read(`${REVIEW_DIR}/review/ManagerReviewClient.tsx`);
    expect(page).toContain("allCheckpoints={allCheckpoints}");
    expect(client).toContain("body.checkpointId = existingAtNewSecond.id;");
    expect(client).toContain("persistedCheckpoints.map((c) => (");
  });

  it("final review counts only the checkpoints employees are stopped at and names the rest", () => {
    const src = read(`${REVIEW_DIR}/publish-review/page.tsx`);
    expect(src).toContain("questions: { some: { active: true } }");
    expect(src).toContain("pr-checkpoints-skipped");
    expect(src).not.toContain('<dd data-testid="pr-checkpoints">{checkpoints.length}</dd>');
  });
});

describe("EP-TRAIN-4Y-BE — ensureCheckpointEventsForVersion", () => {
  it("does nothing, and does not throw, for a version with no runs", async () => {
    const seed = baseSeed();
    seed.runs = [];
    await expect(ensureCheckpointEventsForVersion(ARGS, { prisma: makeDb(seed) })).resolves.toEqual({
      created: 0,
      existing: 0,
    });
    expect(seed.checkpoints).toHaveLength(0);
  });

  it("creates one checkpoint per produced checkpoint group at the rounded second, with authoring defaults", async () => {
    const seed = baseSeed();
    const result = await ensureCheckpointEventsForVersion(ARGS, { prisma: makeDb(seed) });
    expect(result).toEqual({ created: 2, existing: 0 });
    expect(seed.checkpoints.map((c) => c.atSecond)).toEqual([112, 240]);
    for (const c of seed.checkpoints) {
      expect(c.courseVersionId).toBe(VERSION);
      expect(c.label).toBeNull();
      expect(c.requiredToProceed).toBe(true);
      expect(c.maxRetries).toBe(3);
    }
    expect(seed.checkpoints.map((c) => c.displayOrder)).toEqual([0, 1]);
  });

  it("writes one audit row per created checkpoint, attributed to the actor", async () => {
    const seed = baseSeed();
    await ensureCheckpointEventsForVersion(ARGS, { prisma: makeDb(seed) });
    const calls = vi.mocked(audit).mock.calls;
    expect(calls).toHaveLength(2);
    for (const [actor, input] of calls) {
      expect(actor).toEqual({ id: "user-1" });
      expect(input.action).toBe("hr.training.checkpoint.auto_create");
      expect(input.entityType).toBe("TrainingCheckpoint");
      expect(input.clubId).toBe(CLUB);
    }
    expect(calls.map(([, input]) => input.entityId).sort()).toEqual(seed.checkpoints.map((c) => c.id).sort());
  });

  it("audits with a null actor when no user is known", async () => {
    const seed = baseSeed();
    await ensureCheckpointEventsForVersion({ ...ARGS, actorUserId: null }, { prisma: makeDb(seed) });
    expect(vi.mocked(audit).mock.calls[0]?.[0]).toBeNull();
  });

  it("is idempotent: a second call creates nothing", async () => {
    const seed = baseSeed();
    const db = makeDb(seed);
    await ensureCheckpointEventsForVersion(ARGS, { prisma: db });
    vi.mocked(audit).mockClear();
    const second = await ensureCheckpointEventsForVersion(ARGS, { prisma: db });
    expect(second).toEqual({ created: 0, existing: 2 });
    expect(seed.checkpoints).toHaveLength(2);
    expect(audit).not.toHaveBeenCalled();
  });

  it("leaves an existing checkpoint at the same second untouched and appends after the highest display order", async () => {
    const seed = baseSeed();
    const existing: SeedCheckpoint = {
      id: "cp-manual",
      courseVersionId: VERSION,
      atSecond: 112,
      label: "Manager's own",
      requiredToProceed: false,
      maxRetries: 7,
      displayOrder: 4,
    };
    seed.checkpoints.push(existing);
    const result = await ensureCheckpointEventsForVersion(ARGS, { prisma: makeDb(seed) });
    expect(result).toEqual({ created: 1, existing: 1 });
    expect(seed.checkpoints[0]).toEqual(existing);
    expect(seed.checkpoints.filter((c) => c.atSecond === 112)).toHaveLength(1);
    expect(seed.checkpoints.find((c) => c.atSecond === 240)?.displayOrder).toBe(5);
  });

  it("ignores discarded drafts, final-assessment drafts and groups with no draft", async () => {
    const seed = baseSeed();
    seed.drafts[1].state = "REJECTED";
    const result = await ensureCheckpointEventsForVersion(ARGS, { prisma: makeDb(seed) });
    expect(result).toEqual({ created: 1, existing: 0 });
    expect(seed.checkpoints.map((c) => c.atSecond)).toEqual([112]);
  });

  it("a manager-edited draft inherits the placement of the draft it replaced", async () => {
    const seed = baseSeed();
    seed.drafts[0].state = "ARCHIVED";
    seed.drafts.push({
      id: "d1-edit",
      state: "EDITED_VALIDATION_STALE",
      contentHash: "h1-edited",
      supersedesDraftId: "d1",
      promotion: null,
    });
    seed.drafts[1].state = "REJECTED";
    const result = await ensureCheckpointEventsForVersion(ARGS, { prisma: makeDb(seed) });
    expect(result).toEqual({ created: 1, existing: 0 });
    expect(seed.checkpoints.map((c) => c.atSecond)).toEqual([112]);
  });

  it("skips a draft that was already accepted into the course", async () => {
    const seed = baseSeed();
    seed.drafts[0].promotion = { destination: "CHECKPOINT" };
    const result = await ensureCheckpointEventsForVersion(ARGS, { prisma: makeDb(seed) });
    expect(seed.checkpoints.map((c) => c.atSecond)).toEqual([240]);
    expect(result).toEqual({ created: 1, existing: 0 });
  });

  it("never places a checkpoint past the end of the video", async () => {
    const seed = baseSeed();
    seed.version = { id: VERSION, clubId: CLUB, state: "DRAFT", videoDurationSec: 200 };
    const result = await ensureCheckpointEventsForVersion(ARGS, { prisma: makeDb(seed) });
    expect(result).toEqual({ created: 1, existing: 0 });
    expect(seed.checkpoints.map((c) => c.atSecond)).toEqual([112]);
  });

  it("is a no-op on a version that is not a draft", async () => {
    const seed = baseSeed();
    seed.version = { id: VERSION, clubId: CLUB, state: "PUBLISHED", videoDurationSec: 720 };
    const result = await ensureCheckpointEventsForVersion(ARGS, { prisma: makeDb(seed) });
    expect(result).toEqual({ created: 0, existing: 0 });
    expect(seed.checkpoints).toHaveLength(0);
  });

  it("is a no-op for another club's version (tenant scope)", async () => {
    const seed = baseSeed();
    const result = await ensureCheckpointEventsForVersion(
      { ...ARGS, clubId: "club-b" },
      { prisma: makeDb(seed) },
    );
    expect(result).toEqual({ created: 0, existing: 0 });
    expect(seed.checkpoints).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
  });
});
