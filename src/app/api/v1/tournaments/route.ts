// Phase 10D — GET /api/v1/tournaments
import { prisma } from "@/lib/prisma";
import { apiRoute } from "@/lib/api/handler";

export const runtime = "nodejs";

export const GET = apiRoute("lessons:view", async ({ clubId }) => {
  const rows = await prisma.tournament.findMany({
    where: { clubId },
    orderBy: { startDate: "desc" },
    take: 50,
    select: {
      id: true, name: true, format: true, status: true,
      startDate: true, endDate: true, entryFee: true, maxParticipants: true,
      _count: { select: { registrations: true } },
    },
  });
  return { data: rows.map((r) => ({ ...r, registrationCount: r._count.registrations, _count: undefined })) };
});
