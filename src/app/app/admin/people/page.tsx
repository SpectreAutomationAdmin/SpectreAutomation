// HR-2A (2026-08-16) — People landing.
//
// The People hub is the club-side administrative beginning of the
// employee journey. HR-2A ships two surfaces (Employee Directory +
// Onboarding); the landing route immediately redirects into the
// directory so the sidebar-hover experience mirrors the founder-
// approved pattern used by other module hubs.
//
// A dedicated dashboard for People is deferred to a later slice —
// this file exists so /app/admin/people is not a 404.

import { redirect } from "next/navigation";

export default function PeopleLandingPage() {
  redirect("/app/admin/people/employees");
}
