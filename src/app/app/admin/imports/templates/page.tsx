import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { listTemplates } from "@/lib/import-templates";
import { Badge } from "@/components/Badge";
import { formatDate } from "@/lib/finance";

export default async function ImportTemplatesPage() {
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "settings:write")) redirect("/app/admin");
  const templates = await listTemplates({ clubId });
  const grouped = templates.reduce((acc, t) => { (acc[t.domain] = acc[t.domain] ?? []).push(t); return acc; }, {} as Record<string, typeof templates>);

  return (
    <div>
      <Link href="/app/admin/imports" className="text-sm text-stone-500 hover:text-club-ink">← Imports</Link>
      <h1 className="mt-3 page-title">Import templates</h1>
      <p className="mt-1 text-stone-500">Saved column mappings for the common legacy systems. Apply one to a batch in the imports wizard.</p>

      {Object.entries(grouped).map(([domain, items]) => (
        <div key={domain} className="mt-6 card overflow-hidden">
          <div className="px-6 py-3 border-b border-stone-200 font-medium">{domain}</div>
          <table className="table-base">
            <thead><tr><th>Name</th><th>Source</th><th>Scope</th><th>Version</th><th>Status</th><th>Updated</th></tr></thead>
            <tbody>
              {items.map((t) => (
                <tr key={t.id}>
                  <td>
                    <div>{t.name}</div>
                    {t.description && <div className="text-xs text-stone-500 mt-0.5">{t.description}</div>}
                  </td>
                  <td className="text-xs">{t.source}</td>
                  <td className="text-xs">{t.scope}</td>
                  <td className="text-xs">v{t.version}</td>
                  <td><Badge status={t.status} /></td>
                  <td className="text-xs">{formatDate(t.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      <p className="mt-6 text-xs text-stone-500">
        Custom templates can be added per club via the API (<code>upsertTemplate</code>) or the SUPER_ADMIN tools.
      </p>
    </div>
  );
}
