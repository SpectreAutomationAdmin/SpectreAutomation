// Governance → Board & Committees admin page.
//
// Where: /app/admin/governance/board-committees
// Permission: packages:read (list) + packages:write (assign/edit/delete).
//
// What it does:
//   • Lists every BoardRole row for the active club, sorted by
//     term start (most-recent first) with an effective-status pill
//     computed against today's date.
//   • Provides an "Assign a member" form for adding new roles —
//     pick a member, pick a title from the canonical list,
//     optionally name a committee, set the term window, and choose
//     the initial status (defaults to UPCOMING).
//   • Per-row delete (confirm-gated; the controller can also use
//     the Edit affordance to set status=EXPIRED for a softer
//     revoke that preserves the historical record).
//
// What it does NOT touch:
//   • Club Settings (per the founder's spec — Board roles are
//     person-specific, term-specific, and live separately).
//   • UserClubRole (the permission layer) — board-role access is
//     additive; setting an ACTIVE BoardRole grants tile + report
//     visibility without granting any other admin permission.

import Link from "next/link";
import { redirect } from "next/navigation";

import { Badge } from "@/components/Badge";
import { getActiveClubId } from "@/lib/active-club";
import {
  BOARD_ROLE_TITLES,
  listBoardRoster,
} from "@/lib/governance/board-roles";
import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/rbac";
import { getCurrentPrincipal } from "@/lib/services/principal";

import { AssignBoardRoleForm, type MemberOption } from "./AssignBoardRoleForm";
import { DeleteBoardRoleButton } from "./DeleteBoardRoleButton";

type PageProps = {
  searchParams?: { notice?: string; error?: string };
};

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function defaultTermStart(): string {
  // Default = today (so the controller can assign a role that's
  // immediately effective). Computed as a UTC date string to match
  // the <input type="date"> format.
  return new Date().toISOString().slice(0, 10);
}

function defaultTermEnd(): string {
  // Default = one year from today — covers the typical AGM-cycle
  // single-year term. The controller can shorten / lengthen.
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d.toISOString().slice(0, 10);
}

