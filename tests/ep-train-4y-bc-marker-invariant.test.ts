/**
 * EP-TRAIN-4Y-BC §1 + §6 + §8 — live-marker invariant,
 * planned-marker separation and durable-authorization contract.
 *
 * The live marker invariant: a persisted TrainingCheckpoint event
 * ONLY qualifies as a live marker when it has at least one bound
 * active TrainingQuestion. Planned positions (from the plan's
 * proposedCheckpointGroups[].atSec) are a SEPARATE collection the
 * UI renders visually distinct — they never carry an interactive
 * question marker.
 *
 * Authorization: no GPU-side-effect endpoint may enqueue without a
 * fresh (≤ AUTHORIZATION_TTL_MS) AuditLog row with
 * action=hr.training.generation.authorize scoped to the version.
 */
import { describe, it, expect } from "vitest";
import {
  AUTHORIZATION_TTL_MS,
  recordProcessingAuthorization,
  hasFreshProcessingAuthorization,
  readProcessingAuthorizationStatus,
} from "@/lib/hr/training/generation/processing-authorization";

// We implement the live-marker invariant as a pure function below
// mirroring resolveLiveCheckpointMarkers in review/page.tsx. The
// server-side helper is also exercised through the separate
// Playwright acceptance spec.
function resolveLiveCheckpointMarkers(
  checkpoints: Array<{
    id: string; label: string | null; atSecond: number;
    activeQuestionCount: number;
  }>,
) {
  return checkpoints
    .filter((c) => c.activeQuestionCount > 0)
    .map((c) => ({
      id: c.id,
      title: c.label ?? `Checkpoint at ${Math.floor(c.atSecond / 60)}:${String(Math.floor(c.atSecond % 60)).padStart(2, "0")}`,
      atSecond: c.atSecond,
    }))
    .sort((a, b) => a.atSecond - b.atSecond);
}

function resolvePlannedCheckpointMarkers(assessmentPlanJson: string | null) {
  if (!assessmentPlanJson) return [];
  try {
    const plan = JSON.parse(assessmentPlanJson) as {
      proposedCheckpointGroups?: Array<{ id?: unknown; atSec?: unknown }>;
    };
    const rows: Array<{ id: string; title: string; atSecond: number }> = [];
    for (const g of plan.proposedCheckpointGroups ?? []) {
      if (typeof g?.id !== "string") continue;
      if (typeof g?.atSec !== "number" || !Number.isFinite(g.atSec)) continue;
      rows.push({
        id: `planned:${g.id}`,
        title: `Planned checkpoint at ${Math.floor(g.atSec / 60)}:${String(Math.floor(g.atSec % 60)).padStart(2, "0")}`,
        atSecond: g.atSec,
      });
    }
    return rows.sort((a, b) => a.atSecond - b.atSecond);
  } catch {
    return [];
  }
}

describe("EP-TRAIN-4Y-BC §1 — live-marker invariant", () => {
  it("zero persisted checkpoints → zero live markers, regardless of plan contents", () => {
    const live = resolveLiveCheckpointMarkers([]);
    expect(live).toHaveLength(0);
  });

  it("one planned CP with zero active questions → zero live markers (the current course's defect)", () => {
    const live = resolveLiveCheckpointMarkers([
      { id: "cp-1", label: "Planned", atSecond: 120, activeQuestionCount: 0 },
    ]);
    expect(live).toHaveLength(0);
  });

  it("four saved checkpoints with questions → four live markers, sorted by atSecond", () => {
    const live = resolveLiveCheckpointMarkers([
      { id: "cp-3", label: null, atSecond: 300, activeQuestionCount: 1 },
      { id: "cp-1", label: null, atSecond: 100, activeQuestionCount: 2 },
      { id: "cp-4", label: null, atSecond: 500, activeQuestionCount: 1 },
      { id: "cp-2", label: "Mid", atSecond: 200, activeQuestionCount: 1 },
    ]);
    expect(live).toHaveLength(4);
    expect(live.map((m) => m.atSecond)).toEqual([100, 200, 300, 500]);
    expect(live[1].title).toBe("Mid");
    // Un-labeled markers get a time-formatted title.
    expect(live[0].title).toBe("Checkpoint at 1:40");
  });

  it("mixed set (some with questions, some without) → only question-bearing ones go live", () => {
    const live = resolveLiveCheckpointMarkers([
      { id: "cp-1", label: null, atSecond: 100, activeQuestionCount: 0 },
      { id: "cp-2", label: null, atSecond: 200, activeQuestionCount: 1 },
      { id: "cp-3", label: null, atSecond: 300, activeQuestionCount: 0 },
      { id: "cp-4", label: null, atSecond: 400, activeQuestionCount: 3 },
    ]);
    expect(live.map((m) => m.id)).toEqual(["cp-2", "cp-4"]);
  });
});

