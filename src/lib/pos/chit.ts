// Lounge chit generation.
//
// A "chit" is the slip the lounge prints when a sale completes. Three
// kinds are produced per sale:
//
//   1. KITCHEN   — food items the kitchen needs to prep. No prices.
//   2. BAR       — drink items the bar needs to pour. No prices.
//   3. SIGNATURE — itemised receipt with prices and a signature line
//                  the member signs at the table.
//
// Today every chit is a PDF returned over HTTP. The API route streams
// the bytes to the staff's browser; they print to whatever printer
// the device has access to. Tomorrow the same `printChit()` entry
// point can dispatch to a real thermal-printer driver — the rest of
// the system doesn't care which transport runs.
//
// **Future-printer hook**: `getChitTransport(clubId)` is the single
// place a real printer adapter would slot in. See `selectTransport`
// at the bottom of this file. The lounge POS UI calls the same API
// route either way; only the response shape changes (PDF body vs.
// "queued for printer X" JSON).

import { prisma } from "../prisma";
import { NotFoundError, ValidationError } from "../errors";
import { formatCurrency, formatDateTime } from "../finance";

export type ChitType = "KITCHEN" | "BAR" | "SIGNATURE";
export const CHIT_TYPES: readonly ChitType[] = ["KITCHEN", "BAR", "SIGNATURE"];

export function isChitType(s: string): s is ChitType {
  return CHIT_TYPES.includes(s as ChitType);
}

// ---------------------------------------------------------------------------
// What goes on a chit. Computed from the underlying POSSale plus its
// lines, menu items, and category destinations. We pre-compute the
// member/server display strings here so the PDF renderer is purely
// presentational.
// ---------------------------------------------------------------------------
export type ChitData = {
  type: ChitType;
  clubName: string;
  locationName: string;
  saleNumber: string;
  saleDate: Date;
  serverName: string | null;
  // STAY vs TO_GO. Drives a prominent banner on KITCHEN and BAR prep
  // chits so the line knows how to plate (ceramic vs. takeaway box).
  // The signature chit gets a quieter "Dining in" / "To go" label in
  // the metadata block so the member sees what they ordered as.
  diningMode: "STAY" | "TO_GO";
  member: {
    firstName: string;
    lastName: string;
    memberNumberDisplay: string; // prefix stripped, e.g. "1042"
  } | null;
  lines: Array<{
    quantity: number;
    description: string;
    unitPrice: number;
    // Pre-tax, pre-discount line value (qty × unitPrice). The
    // signature renderer shows this in the body so the line totals
    // sum to the "Subtotal" line in the totals block.
    lineSubtotal: number;
    // Line-specific discount percentage (recovered from the
    // matching POSDiscount row). 0 if there was no line discount.
    lineDiscountPct: number;
    // Dollar amount of the line-specific discount.
    lineDiscountAmount: number;
    // Phase 18E — seat assignment. Snapshotted at send time so the
    // kitchen/bar print always shows "Seat 2 — Burger" even if the
    // line was later reassigned. `seatLabel` is null for TABLE-level
    // shared items, in which case the chit prints "Table".
    seatLabel?: string | null;
  }>;
  // Totals are only meaningful on the signature chit; kitchen/bar chits
  // don't display prices but we still carry them so the rendering layer
  // doesn't have to special-case undefined.
  subtotal: number;
  // Sum of line-specific discounts (chit-level discount is reported
  // separately below). 0 when no line discounts were applied.
  lineDiscountTotal: number;
  // Chit-level discount the staff applied, if any.
  chitDiscount: { pct: number; amount: number } | null;
  taxTotal: number;
  grandTotal: number;
  notes: string | null;
  // QR Pay support. When the sale was rung up with paymentMethod QR_PAY,
  // `qrPayUrl` is the URL we encode into a QR code on the signature
  // chit — the member scans it on their phone and finishes the
  // payment there. Null for MEMBER_ACCOUNT sales.
  qrPayUrl: string | null;
};

