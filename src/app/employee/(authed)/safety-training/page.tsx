// EP-UX-2 (2026-11-01) — Employee Safety & Training dashboard redesign.
//
// Replaces the HR-2C B3 stacked-list layout with the founder-approved
// composition (reference image at `docs/design/ep-ux-2/
// ep-ux-2-dashboard-reference.png`):
//
//   1. Hero          : hard-hat icon + "Safety & Training" + description
//   2. Summary cards : three horizontally-aligned cards
//                      (completion circle | upcoming deadlines | completed count)
//   3. Tabs          : My Training | Training History
//   4. My Training   : Required Training (banner when caught up) +
//                      Completed Training table
//   5. Training Hist : full completed-course history (same table)
//
// Data model (unchanged — EP-TRAIN-4E frozen):
//   - Single resolver call `resolveEmployeeSchedulingEligibility`
//     yields applicable + outstanding + per-course last attempt +
//     completedAt.
//   - Scores are fetched in a second query (one roundtrip for all
//     completed version ids) because the resolver's output does not
//     carry `TrainingCompletion.score`.
//   - Deadlines model does not exist on TrainingAssignment; the
//     "No upcoming deadlines" card renders a permanent neutral
//     state — accurate, not fabricated.

import { redirect } from "next/navigation";
import Link from "next/link";
import { getEmployeePortalPrincipal } from "@/lib/employee-portal-session";
import { resolveEmployeeSchedulingEligibility } from "@/lib/hr/training/applicability";
import { prisma } from "@/lib/prisma";
import TrainingTabs from "@/components/employee/safety-training/TrainingTabs";
import CircularProgress from "@/components/employee/safety-training/CircularProgress";
// EP-TRAIN-5C-3 (2026-11-02) -- obligation-aware overlay on the
// dashboard.  Reads OUTSTANDING TrainingObligation rows for the
// authenticated employee.  Pre-5C-4 production prisma has 0
// obligations so this query returns [] for every real employee.
import { resolveEmployeeTrainingCompliance } from "@/lib/hr/training/compliance-resolver";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Applicable = Awaited<
  ReturnType<typeof resolveEmployeeSchedulingEligibility>
>["applicable"][number];

