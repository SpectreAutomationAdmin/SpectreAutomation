// Phase 9H — GET /api/v1/members
import { prisma } from "@/lib/prisma";
import { apiRoute } from "@/lib/api/handler";

export const runtime = "nodejs";

export const GET = apiRoute("members:read", async ({ req, clubId }) => {
  const url = new URL(req.url);
  const limit = Math.min(200, Number(url.searchParams.get("limit") ?? 50));
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const rows = await prisma.member.findMany({
    where: { clubId },
    take: limit + 1,
    orderBy: { lastName: "asc" },
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    select: { id: true, memberNumber: true, firstName: true, lastName: true, email: true, status: true, membershipCategory: true },
  });
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  return { data, nextCursor: hasMore ? data[data.length - 1].id : null };
});
