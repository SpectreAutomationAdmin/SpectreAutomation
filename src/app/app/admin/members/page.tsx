// Phase 20 (Member Database, 2026-08-15) — admin roster of every
// member in the active club/tenant. Dense, operational table with
// URL-driven search + status/category/group filters + sort. All
// queries are club-scoped via `getActiveClubId(user)`.
//
// Founder reference: replicates a private-club Member Database
// (see the Tucker-Hersam profile screenshot) — not a marketing
// dashboard.

import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { getActiveClubId } from "@/lib/active-club";
import { Badge } from "@/components/Badge";

export const dynamic = "force-dynamic";

type Search = {
  q?: string;
  status?: string;
  category?: string;
  group?: string;
  sort?: string;
};

function initials(first: string | null, last: string | null): string {
  const a = (first ?? "").trim().charAt(0);
  const b = (last ?? "").trim().charAt(0);
  return `${a}${b}`.toUpperCase() || "·";
}

function formatJoinDate(d: Date | null): string {
  if (!d) return "—";
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

export default async function MembersListPage({ searchParams }: { searchParams: Search }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const clubId = await getActiveClubId(user);

  const q = (searchParams.q ?? "").trim();
  const statusFilter = (searchParams.status ?? "").trim();
  const categoryFilter = (searchParams.category ?? "").trim();
  const groupFilter = (searchParams.group ?? "").trim();
  const sort = (searchParams.sort ?? "lastName").trim();

  const where: {
    clubId: string;
    status?: string;
    membershipCategory?: string;
    OR?: Array<Record<string, unknown>>;
    groupAssignments?: { some: { groupId: string } };
  } = { clubId };
  if (statusFilter) where.status = statusFilter;
  if (categoryFilter) where.membershipCategory = categoryFilter;
  if (groupFilter) where.groupAssignments = { some: { groupId: groupFilter } };
  if (q) {
    // No `mode:insensitive` (SQLite portability); the sample sizes
    // typical for a club's member list keep the `contains` search fast.
    where.OR = [
      { firstName:    { contains: q } },
      { lastName:     { contains: q } },
      { email:        { contains: q } },
      { memberNumber: { contains: q } },
    ];
  }

  const orderBy = (() => {
    switch (sort) {
      case "joinDate":     return [{ joinDate: "desc" as const }, { lastName: "asc" as const }];
      case "memberNumber": return [{ memberNumber: "asc" as const }];
      case "category":     return [{ membershipCategory: "asc" as const }, { lastName: "asc" as const }];
      case "status":       return [{ status: "asc" as const }, { lastName: "asc" as const }];
      case "lastName":
      default:             return [{ lastName: "asc" as const }, { firstName: "asc" as const }];
    }
  })();

  const [members, groups, categoriesRaw, statusesRaw, total] = await Promise.all([
    prisma.member.findMany({
      where,
      orderBy,
      take: 500,
      include: {
        groupAssignments: { include: { group: true } },
      },
    }),
    prisma.memberGroup.findMany({
      where: { clubId },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    }),
    prisma.member.findMany({
      where: { clubId, membershipCategory: { not: null } },
      distinct: ["membershipCategory"],
      select: { membershipCategory: true },
      orderBy: [{ membershipCategory: "asc" }],
    }),
    prisma.member.findMany({
      where: { clubId },
      distinct: ["status"],
      select: { status: true },
      orderBy: [{ status: "asc" }],
    }),
    prisma.member.count({ where: { clubId } }),
  ]);
  const categories = categoriesRaw.map((r) => r.membershipCategory!).filter(Boolean);
  const statuses = statusesRaw.map((r) => r.status);

  return (
    <div className="spectre-members-db">
      <header className="spectre-members-db-head">
        <div>
          <h1 className="spectre-members-db-title">Members</h1>
          <p className="spectre-members-db-meta">
            {total} member{total === 1 ? "" : "s"} in this club
            {q || statusFilter || categoryFilter || groupFilter
              ? ` · showing ${members.length} match${members.length === 1 ? "" : "es"}`
              : ""}
          </p>
        </div>
      </header>

      <form className="spectre-members-db-filters" action="/app/admin/members" method="get">
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Search name, email, or member number"
          className="spectre-members-db-search"
          aria-label="Search members"
        />
        <select name="status" defaultValue={statusFilter} className="spectre-members-db-select" aria-label="Filter by status">
          <option value="">All statuses</option>
          {statuses.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select name="category" defaultValue={categoryFilter} className="spectre-members-db-select" aria-label="Filter by category">
          <option value="">All categories</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select name="group" defaultValue={groupFilter} className="spectre-members-db-select" aria-label="Filter by group">
          <option value="">All groups</option>
          {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
        <select name="sort" defaultValue={sort} className="spectre-members-db-select" aria-label="Sort">
          <option value="lastName">Sort: Last name</option>
          <option value="memberNumber">Sort: Member #</option>
          <option value="category">Sort: Category</option>
          <option value="status">Sort: Status</option>
          <option value="joinDate">Sort: Newest first</option>
        </select>
        <button type="submit" className="spectre-btn spectre-btn--secondary spectre-btn--sm">Apply</button>
        {(q || statusFilter || categoryFilter || groupFilter || sort !== "lastName") ? (
          <Link href="/app/admin/members" className="spectre-members-db-clear">Clear</Link>
        ) : null}
      </form>

      <div className="spectre-members-db-table-wrap">
        <table className="spectre-members-db-table">
          <thead>
            <tr>
              <th className="col-avatar" aria-label="Photo" />
              <th className="col-name">Name</th>
              <th className="col-number">Member #</th>
              <th className="col-category">Category</th>
              <th className="col-status">Status</th>
              <th className="col-email">Email</th>
              <th className="col-phone">Mobile</th>
              <th className="col-join">Member since</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => {
              const displayName = m.nickname ? `${m.firstName} "${m.nickname}" ${m.lastName}` : `${m.firstName} ${m.lastName}`;
              return (
                <tr key={m.id} className="spectre-members-db-row">
                  <td className="col-avatar">
                    <Link href={`/app/admin/members/${m.id}`} className="spectre-members-db-avatar-link" aria-label={`Open ${m.firstName} ${m.lastName}`}>
                      {m.profileImageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={m.profileImageUrl} alt="" className="spectre-members-db-avatar" />
                      ) : (
                        <span className="spectre-members-db-avatar spectre-members-db-avatar--placeholder">{initials(m.firstName, m.lastName)}</span>
                      )}
                    </Link>
                  </td>
                  <td className="col-name">
                    <Link href={`/app/admin/members/${m.id}`} className="spectre-members-db-name">{displayName}</Link>
                  </td>
                  <td className="col-number spectre-members-db-mono">{m.memberNumber}</td>
                  <td className="col-category">{m.membershipCategory ?? "—"}</td>
                  <td className="col-status"><Badge status={m.status} /></td>
                  <td className="col-email">{m.email ? (
                    <a href={`mailto:${m.email}`} className="spectre-members-db-link">{m.email}</a>
                  ) : "—"}</td>
                  <td className="col-phone">{m.phone ? (
                    <a href={`tel:${m.phone}`} className="spectre-members-db-link">{m.phone}</a>
                  ) : "—"}</td>
                  <td className="col-join">{formatJoinDate(m.joinDate)}</td>
                </tr>
              );
            })}
            {members.length === 0 && (
              <tr>
                <td colSpan={8} className="spectre-members-db-empty">
                  {q || statusFilter || categoryFilter || groupFilter
                    ? "No members match those filters."
                    : "No members yet. Add your first member to begin building this club's roster."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
