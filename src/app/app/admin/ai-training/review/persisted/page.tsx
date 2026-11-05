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

  // EP-TRAIN-6D-4I — enrich the selected detail with the reviewer-facing
  // course + version context. These are the authoritative fields on the
  // TrainingCourseVersion / TrainingCourse rows — they are NOT derived,
  // guessed, or invented, and they come through the same tenant-scoped
  // Prisma client the rest of this page uses. If the lookup misses, the
  // workspace falls back to "unavailable" labels on the client.
  let sourceContext: {
    courseTitle: string | null;
    versionTitle: string | null;
    versionNumber: number | null;
    videoStorageKeyPresent: boolean;
    videoDurationSec: number | null;
  } | null = null;

  if (selectedDetail) {
    const version = await prisma.trainingCourseVersion.findUnique({
      where: { id: selectedDetail.courseVersionId },
      select: {
        title: true,
        version: true,
        videoStorageKey: true,
        videoDurationSec: true,
        course: { select: { title: true, clubId: true } },
      },
    });
    // Tenant assertion — a version resolved for a candidate the tenant
    // can see must itself belong to the tenant. Belt-and-braces guard
    // against a mis-joined row.
    if (version && version.course?.clubId === clubId) {
      sourceContext = {
        courseTitle: version.course?.title ?? null,
        versionTitle: version.title ?? null,
        versionNumber: version.version ?? null,
        videoStorageKeyPresent: Boolean(version.videoStorageKey),
        videoDurationSec: version.videoDurationSec ?? null,
      };
    }
  }

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
    />
  );
}
