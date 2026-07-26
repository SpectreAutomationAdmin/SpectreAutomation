// Sprint 3 Checkpoint 15D (2026-07-24) — Document metadata endpoint.
//
// GET /api/documents/[id]/metadata
//
// Returns display metadata for an ingested document — filename, MIME,
// byte length, SHA256 fingerprint, classification, evidence links.
// NEVER returns storage keys, bucket names, or bytes.
//
// Authorization:
//   * authenticated principal
//   * doc.clubId === principal.activeClubId
//   * at least one evidence link points at a target the principal can read
// Any failure returns 404 (never leaks existence).

import { NextRequest, NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { getDocumentMetadata } from "@/lib/documents/retrieve";
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
    const meta = await getDocumentMetadata({
      clubId,
      documentId,
      actorUserId: principal.id,
      ip: req.headers.get("x-forwarded-for") ?? null,
      userAgent: req.headers.get("user-agent") ?? null,
    });
    return NextResponse.json(meta);
  } catch (err) {
    if (err instanceof DocumentError && (err.category === "NOT_FOUND" || err.category === "TENANT_MISMATCH")) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