// ---------------------------------------------------------------------------
// Data assembly. Caller is responsible for proving the principal can
// see this sale before calling — the lounge service already does that
// via tenant + permission checks at its entry point. The API route
// re-asserts both as defense-in-depth.
// ---------------------------------------------------------------------------
export async function buildChitData(saleId: string, type: ChitType, opts?: { origin?: string }): Promise<ChitData> {
  if (!isChitType(type)) throw new ValidationError([{ path: "type", message: `Unknown chit type: ${type}` }]);
  const sale = await prisma.pOSSale.findUnique({
    where: { id: saleId },
    include: {
      lines: {
        orderBy: { id: "asc" },
        include: {
          menuItem: { include: { category: true } },
        },
      },
      discounts: true,
      location: { select: { name: true } },
      member: { select: { firstName: true, lastName: true, memberNumber: true } },
      club: { select: { name: true } },
    },
  });
  if (!sale) throw new NotFoundError("POSSale", saleId);

  // Filter lines for prep chits. The SIGNATURE chit always shows
  // every line so the member sees what they're paying for.
  const filtered = type === "SIGNATURE"
    ? sale.lines
    : sale.lines.filter((l) => {
        const dest = l.menuItem?.category?.chitDestination;
        // Lines without a menu item link (legacy / external sales)
        // default to KITCHEN. That keeps food-related items from
        // silently disappearing if the link wasn't stamped.
        return (dest ?? "KITCHEN") === type;
      });

  // Resolve server name in a single user lookup.
  const serverName = sale.createdByUserId
    ? (await prisma.user.findUnique({ where: { id: sale.createdByUserId }, select: { name: true } }))?.name ?? null
    : null;

  // Pull discount info out of POSDiscount rows. The lounge service
  // labels them deterministically — "Line: …" for per-line, "Chit
  // discount X%" for chit-level — so we can split them here for
  // display. Anything we can't classify falls into the line-discount
  // pile, which is the safer default for an unknown source.
  //
  // Hoisted into a local so the per-line closure below can read it
  // without TypeScript losing the null-narrowing on `sale`.
  const discounts = sale.discounts;
  const chitDiscountRow = discounts.find((d) => /^Chit discount/i.test(d.label));
  const chitDiscount = chitDiscountRow
    ? { pct: Number(chitDiscountRow.value.toString()), amount: Number(chitDiscountRow.amount.toString()) }
    : null;
  const lineDiscountTotal = discounts
    .filter((d) => !chitDiscountRow || d.id !== chitDiscountRow.id)
    .reduce((s, d) => s + Number(d.amount.toString()), 0);

  // For each line, recover its line-specific discount % from the
  // matching POSDiscount label. We round to the nearest whole percent
  // — that matches what the UI offers (preset list).
  type SaleLineRow = (typeof sale.lines)[number];
  function lineSpecific(l: SaleLineRow) {
    const subTotal = Number(l.lineSubtotal.toString());
    // Try matching a "Line: <description> N% off" row.
    const match = discounts.find((d) =>
      /^Line:/i.test(d.label) && d.label.includes(l.description),
    );
    if (!match) return { pct: 0, amount: 0 };
    const amount = Number(match.amount.toString());
    const pct = subTotal > 0 ? Math.round((amount / subTotal) * 100) : 0;
    return { pct, amount };
  }

  return {
    type,
    clubName: sale.club.name,
    locationName: sale.location.name,
    saleNumber: sale.saleNumber,
    saleDate: sale.saleDate,
    serverName,
    diningMode: (sale.diningMode === "TO_GO" ? "TO_GO" : "STAY") as "STAY" | "TO_GO",
    member: sale.member
      ? {
          firstName: sale.member.firstName,
          lastName: sale.member.lastName,
          memberNumberDisplay: sale.member.memberNumber.replace(/^[A-Z]+-/i, ""),
        }
      : null,
    lines: filtered.map((l) => {
      const disc = lineSpecific(l);
      return {
        quantity: Number(l.quantity.toString()),
        description: l.description,
        unitPrice: Number(l.unitPrice.toString()),
        lineSubtotal: Number(l.lineSubtotal.toString()),
        lineDiscountPct: disc.pct,
        lineDiscountAmount: disc.amount,
      };
    }),
    subtotal: Number(sale.subtotal.toString()),
    lineDiscountTotal: Math.round(lineDiscountTotal * 100) / 100,
    chitDiscount,
    taxTotal: Number(sale.taxTotal.toString()),
    grandTotal: Number(sale.grandTotal.toString()),
    notes: sale.notes,
    // QR Pay URL — encoded into a QR code on the signature chit when
    // the sale was rung up with paymentMethod QR_PAY. The member opens
    // it on their phone to finish payment. `origin` is the request's
    // own origin (resolved by the API route from request headers) so
    // the link works on whatever host the staff is on.
    qrPayUrl: sale.chargeMode === "QR_PAY" && opts?.origin
      ? `${opts.origin}/pos/pay/${sale.id}`
      : null,
  };
}

