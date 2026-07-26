import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { getClubProfile } from "@/lib/clubs/profile";
import { ClubSettingsForm } from "./ClubSettingsForm";

// Admin → Club Settings.
//
// Single-page form grouped into five sections:
//   1. Club Identity
//   2. Address & Contact
//   3. Tax Registration
//   4. Fiscal Year & Reporting
//   5. Accounting Defaults
//
// Permissions: settings:read to view, settings:write to save.
// Tenant: clubId comes from getActiveClubId, never from the URL or form.
// Cross-club access is impossible at this layer.
export default async function ClubSettingsPage() {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");

  const clubId = await getActiveClubId({
    clubId: principal.activeClubId ?? null,
    role: "",
  });

  if (!hasPermission(principal, clubId, "settings:read")) {
    redirect("/app/admin");
  }
  const canWrite = hasPermission(principal, clubId, "settings:write");

  // Read in parallel: the profile (may be null on first visit) + the
  // club row (for the page heading) + the chart-of-accounts list scoped
  // to this club (powers the eight default-account <select>s).
  const [profile, club, accounts] = await Promise.all([
    getClubProfile(principal, clubId),
    prisma.club.findUnique({ where: { id: clubId }, select: { name: true } }),
    prisma.account.findMany({
      where: { clubId, isActive: true },
      select: { id: true, accountNumber: true, name: true, type: true },
      orderBy: { accountNumber: "asc" },
    }),
  ]);

  return (
    <div className="max-w-5xl">
      <header>
        <div className="text-[11px] uppercase tracking-[0.22em] text-stone-500">
          Admin · {club?.name ?? "Club Settings"}
        </div>
        <h1 className="page-title mt-1">Club Settings</h1>
        <p className="mt-1 text-stone-600">
          Identity, addresses, tax registration, fiscal year, and accounting defaults for this club.
          These settings flow through the Monthly Reporting package, financial statements, statements, and
          invoice / receipt templates.
        </p>
      </header>

      <ClubSettingsForm
        profile={profile}
        accounts={accounts}
        canWrite={canWrite}
      />

      {profile ? (
        <div className="mt-8 rounded-lg border border-stone-200 bg-stone-50 p-4 text-xs text-stone-600">
          <div data-testid="club-settings-meta">
            Last updated{" "}
            <strong>{profile.updatedAt.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}</strong>
            {profile.updatedByUserId ? ` by user ${profile.updatedByUserId}` : ""}
            {" · "}
            Created{" "}
            <strong>{profile.createdAt.toLocaleString("en-US", { dateStyle: "medium" })}</strong>
          </div>
        </div>
      ) : null}
    </div>
  );
}
