// HR-2C B5 (2026-08-28) — Employee Profile Training tab body.
//
// Server component. Renders a person-level compliance record: scheduling
// eligibility line, current requirements (with completion status +
// source), and training history (all completions, including for retired
// or no-longer-applicable versions).
//
// The Assign-training action is factored into a small client component
// (`AssignTrainingButton`) so this file stays server-rendered and never
// leaks Prisma or principal into the client bundle.
//
// Design discipline (§39): flat, dense, restrained; no giant training
// cards; matches the existing spectre-person-section grammar.

import type { EmployeeTrainingRecord } from "@/lib/hr/training/compliance";
import AssignTrainingButton from "./AssignTrainingButton";

interface Props {
  record: EmployeeTrainingRecord;
  employeeId: string;
  canAssign: boolean;
  /** Published courses in the current Club — powers the Assign
   *  dropdown. Passed from the server page (single canonical read
   *  through listClubCourses). */
  publishableCourses: Array<{ id: string; code: string; title: string }>;
  assignAction: (input: { courseId: string; note?: string | null }) => Promise<
    { ok: true; alreadyAssigned: boolean } | { ok: false; error: string }
  >;
}

function formatDate(d: Date | null): string {
  if (!d) return "—";
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function statusLabel(s: string): { label: string; tone: "emerald" | "amber" | "stone" | "red" } {
  switch (s) {
    case "completed": return { label: "Completed", tone: "emerald" };
    case "not_started": return { label: "Not started", tone: "amber" };
    case "in_progress": return { label: "In progress", tone: "stone" };
    case "attempted_failed": return { label: "Attempted · not passed", tone: "amber" };
    default: return { label: s, tone: "stone" };
  }
}

function Pill({ label, tone }: { label: string; tone: "emerald" | "amber" | "stone" | "red" }) {
  const cls =
    tone === "emerald" ? "bg-emerald-50 text-emerald-800 border-emerald-200"
      : tone === "amber" ? "bg-amber-50 text-amber-800 border-amber-200"
      : tone === "red" ? "bg-red-50 text-red-700 border-red-200"
      : "bg-stone-50 text-stone-700 border-stone-200";
  return <span className={"inline-block rounded border px-2 py-0.5 text-[11px] " + cls}>{label}</span>;
}

export default function EmployeeTrainingSection({
  record, employeeId, canAssign, publishableCourses, assignAction,
}: Props) {
  const { eligibility, current, history, explicitAssignments } = record;
  const explicitByCourseId = new Set(explicitAssignments.map((a) => a.courseId));
  const outstandingRequired = current.filter((c) => c.required && !c.completed).length;

  return (
    <div data-testid="employee-training-section">
      <h2 className="spectre-person-section-title">Training</h2>

      {/* Scheduling eligibility — canonical derived state, not editable. */}
      <div className="spectre-person-section" data-testid="training-eligibility">
        <div className="spectre-person-section-head">
          <h3 className="spectre-person-eyebrow">Scheduling eligibility</h3>
        </div>
        {eligibility.eligible ? (
          <p className="text-sm text-emerald-800" data-testid="training-eligibility-eligible">
            Eligible
          </p>
        ) : (
          <p className="text-sm text-amber-800" data-testid="training-eligibility-not-eligible">
            Not eligible · {outstandingRequired} required course
            {outstandingRequired === 1 ? "" : "s"} outstanding
          </p>
        )}
      </div>

      {/* Current requirements */}
      <div className="spectre-person-section mt-6" data-testid="training-current">
        <div className="spectre-person-section-head flex items-center justify-between">
          <h3 className="spectre-person-eyebrow">Current requirements</h3>
          {canAssign && (
            <AssignTrainingButton
              employeeId={employeeId}
              courses={publishableCourses}
              alreadyAssignedCourseIds={[...explicitByCourseId]}
              action={assignAction}
            />
          )}
        </div>
        {current.length === 0 ? (
          <p
            className="text-sm text-stone-500"
            data-testid="training-current-empty"
          >
            No training requirements currently apply to this employee.
          </p>
        ) : (
          <ul className="mt-1 space-y-3" data-testid="training-current-list">
            {current.map((c) => {
              const s = statusLabel(c.status);
              const isExplicit = explicitByCourseId.has(c.courseId);
              return (
                <li
                  key={c.courseVersionId}
                  className="border-b border-stone-100 pb-3 last:border-b-0 last:pb-0"
                  data-testid={`training-current-${c.code}`}
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-club-ink truncate">
                        {c.title}
                      </div>
                      <div className="mt-0.5 text-xs text-stone-500 font-mono">{c.code}</div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Pill label={c.required ? "Required" : "Optional"} tone={c.required ? "stone" : "stone"} />
                      <Pill label={s.label} tone={s.tone} />
                    </div>
                  </div>
                  <div className="mt-1 text-xs text-stone-500">
                    {c.sourceLabel}
                    {isExplicit && c.source !== "assigned" && " · Individually assigned"}
                  </div>
                  {c.completed && (
                    <div className="mt-1 text-xs text-emerald-800">
                      Completed {formatDate(c.completedAt)}
                      {typeof c.score === "number" && <> · Score {c.score}%</>}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Training history */}
      <div className="spectre-person-section mt-6" data-testid="training-history">
        <div className="spectre-person-section-head">
          <h3 className="spectre-person-eyebrow">Training history</h3>
        </div>
        {history.length === 0 ? (
          <p className="text-sm text-stone-500" data-testid="training-history-empty">
            No completed training on record yet.
          </p>
        ) : (
          <table className="table-base">
            <thead>
              <tr>
                <th>Course</th>
                <th>Version</th>
                <th>Completed</th>
                <th className="text-right">Score</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={`${h.courseVersionId}::${h.completedAt.toISOString()}`}>
                  <td>
                    <div className="text-sm text-club-ink">{h.title}</div>
                    <div className="text-xs text-stone-500 font-mono">{h.code}</div>
                  </td>
                  <td className="text-xs text-stone-600">v{h.version}</td>
                  <td className="text-xs text-stone-600">{formatDate(h.completedAt)}</td>
                  <td className="text-xs text-right">{h.score}%</td>
                  <td className="text-xs">
                    {h.courseRetired && <Pill label="Retired" tone="stone" />}
                    {!h.courseRetired && h.isCurrentVersion === false && (
                      <span className="text-stone-500">Superseded by newer version</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
