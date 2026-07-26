import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission, isSuperAdmin } from "@/lib/rbac";
import { isAppError } from "@/lib/errors";
import { listDomains, addDomain, verifyDomain, activateDomain, deactivateDomain, removeDomain, DOMAIN_KINDS, dnsInstructions } from "@/lib/club-domains";
import { Badge } from "@/components/Badge";
import { formatDate } from "@/lib/finance";

async function addAction(formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = String(formData.get("clubId") ?? (await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" })));
  try {
    await addDomain(p, {
      clubId,
      hostname: String(formData.get("hostname") ?? ""),
      kind: String(formData.get("kind") ?? "PRIMARY") as "PRIMARY" | "ADMIN" | "MEMBER" | "PROSHOP" | "APP",
      isPrimary: formData.get("isPrimary") === "on",
    });
  } catch (err) {
    if (isAppError(err)) cookies().set("spectre_domain_error", err.safeMessage, { httpOnly: true, sameSite: "strict", maxAge: 30 });
    else throw err;
  }
  revalidatePath("/app/admin/settings/domains");
}

async function verifyAction(domainId: string) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try { await verifyDomain(p, domainId); }
  catch (err) { if (isAppError(err)) cookies().set("spectre_domain_error", err.safeMessage, { httpOnly: true, sameSite: "strict", maxAge: 30 }); else throw err; }
  revalidatePath("/app/admin/settings/domains");
}

async function activateAction(domainId: string) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try { await activateDomain(p, domainId); }
  catch (err) { if (isAppError(err)) cookies().set("spectre_domain_error", err.safeMessage, { httpOnly: true, sameSite: "strict", maxAge: 30 }); else throw err; }
  revalidatePath("/app/admin/settings/domains");
}

async function deactivateAction(domainId: string) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try { await deactivateDomain(p, domainId); }
  catch (err) { if (isAppError(err)) cookies().set("spectre_domain_error", err.safeMessage, { httpOnly: true, sameSite: "strict", maxAge: 30 }); else throw err; }
  revalidatePath("/app/admin/settings/domains");
}

async function removeAction(domainId: string) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try { await removeDomain(p, domainId); }
  catch (err) { if (isAppError(err)) cookies().set("spectre_domain_error", err.safeMessage, { httpOnly: true, sameSite: "strict", maxAge: 30 }); else throw err; }
  revalidatePath("/app/admin/settings/domains");
}

export default async function DomainsPage() {
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "settings:write") && !isSuperAdmin(p)) redirect("/app/admin");

  const superMode = isSuperAdmin(p);
  const domains = superMode ? await listDomains(p, {}) : await listDomains(p, { clubId });
  const error = cookies().get("spectre_domain_error")?.value;
  if (error) cookies().delete("spectre_domain_error");

  return (
    <div>
      <Link href="/app/admin/settings" className="text-sm text-stone-500 hover:text-club-ink">← Settings</Link>
      <h1 className="mt-3 page-title">Custom domains</h1>
      <p className="mt-1 text-stone-500">
        Map external hostnames to {superMode ? "any club" : "this club"}. Only ACTIVE
        domains route traffic; PENDING / VERIFIED are reserved but invisible
        to visitors.
      </p>
      {error && <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      <div className="mt-6 card card-body">
        <h2 className="section-title text-lg">Add a hostname</h2>
        <form action={addAction} className="mt-3 grid grid-cols-1 md:grid-cols-5 gap-3 items-end">
          {superMode && (
            <div className="md:col-span-1">
              <label className="block text-xs uppercase text-stone-500">Club ID</label>
              <input name="clubId" required className="input mt-1 text-sm w-full" placeholder="cl..." />
            </div>
          )}
          <div className={superMode ? "md:col-span-2" : "md:col-span-3"}>
            <label className="block text-xs uppercase text-stone-500">Hostname</label>
            <input name="hostname" required className="input mt-1 text-sm w-full" placeholder="www.example.com" />
          </div>
          <div>
            <label className="block text-xs uppercase text-stone-500">Kind</label>
            <select name="kind" className="input mt-1 text-sm w-full">
              {DOMAIN_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-stone-600 flex items-center gap-2">
              <input type="checkbox" name="isPrimary" /> Primary
            </label>
          </div>
          <button className="btn btn-primary md:col-span-5">Add domain</button>
        </form>
      </div>

      <div className="mt-6 card overflow-hidden">
        <div className="px-6 py-4 border-b border-stone-200 font-medium">Domains ({domains.length})</div>
        <table className="table-base">
          <thead><tr><th>Hostname</th>{superMode && <th>Club</th>}<th>Kind</th><th>Status</th><th>Verified</th><th>Activated</th><th></th></tr></thead>
          <tbody>
            {domains.length === 0 && <tr><td colSpan={superMode ? 7 : 6} className="px-4 py-6 text-center text-stone-500">No domains configured yet.</td></tr>}
            {domains.map((d) => {
              const dns = dnsInstructions({ hostname: d.hostname, verificationToken: d.verificationToken });
              return (
                <tr key={d.id}>
                  <td className="font-mono text-xs">{d.hostname}{d.isPrimary && <span className="ml-2 text-xs uppercase text-club-green-700">primary</span>}</td>
                  {superMode && <td className="text-xs">{("club" in d) ? (d as { club: { name: string } }).club.name : "—"}</td>}
                  <td className="text-xs">{d.kind}</td>
                  <td><Badge status={d.status} /></td>
                  <td className="text-xs">{d.verifiedAt ? formatDate(d.verifiedAt) : "—"}</td>
                  <td className="text-xs">{d.activatedAt ? formatDate(d.activatedAt) : "—"}</td>
                  <td className="text-right">
                    <div className="flex flex-col items-end gap-1">
                      {d.status === "PENDING" && (
                        <details className="text-xs">
                          <summary className="text-club-ink cursor-pointer">DNS setup</summary>
                          <div className="mt-1 rounded border border-stone-200 bg-stone-50 p-2 max-w-md text-left">
                            <div className="font-mono text-[11px] break-all">{dns.txtRecord.name} TXT {dns.txtRecord.value}</div>
                            <div className="mt-1 font-mono text-[11px] break-all">{dns.cnameRecord.name} CNAME {dns.cnameRecord.value}</div>
                            <p className="mt-1 text-[11px] text-stone-500">{dns.note}</p>
                          </div>
                        </details>
                      )}
                      <div className="flex gap-1">
                        {d.status === "PENDING" && (
                          <form action={verifyAction.bind(null, d.id)}><button className="btn btn-secondary btn-sm">Mark verified</button></form>
                        )}
                        {d.status === "VERIFIED" && (
                          <form action={activateAction.bind(null, d.id)}><button className="btn btn-primary btn-sm">Activate</button></form>
                        )}
                        {d.status === "ACTIVE" && (
                          <form action={deactivateAction.bind(null, d.id)}><button className="btn btn-secondary btn-sm">Deactivate</button></form>
                        )}
                        {(d.status === "PENDING" || d.status === "FAILED") && (
                          <form action={removeAction.bind(null, d.id)}><button className="btn btn-secondary btn-sm">Remove</button></form>
                        )}
                      </div>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="mt-6 text-xs text-stone-500">
        Need to test locally? Set <code className="font-mono">SPECTRE_LOCAL_PIN_CLUB_SLUG=&lt;slug&gt;</code> in
        your environment, restart the dev server, and your <code className="font-mono">localhost:3000</code> requests
        will resolve to that club. Alternatively, register
        <code className="font-mono">&lt;slug&gt;.localtest.me</code> as a domain — it always resolves to 127.0.0.1.
      </p>
    </div>
  );
}
