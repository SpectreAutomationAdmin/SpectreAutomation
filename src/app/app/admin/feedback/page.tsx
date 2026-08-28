// HR-2C Anonymous Feedback — admin inbox (2026-08-27).
//
// Read-only listing + status transitions. The rows carry only what
// the anonymous-feedback service persists (category, message,
// status, timestamps) — never any employee identity, so the admin
// sees exactly what the record contains.

import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { listAnonymousFeedback } from "@/lib/anonymous-feedback";
import AdminFeedbackList from "./AdminFeedbackList";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function AdminFeedbackPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const clubId = await getActiveClubId(user);
  const principal = await getCurrentPrincipal();
  if (!principal || !hasPermission(principal, clubId, "settings:read")) redirect("/app/admin");

  const rows = await listAnonymousFeedback(clubId);

  return (
    <div className="max-w-[880px]" data-testid="admin-feedback-page">
      <header className="mb-spectre-8">
        <h1 className="text-spectre-h1 font-semibold" style={{ color: "var(--spectre-text-primary)" }}>
          Anonymous Feedback
        </h1>
        <p className="mt-2 text-spectre-body" style={{ color: "var(--spectre-text-secondary)" }}>
          Feedback submitted by employees through the Employee Portal. The application does not
          store the submitter&rsquo;s name, email, or employee number — only which Club the
          message belongs to. Reply-to-employee is not available because the record is
          intentionally anonymous.
        </p>
      </header>
      <section
        className="rounded-spectre-panel border p-spectre-6"
        style={{ background: "var(--spectre-surface)", borderColor: "var(--spectre-border-hairline)" }}
      >
        <AdminFeedbackList clubId={clubId} initial={rows} />
      </section>
    </div>
  );
}
