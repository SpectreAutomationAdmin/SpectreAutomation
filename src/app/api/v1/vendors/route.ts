// Phase 10D — GET /api/v1/vendors
import { prisma } from "@/lib/prisma";
import { apiRoute } from "@/lib/api/handler";

export const runtime = "nodejs";

export const GET = apiRoute("vendor:view", async ({ req, clubId }) => {
  const url = new URL(req.url);
  const limit = Math.min(200, Number(url.searchParams.get("limit") ?? 50));
  const status = url.searchParams.get("status") ?? undefined;
  const rows = await prisma.vendor.findMany({
    where: { clubId, ...(status ? { status } : {}) },
    take: limit,
    orderBy: { legalName: "asc" },
    select: { id: true, legalName: true, operatingName: true, status: true, paymentMethod: true },
  });
  return { data: rows };
});
