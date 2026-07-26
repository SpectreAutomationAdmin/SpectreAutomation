import { redirect } from "next/navigation";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { listLoungeMenu, LOUNGE_LOCATION_CODE } from "@/lib/pos/lounge";
import { prisma } from "@/lib/prisma";
import { LoungePOS } from "./LoungePOS";

// /app/admin/ops/pos/lounge — the working lounge POS surface.
//
// This is a server component: it does the auth check, pulls the menu
// (already serialized into number-shaped objects by the service), and
// hands a sane initial payload to the client component that owns the
// interactive cart / member / charge flow.
export default async function LoungePOSPage() {
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  // Lounge servers need `inventory:write` to actually post a sale; we
  // gate the page at read because staff may also visit just to browse.
  if (!hasPermission(p, clubId, "inventory:read")) redirect("/app/admin");

  // The lounge POS page used to render its own title block + sibling-
  // surface nav. Both moved into the AdminShell POS-mode header so the
  // tile grid gets the full remaining viewport. We only fetch what the
  // page still needs (menu + location existence + write-perm flag).
  const [menu, location] = await Promise.all([
    listLoungeMenu(p, clubId),
    prisma.pOSLocation.findFirst({ where: { clubId, code: LOUNGE_LOCATION_CODE } }),
  ]);

  const canPost = hasPermission(p, clubId, "inventory:write");

  if (!location) {
    return (
      <div>
        <h1 className="page-title">Quick Sale / Bar</h1>
        <div className="mt-6 card card-body">
          <p className="text-stone-600">The lounge POS location hasn&rsquo;t been provisioned for this club yet.</p>
          <p className="mt-2 text-xs text-stone-500">Expected location code: <code>{LOUNGE_LOCATION_CODE}</code></p>
        </div>
      </div>
    );
  }

  return (
    // Flex column so the LoungePOS area can `flex-1` against the
    // bounded height of `<main>` (which is `flex flex-col
    // overflow-hidden` in POS mode). No page-level chrome here — the
    // AdminShell header above already shows the surface label, nav
    // pills, and POS-mode indicator.
    <div className="flex flex-col flex-1 min-h-0">
      {!canPost && (
        <div className="shrink-0 mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          You can browse the menu, but charging a sale requires the inventory:write permission.
        </div>
      )}
      <div className="flex-1 min-h-0 flex flex-col">
        <LoungePOS menu={menu} canPost={canPost} />
      </div>
    </div>
  );
}
