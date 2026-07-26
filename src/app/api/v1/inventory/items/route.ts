// Phase 9H — GET /api/v1/inventory/items
import { prisma } from "@/lib/prisma";
import { apiRoute } from "@/lib/api/handler";

export const runtime = "nodejs";

export const GET = apiRoute("inventory:read", async ({ req, clubId }) => {
  const url = new URL(req.url);
  const limit = Math.min(200, Number(url.searchParams.get("limit") ?? 50));
  const rows = await prisma.inventoryItem.findMany({
    where: { clubId, isActive: true },
    take: limit,
    orderBy: { sku: "asc" },
    select: { id: true, sku: true, name: true, quantityOnHand: true, averageCost: true, retailPrice: true },
  });
  return { data: rows.map((r) => ({ ...r, quantityOnHand: Number(r.quantityOnHand.toString()), averageCost: Number(r.averageCost.toString()), retailPrice: Number(r.retailPrice.toString()) })) };
});
