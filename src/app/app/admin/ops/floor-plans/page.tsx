// Step 32 — Floor-plan editor (admin).
//
// Tabbed per DiningArea (Lounge / Patio / …). For the active area
// we surface the current LIVE plan + any open DRAFT. Edit controls
// live in the inner client component. Server actions handle
// add/update/archive/discard/publish.

import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { tenantWhere } from "@/lib/services/tenant";
import {
  getDraftForArea,
  getLivePlanForArea,
} from "@/lib/hospitality/floor-plan";
import { FloorPlanEditor } from "./FloorPlanEditor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function FloorPlansPage({
  searchParams,
}: {
  searchParams: Promise<{ area?: string }>;
}) {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });
  if (!hasPermission(principal, clubId, "hospitality:floor:view")) redirect("/app/admin");

  const areas = await prisma.diningArea.findMany({
    where: { ...tenantWhere(principal, clubId), active: true },
    orderBy: { sortOrder: "asc" },
    select: { id: true, name: true, canvasWidth: true, canvasHeight: true },
  });

  if (areas.length === 0) {
    return (
      <div className="card card-body">
        <h1 className="page-title">Floor Plans</h1>
        <p className="mt-3 text-sm text-stone-600">
          No dining areas configured yet. Add an area to start designing a layout.
        </p>
      </div>
    );
  }

  const params = await searchParams;
  const activeAreaId = params.area && areas.some((a) => a.id === params.area)
    ? params.area
    : areas[0].id;
  const activeArea = areas.find((a) => a.id === activeAreaId)!;

  const [draft, live] = await Promise.all([
    getDraftForArea(principal, clubId, activeArea.id),
    getLivePlanForArea(principal, clubId, activeArea.id),
  ]);

  const canEdit = hasPermission(principal, clubId, "hospitality:floor:edit");
  const canPublish = hasPermission(principal, clubId, "hospitality:floor:publish");

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-baseline gap-3">
          <h1 className="font-serif text-2xl text-stone-900">Floor Plans</h1>
          <span className="hidden md:inline text-xs text-stone-500">
            Design and publish layouts for the live POS floor map.
          </span>
        </div>
        <div className="flex gap-2 text-xs">
          <Link href="/app/admin/hospitality/reservations/floor" className="btn btn-secondary btn-sm">
            View live floor map
          </Link>
        </div>
      </div>

      {/* Area tabs */}
      <div className="card card-overflow-hidden">
        <div className="flex flex-wrap gap-1 border-b border-stone-200 bg-stone-50 px-3 py-2">
          {areas.map((a) => (
            <Link
              key={a.id}
              href={`/app/admin/ops/floor-plans?area=${a.id}`}
              className={`rounded-md px-3 py-1.5 text-sm ${a.id === activeAreaId
                ? "bg-stone-900 text-white"
                : "bg-white border border-stone-300 text-stone-700 hover:border-stone-500"}`}
            >
              {a.name}
            </Link>
          ))}
        </div>
        <FloorPlanEditor
          area={activeArea}
          live={live ? toEditorPlan(live) : null}
          draft={draft ? toEditorPlan(draft) : null}
          canEdit={canEdit}
          canPublish={canPublish}
        />
      </div>
    </div>
  );
}

type RawPlan = Awaited<ReturnType<typeof getDraftForArea>>;

function toEditorPlan(p: NonNullable<RawPlan>) {
  return {
    id: p.id,
    status: p.status as "DRAFT" | "LIVE" | "ARCHIVED",
    name: p.name,
    versionNumber: p.versionNumber,
    publishedAt: p.publishedAt ? p.publishedAt.toISOString() : null,
    tables: p.tables.map((t) => ({
      id: t.id,
      tableNumber: t.tableNumber,
      displayName: t.displayName,
      shape: t.shape as "ROUND" | "SQUARE" | "RECTANGLE",
      capacity: t.capacity,
      xPos: t.xPos,
      yPos: t.yPos,
      width: t.width,
      height: t.height,
      rotation: t.rotation,
      archived: t.archived,
      sourceDiningTableId: t.sourceDiningTableId,
    })),
  };
}
