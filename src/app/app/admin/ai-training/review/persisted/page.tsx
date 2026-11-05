// EP-TRAIN-6D-4D — Persisted-mode AI-training review page.
//
// Unlike `../page.tsx` (fixture preview), this page reads PERSISTED
// AI-review records via the tenant-scoped read service, and renders
// through `PersistedReviewWorkspace` which disables every mutation
// control by construction.
//
// Flow (all server-side):
//   1. Auth gate — `getCurrentPrincipal`; redirect to /login when
//      absent.
//   2. Active club resolution — delegated to the project's standard
//      `getActiveClubId` helper (host resolution + principal fallback).
//   3. Permission check — `hr:training:ai:read` on the active club.
//      A missing permission redirects to the fixture preview route so
//      Chrome's history doesn't leak "persisted mode exists".
//   4. Read-only service calls — queue + (optionally) detail.
//
// There are no mutations, no publish hooks, and no live-inference
// callers on this path. Query-parameters accepted:
//   ?candidate=<draftId>       — select a specific candidate
//   ?cursor=<draftId>          — paginate forwards
//   ?limit=<1..50>             — page size (default 20)
//   ?state=<LifecycleState>    — filter queue by state (repeatable)

import { redirect } from "next/navigation";
import type { ReactElement } from "react";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import {
  listCandidates,
  getCandidate,
  type LifecycleState,
  type CandidateQueueRow,
  type CandidateDetail,
} from "@/lib/hr/training/ai-review/read-service";
import {
  resolveCandidateEvidence,
  type CandidateEvidence,
} from "@/lib/hr/training/ai-review/evidence-reader";
import {
  resolveVerifiedAnswer,
  type VerifiedAnswerResolution,
} from "@/lib/hr/training/ai-review/verified-answer-reader";
import PersistedReviewWorkspace from "@/components/ai-training/PersistedReviewWorkspace";

export const metadata = {
  title: "AI-assisted training · persisted review",
};

const ALLOWED_STATES = new Set<LifecycleState>([
  "GENERATED",
  "VALIDATION_PENDING",
  "REQUIRES_HUMAN_REVIEW",
  "APPROVED_DRAFT",
  "REJECTED",
  "EDITED_VALIDATION_STALE",
  "VALIDATION_FAILED",
  "ARCHIVED",
]);

function parseLimit(raw: string | string[] | undefined): number | undefined {
  if (!raw || Array.isArray(raw)) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 50) return undefined;
  return n;
}

function parseStates(
  raw: string | string[] | undefined,
): LifecycleState[] | undefined {
  if (!raw) return undefined;
  const parts = (Array.isArray(raw) ? raw : [raw])
    .flatMap((s) => s.split(",").map((t) => t.trim()).filter(Boolean));
  const filtered: LifecycleState[] = [];
  for (const p of parts) {
    if (ALLOWED_STATES.has(p as LifecycleState)) filtered.push(p as LifecycleState);
  }
  return filtered.length > 0 ? filtered : undefined;
}