describe("EP-TRAIN-4Y-BC §1 — planned-marker separation", () => {
  it("returns [] when no plan JSON", () => {
    expect(resolvePlannedCheckpointMarkers(null)).toEqual([]);
    expect(resolvePlannedCheckpointMarkers("")).toEqual([]);
  });

  it("reads proposedCheckpointGroups[].atSec with planned: prefix on id", () => {
    const plan = JSON.stringify({
      proposedCheckpointGroups: [
        { id: "cg-2", atSec: 250 },
        { id: "cg-1", atSec: 120 },
      ],
    });
    const planned = resolvePlannedCheckpointMarkers(plan);
    expect(planned.map((m) => m.id)).toEqual(["planned:cg-1", "planned:cg-2"]);
    expect(planned.map((m) => m.title)).toEqual([
      "Planned checkpoint at 2:00",
      "Planned checkpoint at 4:10",
    ]);
  });

  it("malformed plan → empty (no throw)", () => {
    expect(resolvePlannedCheckpointMarkers("}{")).toEqual([]);
    expect(resolvePlannedCheckpointMarkers("null")).toEqual([]);
  });
});

describe("EP-TRAIN-4Y-BC §6 — durable processing authorization", () => {
  const CLUB = "club-xyz";
  const VID = "ver-xyz";

  function makeAuditDb(rows: Array<{
    id: string; afterJson: string | null; createdAt: Date; userId: string | null;
  }>) {
    return {
      auditLog: {
        findFirst: async (q: {
          where: {
            clubId: string;
            action: string;
            entityType: string;
            entityId: string;
            createdAt: { gte: Date };
          };
          orderBy: { createdAt: "desc" };
          select?: unknown;
        }) => {
          const filtered = rows
            .filter((r) => r.createdAt >= q.where.createdAt.gte)
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
          return filtered[0] ?? null;
        },
      },
    };
  }

  it("no authorization row → hasFresh returns false", async () => {
    const db = makeAuditDb([]);
    const ok = await hasFreshProcessingAuthorization(
      { clubId: CLUB, courseVersionId: VID, operation: "GENERATE_RECOVERY" },
      { prisma: db as unknown as never },
    );
    expect(ok).toBe(false);
  });

  it("fresh GENERATE_FULL satisfies GENERATE_RECOVERY check (recovery is a subset)", async () => {
    const now = new Date("2026-11-14T18:00:00Z");
    const db = makeAuditDb([
      {
        id: "a1",
        afterJson: JSON.stringify({ operation: "GENERATE_FULL", authorizedAt: now.toISOString() }),
        createdAt: new Date(now.getTime() - 10 * 60 * 1000),
        userId: "u1",
      },
    ]);
    const ok = await hasFreshProcessingAuthorization(
      { clubId: CLUB, courseVersionId: VID, operation: "GENERATE_RECOVERY", now },
      { prisma: db as unknown as never },
    );
    expect(ok).toBe(true);
  });

  it("fresh GENERATE_RECOVERY does NOT satisfy a GENERATE_FULL check (recovery is strictly narrower)", async () => {
    const now = new Date("2026-11-14T18:00:00Z");
    const db = makeAuditDb([
      {
        id: "a1",
        afterJson: JSON.stringify({ operation: "GENERATE_RECOVERY", authorizedAt: now.toISOString() }),
        createdAt: new Date(now.getTime() - 10 * 60 * 1000),
        userId: "u1",
      },
    ]);
    const ok = await hasFreshProcessingAuthorization(
      { clubId: CLUB, courseVersionId: VID, operation: "GENERATE_FULL", now },
      { prisma: db as unknown as never },
    );
    expect(ok).toBe(false);
  });

  it("stale authorization (older than TTL) is rejected — legacy polling cannot resurrect", async () => {
    const now = new Date("2026-11-14T18:00:00Z");
    const db = makeAuditDb([
      {
        id: "a1",
        afterJson: JSON.stringify({ operation: "GENERATE_FULL", authorizedAt: new Date(now.getTime() - AUTHORIZATION_TTL_MS - 60_000).toISOString() }),
        createdAt: new Date(now.getTime() - AUTHORIZATION_TTL_MS - 60_000),
        userId: "u1",
      },
    ]);
    const ok = await hasFreshProcessingAuthorization(
      { clubId: CLUB, courseVersionId: VID, operation: "GENERATE_RECOVERY", now },
      { prisma: db as unknown as never },
    );
    expect(ok).toBe(false);
  });

  it("malformed afterJson fails closed (not open)", async () => {
    const now = new Date("2026-11-14T18:00:00Z");
    const db = makeAuditDb([
      { id: "a1", afterJson: "{broken", createdAt: new Date(now.getTime() - 10_000), userId: "u1" },
    ]);
    const ok = await hasFreshProcessingAuthorization(
      { clubId: CLUB, courseVersionId: VID, operation: "GENERATE_RECOVERY", now },
      { prisma: db as unknown as never },
    );
    expect(ok).toBe(false);
  });

  it("readProcessingAuthorizationStatus returns the parsed payload when fresh", async () => {
    const now = new Date("2026-11-14T18:00:00Z");
    const db = makeAuditDb([
      {
        id: "a1",
        afterJson: JSON.stringify({ operation: "GENERATE_RECOVERY", authorizedAt: now.toISOString() }),
        createdAt: new Date(now.getTime() - 30 * 60 * 1000),
        userId: "u1",
      },
    ]);
    const s = await readProcessingAuthorizationStatus(
      { clubId: CLUB, courseVersionId: VID, now },
      { prisma: db as unknown as never },
    );
    expect(s).not.toBeNull();
    expect(s?.operation).toBe("GENERATE_RECOVERY");
    expect(s?.authorizedByUserId).toBe("u1");
  });
});
