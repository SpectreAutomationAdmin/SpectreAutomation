// Lounge POS menu modifiers.
//
// A "modifier" is a Remove / Add / Substitute / Allergy / Note applied
// to a check line so a server can ring up "Burger — no onions, add
// bacon, sub fries for salad, allergy: gluten" without free-typing.
//
// Data model:
//   • POSModifierGroup   — per-menu-item bundle of options
//                          (e.g. "Burger removes", "Burger adds")
//   • POSModifierOption  — the individual choices inside a group
//                          (e.g. "No onions", priceDelta 0; "Add bacon",
//                          priceDelta 3.00)
//   • POSCheckLineModifier — instance applied to a draft check line
//   • POSSaleLineModifier  — frozen snapshot copied at settlement
//
// Allergy + free-text notes don't live in the master catalog —
// they're stored only on the check line modifier rows themselves.
//
// Tenant safety: every public function requires a Principal and
// verifies that the line / menu item / option belongs to the same
// club. No cross-tenant leakage; cross-tenant input throws.

import { z } from "zod";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { assertTenantOwned } from "../services/tenant";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import type { POSCheckLineModifier as DbCheckLineModifier } from "@prisma/client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ModifierType = "REMOVE" | "ADD" | "SUBSTITUTE" | "ALLERGY" | "NOTE";
const MODIFIER_TYPES: readonly ModifierType[] = ["REMOVE", "ADD", "SUBSTITUTE", "ALLERGY", "NOTE"] as const;

// Input shape for setLineModifiers — the UI passes one of these per
// modifier the server has applied. `optionId` is the source catalog
// option ID for structured Remove/Add/Substitute selections; null for
// free-text and allergy notes.
export type ModifierInput = {
  optionId?: string | null;
  modifierType: ModifierType;
  // Snapshot label. Always required so the line is self-describing
  // even if the master option list later changes.
  label: string;
  printLabel?: string | null;
  // Per-unit modifier delta. Multiplied by line quantity at price time.
  priceDelta?: number;
  sortOrder?: number;
};

const modifierInputSchema = z.object({
  optionId: z.string().min(1).optional().nullable(),
  modifierType: z.enum(["REMOVE", "ADD", "SUBSTITUTE", "ALLERGY", "NOTE"]),
  label: z.string().trim().min(1).max(120),
  printLabel: z.string().trim().min(1).max(80).optional().nullable(),
  priceDelta: z.number().finite().min(-1000).max(1000).optional(),
  sortOrder: z.number().int().min(0).max(999).optional(),
});

// ---------------------------------------------------------------------------
// Master catalog read
// ---------------------------------------------------------------------------

// What the modifier panel needs to render for a given menu item:
// the active groups for that item plus their active options.
export async function listModifiersForItem(
  principal: Principal,
  menuItemId: string
) {
  const item = await prisma.pOSMenuItem.findUnique({
    where: { id: menuItemId },
    select: { id: true, clubId: true, name: true },
  });
  if (!item) throw new NotFoundError("POSMenuItem", menuItemId);
  assertTenantOwned(item, principal);
  requirePermission(principal, item.clubId, "inventory:read");

  const groups = await prisma.pOSModifierGroup.findMany({
    where: { clubId: item.clubId, menuItemId: item.id, isActive: true },
    include: {
      options: {
        where: { isActive: true },
        orderBy: [{ sortOrder: "asc" }, { label: "asc" }],
      },
    },
    orderBy: [{ sortOrder: "asc" }, { label: "asc" }],
  });
  return groups.map((g) => ({
    id: g.id,
    label: g.label,
    modifierType: g.modifierType as "REMOVE" | "ADD" | "SUBSTITUTE",
    options: g.options.map((o) => ({
      id: o.id,
      label: o.label,
      printLabel: o.printLabel,
      priceDelta: Number(o.priceDelta.toString()),
    })),
  }));
}

// ---------------------------------------------------------------------------
// Apply modifiers to a draft line
// ---------------------------------------------------------------------------

