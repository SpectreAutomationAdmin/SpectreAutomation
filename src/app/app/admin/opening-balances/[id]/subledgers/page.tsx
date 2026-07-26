import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { isAppError } from "@/lib/errors";
import { getSet, uploadSubledger, subledgerSummary } from "@/lib/opening-balance";
import { Badge } from "@/components/Badge";

function parseCsv(text: string): Array<{ entityRef: string; balance: number; note?: string }> {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const headers = lines[0].split(",").map((h) => h.trim());
  const refIdx = headers.findIndex((h) => /(member ?#|member ?number|vendor|legal ?name|entity)/i.test(h));
  const balIdx = headers.findIndex((h) => /(balance|outstanding|amount)/i.test(h));
  if (refIdx < 0 || balIdx < 0) return [];
  return lines.slice(1).map((line) => {
    const cols = line.split(",");
    const balance = Number(String(cols[balIdx]).replace(/,/g, "")) || 0;
    return { entityRef: String(cols[refIdx] ?? "").trim(), balance };
  }).filter((r) => r.entityRef.length > 0);
}

async function uploadAction(setId: string, formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const csv = String(formData.get("csv") ?? "");
  const kind = String(formData.get("kind") ?? "AR") as "AR" | "AP";
  const rows = parseCsv(csv);
  if (rows.length === 0) {
    cookies().set("spectre_subledger_error", "Could not parse CSV — first line must include entity ref + balance columns.", { httpOnly: true, sameSite: "strict", maxAge: 30 });
    revalidatePath(`/app/admin/opening-balances/${setId}/subledgers`); return;
  }
  try {
    await uploadSubledger(p, { setId, kind, rows });
  } catch (err) {
    if (isAppError(err)) cookies().set("spectre_subledger_error", err.safeMessage, { httpOnly: true, sameSite: "strict", maxAge: 30 });
    else throw err;
  }
  revalidatePath(`/app/admin/opening-balances/${setId}/subledgers`);
}

export default async function SubledgersPage({ params }: { params: { id: string } }) {
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  let set;
  try { set = await getSet(p, params.id); }
  catch { notFound(); }
  if (!set) notFound();
  const summary = await subledgerSummary(p, set.id);
  const error = cookies().get("spectre_subledger_error")?.value;
  if (error) cookies().delete("spectre_subledger_error");

  return (
    <div>
      <Link href="/app/admin/opening-balances" className="text-sm text-stone-500 hover:text-club-ink">← Opening balances</Link>
      <h1 className="mt-3 page-title">Subledger upload</h1>
      <p className="mt-1 text-stone-500">{set.label} · <Badge status={set.status} /></p>
      {error && <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      <div className="mt-4 grid grid-cols-2 gap-4">
        <div className="card card-body">
          <div className="text-xs uppercase text-stone-500">AR subledger</div>
          <div className="mt-1 text-xl font-medium">{summary.ar.count} rows · {summary.ar.total.toFixed(2)}</div>
        </div>
        <div className="card card-body">
          <div className="text-xs uppercase text-stone-500">AP subledger</div>
          <div className="mt-1 text-xl font-medium">{summary.ap.count} rows · {summary.ap.total.toFixed(2)}</div>
        </div>
      </div>

      {!summary.validation.ok && (
        <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm">
          <div className="font-medium text-amber-900">Reconciliation gaps</div>
          <ul className="mt-1 space-y-0.5 text-amber-900">
            {summary.validation.errors.map((e, i) => <li key={i}>• {e.message}</li>)}
          </ul>
        </div>
      )}

      <form action={uploadAction.bind(null, set.id)} className="mt-6 card card-body space-y-3">
        <h2 className="section-title text-lg">Upload</h2>
        <div>
          <label className="block text-xs uppercase text-stone-500">Subledger kind</label>
          <select name="kind" className="input mt-1 text-sm w-full">
            <option value="AR">AR — per-member balances</option>
            <option value="AP">AP — per-vendor balances</option>
          </select>
        </div>
        <div>
          <label className="block text-xs uppercase text-stone-500">CSV (entity reference + balance)</label>
          <textarea name="csv" rows={8} className="input mt-1 text-xs font-mono w-full" placeholder="memberNumber,balance&#10;M-001,1200.50&#10;M-002,-50.00"></textarea>
          <p className="text-xs text-stone-500 mt-1">Columns auto-detected: any header matching member#/vendor + any matching balance/outstanding/amount.</p>
        </div>
        <button className="btn btn-primary" disabled={set.status !== "DRAFT"}>Upload</button>
        {set.status !== "DRAFT" && <p className="text-xs text-stone-500">Set is {set.status} — subledgers can only be edited while DRAFT.</p>}
      </form>
    </div>
  );
}
