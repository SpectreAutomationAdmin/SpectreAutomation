// Phase 10D — GET /api/v1/charges (member AR)
import { prisma } from "@/lib/prisma";
import { apiRoute } from "@/lib/api/handler";

export const runtime = "nodejs";

export const GET = apiRoute("ar:read", async ({ req, clubId }) => {
  const url = new URL(req.url);
  const limit = Math.min(500, Number(url.searchParams.get("limit") ?? 100));
  const memberId = url.searchParams.get("memberId") ?? undefined;
  const since = url.searchParams.get("since") ? new Date(String(url.searchParams.get("since"))) : undefined;
  const rows = await prisma.charge.findMany({
    where: {
      clubId,
      ...(memberId ? { memberId } : {}),
      ...(since ? { transactionDate: { gte: since } } : {}),
    },
    take: limit,
    orderBy: { transactionDate: "desc" },
    select: { id: true, memberId: true, description: true, category: true, amount: true, transactionDate: true, status: true },
  });
  return { data: rows };
});
