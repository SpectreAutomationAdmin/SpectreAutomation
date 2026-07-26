// Lounge POS service — a thin, opinionated wrapper around the generic
// POS engine in `./index.ts`. Front-of-house staff hand us a cart (a
// member + a list of menu item ids with quantities) and we turn it into
// the line/tax/payment shape that `createSale` + `completeSale`
// understand. All money, tenant, posting-guard, AR, GL, and audit
// behaviour lives in the underlying engine — this file owns only:
//
//   1. The lounge's location/terminal codes (so callers don't hard-code them)
//   2. Menu-item lookup + line shaping
//   3. GST calculation at the Alberta rate (5%)
//   4. Member-tenant verification at the entry point
//   5. Tenant-safe read helpers for the admin history page and member-side
//      dining list / receipt detail

import { z } from "zod";
import { prisma } from "../prisma";
import { requirePermission, type Principal } from "../rbac";
import { tenantWhere, assertTenantOwned } from "../services/tenant";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { assertPostingAllowed } from "../posting-guard";
import { createSale, completeSale } from "./index";

// Hard-coded to the seeded lounge identifiers. If/when more lounges
// are added per club, these should become per-club config rather than
// growing into a switch.
export const LOUNGE_LOCATION_CODE = "FB-LOUNGE";
export const LOUNGE_TERMINAL_CODE = "LOUNGE-T1";
// Alberta GST. Production should resolve this from the seeded tax-code
// table rather than a hard constant — but a single lounge in a single
// province makes the constant safe today and keeps the math auditable.
export const GST_RATE = 0.05;
// F&B Dining is the seeded revenue account for lounge sales.
const FB_REVENUE_ACCOUNT = "4200";

// ---------------------------------------------------------------------------
// Menu read (server-side render for the POS screen).
// ---------------------------------------------------------------------------
export async function listLoungeMenu(principal: Principal, clubId: string) {
  requirePermission(principal, clubId, "inventory:read");
  const location = await prisma.pOSLocation.findFirst({
    where: { clubId, code: LOUNGE_LOCATION_CODE },
  });
  if (!location) return [];
  const categories = await prisma.pOSMenuCategory.findMany({
    where: { clubId, locationId: location.id, isActive: true },
    include: { items: { where: { isActive: true }, orderBy: { sortOrder: "asc" } } },
    orderBy: { sortOrder: "asc" },
  });
  // Serialize Decimal price into a number — the page is a Server
  // Component so we can hand the raw number straight to the client cart.
  // `chitDestination` is surfaced so the client category-grid tile can
  // show "Kitchen" / "Bar" labels without re-querying.
  return categories.map((c) => ({
    id: c.id,
    name: c.name,
    chitDestination: c.chitDestination as "KITCHEN" | "BAR",
    items: c.items.map((it) => ({
      id: it.id,
      name: it.name,
      description: it.description,
      price: Number(it.price.toString()),
      taxable: it.taxable,
    })),
  }));
}

// ---------------------------------------------------------------------------
// Member search for the POS top bar.
// ---------------------------------------------------------------------------
export async function searchMembersForPos(principal: Principal, clubId: string, query: string) {
  requirePermission(principal, clubId, "members:read");
  const term = query.trim();
  if (term.length < 1) return [];
  // SQLite's `contains` is case-insensitive in collation `NOCASE`, which
  // is the schema default for text. We don't need ILIKE.
  const rows = await prisma.member.findMany({
    where: {
      ...tenantWhere(principal, clubId),
      status: { in: ["ACTIVE", "ONBOARDING"] },
      OR: [
        { firstName: { contains: term } },
        { lastName: { contains: term } },
        { memberNumber: { contains: term } },
      ],
    },
    select: {
      id: true, firstName: true, lastName: true,
      memberNumber: true, accessStatus: true,
      paymentMethodStatus: true, status: true,
    },
    take: 20,
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });
  return rows;
}

