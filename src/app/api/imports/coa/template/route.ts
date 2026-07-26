// COA template download endpoint — returns a multi-sheet XLSX
// workbook built dynamically from the current club's mapping
// configuration.
//
// Founder spec 2026-07-04: the downloadable COA template is now a
// self-contained Excel workbook with Instructions + a Chart of
// Accounts import sheet + reference tabs for Types, Categories,
// FS Groups, and Departments. Every reference tab and every Excel
// dropdown on the import sheet is sourced live — no hard-coded
// mapping values.

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { hasPermission } from "@/lib/rbac";
import { getCoaMappingOptions } from "@/lib/imports/coa-mapping";
import {
  buildCoaXlsxWorkbook,
  coaWorkbookFilename,
} from "@/lib/imports/xlsx-template";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(_req: NextRequest) {
  const principal = await getCurrentPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const clubId = await getActiveClubId({
    clubId: principal.activeClubId ?? null,
    role: "",
  });
  // The mapping-table page is gated on `settings:write`; the
  // download surface inherits the same permission gate so any
  // operator who can run an import can also fetch the template.
  if (!hasPermission(principal, clubId, "settings:write")) {
    return NextResponse.json({ error: "Missing settings:write" }, { status: 403 });
  }
  const options = await getCoaMappingOptions(clubId);
  const club = await prisma.club.findUnique({
    where: { id: clubId },
    select: { name: true },
  });
  const clubName = club?.name ?? "Spectre";
  const buf = await buildCoaXlsxWorkbook(options, clubName);
  const filename = coaWorkbookFilename(clubName);
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-store",
    },
  });
}

export async function GET(req: NextRequest) {
  return handle(req);
}
