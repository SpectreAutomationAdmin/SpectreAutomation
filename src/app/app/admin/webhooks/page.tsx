import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { isAppError } from "@/lib/errors";
import { listSubscriptions, listDeliveries, createSubscription, disableSubscription, ALL_WEBHOOK_EVENTS } from "@/lib/webhooks";
import { replayWebhookDelivery } from "@/lib/ops/replay";
import { Badge } from "@/components/Badge";
import { formatDate } from "@/lib/finance";

async function createAction(formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  try {
    const events = formData.getAll("events").map(String);
    const result = await createSubscription(p, clubId, {
      name: String(formData.get("name") ?? ""),
      url: String(formData.get("url") ?? ""),
      events,
    });
    cookies().set("spectre_webhook_secret_flash", result.secret, { httpOnly: true, sameSite: "strict", maxAge: 60 });
  } catch (err) { if (isAppError(err)) redirect(`/app/admin/webhooks?error=${encodeURIComponent(err.safeMessage)}`); throw err; }
  revalidatePath("/app/admin/webhooks");
}

async function disableAction(subscriptionId: string) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  await disableSubscription(p, subscriptionId);
  revalidatePath("/app/admin/webhooks");
}

async function replayAction(deliveryId: string) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  await replayWebhookDelivery(p, deliveryId);
  revalidatePath("/app/admin/webhooks");
}

export default async function WebhooksPage({ searchParams }: { searchParams: { error?: string } }) {
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "settings:read")) redirect("/app/admin");
  const canWrite = hasPermission(p, clubId, "settings:write");

  const [subs, deliveries] = await Promise.all([
    listSubscriptions(p, clubId),
    listDeliveries(p, clubId),
  ]);
  const flash = cookies().get("spectre_webhook_secret_flash")?.value;
  if (flash) cookies().delete("spectre_webhook_secret_flash");

  return (
    <div>
      <h1 className="page-title">Outbound Webhooks</h1>
      <p className="mt-1 text-stone-500">Send signed event notifications to partner systems. HMAC-SHA256 signing keeps payloads tamper-proof; retries are queue-driven with exponential backoff.</p>

      {searchParams.error && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{searchParams.error}</div>
      )}

      {flash && (
        <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm">
          <div className="font-medium text-amber-900">Your webhook signing secret</div>
          <code className="mt-2 block font-mono text-xs break-all bg-white px-3 py-2 rounded border border-amber-200">{flash}</code>
          <div className="mt-2 text-xs text-amber-900">Shown only once. Subscribers verify deliveries with <span className="font-mono">HMAC-SHA256(timestamp + &quot;.&quot; + body, secret)</span>.</div>
        </div>
      )}

      <div className="mt-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 card overflow-hidden">
          <div className="px-6 py-4 border-b border-stone-200 font-medium">Subscriptions ({subs.length})</div>
          <table className="table-base">
            <thead><tr><th>Name</th><th>URL</th><th>Events</th><th>Status</th><th>Last delivery</th><th></th></tr></thead>
            <tbody>
              {subs.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-stone-500">No subscriptions configured.</td></tr>}
              {subs.map((s) => (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  <td className="text-xs font-mono truncate max-w-xs">{s.url}</td>
                  <td className="text-xs">{s.events.split(",").length} event(s)</td>
                  <td><Badge status={s.status} /></td>
                  <td className="text-xs">{s.lastDeliveryAt ? formatDate(s.lastDeliveryAt) : "—"}</td>
                  <td className="text-right text-xs">
                    {canWrite && s.status === "ACTIVE" && (
                      <form action={disableAction.bind(null, s.id)} className="inline"><button className="text-red-600 hover:underline">Disable</button></form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {canWrite && (
          <form action={createAction} className="card card-body h-fit space-y-3">
            <h2 className="section-title text-lg">New subscription</h2>
            <div><label className="label">Name</label><input className="input" name="name" required maxLength={160} /></div>
            <div><label className="label">URL</label><input className="input font-mono text-xs" name="url" type="url" required placeholder="https://partner.example.com/webhooks" /></div>
            <div>
              <label className="label">Events</label>
              <div className="mt-1 max-h-48 overflow-y-auto space-y-1">
                {ALL_WEBHOOK_EVENTS.map((evt) => (
                  <label key={evt} className="flex items-center gap-2 text-xs">
                    <input type="checkbox" name="events" value={evt} />
                    <span className="font-mono">{evt}</span>
                  </label>
                ))}
              </div>
            </div>
            <button className="btn btn-primary">Create</button>
          </form>
        )}
      </div>

      <div className="mt-8 card overflow-hidden">
        <div className="px-6 py-4 border-b border-stone-200 font-medium">Recent deliveries</div>
        <table className="table-base">
          <thead><tr><th>When</th><th>Subscription</th><th>Event</th><th>Status</th><th>HTTP</th><th>Attempts</th><th></th></tr></thead>
          <tbody>
            {deliveries.length === 0 && <tr><td colSpan={7} className="px-4 py-6 text-center text-stone-500">No deliveries yet.</td></tr>}
            {deliveries.map((d) => (
              <tr key={d.id}>
                <td className="text-xs">{formatDate(d.createdAt)}</td>
                <td className="text-xs">{d.subscription.name}</td>
                <td className="text-xs font-mono">{d.eventType}</td>
                <td><Badge status={d.status} /></td>
                <td className="text-xs">{d.responseCode ?? "—"}</td>
                <td className="text-xs">{d.attempts}</td>
                <td className="text-right text-xs">
                  {canWrite && d.status === "FAILED" && (
                    <form action={replayAction.bind(null, d.id)} className="inline"><button className="text-club-green-700 hover:underline">Replay</button></form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

void Link;
