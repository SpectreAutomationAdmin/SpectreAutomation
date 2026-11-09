// EP-TRAIN-4Y-T §2+§3 — Upload-first with-video entry.
//
// Previously (4Y-S) this was an identity form requiring code/title/
// description/compliance/audience before upload. The 4Y-T founder
// directive removes that upfront burden: the manager picks "With
// video" and immediately lands on a prominent upload area.
//
// Behaviour:
//   - If this user has a RECENT (<60 min) provisional draft on the
//     active club with no video yet, RESUME it by redirecting to its
//     upload screen. Durable across refresh / navigate-away / return.
//   - Otherwise, create a new provisional draft with a placeholder
//     title + an auto-generated code (collision-safe via cuid), and
//     redirect to its upload screen. The real course code + title
//     will be derived from the transcript during AI preparation
//     (§5) and finalised on first manager edit — the provisional
//     identifiers are never surfaced as the course title (§3).
//
// Guards: `hr:training:write`. Same tenant scope as `createCourse`.
// Auto-provisioning never writes anything the manager can't revert
// by returning to the dashboard (the draft remains DRAFT until
// explicit publish).

import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { createCourse } from "@/lib/hr/training/courses";
import { randomBytes } from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RESUME_WINDOW_MS = 60 * 60 * 1000; // 60 min
const PROVISIONAL_CODE_PREFIX = "AUTO-DRAFT";
const PROVISIONAL_TITLE = "Untitled training course";

export default async function NewWithVideoEntry() {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });
  if (!hasPermission(principal, clubId, "hr:training:write")) {
    redirect("/app/admin/people/safety-training");
  }

  const resumeCutoff = new Date(Date.now() - RESUME_WINDOW_MS);
  // Look for a provisional-draft on this club created by this user
  // within the resume window, still a DRAFT version with no video,
  // and recognisable by the AUTO-DRAFT code prefix.
  const existing = await prisma.trainingCourse.findFirst({
    where: {
      clubId,
      createdByUserId: principal.id,
      code: { startsWith: PROVISIONAL_CODE_PREFIX },
      createdAt: { gte: resumeCutoff },
      versions: {
        some: {
          state: "DRAFT",
          version: 1,
          videoSha256: null,
        },
      },
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      versions: {
        where: { state: "DRAFT", version: 1 },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { id: true },
      },
    },
  });

  if (existing && existing.versions[0]) {
    // §3 "Preserve upload and preparation state across refresh/navigation."
    redirect(
      `/app/admin/people/safety-training/${existing.id}/${existing.versions[0].id}/upload`,
    );
  }

  // Create a fresh provisional draft. The code is a URL-safe cuid-
  // derived slug; the title is a known placeholder the Manager Review
  // surface will replace with the AI-generated title (§5). Category
  // defaults to the first allowed category — overridable on review.
  const provisionalCode = `${PROVISIONAL_CODE_PREFIX}-${randomBytes(6).toString("hex").toUpperCase()}`;
  const created = await createCourse(principal, clubId, {
    code: provisionalCode,
    title: PROVISIONAL_TITLE,
    category: "Safety",
    description: null,
  });
  redirect(
    `/app/admin/people/safety-training/${created.courseId}/${created.versionId}/upload`,
  );
}