// ---------------------------------------------------------------------------
// PDF renderer. Sized to ~80mm wide so a future thermal-printer driver
// can take the same dimensions; renders fine on a regular sheet printer
// too. Layout is single column, monospace-feeling, very compact.
// ---------------------------------------------------------------------------
type PDFKitTextOpts = { align?: "left" | "right" | "center"; continued?: boolean; width?: number };
type PDFKitInstance = {
  on(event: "data" | "end", cb: (chunk: Buffer) => void): void;
  on(event: "end", cb: () => void): void;
  fontSize(s: number): PDFKitInstance;
  font(name: string): PDFKitInstance;
  fillColor(c: string): PDFKitInstance;
  // Both pdfkit signatures we use: positional (x, y) for the two-column
  // money rows, and flowing (opts only) for the rest.
  text(s: string, opts?: PDFKitTextOpts): PDFKitInstance;
  text(s: string, x: number, y: number, opts?: PDFKitTextOpts): PDFKitInstance;
  moveDown(n?: number): PDFKitInstance;
  moveTo(x: number, y: number): PDFKitInstance;
  lineTo(x: number, y: number): PDFKitInstance;
  stroke(): PDFKitInstance;
  rect(x: number, y: number, w: number, h: number): PDFKitInstance;
  fill(color?: string): PDFKitInstance;
  end(): void;
  y: number;
  page: { width: number; margins: { left: number; right: number } };
};

const PAGE_WIDTH = 226;   // ~80mm — typical chit-printer roll
const PAGE_HEIGHT = 700;  // tall enough for a 20-line order; pdfkit
                          // auto-grows by adding pages if exceeded.
const MARGIN = 16;

