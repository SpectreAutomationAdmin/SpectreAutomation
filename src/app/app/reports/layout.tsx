// /app/reports/* — board / member-facing read-only reporting surfaces.
//
// This layout lives OUTSIDE the admin layout (/app/admin) and the
// member layout (/app/member), so it can be reached by either role
// without role-gating in the layer above. Per-page server components
// resolve their own authorisation against the requested entity
// (e.g. `getBoardPackageView` checks board-perm OR recipient-link).
//
// The chrome is intentionally minimal — just a session check and a
// neutral container. This is a board surface; the admin sidebar and
// the member-portal wordmark are deliberately not rendered here.

import { redirect } from "next/navigation";

import { getCurrentUser } from "@/lib/session";

export default async function ReportsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return <div className="min-h-screen bg-club-cream">{children}</div>;
}
