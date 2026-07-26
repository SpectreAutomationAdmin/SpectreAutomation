// Sprint 3 Checkpoint 15D (2026-07-24) — Document download.
//
// GET /api/documents/[id]/download
//
// Same authorization + storage flow as ../preview/route.ts but sends
// Content-Disposition: attachment so browsers save-to-disk.

import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { getDocumentBytes } from "@/lib/documents/retrieve";
import { sanitiseFilename } from "@/lib/documents/safety";
import { DocumentError } from "@/lib/documents/types";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });
  if (!clubId) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const documentId = params.id;
  if (!documentId) return NextResponse.json({ error: "not_found" }, { status: 404 });
  try {
    const { metadata, bytes } = await getDocumentBytes(
      {
        clubId,
        documentId,
        actorUserId: principal.id,
        ip: req.headers.get("x-forwarded-for") ?? null,
        userAgent: req.headers.get("user-agent") ?? null,
      },
      "DOWNLOAD",
    );
    const filename = sanitiseFilename(metadata.filename);
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": metadata.mimeType,
        "Content-Length": String(bytes.length),
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "private, no-cache, no-store, must-revalidate",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    if (err instanceof DocumentError && (err.category === "NOT_FOUND" || err.category === "TENANT_MISMATCH")) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (err instanceof DocumentError && err.category === "STORAGE_FAILURE") {
      return NextResponse.json({ error: "storage_unavailable" }, { status: 502 });
    }
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
