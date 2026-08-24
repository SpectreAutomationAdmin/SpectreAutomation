// HR-2C B5 (2026-08-28) — People → Safety & Training → Compliance.
//
// Employee-centric Training compliance dashboard for Club administrators.
// Reads ONLY through the canonical `getClubTrainingCompliance` service —
// no direct Prisma queries here. Every action link drills through to the
// canonical Employee Profile → Training tab (no duplicate person-level
// compliance page).
//
// Permission: `hr:training:compliance:read`.

import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { getClubTrainingCompliance, type ComplianceStatus } from "@/lib/hr/training/compliance";
import { listClubCourses } from "@/lib/hr/training/courses";
import { prisma } from "@/lib/prisma";
import SafetyTrainingTabs from "../_SafetyTrainingTabs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RawSearch {
  status?: string;
  departmentId?: string;
  courseId?: string;
  q?: string;
}

function parseStatus(raw?: string): ComplianceStatus | "all" {
  switch (raw) {
    case "up_to_date":
    case "training_required":
    case "in_progress":
    case "no_requirements":
      return raw;
    default:
      return "all";
  }
}

export default async function ComplianceDashboardPage({
  searchParams,
}: {
  searchParams: Promise<RawSearch>;
}) {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });
  if (!hasPermission(principal, clubId, "hr:training:compliance:read")) {
    redirect("/app/admin/people/safety-training");
  }
  const canReadCompliance = true;

  const sp = await searchParams;
  const status = parseStatus(sp.status);
  const departmentId = sp.departmentId?.trim() || undefined;
  const courseId = sp.courseId?.trim() || undefined;
  const query = sp.q?.trim() || undefined;

  const [{ rows, summary, filteredCount }, courses, departments] = await Promise.all([
    getClubTrainingCompliance(principal, clubId, { status, departmentId, courseId, query }),
    listClubCourses(principal, clubId),
    prisma.department.findMany({
      where: { clubId },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
  ]);

  const publishedCourses = courses.filter((c) => c.currentVersion && !c.retiredAt);

  return (
    <div>
      <Link href="/app/admin/people/employees" className="text-sm text-stone-500 hover:text-club-ink">
        ← People
      </Link>
      <div className="mt-3 mb-6 flex items-baseline justify-between gap-4">
        <div>
          <h1 className="page-title">Safety &amp; Training</h1>
          <p className="mt-1 text-sm text-stone-500 max-w-xl">
            Who is up to date, and who has required training outstanding.
          </p>
        </div>
      </div>

      <SafetyTrainingTabs canReadCompliance={canReadCompliance} />

      {/* Summary line — restrained; no BI dashboard, no giant KPI tiles. */}
      <p className="mb-4 text-sm text-stone-600" data-testid="compliance-summary">
        <span className="font-medium text-club-ink">{summary.activeEmployeeCount}</span>
        {" active employees · "}
        <span className="font-medium text-emerald-800">{summary.upToDateCount}</span>
        {" up to date · "}
        <span className="font-medium text-amber-800">{summary.trainingRequiredCount}</span>
        {" require training · "}
        <span className="text-stone-500">{summary.publishedCourseCount} published courses</span>
      </p>

      {/* Filters */}
      <form
        method="get"
        className="mb-4 flex flex-wrap items-end gap-3 rounded border border-stone-200 bg-white px-4 py-3"
        data-testid="compliance-filters"
      >
        <label className="text-xs text-stone-500">
          Status
          <select
            name="status"
            defaultValue={status}
            className="input mt-1"
            data-testid="compliance-filter-status"
          >
            <option value="all">All</option>
            <option value="up_to_date">Up to date</option>
            <option value="training_required">Training required</option>
            <option value="in_progress">In progress</option>
          </select>
        </label>
        <label className="text-xs text-stone-500">
          Department
          <select
            name="departmentId"
            defaultValue={departmentId ?? ""}
            className="input mt-1"
            data-testid="compliance-filter-department"
          >
            <option value="">All departments</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </label>
        <label className="text-xs text-stone-500">
          Course
          <select
            name="courseId"
            defaultValue={courseId ?? ""}
            className="input mt-1"
            data-testid="compliance-filter-course"
          >
            <option value="">All courses</option>
            {publishedCourses.map((c) => (
              <option key={c.id} value={c.id}>{c.title}</option>
            ))}
          </select>
        </label>
        <label className="text-xs text-stone-500 grow max-w-xs">
          Search
          <input
            type="search"
            name="q"
            defaultValue={query ?? ""}
            placeholder="Name or employee #"
            className="input mt-1 w-full"
            data-testid="compliance-filter-query"
          />
        </label>
        <button type="submit" className="btn btn-secondary btn-sm" data-testid="compliance-apply-filters">
          Apply
        </button>
        <Link
          href="/app/admin/people/safety-training/compliance"
          className="text-xs text-stone-500 underline underline-offset-4"
        >
          Reset
        </Link>
      </form>

      {/* Roll-up table */}
      {rows.length === 0 ? (
        <div className="rounded-md border border-dashed border-stone-300 bg-white px-6 py-10 text-center" data-testid="compliance-empty">
          {summary.publishedCourseCount === 0 ? (
            <>
              <p className="text-sm text-stone-600">No published training courses yet.</p>
              <p className="mt-2 text-xs text-stone-500">
                Publish a course from the Courses tab to begin tracking compliance.
              </p>
            </>
          ) : summary.activeEmployeeCount === 0 ? (
            <p className="text-sm text-stone-600">No active employees.</p>
          ) : filteredCount === 0 ? (
            <p className="text-sm text-stone-600">No employees match these filters.</p>
          ) : (
            <p className="text-sm text-stone-600">No employees currently require training.</p>
          )}
        </div>
      ) : (
        <table className="table-base w-full" data-testid="compliance-table">
          <thead>
            <tr>
              <th className="text-left">Employee</th>
              <th className="text-left">Department</th>
              <th className="text-right">Required</th>
              <th className="text-right">Completed</th>
              <th className="text-right">Outstanding</th>
              <th className="text-left">Status</th>
              <th className="text-left">Scheduling</th>
              <th className="text-left"> </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const displayName = r.preferredName?.trim()
                ? `${r.preferredName} ${r.lastName}`
                : `${r.firstName} ${r.lastName}`;
              const statusLabel = statusToLabel(r.status);
              const eligibleLabel = r.eligible ? "Eligible" : "Not eligible";
              return (
                <tr key={r.employeeId} data-testid={`compliance-row-${r.employeeNumber}`}>
                  <td>
                    <Link
                      href={`/app/admin/people/employees/${r.employeeId}?tab=training`}
                      className="text-club-ink hover:underline font-medium"
                      data-testid={`compliance-employee-link-${r.employeeNumber}`}
                    >
                      {displayName}
                    </Link>
                    <div className="text-xs text-stone-400 font-mono">{r.employeeNumber}</div>
                  </td>
                  <td className="text-sm text-stone-600">
                    {r.primaryDepartmentName ?? "—"}
                  </td>
                  <td className="text-right text-sm">{r.requiredCount}</td>
                  <td className="text-right text-sm">{r.completedCount}</td>
                  <td className="text-right text-sm font-medium">
                    {r.outstandingCount > 0 ? (
                      <span className="text-amber-800">{r.outstandingCount}</span>
                    ) : (
                      <span className="text-stone-400">0</span>
                    )}
                  </td>
                  <td>
                    <StatusPill status={r.status} label={statusLabel} />
                  </td>
                  <td>
                    <span
                      className={
                        "text-xs " +
                        (r.eligible ? "text-emerald-800" : "text-amber-800")
                      }
                      data-testid={`compliance-eligibility-${r.employeeNumber}`}
                    >
                      {eligibleLabel}
                    </span>
                  </td>
                  <td className="text-right">
                    <Link
                      href={`/app/admin/people/employees/${r.employeeId}?tab=training`}
                      className="text-xs text-emerald-800 hover:text-emerald-900 underline underline-offset-4"
                    >
                      Open
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function statusToLabel(s: ComplianceStatus): string {
  switch (s) {
    case "up_to_date": return "Up to date";
    case "training_required": return "Training required";
    case "in_progress": return "In progress";
    case "no_requirements": return "No requirements";
  }
}

function StatusPill({ status, label }: { status: ComplianceStatus; label: string }) {
  const cls =
    status === "up_to_date" || status === "no_requirements"
      ? "bg-emerald-50 text-emerald-800 border-emerald-200"
      : status === "in_progress"
        ? "bg-stone-50 text-stone-700 border-stone-200"
        : "bg-amber-50 text-amber-800 border-amber-200";
  return (
    <span
      className={"inline-block rounded border px-2 py-0.5 text-[11px] " + cls}
      data-testid={`compliance-status-${status}`}
    >
      {label}
    </span>
  );
}
