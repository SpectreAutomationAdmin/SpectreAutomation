// Silver Springs lounge modifier catalog.
//
// Maps menu-item names to modifier groups + options. Used by the
// initial seed (`prisma/seed.ts`) and a manual refresh script
// (`scripts/refresh-lounge-modifiers.ts`) so the live demo DB stays
// in sync without forcing a full reset.
//
// Each entry binds option templates onto items whose name matches a
// predicate (prefix / equals / category-hint). Multiple entries can
// match a single item — they're additive.

export type ModifierTypeLiteral = "REMOVE" | "ADD" | "SUBSTITUTE";

export type ModifierOptionSeed = {
  label: string;
  printLabel?: string;
  priceDelta?: number; // dollars, default 0
};

export type ModifierGroupSeed = {
  // Group label shown to the server when expanding the modifier panel.
  label: string;
  type: ModifierTypeLiteral;
  options: ModifierOptionSeed[];
};

// Predicate to decide which menu items a template should attach to.
// Receives both the lowercase item name AND the lowercase category
// name so templates can scope by category (e.g. "Kids Menu") instead
// of fragile substring matching.
export type ModifierTemplate = {
  // Human label for the template (only used in logs).
  name: string;
  matchItem: (itemNameLower: string, categoryNameLower: string) => boolean;
  groups: ModifierGroupSeed[];
};

// ----- Templates -------------------------------------------------------

// Burgers + handhelds — the classic "no onions, add bacon, fries→salad" set.
const handheldRemoves: ModifierGroupSeed = {
  label: "Remove",
  type: "REMOVE",
  options: [
    // "Plain" = "no condiments, no garnish" shortcut the line cook
    // reads as a single instruction instead of N individual "no X"
    // requests.
    { label: "Plain (no condiments or garnish)", printLabel: "Plain" },
    { label: "No onions" },
    { label: "No tomato" },
    { label: "No lettuce" },
    { label: "No pickle" },
    { label: "No sauce" },
  ],
};
const handheldAdds: ModifierGroupSeed = {
  label: "Add",
  type: "ADD",
  options: [
    { label: "Add bacon", priceDelta: 3 },
    { label: "Add cheese", priceDelta: 1 },
    { label: "Add mushrooms", priceDelta: 2 },
    { label: "Add avocado", priceDelta: 2 },
    { label: "Add fried egg", priceDelta: 2 },
  ],
};
// Condiments live as their own ADD group so the panel can render
// them on a separate row from the paid extras. All free.
const handheldCondiments: ModifierGroupSeed = {
  label: "Condiments",
  type: "ADD",
  options: [
    { label: "Ketchup" },
    { label: "Mustard" },
    { label: "Mayo" },
    { label: "BBQ sauce" },
    { label: "Hot sauce" },
    { label: "Ranch" },
    { label: "Honey mustard" },
    { label: "Tartar sauce" },
  ],
};
const handheldSubs: ModifierGroupSeed = {
  label: "Side substitution",
  type: "SUBSTITUTE",
  options: [
    { label: "Fries → House salad", priceDelta: 2 },
    { label: "Fries → Soup", priceDelta: 2 },
    { label: "Fries → Caesar salad", priceDelta: 2 },
    { label: "Regular bun → Lettuce wrap", printLabel: "Lettuce wrap" },
    { label: "Regular bun → Gluten-free bun", printLabel: "GF bun", priceDelta: 2 },
  ],
};

// Salads — remove dressing / nuts, add protein, dressing on side.
const saladRemoves: ModifierGroupSeed = {
  label: "Remove",
  type: "REMOVE",
  options: [
    { label: "No dressing" },
    { label: "Dressing on side", printLabel: "Dressing on side" },
    { label: "No cheese" },
    { label: "No nuts" },
    { label: "No croutons" },
  ],
};
const saladAdds: ModifierGroupSeed = {
  label: "Add protein",
  type: "ADD",
  options: [
    { label: "Add grilled chicken", priceDelta: 8 },
    { label: "Add shrimp", priceDelta: 8 },
    { label: "Add seared salmon", priceDelta: 6 },
    { label: "Add extra dressing", priceDelta: 1 },
  ],
};

