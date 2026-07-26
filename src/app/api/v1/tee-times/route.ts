// Phase 10D — GET /api/v1/tee-times
import { prisma } from "@/lib/prisma";
import { apiRoute } from "@/lib/api/handler";

export const runtime = "nodejs";

export const GET = apiRoute("lessons:view", async ({ req, clubId }) => {
  const url = new URL(req.url);
  const limit = Math.min(200, Number(url.searchParams.get("limit") ?? 50));
  const from = url.searchParams.get("from") ? new Date(String(url.searchParams.get("from"))) : new Date();
  const to = url.searchParams.get("to") ? new Date(String(url.searchParams.get("to"))) : new Date(Date.now() + 14 * 86400000);
  const rows = await prisma.teeTime.findMany({
    where: { clubId, startTime: { gte: from, lte: to } },
    take: limit,
    orderBy: { startTime: "asc" },
    select: {
      id: true, startTime: true, status: true, maxPlayers: true, startingTee: true,
      teeSheet: { select: { sheetDate: true, course: { select: { name: true, code: true } } } },
    },
  });
  return {
    data: rows.map((t) => ({
      id: t.id, startTime: t.startTime, status: t.status, maxPlayers: t.maxPlayers,
      startingTee: t.startingTee, courseName: t.teeSheet.course.name, courseCode: t.teeSheet.course.code,
    })),
  };
});
