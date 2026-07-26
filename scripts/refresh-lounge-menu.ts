// Refresh the Clubhouse Lounge menu in the live DB without forcing a
// full db:reset. Existing menu items that aren't in the new menu are
// marked `isActive: false` (not deleted) so historical POSSaleLine
// references stay intact. New items + categories are upserted.
//
// Usage:  npx tsx scripts/refresh-lounge-menu.ts
//
// Idempotent: re-running just keeps the menu in sync with whatever's
// currently in `prisma/lounge-menu.ts`.

import { prisma } from "@/lib/prisma";
import { LOUNGE_MENU } from "../prisma/lounge-menu";

const LOUNGE_LOCATION_CODE = "FB-LOUNGE";

async function main() {
  console.log("Refreshing Clubhouse Lounge menu…");

  // Find the lounge location(s). We do this per-club so a multi-tenant
  // install gets each club's lounge refreshed in one pass.
  const lounges = await prisma.pOSLocation.findMany({
    where: { code: LOUNGE_LOCATION_CODE },
    include: { menuCategories: { include: { items: true } } },
  });

  if (lounges.length === 0) {
    console.warn("  No POSLocation with code FB-LOUNGE found — nothing to do.");
    return;
  }

  for (const lounge of lounges) {
    console.log(`\nClub ${lounge.clubId} · ${lounge.name}`);

    // Names that should be active after this refresh.
    const wantedCategories = new Set(LOUNGE_MENU.map((g) => g.category));
    const wantedItems = new Set<string>();
    for (const g of LOUNGE_MENU) {
      for (const it of g.items) wantedItems.add(`${g.category}::${it.name}`);
    }

    // 1. Deactivate categories and items not in the new menu.
    let deactivatedCats = 0;
    let deactivatedItems = 0;
    for (const cat of lounge.menuCategories) {
      const catWanted = wantedCategories.has(cat.name);
      for (const it of cat.items) {
        const itemWanted = wantedItems.has(`${cat.name}::${it.name}`);
        if (!itemWanted && it.isActive) {
          await prisma.pOSMenuItem.update({ where: { id: it.id }, data: { isActive: false } });
          deactivatedItems++;
        }
      }
      if (!catWanted && cat.isActive) {
        await prisma.pOSMenuCategory.update({ where: { id: cat.id }, data: { isActive: false } });
        deactivatedCats++;
      }
    }
    console.log(`  Deactivated ${deactivatedCats} categor${deactivatedCats === 1 ? "y" : "ies"}, ${deactivatedItems} item${deactivatedItems === 1 ? "" : "s"} no longer on the menu.`);

    // 2. Upsert categories and items in the new menu.
    let upsertedCats = 0;
    let upsertedItems = 0;
    for (const group of LOUNGE_MENU) {
      const cat = await prisma.pOSMenuCategory.upsert({
        where: { clubId_locationId_name: { clubId: lounge.clubId, locationId: lounge.id, name: group.category } },
        update: { sortOrder: group.sortOrder, isActive: true, chitDestination: group.destination },
        create: {
          clubId: lounge.clubId, locationId: lounge.id,
          name: group.category, sortOrder: group.sortOrder, isActive: true,
          chitDestination: group.destination,
        },
      });
      upsertedCats++;
      for (let i = 0; i < group.items.length; i++) {
        const it = group.items[i];
        await prisma.pOSMenuItem.upsert({
          where: { clubId_categoryId_name: { clubId: lounge.clubId, categoryId: cat.id, name: it.name } },
          update: { price: it.price, description: it.description ?? null, sortOrder: i, isActive: true },
          create: {
            clubId: lounge.clubId, categoryId: cat.id,
            name: it.name, description: it.description ?? null,
            price: it.price, sortOrder: i, isActive: true,
          },
        });
        upsertedItems++;
      }
    }
    console.log(`  Upserted ${upsertedCats} categor${upsertedCats === 1 ? "y" : "ies"} and ${upsertedItems} active items.`);
  }

  console.log("\nDone.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
