import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { isAppError } from "@/lib/errors";
import { rotate, activate, rollback, expirePrevious, listVersions, listRotationHistory } from "@/lib/webhooks/rotation";
import { prisma } from "@/lib/prisma";
import { Badge } from "@/components/Badge";
import { formatDate } from "@/lib/finance";

async function rotateAction(subscriptionId: string) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try {
    const result = await rotate(p, { subscriptionId });
    cookies().set("spectre_webhook_rotation_flash", result.secret, { httpOnly: true, sameSite: "strict", maxAge: 60 });
  } catch (err) { if (isAppError(err)) redirect(`/app/admin/webhooks/${subscriptionId}/rotation?error=${encodeURIComponent(err.safeMessage)}`); throw err; }
  revalidatePath(`/app/admin/webhooks/${subscriptionId}/rotation`);
}

async function activateAction(subscriptionId: string) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try { await activate(p, subscriptionId); }
  catch (err) { if (isAppError(err)) redirect(`/app/admin/webhooks/${subscriptionId}/rotation?error=${encodeURIComponent(err.safeMessage)}`); throw err; }
  revalidatePath(`/app/admin/webhooks/${subscriptionId}/rotation`);
}

async function rollbackAction(subscriptionId: string, formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  await rollback(p, subscriptionId, String(formData.get("reason") ?? ""));
  revalidatePath(`/app/admin/webhooks/${subscriptionId}/rotation`);
}

async function expireAction(subscriptionId: string) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  await expirePrevious(p, subscriptionId);
  revalidatePath(`/app/admin/webhooks/${subscriptionId}/rotation`);
}

export default async function RotationPage({ params, searchParams }: { params: { id: string }; searchParams: { error?: string } }) {
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const sub = await prisma.webhookSubscription.findUnique({ where: { id: params.id } });
  if (!sub) notFound();
  if (!hasPermission(p, sub.clubId, "settings:read")) redirect("/app/admin");
  const canWrite = hasPermission(p, sub.clubId, "settings:write");
  const [versions, history] = await Promise.all([
    listVersions(p, params.id),
    listRotationHistory(p, params.id),
  ]);
  const flash = cookies().get("spectre_webhook_rotation_flash")?.value;
  if (flash) cookies().delete("spectre_webhook_rotation_flash");
  const hasPending = versions.some((v) => v.state === "PENDING");
  const hasExpired = versions.some((v) => v.state === "EXPIRED");

  return (
    <div>
      <Link href="/app/admin/webhooks" className="text-sm text-stone-500 hover:text-club-ink">← Webhooks</Link>
      <h1 className="mt-3 page-title">Rotate signing secret</h1>
      <p className="mt-1 text-stone-500"><strong>{sub.name}</strong> · <span className="font-mono text-xs">{sub.url}</span></p>

      {searchParams.error && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{searchParams.error}</div>
      )}

      {flash && (
        <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm">
          <div className="font-medium text-amber-900">Your new signing secret</div>
          <code className="mt-2 block font-mono text-xs break-all bg-white px-3 py-2 rounded border border-amber-200">{flash}</code>
          <div className="mt-2 text-xs text-amber-900">Shown only once. Distribute it to your partner before activating so receivers can verify with the new signature.</div>
        </div>
      )}

      <div className="mt-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 card overflow-hidden">
          <div className="px-6 py-4 border-b border-stone-200 font-medium">Secret versions ({versions.length})</div>
          <table className="table-base">
            <thead><tr><th>v</th><th>State</th><th>Secret</th><th>Activated</th><th>Grace expires</th><th>Revoked</th></tr></thead>
            <tbody>
              {versions.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-stone-500">No versions yet. Click <em>Rotate now</em>.</td></tr>}
              {versions.map((v) => (
                <tr key={v.id}>
                  <td className="text-xs font-mono">{v.versionNumber}</td>
                  <td><Badge status={v.state} /></td>
                  <td className="text-xs font-mono">{v.secret}</td>
                  <td className="text-xs">{v.activatedAt ? formatDate(v.activatedAt) : "—"}</td>
                  <td className="text-xs">{v.expiresAt ? formatDate(v.expiresAt) : "—"}</td>
                  <td className="text-xs">{v.revokedAt ? formatDate(v.revokedAt) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {canWrite && (
          <div className="space-y-3 card card-body h-fit">
            <h2 className="section-title text-lg">Rotation actions</h2>
            {!hasPending && (
              <form action={rotateAction.bind(null, params.id)}><button className="btn btn-primary w-full">Rotate now (creates pending)</button></form>
            )}
            {hasPending && (
              <>
                <form action={activateAction.bind(null, params.id)}><button className="btn btn-primary w-full">Activate pending (start grace window)</button></form>
                <form action={rollbackAction.bind(null, params.id)} className="space-y-2">
                  <input className="input text-xs" name="reason" placeholder="Rollback reason" />
                  <button className="btn btn-secondary w-full">Roll back pending</button>
                </form>
              </>
            )}
            {hasExpired && (
              <form action={expireAction.bind(null, params.id)}><button className="btn btn-secondary w-full">Expire previous secret (end grace)</button></form>
            )}
          </div>
        )}
      </div>

      <div className="mt-8 card overflow-hidden">
        <div className="px-6 py-4 border-b border-stone-200 font-medium">Rotation history</div>
        <table className="table-base">
          <thead><tr><th>When</th><th>Action</th><th>By</th><th>Reason</th></tr></thead>
          <tbody>
            {history.length === 0 && <tr><td colSpan={4} className="px-4 py-6 text-center text-stone-500">No history yet.</td></tr>}
            {history.map((h) => (
              <tr key={h.id}>
                <td className="text-xs">{formatDate(h.occurredAt)}</td>
                <td className="text-xs font-mono">{h.action}</td>
                <td className="text-xs">{h.byUserId ? h.byUserId.slice(0, 8) : "—"}</td>
                <td className="text-xs">{h.reason ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
