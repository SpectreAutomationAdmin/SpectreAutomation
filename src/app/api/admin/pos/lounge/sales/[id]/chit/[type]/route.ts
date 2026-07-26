// Lounge chit PDF endpoint.
//
//   GET /api/admin/pos/lounge/sales/[id]/chit/KITCHEN   → kitchen prep slip
//   GET /api/admin/pos/lounge/sales/[id]/chit/BAR       → bar prep slip
//   GET /api/admin/pos/lounge/sales/[id]/chit/SIGNATURE → member receipt
//
// Auth: the calling principal must be able to read the sale's club
// (inventory:read). The same chits the staff prints; the API is
// admin-only and not exposed to members.
//
// Future-printer hook: when `getChitTransport()` reports "printer",
// the route would dispatch to a printer driver and respond with JSON
// confirming the print job, instead of streaming PDF bytes. The lounge
// POS UI in `LoungePOS.tsx` should treat the response polymorphically
// when that day arrives — for now we always return PDF.

import { NextRequest, NextResponse } from "next/server";
// Buffer import — used to wrap snapshot bytes for the Fetch BodyInit
// type when serving from POSSaleChit.pdfBytes.
import { Buffer } from "node:buffer";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { buildChitData, renderChitPDF, getChitTransport, isChitType } from "@/lib/pos/chit";
import { LOUNGE_LOCATION_CODE } from "@/lib/pos/lounge";

export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: { id: string; type: string } }) {
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  // Normalise the type — accept upper/lowercase so it's link-friendly.
  const type = params.type.toUpperCase();
  if (!isChitType(type)) {
    return NextResponse.json({ error: `Unknown chit type: ${params.type}` }, { status: 400 });
  }

  // Tenant + permission check. We fetch just enough to confirm the
  // sale exists at a club the principal can see and that it's actually
  // a lounge sale — chits for other POS locations aren't this surface.
  const sale = await prisma.pOSSale.findUnique({
    where: { id: params.id },
    select: { id: true, clubId: true, location: { select: { code: true } } },
  });
  if (!sale) return NextResponse.json({ error: "Sale not found" }, { status: 404 });
  if (!hasPermission(principal, sale.clubId, "inventory:read")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (sale.location.code !== LOUNGE_LOCATION_CODE) {
    return NextResponse.json({ error: "This chit surface is only for lounge sales" }, { status: 400 });
  }

  // Decide transport. Today this is always "pdf" — the future-printer
  // implementation would short-circuit here with a different response.
  const transport = await getChitTransport(sale.clubId, type);
  if (transport.kind === "printer") {
    return NextResponse.json({
      ok: true, queued: true, target: transport.target,
      message: "Chit dispatched to physical printer.",
    });
  }

  // 1) Saved snapshot path. SIGNATURE chits are snapshotted at
  //    settlement so the audit trail carries the immutable receipt
  //    linked to the GL JE. Return that exact PDF whenever it exists.
  //    `?live=1` opts out for ops/debugging.
  const liveOverride = req.nextUrl.searchParams.get("live") === "1";
  if (!liveOverride) {
    const snapshot = await prisma.pOSSaleChit.findUnique({
      where: { saleId_type: { saleId: params.id, type } },
      select: { pdfBytes: true },
    });
    if (snapshot) {
      const buf = Buffer.from(snapshot.pdfBytes);
      const u8 = new Uint8Array(buf.length);
      u8.set(buf);
      return new NextResponse(u8, {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": "inline",
          "Cache-Control": "no-store",
          // Tag the response so an inspector can confirm it came from
          // the saved snapshot, not a live re-render.
          "X-Spectre-Chit-Source": "snapshot",
        },
      });
    }
  }

  // 2) Fallback: live re-render. Used for KITCHEN / BAR chits (which
  //    we don't snapshot), for `?live=1`, or as a safety net if the
  //    settlement-time snapshot didn't write (e.g. error swallowed).
  const origin = req.nextUrl.origin;
  const data = await buildChitData(params.id, type, { origin });
  const pdf = await renderChitPDF(data);
  // Copy into a freshly-allocated Uint8Array (backed by an ArrayBuffer,
  // not SharedArrayBuffer) so it satisfies the Fetch `BodyInit` type
  // without TypeScript squabbling about Node's `ArrayBufferLike` union.
  // The byte payload is unchanged.
  const u8 = new Uint8Array(pdf.length);
  u8.set(pdf);
  return new NextResponse(u8, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      // `inline` (no `filename=`) so the browser displays the chit
      // in its built-in PDF viewer — the operator can read + scan
      // the QR + hit Ctrl+P from there without ever seeing a Save
      // As dialog. Some browsers treat the presence of `filename=`
      // as a download hint even on `inline`; we omit it on purpose.
      "Content-Disposition": "inline",
      "Cache-Control": "no-store",
    },
  });
}
