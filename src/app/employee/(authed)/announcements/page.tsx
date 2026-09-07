// HR-2C Fore! Announcements — full-list employee page (2026-08-27).
//
// Scheduling Foundation · Phase E (2026-09-07) — extended with a
// Shift Opportunities tab per amendment §8. The existing
// Announcements list is UNCHANGED; the shifts tab is additive.

import { redirect } from "next/navigation";
import { getEmployeePortalPrincipal } from "@/lib/employee-portal-session";
import { listVisibleAnnouncements } from "@/lib/announcements";
import {
  listEligibleOpportunitiesForEmployee,
} from "@/lib/scheduling/shift-opportunities";
import ForeTabs from "./ForeTabs";
import ShiftOpportunitiesList, {
  type ShiftOpportunityRow,
} from "./ShiftOpportunitiesList";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function EmployeeAnnouncementsPage({
  searchParams,
}: {
  searchParams?: { tab?: string; err?: string };
}) {
  const principal = await getEmployeePortalPrincipal();
  if (!principal) redirect("/employee/login");

  const tab = searchParams?.tab === "shifts" ? "shifts" : "announcements";

  // Both tabs' data always loaded so the tab strip can render a
  // count badge. Reads are cheap and both are tenant-scoped.
  const [announcements, opportunities] = await Promise.all([
    listVisibleAnnouncements(principal.clubId, "EMPLOYEE", { limit: 100 }),
    listEligibleOpportunitiesForEmployee(principal.clubId, principal.employeeId),
  ]);

  const opportunityRows: ShiftOpportunityRow[] = opportunities.map((o) => ({
    opportunityId: o.id,
    shiftId: o.shiftId,
    scheduledStartIso: o.startAt.toISOString(),
    scheduledEndIso: o.endAt.toISOString(),
    scheduledSeconds: Math.max(0, Math.floor((o.endAt.getTime() - o.startAt.getTime()) / 1000)),
    departmentName: o.departmentName,
    templateName: o.templateName,
    positionName: o.positionName,
  }));

  return (
    <div className="max-w-3xl mx-auto px-4 md:px-8 py-8" data-testid="employee-announcements-page">
      <header className="flex items-baseline gap-3 pb-2">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/brand/fore.svg"
          alt=""
          aria-hidden="true"
          className="h-8 w-auto block"
        />
        <h1 className="font-serif text-[24px] text-club-ink">FORE!</h1>
      </header>

      <ForeTabs shiftOpportunityCount={opportunityRows.length} />

      {searchParams?.err && (
        <div
          data-testid="fore-error-toast"
          className="mb-4 rounded-md border border-stone-300 bg-stone-50 px-4 py-3 text-sm text-stone-800"
        >
          {searchParams.err}
        </div>
      )}

      {tab === "announcements" && (
        <section data-testid="fore-tab-content-announcements">
          {announcements.length === 0 ? (
            <div
              className="rounded-2xl bg-club-cream border border-stone-200/60 p-6 text-center"
              data-testid="employee-announcements-empty"
            >
              <p className="text-[14px] text-stone-600">
                No announcements right now.
              </p>
              <p className="text-[12.5px] text-stone-500 mt-1">
                When your Club posts new updates they&rsquo;ll appear here.
              </p>
            </div>
          ) : (
            <ol className="space-y-4">
              {announcements.map((a) => {
                const effectiveDate = a.publishedAt ?? a.createdAt;
                const dateLabel = new Date(effectiveDate).toLocaleDateString(undefined, {
                  year: "numeric", month: "long", day: "numeric",
                });
                return (
                  <li
                    key={a.id}
                    className="rounded-2xl bg-white border border-stone-200/70 p-5"
                    data-testid={`employee-announcement-${a.id}`}
                  >
                    <div className="flex items-baseline gap-3 flex-wrap">
                      <p className="text-[11.5px] uppercase tracking-widest text-stone-500">{dateLabel}</p>
                      {a.isPinned && (
                        <span className="text-[10px] uppercase tracking-widest text-club-green-700 border border-club-green-700/40 rounded px-1.5 py-0.5">
                          Pinned
                        </span>
                      )}
                    </div>
                    <h2 className="font-serif text-[19px] text-club-ink mt-1">{a.title}</h2>
                    <p className="text-[14px] text-stone-700 leading-relaxed whitespace-pre-wrap mt-2">
                      {a.body}
                    </p>
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      )}

      {tab === "shifts" && (
        <section data-testid="fore-tab-content-shifts">
          <ShiftOpportunitiesList opportunities={opportunityRows} />
        </section>
      )}
    </div>
  );
}
