import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { overrideException, resolveException } from "@/lib/ap/exceptions";
import { isAppError } from "@/lib/errors";
import { Badge } from "@/components/Badge";
import { formatDate } from "@/lib/finance";

async function overrideAction(id: string, formData: FormData) {
  "use server"; const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try { await overrideException(p, id, String(formData.get("note") ?? "")); } catch (err) { if (isAppError(err)) redirect(`/app/admin/ap/exceptions?error=${encodeURIComponent(err.safeMessage)}`); throw err; }
  revalidatePath("/app/admin/ap/exceptions");
}
async function resolveAction(id: string, formData: FormData) {
  "use server"; const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try { await resolveException(p, id, String(formData.get("note") ?? "")); } catch (err) { if (isAppError(err)) redirect(`/app/admin/ap/exceptions?error=${encodeURIComponent(err.safeMessage)}`); throw err; }
  revalidatePath("/app/admin/ap/exceptions");
}

export default async function APExceptionsPage({ searchParams }: { searchParams: { error?: string } }) {
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "ap:invoice:view")) redirect("/app/admin");
  const canOverride = hasPermission(p, clubId, "ap:exception:override");

  const exceptions = await prisma.aPException.findMany({
    where: { clubId, status: "OPEN" },
    orderBy: [{ severity: "desc" }, { createdAt: "desc" }],
    take: 200,
  });

  return (
    <div>
      <Link href="/app/admin/ap" className="text-sm text-stone-500 hover:text-club-ink">← AP</Link>
      <h1 className="page-title mt-3">AP Exceptions</h1>
      <p className="mt-1 text-stone-500">Risk flags raised by the AP engine. HIGH-severity flags require override permission.</p>

      {searchParams.error && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{searchParams.error}</div>
      )}

      <div className="mt-6 card overflow-hidden">
        <table className="table-base">
          <thead><tr><th>Created</th><th>Severity</th><th>Kind</th><th>Description</th><th>Invoice</th><th></th></tr></thead>
          <tbody>
            {exceptions.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-stone-500">No open exceptions.</td></tr>}
            {exceptions.map((e) => (
              <tr key={e.id}>
                <td className="text-xs text-stone-500">{formatDate(e.createdAt)}</td>
                <td><Badge status={e.severity === "HIGH" ? "FAILED" : e.severity === "MEDIUM" ? "PENDING" : "DRAFT"} label={e.severity} /></td>
                <td className="text-xs">{e.kind.replace(/_/g, " ")}</td>
                <td className="text-stone-600 text-xs">{e.description}</td>
                <td className="font-mono text-xs">{e.invoiceId ? <Link href={`/app/admin/ap/invoices/${e.invoiceId}`} className="hover:text-club-green-700">{e.invoiceId.slice(0, 8)}…</Link> : "—"}</td>
                <td className="text-right">
                  <form action={resolveAction.bind(null, e.id)} className="inline mr-2">
                    <input className="input inline-block w-32" name="note" placeholder="Resolution note" />
                    <button className="text-xs text-club-green-700 hover:underline ml-1">Resolve</button>
                  </form>
                  {canOverride && (
                    <form action={overrideAction.bind(null, e.id)} className="inline">
                      <input className="input inline-block w-32" name="note" placeholder="Override note" />
                      <button className="text-xs text-red-600 hover:underline ml-1">Override</button>
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
