import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { documentService } from "@/lib/enterprise";
import { Badge } from "@/components/Badge";
import { formatDate } from "@/lib/finance";

export default async function DocumentsPage({ searchParams }: { searchParams: { q?: string; folder?: string } }) {
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "documents:read")) redirect("/app/admin");

  const documents = await documentService.searchDocuments(p, clubId, { query: searchParams.q, folderPath: searchParams.folder });

  return (
    <div>
      <h1 className="page-title">Documents</h1>
      <p className="mt-1 text-stone-500">Unified document library with versioning, retention policies, and signed-URL sharing. Every read/download is audit-logged.</p>

      <form className="mt-6 flex gap-3">
        <input className="input flex-1" name="q" placeholder="Search by name, description, or extracted text…" defaultValue={searchParams.q ?? ""} />
        <input className="input w-64" name="folder" placeholder="Folder path (optional)" defaultValue={searchParams.folder ?? ""} />
        <button className="btn btn-secondary">Search</button>
      </form>

      <div className="mt-6 card overflow-hidden">
        <div className="px-6 py-4 border-b border-stone-200 font-medium">Results ({documents.length})</div>
        <table className="table-base">
          <thead><tr><th>Name</th><th>Folder</th><th>Type</th><th>Size</th><th>Tags</th><th>Status</th><th>Updated</th></tr></thead>
          <tbody>
            {documents.length === 0 && <tr><td colSpan={7} className="px-4 py-6 text-center text-stone-500">No documents match. Documents uploaded via the unified service appear here; legacy attachments live on their parent records.</td></tr>}
            {documents.map((d) => (
              <tr key={d.id}>
                <td>{d.name}</td>
                <td className="text-xs font-mono text-stone-500">{d.folder?.path ?? "/"}</td>
                <td className="text-xs text-stone-500">{d.mimeType ?? "—"}</td>
                <td className="text-xs">{formatBytes(d.sizeBytes)}</td>
                <td className="text-xs">{d.tags.map((t) => t.tag.label).join(", ") || "—"}</td>
                <td><Badge status={d.status} /></td>
                <td className="text-xs">{formatDate(d.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

void Link;
