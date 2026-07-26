import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { isInsecureKmsModeInProduction, selectKmsProvider } from "@/lib/kms";
import { Badge } from "@/components/Badge";
import { formatDate } from "@/lib/finance";

export default async function KmsHealthPage() {
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "system:audit:read")) redirect("/app/admin");

  const provider = await selectKmsProvider();
  const insecure = isInsecureKmsModeInProduction();
  const [metadata, recentLogs, rotations] = await Promise.all([
    prisma.encryptedSecretMetadata.findMany({ where: { OR: [{ clubId }, { clubId: null }] }, orderBy: { rotatedAt: "desc" }, take: 50 }),
    prisma.secretAccessLog.findMany({ where: { OR: [{ clubId }, { clubId: null }] }, orderBy: { occurredAt: "desc" }, take: 30 }),
    prisma.keyRotationEvent.findMany({ where: { OR: [{ clubId }, { clubId: null }] }, orderBy: { startedAt: "desc" }, take: 15 }),
  ]);

  return (
    <div>
      <Link href="/app/admin/security" className="text-sm text-stone-500 hover:text-club-ink">← Security</Link>
      <h1 className="mt-3 page-title">Secret encryption (KMS)</h1>
      <p className="mt-1 text-stone-500">Envelope-encryption health for webhook, billing, SSO, and POS secrets.</p>

      <div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="card card-body">
          <div className="text-xs uppercase text-stone-500">Active provider</div>
          <div className="mt-1 font-medium">{provider.name}</div>
          <div className="text-xs text-stone-500 font-mono">{provider.keyId()}</div>
        </div>
        <div className="card card-body">
          <div className="text-xs uppercase text-stone-500">Encrypted secrets</div>
          <div className="mt-1 text-2xl font-medium">{metadata.length}</div>
        </div>
        <div className="card card-body">
          <div className="text-xs uppercase text-stone-500">Production posture</div>
          <div className="mt-1">
            {insecure
              ? <span className="text-red-600 font-medium">⚠ Local KMS in production</span>
              : <span className="text-emerald-700 font-medium">OK</span>}
          </div>
        </div>
      </div>

      <div className="mt-6 card overflow-hidden">
        <div className="px-6 py-4 border-b border-stone-200 font-medium">Encrypted secrets</div>
        <table className="table-base">
          <thead><tr><th>Scope</th><th>Reference</th><th>Provider</th><th>Key</th><th>Rotated</th><th>Last decrypted</th></tr></thead>
          <tbody>
            {metadata.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-stone-500">No encrypted secrets yet.</td></tr>}
            {metadata.map((m) => (
              <tr key={m.id}>
                <td className="text-xs"><Badge status={m.scope} /></td>
                <td className="text-xs font-mono">{m.secretReference}</td>
                <td className="text-xs">{m.provider}</td>
                <td className="text-xs font-mono">{m.keyId}</td>
                <td className="text-xs">{m.rotatedAt ? formatDate(m.rotatedAt) : "—"}</td>
                <td className="text-xs">{m.lastDecryptedAt ? formatDate(m.lastDecryptedAt) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card overflow-hidden">
          <div className="px-6 py-4 border-b border-stone-200 font-medium">Recent access</div>
          <table className="table-base">
            <thead><tr><th>When</th><th>Scope</th><th>Action</th><th>Status</th></tr></thead>
            <tbody>
              {recentLogs.length === 0 && <tr><td colSpan={4} className="px-4 py-6 text-center text-stone-500">No access yet.</td></tr>}
              {recentLogs.map((l) => (
                <tr key={l.id}>
                  <td className="text-xs">{formatDate(l.occurredAt)}</td>
                  <td className="text-xs">{l.scope}</td>
                  <td className="text-xs font-mono">{l.action}</td>
                  <td className="text-xs">{l.status === "OK" ? "OK" : <span className="text-red-600">FAIL</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card overflow-hidden">
          <div className="px-6 py-4 border-b border-stone-200 font-medium">Key rotation events</div>
          <table className="table-base">
            <thead><tr><th>When</th><th>Scope</th><th>Kind</th><th>Status</th></tr></thead>
            <tbody>
              {rotations.length === 0 && <tr><td colSpan={4} className="px-4 py-6 text-center text-stone-500">No key rotation events recorded.</td></tr>}
              {rotations.map((r) => (
                <tr key={r.id}>
                  <td className="text-xs">{formatDate(r.startedAt)}</td>
                  <td className="text-xs">{r.scope}</td>
                  <td className="text-xs">{r.kind}</td>
                  <td className="text-xs">{r.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
