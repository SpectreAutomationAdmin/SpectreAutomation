// HR-2C Fore! Announcements — full-list employee page (2026-08-27).
//
// Shown when Home's Fore! card links out via "View all
// announcements". Consumes the canonical publication-rule read
// (`listVisibleAnnouncements`) — drafts, future publishedAt, and
// expired rows are silently excluded. Tenant-scoped on read via
// the authenticated employee session.
//
// Fore! branding is preserved: same wordmark treatment as the home
// card header, restrained editorial layout.

import { redirect } from "next/navigation";
import { getEmployeePortalPrincipal } from "@/lib/employee-portal-session";
import { listVisibleAnnouncements } from "@/lib/announcements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function EmployeeAnnouncementsPage() {
  const principal = await getEmployeePortalPrincipal();
  if (!principal) redirect("/employee/login");

  const announcements = await listVisibleAnnouncements(principal.clubId, "EMPLOYEE", { limit: 100 });

  return (
    <div className="max-w-3xl mx-auto px-4 md:px-8 py-8" data-testid="employee-announcements-page">
      <header className="flex items-baseline gap-3 pb-6">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/brand/fore.svg"
          alt=""
          aria-hidden="true"
          className="h-8 w-auto block"
        />
        <h1 className="font-serif text-[24px] text-club-ink">Announcements</h1>
      </header>

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
    </div>
  );
}
