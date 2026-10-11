// MBR-VIS-1 (2026-10-11) — Monthly Reporting Package visibility API.
//
// POST  /api/admin/reporting/monthly/visibility
//   body: { reportingYear, reportingMonth, componentKey, hidden }
//   effect: upserts a draft visibility row + records an audit entry.
//           Does NOT alter frozen `MonthlyPackage.packagePayloadJson.
//           visibility` — the Board + PDF continue to render the
//           previously published state until explicit republish.
//
// GET   /api/admin/reporting/monthly/visibility?year=YYYY&month=M
//        [&source=draft|published]
//   returns: the resolved VisibilityConfig for the (club, year,
//            month) tuple. Defaults to source=draft for the admin
//            editing surface.
//
// Permission: both verbs require `packages:write` on the active
// club. Enforced server-side via `hasPermission`.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requirePrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { getActiveClubId } from "@/lib/active-club";
import {
  COMPONENT_KEY_PATTERN,
  resolveDraftVisibility,
  resolvePublishedVisibility,
  setComponentVisibility,
} from "@/lib/reporting/monthly-package-visibility";

export const dynamic = "force-dynamic";

const PostBody = z.object({
  reportingYear: z.number().int().gte(1900).lte(9999),
  reportingMonth: z.number().int().gte(1).lte(12),
  componentKey: z.string().regex(COMPONENT_KEY_PATTERN, {
    message: 'componentKey must match "(chapter|card|row|commentary):<anchor>:…"',
  }),
  hidden: z.boolean(),
});

export async function POST(req: NextRequest): Promise<NextResponse> {
  const principal = await requirePrincipal();
  const clubId = await getActiveClubId({
    clubId: principal.activeClubId ?? null,
    role: "",
  });
  if (!hasPermission(principal, clubId, "packages:write")) {
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  }

  let body: z.infer<typeof PostBody>;
  try {
    body = PostBody.parse(await req.json());
  } catch (err) {
    const msg = err instanceof z.ZodError
      ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
      : "invalid body";
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  const { before, after } = await setComponentVisibility(principal, {
    clubId,
    reportingYear: body.reportingYear,
    reportingMonth: body.reportingMonth,
    componentKey: body.componentKey,
    hidden: body.hidden,
  });

  return NextResponse.json({
    clubId,
    reportingYear: body.reportingYear,
    reportingMonth: body.reportingMonth,
    componentKey: body.componentKey,
    before,
    after,
  });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const principal = await requirePrincipal();
  const clubId = await getActiveClubId({
    clubId: principal.activeClubId ?? null,
    role: "",
  });
  if (!hasPermission(principal, clubId, "packages:write")) {
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  }

  const year = Number(req.nextUrl.searchParams.get("year") ?? "");
  const month = Number(req.nextUrl.searchParams.get("month") ?? "");
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
    return NextResponse.json({ error: "year + month (1..12) required" }, { status: 400 });
  }
  const source = (req.nextUrl.searchParams.get("source") ?? "draft") as
    | "draft"
    | "published";
  if (source !== "draft" && source !== "published") {
    return NextResponse.json({ error: "source must be draft or published" }, { status: 400 });
  }

  const config = source === "published"
    ? await resolvePublishedVisibility(clubId, year, month)
    : await resolveDraftVisibility(clubId, year, month);

  return NextResponse.json({ clubId, config });
}
