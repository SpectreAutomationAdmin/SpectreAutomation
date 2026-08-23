// HR-2B.5 §33 (2026-08-19) — Employee Portal Home.
// HR-2C §1-4 (2026-08-20) — Adds the Club-configurable photographic
// hero header. When the Club has uploaded a ClubMedia row for
// category=`employee_portal_hero` it renders through the same-origin
// proxy route; otherwise a branded gradient fallback derived from
// Club.primaryColor takes its place. Never emits the "Spectre"
// wordmark [[feedback_member_brand_shielding]].
//
// Real, useful information that already exists. No fake widgets, no
// developer-facing copy. Every value comes from a database read
// scoped by the EmployeePortalPrincipal.

import { redirect } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getEmployeePortalPrincipal } from "@/lib/employee-portal-session";
import EmployeeTourOnFirstLogin from "@/components/employee/EmployeeTourOnFirstLogin";
import EmployeePortalHero from "@/components/employee/EmployeePortalHero";
import { getClubMedia } from "@/lib/club/media";
import { resolveEmployeeSchedulingEligibility } from "@/lib/hr/training/applicability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function formatDate(d: Date | null | undefined): string {
  if (!d) return "—";
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

function formatEmploymentType(t: string | null): string {
  if (!t) return "—";
  return { FULL_TIME: "Full-time", PART_TIME: "Part-time", SEASONAL: "Seasonal", CONTRACT: "Contract" }[t] ?? t;
}

function formatLifecycle(l: string, submittedState: string | null): string {
  if (submittedState === "APPROVED") return "Active";
  if (submittedState === "SUBMITTED") return "Awaiting Club review";
  if (l === "PRE_HIRE") return "Pre-hire";
  if (l === "ACTIVE") return "Active";
  if (l === "LEAVE") return "On leave";
  if (l === "TERMINATED") return "Terminated";
  return l;
}

export default async function EmployeePortalHome() {
  const principal = await getEmployeePortalPrincipal();
  if (!principal) redirect("/employee/login");

  const [employee, heroMedia, club, eligibility] = await Promise.all([
    prisma.employee.findFirst({
      where: { id: principal.employeeId, clubId: principal.clubId },
      include: {
        department: { select: { name: true } },
        position: { select: { name: true } },
        manager: { select: { firstName: true, lastName: true, preferredName: true } },
        onboardingSessions: {
          orderBy: { startedAt: "desc" },
          take: 1,
          select: { state: true, submittedAt: true },
        },
      },
    }),
    getClubMedia(principal.clubId, "employee_portal_hero"),
    prisma.club.findFirst({
      where: { id: principal.clubId },
      select: { primaryColor: true },
    }),
    // HR-2C B3 §17 — restrained Home summary; NON-gating (the actual
    // scheduling/availability compliance gate arrives with B4).
    resolveEmployeeSchedulingEligibility(principal.employeeId).catch(() => null),
  ]);
  if (!employee) redirect("/employee/login");

  const displayName = employee.preferredName?.trim().length
    ? employee.preferredName
    : employee.firstName;
  const managerName = employee.manager
    ? (employee.manager.preferredName ?? employee.manager.firstName) + " " + employee.manager.lastName
    : null;
  const sessionState = employee.onboardingSessions[0]?.state ?? null;
  const startDate = employee.hireDate ?? employee.expectedStartDate;

  const tourAlreadyDone = employee.portalTourCompletedAt !== null;

  return (
    <div className="space-y-8" data-testid="portal-home">
      <EmployeeTourOnFirstLogin alreadyDone={tourAlreadyDone} />

      <EmployeePortalHero
        clubId={principal.clubId}
        version={heroMedia?.sha256.slice(0, 12) ?? null}
        hasImage={heroMedia !== null}
        primaryColor={club?.primaryColor ?? null}
        greetingName={displayName ?? "there"}
        positionName={employee.position?.name ?? null}
      />

      <header>
        <h1 className="font-serif text-3xl leading-tight text-club-ink">
          Welcome to your employee portal, {displayName}.
        </h1>
        <p className="mt-2 text-sm text-stone-500">
          Everything you need to know about your role at the Club lives here.
        </p>
      </header>

      <section
        className="rounded-lg border border-stone-200 bg-white px-6 py-6 grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-4"
        data-testid="portal-home-summary"
      >
        <Item label="Employee number">
          <span className="font-mono">{employee.employeeNumber}</span>
        </Item>
        <Item label="Onboarding status">
          {formatLifecycle(employee.employeeLifecycle, sessionState)}
        </Item>
        <Item label="Position">{employee.position?.name ?? "—"}</Item>
        <Item label="Department">{employee.department?.name ?? "—"}</Item>
        <Item label="Employment type">
          {formatEmploymentType(employee.employmentType)}
        </Item>
        <Item label="Start date">{formatDate(startDate)}</Item>
        {managerName && <Item label="Reports to">{managerName}</Item>}
      </section>

      {eligibility && eligibility.applicable.length > 0 && (
        eligibility.outstandingTraining.length > 0 ? (
          // HR-2C B4 (2026-08-23) — Actionable compliance banner.
          // Upgraded from B3's soft summary because eligibility now
          // gates real availability writes and future scheduling.
          <section
            className="rounded-lg border border-amber-200 bg-amber-50/70 px-6 py-5"
            data-testid="portal-home-training-summary"
            data-eligible="false"
          >
            <div className="flex items-baseline justify-between gap-4">
              <div>
                <div className="text-[11px] uppercase tracking-[0.2em] text-amber-800">
                  Action required
                </div>
                <p className="mt-2 text-sm text-amber-900">
                  <strong data-testid="portal-home-training-count">
                    {eligibility.outstandingTraining.length}
                  </strong>{" "}
                  required training{" "}
                  {eligibility.outstandingTraining.length === 1 ? "course" : "courses"}{" "}
                  must be completed before you can submit availability or be
                  scheduled.
                </p>
              </div>
            </div>
            <div className="mt-4">
              <Link
                href="/employee/safety-training"
                className="btn btn-primary"
                data-testid="portal-home-training-cta"
              >
                Go to Safety &amp; Training
              </Link>
            </div>
          </section>
        ) : (
          // Compliance state visible even when up-to-date so the
          // employee can see they're in good standing at a glance.
          <section
            className="rounded-lg border border-emerald-200 bg-emerald-50/70 px-6 py-4"
            data-testid="portal-home-training-summary"
            data-eligible="true"
          >
            <div className="text-[11px] uppercase tracking-[0.2em] text-emerald-800">
              Required training
            </div>
            <p
              className="mt-1 text-sm text-emerald-900"
              data-testid="portal-home-training-uptodate"
            >
              Up to date
            </p>
          </section>
        )
      )}

      {sessionState === "SUBMITTED" && (
        <section
          className="rounded-lg border border-emerald-200 bg-emerald-50/60 px-6 py-5"
          data-testid="portal-home-awaiting-review"
        >
          <h2 className="font-serif text-lg text-stone-900">
            Your Club is reviewing your onboarding.
          </h2>
          <p className="mt-2 text-sm text-stone-700 leading-relaxed">
            You can use the portal in the meantime. Pay statements and
            schedule details will appear once you&rsquo;ve been fully
            activated.
          </p>
        </section>
      )}
    </div>
  );
}

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-[0.2em] text-stone-500">{label}</div>
      <div className="mt-1 text-sm text-club-ink">{children}</div>
    </div>
  );
}