// ---------------------------------------------------------------------------
// Cart contract submitted by the POS UI.
// ---------------------------------------------------------------------------
export const loungeCartSchema = z.object({
  memberId: z.string().min(1, "Select a member"),
  items: z.array(z.object({
    menuItemId: z.string().min(1),
    quantity: z.number().int().positive().max(99),
    note: z.string().trim().max(200).optional().nullable(),
    // Per-line percentage discount (0–100). Reduces this line's
    // revenue and taxable base; the line's tax is recomputed against
    // the post-discount net. Default 0.
    discountPct: z.number().min(0).max(100).default(0),
  })).min(1, "Cart cannot be empty"),
  // Chit-wide percentage discount (0–100) applied to the post-line-
  // discount subtotal. For JE balance the chit discount is allocated
  // proportionally across the lines server-side — the user sees it as
  // a single "chit discount" line on the receipt, but accounting-wise
  // each line's revenue is reduced by its share.
  chitDiscountPct: z.number().min(0).max(100).default(0),
  // How the chit gets paid:
  //   MEMBER_ACCOUNT — tab it to the member's AR (default; blocked
  //     if the member's access is suspended)
  //   QR_PAY        — sale completes, a QR code is rendered on the
  //     signature chit linking to a payment page the member opens on
  //     their phone. Useful when the member's account is suspended or
  //     they prefer a direct payment.
  paymentMethod: z.enum(["MEMBER_ACCOUNT", "QR_PAY"]).default("MEMBER_ACCOUNT"),
  // STAY (dining in) vs TO_GO (takeaway). Drives how the kitchen
  // and bar plate the order. Defaults to STAY for the lounge.
  diningMode: z.enum(["STAY", "TO_GO"]).default("STAY"),
  notes: z.string().trim().max(1000).optional().nullable(),
});
// Input type — callers may omit the discount fields, defaults apply
// via the schema parser. Inside the service we normalise with `?? 0`.
export type LoungeCart = z.input<typeof loungeCartSchema>;

