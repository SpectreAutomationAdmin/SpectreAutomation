import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { workflowService } from "@/lib/enterprise";
import { Badge } from "@/components/Badge";
import { formatDate } from "@/lib/finance";

export default async function WorkflowsPage() {
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "workflow:read")) redirect("/app/admin");

  const [open, recent] = await Promise.all([
    workflowService.listWorkflows(p, clubId, { status: "ACTIVE" }),
    workflowService.listWorkflows(p, clubId),
  ]);
  const completed = recent.filter((w) => w.status === "COMPLETED" || w.status === "CANCELLED").slice(0, 20);

  return (
    <div>
      <Link href="/app/admin/governance" className="text-sm text-stone-500 hover:text-club-ink">← Governance</Link>
      <h1 className="mt-3 page-title">Governance Workflows</h1>
      <p className="mt-1 text-stone-500">Multi-step approvals for budgets, capital projects, banking changes, and policy. Each step is auditable; self-approval is blocked.</p>

      <div className="mt-6 card overflow-hidden">
        <div className="px-6 py-4 border-b border-stone-200 font-medium">Active ({open.length})</div>
        <table className="table-base">
          <thead><tr><th>Workflow</th><th>Subject</th><th>Status</th><th>Current step</th><th>Started</th></tr></thead>
          <tbody>
            {open.length === 0 && <tr><td colSpan={5} className="px-4 py-6 text-center text-stone-500">No active workflows.</td></tr>}
            {open.map((w) => {
              const current = w.steps.find((s) => s.id === w.currentStepId);
              return (
                <tr key={w.id}>
                  <td>{w.name}</td>
                  <td className="text-xs text-stone-500">{w.entityType ?? "—"}{w.entityId ? ` · ${w.entityId.slice(0, 8)}` : ""}</td>
                  <td><Badge status={w.status} /></td>
                  <td className="text-xs">{current?.name ?? "—"} <span className="text-stone-500">({current?.status ?? "—"})</span></td>
                  <td className="text-xs">{w.startedAt ? formatDate(w.startedAt) : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-8 card overflow-hidden">
        <div className="px-6 py-4 border-b border-stone-200 font-medium">Recent ({completed.length})</div>
        <table className="table-base">
          <thead><tr><th>Workflow</th><th>Status</th><th>Started</th><th>Completed</th></tr></thead>
          <tbody>
            {completed.length === 0 && <tr><td colSpan={4} className="px-4 py-6 text-center text-stone-500">None yet.</td></tr>}
            {completed.map((w) => (
              <tr key={w.id}>
                <td>{w.name}</td>
                <td><Badge status={w.status} /></td>
                <td className="text-xs">{w.startedAt ? formatDate(w.startedAt) : "—"}</td>
                <td className="text-xs">{w.completedAt ? formatDate(w.completedAt) : (w.cancelledAt ? formatDate(w.cancelledAt) : "—")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
