// EP-TRAIN-4Y-AB §4 — unit tests for the manager inline-edit service.
// Uses an in-memory Prisma double so the full tx path (including
// writeStateTransition) is exercised without a DB.

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  editAiDraft,
  EditRejectedError,
} from "@/lib/hr/training/ai-review/edit-service";
import { canonicalise, sha256Hex } from "@/lib/hr/training/ai-review/content-hash";

type DraftRow = {
  id: string;
  clubId: string;
  courseId: string;
  courseVersionId: string;
  state: string;
  contentHash: string;
  recordVersion: number;
  draftJson: string;
  sourceVideoSha256: string;
  resolvedTranscriptBuildId: string;
  groundingProjectionSha256: string;
  groundingProjectionId: string | null;
  pilotAuthorizationId: string;
  pilotAuthorizationFingerprint: string;
  generationRunId: string | null;
  stateChangedByUserId: string | null;
  stateChangedAt: Date;
  supersedesDraftId: string | null;
  createdAt: Date;
  updatedAt: Date;
  generatedAt: Date;
  generatedByUserId: string | null;
};

function makeParentDraft(overrides: Partial<DraftRow> = {}): DraftRow {
  const body = {
    questionType: "SINGLE_CHOICE",
    questionText: "What is the best way to address a Silver Springs member?",
    options: [
      { text: "By their first name", isCorrect: false },
      { text: "Mr./Mrs. (Last Name)", isCorrect: true },
      { text: "By their member number", isCorrect: false },
      { text: "No formal address needed", isCorrect: false },
    ],
    explanation: "Club etiquette.",
    sourceSegmentIds: [15, 18],
  };
  const json = JSON.stringify(body);
  return {
    id: "parent-draft-1",
    clubId: "clubA",
    courseId: "courseA",
    courseVersionId: "versionA",
    state: "REQUIRES_HUMAN_REVIEW",
    contentHash: sha256Hex(canonicalise(body)),
    recordVersion: 3,
    draftJson: json,
    sourceVideoSha256: "sha",
    resolvedTranscriptBuildId: "build",
    groundingProjectionSha256: "proj",
    groundingProjectionId: "proj-row",
    pilotAuthorizationId: "4w-generation",
    pilotAuthorizationFingerprint: "fp",
    generationRunId: "run-1",
    stateChangedByUserId: null,
    stateChangedAt: new Date(),
    supersedesDraftId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    generatedAt: new Date(),
    generatedByUserId: null,
    ...overrides,
  };
}

function makePrismaDouble(parent: DraftRow) {
  const store: Record<string, DraftRow> = { [parent.id]: { ...parent } };
  const transitions: Array<Record<string, unknown>> = [];
  let nextId = 1;
  const genId = () => `edited-draft-${nextId++}`;
  const db = {
    trainingQuestionAiDraft: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const row = Object.values(store).find(
          (r) =>
            r.id === where.id &&
            r.clubId === (where.clubId as string),
        );
        return row ?? null;
      }),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        return store[where.id] ?? null;
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const id = genId();
        const row = {
          ...(data as unknown as DraftRow),
          id,
          createdAt: new Date(),
          updatedAt: new Date(),
          stateChangedAt: new Date(),
        };
        store[id] = row;
        return { id };
      }),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          const row = store[where.id as string];
          if (
            !row ||
            row.recordVersion !== (where.recordVersion as number) ||
            row.state !== (where.state as string)
          ) {
            return { count: 0 };
          }
          Object.assign(row, data);
          return { count: 1 };
        },
      ),
    },
    trainingQuestionAiStateTransition: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const t = { ...data, id: `trans-${transitions.length + 1}` };
        transitions.push(t);
        return { id: t.id };
      }),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
  };
  return { db, store, transitions };
}

// The real Principal shape uses `memberships` + a RoleKey lookup; the
// edit-service calls hasPermission which goes through ROLE_PERMISSIONS.
// SUPER_ADMIN holds every grant via the isSuperAdmin short-circuit.
const principal = {
  id: "user-manager",
  memberships: [{ clubId: "clubA", roleKey: "SUPER_ADMIN" as const }],
};

const PERMISSIONLESS_PRINCIPAL = {
  id: "user-reviewer-no-edit",
  memberships: [{ clubId: "clubA", roleKey: "EMPLOYEE" as const }],
};

describe("editAiDraft — happy path", () => {
  it("creates a new EDITED_VALIDATION_STALE draft and archives the parent", async () => {
    const parent = makeParentDraft();
    const { db, store, transitions } = makePrismaDouble(parent);

    const result = await editAiDraft(
      principal as never,
      "clubA",
      {
        draftId: parent.id,
        questionText: "What is the correct way to address a Silver Springs member?",
        options: [
          { text: "By their first name", isCorrect: false },
          { text: "Mr./Mrs. plus their surname", isCorrect: true },
          { text: "By their member number", isCorrect: false },
          { text: "No formal address needed", isCorrect: false },
        ],
        explanation: "Club etiquette specifies formal address.",
        expectedContentHash: parent.contentHash,
        expectedRecordVersion: parent.recordVersion,
        reviewerNote: "Removed internal transcript reference.",
      },
      { prisma: db as never },
    );
    expect(result.ok).toBe(true);
    expect(result.newState).toBe("EDITED_VALIDATION_STALE");
    expect(result.supersedesDraftId).toBe(parent.id);
    const newRow = store[result.newDraftId];
    expect(newRow.state).toBe("EDITED_VALIDATION_STALE");
    expect(newRow.supersedesDraftId).toBe(parent.id);
    expect(newRow.contentHash).toBe(result.newContentHash);
    // Parent should be archived.
    const parentAfter = store[parent.id];
    expect(parentAfter.state).toBe("ARCHIVED");
    expect(parentAfter.recordVersion).toBe(parent.recordVersion + 1);
    // Transition row should exist with SUPERSEDED_BY_EDIT.
    expect(transitions).toHaveLength(1);
    expect(transitions[0].fromState).toBe("REQUIRES_HUMAN_REVIEW");
    expect(transitions[0].toState).toBe("ARCHIVED");
    expect(transitions[0].reasonCode).toBe("SUPERSEDED_BY_EDIT");
  });

  it("preserves parent's questionType + sourceSegmentIds in the new body", async () => {
    const parent = makeParentDraft();
    const { db, store } = makePrismaDouble(parent);
    const result = await editAiDraft(
      principal as never,
      "clubA",
      {
        draftId: parent.id,
        questionText: "A valid rewrite of the question.",
        options: [
          { text: "A", isCorrect: true },
          { text: "B", isCorrect: false },
        ],
        explanation: "",
        expectedContentHash: parent.contentHash,
        expectedRecordVersion: parent.recordVersion,
      },
      { prisma: db as never },
    );
    const body = JSON.parse(store[result.newDraftId].draftJson);
    expect(body.questionType).toBe("SINGLE_CHOICE");
    expect(body.sourceSegmentIds).toEqual([15, 18]);
  });
});