function formatCompleted(d: Date | null | undefined): string {
  if (!d) return "";
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** EP-UX-2 — derive the human course-type label from the version's
 *  configured fields.  No new DB queries. */
function courseTypeLabel(a: Applicable): string {
  const hasVideo = typeof a.version.videoDurationSec === "number" && a.version.videoDurationSec > 0;
  const hasAssessment = a.version.requiresKnowledgeTest;
  if (hasVideo && hasAssessment) return "Video + Assessment";
  if (hasVideo) return "Video Only";
  if (hasAssessment) return "Assessment";
  return "Course";
}

export default async function EmployeePortalSafetyTrainingPage() {
  const principal = await getEmployeePortalPrincipal();
  if (!principal) redirect("/employee/login");

  // Resolver — ONE call, same contract as the HR-2C B3 layout.
  const eligibility = await resolveEmployeeSchedulingEligibility(principal.employeeId);
  // EP-TRAIN-5C-3 — obligation-aware per-course state overlay.  When
  // no OUTSTANDING obligations exist for this employee the resolver
  // reports every course as either INITIAL_REQUIRED / COMPLIANT /
  // NO_REQUIREMENT (byte-for-byte pre-5C-3 behavior).  When
  // obligations exist (from 5B workflows), UPDATED_REQUIRED /
  // RETAKE_REQUIRED / MULTIPLE_OUTSTANDING courses surface the new
  // labels + the dashboard metrics distinguish compliance from
  // historical completion.
  const compliance = await resolveEmployeeTrainingCompliance(principal.employeeId);
  const complianceByCourseId = new Map(compliance.courses.map((c) => [c.courseId, c]));
  const club = await prisma.club.findUnique({
    where: { id: principal.clubId },
    select: { name: true },
  });
  const clubName = club?.name ?? "Your Club";

  // Summary metrics — directive §4 Card 1.
  //
  // EP-TRAIN-5C-3 (2026-11-02) -- metric derivation now distinguishes
  // CURRENT COMPLIANCE from HISTORICAL COMPLETION.  A course with a
  // historical completion AND an OUTSTANDING obligation is NOT counted
  // as currently compliant (directive §4: "Do not count multiple
  // historical completions as multiple currently compliant courses"
  // / "Do not report 100% compliance while an outstanding retake
  // requirement exists").
  const requiredApplicable = eligibility.applicable.filter((a) => a.version.required);
  const assignedRequiredCount = requiredApplicable.length;
  // A course is "currently compliant" iff it has a completion AND no
  // OUTSTANDING obligation (compliance.courses[*].state === "COMPLIANT").
  const complianceStateByCourseId = new Map(compliance.courses.map((c) => [c.courseId, c.state]));
  const currentlyCompliantCount = requiredApplicable.filter((a) => {
    const state = complianceStateByCourseId.get(a.courseId);
    // Pre-5C-3 fallback: no entry in compliance (shouldn't happen since
    // the resolver covers every applicable course) treats .completed
    // as compliant.
    if (state === undefined) return a.completed;
    return state === "COMPLIANT";
  }).length;
  const completedRequiredCount = currentlyCompliantCount;
  // "Outstanding" = sum of actionable requirements per the obligation-
  // aware resolver, which includes INITIAL_REQUIRED / UPDATED_REQUIRED
  // / RETAKE_REQUIRED / IN_PROGRESS / MULTIPLE_OUTSTANDING.  For
  // courses the obligation-aware resolver doesn't touch (shouldn't
  // happen in practice), fall back to the pre-5C-3 outstandingTraining
  // count.
  const outstandingRequiredCount = requiredApplicable.filter((a) => {
    const state = complianceStateByCourseId.get(a.courseId);
    if (state === undefined) return !a.completed;
    return state === "INITIAL_REQUIRED"
      || state === "UPDATED_REQUIRED"
      || state === "RETAKE_REQUIRED"
      || state === "IN_PROGRESS"
      || state === "MULTIPLE_OUTSTANDING";
  }).length;
  const completedPercent = assignedRequiredCount === 0
    ? 0
    : Math.round((completedRequiredCount / assignedRequiredCount) * 100);
  const allCompleted = assignedRequiredCount > 0 && outstandingRequiredCount === 0;

  // Full completed list — includes optional + required completions,
  // ordered by completedAt DESC.
  const completed = eligibility.applicable
    .filter((a) => a.completed && a.completedAt)
    .sort((x, y) => (y.completedAt?.getTime() ?? 0) - (x.completedAt?.getTime() ?? 0));

  // Scores — single roundtrip for all completed versionIds.
  const completedVersionIds = completed.map((a) => a.version.id);
  const completionRows = completedVersionIds.length > 0
    ? await prisma.trainingCompletion.findMany({
        where: {
          employeeId: principal.employeeId,
          courseVersionId: { in: completedVersionIds },
        },
        select: { courseVersionId: true, score: true },
      })
    : [];
  const scoreByVersionId = new Map(completionRows.map((r) => [r.courseVersionId, r.score]));

  // Outstanding required courses — these drive the Required Training
  // section.
  //
  // EP-TRAIN-5C-3 — now includes courses that have a HISTORICAL
  // completion but an OUTSTANDING obligation (REVISION or
  // MANUAL_REINSTATE).  The per-course `obligationLabel` tells the
  // dashboard card which badge to render ("Updated Training Required"
  // / "Retake Required" / default "Required").
  const outstandingRequired = eligibility.applicable
    .filter((a) => {
      if (!a.version.required) return false;
      const state = complianceStateByCourseId.get(a.courseId);
      if (state === undefined) return !a.completed;
      return state === "INITIAL_REQUIRED"
        || state === "UPDATED_REQUIRED"
        || state === "RETAKE_REQUIRED"
        || state === "IN_PROGRESS"
        || state === "MULTIPLE_OUTSTANDING";
    })
    .sort((x, y) => x.title.localeCompare(y.title));
  // Per-course obligation annotation for the dashboard card renderer.
  const obligationStateByCourseId = new Map<string, {
    label: "Updated Training Required" | "Retake Required" | "Required" | "Initial Training Required" | "In Progress" | "Additional Retake Required";
    multiple: boolean;
  }>();
  for (const a of outstandingRequired) {
    const state = complianceStateByCourseId.get(a.courseId);
    const compliance = complianceByCourseId.get(a.courseId);
    const multiple = (compliance?.outstandingObligationCount ?? 0) > 1;
    if (state === "UPDATED_REQUIRED") {
      obligationStateByCourseId.set(a.courseId, { label: "Updated Training Required", multiple });
    } else if (state === "RETAKE_REQUIRED") {
      obligationStateByCourseId.set(a.courseId, { label: "Retake Required", multiple });
    } else if (state === "IN_PROGRESS") {
      obligationStateByCourseId.set(a.courseId, { label: "In Progress", multiple });
    } else if (state === "MULTIPLE_OUTSTANDING") {
      obligationStateByCourseId.set(a.courseId, { label: "Additional Retake Required", multiple: true });
    } else if (
      // EP-TRAIN-5C-4B-α (2026-11-02) -- distinguish a persisted
      // OUTSTANDING INITIAL obligation from an inferred INITIAL_REQUIRED
      // state (no obligation row).  The resolver already filters to
      // status=OUTSTANDING at the query level, and `activeObligation`
      // is only non-null when such a row exists; checking
      // reason==="INITIAL" guards against future state growth.
      compliance?.activeObligation != null
      && compliance.activeObligation.reason === "INITIAL"
    ) {
      obligationStateByCourseId.set(a.courseId, { label: "Initial Training Required", multiple });
    } else {
      obligationStateByCourseId.set(a.courseId, { label: "Required", multiple });
    }
  }

  const noAssignments = eligibility.applicable.length === 0;

  const completedRows = completed.map((a) => ({
    courseId: a.courseId,
    versionId: a.version.id,
    title: a.title,
    typeLabel: courseTypeLabel(a),
    score: scoreByVersionId.get(a.version.id) ?? null,
    completedAt: a.completedAt as Date,
  }));

  return (
    <div
      className="w-full px-6 md:px-8 py-6 md:py-8 max-w-[1360px]"
      data-testid="portal-safety-training"
    >
      {/* ------------------------------------------------------------
          §3 — Hero / page introduction */}
      <header className="mb-8" data-testid="portal-safety-training-hero">
        <h1 className="font-serif text-3xl md:text-4xl text-club-ink leading-tight flex items-center gap-3">
          <HardHatIcon className="text-club-green-800" />
          <span>Safety &amp; Training</span>
        </h1>
        <p className="mt-3 text-sm md:text-base text-stone-600 max-w-3xl">
          Complete your required training, keep your certifications current,
          and review your training history.
        </p>
      </header>

      {/* ------------------------------------------------------------
          §4 — Summary cards */}
      <section
        className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-10"
        data-testid="portal-safety-training-summary-cards"
      >
        {/* Card 1 — completion */}
        <article
          className={
            "rounded-xl border px-5 py-5 flex items-center gap-4 " +
            (noAssignments
              ? "border-stone-200 bg-white"
              : allCompleted
                ? "border-emerald-200 bg-emerald-50/60"
                : "border-stone-200 bg-white")
          }
          data-testid="portal-safety-training-card-completion"
        >
          <CircularProgress
            value={completedPercent}
            size={64}
            testId="portal-safety-training-card-completion-circle"
          />
          <div className="min-w-0">
            {noAssignments ? (
              <>
                <div className="text-sm font-semibold text-club-ink">No required training</div>
                <div className="mt-0.5 text-xs text-stone-500">
                  Nothing is currently assigned.
                </div>
              </>
            ) : (
              <>
                <div className="text-sm font-semibold text-club-ink">
                  {allCompleted ? "Training Complete" : "In Progress"}
                </div>
                <div className="mt-0.5 text-xs text-stone-500">
                  <span data-testid="portal-safety-training-card-completion-count">
                    {completedRequiredCount} of {assignedRequiredCount}
                  </span>{" "}
                  assigned {assignedRequiredCount === 1 ? "course" : "courses"}
                </div>
              </>
            )}
          </div>
        </article>

        {/* Card 2 — deadlines (TrainingAssignment has no due-date model;
            permanent neutral state per EP-UX-2 §4 directive). */}
        <article
          className="rounded-xl border border-stone-200 bg-white px-5 py-5 flex items-center gap-4"
          data-testid="portal-safety-training-card-deadlines"
        >
          <div className="h-12 w-12 rounded-full bg-stone-100 flex items-center justify-center text-stone-500 shrink-0">
            <CalendarIcon />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-club-ink">No upcoming deadlines</div>
            <div className="mt-0.5 text-xs text-stone-500">
              {outstandingRequiredCount === 0
                ? "All required training is complete."
                : "Keep your assigned training up to date to stay compliant."}
            </div>
          </div>
        </article>

        {/* Card 3 — completed count */}
        <article
          className="rounded-xl border border-stone-200 bg-white px-5 py-5 flex items-center gap-4"
          data-testid="portal-safety-training-card-completed"
        >
          <div className="h-12 w-12 rounded-full bg-club-green-50 flex items-center justify-center text-club-green-800 shrink-0">
            <RibbonIcon />
          </div>
          <div className="min-w-0">
            <div
              className="text-2xl font-semibold text-club-ink tabular-nums leading-tight"
              data-testid="portal-safety-training-card-completed-count"
            >
              {completed.length}
            </div>
            <div className="text-xs text-stone-500">Completed courses</div>
            <a
              href="#completed-training"
              className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-club-green-800 hover:text-club-green-900"
              data-testid="portal-safety-training-card-completed-link"
            >
              View training history →
            </a>
          </div>
        </article>
      </section>

      {/* ------------------------------------------------------------
          §5 — Tabs */}
      <TrainingTabs
        testIdPrefix="portal-safety-training-tabs"
        tabs={[
          {
            id: "my-training",
            label: "My Training",
            content: (
              <MyTrainingPanel
                clubName={clubName}
                outstandingCount={outstandingRequiredCount}
                outstandingRequired={outstandingRequired}
                obligationStateByCourseId={obligationStateByCourseId}
                completedRows={completedRows}
                noAssignments={noAssignments}
              />
            ),
          },
          {
            id: "training-history",
            label: "Training History",
            content: (
              <TrainingHistoryPanel
                completedRows={completedRows}
              />
            ),
          },
        ]}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

interface CompletedRow {
  courseId: string;
  versionId: string;
  title: string;
  typeLabel: string;
  score: number | null;
  completedAt: Date;
}

function MyTrainingPanel({
  clubName,
  outstandingCount,
  outstandingRequired,
  obligationStateByCourseId,
  completedRows,
  noAssignments,
}: {
  clubName: string;
  outstandingCount: number;
  outstandingRequired: Applicable[];
  // EP-TRAIN-5C-3 — per-course obligation annotation drives the badge
  // on each Required Training card.  Unmapped courses show no extra
  // badge (pre-5C-3 behavior).
  obligationStateByCourseId: Map<string, { label: string; multiple: boolean }>;
  completedRows: CompletedRow[];
  noAssignments: boolean;
}) {
  return (
    <div className="space-y-10">
      {/* §6 — Required Training section */}
      <section data-testid="portal-safety-training-required">
        <div className="flex items-baseline gap-3 flex-wrap">
          <h2 className="font-serif text-2xl text-club-ink">Required Training</h2>
          <span
            className={
              "inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold tabular-nums " +
              (outstandingCount === 0
                ? "bg-emerald-50 text-emerald-800 border border-emerald-200"
                : "bg-amber-50 text-amber-800 border border-amber-200")
            }
            data-testid="portal-safety-training-required-count"
          >
            {outstandingCount} remaining
          </span>
        </div>
        <p className="mt-2 text-sm text-stone-600 max-w-3xl">
          Training assigned to you by <span data-testid="portal-safety-training-required-clubname">{clubName}</span>.
          Keep these courses up to date to stay compliant.
        </p>

        <div className="mt-5">
          {noAssignments ? (
            <EmptyAssignments />
          ) : outstandingCount === 0 ? (
            <AllCaughtUpBanner />
          ) : (
            <ul className="space-y-3" data-testid="portal-safety-training-required-list">
              {outstandingRequired.map((a) => {
                const obState = obligationStateByCourseId.get(a.courseId);
                // "Required" is the default pre-5C-3 label; only
                // non-default obligation labels get rendered as a chip
                // so the dashboard visually matches EP-UX-2D for
                // pre-5C-3 employees (no OUTSTANDING obligations).
                const showObligationChip = obState && obState.label !== "Required";
                return (
                  <li key={a.courseId}>
                    <Link
                      href={`/employee/safety-training/${encodeURIComponent(a.version.id)}`}
                      className="group block rounded-lg border border-stone-200 bg-white px-5 py-4 hover:border-stone-300 hover:bg-stone-50 transition-colors"
                      data-testid={`portal-safety-training-course-${a.courseId}`}
                      data-obligation-label={obState?.label ?? "Required"}
                      data-obligation-multiple={obState?.multiple ? "true" : "false"}
                    >
                      <div className="flex items-baseline justify-between gap-4">
                        <div className="min-w-0">
                          <div className="font-semibold text-club-ink truncate">{a.title}</div>
                          <div className="mt-1 flex items-center gap-2 flex-wrap text-xs text-stone-500">
                            <span>
                              {courseTypeLabel(a)}
                              {a.version.videoDurationSec && a.version.videoDurationSec > 0 ? (
                                <> · {formatDurationShort(a.version.videoDurationSec)}</>
                              ) : null}
                            </span>
                            {showObligationChip && (
                              <span
                                className="inline-flex items-center rounded-full bg-amber-50 text-amber-800 border border-amber-200 px-2 py-0.5 text-[10px] font-semibold"
                                data-testid={`portal-safety-training-course-${a.courseId}-obligation-chip`}
                              >
                                {obState!.label}
                              </span>
                            )}
                            {obState?.multiple && (
                              <span
                                className="inline-flex items-center rounded-full bg-amber-50 text-amber-800 border border-amber-200 px-2 py-0.5 text-[10px] font-semibold"
                                data-testid={`portal-safety-training-course-${a.courseId}-multiple-chip`}
                              >
                                Multiple completions required
                              </span>
                            )}
                          </div>
                        </div>
                        <span className="shrink-0 inline-flex items-center rounded-md bg-club-green-800 text-white text-xs font-semibold px-3 py-1.5 group-hover:bg-club-green-900 transition-colors">
                          Start
                        </span>
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>

      {/* §7 — Completed Training */}
      <CompletedTrainingSection completedRows={completedRows} />
    </div>
  );
}

function TrainingHistoryPanel({ completedRows }: { completedRows: CompletedRow[] }) {
  return (
    <div className="space-y-10">
      <CompletedTrainingSection
        completedRows={completedRows}
        headingOverride="Training History"
        descriptionOverride="Every course you have ever completed, including historical versions."
      />
    </div>
  );
}

function CompletedTrainingSection({
  completedRows,
  headingOverride,
  descriptionOverride,
}: {
  completedRows: CompletedRow[];
  headingOverride?: string;
  descriptionOverride?: string;
}) {
  return (
    <section id="completed-training" data-testid="portal-safety-training-completed">
      <h2 className="font-serif text-2xl text-club-ink">{headingOverride ?? "Completed Training"}</h2>
      <p className="mt-2 text-sm text-stone-600 max-w-3xl">
        {descriptionOverride ?? "All training you’ve completed, with your scores and completion dates."}
      </p>

      {completedRows.length === 0 ? (
        <div className="mt-5 rounded-lg border border-dashed border-stone-300 bg-white px-6 py-10 text-center">
          <p className="text-sm text-stone-600">No completed training yet.</p>
        </div>
      ) : (
        <div className="mt-5 overflow-x-auto rounded-xl border border-stone-200 bg-white">
          <table className="w-full text-sm" data-testid="portal-safety-training-completed-table">
            <thead>
              <tr className="border-b border-stone-200 bg-stone-50/70 text-left">
                <th className="font-semibold text-stone-700 px-5 py-3">Course</th>
                <th className="font-semibold text-stone-700 px-5 py-3">Type</th>
                <th className="font-semibold text-stone-700 px-5 py-3">Score</th>
                <th className="font-semibold text-stone-700 px-5 py-3">Completed</th>
                <th className="font-semibold text-stone-700 px-5 py-3 text-right"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {completedRows.map((row) => (
                <tr key={row.versionId} data-testid={`portal-safety-training-completed-row-${row.courseId}`}>
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-3">
                      <CheckCircle className="shrink-0" />
                      <Link
                        href={`/employee/safety-training/${encodeURIComponent(row.versionId)}`}
                        className="font-semibold text-club-green-800 hover:text-club-green-900 truncate"
                      >
                        {row.title}
                      </Link>
                    </div>
                  </td>
                  <td className="px-5 py-3 text-stone-600">{row.typeLabel}</td>
                  <td className="px-5 py-3 text-stone-700 tabular-nums">
                    {row.score != null ? `${row.score}%` : "—"}
                  </td>
                  <td className="px-5 py-3 text-stone-600 tabular-nums">
                    {formatCompleted(row.completedAt)}
                  </td>
                  <td className="px-5 py-3 text-right">
                    <Link
                      href={`/employee/safety-training/${encodeURIComponent(row.versionId)}`}
                      className="inline-flex items-center rounded-md border border-stone-300 bg-white text-stone-700 text-xs font-semibold px-3 py-1.5 hover:bg-stone-50"
                    >
                      View
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Small presentational bits
// ---------------------------------------------------------------------------

function AllCaughtUpBanner() {
  return (
    <div
      className="flex items-center gap-4 rounded-xl border border-emerald-200 bg-emerald-50/60 px-5 py-5"
      data-testid="portal-safety-training-caught-up"
    >
      <div className="h-12 w-12 rounded-full bg-emerald-100 flex items-center justify-center text-emerald-800 shrink-0">
        <CheckIcon />
      </div>
      <div>
        <div className="font-semibold text-emerald-900">You’re all caught up!</div>
        <div className="text-sm text-emerald-800/90">All required training is complete. Great work.</div>
      </div>
    </div>
  );
}

function EmptyAssignments() {
  return (
    <div className="rounded-lg border border-dashed border-stone-300 bg-white px-6 py-10 text-center">
      <p className="text-sm text-stone-600">No training has been assigned to you yet.</p>
      <p className="mt-2 text-xs text-stone-500">
        When your Club assigns a course, it will appear here.
      </p>
    </div>
  );
}

function formatDurationShort(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  if (seconds < 60) return `${Math.round(seconds)} sec`;
  const m = Math.round(seconds / 60);
  return `${m} min`;
}

// ---------------------------------------------------------------------------
// Icons (inline SVG — no deps)
// ---------------------------------------------------------------------------

function HardHatIcon({ className = "" }: { className?: string }) {
  return (
    <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M3 16h18" />
      <path d="M4.5 16a7.5 7.5 0 0 1 15 0" />
      <path d="M10 8.5V6a2 2 0 0 1 4 0v2.5" />
      <path d="M3 16v2a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-2" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="17" rx="2" />
      <path d="M3 9h18" />
      <path d="M8 2v4M16 2v4" />
    </svg>
  );
}

function RibbonIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="9" r="6" />
      <path d="M8.5 14l-2 7 5.5-3 5.5 3-2-7" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12l5 5L20 7" />
    </svg>
  );
}

function CheckCircle({ className = "" }: { className?: string }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" fill="#059669" opacity="0.12" />
      <circle cx="12" cy="12" r="8" fill="#059669" />
      <path d="M8.5 12.5l2.5 2.5L15.5 10" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}
