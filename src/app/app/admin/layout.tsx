import { redirect } from "next/navigation";
import { Suspense } from "react";
import { getCurrentUser } from "@/lib/session";
import { Sidebar } from "@/components/Sidebar";
import { TopBar } from "@/components/TopBar";
import { Toast } from "@/components/Toast";
import { AdminShell } from "@/components/admin/AdminShell";
import { SpectreSidebar } from "@/components/spectre/SpectreSidebar";
import { SpectreTopBar } from "@/components/spectre/SpectreTopBar";
import { buildSpectreClubAccentStyle } from "@/lib/design/tokens";
import { prisma } from "@/lib/prisma";
import { getActiveBranding } from "@/lib/branding";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { ROLE_PERMISSIONS, type RoleKey } from "@/lib/permissions";

const ADMIN_ROLES = new Set([
  "SUPER_ADMIN", "CLUB_ADMIN", "GENERAL_MANAGER", "CONTROLLER", "FINANCE_ADMIN",
  "DEPARTMENT_MANAGER", "PRO_SHOP_MANAGER", "F_AND_B_MANAGER", "EVENT_MANAGER",
  "PAYROLL_ADMIN", "STAFF", "AUDITOR_READ_ONLY", "BOARD_READ_ONLY",
]);

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // White-label: host resolution before auth so unknown hosts can't probe
  // session state. Unknown → safe error page. Club host → resolved branding.
  // Platform host → Spectre branding.
  const branding = await getActiveBranding();
  if (branding.mode === "unknown") redirect("/unknown-domain");

  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (!ADMIN_ROLES.has(user.role)) redirect("/app/member");

  // Wordmark: club host shows the club's wordmark; platform shows
  // "{Spectre} · {first club}" so SUPER_ADMIN sees which club they're in.
  const clubName = branding.mode === "club"
    ? branding.wordmark
    : (user.club?.name ?? (await prisma.club.findFirst({ orderBy: { createdAt: "asc" } }))?.name ?? "Spectre");

  // Phase 13F — surface a clearly visible banner when the current user has
  // an active support session for any club. Self-impersonation is per-user.
  const supportSession = await prisma.supportSession.findFirst({
    where: { supportUserId: user.id, endedAt: null },
    orderBy: { startedAt: "desc" },
  });

  // Compute the permission set for the sidebar to gate its nav items.
  // Union of permissions granted by every role this user holds at the
  // active club, plus any global SUPER_ADMIN membership. Routes still
  // enforce permissions independently — this is for UI visibility.
  const principal = await getCurrentPrincipal();
  const isSuperAdmin = !!principal && principal.memberships.some(
    (m) => m.clubId === null && m.roleKey === "SUPER_ADMIN"
  );
  const activeClubId = principal?.activeClubId ?? null;
  const permSet = new Set<string>();
  if (principal) {
    const rolesHere = principal.memberships
      .filter((m) => m.clubId === activeClubId || m.clubId === null)
      .map((m) => m.roleKey as RoleKey);
    for (const r of rolesHere) {
      for (const p of ROLE_PERMISSIONS[r] ?? []) permSet.add(p);
    }
  }

  const supportBanner = supportSession ? (
    <div className="bg-red-600 text-white text-sm px-4 py-2 flex items-center justify-between">
      <span>⚠ Support session active — mode {supportSession.mode}. Every action you take is being logged.</span>
      <span className="font-mono text-xs">session {supportSession.id.slice(0, 8)}</span>
    </div>
  ) : null;

  // Slice 1 v1.0 — Spectre Design System chrome. `AdminShell` only
  // uses these props when the current route is in its
  // `SPECTRE_MODE_EXACT_PATHS` list. Every OTHER route continues to
  // render through the LEGACY `sidebar` + `topbar` slots unchanged.
  // The club-accent style reads the real `Club.primaryColor` — no
  // hardcoded Silver Springs value.
  const spectreClubAccentStyle = buildSpectreClubAccentStyle(branding.primaryColor);

  return (
    <AdminShell
      sidebar={
        <Sidebar
          kind="admin"
          clubName={clubName}
          permissions={Array.from(permSet)}
          isSuperAdmin={isSuperAdmin}
        />
      }
      topbar={
        <TopBar
          userName={user.name}
          userRole={user.role}
          settingsHref="/app/admin/settings"
        />
      }
      spectreSidebar={
        <SpectreSidebar
          clubName={clubName}
          permissions={Array.from(permSet)}
          isSuperAdmin={isSuperAdmin}
        />
      }
      spectreTopbar={
        <SpectreTopBar
          userName={user.name}
          userRole={user.role}
          settingsHref="/app/admin/settings"
        />
      }
      spectreClubAccentStyle={spectreClubAccentStyle}
      supportBanner={supportBanner}
      toast={<Suspense fallback={null}><Toast /></Suspense>}
    >
      {children}
    </AdminShell>
  );
}
