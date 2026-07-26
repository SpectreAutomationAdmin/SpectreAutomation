import { NextResponse, type NextRequest } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { createDraft, post } from "@/lib/accounting/journal";
import { isAppError } from "@/lib/errors";

// Server endpoint backing the new-journal page. The client posts JSON; we
// validate via the service's Zod schema and return the created entry id.
export async function POST(req: NextRequest) {
  const p = await getCurrentPrincipal();
  if (!p) return NextResponse.json({ error: "unauth" }, { status: 401 });
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  const body = await req.json();
  try {
    const draft = await createDraft(p, clubId, {
      entryDate: body.entryDate,
      description: body.description,
      memo: body.memo || null,
      lines: body.lines,
    });
    if (body.action === "post") {
      await post(p, draft.id);
    }
    return NextResponse.json({ id: draft.id });
  } catch (err) {
    if (isAppError(err)) {
      return NextResponse.json({ error: err.safeMessage }, { status: err.httpStatus });
    }
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
