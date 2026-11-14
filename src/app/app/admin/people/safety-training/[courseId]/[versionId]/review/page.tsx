// EP-TRAIN-4Y-S §5+§6+§7+§8 — Manager Review (video-first authoring).
// EP-TRAIN-4Y-AA §2+§5 (2026-11-09) — reads course-level AI metadata
// (title + description) directly from TrainingCourse so the review
// surface shows the Qwen-written description, not the version's
// transcript introduction. Also resolves each draft's generation-plan
// destination (CHECKPOINT vs FINAL_ASSESSMENT) from the run's
// shortfallReasonJson so the Checkpoints / Final-assessment tabs
// filter authentically.
//
// Data loaded server-side (tenant-scoped at every query):
//   - Course row (title, description, AI attribution)
//   - Version row (publish settings, video, checkpoints)
//   - Latest generation run (for the shortfallReasonJson → destination map)
//   - AI drafts with their resolved destination kind
//
// Actions on the client call the existing approve / reject / promote
// routes — no new mutation paths are introduced here. Separation of
// duties is unchanged.

import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { listCheckpointsForVersion } from "@/lib/hr/training/checkpoints";
import { checkPublishReadiness } from "@/lib/hr/training/courses";
import {
  annotateDraftsWithComposedDestination,
  composeGroupMapsFromRuns,
} from "@/lib/hr/training/generation/destination-resolver";
import { listRetainedForManagerReview } from "@/lib/hr/training/generation/retained-proposals-reader";
import ManagerReviewClient from "./ManagerReviewClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function ManagerReviewPage({
  params,
}: {
  params: { courseId: string; versionId: string };
}) {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });
  if (!hasPermission(principal, clubId, "hr:training:read")) {
    redirect("/app/admin/people/employees");
  }
  const version = await prisma.trainingCourseVersion.findFirst({
    where: { id: params.versionId, course: { id: params.courseId, clubId } },
    include: {
      course: {
        select: {
          id: true,
          code: true,
          title: true,
          description: true,
          aiMetadataAttributionSource: true,
          aiMetadataAttributedTitle: true,
        },
      },
    },
  });
  if (!version) redirect("/app/admin/people/safety-training");

  const canApprove = hasPermission(principal, clubId, "hr:training:ai:approve");
  const canAuthor = hasPermission(principal, clubId, "hr:training:write");
  const canRead = hasPermission(principal, clubId, "hr:training:ai:read");

  const checkpoints = await listCheckpointsForVersion(version.id);
  // EP-TRAIN-4Y-BC §1 — per-checkpoint active question count for the
  // live-marker invariant. A persisted TrainingCheckpoint only
  // qualifies as a "live" marker when at least one bound
  // TrainingQuestion is active=true.
  const activeQuestionCountsByCheckpointId = checkpoints.length === 0
    ? new Map<string, number>()
    : await (async () => {
        const grouped = await prisma.trainingQuestion.groupBy({
          by: ["checkpointId"],
          where: {
            courseVersionId: version.id,
            active: true,
            checkpointId: { in: checkpoints.map((c) => c.id) },
          },
          _count: { checkpointId: true },
        });
        const m = new Map<string, number>();
        for (const row of grouped) {
          if (row.checkpointId) m.set(row.checkpointId, row._count.checkpointId);
        }
        return m;
      })();
  const checkpointsWithActiveCount = checkpoints.map((c) => ({
    id: c.id,
    label: c.label,
    atSecond: c.atSecond,
    activeQuestionCount: activeQuestionCountsByCheckpointId.get(c.id) ?? 0,
  }));
  const readiness = await checkPublishReadiness(version.id);

  // Audience summary for the pre-publish review card.
  type AudienceSummary = {
    kind: "everyone" | "scoped" | "explicit";
    deptCount: number;
    positionCount: number;
  };
  const appliesToAll = !!version.appliesToAll;
  const deptIds = Array.isArray(version.appliesToDeptIds) ? version.appliesToDeptIds.length : 0;
  const positionIds = Array.isArray(version.appliesToPositionIds)
    ? version.appliesToPositionIds.length
    : 0;
  const audience: AudienceSummary = appliesToAll
    ? { kind: "everyone", deptCount: 0, positionCount: 0 }
    : deptIds > 0 || positionIds > 0
      ? { kind: "scoped", deptCount: deptIds, positionCount: positionIds }
      : { kind: "explicit", deptCount: 0, positionCount: 0 };

  const publishConfig = {
    passingScore: version.passingScore ?? 80,
    retakesAllowed: !!version.retakesAllowed,
    required: !!version.required,
    requiresKnowledgeTest: !!version.requiresKnowledgeTest,
    audience,
    versionState: version.state,
    readinessReady: readiness.ready,
    readinessReasons: readiness.reasons,
  };

  // EP-TRAIN-4Y-AA §5 — load generation runs so the shortfallReasonJson
  // (contentHash → group map) can resolve each draft's destination.
  //
  // EP-TRAIN-4Y-AA §4 — also load assessmentPlanJson so the review
  // page can render the checkpoint timeline markers when the course
  // has no persisted TrainingCheckpoint rows. The plan's
  // `proposedCheckpointGroups[].atSec` values are the authoritative
  // timestamps the worker used — they are NOT invented markers.
  //
  // EP-TRAIN-4Y-AF §6 (2026-11-10) — composed resolver across ALL
  // COMPLETED runs for this (clubId, courseVersionId). The FA recovery
  // lifecycle creates a NEW generation run whose drafts live beside the
  // original checkpoint drafts; without the composed walk, FA-recovered
  // drafts would resolve as UNKNOWN because the "latest" run's
  // shortfallReasonJson only names FA chunk groups and the ORIGINAL run
  // alone names checkpoint groups (or vice versa). We select the
  // atSec-bearing plan from the FIRST run that carries a non-empty
  // `proposedCheckpointGroups`, which keeps AE2's chronological sort
  // stable across recovery.
  // EP-TRAIN-4Y-AU (2026-11-11) — the composed destination resolver
  // must see EVERY TERMINAL run for this version, not only COMPLETED
  // ones. The AR → AS lifecycle lands a successful manager-recovered
  // draft inside the `shortfallReasonJson.perGroupDiagnostics[g]
  // .recoveryHistory[]` of a run whose terminal state is FAILED
  // (because the GPU call itself was rejected — the manager then
  // corrected and persisted offline). Filtering to COMPLETED-only
  // hides that recovery from the resolver, which collapses the
  // recovered draft's destination to UNKNOWN, which then makes it
  // render in BOTH tabs (observed as "Checkpoints · 6" in the
  // founder's screenshot) and shows "destination unknown" in the
  // header.
  //
  // Fix: query both COMPLETED and FAILED runs. CANCELLED runs are
  // excluded because they didn't reach a terminal commit of their
  // shortfall payload. RUNNING / QUEUED / REQUESTED are excluded
  // because they haven't committed state yet. Ordering retains the
  // original semantics (completed-first by completedAt, otherwise
  // by requestedAt) so `planRun` selection is unchanged.
  const allTerminalRuns = await prisma.trainingQuestionAiGenerationRun.findMany({
    where: {
      clubId,
      courseVersionId: version.id,
      executionStatus: { in: ["COMPLETED", "FAILED"] },
    },
    orderBy: [{ completedAt: "asc" }, { requestedAt: "asc" }],
    select: {
      id: true,
      shortfallReasonJson: true,
      assessmentPlanJson: true,
      completedAt: true,
    },
  });
  // Fallback: when no terminal run exists yet, include QUEUED /
  // RUNNING too so the review surface renders during initial
  // generation. atSec markers come from whichever run has the plan.
  const runsForResolver = allTerminalRuns.length > 0
    ? allTerminalRuns
    : await prisma.trainingQuestionAiGenerationRun.findMany({
        where: { clubId, courseVersionId: version.id },
        orderBy: [{ requestedAt: "asc" }],
        select: {
          id: true,
          shortfallReasonJson: true,
          assessmentPlanJson: true,
          completedAt: true,
        },
      });

  // EP-TRAIN-4Y-BB §1+§3 — Pick the planRun that actually represents
  // the generation that produced the drafts on this course. The 4Y-AA
  // selector picked the FIRST run with non-empty checkpoint groups,
  // which for `cmwgl11wv002jh25jb8gfzlwi` meant one of the 108+
  // pre-BA FAILED runs whose stale plans had 30 CP groups. The
  // review page then rendered 30 timeline markers while only 1 CP
  // was actually planned in the successful run — the "30 question
  // markers from an obsolete plan" the BB directive forbids.
  //
  // Priority order (most-authoritative first):
  //   1. A COMPLETED run that produced drafts (any CP-group count).
  //   2. A RUNNING / QUEUED / REQUESTED run (in-flight; its plan is
  //      authoritative for the current attempt).
  //   3. ANY run with a non-empty CP group AND inferenceMs !== null
  //      (i.e. a run that actually started inference — not a pre-
  //      flight budget-rejected run).
  //   4. Fall back to any run with a non-empty CP plan (preserves the
  //      prior AA fallback behaviour for courses whose only runs
  //      failed before inference began).
  const nonTerminalRunsAll = await prisma.trainingQuestionAiGenerationRun.findMany({
    where: { clubId, courseVersionId: version.id },
    orderBy: { requestedAt: "desc" },
    select: {
      id: true, shortfallReasonJson: true, assessmentPlanJson: true,
      completedAt: true, executionStatus: true, inferenceMs: true,
    },
  });
  function planHasCheckpointGroups(json: string | null): boolean {
    if (!json) return false;
    try {
      const planObj = JSON.parse(json) as {
        proposedCheckpointGroups?: Array<{ id?: unknown; atSec?: unknown }>;
      };
      return (planObj.proposedCheckpointGroups ?? []).length > 0;
    } catch { return false; }
  }
  let planRun: (typeof runsForResolver)[number] | undefined;
  // Priority 1: COMPLETED run with CP groups in its plan.
  for (const r of nonTerminalRunsAll) {
    if (r.executionStatus !== "COMPLETED") continue;
    if (planHasCheckpointGroups(r.assessmentPlanJson)) { planRun = r as unknown as typeof runsForResolver[number]; break; }
  }
  // Priority 2: in-flight run (RUNNING/QUEUED/REQUESTED).
  if (!planRun) {
    for (const r of nonTerminalRunsAll) {
      if (!(r.executionStatus === "RUNNING" || r.executionStatus === "QUEUED" || r.executionStatus === "REQUESTED")) continue;
      if (planHasCheckpointGroups(r.assessmentPlanJson)) { planRun = r as unknown as typeof runsForResolver[number]; break; }
    }
  }
  // Priority 3: any run whose plan has CP groups AND actually started
  // inference (inferenceMs is not null). Budget pre-flight FAILED runs
  // have inferenceMs=null and must NOT drive marker rendering.
  if (!planRun) {
    for (const r of nonTerminalRunsAll) {
      if (r.inferenceMs == null) continue;
      if (planHasCheckpointGroups(r.assessmentPlanJson)) { planRun = r as unknown as typeof runsForResolver[number]; break; }
    }
  }
  // Priority 4: legacy fallback for courses whose only runs failed
  // before inference began. Preserves 4Y-AA behaviour for tenants
  // that never got past pre-flight.
  if (!planRun) {
    for (const r of runsForResolver) {
      if (planHasCheckpointGroups(r.assessmentPlanJson)) { planRun = r; break; }
    }
  }
  // Legacy compat for any downstream code that still names `latestRun`.
  const latestRun = planRun ?? runsForResolver[runsForResolver.length - 1] ?? null;

  // EP-TRAIN-4Y-AE2 §3 (2026-11-10) — parse the plan's checkpoint
  // groups into a `groupKey → atSec` map for deterministic ordering.
  const groupAtSec = new Map<string, number>();
  try {
    if (planRun?.assessmentPlanJson) {
      const planObj = JSON.parse(planRun.assessmentPlanJson) as {
        proposedCheckpointGroups?: Array<{ id?: unknown; atSec?: unknown }>;
      };
      for (const g of planObj.proposedCheckpointGroups ?? []) {
        if (typeof g?.id === "string" && typeof g?.atSec === "number" && Number.isFinite(g.atSec)) {
          groupAtSec.set(g.id, g.atSec);
        }
      }
    }
  } catch {
    /* malformed plan JSON — fall back to group-key lexical order */
  }

  // EP-TRAIN-4Y-AF §6 — compose contentHash → group across every run
  // so FA-recovered drafts resolve to FINAL_ASSESSMENT via `fa-*`
  // group names AND original checkpoint drafts still resolve to
  // CHECKPOINT via `cg-*` names.
  const composedGroupMap = composeGroupMapsFromRuns(
    runsForResolver.map((r) => r.shortfallReasonJson),
  );

  // Pull AI drafts for this version. Tenant scope enforced via
  // (clubId, courseVersionId); the state filter avoids archived /
  // failed noise.
  type ClientDraft = {
    id: string;
    state: string;
    questionText: string;
    questionType: string;
    options: { optionText: string; isCorrect: boolean }[];
    sourceSegmentIds: number[];
    correctOptionIndex: number;
    isPromoted: boolean;
    destination: "CHECKPOINT" | "FINAL_ASSESSMENT" | "UNKNOWN";
    planGroupKey: string | null;
    // EP-TRAIN-4Y-AE2 §3 — carry the atSec + the original ancestor's
    // contentHash so the client preserves the server's sort and the
    // client's "Question N of M" numbering matches chronological order.
    atSec: number | null;
    originalContentHash: string;
  };
  let drafts: ClientDraft[] = [];
  if (canRead) {
    const rows = await prisma.trainingQuestionAiDraft.findMany({
      where: {
        clubId,
        courseVersionId: version.id,
        state: {
          in: [
            "REQUIRES_HUMAN_REVIEW",
            "APPROVED_DRAFT",
            "REJECTED",
            "GENERATED",
            "VALIDATION_PENDING",
            // EP-TRAIN-4Y-AB §4 — show manager-edited drafts that are
            // awaiting re-validation, and any validator-failed row so
            // the manager can see what the inline edit produced.
            "EDITED_VALIDATION_STALE",
            "VALIDATION_FAILED",
          ],
        },
      },
      orderBy: [{ generatedAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        state: true,
        draftJson: true,
        contentHash: true,
        supersedesDraftId: true,
        promotion: { select: { questionId: true, destination: true } },
      },
      take: 100,
    });

    // EP-TRAIN-4Y-AA §5 — resolve destination for every draft BEFORE
    // mapping to the client shape. Post-promotion rows prefer the
    // sidecar's immutable `destination`; pre-promotion rows fall back
    // to the shortfallReasonJson resolver.
    //
    // EP-TRAIN-4Y-AB §3 — manager-edited drafts carry a fresh
    // contentHash that is absent from the original run's
    // shortfallReasonJson, so the resolver alone classifies them as
    // UNKNOWN. Walk the `supersedesDraftId` ancestry (including
    // ARCHIVED parents, which the main query excluded) and inherit
    // the oldest ancestor's destination. This keeps the Checkpoints /
    // Final-assessment tabs accurate across edits.
    //
    // Chains up to 5 levels deep are resolved via BFS, which handles
    // the realistic case of a manager editing twice (an initial AB §3
    // bulk-cleanup + a subsequent manual edit, both of which supersede
    // further). We stop at depth 5 so a malformed cycle terminates.
    const ancestorsById = new Map<
      string,
      { id: string; contentHash: string; supersedesDraftId: string | null; promotion: { destination: string | null } | null }
    >();
    let frontier = Array.from(
      new Set(
        rows
          .map((r) => r.supersedesDraftId)
          .filter((x): x is string => typeof x === "string" && x.length > 0),
      ),
    );
    for (let depth = 0; depth < 5 && frontier.length > 0; depth++) {
      const batch = await prisma.trainingQuestionAiDraft.findMany({
        where: {
          clubId,
          courseVersionId: version.id,
          id: { in: frontier.filter((id) => !ancestorsById.has(id)) },
        },
        select: {
          id: true,
          contentHash: true,
          supersedesDraftId: true,
          promotion: { select: { destination: true } },
        },
      });
      if (batch.length === 0) break;
      for (const a of batch) {
        ancestorsById.set(a.id, {
          id: a.id,
          contentHash: a.contentHash,
          supersedesDraftId: a.supersedesDraftId,
          promotion: a.promotion ?? null,
        });
      }
      frontier = batch
        .map((a) => a.supersedesDraftId)
        .filter((x): x is string => typeof x === "string" && x.length > 0 && !ancestorsById.has(x));
    }
    const ancestors = Array.from(ancestorsById.values());
    // Deep resolution: if an ancestor is ALSO an edit, follow further
    // up. One extra findMany covers the realistic depth (manager edits
    // on this slice are one level deep); if a future slice stacks
    // edits multiple deep, this still terminates — it just skips the
    // deeper ancestors (destination falls back to UNKNOWN for them,
    // which is the pre-AB behaviour).
    const allForResolver = [
      ...rows.map((r) => ({ id: r.id, contentHash: r.contentHash })),
      ...ancestors.map((a) => ({ id: a.id, contentHash: a.contentHash })),
    ];
    const annotated = annotateDraftsWithComposedDestination({
      drafts: allForResolver,
      composedGroupMap,
    });
    const destByIdRaw = new Map(
      annotated.map((a) => [a.draft.id, { kind: a.destination, groupKey: a.planGroupKey }] as const),
    );
    const ancestorPromoById = new Map(
      ancestors.map((a) => [a.id, a.promotion?.destination ?? null] as const),
    );
    const ancestorParentById = new Map(
      ancestors.map((a) => [a.id, a.supersedesDraftId ?? null] as const),
    );
    const destById = new Map<
      string,
      { kind: "CHECKPOINT" | "FINAL_ASSESSMENT" | "UNKNOWN"; groupKey: string | null }
    >();
    // EP-TRAIN-4Y-AE2 §3 — the ORIGINAL ancestor's contentHash is the
    // stable logical identity of a checkpoint across every edit +
    // revalidation. Falls back to the row's own contentHash when the
    // supersedes chain is empty (= this IS the original).
    const ancestorContentHashById = new Map(
      ancestors.map((a) => [a.id, a.contentHash] as const),
    );
    const originalHashById = new Map<string, string>();
    for (const row of rows) {
      const own = destByIdRaw.get(row.id);
      if (own && own.kind !== "UNKNOWN") {
        destById.set(row.id, { kind: own.kind, groupKey: own.groupKey });
      } else {
        // Walk up to 5 levels of supersedesDraftId to inherit — matches
        // the BFS fan-out depth above.
        let cursor: string | null = row.supersedesDraftId ?? null;
        let resolvedKind: "CHECKPOINT" | "FINAL_ASSESSMENT" | "UNKNOWN" = "UNKNOWN";
        let resolvedGroup: string | null = null;
        for (let depth = 0; depth < 5 && cursor; depth++) {
          const anc = destByIdRaw.get(cursor);
          if (anc && anc.kind !== "UNKNOWN") {
            resolvedKind = anc.kind;
            resolvedGroup = anc.groupKey;
            break;
          }
          const promo = ancestorPromoById.get(cursor);
          if (promo === "CHECKPOINT" || promo === "FINAL_ASSESSMENT") {
            resolvedKind = promo;
            break;
          }
          cursor = ancestorParentById.get(cursor) ?? null;
        }
        destById.set(row.id, { kind: resolvedKind, groupKey: resolvedGroup });
      }
      // Walk to the topmost ancestor to capture its contentHash as the
      // logical identity. Same depth cap as the kind walk above.
      let walker: string | null = row.supersedesDraftId ?? null;
      let originalHash = row.contentHash;
      for (let d = 0; d < 5 && walker; d++) {
        const parentHash = ancestorContentHashById.get(walker);
        if (parentHash) originalHash = parentHash;
        walker = ancestorParentById.get(walker) ?? null;
      }
      originalHashById.set(row.id, originalHash);
    }

    drafts = rows.map((d) => {
      let body: {
        questionText?: unknown;
        questionType?: unknown;
        options?: unknown;
        sourceSegmentIds?: unknown;
      } = {};
      try {
        body = JSON.parse(d.draftJson || "{}");
      } catch {}
      const options: { text?: string; isCorrect?: boolean }[] = Array.isArray(body.options)
        ? (body.options as { text?: string; isCorrect?: boolean }[])
        : [];
      let correctIndex = 0;
      for (let i = 0; i < options.length; i++) {
        if (options[i]?.isCorrect) {
          correctIndex = i;
          break;
        }
      }
      // Promotion sidecar wins when present — it's the immutable
      // post-approval destination — otherwise use the resolver's
      // output (which reads shortfallReasonJson).
      const promoDest = d.promotion?.destination as
        | "CHECKPOINT"
        | "FINAL_ASSESSMENT"
        | undefined;
      const resolved = destById.get(d.id);
      const destination: "CHECKPOINT" | "FINAL_ASSESSMENT" | "UNKNOWN" =
        promoDest ?? resolved?.kind ?? "UNKNOWN";
      return {
        id: d.id,
        state: d.state,
        questionText: String(body.questionText ?? "(no question text)"),
        questionType: String(body.questionType ?? "MULTIPLE_CHOICE"),
        options: options.map((o) => ({
          optionText: String(o?.text ?? ""),
          isCorrect: !!o?.isCorrect,
        })),
        sourceSegmentIds: Array.isArray(body.sourceSegmentIds)
          ? (body.sourceSegmentIds as unknown[]).filter(
              (n): n is number => typeof n === "number",
            )
          : [],
        correctOptionIndex: correctIndex,
        isPromoted: d.state === "APPROVED_DRAFT" && !!d.promotion?.questionId,
        destination,
        planGroupKey: resolved?.groupKey ?? null,
        // EP-TRAIN-4Y-AE2 §3 — chronological ordering carriers.
        atSec: resolved?.groupKey ? groupAtSec.get(resolved.groupKey) ?? null : null,
        originalContentHash: originalHashById.get(d.id) ?? d.contentHash,
      };
    });

    // EP-TRAIN-4Y-AE2 §3 — sort the drafts so Q1 is the earliest
    // checkpoint and Q5 is the latest. Ties on atSec (or atSec null)
    // break lexicographically on the original ancestor's contentHash,
    // which is stable across edits + supersessions + revalidations.
    // Drafts with no resolvable atSec sink to the end in a stable
    // order — never floating to the top where they'd shift the Q1..QN
    // numbering.
    drafts.sort((a, b) => {
      const aSec = a.atSec;
      const bSec = b.atSec;
      if (aSec !== null && bSec !== null) {
        if (aSec !== bSec) return aSec - bSec;
      } else if (aSec !== null) {
        return -1;
      } else if (bSec !== null) {
        return 1;
      }
      // Both null OR tied → stable identity break.
      return a.originalContentHash.localeCompare(b.originalContentHash);
    });
  }

  // EP-TRAIN-4Y-AS §5 — retained rejected-proposal candidates that
  // need a manager editorial correction. Scoped by clubId; already-
  // recovered or expired records are filtered out server-side.
  const retainedRejectedProposals = await listRetainedForManagerReview(clubId, version.id);

  // EP-TRAIN-4Y-AX §2 (2026-11-11) — load manager-authored
  // TrainingQuestion rows for this version so the review workspace can
  // render them alongside the AI drafts in their respective tabs. A
  // question's provenance is determined structurally: a non-null
  // `aiPromotion` means the question was promoted from an AI draft;
  // a NULL aiPromotion means it is manager-authored. No schema change;
  // no new column.
  //
  // Safety: the loader includes an `aiPromotion` select so the client
  // never surfaces an AI-promoted question through the manual list
  // (which would double-count it against the AI-drafts tab). Promoted
  // questions are filtered out server-side.
  type ManualQuestionDest = "CHECKPOINT" | "FINAL_ASSESSMENT";
  interface ManualQuestionForClient {
    id: string;
    prompt: string;
    questionType: "SINGLE_CHOICE" | "MULTI_ANSWER" | "TRUE_FALSE";
    destination: ManualQuestionDest;
    checkpointId: string | null;
    checkpointAtSecond: number | null;
    options: Array<{ id: string; text: string; isCorrect: boolean }>;
    displayOrder: number;
    active: boolean;
    updatedAt: string;
  }
  let manualQuestions: ManualQuestionForClient[] = [];
  if (canRead) {
    const rows = await prisma.trainingQuestion.findMany({
      where: { courseVersionId: version.id, courseVersion: { course: { clubId } } },
      orderBy: [{ displayOrder: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        prompt: true,
        questionType: true,
        checkpointId: true,
        checkpoint: { select: { atSecond: true } },
        displayOrder: true,
        active: true,
        updatedAt: true,
        aiPromotion: { select: { questionId: true } },
        options: {
          orderBy: { displayOrder: "asc" },
          select: { id: true, text: true, isCorrect: true },
        },
      },
    });
    manualQuestions = rows
      .filter((r) => !r.aiPromotion)
      .map((r) => ({
        id: r.id,
        prompt: r.prompt,
        questionType: (r.questionType === "MULTI_ANSWER" || r.questionType === "TRUE_FALSE"
          ? r.questionType
          : "SINGLE_CHOICE") as ManualQuestionForClient["questionType"],
        destination: (r.checkpointId ? "CHECKPOINT" : "FINAL_ASSESSMENT") as ManualQuestionDest,
        checkpointId: r.checkpointId ?? null,
        checkpointAtSecond: r.checkpoint?.atSecond ?? null,
        options: r.options.map((o) => ({ id: o.id, text: o.text, isCorrect: o.isCorrect })),
        displayOrder: r.displayOrder,
        active: r.active,
        updatedAt: r.updatedAt.toISOString(),
      }));
  }

  // EP-TRAIN-4Y-AA §2 — the course-level AI title + description are
  // the authoritative source for the review header. Fall back to the
  // version's values only when the course row is somehow empty (a
  // pre-4Y-X course that never saw a Qwen metadata write).
  const headerTitle = version.course.title;
  const headerDescription =
    version.course.description && version.course.description.trim().length > 0
      ? version.course.description
      : version.description ?? "";

  return (
    // EP-TRAIN-4Y-AE §2 (2026-11-10) — the review surface is the
    // founder's primary content-authoring canvas. The 1400px cap was
    // squeezing the video (which also squeezed the question pane).
    // Let the layout grow to the sidebar-less width of the viewport;
    // the two-column grid below gives the video a minmax floor so it
    // never shrinks below a readable size on small admin monitors.
    <div className="w-full">
      <ManagerReviewClient
        versionId={version.id}
        courseTitle={headerTitle}
        courseDescription={headerDescription}
        videoStorageKey={version.videoStorageKey ?? null}
        videoDurationSec={version.videoDurationSec ?? null}
        videoUrl={
          version.videoStorageKey
            ? `/api/hr/training/versions/${version.id}/video`
            : null
        }
        drafts={drafts}
        checkpoints={resolveLiveCheckpointMarkers(checkpointsWithActiveCount)}
        plannedCheckpoints={resolvePlannedCheckpointMarkers(latestRun?.assessmentPlanJson ?? null)}
        canApprove={canApprove}
        canAuthor={canAuthor}
        canPublish={hasPermission(principal, clubId, "hr:training:publish")}
        courseId={params.courseId}
        publishConfig={publishConfig}
        retainedRejectedProposals={retainedRejectedProposals}
        manualQuestions={manualQuestions}
        isDraft={version.state === "DRAFT"}
      />
    </div>
  );
}

// EP-TRAIN-4Y-BC §1 — enforce the live-marker invariant.
//
// A live checkpoint marker requires BOTH a persisted TrainingCheckpoint
// event AND at least one active TrainingQuestion bound to it. Planned
// checkpoint positions (from the plan's proposedCheckpointGroups) are
// a SEPARATE collection the UI renders visually distinct — they never
// carry an interactive question marker.
//
// This closes the "30-marker from an obsolete plan" (BB) and the
// "1 marker with zero questions" (BC) defects: the UI can no longer
// show a live marker for a checkpoint that has no question.
function resolveLiveCheckpointMarkers(
  checkpoints: Array<{
    id: string; label: string | null; atSecond: number;
    activeQuestionCount: number;
  }>,
): Array<{ id: string; title: string; atSecond: number }> {
  return checkpoints
    .filter((c) => c.activeQuestionCount > 0)
    .map((c) => ({
      id: c.id,
      title: c.label ?? `Checkpoint at ${Math.floor(c.atSecond / 60)}:${String(Math.floor(c.atSecond % 60)).padStart(2, "0")}`,
      atSecond: c.atSecond,
    }))
    .sort((a, b) => a.atSecond - b.atSecond);
}

// EP-TRAIN-4Y-BC §1 — surface planned checkpoint positions separately.
// The UI renders these as dashed / "planned" markers so the manager
// sees where AI generation intended to place checkpoints even before
// any question has been produced.
function resolvePlannedCheckpointMarkers(
  assessmentPlanJson: string | null,
): Array<{ id: string; title: string; atSecond: number }> {
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

// Legacy helper retained for callers that still want the historical
// combined output. Live markers only — never falls back to plan.
// New callers should use `resolveLiveCheckpointMarkers` +
// `resolvePlannedCheckpointMarkers` directly.
function resolveCheckpointMarkers(
  checkpoints: Array<{ id: string; label: string | null; atSecond: number }>,
  _assessmentPlanJson: string | null,
): Array<{ id: string; title: string; atSecond: number }> {
  if (checkpoints.length > 0) {
    return checkpoints.map((c) => ({
      id: c.id,
      title:
        c.label ??
        `Checkpoint at ${Math.floor(c.atSecond / 60)}:${String(
          Math.floor(c.atSecond % 60),
        ).padStart(2, "0")}`,
      atSecond: c.atSecond,
    }));
  }
  // Fallback: plan.proposedCheckpointGroups[].atSec
  if (!_assessmentPlanJson) return [];
  try {
    const plan = JSON.parse(_assessmentPlanJson) as {
      proposedCheckpointGroups?: Array<{
        id?: unknown;
        atSec?: unknown;
      }>;
    };
    const groups = Array.isArray(plan?.proposedCheckpointGroups)
      ? plan.proposedCheckpointGroups
      : [];
    const rows: Array<{ id: string; title: string; atSecond: number }> = [];
    for (const g of groups) {
      if (typeof g?.id !== "string") continue;
      if (typeof g?.atSec !== "number" || !Number.isFinite(g.atSec)) continue;
      rows.push({
        id: `plan:${g.id}`,
        title: `Checkpoint at ${Math.floor(g.atSec / 60)}:${String(
          Math.floor(g.atSec % 60),
        ).padStart(2, "0")}`,
        atSecond: g.atSec,
      });
    }
    return rows.sort((a, b) => a.atSecond - b.atSecond);
  } catch {
    return [];
  }
}
