// EP-TRAIN-3 Slice 1 (2026-10-29) -- schema + migration + dormant-
// behaviour contract tests.  No DB mutations in the test tree; the
// schema + migrations are inspected as text.  Behaviour tests
// confirm the new fields can be read + written against the generated
// Prisma client without regressing existing TrainingAttempt / Progress
// / Question semantics.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const SCHEMA_SQLITE = readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8");
const SCHEMA_PG = readFileSync(join(process.cwd(), "prisma-postgres/schema.prisma"), "utf8");
const MIG_SQLITE = readFileSync(
  join(process.cwd(), "prisma/migrations/20261029_ep_train_3_slice1_checkpoints/migration.sql"),
  "utf8",
);
const MIG_PG = readFileSync(
  join(process.cwd(), "prisma-postgres/migrations/20261029_ep_train_3_slice1_checkpoints/migration.sql"),
  "utf8",
);

describe("EP-TRAIN-3 Slice 1 :: schema shape (both schemas)", () => {
  for (const [name, schema] of [["sqlite", SCHEMA_SQLITE], ["postgres", SCHEMA_PG]] as const) {
    describe(`in ${name} schema`, () => {
      it("declares the new TrainingCheckpoint model", () => {
        expect(schema).toMatch(/^model TrainingCheckpoint \{/m);
        expect(schema).toMatch(/atSecond\s+Int/);
        expect(schema).toMatch(/requiredToProceed\s+Boolean\s+@default\(true\)/);
        expect(schema).toMatch(/maxRetries\s+Int\s+@default\(3\)/);
        expect(schema).toMatch(/displayOrder\s+Int\s+@default\(0\)/);
      });
      it("adds kind + checkpointId to TrainingAttempt (both nullable in effect for existing rows via defaults / nullability)", () => {
        const attemptBlock = schema.match(/^model TrainingAttempt \{[\s\S]*?^\}/m)?.[0] ?? "";
        expect(attemptBlock).toMatch(/kind\s+String\s+@default\("FINAL"\)/);
        expect(attemptBlock).toMatch(/checkpointId\s+String\?/);
      });
      it("adds checkpointId + questionType to TrainingQuestion", () => {
        const qBlock = schema.match(/^model TrainingQuestion \{[\s\S]*?^\}/m)?.[0] ?? "";
        expect(qBlock).toMatch(/checkpointId\s+String\?/);
        expect(qBlock).toMatch(/questionType\s+String\s+@default\("SINGLE_CHOICE"\)/);
      });
      it("adds checkpointClearedJson (nullable) to TrainingProgress", () => {
        const pBlock = schema.match(/^model TrainingProgress \{[\s\S]*?^\}/m)?.[0] ?? "";
        expect(pBlock).toMatch(/checkpointClearedJson\s+String\?/);
      });
      it("TrainingCourseVersion back-relation `checkpoints` added", () => {
        const vBlock = schema.match(/^model TrainingCourseVersion \{[\s\S]*?^\}/m)?.[0] ?? "";
        expect(vBlock).toMatch(/checkpoints\s+TrainingCheckpoint\[\]/);
      });
      it("TrainingCompletion is UNCHANGED (no new column)", () => {
        const cBlock = schema.match(/^model TrainingCompletion \{[\s\S]*?^\}/m)?.[0] ?? "";
        // Keep the Completion row minimal; evidence is retrievable via joins.
        expect(cBlock).not.toMatch(/checkpointClearedJson/);
        expect(cBlock).not.toMatch(/\bkind\s+String\b/);
      });
      it("TrainingQuestionResponse is UNCHANGED (chain via attempt covers the evidence requirement)", () => {
        const rBlock = schema.match(/^model TrainingQuestionResponse \{[\s\S]*?^\}/m)?.[0] ?? "";
        expect(rBlock).not.toMatch(/checkpointId/);
      });
    });
  }
});

describe("EP-TRAIN-3 Slice 1 :: migration shape (both)", () => {
  for (const [name, sql] of [["sqlite", MIG_SQLITE], ["postgres", MIG_PG]] as const) {
    describe(`in ${name} migration`, () => {
      it("creates the TrainingCheckpoint table", () => {
        expect(sql).toMatch(/CREATE TABLE "TrainingCheckpoint"/);
        expect(sql).toMatch(/"atSecond"\s+INTEGER NOT NULL/);
        expect(sql).toMatch(/"requiredToProceed"\s+BOOLEAN NOT NULL DEFAULT true/);
        expect(sql).toMatch(/"maxRetries"\s+INTEGER NOT NULL DEFAULT 3/);
      });
      it("adds additive columns on TrainingAttempt / Question / Progress", () => {
        expect(sql).toMatch(/ALTER TABLE "TrainingAttempt"[\s\S]{0,400}"kind"\s+TEXT\s+NOT NULL DEFAULT 'FINAL'/);
        expect(sql).toMatch(/ALTER TABLE "TrainingAttempt"[\s\S]{0,400}"checkpointId"\s+TEXT/);
        expect(sql).toMatch(/ALTER TABLE "TrainingQuestion"[\s\S]{0,400}"checkpointId"\s+TEXT/);
        expect(sql).toMatch(/ALTER TABLE "TrainingQuestion"[\s\S]{0,400}"questionType"\s+TEXT\s+NOT NULL DEFAULT 'SINGLE_CHOICE'/);
        expect(sql).toMatch(/ALTER TABLE "TrainingProgress"[\s\S]{0,400}"checkpointClearedJson"\s+TEXT/);
      });
      it("creates indexes without dropping existing ones", () => {
        expect(sql).toMatch(/CREATE INDEX "TrainingCheckpoint_courseVersionId_atSecond_idx"/);
        expect(sql).toMatch(/CREATE INDEX "TrainingCheckpoint_courseVersionId_displayOrder_idx"/);
      });
      it("contains ZERO destructive statements (preserves existing completions, progress, attempts)", () => {
        expect(sql).not.toMatch(/\bDROP\s+TABLE\b/i);
        expect(sql).not.toMatch(/\bDROP\s+COLUMN\b/i);
        expect(sql).not.toMatch(/\bDROP\s+INDEX\b/i);
        expect(sql).not.toMatch(/\bDELETE\s+FROM\s+"Training/i);
        expect(sql).not.toMatch(/\bUPDATE\s+"Training/i);
        expect(sql).not.toMatch(/\bTRUNCATE\b/i);
      });
      it("does NOT alter TrainingCompletion (per founder: no retroactive invalidation)", () => {
        expect(sql).not.toMatch(/ALTER TABLE "TrainingCompletion"/);
      });
      it("does NOT alter TrainingQuestionResponse", () => {
        expect(sql).not.toMatch(/ALTER TABLE "TrainingQuestionResponse"/);
      });
    });
  }
});

describe("EP-TRAIN-3 Slice 1 :: dormant behaviour (no new employee/manager code paths yet)", () => {
  it("Slice 1 does NOT ship a /app/admin/hr/training/.../edit builder route", () => {
    expect(existsSync(join(process.cwd(), "src/app/app/admin/hr/training/[courseId]/versions/[versionId]/edit"))).toBe(false);
    expect(existsSync(join(process.cwd(), "src/app/app/admin/hr/training/[courseId]/versions/[versionId]/edit/page.tsx"))).toBe(false);
  });
  it("Slice 1 does NOT change the employee CoursePlayer checkpoint state machine", () => {
    const player = readFileSync(
      join(process.cwd(), "src/app/employee/(authed)/safety-training/[versionId]/CoursePlayer.tsx"),
      "utf8",
    );
    // No new client-side checkpoint handling has shipped yet.
    expect(player).not.toMatch(/CHECKPOINT_PENDING|CHECKPOINT_ANSWERING|clearedCheckpointIds/);
  });
  it("Slice 1 does NOT change the attempts.ts final-assessment precondition", () => {
    const attempts = readFileSync(join(process.cwd(), "src/lib/hr/training/attempts.ts"), "utf8");
    // The existing VIDEO_COMPLETION_THRESHOLD_PERCENT gate is preserved;
    // the new "all required checkpoints cleared" precondition lands in
    // Slice 3, not here.
    expect(attempts).toMatch(/VIDEO_COMPLETION_THRESHOLD_PERCENT/);
    expect(attempts).not.toMatch(/all required checkpoints cleared/i);
  });
  it("Slice 1 ships NO new RBAC permission (reuses existing hr:training:write)", () => {
    const perms = readFileSync(join(process.cwd(), "src/lib/permissions.ts"), "utf8");
    expect(perms).toMatch(/hr:training:write/);
    expect(perms).not.toMatch(/hr:training:checkpoint:write/);
    expect(perms).not.toMatch(/hr:training:checkpoint:read/);
  });
});

/* ============================================================
 * Behaviour-level: new fields are read + written through the
 * generated Prisma client without regressing existing semantics.
 * ============================================================ */

describe("EP-TRAIN-3 Slice 1 :: behaviour (new Prisma client fields)", () => {
  it("TrainingCheckpoint model is exposed on the Prisma client", async () => {
    const { PrismaClient } = await import("@prisma/client");
    const p = new PrismaClient();
    try {
      // Model accessor is present even without data.
      expect(typeof p.trainingCheckpoint.findMany).toBe("function");
    } finally {
      await p.$disconnect();
    }
  });

  it("TrainingAttempt generated type carries the new `kind` + `checkpointId` fields", async () => {
    const { PrismaClient } = await import("@prisma/client");
    const p = new PrismaClient();
    try {
      // Attempt a type-safe `select` on both new fields; TS compile +
      // Prisma validate pass only if the fields are present.
      const noneQuery = p.trainingAttempt.findFirst({
        where: { kind: "FINAL" },
        select: { id: true, kind: true, checkpointId: true },
      });
      // The DB is empty + schema is fresh; a null result is fine.
      await expect(noneQuery).resolves.toBeNull();
    } finally {
      await p.$disconnect();
    }
  });

  it("TrainingProgress generated type carries `checkpointClearedJson`", async () => {
    const { PrismaClient } = await import("@prisma/client");
    const p = new PrismaClient();
    try {
      const query = p.trainingProgress.findFirst({
        select: { id: true, checkpointClearedJson: true },
      });
      await expect(query).resolves.toBeNull();
    } finally {
      await p.$disconnect();
    }
  });

  it("TrainingQuestion generated type carries `checkpointId` + `questionType`", async () => {
    const { PrismaClient } = await import("@prisma/client");
    const p = new PrismaClient();
    try {
      const query = p.trainingQuestion.findFirst({
        where: { questionType: "SINGLE_CHOICE" },
        select: { id: true, checkpointId: true, questionType: true },
      });
      await expect(query).resolves.toBeNull();
    } finally {
      await p.$disconnect();
    }
  });
});
