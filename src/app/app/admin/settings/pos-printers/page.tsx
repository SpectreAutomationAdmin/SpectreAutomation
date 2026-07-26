import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { listPrintersForAdmin } from "@/lib/pos/printers";
import { Badge } from "@/components/Badge";
import { PrinterAdminPanel } from "./PrinterAdminPanel";

// POS printer registry admin page. Lists every printer registered for
// the club + provides CRUD via the client panel.
//
// Permission gate: `settings:read` to view, `settings:write` to mutate
// (enforced inside the service). Most admin roles (CLUB_ADMIN, GM)
// have both; lower roles see a redirect to /app/admin.
export default async function POSPrintersSettingsPage() {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });
  if (!hasPermission(principal, clubId, "settings:read")) redirect("/app/admin");
  const canEdit = hasPermission(principal, clubId, "settings:write");

  const printers = await listPrintersForAdmin(principal, clubId);

  return (
    <div>
      <Link href="/app/admin/settings" className="text-sm text-stone-500 hover:text-club-ink">
        ← Settings
      </Link>
      <div className="mt-3 flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="page-title">POS print settings</h1>
          <p className="mt-1 text-sm text-stone-500 max-w-2xl">
            Register the printers wired to this club&rsquo;s lounge POS so servers can pick a target when printing chits and receipts.{" "}
            <strong className="text-club-ink">Print to PDF</strong> is always offered as the default — register a physical printer to make it available alongside.
          </p>
        </div>
      </div>

      {/* "Print to PDF" — always-available fallback. Rendered as a
          read-only row so the admin can see it lives in the picker. */}
      <div className="mt-6 card overflow-hidden">
        <div className="px-5 py-3 border-b border-stone-200 font-medium">Built-in</div>
        <table className="table-base">
          <thead>
            <tr>
              <th>Name</th>
              <th>Role</th>
              <th>Kind</th>
              <th>Default</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="text-sm font-medium text-club-ink">Print to PDF (browser)</td>
              <td className="text-xs text-stone-500">Any</td>
              <td className="text-xs text-stone-500">PDF</td>
              <td>
                <span className="inline-flex rounded-md border border-club-green-200 bg-club-green-50 px-2 py-0.5 text-[10px] uppercase tracking-wide text-club-green-700">
                  Fallback
                </span>
              </td>
              <td className="text-right text-xs text-stone-400">Always available — cannot be removed</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Registered physical printers */}
      <div className="mt-4 card overflow-hidden">
        <div className="px-5 py-3 border-b border-stone-200 font-medium flex items-center justify-between gap-3">
          <span>Registered printers ({printers.length})</span>
        </div>
        <table className="table-base">
          <thead>
            <tr>
              <th>Name</th>
              <th>Role</th>
              <th>Kind</th>
              <th>Location</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {printers.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sm text-stone-500">
                  No physical printers registered yet. Add one below to surface it in the lounge POS print picker.
                </td>
              </tr>
            )}
            {printers.map((p) => (
              <tr key={p.id}>
                <td className="text-sm font-medium text-club-ink">
                  {p.name}
                  {p.isDefault && (
                    <span className="ml-2 inline-flex rounded-md border border-club-green-200 bg-club-green-50 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-club-green-700">
                      Default
                    </span>
                  )}
                </td>
                <td className="text-xs text-stone-600">{roleLabel(p.role)}</td>
                <td className="text-xs text-stone-600">{kindLabel(p.kind)}</td>
                <td className="text-xs text-stone-500">{p.location || "—"}</td>
                <td>
                  <Badge status={p.isActive ? "ACTIVE" : "INACTIVE"} />
                </td>
                <td className="text-right">
                  {canEdit && (
                    <PrinterRowActions
                      id={p.id}
                      name={p.name}
                      role={p.role}
                      kind={p.kind}
                      location={p.location}
                      driverHint={p.driverHint}
                      isDefault={p.isDefault}
                      isActive={p.isActive}
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Add-printer form */}
      {canEdit && (
        <div className="mt-4">
          <PrinterAdminPanel />
        </div>
      )}
    </div>
  );
}

function roleLabel(r: string): string {
  if (r === "KITCHEN") return "Kitchen chits";
  if (r === "BAR") return "Bar chits";
  if (r === "SIGNATURE") return "Signature / receipt";
  if (r === "RECEIPT") return "Receipt printer";
  return "Any";
}
function kindLabel(k: string): string {
  if (k === "NETWORK") return "Network (IPP / LPR)";
  if (k === "USB") return "USB";
  if (k === "RECEIPT_PRINTER") return "Thermal receipt";
  return "PDF";
}

// Inline action component — defers to the client-side panel so the
// edit + delete forms live in the same hydrated bundle.
function PrinterRowActions(props: {
  id: string;
  name: string;
  role: string;
  kind: string;
  location: string | null;
  driverHint: string | null;
  isDefault: boolean;
  isActive: boolean;
}) {
  // The actual buttons live in the client panel; this server-rendered
  // row only carries the payload via a Link-style anchor that the
  // client picks up via the hash. To keep this MVP simple we embed
  // a small client component instead.
  return <RowActionsClient {...props} />;
}

// Re-export the client component for inline use.
import { RowActionsClient } from "./RowActionsClient";
