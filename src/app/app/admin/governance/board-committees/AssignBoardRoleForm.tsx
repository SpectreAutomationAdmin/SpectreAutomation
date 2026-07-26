"use client";

// "Assign a member" form on the Board & Committees admin page.
//
// Client component because the member picker needs a text-filter
// against the supplied roster — server-side filtering would require
// a round trip per keystroke. The roster is supplied as a prop from
// the page (already tenant-scoped) so this stays cheap.
//
// The form posts to `assignBoardRoleAction` via the standard
// server-action mechanism (`action={...}`), so submission still
// goes through the validated server path.

import { useMemo, useState } from "react";

import { BOARD_ROLE_TITLES } from "@/lib/governance/board-roles-data";

import { assignBoardRoleAction } from "./_actions";

export type MemberOption = {
  id: string;
  memberNumber: string;
  name: string;
  email: string;
};

type Props = {
  members: ReadonlyArray<MemberOption>;
  /** ISO YYYY-MM-DD strings — pre-fill the form with sensible
   *  defaults so the operator can hit save quickly. */
  defaultTermStart: string;
  defaultTermEnd: string;
};

export function AssignBoardRoleForm({
  members,
  defaultTermStart,
  defaultTermEnd,
}: Props) {
  const [query, setQuery] = useState("");
  const [selectedMemberId, setSelectedMemberId] = useState<string>("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return members.slice(0, 30);
    return members
      .filter((m) =>
        [m.name, m.memberNumber, m.email]
          .filter(Boolean)
          .some((s) => s.toLowerCase().includes(q)),
      )
      .slice(0, 30);
  }, [query, members]);

  const selectedMember = members.find((m) => m.id === selectedMemberId);

  return (
    <form
      action={assignBoardRoleAction}
      className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2"
      data-testid="assign-board-role-form"
    >
      {/* Member search + select ----------------------------------------*/}
      <div className="lg:col-span-2">
        <label
          htmlFor="board-member-search"
          className="block text-xs uppercase tracking-wide text-stone-500"
        >
          Member
        </label>
        <input
          id="board-member-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name, member number, or email…"
          className="input mt-1 w-full text-sm"
          data-testid="board-member-search"
          autoComplete="off"
        />
        <input type="hidden" name="memberId" value={selectedMemberId} />
        <div
          className="mt-2 max-h-48 overflow-y-auto rounded-md border border-stone-200 divide-y divide-stone-100"
          data-testid="board-member-results"
        >
          {filtered.length === 0 && (
            <div className="px-3 py-2 text-xs text-stone-500">No matches.</div>
          )}
          {filtered.map((m) => {
            const selected = m.id === selectedMemberId;
            return (
              <button
                type="button"
                key={m.id}
                onClick={() => setSelectedMemberId(m.id)}
                className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-stone-50 ${
                  selected ? "bg-club-green-50" : ""
                }`}
                data-testid={`board-member-option-${m.memberNumber}`}
              >
                <span className="font-medium text-club-ink">{m.name}</span>
                <span className="text-xs text-stone-500">
                  {m.memberNumber}{m.email ? ` · ${m.email}` : ""}
                </span>
              </button>
            );
          })}
        </div>
        {selectedMember && (
          <p className="mt-1 text-xs text-club-green-700" data-testid="board-member-selected">
            Selected: {selectedMember.name} ({selectedMember.memberNumber})
          </p>
        )}
      </div>

      {/* Role title --------------------------------------------------*/}
      <div>
        <label
          htmlFor="board-role-title"
          className="block text-xs uppercase tracking-wide text-stone-500"
        >
          Board title / committee role
        </label>
        <select
          id="board-role-title"
          name="roleTitle"
          defaultValue=""
          className="input mt-1 w-full text-sm"
          required
          data-testid="board-role-title"
        >
          <option value="" disabled>
            Select a title…
          </option>
          {BOARD_ROLE_TITLES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>

      {/* Committee name (optional) ----------------------------------*/}
      <div>
        <label
          htmlFor="board-committee-name"
          className="block text-xs uppercase tracking-wide text-stone-500"
        >
          Committee (optional)
        </label>
        <input
          id="board-committee-name"
          name="committeeName"
          type="text"
          placeholder="e.g. Finance Committee"
          className="input mt-1 w-full text-sm"
          data-testid="board-committee-name"
        />
      </div>

      {/* Term start ---------------------------------------------------*/}
      <div>
        <label
          htmlFor="board-term-start"
          className="block text-xs uppercase tracking-wide text-stone-500"
        >
          Term start
        </label>
        <input
          id="board-term-start"
          name="termStartDate"
          type="date"
          defaultValue={defaultTermStart}
          required
          className="input mt-1 w-full text-sm"
          data-testid="board-term-start"
        />
      </div>

      {/* Term end ---------------------------------------------------*/}
      <div>
        <label
          htmlFor="board-term-end"
          className="block text-xs uppercase tracking-wide text-stone-500"
        >
          Term end
        </label>
        <input
          id="board-term-end"
          name="termEndDate"
          type="date"
          defaultValue={defaultTermEnd}
          required
          className="input mt-1 w-full text-sm"
          data-testid="board-term-end"
        />
      </div>

      {/* Initial status (defaults to UPCOMING) ----------------------*/}
      <div>
        <label
          htmlFor="board-status"
          className="block text-xs uppercase tracking-wide text-stone-500"
        >
          Status
        </label>
        <select
          id="board-status"
          name="status"
          defaultValue="UPCOMING"
          className="input mt-1 w-full text-sm"
          data-testid="board-status"
        >
          <option value="UPCOMING">Upcoming</option>
          <option value="ACTIVE">Active</option>
          <option value="EXPIRED">Expired</option>
        </select>
        <p className="mt-1 text-xs text-stone-500">
          The system uses term dates to determine current access automatically.
          Set Expired only to revoke access before the term ends.
        </p>
      </div>

      <div className="lg:col-span-2 flex flex-wrap items-center gap-3">
        <button
          type="submit"
          className="btn btn-primary"
          disabled={!selectedMemberId}
          data-testid="assign-board-role-submit"
        >
          Assign Board role
        </button>
        {!selectedMemberId && (
          <span className="text-xs text-stone-500">
            Pick a member from the list above to enable Assign.
          </span>
        )}
      </div>
    </form>
  );
}