// Kids items — light-touch modifiers. Substitution covers the most
// common "swap the fries" requests at the kids counter.
const kidsRemoves: ModifierGroupSeed = {
  label: "Remove",
  type: "REMOVE",
  options: [
    { label: "Sauce on side" },
    { label: "No garnish" },
    { label: "No crust (kids pizza)" },
  ],
};
const kidsAdds: ModifierGroupSeed = {
  label: "Add",
  type: "ADD",
  options: [
    { label: "Extra ketchup" },
  ],
};
const kidsSubs: ModifierGroupSeed = {
  label: "Side substitution",
  type: "SUBSTITUTE",
  options: [
    { label: "Fries → House salad" },
    { label: "Fries → Veggie sticks" },
    { label: "Fries → Apple slices" },
  ],
};

// Drinks — highball + standard cocktail removes/adds.
const drinkRemoves: ModifierGroupSeed = {
  label: "Remove",
  type: "REMOVE",
  options: [
    { label: "No ice" },
    { label: "No garnish" },
  ],
};
const drinkAdds: ModifierGroupSeed = {
  label: "Add",
  type: "ADD",
  options: [
    { label: "Double shot", priceDelta: 4.5 },
    { label: "Extra lime" },
    { label: "Tall pour", priceDelta: 1 },
  ],
};
const spiritSubs: ModifierGroupSeed = {
  label: "Spirit substitution",
  type: "SUBSTITUTE",
  options: [
    { label: "Rail → premium spirit", priceDelta: 3 },
  ],
};

// Desserts — light removes/adds.
const dessertRemoves: ModifierGroupSeed = {
  label: "Remove",
  type: "REMOVE",
  options: [{ label: "No whipped cream" }],
};
const dessertAdds: ModifierGroupSeed = {
  label: "Add",
  type: "ADD",
  options: [{ label: "Add scoop ice cream", priceDelta: 3 }],
};

const HANDHELD_KEYWORDS = [
  "burger",
  "ciabatta",
  "steak sandwich",
  "seafood melt",
  "turkey",
  "beef & cheddar",
  "chicken fingers",
  "pulled pork",
  "express sandwich",
  "fish & chips",
];

const SALAD_KEYWORDS = [
  "salad",
  "ramen",
  "quinoa power",
  "dynamite sushi",
];

const DRINK_KEYWORDS = [
  "highball",
  // Most beers also benefit from a "no ice" / "extra lime" modifier
  // since the lounge serves draft + bottled beer with lime garnish
  // on the rim of some glasses.
  "corona",
  "kronenbourg fruit",
  "radler",
  "cider",
];

const SPIRIT_KEYWORDS = ["highball"];

const DESSERT_KEYWORDS = [
  "cheesecake",
  "tiramisu",
  "ice cream",
  "sorbet",
  "reese",
];

export const LOUNGE_MODIFIER_TEMPLATES: ModifierTemplate[] = [
  // Kids gets matched FIRST (by category) so it shadows everything
  // else — a kids burger doesn't need adult burger modifiers.
  {
    name: "Kids",
    matchItem: (_n, c) => c === "kids menu",
    groups: [kidsRemoves, kidsAdds, kidsSubs],
  },
  {
    name: "Handheld / burger combo",
    matchItem: (n, c) =>
      c !== "kids menu" && HANDHELD_KEYWORDS.some((k) => n.includes(k)),
    groups: [handheldRemoves, handheldAdds, handheldCondiments, handheldSubs],
  },
  {
    name: "Salad",
    matchItem: (n, c) =>
      c !== "kids menu" && SALAD_KEYWORDS.some((k) => n.includes(k)),
    groups: [saladRemoves, saladAdds],
  },
  {
    name: "Drink",
    matchItem: (n) => DRINK_KEYWORDS.some((k) => n.includes(k)),
    groups: [drinkRemoves, drinkAdds],
  },
  {
    name: "Spirit",
    matchItem: (n) => SPIRIT_KEYWORDS.some((k) => n.includes(k)),
    groups: [spiritSubs],
  },
  {
    name: "Dessert",
    matchItem: (n) => DESSERT_KEYWORDS.some((k) => n.includes(k)),
    groups: [dessertRemoves, dessertAdds],
  },
];
