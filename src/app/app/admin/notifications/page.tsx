import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { notificationService } from "@/lib/enterprise";
import { prisma } from "@/lib/prisma";
import { Badge } from "@/components/Badge";
import { formatDate } from "@/lib/finance";

export default async function NotificationsPage() {
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "notifications:read")) redirect("/app/admin");

  const [inbox, templates, recentComms] = await Promise.all([
    notificationService.listNotificationsForUser(p, clubId),
    notificationService.listTemplates(p, clubId),
    prisma.communicationLog.findMany({ where: { clubId }, orderBy: { occurredAt: "desc" }, take: 25 }),
  ]);
  const unread = inbox.filter((n) => !n.readAt).length;

  return (
    <div>
      <h1 className="page-title">Notifications & Communications</h1>
      <p className="mt-1 text-stone-500">Centralized inbox, template library, and append-only communication log.</p>

      <div className="mt-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 card overflow-hidden">
          <div className="px-6 py-4 border-b border-stone-200 flex items-center justify-between">
            <div className="font-medium">Inbox ({unread} unread)</div>
            <div className="text-xs text-stone-500">{inbox.length} total</div>
          </div>
          <ul className="divide-y divide-stone-200 max-h-[60vh] overflow-y-auto">
            {inbox.length === 0 && <li className="px-6 py-6 text-center text-stone-500">No notifications.</li>}
            {inbox.map((n) => (
              <li key={n.id} className={`px-6 py-3 text-sm ${n.readAt ? "" : "bg-amber-50"}`}>
                <div className="flex items-center justify-between">
                  <span className="font-medium">{n.subject}</span>
                  <span className="text-xs text-stone-500">{formatDate(n.createdAt)} · {n.channel}</span>
                </div>
                <p className="mt-1 text-xs text-stone-600 whitespace-pre-wrap">{n.body.slice(0, 200)}</p>
              </li>
            ))}
          </ul>
        </div>

        <div className="card overflow-hidden">
          <div className="px-6 py-4 border-b border-stone-200 font-medium">Templates ({templates.length})</div>
          <ul className="divide-y divide-stone-200 max-h-[60vh] overflow-y-auto">
            {templates.map((t) => (
              <li key={t.id} className="px-6 py-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="font-medium">{t.name}</span>
                  <span className="text-xs text-stone-500">{t.channel}</span>
                </div>
                <div className="mt-1 text-xs font-mono text-stone-500">{t.key}</div>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="mt-8 card overflow-hidden">
        <div className="px-6 py-4 border-b border-stone-200 font-medium">Communication log (last 25)</div>
        <table className="table-base">
          <thead><tr><th>When</th><th>Channel</th><th>To</th><th>Subject</th><th>Status</th></tr></thead>
          <tbody>
            {recentComms.length === 0 && <tr><td colSpan={5} className="px-4 py-6 text-center text-stone-500">No outbound messages yet.</td></tr>}
            {recentComms.map((c) => (
              <tr key={c.id}>
                <td className="text-xs">{formatDate(c.occurredAt)}</td>
                <td className="text-xs">{c.channel}</td>
                <td className="text-xs">{c.toAddress ?? c.toUserId ?? c.toMemberId ?? "—"}</td>
                <td className="text-xs">{c.subject ?? "—"}</td>
                <td><Badge status={c.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

void Link;
