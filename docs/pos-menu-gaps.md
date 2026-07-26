# Clubhouse Lounge — Menu

The lounge POS at `/app/admin/ops/pos/lounge` reads its menu from
[`prisma/lounge-menu.ts`](../prisma/lounge-menu.ts) (the single source of
truth, imported by both the seed and the live-DB refresh script).

## Source

Two Silver Springs Golf Club menus, kept in sync with the data file:

- **Food**: April 2026 Digital Menu (Appetizers, Soups & Salads, Express
  Sandwiches, Handhelds, Mains, Pizza, Desserts, Kids Menu)
- **Beverages**: 2021 Happy Hour menu (Wine, Domestic/Imported/Draught
  beers, Cider & Coolers, Highballs, Non-Alcoholic)

131 items across 15 categories. KITCHEN-routed (food) and BAR-routed
(drinks) are tagged on the category so each chit goes to the right
prep destination automatically.

## Updating the menu

When the club publishes a new printed menu:

1. Edit [`prisma/lounge-menu.ts`](../prisma/lounge-menu.ts) — add, remove,
   or reprice items in the appropriate category.
2. To apply to a fresh database: `npm run db:reset` (wipes + reseeds).
3. To apply to an existing database **without losing historical sales**:
   `npx tsx scripts/refresh-lounge-menu.ts`
   This deactivates (`isActive: false`) any items no longer on the menu
   so historical POSSaleLine links stay valid, then upserts the new menu.

The refresh script is idempotent — re-running keeps the DB in sync with
whatever's in the data file.

## Known limitations of the current model

- **No modifiers.** Build-Your-Own Pizza's "extra cheese $3, protein $3,
  veggies $2" rule is captured in the description; the server records
  selections as a free-text line note. Same for spirit selection on
  Highballs and bread/filling choice on Express Sandwiches. A real
  modifier-and-options schema is a larger follow-up.
- **No allergen / dietary tags as data.** Dietary indicators (GF, DF,
  Vegan, etc.) are mentioned in item descriptions but not stored as
  structured tags — they don't drive filtering on the POS UI yet.
- **No happy-hour pricing.** The 2021 happy-hour menu lists discounted
  wine/beer prices during Wed–Sat 3–6 pm; the POS doesn't have
  time-of-day price rules, so seeded prices are the regular menu prices.
  Staff would apply discounts manually via the chit-level discount
  picker if a club opts in to time-of-day pricing later.
- **Item categories vs. real kitchen stations.** All food currently
  routes to "KITCHEN" as a single destination. A real club may split
  cold-line vs. hot-line vs. pizza oven, but our chit-destination model
  is binary today (KITCHEN | BAR). Adding more destinations is a
  schema-only change when the need arises.
