// Phase 10D — GET /api/v1/events
import { prisma } from "@/lib/prisma";
import { apiRoute } from "@/lib/api/handler";

export const runtime = "nodejs";

export const GET = apiRoute("events:read", async ({ req, clubId }) => {
  const url = new URL(req.url);
  const limit = Math.min(200, Number(url.searchParams.get("limit") ?? 50));
  const rows = await prisma.clubEvent.findMany({
    where: { clubId },
    take: limit,
    orderBy: { eventDate: "desc" },
    select: { id: true, title: true, description: true, eventDate: true, capacity: true, price: true, status: true },
  });
  return { data: rows };
});