// ---------------------------------------------------------------------------
// Server-side pricing. The cart from the client is untrusted — we always
// re-look up prices and recompute tax here before any state mutation.
// ---------------------------------------------------------------------------
export async function priceLoungeCart(principal: Principal, clubId: string, cart: LoungeCart) {
  requirePermission(principal, clubId, "inventory:read");
  const itemIds = Array.from(new Set(cart.items.map((i) => i.menuItemId)));
  const items = await prisma.pOSMenuItem.findMany({
    where: { clubId, id: { in: itemIds }, isActive: true },
    include: { category: { select: { chitDestination: true } } },
  });
  const byId = new Map(items.map((i) => [i.id, i]));

  // Discount override rule (per-line, three-way priority):
  //
  //   1. If the line is a Comp (lineDiscountPct === 100), it stays
  //      100% off no matter what — chit-level can't undo a comp.
  //   2. Else, if a chit-level discount is set, use chitPct (overrides
  //      whatever lower line discount the staff entered).
  //   3. Else, use the line's own pct.
  //
  // Rationale: a server enters a Comp because something specific went
  // wrong (kitchen mistake, VIP touch); a later chit-wide discount
  // (birthday, event) shouldn't take that comp away. But a 50% staff
  // discount on a line *should* be replaced by a more generous 50%
  // chit discount rather than compounded.
  //
  // Σ line.discountAmount becomes the engine's discountTotal — the JE
  // balances regardless of which mix of preserves/overrides applied.
  const chitPct = cart.chitDiscountPct ?? 0;
  const chitOverrides = chitPct > 0;

  const lines = cart.items.map((c) => {
    const it = byId.get(c.menuItemId);
    if (!it) throw new ConflictError(`Unknown or inactive menu item: ${c.menuItemId}`);
    const unitPrice = Number(it.price.toString());
    const lineSubtotal = round2(c.quantity * unitPrice);
    const lineDiscountPct = c.discountPct ?? 0;
    // A "Comp" is anything that brings the line to zero — preset Comp
    // (100%) or a custom 100. Treating by value, not by preset name,
    // matches the spirit of the rule and handles the Custom-100 case
    // without a separate flag.
    const isComp = lineDiscountPct >= 100;
    const effectivePct = isComp
      ? 100
      : chitOverrides
        ? chitPct
        : lineDiscountPct;
    const totalLineDiscount = round2(lineSubtotal * (effectivePct / 100));
    const finalNet = round2(lineSubtotal - totalLineDiscount);
    const taxAmount = it.taxable ? round2(finalNet * GST_RATE) : 0;
    return {
      menuItemId: it.id,
      description: c.note ? `${it.name} — ${c.note}` : it.name,
      itemName: it.name,
      quantity: c.quantity,
      unitPrice,
      lineSubtotal,
      lineDiscountPct,
      isComp,
      effectivePct,
      totalLineDiscount,
      taxAmount,
      taxable: it.taxable,
      destination: (it.category.chitDestination as "KITCHEN" | "BAR"),
    };
  });

  const subtotal = round2(lines.reduce((s, l) => s + l.lineSubtotal, 0));
  const taxTotal = round2(lines.reduce((s, l) => s + l.taxAmount, 0));
  // Bucket the line discounts so the receipt and UI can show them in
  // human-readable groups:
  //   - compTotal:        Σ comps that survived chit override (or any
  //                        comps when chit is off)
  //   - chitAppliedTotal:  Σ non-comp lines that got the chit's pct
  //   - regularLineTotal:  Σ non-comp line-level discounts when chit
  //                        is off
  const compTotal = round2(
    lines.filter((l) => l.isComp).reduce((s, l) => s + l.totalLineDiscount, 0),
  );
  const chitAppliedTotal = round2(
    chitOverrides
      ? lines.filter((l) => !l.isComp).reduce((s, l) => s + l.totalLineDiscount, 0)
      : 0,
  );
  const regularLineTotal = round2(
    !chitOverrides
      ? lines.filter((l) => !l.isComp && l.totalLineDiscount > 0).reduce((s, l) => s + l.totalLineDiscount, 0)
      : 0,
  );
  const totalDiscount = round2(compTotal + chitAppliedTotal + regularLineTotal);
  const grandTotal = round2(subtotal + taxTotal - totalDiscount);

  return {
    lines,
    subtotal,
    // Surface buckets for both the UI mirror and the chit PDF.
    compTotal,           // comps (always shown as their own group when present)
    chitAppliedTotal,    // chit-discount portion (excludes comps)
    regularLineTotal,    // line discounts when chit is off (excludes comps)
    chitDiscountPct: chitPct,
    chitOverrides,
    // Legacy fields kept for the chit-PDF builder and any callers
    // that haven't switched to the buckets yet:
    //   lineDiscountTotal = comps + non-comp line discounts (whichever applies)
    //   chitDiscountAmount = just the chit's portion
    lineDiscountTotal: round2(compTotal + regularLineTotal),
    chitDiscountAmount: chitAppliedTotal,
    taxTotal,
    grandTotal,
  };
}

