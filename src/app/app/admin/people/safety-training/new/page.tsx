// EP-TRAIN-4Y-S §2 — course-format selection.
//
// Previously a single-form create-course screen. The founder directive
// asks for a guided workflow: manager picks "With video" (upload +
// auto-AI preparation) or "Without video" (manual authoring). The
// existing form fields + logic now live under each format's own route
// so the format choice is the first decision the manager makes.

import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function NewCourseFormatSelection() {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });
  if (!hasPermission(principal, clubId, "hr:training:write")) {
    redirect("/app/admin/people/safety-training");
  }

  return (
    <div className="max-w-[920px]">
      <Link
        href="/app/admin/people/safety-training"
        className="text-sm text-stone-500 hover:text-club-ink"
      >
        ← Safety &amp; Training
      </Link>

      <div className="mt-3 mb-8">
        <h1 className="page-title">Create course</h1>
        <p className="mt-1 text-sm text-stone-500">
          Choose how you&apos;d like to build this training course.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Link
          href="/app/admin/people/safety-training/new/with-video"
          className="card card-body flex flex-col gap-3 hover:border-club-green hover:shadow-sm transition-all group"
          data-testid="training-new-format-with-video"
        >
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-full bg-club-green/10 text-club-green flex items-center justify-center font-semibold group-hover:bg-club-green/20">
              {/* play icon */}
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="6 3 20 12 6 21 6 3" /></svg>
            </div>
            <h2 className="section-title text-lg">With video</h2>
          </div>
          <p className="text-sm text-stone-600">
            Upload a training video and let Spectre prepare the course
            for you &mdash; transcription, learning objectives, knowledge
            checks, and a final assessment.
          </p>
          <p className="text-xs text-stone-500 mt-auto">
            You&apos;ll review every AI-generated question before publishing.
          </p>
        </Link>

        <Link
          href="/app/admin/people/safety-training/new/without-video"
          className="card card-body flex flex-col gap-3 hover:border-club-green hover:shadow-sm transition-all group"
          data-testid="training-new-format-without-video"
        >
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-full bg-stone-100 text-stone-600 flex items-center justify-center font-semibold group-hover:bg-stone-200">
              {/* pencil icon */}
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
            </div>
            <h2 className="section-title text-lg">Without video</h2>
          </div>
          <p className="text-sm text-stone-600">
            Create a training course manually. Write your own questions,
            configure the final assessment, and publish &mdash; no video
            required.
          </p>
          <p className="text-xs text-stone-500 mt-auto">
            Useful for policy acknowledgements and knowledge-based courses.
          </p>
        </Link>
      </div>
    </div>
  );
}
