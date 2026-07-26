// Apply the modifier templates in `prisma/lounge-modifiers.ts` to every
// active lounge menu item in the live DB. Idempotent — re-running keeps
// the catalog in sync without wiping anything.
//
// Usage (standalone):  npx tsx scripts/refresh-lounge-modifiers.ts
// Used by:             prisma/seed.ts (after the menu seed)

import { prisma } from "@/lib/prisma";
import {
  LOUNGE_MODIFIER_TEMPLATES,
  type ModifierGroupSeed,
} from "../prisma/lounge-modifiers";

const LOUNGE_LOCATION_CODE = "FB-LOUNGE";

export async function seedLoungeModifiers(opts: { clubId: string; verbose?: boolean } = { clubId: "" }) {
  const { clubId, verbose = false } = opts;
  const log = verbose ? (m: string) => console.log(`  ${m}`) : () => {};

  // Caller may pass clubId or rely on us scanning every club that has a
  // lounge location. The seed always passes one club.
  const clubFilter = clubId ? { clubId } : {};

  const lounges = await prisma.pOSLocation.findMany({
    where: { ...clubFilter, code: LOUNGE_LOCATION_CODE },
    select: { id: true, clubId: true },
  });
  if (lounges.length === 0) {
    log("No lounge location — skipping modifier seed.");
    return { groups: 0, options: 0, items: 0 };
  }

  let groupCount = 0;
  let optionCount = 0;
  let itemCount = 0;

  for (const lounge of lounges) {
    const items = await prisma.pOSMenuItem.findMany({
      where: { clubId: lounge.clubId, category: { locationId: lounge.id }, isActive: true },
      select: { id: true, name: true, category: { select: { name: true } } },
    });

    for (const item of items) {
      const nameLower = item.name.toLowerCase();
      const catLower = item.category.name.toLowerCase();
      const matched = LOUNGE_MODIFIER_TEMPLATES.filter((t) => t.matchItem(nameLower, catLower));
      if (matched.length === 0) continue;
      itemCount++;

      // Idempotency: drop existing groups for this item before re-adding.
      // Options cascade via the group's onDelete: Cascade.
      await prisma.pOSModifierGroup.deleteMany({
        where: { clubId: lounge.clubId, menuItemId: item.id },
      });

      let groupSort = 0;
      for (const template of matched) {
        for (const g of template.groups) {
          await upsertGroup(lounge.clubId, item.id, g, groupSort);
          groupSort++;
          groupCount++;
          optionCount += g.options.length;
        }
      }
    }
  }

  log(`Seeded ${groupCount} groups · ${optionCount} options across ${itemCount} menu items.`);
  return { groups: groupCount, options: optionCount, items: itemCount };
}

async function upsertGroup(
  clubId: string,
  menuItemId: string,
  g: ModifierGroupSeed,
  sortOrder: number
) {
  const group = await prisma.pOSModifierGroup.create({
    data: {
      clubId,
      menuItemId,
      modifierType: g.type,
      label: g.label,
      sortOrder,
      isActive: true,
    },
  });
  for (let i = 0; i < g.options.length; i++) {
    const o = g.options[i];
    await prisma.pOSModifierOption.create({
      data: {
        clubId,
        groupId: group.id,
        label: o.label,
        printLabel: o.printLabel ?? null,
        priceDelta: o.priceDelta ?? 0,
        sortOrder: i,
        isActive: true,
      },
    });
  }
}

// Stand-alone runner.
async function main() {
  const club = await prisma.club.findFirst({ orderBy: { createdAt: "asc" } });
  if (!club) {
    console.error("No club — run `npm run db:reset` first.");
    process.exit(1);
  }
  console.log(`Seeding lounge modifiers for ${club.name} (${club.id})…`);
  const r = await seedLoungeModifiers({ clubId: club.id, verbose: true });
  console.log(`Done. ${r.groups} groups · ${r.options} options · ${r.items} items.`);
}

if (require.main === module) {
  main()
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
