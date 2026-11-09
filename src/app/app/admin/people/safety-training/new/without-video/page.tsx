// EP-TRAIN-4Y-S §13 — Without-video manual course creation.
//
// Lifts the pre-4Y-S single-form create-course flow onto the
// "Without video" branch of the new format-selection landing. Same
// identity + compliance + applicability form; same `createCourseAction`
// server action; routes to the existing version editor on success.
// No Whisper / Qwen / transcription / grounding projection code paths
// are reached from this branch.

import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { TRAINING_COURSE_CATEGORIES } from "@/lib/hr/training/courses";
import { createCourseAction } from "../../_actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function NewSafetyTrainingCourseWithoutVideo({
  searchParams,
}: {
  searchParams: Promise<{ err?: string }>;
}) {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });
  if (!hasPermission(principal, clubId, "hr:training:write")) {
    redirect("/app/admin/people/safety-training");
  }
  const { err } = await searchParams;
  const action = createCourseAction.bind(null, clubId);

  return (
    <div className="max-w-[720px]">
      <Link
        href="/app/admin/people/safety-training/new"
        className="text-sm text-stone-500 hover:text-club-ink"
      >
        ← Choose format
      </Link>
      <div className="mt-3 mb-6">
        <h1 className="page-title">New course &mdash; without video</h1>
        <p className="mt-1 text-sm text-stone-500">
          Create the course identity, then add knowledge-check questions
          and a final assessment on the next screen. No video is required.
        </p>
      </div>

      {err && (
        <div
          role="alert"
          className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {err}
        </div>
      )}

      <form action={action} className="space-y-6">
        <section className="card card-body space-y-4">
          <h2 className="section-title text-lg">Identity</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="label" htmlFor="code">Course code</label>
              <input
                id="code"
                name="code"
                className="input font-mono"
                required
                maxLength={64}
                placeholder="WORKPLACE_SAFETY_2026"
                data-testid="training-new-code"
              />
              <p className="mt-1 text-xs text-stone-500">
                2-64 uppercase letters, numbers, underscore, or dash.
              </p>
            </div>
            <div>
              <label className="label" htmlFor="category">Category</label>
              <select
                id="category"
                name="category"
                className="select"
                required
                data-testid="training-new-category"
              >
                {TRAINING_COURSE_CATEGORIES.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="label" htmlFor="title">Course title</label>
            <input
              id="title"
              name="title"
              className="input"
              required
              maxLength={200}
              placeholder="Workplace Safety Orientation"
              data-testid="training-new-title"
            />
          </div>
          <div>
            <label className="label" htmlFor="description">Description (optional)</label>
            <textarea
              id="description"
              name="description"
              className="input"
              rows={3}
              maxLength={500}
              placeholder="What this course covers and why it matters."
            />
          </div>
        </section>

        <p className="text-xs text-stone-500 -mt-2">
          Compliance and audience settings are configured later, on the
          Training Requirements step &mdash; immediately before Publish.
        </p>

        <div className="flex items-center justify-end gap-3">
          <Link
            href="/app/admin/people/safety-training/new"
            className="text-sm text-stone-500 hover:text-club-ink"
          >
            Cancel
          </Link>
          <button type="submit" className="btn btn-primary" data-testid="training-new-submit">
            Create draft
          </button>
        </div>
      </form>
    </div>
  );
}
