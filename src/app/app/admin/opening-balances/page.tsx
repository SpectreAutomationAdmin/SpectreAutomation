import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { isAppError } from "@/lib/errors";
import { listSets, validateSet, postSet, lockSet } from "@/lib/opening-balance";
import { prisma } from "@/lib/prisma";
import { Badge } from "@/components/Badge";
import { formatDate } from "@/lib/finance";

async function validateAction(setId: string) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const r = await validateSet(setId);
  cookies().set("spectre_ob_msg", r.ok ? "Validation passed" : r.errors.map((e) => e.message).join("; "), { httpOnly: true, sameSite: "strict", maxAge: 30 });
  revalidatePath("/app/admin/opening-balances");
}

async function postAction(setId: string, formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try { await postSet(p, setId, String(formData.get("periodId"))); }
  catch (err) { if (isAppError(err)) cookies().set("spectre_ob_msg", err.safeMessage, { httpOnly: true, sameSite: "strict", maxAge: 30 }); else throw err; }
  revalidatePath("/app/admin/opening-balances");
}

async function lockAction(setId: string) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try { await lockSet(p, setId); }
  catch (err) { if (isAppError(err)) cookies().set("spectre_ob_msg", err.safeMessage, { httpOnly: true, sameSite: "strict", maxAge: 30 }); else throw err; }
  revalidatePath("/app/admin/opening-balances");
}

export default async function OpeningBalancesPage() {
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "gl:post")) redirect("/app/admin");
  const [sets, periods] = await Promise.all([
    listSets(p, clubId),
    prisma.fiscalPeriod.findMany({ where: { clubId, status: { in: ["OPEN", "DRAFT"] } }, orderBy: { startDate: "asc" }, take: 24 }),
  ]);
  const msg = cookies().get("spectre_ob_msg")?.value;
  if (msg) cookies().delete("spectre_ob_msg");

  return (
    <div>
      <h1 className="page-title">Opening balances</h1>
      <p className="mt-1 text-stone-500">Import the trial balance from the legacy system, reconcile to AR / AP subledgers, then post a single opening journal entry.</p>
      {msg && <div className="mt-4 rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-sm">{msg}</div>}

      <div className="mt-6 card overflow-hidden">
        <div className="px-6 py-4 border-b border-stone-200 font-medium">Sets ({sets.length})</div>
        <table className="table-base">
          <thead><tr><th>Label</th><th>Status</th><th>Debits</th><th>Credits</th><th>Posted</th><th></th></tr></thead>
          <tbody>
            {sets.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-stone-500">No opening sets yet. Create one via the Imports tool (domain OPENING_TRIAL_BALANCE) or via API.</td></tr>}
            {sets.map((s) => (
              <tr key={s.id}>
                <td>{s.label}</td>
                <td><Badge status={s.status} /></td>
                <td className="text-xs">{String(s.totalDebits)}</td>
                <td className="text-xs">{String(s.totalCredits)}</td>
                <td className="text-xs">{s.postedAt ? formatDate(s.postedAt) : "—"}</td>
                <td className="text-right">
                  <div className="flex justify-end gap-1">
                    <form action={validateAction.bind(null, s.id)}><button className="btn btn-secondary btn-sm">Validate</button></form>
                    {s.status === "DRAFT" && (
                      <form action={postAction.bind(null, s.id)} className="inline-flex gap-1">
                        <select name="periodId" required className="input text-xs">
                          <option value="">Pick period…</option>
                          {periods.map((pe) => <option key={pe.id} value={pe.id}>{pe.label}</option>)}
                        </select>
                        <button className="btn btn-primary btn-sm">Post</button>
                      </form>
                    )}
                    {s.status === "POSTED" && <form action={lockAction.bind(null, s.id)}><button className="btn btn-secondary btn-sm">Lock</button></form>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-6 text-xs text-stone-500">
        Use <Link href="/app/admin/imports" className="text-club-ink hover:underline">Imports</Link> with domain <code>OPENING_TRIAL_BALANCE</code> to upload a balanced TB from your legacy system, then come back here to validate and post.
      </p>
    </div>
  );
}