export async function renderChitPDF(data: ChitData): Promise<Buffer> {
  const PDFDocument = (await import("pdfkit")).default as unknown as new (opts: {
    size: [number, number];
    margin: number;
    bufferPages?: boolean;
  }) => PDFKitInstance;
  const doc = new PDFDocument({ size: [PAGE_WIDTH, PAGE_HEIGHT], margin: MARGIN, bufferPages: true });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done: Promise<void> = new Promise((res) => doc.on("end", () => res()));

  const innerWidth = PAGE_WIDTH - MARGIN * 2;
  const divider = () => {
    const y = doc.y + 2;
    doc.moveTo(MARGIN, y).lineTo(PAGE_WIDTH - MARGIN, y).stroke();
    doc.moveDown(0.6);
  };

  // ---- Header --------------------------------------------------------
  // The destination label is the loud, instantly-recognisable element
  // for kitchen/bar staff who glance at the chit from across the line.
  doc.font("Helvetica-Bold").fontSize(20).fillColor("#000").text(headerLabel(data.type), { align: "center", width: innerWidth });
  doc.moveDown(0.2);
  doc.font("Helvetica").fontSize(9).fillColor("#444").text(data.clubName, { align: "center", width: innerWidth });
  doc.fontSize(9).text(data.locationName, { align: "center", width: innerWidth });
  doc.moveDown(0.4);
  divider();

  // ---- Dining-mode banner (KITCHEN / BAR only) ----------------------
  // A loud full-width banner immediately under the header so the line
  // cook glancing at the ticket from across the kitchen sees STAY or
  // TO GO before reading anything else. The signature chit gets a
  // quieter "Dining" line in the metadata block below instead.
  if (data.type !== "SIGNATURE") {
    const bannerText = data.diningMode === "TO_GO" ? "TO GO" : "DINING IN";
    const bannerY = doc.y;
    const bannerH = 22;
    doc.rect(MARGIN, bannerY, innerWidth, bannerH).fill(data.diningMode === "TO_GO" ? "#1f2937" : "#e7eee4");
    doc.fillColor(data.diningMode === "TO_GO" ? "#ffffff" : "#1f3a23");
    doc.font("Helvetica-Bold").fontSize(13)
      .text(bannerText, MARGIN, bannerY + 5, { width: innerWidth, align: "center" });
    doc.y = bannerY + bannerH + 4;
    doc.fillColor("#000");
    divider();
  }

  // ---- Sale metadata -------------------------------------------------
  doc.fontSize(9).fillColor("#000");
  doc.font("Helvetica-Bold").text("Sale", { continued: true }).font("Helvetica").text(`  ${data.saleNumber}`);
  doc.font("Helvetica-Bold").text("Time", { continued: true }).font("Helvetica").text(`  ${formatDateTime(data.saleDate)}`);
  if (data.serverName) {
    doc.font("Helvetica-Bold").text("Server", { continued: true }).font("Helvetica").text(`  ${data.serverName}`);
  }
  if (data.member) {
    doc.font("Helvetica-Bold").text("Member", { continued: true })
      .font("Helvetica").text(`  ${data.member.firstName} ${data.member.lastName} (${data.member.memberNumberDisplay})`);
  }
  // Quieter "Dining" label on the signature chit so the member sees
  // what they're being served as.
  if (data.type === "SIGNATURE") {
    doc.font("Helvetica-Bold").text("Dining", { continued: true })
      .font("Helvetica").text(`  ${data.diningMode === "TO_GO" ? "To go" : "Dining in"}`);
  }
  doc.moveDown(0.2);
  divider();

  // ---- Body ----------------------------------------------------------
  if (data.lines.length === 0) {
    doc.font("Helvetica-Oblique").fontSize(10).fillColor("#666")
      .text(`No ${data.type.toLowerCase()} items on this order.`, { align: "center", width: innerWidth });
  } else if (data.type === "SIGNATURE") {
    // Itemised list with PRE-DISCOUNT, PRE-TAX line subtotals so the
    // body adds up to the "Subtotal" line in the totals block. Any
    // line-specific discount is annotated under the line in green and
    // surfaces again in the totals block.
    // We render two `text()` calls with the SAME starting y (using
    // pdfkit's positional `text(s, x, y, opts)` overload). The right
    // call uses `align: "right"` against the full inner width so the
    // price sits flush at the page edge. If the left text wraps, we
    // take its longer end position as the new cursor.
    for (const line of data.lines) {
      const left = `${line.quantity} × ${line.description}`;
      const right = formatCurrency(line.lineSubtotal);
      doc.font("Helvetica").fontSize(10).fillColor("#000");
      const y = doc.y;
      // Reserve ~60pt on the right for the price so left text wraps
      // before colliding with it.
      doc.text(left, MARGIN, y, { width: innerWidth - 60 });
      const afterLeft = doc.y;
      doc.text(right, MARGIN, y, { width: innerWidth, align: "right" });
      if (doc.y < afterLeft) doc.y = afterLeft;
      // Per-line discount annotation (small grey row underneath).
      if (line.lineDiscountAmount > 0) {
        doc.font("Helvetica").fontSize(8).fillColor("#666");
        const y2 = doc.y;
        doc.text(`   ${line.lineDiscountPct}% off`, MARGIN, y2, { width: innerWidth - 60 });
        doc.text(`(${formatCurrency(line.lineDiscountAmount)})`, MARGIN, y2, { width: innerWidth, align: "right" });
      }
    }
    doc.moveDown(0.4);
    divider();
    // Totals block. Order: Subtotal → line discounts → chit discount
    // → GST → TOTAL. Each discount row only renders if it had a value.
    moneyRow(doc, "Subtotal", formatCurrency(data.subtotal), innerWidth, false);
    if (data.lineDiscountTotal > 0) {
      moneyRow(doc, "Line discounts", `(${formatCurrency(data.lineDiscountTotal)})`, innerWidth, false);
    }
    if (data.chitDiscount) {
      moneyRow(doc, `Chit discount ${data.chitDiscount.pct}%`, `(${formatCurrency(data.chitDiscount.amount)})`, innerWidth, false);
    }
    moneyRow(doc, "GST 5%", formatCurrency(data.taxTotal), innerWidth, false);
    doc.moveDown(0.1);
    moneyRow(doc, "TOTAL", formatCurrency(data.grandTotal), innerWidth, true);

    // Suggested gratuity — % of the pre-tax subtotal (industry standard;
    // tipping on tax is not customary in Alberta). The chit doesn't post
    // a tip to the member's account on its own; this is purely a writing
    // aid for the member. Staff would enter the actual tip back into the
    // sale through a future gratuity-adjustment flow.
    doc.moveDown(0.5);
    divider();
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#000")
      .text("Suggested gratuity", MARGIN, doc.y, { width: innerWidth, align: "left" });
    doc.moveDown(0.15);
    doc.font("Helvetica").fontSize(9).fillColor("#000");
    for (const pct of [15, 18, 20] as const) {
      const amount = Math.round(data.subtotal * (pct / 100) * 100) / 100;
      const y = doc.y;
      doc.text(`${pct}% of pre-tax subtotal`, MARGIN, y, { width: innerWidth - 60 });
      doc.text(formatCurrency(amount), MARGIN, y, { width: innerWidth, align: "right" });
      doc.moveDown(0.1);
    }

    // Fill-in lines for the member to write their gratuity and the
    // grand total with gratuity. Only on member-account chits — QR
    // Pay chits use the QR landing page to capture tip + payment in
    // one step, so a paper write-in line is redundant noise.
    if (!data.qrPayUrl) {
      doc.moveDown(0.6);
      drawFillInRow(doc, "Gratuity", innerWidth, 14);
      doc.moveDown(0.4);
      drawFillInRow(doc, "Total with gratuity", innerWidth, 14);
    }
  } else {
    // KITCHEN or BAR — prep-only. Big quantity + item name; no prices.
    for (const line of data.lines) {
      doc.font("Helvetica-Bold").fontSize(12).fillColor("#000")
        .text(`${line.quantity} × ${line.description}`, { width: innerWidth });
      doc.moveDown(0.15);
    }
  }

  // ---- Notes ---------------------------------------------------------
  if (data.notes) {
    doc.moveDown(0.4);
    divider();
    doc.font("Helvetica-Bold").fontSize(9).text("Notes");
    doc.font("Helvetica").fontSize(9).text(data.notes, { width: innerWidth });
  }

  // ---- Footer ---------------------------------------------------------
  // Three render paths, mutually exclusive:
  //   1. SIGNATURE chit + QR Pay  → big QR code block, no signature
  //   2. SIGNATURE chit + member-account → "charged to member account",
  //      member identity, signature line
  //   3. KITCHEN / BAR (prep)     → just a centred dotted hairline
  doc.moveDown(0.6);
  if (data.type === "SIGNATURE" && data.qrPayUrl) {
    // Path 1 — QR Pay. The member scans the QR with their phone to
    // complete payment, so no signature line, no gratuity write-in,
    // no "charged to account" text. The suggested-gratuity block
    // above is still printed for member reference.
    doc.font("Helvetica-Bold").fontSize(10).fillColor("#000")
      .text("Pay by Phone", { align: "center", width: innerWidth });
    doc.font("Helvetica").fontSize(8).fillColor("#666")
      .text("Scan with your phone camera to pay.", { align: "center", width: innerWidth });
    doc.moveDown(0.4);
    // Generate the QR as PNG bytes server-side. Error-correction
    // level M is forgiving enough that a slightly smudged thermal
    // print still scans.
    const QRCode = (await import("qrcode")).default as {
      toBuffer(text: string, opts: { errorCorrectionLevel: "L" | "M" | "Q" | "H"; margin: number; width: number }): Promise<Buffer>;
    };
    const qrSizePt = 150; // ≈ 53mm at 72dpi — comfortably scannable
    const qrPng = await QRCode.toBuffer(data.qrPayUrl, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 600, // render bigger then scale down → sharp PDF embed
    });
    const qrX = MARGIN + (innerWidth - qrSizePt) / 2;
    const qrY = doc.y;
    // pdfkit's `image` accepts a Buffer directly. Cast to its image
    // signature since our PDFKitInstance type doesn't include it.
    (doc as unknown as { image: (src: Buffer, x: number, y: number, opts: { width: number; height: number }) => void })
      .image(qrPng, qrX, qrY, { width: qrSizePt, height: qrSizePt });
    doc.y = qrY + qrSizePt + 4;
    doc.font("Helvetica").fontSize(7).fillColor("#999")
      .text(data.qrPayUrl, { align: "center", width: innerWidth });
  } else if (data.type === "SIGNATURE") {
    // Path 2 — member-account chit. Needs a signature line and the
    // member's identity above it.
    doc.font("Helvetica").fontSize(9).fillColor("#000")
      .text("Charged to member account.", { align: "center", width: innerWidth });
    doc.moveDown(0.8);
    // Print the member's identity directly above the signature line,
    // left-justified to match the rest of the metadata block. The top
    // of the chit already shows this — repeating it here lets the
    // member read exactly what they're attesting to right where they
    // sign (same convention as bar tabs and hotel folios).
    if (data.member) {
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#000")
        .text(`${data.member.firstName} ${data.member.lastName}`, MARGIN, doc.y, { width: innerWidth, align: "left" });
      doc.font("Helvetica").fontSize(9).fillColor("#444")
        .text(`Member ${data.member.memberNumberDisplay}`, MARGIN, doc.y, { width: innerWidth, align: "left" });
    }
    // Generous vertical padding so a real pen has room. ~36pt ≈ 12mm,
    // about a normal handwritten signature height on an 80mm chit.
    doc.moveDown(2.8);
    const y = doc.y;
    doc.moveTo(MARGIN, y).lineTo(PAGE_WIDTH - MARGIN, y).stroke();
    doc.moveDown(0.2);
    doc.fontSize(8).fillColor("#666").text("Signature", { align: "center", width: innerWidth });
  } else {
    // Path 3 — prep chit footer.
    doc.font("Helvetica").fontSize(9).fillColor("#888")
      .text("· · ·", { align: "center", width: innerWidth });
  }

  doc.end();
  await done;
  return Buffer.concat(chunks);
}

