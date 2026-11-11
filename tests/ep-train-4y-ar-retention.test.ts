/**
 * EP-TRAIN-4Y-AR §5 — offline contract tests for the rejected-
 * proposal diagnostic retention mechanism.
 *
 * Uses SYNTHETIC fixtures — the real AP proposal text was lost
 * (see PHASE-4Y-AQ-REPORT.md §1). After AR deploys, FUTURE runs
 * will retain real text for the exact scenario that caused AQ's
 * forensic gap.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  buildRetainedRejectedProposal,
  pruneExpiredRetainedProposals,
  flattenRetainedFromDiagnostics,
  DEFAULT_RETENTION_DAYS,
  type RetainedRejectedProposal,
} from "@/lib/hr/training/generation/rejected-proposal-retention";

// SYNTHETIC — mimics the AP failure shape for coverage.
const AP_SHAPED_SYNTHETIC = {
  questionText:
    "According to the training material, what identifier is used to access pay stubs? (see segment 4)",
  options: [
    { text: "The last four digits of their SIN number", isCorrect: true },
    { text: "Their full social insurance number", isCorrect: false },
    { text: "Their employee ID", isCorrect: false },
    { text: "Their phone number", isCorrect: false },
  ],
  explanation:
    "Pay stubs are accessed via the last four digits of the employee SIN number.",
  sourceSegmentIds: [3, 4, 5, 6],
  questionType: "MULTIPLE_CHOICE",
};

describe("EP-TRAIN-4Y-AR §5.1 — retention builder contract", () => {
  it("captures original + normalised text, options, explanation, source segments, stage, codes", () => {
    const rejectedAt = new Date("2026-11-11T02:30:00.000Z");
    const r = buildRetainedRejectedProposal({
      proposalIndex: 0,
      rejectionStage: "SANITISER",
      proposal: AP_SHAPED_SYNTHETIC,
      normalisedQuestionText: "What identifier is used to access pay stubs?",
      normalisationTransforms: [
        { ruleId: "LEADING_FRAME_ACCORDING_TO_TRAINING_MATERIAL", position: "leading", beforeSlice: "According to the training material, ", afterSlice: "" },
        { ruleId: "TRAILING_SEGMENT_PARENTHETICAL_SEE_SEGMENT", position: "trailing", beforeSlice: " (see segment 4)", afterSlice: "" },
      ],
      normalisationRefusalReason: null,
      findingCodes: "ACCORDING_TO_TRAINING_MATERIAL,EXPLICIT_SEGMENT_ID_REFERENCE",
      rejectedAt,
      generationRunId: "run_synthetic_ar_1",
      groupId: "fa-1",
    });
    expect(r.originalQuestionText).toBe(AP_SHAPED_SYNTHETIC.questionText);
    expect(r.normalisedQuestionText).toBe("What identifier is used to access pay stubs?");
    expect(r.options).toHaveLength(4);
    expect(r.options[0].isCorrect).toBe(true);
    expect(r.explanation).toBe(AP_SHAPED_SYNTHETIC.explanation);
    expect(r.sourceSegmentIds).toEqual([3, 4, 5, 6]);
    expect(r.rejectionStage).toBe("SANITISER");
    expect(r.findingCodes).toBe("ACCORDING_TO_TRAINING_MATERIAL,EXPLICIT_SEGMENT_ID_REFERENCE");
    expect(r.normalisationTransforms).toHaveLength(2);
    expect(r.generationRunId).toBe("run_synthetic_ar_1");
    expect(r.groupId).toBe("fa-1");
    expect(r.rejectedAt).toBe("2026-11-11T02:30:00.000Z");
  });

  it("sets retentionExpiresAt = rejectedAt + 30 days by default", () => {
    const rejectedAt = new Date("2026-11-11T02:30:00.000Z");
    const r = buildRetainedRejectedProposal({
      proposalIndex: 0,
      rejectionStage: "SANITISER",
      proposal: AP_SHAPED_SYNTHETIC,
      normalisedQuestionText: AP_SHAPED_SYNTHETIC.questionText,
      normalisationTransforms: [],
      normalisationRefusalReason: null,
      findingCodes: "ACCORDING_TO_TRAINING_MATERIAL",
      rejectedAt,
      generationRunId: "r1",
      groupId: "fa-1",
    });
    const expiresMs = Date.parse(r.retentionExpiresAt);
    const expectedMs = rejectedAt.getTime() + DEFAULT_RETENTION_DAYS * 86_400_000;
    expect(expiresMs).toBe(expectedMs);
  });

  it("records NORMALISATION_REFUSED stage + refusal reason", () => {
    const r = buildRetainedRejectedProposal({
      proposalIndex: 0,
      rejectionStage: "NORMALISATION_REFUSED",
      proposal: AP_SHAPED_SYNTHETIC,
      normalisedQuestionText: AP_SHAPED_SYNTHETIC.questionText,
      normalisationTransforms: [],
      normalisationRefusalReason: "MULTIPLE_COMPETING_LEADING_RULES",
      findingCodes: "ACCORDING_TO_TRAINING_MATERIAL",
      rejectedAt: new Date(),
      generationRunId: "r1",
      groupId: "fa-1",
    });
    expect(r.rejectionStage).toBe("NORMALISATION_REFUSED");
    expect(r.normalisationRefusalReason).toBe("MULTIPLE_COMPETING_LEADING_RULES");
  });
});

describe("EP-TRAIN-4Y-AR §5.2 — retrieval + pruning", () => {
  const rejectedAt = new Date("2026-11-11T02:30:00.000Z");
  const mkRetained = (groupId: string, index: number, rejectedMsOffset = 0): RetainedRejectedProposal =>
    buildRetainedRejectedProposal({
      proposalIndex: index,
      rejectionStage: "SANITISER",
      proposal: AP_SHAPED_SYNTHETIC,
      normalisedQuestionText: AP_SHAPED_SYNTHETIC.questionText,
      normalisationTransforms: [],
      normalisationRefusalReason: null,
      findingCodes: "ACCORDING_TO_TRAINING_MATERIAL",
      rejectedAt: new Date(rejectedAt.getTime() + rejectedMsOffset),
      generationRunId: "run_1",
      groupId,
    });

  it("flattens multi-group diagnostics into a single ordered array", () => {
    const diagnostics = [
      { group: "fa-1", rejectedProposals: [mkRetained("fa-1", 0), mkRetained("fa-1", 1)] },
      { group: "fa-2", rejectedProposals: [mkRetained("fa-2", 0)] },
    ];
    const flat = flattenRetainedFromDiagnostics(diagnostics);
    expect(flat).toHaveLength(3);
    expect(flat.map((r) => r.groupId)).toEqual(["fa-1", "fa-1", "fa-2"]);
    expect(flat.map((r) => r.proposalIndex)).toEqual([0, 1, 0]);
  });

  it("prunes records whose retentionExpiresAt is past `now`", () => {
    const retained = [
      mkRetained("fa-1", 0), // expires rejectedAt + 30d
      mkRetained("fa-1", 1, 0),
    ];
    const now = new Date(rejectedAt.getTime() + 31 * 86_400_000);
    const active = pruneExpiredRetainedProposals(retained, now);
    expect(active).toHaveLength(0);
  });

  it("keeps records whose retentionExpiresAt is in the future", () => {
    const retained = [mkRetained("fa-1", 0)];
    const now = new Date(rejectedAt.getTime() + 15 * 86_400_000);
    const active = pruneExpiredRetainedProposals(retained, now);
    expect(active).toHaveLength(1);
  });
});

describe("EP-TRAIN-4Y-AR §5.3 — tenant isolation (structural)", () => {
  it("retained record carries generationRunId that correlates to the row's clubId", () => {
    // The TrainingQuestionAiGenerationRun row carries clubId. The
    // retained record carries generationRunId. The admin GET
    // endpoint joins them AND rejects if run.clubId != caller's
    // active clubId. The record itself does NOT carry clubId —
    // scope is enforced AT the admin route, not duplicated into
    // every row. This test documents the contract: generationRunId
    // is REQUIRED on every retained record.
    const r = buildRetainedRejectedProposal({
      proposalIndex: 0,
      rejectionStage: "SANITISER",
      proposal: AP_SHAPED_SYNTHETIC,
      normalisedQuestionText: AP_SHAPED_SYNTHETIC.questionText,
      normalisationTransforms: [],
      normalisationRefusalReason: null,
      findingCodes: "X",
      rejectedAt: new Date(),
      generationRunId: "run_club_A",
      groupId: "fa-1",
    });
    expect(r.generationRunId).toBe("run_club_A");
    // A reader filtering by run id transitively filters by club id.
  });
});

describe("EP-TRAIN-4Y-AR §5.4 — employee-facing API isolation", () => {
  // Structural guard: assert no employee-facing module imports the
  // retention module. The retention module name is unique, so a
  // simple directory grep produces a definitive answer.
  const retentionModuleName = "rejected-proposal-retention";
  const employeeSurfaces = [
    "src/app/member",
    "src/app/app/member",
    "src/app/employee",
    "src/app/app/employee",
    "src/app/app/hub",
    "src/app/app/dashboard",
  ];
  function filesUnder(dir: string): string[] {
    const root = path.resolve(process.cwd(), dir);
    if (!fs.existsSync(root)) return [];
    const out: string[] = [];
    const stack: string[] = [root];
    while (stack.length) {
      const next = stack.pop()!;
      for (const entry of fs.readdirSync(next, { withFileTypes: true })) {
        const full = path.join(next, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
          out.push(full);
        }
      }
    }
    return out;
  }
  it("no employee-facing surface imports the retention module", () => {
    const leaks: string[] = [];
    for (const dir of employeeSurfaces) {
      for (const file of filesUnder(dir)) {
        const text = fs.readFileSync(file, "utf8");
        if (text.includes(retentionModuleName)) leaks.push(file);
      }
    }
    expect(leaks).toEqual([]);
  });
  it("no employee-facing surface references the rejectedProposals field by name", () => {
    const leaks: string[] = [];
    const field = "rejectedProposals";
    for (const dir of employeeSurfaces) {
      for (const file of filesUnder(dir)) {
        const text = fs.readFileSync(file, "utf8");
        if (text.includes(field)) leaks.push(file);
      }
    }
    expect(leaks).toEqual([]);
  });
});

describe("EP-TRAIN-4Y-AR §5.5 — retention does not alter the 14 approved hashes", () => {
  it("retention module exports contain no draft-mutating surface", async () => {
    // The retention sink is `shortfallReasonJson.perGroupDiagnostics
    // [*].rejectedProposals[]`. It lives on the AiGenerationRun
    // row. Drafts are a separate table (TrainingQuestionAiDraft).
    // The retention module has no DB client and no imports from
    // the drafts path — so by shape it cannot touch a draft row.
    const mod = await import("@/lib/hr/training/generation/rejected-proposal-retention");
    for (const name of Object.keys(mod)) {
      expect(name.toLowerCase().includes("draft")).toBe(false);
    }
  });
  it("retention module source imports neither prisma nor the drafts path", () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), "src/lib/hr/training/generation/rejected-proposal-retention.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/from\s+["']@\/lib\/prisma["']/);
    expect(src).not.toMatch(/TrainingQuestionAiDraft/);
  });
});

describe("EP-TRAIN-4Y-AR §5.6 — DEDUP rejection retention", () => {
  it("retains proposals dropped at the dedup stage with DEDUP: finding code", () => {
    const r = buildRetainedRejectedProposal({
      proposalIndex: 2,
      rejectionStage: "DEDUP",
      proposal: AP_SHAPED_SYNTHETIC,
      normalisedQuestionText: "What identifier is used to access pay stubs?",
      normalisationTransforms: [],
      normalisationRefusalReason: null,
      findingCodes: "DEDUP:PARAPHRASE_DUP",
      rejectedAt: new Date(),
      generationRunId: "r1",
      groupId: "fa-1",
    });
    expect(r.rejectionStage).toBe("DEDUP");
    expect(r.findingCodes).toBe("DEDUP:PARAPHRASE_DUP");
  });
});