function firstString(v: string | string[] | undefined): string | undefined {
  if (!v) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

interface PageProps {
  readonly searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

export default async function PersistedAiTrainingReviewPage(
  props: PageProps,
): Promise<ReactElement> {
  // Next 15 async-searchParams signature — guard for undefined.
  const search = (await props.searchParams) ?? {};

  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");

  const clubId = await getActiveClubId({
    clubId: principal.activeClubId ?? null,
    role: "",
    id: principal.id,
  });

  if (!hasPermission(principal, clubId, "hr:training:ai:read")) {
    // Deny shape: redirect to the fixture route so we don't advertise
    // the persisted surface's existence to probes.
    redirect("/app/admin/ai-training/review");
  }

  // Club label — Spectre's Club schema stores `wordmark` (optional
  // whitelabel display name) + `name` (fallback). A defensive fallback
  // keeps the UI readable even if the row is unexpectedly missing.
  const club = await prisma.club.findUnique({
    where: { id: clubId },
    select: { name: true, wordmark: true },
  });
  const clubLabel: string =
    (club?.wordmark ?? null) ?? club?.name ?? "This club";

  const cursor = firstString(search.cursor) ?? undefined;
  const limit = parseLimit(search.limit);
  const states = parseStates(search.state ?? search.states);
  const candidateParam = firstString(search.candidate);

  const queuePage = await listCandidates(principal, clubId, {
    cursor,
    limit,
    states,
  });

  // If no explicit candidate requested, auto-select the first queue row
  // so the user lands on the detail pane straight away.
  const selectedDraftId =
    candidateParam ?? (queuePage.rows[0]?.draftId ?? null);

  let selectedDetail: CandidateDetail | null = null;
  if (selectedDraftId) {
    selectedDetail = await getCandidate(principal, clubId, selectedDraftId);
    // When the explicit candidate param points at a row this tenant
    // cannot see (cross-tenant or stale link), fall back silently to
    // the top of the queue instead of 404-ing the whole page.
    if (!selectedDetail && queuePage.rows[0]) {
      selectedDetail = await getCandidate(
        principal,
        clubId,
        queuePage.rows[0].draftId,
      );
    }
  }

  const queue: readonly CandidateQueueRow[] = queuePage.rows;

  // EP-TRAIN-6D-4M (2026-11-05) — authenticated evidence resolution.
  //
  // `resolveCandidateEvidence` composes the 4K schema + 4L ingest helpers:
  //   - For drafts with a non-null groundingProjectionId, it reconciles
  //     the stored projection hash against the draft's scalar hash AND
  //     a server-recomputed canonical hash, resolves every cited
  //     segment to authoritative persisted transcript text + timestamps
  //     (or surfaces per-segment "unavailable" reasons), and reports
  //     whether click-to-seek is enabled.
  //   - For historical 6D-4H candidates (null FK), it returns a
  //     dedicated `historical-unavailable` payload — the UI renders the
  //     accepted "Historical evidence unavailable" treatment without
  //     fabricating segment bodies.
  //   - For integrity failures (hash mismatch, missing build,
  //     unresolvable citations), it returns a dedicated `evidence-
  //     integrity-failure` payload — the UI surfaces a safe diagnostic
  //     and withholds authoritative evidence.
  //
  // The reader is tenant-scoped at every lookup; cross-tenant drafts
  // resolve as null and are mapped to a 404 same-shape downstream.
  //
  // The legacy `sourceContext` prop is still passed (derived from the
  // evidence payload's `sourceMaterial` summary) so the workspace's
  // existing props contract remains unchanged for callers that don't
  // yet consume `evidence`.
  let evidence: CandidateEvidence | null = null;
  let verifiedAnswer: VerifiedAnswerResolution | null = null;
  if (selectedDetail) {
    [evidence, verifiedAnswer] = await Promise.all([
      resolveCandidateEvidence(principal, clubId, selectedDetail.draftId),
      resolveVerifiedAnswer(principal, clubId, selectedDetail.draftId),
    ]);
  }
  const sourceContext = evidence
    ? {
        courseTitle: evidence.sourceMaterial.courseTitle,
        versionTitle: evidence.sourceMaterial.versionTitle,
        versionNumber: evidence.sourceMaterial.versionNumber,
        videoStorageKeyPresent: evidence.sourceMaterial.videoStorageKeyPresent,
        videoDurationSec: evidence.sourceMaterial.videoDurationSec,
      }
    : null;

  return (
    <PersistedReviewWorkspace
      queue={queue}
      selectedDetail={selectedDetail}
      selectedDraftId={selectedDetail?.draftId ?? null}
      clubLabel={clubLabel}
      totalCount={queue.length}
      nextCursor={queuePage.nextCursor}
      isEmptyQueue={queue.length === 0}
      sourceContext={sourceContext}
      evidence={evidence}
      verifiedAnswer={verifiedAnswer}
    />
  );
}