function moneyRow(doc: PDFKitInstance, label: string, amount: string, innerWidth: number, bold: boolean) {
  const size = bold ? 11 : 10;
  doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(size).fillColor("#000");
  const y = doc.y;
  doc.text(label, MARGIN, y);
  doc.text(amount, MARGIN, y, { width: innerWidth, align: "right" });
}

// Renders `<label>: ________________` where the underline runs from just
// after the label out to the right margin. `gap` is the vertical space
// reserved below the baseline so the line sits a bit under the text.
function drawFillInRow(doc: PDFKitInstance, label: string, innerWidth: number, gap: number) {
  doc.font("Helvetica").fontSize(10).fillColor("#000");
  const y = doc.y;
  const text = `${label}:`;
  doc.text(text, MARGIN, y, { width: innerWidth });
  // Underline from a fixed starting x out to the right margin.
  // We use the label string length as a rough guide for where the
  // underline should begin (so the line never crosses through the text).
  const labelOffset = Math.min(innerWidth * 0.55, label.length * 6 + 18);
  const lineY = y + gap;
  doc.moveTo(MARGIN + labelOffset, lineY).lineTo(MARGIN + innerWidth, lineY).stroke();
  // Push the cursor below the underline so subsequent content stacks.
  doc.y = lineY + 4;
}

