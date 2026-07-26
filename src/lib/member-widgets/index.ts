// Member-hub widget service. Reads + writes `DashboardWidget` for a single
// member. All operations are tenant-safe:
//   - The caller resolves the principal's `memberId` via `getActiveMember`.
//   - This service refuses to act on a `memberId` belonging to a different
//     club than the principal would be allowed to see.
//
// We don't store unknown widget keys — every key is validated against
// `WIDGET_CATALOG` so a stale row doesn't crash the renderer.

import { z } from "zod";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { defaultEnabledKeys, isWidgetKey, isWidgetSize, WIDGET_KEYS, widgetEntry, type WidgetKey, type WidgetSize } from "./catalog";

export type MemberWidget = {
  id: string;
  widgetType: WidgetKey;
  enabled: boolean;
  sortOrder: number;
  size: WidgetSize;
};

async function memberOrThrow(memberId: string) {
  const m = await prisma.member.findUnique({
    where: { id: memberId },
    select: { id: true, clubId: true },
  });
  if (!m) throw new NotFoundError("Member", memberId);
  return m;
}

function assertOwnHub(principalMemberId: string | null | undefined, targetMemberId: string) {
  if (!principalMemberId) throw new ForbiddenError("Hub edits require an authenticated member");
  if (principalMemberId !== targetMemberId) {
    throw new ForbiddenError("Cannot edit another member's hub");
  }
}

// ---------------------------------------------------------------------------
// List — returns enabled widgets in saved order. Auto-seeds the default set
// the first time a member's hub is read.
// ---------------------------------------------------------------------------
export async function listForMember(memberId: string): Promise<MemberWidget[]> {
  const member = await memberOrThrow(memberId);
  const rows = await prisma.dashboardWidget.findMany({
    where: { memberId },
    orderBy: { sortOrder: "asc" },
  });
  if (rows.length === 0) {
    // First visit — seed defaults so the hub never renders empty. Each
    // widget gets its catalog-default size so the first impression is the
    // intended visual rhythm (compact for low-info tiles, detailed for the
    // rest).
    const defaults = defaultEnabledKeys();
    await prisma.dashboardWidget.createMany({
      data: defaults.map((key, i) => ({
        clubId: member.clubId,
        memberId,
        widgetType: key,
        enabled: true,
        sortOrder: i,
        size: widgetEntry(key).defaultSize,
      })),
    });
    const seeded = await prisma.dashboardWidget.findMany({
      where: { memberId },
      orderBy: { sortOrder: "asc" },
    });
    return seeded.filter((r) => isWidgetKey(r.widgetType)).map(toModel);
  }
  return rows.filter((r) => isWidgetKey(r.widgetType)).map(toModel);
}

function toModel(r: { id: string; widgetType: string; enabled: boolean; sortOrder: number; size: string }): MemberWidget {
  return {
    id: r.id,
    widgetType: r.widgetType as WidgetKey,
    enabled: r.enabled,
    sortOrder: r.sortOrder,
    size: isWidgetSize(r.size) ? r.size : "DETAILED",
  };
}

// ---------------------------------------------------------------------------
// Reorder — caller supplies the full desired ordering of enabled widget keys.
// Rows not in the list are kept but pushed to the end with enabled=false.
// ---------------------------------------------------------------------------
export const reorderSchema = z.object({
  memberId: z.string(),
  orderedKeys: z.array(z.string()).max(WIDGET_KEYS.length * 2),
});

export async function reorderWidgets(args: {
  principalMemberId: string | null | undefined;
  memberId: string;
  orderedKeys: string[];
  actorUserId?: string | null;
}) {
  const parsed = reorderSchema.safeParse(args);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  }
  assertOwnHub(args.principalMemberId, args.memberId);
  const member = await memberOrThrow(args.memberId);

  // Validate every key is in the catalog. Unknown keys are dropped silently
  // (defensive — the catalog is the contract).
  const knownOrdered = args.orderedKeys.filter(isWidgetKey);
  // De-dupe, preserve first occurrence.
  const seen = new Set<WidgetKey>();
  const uniqOrdered: WidgetKey[] = [];
  for (const k of knownOrdered) {
    if (!seen.has(k)) { seen.add(k); uniqOrdered.push(k); }
  }

  await prisma.$transaction(async (tx) => {
    // Bring every supplied widget into the row set (upsert).
    for (let i = 0; i < uniqOrdered.length; i++) {
      const key = uniqOrdered[i];
      const existing = await tx.dashboardWidget.findFirst({
        where: { memberId: args.memberId, widgetType: key },
      });
      if (existing) {
        await tx.dashboardWidget.update({
          where: { id: existing.id },
          data: { enabled: true, sortOrder: i },
        });
      } else {
        await tx.dashboardWidget.create({
          data: { clubId: member.clubId, memberId: args.memberId, widgetType: key, enabled: true, sortOrder: i },
        });
      }
    }
    // Any widget NOT in the supplied order is preserved but disabled and
    // appended after the visible set.
    let tailIndex = uniqOrdered.length;
    const all = await tx.dashboardWidget.findMany({ where: { memberId: args.memberId } });
    for (const row of all) {
      if (!(uniqOrdered as readonly string[]).includes(row.widgetType)) {
        await tx.dashboardWidget.update({
          where: { id: row.id },
          data: { enabled: false, sortOrder: tailIndex++ },
        });
      }
    }
  });

  await audit(args.actorUserId ? { id: args.actorUserId } : null, {
    action: "member.widget.reorder",
    entityType: "Member",
    entityId: args.memberId,
    clubId: member.clubId,
    after: { ordered: uniqOrdered },
  });
}

