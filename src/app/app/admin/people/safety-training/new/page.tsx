// HR-2C B2 (2026-08-20) — Create Safety & Training course.
//
// Small first-pass form: the admin fills identity (code / title /
// category / description) + a first-pass required/applicability
// choice, then submit creates a DRAFT v1 and routes to the version
// editor for content authoring (video + quiz).

import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { TRAINING_COURSE_CATEGORIES } from "@/lib/hr/training/courses";
import { createCourseAction } from "../_actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function NewSafetyTrainingCourse({
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
      <Link href="/app/admin/people/safety-training" className="text-sm text-stone-500 hover:text-club-ink">
        ← Safety &amp; Training
      </Link>
      <div className="mt-3 mb-6">
        <h1 className="page-title">Create course</h1>
        <p className="mt-1 text-sm text-stone-500">
          The course starts as a draft. Upload the training video and add
          knowledge-test questions on the next screen, then publish when ready.
        </p>
      </div>

      {err && (
        <div role="alert" className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
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
                2-64 uppercase letters, numbers, underscore, or dash. Machine-safe identifier; use one per topic.
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

        <section className="card card-body space-y-4">
          <h2 className="section-title text-lg">Compliance</h2>
          <div className="flex items-start gap-3">
            <input type="checkbox" name="required" defaultChecked id="required" className="mt-1" data-testid="training-new-required" />
            <label htmlFor="required" className="text-sm text-stone-800">
              <span className="font-medium">Required for scheduling</span>
              <span className="block text-xs text-stone-500 mt-0.5">
                Employees cannot submit availability or be scheduled until they complete required courses. Uncheck for optional courses.
              </span>
            </label>
          </div>
        </section>

        <section className="card card-body space-y-4">
          <h2 className="section-title text-lg">Who needs to complete this?</h2>
          <p className="text-xs text-stone-500">You can refine department and position selectors after the course is created.</p>
          <div className="space-y-2">
            <label className="flex items-start gap-3">
              <input type="radio" name="applicabilityMode" value="everyone" defaultChecked className="mt-1" data-testid="training-new-applicability-everyone" />
              <span>
                <span className="text-sm text-club-ink font-medium">Everyone</span>
                <span className="block text-xs text-stone-500">Every active employee at the Club is required to complete this.</span>
              </span>
            </label>
            <label className="flex items-start gap-3">
              <input type="radio" name="applicabilityMode" value="scoped" className="mt-1" data-testid="training-new-applicability-scoped" />
              <span>
                <span className="text-sm text-club-ink font-medium">Specific departments or positions</span>
                <span className="block text-xs text-stone-500">Choose department(s) or position(s) after creating the draft.</span>
              </span>
            </label>
            <label className="flex items-start gap-3">
              <input type="radio" name="applicabilityMode" value="explicit" className="mt-1" data-testid="training-new-applicability-explicit" />
              <span>
                <span className="text-sm text-club-ink font-medium">Assign individually</span>
                <span className="block text-xs text-stone-500">The course only applies to employees you explicitly assign — useful for remedial or role-specific training.</span>
              </span>
            </label>
          </div>
        </section>

        <div className="flex items-center justify-end gap-3">
          <Link href="/app/admin/people/safety-training" className="text-sm text-stone-500 hover:text-club-ink">
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