export default async function BoardCommitteesAdminPage({
  searchParams,
}: PageProps) {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const clubId = await getActiveClubId({
    clubId: principal.activeClubId ?? null,
    role: "",
  });
  if (!hasPermission(principal, clubId, "packages:read")) redirect("/app/admin");
  const canWrite = hasPermission(principal, clubId, "packages:write");

  const [rows, members] = await Promise.all([
    listBoardRoster(principal, clubId),
    prisma.member.findMany({
      where: { clubId, status: { in: ["ACTIVE", "ONBOARDING"] } },
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
      select: {
        id: true,
        memberNumber: true,
        firstName: true,
        lastName: true,
        email: true,
      },
    }),
  ]);
  const memberOptions: MemberOption[] = members.map((m) => ({
    id: m.id,
    memberNumber: m.memberNumber,
    name: `${m.firstName} ${m.lastName}`.trim(),
    email: m.email,
  }));

  const notice = searchParams?.notice ? String(searchParams.notice) : null;
  const error = searchParams?.error ? String(searchParams.error) : null;

  // Roster stats — handy for the controller to see at a glance.
  const stats = {
    active: rows.filter((r) => r.effectiveStatus === "ACTIVE").length,
    upcoming: rows.filter((r) => r.effectiveStatus === "UPCOMING").length,
    expired: rows.filter((r) => r.effectiveStatus === "EXPIRED").length,
  };

  return (
    <div data-testid="board-committees-page">
      <Link
        href="/app/admin/governance"
        className="text-sm text-stone-500 hover:text-club-ink"
      >
        ← Governance
      </Link>

      <h1 className="mt-3 page-title">Board &amp; Committees</h1>
      <p className="mt-1 text-stone-500">
        Person- and term-specific governance roster. Active Board
        members automatically receive access to the Monthly
        Reporting Package tile on their member dashboard. Roles
        become Active on the term start date and revert to Expired
        on the term end date.
      </p>

      {error && (
        <div
          className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
          role="alert"
          data-testid="board-roster-error"
        >
          {error}
        </div>
      )}
      {notice && (
        <div
          className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700"
          role="status"
          data-testid="board-roster-notice"
        >
          {notice}
        </div>
      )}

      {/* Stats ribbon -----------------------------------------------------*/}
      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="card card-body">
          <div className="text-xs uppercase tracking-wide text-stone-500">Active</div>
          <div className="mt-1 font-serif text-3xl text-club-ink">{stats.active}</div>
        </div>
        <div className="card card-body">
          <div className="text-xs uppercase tracking-wide text-stone-500">Upcoming</div>
          <div className="mt-1 font-serif text-3xl text-club-ink">{stats.upcoming}</div>
        </div>
        <div className="card card-body">
          <div className="text-xs uppercase tracking-wide text-stone-500">Expired</div>
          <div className="mt-1 font-serif text-3xl text-club-ink">{stats.expired}</div>
        </div>
      </div>

      {/* Roster table ---------------------------------------------------*/}
      <section className="mt-6 card overflow-hidden">
        <div className="px-6 py-4 border-b border-stone-200 flex items-baseline justify-between gap-3">
          <div>
            <h2 className="section-title text-lg">Roster ({rows.length})</h2>
            <p className="mt-0.5 text-xs text-stone-500">
              Sorted by term start — most recent first. Effective status
              is computed against today's date; stored status overrides
              only when set to Expired (manual revoke).
            </p>
          </div>
        </div>
        <table className="table-base">
          <thead>
            <tr>
              <th>Member</th>
              <th>Role</th>
              <th>Committee</th>
              <th>Term</th>
              <th>Status</th>
              <th>Source</th>
              <th className="text-right">Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-stone-500" data-testid="board-roster-empty">
                  No Board roles assigned yet. Use the form below to add the first.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} data-testid={`board-role-row-${r.id}`}>
                <td>
                  <div className="font-medium text-club-ink">{r.memberName}</div>
                  <div className="text-xs text-stone-500">
                    {r.memberNumber}
                    {r.email && <> · {r.email}</>}
                  </div>
                </td>
                <td className="text-sm">{r.roleTitle}</td>
                <td className="text-xs text-stone-600">
                  {r.committeeName ?? <span className="text-stone-400">—</span>}
                </td>
                <td className="text-xs text-stone-600">
                  <div>{formatDate(r.termStartDate)}</div>
                  <div className="text-stone-400">to {formatDate(r.termEndDate)}</div>
                </td>
                <td>
                  <Badge
                    status={r.effectiveStatus}
                    data-testid={`board-role-status-${r.id}`}
                  />
                  {r.status !== r.effectiveStatus && (
                    <div className="mt-0.5 text-[10px] uppercase tracking-wide text-stone-400">
                      stored: {r.status}
                    </div>
                  )}
                </td>
                <td className="text-xs text-stone-500">
                  {r.source === "AGM_ELECTION" ? "AGM election" : "Manual"}
                </td>
                <td className="text-right">
                  {canWrite && (
                    <DeleteBoardRoleButton roleId={r.id} label={`${r.memberName} (${r.roleTitle})`} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* Assign form -----------------------------------------------------*/}
      {canWrite && (
        <section
          className="mt-6 card card-body"
          aria-labelledby="assign-heading"
          data-testid="board-roster-assign-section"
        >
          <h2 id="assign-heading" className="section-title text-lg">
            Assign a member to the Board
          </h2>
          <p className="mt-1 text-xs text-stone-600">
            Select an active member, pick a title from the canonical list,
            and choose a term window. Upcoming roles become Active
            automatically on the term start date.
          </p>
          <AssignBoardRoleForm
            members={memberOptions}
            defaultTermStart={defaultTermStart()}
            defaultTermEnd={defaultTermEnd()}
          />
          <details className="mt-4 text-xs text-stone-500">
            <summary className="cursor-pointer">
              Available titles ({BOARD_ROLE_TITLES.length})
            </summary>
            <ul className="mt-2 list-disc list-inside space-y-0.5">
              {BOARD_ROLE_TITLES.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
            <p className="mt-2">
              The roleTitle column accepts free text — if the title you need
              isn't here, type it into the database directly or extend the
              canonical list in code.
            </p>
          </details>
        </section>
      )}
    </div>
  );
}
