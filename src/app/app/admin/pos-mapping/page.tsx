import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { isAppError } from "@/lib/errors";
import { listMappings, createOrUpdateMapping, deleteMapping, unmappedQueue, reprocessFailedEvent } from "@/lib/pos/mapping";
import { Badge } from "@/components/Badge";
import { formatDate } from "@/lib/finance";

async function upsertAction(formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  try {
    await createOrUpdateMapping(p, clubId, {
      providerKey: String(formData.get("providerKey") ?? ""),
      kind: formData.get("kind") as "MEMBER" | "ITEM" | "LOCATION" | "TERMINAL" | "TAX_CODE" | "DEPARTMENT" | "DISCOUNT" | "TENDER",
      externalId: String(formData.get("externalId") ?? ""),
      spectreId: String(formData.get("spectreId") ?? ""),
    });
  } catch (err) { if (isAppError(err)) redirect(`/app/admin/pos-mapping?error=${encodeURIComponent(err.safeMessage)}`); throw err; }
  revalidatePath("/app/admin/pos-mapping");
}

async function deleteAction(mappingId: string) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  await deleteMapping(p, mappingId);
  revalidatePath("/app/admin/pos-mapping");
}

async function reprocessAction(eventId: string) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  await reprocessFailedEvent(p, eventId);
  revalidatePath("/app/admin/pos-mapping");
}

export default async function PosMappingPage({ searchParams }: { searchParams: { error?: string } }) {
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "settings:read")) redirect("/app/admin");
  const canWrite = hasPermission(p, clubId, "settings:write");

  const [mappings, unmapped] = await Promise.all([
    listMappings(p, clubId),
    unmappedQueue(p, clubId),
  ]);

  return (
    <div>
      <h1 className="page-title">POS Mappings</h1>
      <p className="mt-1 text-stone-500">Map external POS identifiers (Square / Lightspeed / Clover) to Spectre members, items, locations, tax codes, and tender types. Mapping changes are audited.</p>

      {searchParams.error && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{searchParams.error}</div>
      )}

      <div className="mt-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 card overflow-hidden">
          <div className="px-6 py-4 border-b border-stone-200 font-medium">Mappings ({mappings.length})</div>
          <table className="table-base">
            <thead><tr><th>Provider</th><th>Kind</th><th>External ID</th><th>Spectre ID</th><th>Updated</th><th></th></tr></thead>
            <tbody>
              {mappings.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-stone-500">No mappings configured yet.</td></tr>}
              {mappings.map((m) => (
                <tr key={m.id}>
                  <td className="text-xs font-mono">{m.providerKey}</td>
                  <td className="text-xs">{m.kind}</td>
                  <td className="text-xs font-mono">{m.externalId}</td>
                  <td className="text-xs font-mono">{m.spectreId}</td>
                  <td className="text-xs">{formatDate(m.updatedAt)}</td>
                  <td className="text-right text-xs">
                    {canWrite && (
                      <form action={deleteAction.bind(null, m.id)} className="inline"><button className="text-red-600 hover:underline">Delete</button></form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {canWrite && (
          <form action={upsertAction} className="card card-body h-fit space-y-3">
            <h2 className="section-title text-lg">Create / update mapping</h2>
            <div>
              <label className="label">Provider</label>
              <select className="select" name="providerKey" required>
                <option value="square">Square</option>
                <option value="lightspeed">Lightspeed</option>
                <option value="clover">Clover</option>
              </select>
            </div>
            <div>
              <label className="label">Kind</label>
              <select className="select" name="kind">
                <option value="ITEM">Item</option>
                <option value="MEMBER">Member</option>
                <option value="LOCATION">Location</option>
                <option value="TERMINAL">Terminal</option>
                <option value="TAX_CODE">Tax code</option>
                <option value="DEPARTMENT">Department</option>
                <option value="DISCOUNT">Discount</option>
                <option value="TENDER">Tender</option>
              </select>
            </div>
            <div><label className="label">External ID</label><input className="input font-mono" name="externalId" required /></div>
            <div><label className="label">Spectre ID</label><input className="input font-mono" name="spectreId" required /></div>
            <button className="btn btn-primary">Save mapping</button>
          </form>
        )}
      </div>

      <div className="mt-8 card overflow-hidden">
        <div className="px-6 py-4 border-b border-stone-200 font-medium">Failed imports (last 30 days, {unmapped.length})</div>
        <table className="table-base">
          <thead><tr><th>When</th><th>Provider</th><th>Error</th><th></th></tr></thead>
          <tbody>
            {unmapped.length === 0 && <tr><td colSpan={4} className="px-4 py-6 text-center text-stone-500">No failed imports.</td></tr>}
            {unmapped.map((e) => (
              <tr key={e.id}>
                <td className="text-xs">{formatDate(e.occurredAt)}</td>
                <td className="text-xs font-mono">{e.providerKey}</td>
                <td className="text-xs text-red-700 max-w-md truncate">{e.errorMessage}</td>
                <td className="text-right text-xs">
                  {canWrite && e.webhookEventId && (
                    <form action={reprocessAction.bind(null, e.webhookEventId)} className="inline">
                      <button className="text-club-green-700 hover:underline">Reprocess</button>
                    </form>
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

void Link; void Badge;
