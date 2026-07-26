import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { isAppError } from "@/lib/errors";
import { bounceSummary, recentFailedInvites, listSuppressions, addSuppression, removeSuppression, resendWithCorrectedEmail } from "@/lib/email-delivery";
import { Badge } from "@/components/Badge";
import { formatDate } from "@/lib/finance";

async function addSuppressionAction(formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  try {
    await addSuppression(p, {
      clubId,
      email: String(formData.get("email") ?? ""),
      reason: String(formData.get("reason") ?? "MANUAL") as "HARD_BOUNCE" | "SPAM" | "UNSUBSCRIBE" | "MANUAL",
    });
  } catch (err) {
    if (isAppError(err)) cookies().set("spectre_email_error", err.safeMessage, { httpOnly: true, sameSite: "strict", maxAge: 30 });
    else throw err;
  }
  revalidatePath("/app/admin/notifications/email-health");
}

async function removeSuppressionAction(id: string) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  await removeSuppression(p, id).catch(() => undefined);
  revalidatePath("/app/admin/notifications/email-health");
}

async function resendCorrectedAction(inviteId: string, formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try {
    await resendWithCorrectedEmail(p, { inviteId, newEmail: String(formData.get("newEmail") ?? "") });
  } catch (err) {
    if (isAppError(err)) cookies().set("spectre_email_error", err.safeMessage, { httpOnly: true, sameSite: "strict", maxAge: 30 });
    else throw err;
  }
  revalidatePath("/app/admin/notifications/email-health");
}

export default async function EmailHealthPage() {
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "notifications:read")) redirect("/app/admin");
  const [summary, failedInvites, suppressions] = await Promise.all([
    bounceSummary(clubId, 14),
    recentFailedInvites(clubId),
    listSuppressions({ clubId }),
  ]);
  const error = cookies().get("spectre_email_error")?.value;
  if (error) cookies().delete("spectre_email_error");

  return (
    <div>
      <Link href="/app/admin/notifications" className="text-sm text-stone-500 hover:text-club-ink">← Notifications</Link>
      <h1 className="mt-3 page-title">Email health</h1>
      <p className="mt-1 text-stone-500">Delivery events from the configured provider + suppression list for the last 14 days.</p>
      {error && <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      <div className="mt-6 grid grid-cols-2 md:grid-cols-4 gap-3">
        {(["DELIVERED", "HARD_BOUNCE", "SOFT_BOUNCE", "SPAM_COMPLAINT", "UNSUBSCRIBE", "FAILED", "DELAYED", "OPENED"] as const).map((k) => (
          <div key={k} className="card card-body">
            <div className="text-xs uppercase text-stone-500">{k}</div>
            <div className={`mt-1 text-2xl font-medium ${k === "HARD_BOUNCE" || k === "SPAM_COMPLAINT" || k === "FAILED" ? "text-red-700" : ""}`}>{summary[k] ?? 0}</div>
          </div>
        ))}
      </div>

      <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card overflow-hidden">
          <div className="px-6 py-4 border-b border-stone-200 font-medium">Failed invites ({failedInvites.length})</div>
          <table className="table-base">
            <thead><tr><th>Email</th><th>Last error</th><th></th></tr></thead>
            <tbody>
              {failedInvites.length === 0 && <tr><td colSpan={3} className="px-4 py-6 text-center text-stone-500">No failed invites.</td></tr>}
              {failedInvites.map((i) => (
                <tr key={i.id}>
                  <td className="text-xs">{i.email}</td>
                  <td className="text-xs">{i.lastError ?? "—"}</td>
                  <td className="text-right">
                    <details>
                      <summary className="text-xs text-club-ink cursor-pointer">Resend</summary>
                      <form action={resendCorrectedAction.bind(null, i.id)} className="mt-1 flex gap-1">
                        <input name="newEmail" required type="email" placeholder="Corrected email" className="input text-xs" />
                        <button className="btn btn-secondary btn-sm">Send</button>
                      </form>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card overflow-hidden">
          <div className="px-6 py-4 border-b border-stone-200 flex items-center justify-between">
            <div className="font-medium">Suppression list ({suppressions.length})</div>
            <details>
              <summary className="text-xs text-stone-500 cursor-pointer">+ Add</summary>
              <form action={addSuppressionAction} className="mt-2 flex flex-col gap-1">
                <input name="email" type="email" required placeholder="address@example.com" className="input text-xs" />
                <select name="reason" className="input text-xs">
                  <option value="MANUAL">MANUAL</option>
                  <option value="HARD_BOUNCE">HARD_BOUNCE</option>
                  <option value="SPAM">SPAM</option>
                  <option value="UNSUBSCRIBE">UNSUBSCRIBE</option>
                </select>
                <button className="btn btn-primary btn-sm">Add</button>
              </form>
            </details>
          </div>
          <table className="table-base">
            <thead><tr><th>Email</th><th>Reason</th><th>Added</th><th></th></tr></thead>
            <tbody>
              {suppressions.length === 0 && <tr><td colSpan={4} className="px-4 py-6 text-center text-stone-500">No suppressed addresses.</td></tr>}
              {suppressions.map((s) => (
                <tr key={s.id}>
                  <td className="text-xs">{s.email}</td>
                  <td className="text-xs"><Badge status={s.reason} /></td>
                  <td className="text-xs">{formatDate(s.addedAt)}</td>
                  <td className="text-right">
                    <form action={removeSuppressionAction.bind(null, s.id)}><button className="btn btn-secondary btn-sm">Remove</button></form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