// ---------------------------------------------------------------------------
// Charge to member account: create + complete in one shot. The underlying
// `completeSale` runs the posting guard, training-mode + support-readonly
// gates, AR Charge creation, balance recompute, GL JE, and audit.
// ---------------------------------------------------------------------------
export async function ringUpLoungeSale(principal: Principal, clubId: string, raw: unknown) {
  const parsed = loungeCartSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  }
  const cart = parsed.data;

  // Tenant-safety: the supplied memberId must belong to `clubId` AND
  // the principal must be allowed to see that club. The generic
  // `createSale` does this too, but failing fast here gives the POS UI
  // a cleaner error before any DB writes.
  const member = await prisma.member.findUnique({ where: { id: cart.memberId } });
  if (!member) throw new NotFoundError("Member", cart.memberId);
  assertTenantOwned(member, principal);
  if (member.clubId !== clubId) {
    throw new ConflictError("Member is not at this club");
  }

  // Fire the posting-guard up front with a write-flavoured action name.
  // The underlying `completeSale` calls `assertPostingAllowed` too, but
  // with action `"pos.sale.complete"` which doesn't contain any of the
  // support-access write keywords (create/update/delete/post/...) —
  // so a READ_ONLY support session would slip past. Using
  // `pos.lounge.charge.post` makes the gate fire on the lounge entry
  // point regardless of how `completeSale`'s keyword list evolves.
  await assertPostingAllowed(principal, clubId, "pos.lounge.charge.post", "Member", cart.memberId);

  // The active open session, if any. createSale doesn't require one,
  // but linking sales to a session gives the reconciliation reports
  // something to aggregate.
  const session = await prisma.pOSSession.findFirst({
    where: { clubId, location: { code: LOUNGE_LOCATION_CODE }, status: "OPEN" },
    orderBy: { openedAt: "desc" },
  });

  const priced = await priceLoungeCart(principal, clubId, cart);

  // POSDiscount entries — three groups can appear in any combination:
  //   - "Line: <item> 100% off" — comps (preserved through chit override)
  //   - "Chit discount X%"     — single aggregate for the chit-applied portion
  //   - "Line: <item> N% off"   — non-comp line discounts (only when chit is off)
  //
  // The engine sums these into `POSSale.discountTotal`, which equals
  // Σ POSSaleLine.discountAmount → JE balances regardless of mix.
  const discountEntries: Array<{ label: string; kind: "PERCENT"; value: number; amount: number }> = [];
  // Comps always get their own line so they're auditable on the receipt
  // even when a chit discount is also applied.
  for (const l of priced.lines) {
    if (l.isComp && l.totalLineDiscount > 0) {
      discountEntries.push({
        label: `Line: ${l.itemName} 100% off`,
        kind: "PERCENT",
        value: 100,
        amount: l.totalLineDiscount,
      });
    }
  }
  if (priced.chitOverrides) {
    if (priced.chitAppliedTotal > 0) {
      discountEntries.push({
        label: `Chit discount ${priced.chitDiscountPct}%`,
        kind: "PERCENT",
        value: priced.chitDiscountPct,
        amount: priced.chitAppliedTotal,
      });
    }
  } else {
    // Non-comp line discounts (only meaningful when chit is off).
    for (const l of priced.lines) {
      if (!l.isComp && l.totalLineDiscount > 0) {
        discountEntries.push({
          label: `Line: ${l.itemName} ${l.lineDiscountPct}% off`,
          kind: "PERCENT",
          value: l.lineDiscountPct,
          amount: l.totalLineDiscount,
        });
      }
    }
  }

  // Map the lounge cart's `paymentMethod` to the POS engine's
  // `chargeMode`. Today the two values map 1:1, but the wrapper layer
  // exists so the UI can speak in domain terms ("Pay by Phone")
  // while the engine stays generic.
  const chargeMode = cart.paymentMethod;

  const draft = await createSale(principal, clubId, {
    locationCode: LOUNGE_LOCATION_CODE,
    terminalCode: LOUNGE_TERMINAL_CODE,
    sessionId: session?.id ?? null,
    memberId: cart.memberId,
    chargeMode,
    diningMode: cart.diningMode ?? "STAY",
    lines: priced.lines.map((l) => ({
      kind: "SERVICE" as const,
      menuItemId: l.menuItemId,
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      taxAmount: l.taxAmount,
      // Stamp the allocated total discount onto the line so the GL
      // revenue credit (lineSubtotal − discountAmount per line) sums
      // to subtotal − totalDiscountAmount and the JE balances.
      discountAmount: l.totalLineDiscount,
      revenueAccountNumber: FB_REVENUE_ACCOUNT,
    })),
    taxLines: priced.taxTotal > 0
      ? [{ label: "GST 5%", rate: GST_RATE, amount: priced.taxTotal, taxCodeKey: "GST_5" }]
      : [],
    discounts: discountEntries,
    payments: [{
      method: chargeMode,
      amount: priced.grandTotal,
      tipAmount: 0,
    }],
    notes: cart.notes ?? null,
  });

  const completed = await completeSale(principal, draft.id);

  // Which destinations have items? The success UI uses this to decide
  // whether to surface the Kitchen / Bar chit links. SIGNATURE is always
  // produced because the member always signs.
  const destinationsNeeded: Array<"KITCHEN" | "BAR" | "SIGNATURE"> = ["SIGNATURE"];
  if (priced.lines.some((l) => l.destination === "KITCHEN")) destinationsNeeded.unshift("KITCHEN");
  if (priced.lines.some((l) => l.destination === "BAR")) destinationsNeeded.splice(destinationsNeeded.length - 1, 0, "BAR");

  return { sale: completed, destinationsNeeded };
}

