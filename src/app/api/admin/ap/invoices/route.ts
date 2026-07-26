import { NextResponse, type NextRequest } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { createDraft, submitInvoiceForApproval } from "@/lib/ap/invoices";
import { isAppError } from "@/lib/errors";

export async function POST(req: NextRequest) {
  const p = await getCurrentPrincipal();
  if (!p) return NextResponse.json({ error: "unauth" }, { status: 401 });
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  const body = await req.json();
  try {
    const inv = await createDraft(p, clubId, {
      vendorId: body.vendorId,
      vendorReference: body.vendorReference,
      invoiceDate: body.invoiceDate,
      description: body.description,
      lines: body.lines,
      captureId: body.captureId ?? null,
    });
    if (body.action === "submit") {
      await submitInvoiceForApproval(p, inv.id);
    }
    return NextResponse.json({ id: inv.id });
  } catch (err) {
    if (isAppError(err)) return NextResponse.json({ error: err.safeMessage }, { status: err.httpStatus });
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
