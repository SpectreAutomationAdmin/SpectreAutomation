import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { listApiKeys, createApiKey, revokeApiKey, API_PERMISSIONS } from "@/lib/api/keys";
import { isAppError } from "@/lib/errors";
import { Badge } from "@/components/Badge";
import { formatDate } from "@/lib/finance";

async function createAction(formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  try {
    const perms = formData.getAll("permissions").map((v) => String(v));
    const result = await createApiKey(p, clubId, {
      name: String(formData.get("name") ?? ""),
      permissions: perms,
    });
    // Show the raw key once via a flash cookie (server-action-only readback).
    cookies().set("spectre_apikey_flash", result.rawKey, { httpOnly: true, sameSite: "strict", maxAge: 60 });
  } catch (err) { if (isAppError(err)) redirect(`/app/admin/api-keys?error=${encodeURIComponent(err.safeMessage)}`); throw err; }
  revalidatePath("/app/admin/api-keys");
}

async function revokeAction(keyId: string) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  await revokeApiKey(p, keyId);
  revalidatePath("/app/admin/api-keys");
}

export default async function ApiKeysPage({ searchParams }: { searchParams: { error?: string } }) {
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "settings:read")) redirect("/app/admin");
  const canWrite = hasPermission(p, clubId, "settings:write");
  const keys = await listApiKeys(p, clubId);
  const flash = cookies().get("spectre_apikey_flash")?.value;
  if (flash) cookies().delete("spectre_apikey_flash");

  return (
    <div>
      <h1 className="page-title">External API Keys</h1>
      <p className="mt-1 text-stone-500">Bearer-token API keys for partner integrations. The raw key is shown only once — copy it immediately.</p>

      {searchParams.error && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{searchParams.error}</div>
      )}

      {flash && (
        <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm">
          <div className="font-medium text-amber-900">Your new API key</div>
          <code className="mt-2 block font-mono text-xs break-all bg-white px-3 py-2 rounded border border-amber-200">{flash}</code>
          <div className="mt-2 text-xs text-amber-900">This is the only time the full key will be displayed. Store it in a secrets manager now.</div>
        </div>
      )}

      <div className="mt-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 card overflow-hidden">
          <div className="px-6 py-4 border-b border-stone-200 font-medium">Keys ({keys.length})</div>
          <table className="table-base">
            <thead><tr><th>Name</th><th>Prefix</th><th>Status</th><th>Permissions</th><th>Last used</th><th></th></tr></thead>
            <tbody>
              {keys.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-stone-500">No API keys.</td></tr>}
              {keys.map((k) => (
                <tr key={k.id}>
                  <td>{k.name}</td>
                  <td className="text-xs font-mono">{k.keyPrefix}…</td>
                  <td><Badge status={k.status} /></td>
                  <td className="text-xs">{k.permissions.map((p) => p.permission).join(", ") || "—"}</td>
                  <td className="text-xs">{k.lastUsedAt ? formatDate(k.lastUsedAt) : "—"}</td>
                  <td className="text-right text-xs">
                    {canWrite && k.status === "ACTIVE" && (
                      <form action={revokeAction.bind(null, k.id)} className="inline"><button className="text-red-600 hover:underline">Revoke</button></form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {canWrite && (
          <form action={createAction} className="card card-body h-fit space-y-3">
            <h2 className="section-title text-lg">New API key</h2>
            <div><label className="label">Name</label><input className="input" name="name" required placeholder="Pilot — Northbound" /></div>
            <div>
              <label className="label">Scoped permissions</label>
              <div className="mt-1 space-y-1 text-sm">
                {API_PERMISSIONS.map((perm) => (
                  <label key={perm} className="flex items-center gap-2">
                    <input type="checkbox" name="permissions" value={perm} />
                    <span className="font-mono text-xs">{perm}</span>
                  </label>
                ))}
              </div>
            </div>
            <button className="btn btn-primary">Create</button>
          </form>
        )}
      </div>

      <div className="mt-6 text-xs text-stone-500">
        Spec: <Link href="/api/openapi.json" className="text-club-green-700 hover:underline">/api/openapi.json</Link>
      </div>
    </div>
  );
}
