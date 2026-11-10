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
import { annotateDraftsWithDestination } from "@/lib/hr/training/generation/destination-resolver";
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

  // EP-TRAIN-4Y-AA §5 — load the latest generation run so the
  // shortfallReasonJson (contentHash → group map) can resolve each
  // draft's destination. A version with no run leaves every draft
  // UNKNOWN which the client still renders safely.
  //
  // EP-TRAIN-4Y-AA §4 — also load assessmentPlanJson so the review
  // page can render the checkpoint timeline markers when the course
  // has no persisted TrainingCheckpoint rows (the staging founder
  // course is in exactly this shape: 5 CP drafts were generated but
  // zero TrainingCheckpoint rows exist). The plan's
  // `proposedCheckpointGroups[].atSec` values are the authoritative
  // timestamps the worker used — they are NOT invented markers.
  const latestRun = await prisma.trainingQuestionAiGenerationRun.findFirst({
    where: { clubId, courseVersionId: version.id },
    orderBy: { requestedAt: "desc" },
    select: {
      id: true,
      shortfallReasonJson: true,
      assessmentPlanJson: true,
    },
  });

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
    const annotated = annotateDraftsWithDestination({
      drafts: allForResolver,
      shortfallReasonJson: latestRun?.shortfallReasonJson ?? null,
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
    for (const row of rows) {
      const own = destByIdRaw.get(row.id);
      if (own && own.kind !== "UNKNOWN") {
        destById.set(row.id, { kind: own.kind, groupKey: own.groupKey });
        continue;
      }
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
      };
    });
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
    <div className="max-w-[1400px]">
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
        checkpoints={resolveCheckpointMarkers(checkpoints, latestRun?.assessmentPlanJson ?? null)}
        canApprove={canApprove}
        canAuthor={canAuthor}
        canPublish={hasPermission(principal, clubId, "hr:training:publish")}
        courseId={params.courseId}
        publishConfig={publishConfig}
      />
    </div>
  );
}

// EP-TRAIN-4Y-AA §4 — resolve the checkpoint timeline markers.
//
// Preferred source: persisted `TrainingCheckpoint` rows (the editor's
// own authoritative list). When a course has zero such rows — which
// is the shape of the 4Y-Z pilot course `cmw8n6z8f0008z4nxck6uvms9`
// because the plan produced CP drafts but no TrainingCheckpoint rows
// were ever materialised — fall back to the plan's
// `proposedCheckpointGroups[].atSec` values. These are the exact
// timestamps the worker aimed its CP generation at, so rendering them
// is NOT invention; they came from the plan the founder authorised.
//
// Returns the Client shape expected by `ManagerReviewClient`.
function resolveCheckpointMarkers(
  checkpoints: Array<{ id: string; label: string | null; atSecond: number }>,
  assessmentPlanJson: string | null,
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
  if (!assessmentPlanJson) return [];
  try {
    const plan = JSON.parse(assessmentPlanJson) as {
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