// Replace (transactionally) the modifier set on a draft check line.
// Sent / voided / comped lines are immutable from this entry point —
// the caller must void + re-add to change them.
export async function setLineModifiers(
  principal: Principal,
  checkLineId: string,
  raw: unknown
) {
  const parsed = z.object({ modifiers: z.array(modifierInputSchema).max(40) }).safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  }
  const modifiers = parsed.data.modifiers;

  // Allergy notes must carry a body — an "allergy" modifier with an
  // empty label is meaningless on the kitchen line.
  for (const m of modifiers) {
    if (m.modifierType === "ALLERGY" && !m.label.trim()) {
      throw new ValidationError([{ path: "modifiers.label", message: "Allergy note cannot be empty" }]);
    }
  }

  const line = await prisma.pOSCheckLine.findUnique({
    where: { id: checkLineId },
    include: { check: { select: { clubId: true, status: true } } },
  });
  if (!line) throw new NotFoundError("POSCheckLine", checkLineId);
  assertTenantOwned(line, principal);
  requirePermission(principal, line.clubId, "inventory:write");
  if (line.status !== "DRAFT") {
    throw new ConflictError(
      `Cannot modify a ${line.status.toLowerCase()} line. ` +
        "This item has already been sent. Void it with manager approval or add a new item."
    );
  }
  if (line.check.status === "CLOSED" || line.check.status === "VOIDED") {
    throw new ConflictError(`Cannot modify items on a ${line.check.status.toLowerCase()} check`);
  }

  // Cross-tenant block: every supplied optionId must belong to a
  // group attached to a menu item owned by this club AND attached to
  // THIS specific menu item. Free-text / allergy lines have no
  // optionId — skip them.
  const optionIds = modifiers.map((m) => m.optionId).filter((id): id is string => !!id);
  if (optionIds.length > 0) {
    const options = await prisma.pOSModifierOption.findMany({
      where: { id: { in: optionIds } },
      include: { group: { select: { clubId: true, menuItemId: true } } },
    });
    const byId = new Map(options.map((o) => [o.id, o]));
    for (const m of modifiers) {
      if (!m.optionId) continue;
      const opt = byId.get(m.optionId);
      if (!opt) throw new ConflictError(`Unknown modifier option: ${m.optionId}`);
      if (opt.group.clubId !== line.clubId) {
        throw new ConflictError("Cross-tenant modifier option blocked");
      }
      if (line.menuItemId && opt.group.menuItemId !== line.menuItemId) {
        throw new ConflictError("Modifier option does not belong to this menu item");
      }
    }
  }

  const hasAllergy = modifiers.some((m) => m.modifierType === "ALLERGY");

  // Transactional replace — drop the existing set, insert the new set,
  // flip the line's denormalised hasAllergy flag.
  await prisma.$transaction(async (tx) => {
    await tx.pOSCheckLineModifier.deleteMany({ where: { checkLineId: line.id } });
    if (modifiers.length > 0) {
      await tx.pOSCheckLineModifier.createMany({
        data: modifiers.map((m, idx) => ({
          clubId: line.clubId,
          checkLineId: line.id,
          optionId: m.optionId ?? null,
          modifierType: m.modifierType,
          label: m.label.trim(),
          printLabel: m.printLabel?.trim() ?? null,
          priceDelta: m.priceDelta ?? 0,
          sortOrder: m.sortOrder ?? idx,
        })),
      });
    }
    await tx.pOSCheckLine.update({
      where: { id: line.id },
      data: { hasAllergy },
    });
    await tx.pOSCheckEvent.create({
      data: {
        clubId: line.clubId,
        checkId: line.checkId,
        type: "ITEM_MODIFIED",
        payloadJson: JSON.stringify({
          checkLineId: line.id,
          count: modifiers.length,
          hasAllergy,
        }),
        byUserId: principal.id,
      },
    });
  });

  await audit(principal, {
    action: "pos.check.line.modify",
    entityType: "POSCheckLine",
    entityId: line.id,
    clubId: line.clubId,
    after: { count: modifiers.length, hasAllergy },
  });
}

// ---------------------------------------------------------------------------
// Pricing helpers — used by the UI cart + settlement.
// ---------------------------------------------------------------------------

// Per-unit modifier delta for a single line. Multiply by quantity to
// get the line-level modifier contribution. Modifier price deltas are
// per unit of the item — "add bacon" on 2× burger = 2× bacon charge.
export function modifierDeltaPerUnit(
  mods: ReadonlyArray<{ priceDelta: number | string | { toString(): string } }>
): number {
  let sum = 0;
  for (const m of mods) {
    sum += Number(m.priceDelta.toString());
  }
  return round2(sum);
}

// Compact display label for a list of modifiers — used on cart rows
// and chits. Allergy is intentionally bolded at the call site; here
// we just join the labels into a single line.
export function summarizeModifiers(
  mods: ReadonlyArray<{ modifierType: string; label: string; printLabel?: string | null }>,
  opts: { max?: number; usePrintLabel?: boolean } = {}
): string {
  const { max = 6, usePrintLabel = false } = opts;
  if (mods.length === 0) return "";
  const labels = mods.map((m) => (usePrintLabel ? m.printLabel || m.label : m.label));
  if (labels.length <= max) return labels.join(" · ");
  return `${labels.slice(0, max).join(" · ")} +${labels.length - max} more`;
}

// Type-narrowing helper for views that join modifiers in via Prisma.
export type LineWithModifiers<L> = L & { modifiers: DbCheckLineModifier[] };

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
