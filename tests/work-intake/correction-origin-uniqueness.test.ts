// Payroll-3D-3B Slice 1 (2026-09-06) — integration tests for the
// correction-review WorkIntakeOrigin partial-unique.
//
// These tests exercise the DB-level invariant that guards
// "one PENDING correction → one canonical WorkIntakeItem" against
// concurrent producers. The invariant is enforced by the raw-SQL
// migration in
// prisma-postgres/migrations/20260911_payroll_3d3b_correction_review_partial_unique/
// and mirrored to SQLite via the same DDL (see
// scripts/payroll-3d3b-ensure-partial-unique.ts). This suite reapplies
// the DDL in beforeAll with CREATE UNIQUE INDEX IF NOT EXISTS so the
// test is self-sufficient regardless of `db push` history.
//
// Slice 1 covers the DB constraint + P2002 refetch shim only. The
// production creator (ensureCorrectionReviewWorkItems) lands in
// Slice 2; here we exercise the constraint directly via WorkIntakeItem
// + WorkIntakeOrigin creates.
//
// Founder-required test cases from Slice 1 checkpoint §I-§O:
//   §I  sequential idempotency
//   §J  concurrent correction creation → one winner + P2002 loser
//   §K  concurrent config-gap → one winner
//   §L  cross-correction (two request ids → two items)
//   §M  cross-tenant (same request id, different club → two items)
//   §N  unrelated WorkIntakeOrigin kinds are unaffected
//   §O  INGESTED_DOCUMENT existing behaviour is not constrained

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db, resetDb, makeClub } from "../util/db";
import {
  isCorrectionReviewOriginConflict,
  CORRECTION_REVIEW_ORIGIN_INDEX_NAME,
} from "@/lib/work-intake/origin-conflict";

const DDL = `
CREATE UNIQUE INDEX IF NOT EXISTS "${CORRECTION_REVIEW_ORIGIN_INDEX_NAME}"
  ON "WorkIntakeOrigin" ("clubId", "kind", "referenceId")
  WHERE "role" = 'PRIMARY'
    AND "kind" IN (
      'TIMECLOCK_CORRECTION_REVIEW',
      'TIMECLOCK_CORRECTION_REVIEW_CONFIG_GAP'
    );
`;

// Minimal raw creator that mirrors the shape Slice 2's
// ensureCorrectionReviewWorkItems will use. Kept local to this test so
// Slice 1 does not ship production code that Slice 2 must then rewrite.
async function rawCreateCorrectionReviewCard(opts: {
  clubId: string;
  correctionRequestId: string;
  kind?: "TIMECLOCK_CORRECTION_REVIEW" | "TIMECLOCK_CORRECTION_REVIEW_CONFIG_GAP";
}) {
  const kind = opts.kind ?? "TIMECLOCK_CORRECTION_REVIEW";
  // Atomic: item + origin roll back together if the DB partial-unique
  // rejects the origin insert. This is the shape Slice 2's production
  // ensureCorrectionReviewWorkItems will use.
  return db().$transaction(async (tx) => {
    const item = await tx.workIntakeItem.create({
      data: {
        clubId: opts.clubId,
        status: "OPEN",
        workDomain: "PAYROLL",
        workIntent: "REVIEW",
        workSubtype: kind,
        classification: `PAYROLL_${kind}`,
        displaySourceLabel: "payroll",
        displaySender: "system",
        displaySubject: "Slice-1 test card",
        displayPreview: "",
        displayReceivedAt: new Date(),
      },
    });
    await tx.workIntakeOrigin.create({
      data: {
        clubId: opts.clubId,
        workIntakeItemId: item.id,
        kind,
        referenceId: opts.correctionRequestId,
        role: "PRIMARY",
      },
    });
    return item;
  });
}

