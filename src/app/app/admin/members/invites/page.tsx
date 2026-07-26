import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { isAppError } from "@/lib/errors";
import { listInvites, inviteStats, bulkCreateInvites, resendInvite, buildInviteEmail } from "@/lib/member-invites";
import { prisma } from "@/lib/prisma";
import { Badge } from "@/components/Badge";
import { formatDate } from "@/lib/finance";

async function bulkAction() {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  try { await bulkCreateInvites(p, { clubId }); }
  catch (err) { if (isAppError(err)) cookies().set("spectre_invite_error", err.safeMessage, { httpOnly: true, sameSite: "strict", maxAge: 30 }); else throw err; }
  revalidatePath("/app/admin/members/invites");
}

async function resendAction(inviteId: string) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  await resendInvite(p, inviteId).catch(() => undefined);
  revalidatePath("/app/admin/members/invites");
}

export default async function InvitesPage() {
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "users:invite")) redirect("/app/admin");
  const [invites, stats, club] = await Promise.all([
    listInvites(p, clubId),
    inviteStats(p, clubId),
    prisma.club.findUnique({ where: { id: clubId } }),
  ]);
  const error = cookies().get("spectre_invite_error")?.value;
  if (error) cookies().delete("spectre_invite_error");
  const preview = buildInviteEmail({ memberName: "[member]", clubName: club?.name ?? "Your Club", activationUrl: "https://app.spectre/club/activate?token=…" });

  return (
    <div>
      <h1 className="page-title">Member portal invites</h1>
      <p className="mt-1 text-stone-500">Activate imported members with branded portal invites. Tokens are one-time and expire after 30 days by default.</p>
      {error && <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      <div className="mt-4 grid grid-cols-2 md:grid-cols-6 gap-3">
        {["PENDING", "SENT", "OPENED", "ACTIVATED", "EXPIRED", "FAILED"].map((s) => (
          <div key={s} className="card card-body"><div className="text-xs uppercase text-stone-500">{s}</div><div className="mt-1 text-xl font-medium">{stats[s] ?? 0}</div></div>
        ))}
      </div>

      <div className="mt-4 flex items-center gap-3">
        <form action={bulkAction}><button className="btn btn-primary">Send to all active members</button></form>
        <span className="text-xs text-stone-500">Batches are limited to 100 invites at a time to avoid spam classifiers.</span>
      </div>

      <div className="mt-6 card overflow-hidden">
        <div className="px-6 py-4 border-b border-stone-200 font-medium">Recent invites</div>
        <table className="table-base">
          <thead><tr><th>Email</th><th>Status</th><th>Sent</th><th>Activated</th><th>Expires</th><th></th></tr></thead>
          <tbody>
            {invites.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-stone-500">No invites yet.</td></tr>}
            {invites.map((i) => (
              <tr key={i.id}>
                <td className="text-xs">{i.email}</td>
                <td><Badge status={i.status} /></td>
                <td className="text-xs">{i.sentAt ? formatDate(i.sentAt) : "—"}</td>
                <td className="text-xs">{i.activatedAt ? formatDate(i.activatedAt) : "—"}</td>
                <td className="text-xs">{formatDate(i.expiresAt)}</td>
                <td className="text-right">
                  {i.status !== "ACTIVATED" && (
                    <form action={resendAction.bind(null, i.id)}><button className="btn btn-secondary btn-sm">Resend</button></form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <details className="mt-6">
        <summary className="text-sm text-club-ink cursor-pointer">Email preview</summary>
        <div className="mt-2 card card-body whitespace-pre-line text-sm">
          <div className="font-medium">Subject: {preview.subject}</div>
          <hr className="my-2" />
          {preview.body}
        </div>
      </details>
    </div>
  );
}