// ---------------------------------------------------------------------------
// Add — enable a widget (or insert it). Inserts at the END of the current
// enabled order so it doesn't surprise the user by jumping to position 0.
// ---------------------------------------------------------------------------
export async function addWidget(args: {
  principalMemberId: string | null | undefined;
  memberId: string;
  widgetType: string;
  actorUserId?: string | null;
}) {
  assertOwnHub(args.principalMemberId, args.memberId);
  if (!isWidgetKey(args.widgetType)) {
    throw new ValidationError([{ path: "widgetType", message: `Unknown widget: ${args.widgetType}` }]);
  }
  const member = await memberOrThrow(args.memberId);

  const enabledCount = await prisma.dashboardWidget.count({
    where: { memberId: args.memberId, enabled: true },
  });

  const existing = await prisma.dashboardWidget.findFirst({
    where: { memberId: args.memberId, widgetType: args.widgetType },
  });
  const widget = existing
    ? await prisma.dashboardWidget.update({
        where: { id: existing.id },
        data: { enabled: true, sortOrder: enabledCount },
      })
    : await prisma.dashboardWidget.create({
        data: {
          clubId: member.clubId,
          memberId: args.memberId,
          widgetType: args.widgetType,
          enabled: true,
          sortOrder: enabledCount,
          // New rows take the catalog's default size; the member can
          // toggle in-place after adding.
          size: widgetEntry(args.widgetType).defaultSize,
        },
      });

  await audit(args.actorUserId ? { id: args.actorUserId } : null, {
    action: "member.widget.add",
    entityType: "Member",
    entityId: args.memberId,
    clubId: member.clubId,
    after: { widgetType: args.widgetType },
  });
  return toModel(widget);
}

// ---------------------------------------------------------------------------
// Remove — soft remove. The row stays so the member's preferences are
// preserved if they add it back later.
// ---------------------------------------------------------------------------
export async function removeWidget(args: {
  principalMemberId: string | null | undefined;
  memberId: string;
  widgetType: string;
  actorUserId?: string | null;
}) {
  assertOwnHub(args.principalMemberId, args.memberId);
  if (!isWidgetKey(args.widgetType)) {
    throw new ValidationError([{ path: "widgetType", message: `Unknown widget: ${args.widgetType}` }]);
  }
  const member = await memberOrThrow(args.memberId);

  const existing = await prisma.dashboardWidget.findFirst({
    where: { memberId: args.memberId, widgetType: args.widgetType },
  });
  if (!existing) return; // idempotent
  await prisma.dashboardWidget.update({
    where: { id: existing.id },
    data: { enabled: false },
  });
  await audit(args.actorUserId ? { id: args.actorUserId } : null, {
    action: "member.widget.remove",
    entityType: "Member",
    entityId: args.memberId,
    clubId: member.clubId,
    after: { widgetType: args.widgetType },
  });
}

// ---------------------------------------------------------------------------
// Set size — toggle a widget between COMPACT and DETAILED. Idempotent and
// silent when the requested size already matches.
// ---------------------------------------------------------------------------
export async function setWidgetSize(args: {
  principalMemberId: string | null | undefined;
  memberId: string;
  widgetType: string;
  size: string;
  actorUserId?: string | null;
}) {
  assertOwnHub(args.principalMemberId, args.memberId);
  if (!isWidgetKey(args.widgetType)) {
    throw new ValidationError([{ path: "widgetType", message: `Unknown widget: ${args.widgetType}` }]);
  }
  if (!isWidgetSize(args.size)) {
    throw new ValidationError([{ path: "size", message: `Unknown size: ${args.size}` }]);
  }
  const member = await memberOrThrow(args.memberId);
  const existing = await prisma.dashboardWidget.findFirst({
    where: { memberId: args.memberId, widgetType: args.widgetType },
  });
  if (!existing) {
    throw new ValidationError([{ path: "widgetType", message: "Widget is not on this hub" }]);
  }
  if (existing.size === args.size) return toModel(existing);
  const updated = await prisma.dashboardWidget.update({
    where: { id: existing.id },
    data: { size: args.size },
  });
  await audit(args.actorUserId ? { id: args.actorUserId } : null, {
    action: "member.widget.resize",
    entityType: "Member",
    entityId: args.memberId,
    clubId: member.clubId,
    after: { widgetType: args.widgetType, size: args.size },
  });
  return toModel(updated);
}

export { WIDGET_CATALOG, widgetEntry, widgetsByCategory, defaultEnabledKeys, isWidgetKey, isWidgetSize } from "./catalog";
export type { WidgetKey, WidgetCatalogEntry, WidgetCategory, WidgetSize } from "./catalog";
