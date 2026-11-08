// EP-TRAIN-4Y-Q §5 — authorised transcript-segment attestation.
// POST  → attest segment     DELETE → unattest segment.

import { NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import {
  attestTranscriptSegment,
  unattestTranscriptSegment,
  AttestationError,
} from "@/lib/hr/training/ai-review/transcript-attestation-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function resolveContext() {
  const principal = await getCurrentPrincipal();
  if (!principal) {
    return { unauth: NextResponse.json({ error: "unauthenticated" }, { status: 401 }) };
  }
  const clubId = await getActiveClubId({
    clubId: principal.activeClubId ?? null,
    role: "",
    id: principal.id,
  });
  return { principal, clubId };
}

function fromError(err: unknown): NextResponse {
  if (err instanceof AttestationError) {
    return NextResponse.json({ error: err.code, message: err.message }, { status: err.httpStatus });
  }
  return NextResponse.json(
    { error: "internal_error", message: (err as Error)?.message ?? String(err) },
    { status: 500 },
  );
}

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  const ctx = await resolveContext();
  if (ctx.unauth) return ctx.unauth;
  let body: { note?: unknown } = {};
  try {
    body = await req.json();
  } catch {}
  try {
    const result = await attestTranscriptSegment(ctx.principal, ctx.clubId, {
      segmentId: id,
      note: typeof body.note === "string" ? body.note : undefined,
    });
    return NextResponse.json({ ok: true, ...result }, { status: 200 });
  } catch (err) {
    return fromError(err);
  }
}

export async function DELETE(
  _req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  const ctx = await resolveContext();
  if (ctx.unauth) return ctx.unauth;
  try {
    const result = await unattestTranscriptSegment(ctx.principal, ctx.clubId, id);
    return NextResponse.json({ ok: true, ...result }, { status: 200 });
  } catch (err) {
    return fromError(err);
  }
}