// Idempotent creator matching the production shim Slice 2 will use.
// Encapsulates the "try create; on our specific P2002 refetch" pattern.
async function idempotentCreateCorrectionReviewCard(opts: {
  clubId: string;
  correctionRequestId: string;
  kind?: "TIMECLOCK_CORRECTION_REVIEW" | "TIMECLOCK_CORRECTION_REVIEW_CONFIG_GAP";
}): Promise<{ itemId: string; created: boolean }> {
  const kind = opts.kind ?? "TIMECLOCK_CORRECTION_REVIEW";
  const existing = await db().workIntakeOrigin.findFirst({
    where: { clubId: opts.clubId, kind, referenceId: opts.correctionRequestId, role: "PRIMARY" },
    select: { workIntakeItemId: true },
  });
  if (existing) return { itemId: existing.workIntakeItemId, created: false };
  try {
    const item = await rawCreateCorrectionReviewCard(opts);
    return { itemId: item.id, created: true };
  } catch (err) {
    if (isCorrectionReviewOriginConflict(err)) {
      const canonical = await db().workIntakeOrigin.findFirst({
        where: { clubId: opts.clubId, kind, referenceId: opts.correctionRequestId, role: "PRIMARY" },
        select: { workIntakeItemId: true },
      });
      if (canonical) return { itemId: canonical.workIntakeItemId, created: false };
    }
    throw err;
  }
}