describe("editAiDraft — refusals", () => {
  it("refuses when caller lacks hr:training:ai:edit", async () => {
    const parent = makeParentDraft();
    const { db } = makePrismaDouble(parent);
    await expect(
      editAiDraft(
        PERMISSIONLESS_PRINCIPAL as never,
        "clubA",
        {
          draftId: parent.id,
          questionText: "A valid rewrite.",
          options: [
            { text: "A", isCorrect: true },
            { text: "B", isCorrect: false },
          ],
          explanation: "",
          expectedContentHash: parent.contentHash,
          expectedRecordVersion: parent.recordVersion,
        },
        { prisma: db as never },
      ),
    ).rejects.toMatchObject({ rejectionCode: "EDIT_FORBIDDEN" });
  });

  it("refuses when expectedContentHash does not match", async () => {
    const parent = makeParentDraft();
    const { db } = makePrismaDouble(parent);
    await expect(
      editAiDraft(
        principal as never,
        "clubA",
        {
          draftId: parent.id,
          questionText: "A valid rewrite.",
          options: [
            { text: "A", isCorrect: true },
            { text: "B", isCorrect: false },
          ],
          explanation: "",
          expectedContentHash: "0".repeat(64),
          expectedRecordVersion: parent.recordVersion,
        },
        { prisma: db as never },
      ),
    ).rejects.toMatchObject({ rejectionCode: "EDIT_CONTENT_HASH_MISMATCH" });
  });

  it("refuses when the edited text contains the ACCORDING_TO_TRANSCRIPT leakage", async () => {
    const parent = makeParentDraft();
    const { db } = makePrismaDouble(parent);
    await expect(
      editAiDraft(
        principal as never,
        "clubA",
        {
          draftId: parent.id,
          questionText:
            "According to the transcript, what is the first step for new members?",
          options: [
            { text: "Attend orientation", isCorrect: true },
            { text: "Skip the forms", isCorrect: false },
          ],
          explanation: "",
          expectedContentHash: parent.contentHash,
          expectedRecordVersion: parent.recordVersion,
        },
        { prisma: db as never },
      ),
    ).rejects.toMatchObject({ rejectionCode: "EDIT_TEXT_LEAKAGE" });
  });

  it("refuses an edit from APPROVED_DRAFT (not an editable state)", async () => {
    const parent = makeParentDraft({ state: "APPROVED_DRAFT" });
    const { db } = makePrismaDouble(parent);
    await expect(
      editAiDraft(
        principal as never,
        "clubA",
        {
          draftId: parent.id,
          questionText: "Any edit attempt here.",
          options: [
            { text: "A", isCorrect: true },
            { text: "B", isCorrect: false },
          ],
          explanation: "",
          expectedContentHash: parent.contentHash,
          expectedRecordVersion: parent.recordVersion,
        },
        { prisma: db as never },
      ),
    ).rejects.toMatchObject({ rejectionCode: "EDIT_STATE_NOT_EDITABLE" });
  });

  it("refuses when fewer than exactly one correct option is marked", async () => {
    const parent = makeParentDraft();
    const { db } = makePrismaDouble(parent);
    await expect(
      editAiDraft(
        principal as never,
        "clubA",
        {
          draftId: parent.id,
          questionText: "Totally fine wording here.",
          options: [
            { text: "A", isCorrect: true },
            { text: "B", isCorrect: true },
          ],
          explanation: "",
          expectedContentHash: parent.contentHash,
          expectedRecordVersion: parent.recordVersion,
        },
        { prisma: db as never },
      ),
    ).rejects.toMatchObject({ rejectionCode: "EDIT_CORRECT_INDEX_OUT_OF_RANGE" });
  });

  it("refuses an edit that produces the SAME contentHash as the parent", async () => {
    const parent = makeParentDraft();
    const parentBody = JSON.parse(parent.draftJson);
    const { db } = makePrismaDouble(parent);
    await expect(
      editAiDraft(
        principal as never,
        "clubA",
        {
          draftId: parent.id,
          questionText: parentBody.questionText,
          options: parentBody.options,
          explanation: parentBody.explanation,
          expectedContentHash: parent.contentHash,
          expectedRecordVersion: parent.recordVersion,
        },
        { prisma: db as never },
      ),
    ).rejects.toMatchObject({ rejectionCode: "EDIT_DUPLICATE_OF_PARENT" });
  });
});
