import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { buildSnapshot } from "@/lib/go-live";
import { Badge } from "@/components/Badge";

export default async function GoLivePage({ params }: { params: { id: string } }) {
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  let snap;
  try { snap = await buildSnapshot(p, params.id); }
  catch { notFound(); }
  if (!snap) notFound();

  const recColor = snap.recommendation === "GO" ? "emerald-700" : snap.recommendation === "CAUTION" ? "amber-700" : "red-700";

  return (
    <div>
      <Link href={`/app/admin/pilot/onboarding/${params.id}`} className="text-sm text-stone-500 hover:text-club-ink">← Project</Link>
      <h1 className="mt-3 page-title">Go-live control center</h1>
      <p className="mt-1 text-stone-500">Single dashboard for the implementation team to confirm pilot readiness.</p>

      <div className={`mt-6 card card-body border-2 border-${recColor}`}>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs uppercase text-stone-500">Recommendation</div>
            <div className={`mt-1 text-3xl font-medium text-${recColor}`}>{snap.recommendation}</div>
          </div>
          <div className="text-right">
            <div className="text-xs">Hard blocks: <strong className={snap.hardBlocks.length > 0 ? "text-red-700" : "text-emerald-700"}>{snap.hardBlocks.length}</strong></div>
            <div className="text-xs">Warnings: <strong>{snap.warnings.length}</strong></div>
          </div>
        </div>
        {snap.hardBlocks.length > 0 && (
          <ul className="mt-3 text-sm space-y-1 text-red-700">
            {snap.hardBlocks.map((b, i) => <li key={i}>• {b}</li>)}
          </ul>
        )}
        {snap.warnings.length > 0 && (
          <ul className="mt-2 text-sm space-y-1 text-amber-700">
            {snap.warnings.map((w, i) => <li key={i}>• {w}</li>)}
          </ul>
        )}
      </div>

      <div className="mt-6 grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="card card-body"><div className="text-xs uppercase text-stone-500">Smoke pass</div><div className="mt-1 text-2xl font-medium text-emerald-700">{snap.smoke.summary.pass}</div></div>
        <div className="card card-body"><div className="text-xs uppercase text-stone-500">Smoke warn</div><div className="mt-1 text-2xl font-medium text-amber-700">{snap.smoke.summary.warn}</div></div>
        <div className="card card-body"><div className="text-xs uppercase text-stone-500">Smoke fail</div><div className="mt-1 text-2xl font-medium text-red-700">{snap.smoke.summary.fail}</div></div>
        <div className="card card-body"><div className="text-xs uppercase text-stone-500">Open incidents</div><div className="mt-1 text-2xl font-medium">{snap.openIncidents}</div></div>
      </div>

      <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card overflow-hidden">
          <div className="px-6 py-4 border-b border-stone-200 font-medium">Smoke results</div>
          <table className="table-base">
            <thead><tr><th>Check</th><th>Status</th><th>Detail</th></tr></thead>
            <tbody>
              {snap.smoke.results.map((r) => (
                <tr key={r.key}>
                  <td className="text-xs">{r.label}</td>
                  <td><Badge status={r.status} /></td>
                  <td className="text-xs">{r.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card overflow-hidden">
          <div className="px-6 py-4 border-b border-stone-200 font-medium">Launch checks</div>
          <table className="table-base">
            <thead><tr><th>Check</th><th>Severity</th><th>Status</th></tr></thead>
            <tbody>
              {snap.launch.length === 0 && <tr><td colSpan={3} className="px-4 py-6 text-center text-stone-500">No checks visible at this club.</td></tr>}
              {snap.launch.map((c) => (
                <tr key={c.key}>
                  <td className="text-xs">{c.label}</td>
                  <td className="text-xs">{c.severity}</td>
                  <td><Badge status={c.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="card card-body">
          <h3 className="section-title text-base">Imports</h3>
          <ul className="mt-2 text-sm space-y-1">
            {snap.imports.length === 0 && <li className="text-stone-500">No imports yet.</li>}
            {snap.imports.map((g, i) => <li key={i}>{g.domain} · <Badge status={g.status} /> · {g.count}</li>)}
          </ul>
        </div>
        <div className="card card-body">
          <h3 className="section-title text-base">Opening balances</h3>
          <ul className="mt-2 text-sm space-y-1">
            {snap.openingBalances.length === 0 && <li className="text-stone-500">No sets yet.</li>}
            {snap.openingBalances.map((g, i) => <li key={i}><Badge status={g.status} /> · {g.count}</li>)}
          </ul>
        </div>
        <div className="card card-body">
          <h3 className="section-title text-base">Invites</h3>
          <ul className="mt-2 text-sm space-y-1">
            {Object.entries(snap.invites).length === 0 && <li className="text-stone-500">No invites yet.</li>}
            {Object.entries(snap.invites).map(([s, n]) => <li key={s}><Badge status={s} /> · {n}</li>)}
          </ul>
        </div>
      </div>
    </div>
  );
}