function headerLabel(type: ChitType): string {
  switch (type) {
    case "KITCHEN": return "KITCHEN";
    case "BAR": return "BAR";
    case "SIGNATURE": return "MEMBER CHIT";
  }
}

// ---------------------------------------------------------------------------
// FUTURE PRINTER HOOK
// ---------------------------------------------------------------------------
// When real chit printers are configured for a club, this is the
// function the API route should consult to decide whether to stream a
// PDF back to the browser (current behaviour) or to dispatch the
// chit to a printer driver (future behaviour).
//
// A real implementation would:
//   - look up the configured printer for (clubId, chitType) — likely
//     a new `POSChitPrinter` row with { id, clubId, chitType, transport,
//     networkAddress, vendor }
//   - return either { kind: "pdf" } or { kind: "printer", target: ... }
//
// Today we always return { kind: "pdf" } so the chit shows up in the
// browser. The lounge POS UI links to the API route which produces the
// PDF; once printers are wired the same URL would return JSON saying
// "queued at Kitchen-1 — see queue page" and the UI would surface that
// in the success state without any other change.
// ---------------------------------------------------------------------------
export type ChitTransport =
  | { kind: "pdf" }
  | { kind: "printer"; target: string };

export async function getChitTransport(_clubId: string, _type: ChitType): Promise<ChitTransport> {
  // Single intentional return until printer-config rows exist. The
  // signature is async so a future implementation can read a config
  // row without changing call sites.
  return { kind: "pdf" };
}
