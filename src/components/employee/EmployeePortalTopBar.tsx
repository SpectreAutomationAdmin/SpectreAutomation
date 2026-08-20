// HR-2B.5 §32 — Employee Portal top bar.
// HR-2C §9 (2026-08-20) — adds the Help menu with "Take the portal tour" replay.
//
// Shows the employee's display name + employee number, a Help affordance
// (single item today — restrained; §9 explicit), and a Sign Out button.

import EmployeePortalHelpMenu from "./EmployeePortalHelpMenu";

export default function EmployeePortalTopBar({
  displayName,
  employeeNumber,
}: {
  displayName: string;
  employeeNumber: string;
}) {
  return (
    <header className="flex items-center justify-between border-b border-stone-200 bg-white px-6 py-3">
      <div />
      <div className="flex items-center gap-4">
        <div className="text-right">
          <div className="text-sm text-club-ink" data-testid="portal-topbar-name">{displayName}</div>
          <div className="font-mono text-[11px] text-stone-500" data-testid="portal-topbar-employee-number">
            {employeeNumber}
          </div>
        </div>
        <EmployeePortalHelpMenu />
        <form action="/employee/logout" method="post">
          <button
            type="submit"
            className="rounded-md border border-stone-200 px-3 py-1.5 text-xs text-stone-600 hover:bg-stone-50 hover:text-club-ink"
            data-testid="portal-signout"
          >
            Sign out
          </button>
        </form>
      </div>
    </header>
  );
}