describe("Payroll-3D-3B Slice 1 · correction-review origin partial unique", () => {
  beforeAll(async () => {
    // Ensure the partial-unique exists in the connected DB regardless
    // of `db push` migration state. Postgres + SQLite share the DDL.
    await db().$executeRawUnsafe(DDL);
  });

  beforeEach(async () => {
    await resetDb();
  });

  it("§I sequential idempotency — second ensure returns same canonical WI", async () => {
    const club = await makeClub("3D3B-slice1-I");
    const requestId = "req-I-1";

    const a = await idempotentCreateCorrectionReviewCard({ clubId: club.id, correctionRequestId: requestId });
    const b = await idempotentCreateCorrectionReviewCard({ clubId: club.id, correctionRequestId: requestId });

    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.itemId).toBe(a.itemId);

    // One WI item exists, one origin exists.
    expect(await db().workIntakeItem.count({ where: { clubId: club.id } })).toBe(1);
    expect(await db().workIntakeOrigin.count({
      where: { clubId: club.id, kind: "TIMECLOCK_CORRECTION_REVIEW", referenceId: requestId },
    })).toBe(1);
  });

  it("§J concurrent correction creation — exactly one canonical WI, loser refetches", async () => {
    const club = await makeClub("3D3B-slice1-J");
    const requestId = "req-J-1";

    const [a, b] = await Promise.all([
      idempotentCreateCorrectionReviewCard({ clubId: club.id, correctionRequestId: requestId }),
      idempotentCreateCorrectionReviewCard({ clubId: club.id, correctionRequestId: requestId }),
    ]);

    // Both callers observe the same canonical item id.
    expect(a.itemId).toBe(b.itemId);
    // Exactly one .created:true (the winner). If findFirst on both
    // sides misses (worst case) both attempt create — one succeeds,
    // one throws P2002 handled by the shim.
    // If findFirst on one side sees the winner's write first (best
    // case), we get one .created:true and one .created:false.
    const winners = [a, b].filter((r) => r.created).length;
    expect(winners).toBeGreaterThanOrEqual(1);
    expect(winners).toBeLessThanOrEqual(1);
    // Exactly one item + one origin.
    expect(await db().workIntakeItem.count({ where: { clubId: club.id } })).toBe(1);
    expect(await db().workIntakeOrigin.count({
      where: { clubId: club.id, kind: "TIMECLOCK_CORRECTION_REVIEW", referenceId: requestId },
    })).toBe(1);
  });

  it("§J-raw concurrent RAW origin creates — one succeeds, one throws matching P2002", async () => {
    // Same test as §J but exercising the DB constraint directly (no
    // findFirst-then-create) — proves the partial unique fires and
    // the shim's isCorrectionReviewOriginConflict recognises it.
    const club = await makeClub("3D3B-slice1-Jraw");
    const requestId = "req-Jraw-1";
    const item1 = await db().workIntakeItem.create({
      data: {
        clubId: club.id, status: "OPEN",
        workDomain: "PAYROLL", workIntent: "REVIEW",
        workSubtype: "TIMECLOCK_CORRECTION_REVIEW",
        displaySourceLabel: "payroll", displaySender: "system", displaySubject: "raw-A", displayPreview: "", displayReceivedAt: new Date(),
      },
    });
    const item2 = await db().workIntakeItem.create({
      data: {
        clubId: club.id, status: "OPEN",
        workDomain: "PAYROLL", workIntent: "REVIEW",
        workSubtype: "TIMECLOCK_CORRECTION_REVIEW",
        displaySourceLabel: "payroll", displaySender: "system", displaySubject: "raw-B", displayPreview: "", displayReceivedAt: new Date(),
      },
    });
    const attempts = await Promise.allSettled([
      db().workIntakeOrigin.create({
        data: {
          clubId: club.id, workIntakeItemId: item1.id,
          kind: "TIMECLOCK_CORRECTION_REVIEW", referenceId: requestId, role: "PRIMARY",
        },
      }),
      db().workIntakeOrigin.create({
        data: {
          clubId: club.id, workIntakeItemId: item2.id,
          kind: "TIMECLOCK_CORRECTION_REVIEW", referenceId: requestId, role: "PRIMARY",
        },
      }),
    ]);
    const fulfilled = attempts.filter((a) => a.status === "fulfilled").length;
    const rejected = attempts.filter((a) => a.status === "rejected") as PromiseRejectedResult[];
    expect(fulfilled).toBe(1);
    expect(rejected).toHaveLength(1);
    // The loser must be recognisable by the shim as OUR conflict.
    expect(isCorrectionReviewOriginConflict(rejected[0].reason)).toBe(true);
  });

  it("§K concurrent config-gap — exactly one canonical gap WI", async () => {
    const club = await makeClub("3D3B-slice1-K");
    const gapKey = "dept-nnn:req-K-1";

    const [a, b] = await Promise.all([
      idempotentCreateCorrectionReviewCard({
        clubId: club.id, correctionRequestId: gapKey,
        kind: "TIMECLOCK_CORRECTION_REVIEW_CONFIG_GAP",
      }),
      idempotentCreateCorrectionReviewCard({
        clubId: club.id, correctionRequestId: gapKey,
        kind: "TIMECLOCK_CORRECTION_REVIEW_CONFIG_GAP",
      }),
    ]);
    expect(a.itemId).toBe(b.itemId);
    expect(await db().workIntakeItem.count({ where: { clubId: club.id } })).toBe(1);
    expect(await db().workIntakeOrigin.count({
      where: { clubId: club.id, kind: "TIMECLOCK_CORRECTION_REVIEW_CONFIG_GAP", referenceId: gapKey },
    })).toBe(1);
  });

  it("§L cross-correction — two different requestIds → two separate WI items", async () => {
    const club = await makeClub("3D3B-slice1-L");
    const a = await idempotentCreateCorrectionReviewCard({ clubId: club.id, correctionRequestId: "req-L-A" });
    const b = await idempotentCreateCorrectionReviewCard({ clubId: club.id, correctionRequestId: "req-L-B" });
    expect(a.itemId).not.toBe(b.itemId);
    expect(await db().workIntakeItem.count({ where: { clubId: club.id } })).toBe(2);
    expect(await db().workIntakeOrigin.count({
      where: { clubId: club.id, kind: "TIMECLOCK_CORRECTION_REVIEW" },
    })).toBe(2);
  });

  it("§M cross-tenant — same requestId in two clubs → two separate WI items", async () => {
    const clubA = await makeClub("3D3B-slice1-M-A");
    const clubB = await makeClub("3D3B-slice1-M-B");
    // Same requestId across two clubs. Real-world collision would
    // require two different clubs to independently mint identical
    // TimeClockCorrectionRequest ids (cuids don't collide, but the
    // constraint must still be scoped so it can't reject).
    const requestId = "req-M-shared";
    const a = await idempotentCreateCorrectionReviewCard({ clubId: clubA.id, correctionRequestId: requestId });
    const b = await idempotentCreateCorrectionReviewCard({ clubId: clubB.id, correctionRequestId: requestId });
    expect(a.itemId).not.toBe(b.itemId);
    expect(await db().workIntakeItem.count({ where: { clubId: clubA.id } })).toBe(1);
    expect(await db().workIntakeItem.count({ where: { clubId: clubB.id } })).toBe(1);
  });

  it("§N unrelated WorkIntakeOrigin kinds are NOT constrained by the new index", async () => {
    // Prove the partial-unique's kind filter is real — two WI items
    // with the same (clubId, kind='MEMBER_ACCOUNT', referenceId,
    // PRIMARY) must both succeed today (that's the pre-existing
    // convention-only dedupe covered by the deferred platform slice).
    const club = await makeClub("3D3B-slice1-N");
    const item1 = await db().workIntakeItem.create({
      data: {
        clubId: club.id, status: "OPEN",
        classification: "MEMBER_ACCOUNT",
        displaySourceLabel: "member", displaySender: "system", displaySubject: "N-a", displayPreview: "", displayReceivedAt: new Date(),
      },
    });
    const item2 = await db().workIntakeItem.create({
      data: {
        clubId: club.id, status: "OPEN",
        classification: "MEMBER_ACCOUNT",
        displaySourceLabel: "member", displaySender: "system", displaySubject: "N-b", displayPreview: "", displayReceivedAt: new Date(),
      },
    });
    await db().workIntakeOrigin.create({
      data: {
        clubId: club.id, workIntakeItemId: item1.id,
        kind: "MEMBER_ACCOUNT", referenceId: "acct-shared", role: "PRIMARY",
      },
    });
    // Second insert with the same PRIMARY tuple but different item id
    // must succeed — this is exactly the platform race the deferred
    // hardening slice will address, and it MUST NOT be affected by
    // 3D-3B's kind-filtered constraint.
    await expect(
      db().workIntakeOrigin.create({
        data: {
          clubId: club.id, workIntakeItemId: item2.id,
          kind: "MEMBER_ACCOUNT", referenceId: "acct-shared", role: "PRIMARY",
        },
      }),
    ).resolves.toBeTruthy();
    expect(await db().workIntakeOrigin.count({
      where: { clubId: club.id, kind: "MEMBER_ACCOUNT", referenceId: "acct-shared" },
    })).toBe(2);
  });

  it("§O INGESTED_DOCUMENT existing behaviour is not constrained by this migration", async () => {
    // Explicit non-regression for the AP intake dual-writer path.
    // Two WI items sharing (clubId, kind='INGESTED_DOCUMENT',
    // referenceId=doc.id, role='PRIMARY') must remain permitted so
    // the deferred backlog item (ap-intake-ingested-document-dual-writer.md)
    // can be resolved separately without 3D-3B breaking AP.
    const club = await makeClub("3D3B-slice1-O");
    const invoiceItem = await db().workIntakeItem.create({
      data: {
        clubId: club.id, status: "OPEN", classification: "AP_INVOICE_REVIEW",
        displaySourceLabel: "ap", displaySender: "system", displaySubject: "O-invoice", displayPreview: "", displayReceivedAt: new Date(),
      },
    });
    const statementItem = await db().workIntakeItem.create({
      data: {
        clubId: club.id, status: "OPEN", classification: "VENDOR_STATEMENT_REVIEW",
        displaySourceLabel: "ap", displaySender: "system", displaySubject: "O-statement", displayPreview: "", displayReceivedAt: new Date(),
      },
    });
    await db().workIntakeOrigin.create({
      data: {
        clubId: club.id, workIntakeItemId: invoiceItem.id,
        kind: "INGESTED_DOCUMENT", referenceId: "doc-both-pipelines", role: "PRIMARY",
      },
    });
    await expect(
      db().workIntakeOrigin.create({
        data: {
          clubId: club.id, workIntakeItemId: statementItem.id,
          kind: "INGESTED_DOCUMENT", referenceId: "doc-both-pipelines", role: "PRIMARY",
        },
      }),
    ).resolves.toBeTruthy();
    expect(await db().workIntakeOrigin.count({
      where: { clubId: club.id, kind: "INGESTED_DOCUMENT", referenceId: "doc-both-pipelines" },
    })).toBe(2);
  });
});
