import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { searchService } from "@/lib/enterprise";

export default async function SearchPage({ searchParams }: { searchParams: { q?: string } }) {
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "search:read")) redirect("/app/admin");
  const q = (searchParams.q ?? "").trim();
  const hits = q ? await searchService.globalSearch(p, clubId, q, { limit: 100 }) : [];

  return (
    <div>
      <h1 className="page-title">Global search</h1>
      <p className="mt-1 text-stone-500">Permission-aware search across members, vendors, invoices, journal entries, packages, documents, and more.</p>

      <form className="mt-6 flex gap-3">
        <input className="input flex-1" name="q" autoFocus placeholder="Search…" defaultValue={q} />
        <button className="btn btn-primary">Search</button>
      </form>

      {q && (
        <div className="mt-6 card overflow-hidden">
          <div className="px-6 py-4 border-b border-stone-200 font-medium">{hits.length} result{hits.length === 1 ? "" : "s"} for &quot;{q}&quot;</div>
          <ul className="divide-y divide-stone-200">
            {hits.length === 0 && <li className="px-6 py-6 text-center text-stone-500">No results. Try a different query.</li>}
            {hits.map((h) => (
              <li key={`${h.entityType}-${h.entityId}`} className="px-6 py-3 text-sm">
                <div className="flex items-center justify-between">
                  <Link href={h.url} className="font-medium hover:text-club-green-700">{h.title}</Link>
                  <span className="text-xs uppercase tracking-widest text-stone-400">{h.entityType}</span>
                </div>
                {h.subtitle && <p className="mt-1 text-xs text-stone-500">{h.subtitle}</p>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