// ---------------------------------------------------------------------------
// Admin-side history list for the lounge. Includes a batched lookup of the
// staff member who rang each sale — `POSSale.createdByUserId` has no Prisma
// relation defined (the project's convention is bare userId columns), so
// we resolve the user names in a single follow-up query and attach them
// as `createdByName`.
// ---------------------------------------------------------------------------
export type LoungeSaleRow = Awaited<ReturnType<typeof prisma.pOSSale.findMany>>[number] & {
  member: { id: string; firstName: string; lastName: string; memberNumber: string } | null;
  location: { code: string; name: string };
  lines: Array<{ id: string; description: string; quantity: unknown }>;
  createdByName: string | null;
};

export async function listLoungeSales(principal: Principal, clubId: string, opts: { limit?: number } = {}): Promise<LoungeSaleRow[]> {
  requirePermission(principal, clubId, "inventory:read");
  const sales = await prisma.pOSSale.findMany({
    where: {
      clubId,
      location: { code: LOUNGE_LOCATION_CODE },
    },
    include: {
      member: { select: { id: true, firstName: true, lastName: true, memberNumber: true } },
      location: { select: { code: true, name: true } },
      lines: { select: { id: true, description: true, quantity: true } },
    },
    orderBy: { saleDate: "desc" },
    take: opts.limit ?? 100,
  });

  // Resolve staff names in one batch query. Anonymous sales (or sales
  // imported from external POS providers without a Spectre user) keep
  // `createdByName: null` — the UI surfaces that as "—".
  const userIds = Array.from(new Set(sales.map((s) => s.createdByUserId).filter((id): id is string => !!id)));
  const users = userIds.length
    ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })
    : [];
  const nameById = new Map(users.map((u) => [u.id, u.name]));

  return sales.map((s) => ({
    ...s,
    createdByName: s.createdByUserId ? nameById.get(s.createdByUserId) ?? null : null,
  })) as LoungeSaleRow[];
}

// ---------------------------------------------------------------------------
// Member-side reads. These take `memberId` directly (resolved by the
// caller from session via `getActiveMember`) rather than a Principal —
// the page handler is responsible for proving the principal owns
// `memberId`. This mirrors the existing `lib/portal/billing.ts` pattern.
// ---------------------------------------------------------------------------
export async function listDiningForMember(memberId: string, opts: { limit?: number } = {}) {
  return prisma.pOSSale.findMany({
    where: {
      memberId,
      status: "COMPLETED",
      location: { code: LOUNGE_LOCATION_CODE },
    },
    include: {
      location: { select: { name: true } },
      lines: { select: { id: true, description: true, quantity: true, lineTotal: true } },
    },
    orderBy: { saleDate: "desc" },
    take: opts.limit ?? 25,
  });
}

export async function getDiningReceipt(saleId: string, memberId: string) {
  const sale = await prisma.pOSSale.findUnique({
    where: { id: saleId },
    include: {
      // Pull the frozen modifier snapshot so the member's receipt
      // shows exactly what was ordered ("Silver Burger — no onions,
      // add bacon"), independent of any later edit to the master
      // option list.
      lines: {
        orderBy: { id: "asc" },
        include: {
          modifiers: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
        },
      },
      taxLines: true,
      payments: true,
      location: { select: { name: true } },
      member: { select: { firstName: true, lastName: true, memberNumber: true } },
    },
  });
  // Only return the receipt if it belongs to the calling member and is
  // a finalised sale. Drafts/voided/refunded receipts aren't shown
  // member-side — those are admin-only states.
  if (!sale || sale.memberId !== memberId || sale.status !== "COMPLETED") {
    return null;
  }
  return sale;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
