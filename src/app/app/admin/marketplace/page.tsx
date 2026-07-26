import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { isAppError } from "@/lib/errors";
import { listApps, listInstalls, installApp, uninstallApp } from "@/lib/marketplace";
import { Badge } from "@/components/Badge";
import { formatDate } from "@/lib/finance";

async function installAction(formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  try {
    await installApp(p, { appId: String(formData.get("appId")), clubId });
  } catch (err) {
    if (isAppError(err)) cookies().set("spectre_marketplace_error", err.safeMessage, { httpOnly: true, sameSite: "strict", maxAge: 30 });
    else throw err;
  }
  revalidatePath("/app/admin/marketplace");
}

async function uninstallAction(formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try {
    await uninstallApp(p, String(formData.get("installId")), String(formData.get("reason") ?? ""));
  } catch (err) {
    if (isAppError(err)) cookies().set("spectre_marketplace_error", err.safeMessage, { httpOnly: true, sameSite: "strict", maxAge: 30 });
    else throw err;
  }
  revalidatePath("/app/admin/marketplace");
}

export default async function MarketplacePage() {
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "settings:read")) redirect("/app/admin");
  const canWrite = hasPermission(p, clubId, "settings:write");

  const [apps, installs] = await Promise.all([listApps(), listInstalls(p, clubId)]);
  const installedIds = new Set(installs.filter((i) => i.status === "ACTIVE").map((i) => apps.find((a) => a.key === i.appKey)?.id).filter(Boolean) as string[]);
  const error = cookies().get("spectre_marketplace_error")?.value;
  if (error) cookies().delete("spectre_marketplace_error");

  return (
    <div>
      <h1 className="page-title">Marketplace</h1>
      <p className="mt-1 text-stone-500">Third-party app installations for this club.</p>
      {error && <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      <h2 className="section-title text-lg mt-8">Installed apps</h2>
      <div className="mt-2 card overflow-hidden">
        <table className="table-base">
          <thead><tr><th>App</th><th>Status</th><th>Scopes</th><th>Installed</th><th></th></tr></thead>
          <tbody>
            {installs.length === 0 && <tr><td colSpan={5} className="px-4 py-6 text-center text-stone-500">No apps installed yet.</td></tr>}
            {installs.map((i) => (
              <tr key={i.id}>
                <td>{i.appName} <span className="text-xs text-stone-500 ml-1 font-mono">{i.appKey}</span></td>
                <td><Badge status={i.status} /></td>
                <td className="text-xs font-mono">{i.permissions.join(", ") || "—"}</td>
                <td className="text-xs">{formatDate(i.installedAt)}</td>
                <td className="text-right">
                  {canWrite && i.status === "ACTIVE" && (
                    <form action={uninstallAction}>
                      <input type="hidden" name="installId" value={i.id} />
                      <button className="btn btn-secondary btn-sm" formNoValidate>Uninstall</button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="section-title text-lg mt-8">Available apps</h2>
      <div className="mt-2 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {apps.length === 0 && <div className="text-stone-500">No published apps available.</div>}
        {apps.map((a) => (
          <div key={a.id} className="card card-body">
            <div className="flex items-start justify-between">
              <div>
                <div className="font-medium">{a.name}</div>
                <div className="text-xs text-stone-500 font-mono">{a.key}</div>
              </div>
              {installedIds.has(a.id) && <Badge status="INSTALLED" />}
            </div>
            {a.description && <p className="mt-2 text-sm text-stone-600">{a.description}</p>}
            {a.defaultScopes.length > 0 && (
              <div className="mt-2 text-xs text-stone-500">Scopes: <span className="font-mono">{a.defaultScopes.join(", ")}</span></div>
            )}
            {canWrite && !installedIds.has(a.id) && (
              <form action={installAction} className="mt-3">
                <input type="hidden" name="appId" value={a.id} />
                <button className="btn btn-primary btn-sm w-full" formNoValidate>Install</button>
              </form>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
