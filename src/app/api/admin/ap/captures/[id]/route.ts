import { NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getCapture, parseExtraction, parseSuggestion } from "@/lib/ap/capture";
import { isAppError } from "@/lib/errors";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const p = await getCurrentPrincipal();
  if (!p) return NextResponse.json({ error: "unauth" }, { status: 401 });
  try {
    const cap = await getCapture(p, params.id);
    return NextResponse.json({
      capture: cap,
      extraction: parseExtraction(cap),
      suggestion: parseSuggestion(cap),
    });
  } catch (err) {
    if (isAppError(err)) return NextResponse.json({ error: err.safeMessage }, { status: err.httpStatus });
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
