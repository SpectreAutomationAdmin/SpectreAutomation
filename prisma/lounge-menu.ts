// Silver Springs Clubhouse Lounge — full F&B menu.
//
// Source of truth for both the initial seed (`prisma/seed.ts`) and the
// live-DB refresh script (`scripts/refresh-lounge-menu.ts`). Keep the
// menu here so both code paths stay in sync without copy-paste.
//
// Source: Silver Springs Golf Club April 2026 Digital Menu + 2021 Happy
// Hour beverage menu. Items are grouped by category with a routing
// destination (KITCHEN for prep tickets, BAR for drink tickets); the
// lounge POS uses that destination to decide which chit a line lands on.
//
// Prices are pre-tax dollars (GST is applied at sale time). When a
// dish has both half/full or sleeve/pint/pitcher sizes, each is its own
// `POSMenuItem` row so the POS UI can ring it up without modifiers —
// modifier support is a separate, larger feature.

export type LoungeMenuItem = {
  name: string;
  description?: string;
  price: number;
};

export type LoungeMenuCategory = {
  category: string;
  destination: "KITCHEN" | "BAR";
  sortOrder: number;
  items: LoungeMenuItem[];
};

export const LOUNGE_MENU: LoungeMenuCategory[] = [
  // ----- FOOD ------------------------------------------------------------
  {
    category: "Appetizers", destination: "KITCHEN", sortOrder: 1,
    items: [
      { name: "Chicken Wings", description: "1lb wings, vegetable sticks & ranch. Choose Frank's Hot, mild, salt & pepper, lemon pepper, BBQ, honey garlic, teriyaki, or weekly flavour.", price: 18 },
      { name: "Korean BBQ Duck Wings", description: "Slow-braised duck wings, Korean-style BBQ glaze, green onion, sesame, lime.", price: 20 },
      { name: "Wagyu Beef Dumplings", description: "Pan-seared, hoisin sesame soy dip, scallions, dynamite drizzle.", price: 16 },
      { name: "Tropical Fish Tacos (2)", description: "Mango-spice fried cod, chipotle aioli, lime coleslaw, pineapple pico de gallo, pickled red onion.", price: 16 },
      { name: "Pulled Pork & Potato Chip Sliders (2)", description: "House-braised pork, whiskey cola BBQ, kettle chips, lime coleslaw, pickle.", price: 16 },
      { name: "Dip Duo", description: "Masters pimento dip, hummus, crudité, tortilla chips, water crackers.", price: 14 },
      { name: "Nachos (Half)", description: "Tri-color tortilla chips, olives, jalapeños, peppers, mixed cheese, lime crema, pico, sour cream.", price: 14 },
      { name: "Nachos (Full)", description: "Tri-color tortilla chips, olives, jalapeños, peppers, mixed cheese, lime crema, pico, sour cream.", price: 22 },
    ],
  },
  {
    category: "Soups & Salads", destination: "KITCHEN", sortOrder: 2,
    items: [
      { name: "House Soup (Cup)", description: "Silver Springs house soup or feature soup.", price: 7 },
      { name: "House Soup (Bowl)", description: "Silver Springs house soup or feature soup.", price: 10 },
      { name: "House Salad (Starter)", description: "Artisan greens & arugula, cucumber, tomato, carrot, orange, apricot, fennel, feta, almond, maple balsamic.", price: 9 },
      { name: "House Salad (Full)", description: "Artisan greens & arugula, cucumber, tomato, carrot, orange, apricot, fennel, feta, almond, maple balsamic.", price: 15 },
      { name: "Caesar Salad (Starter)", description: "Romaine, croutons, Parmesan Reggiano, house dressing, charred lemon.", price: 9 },
      { name: "Caesar Salad (Full)", description: "Romaine, croutons, Parmesan Reggiano, house dressing, charred lemon.", price: 16 },
      { name: "Silver Cobb Salad", description: "Grilled chicken, bacon, cheese, avocado, tomato, cucumber, soft egg, citrus vinaigrette.", price: 18 },
      { name: "Dynamite Sushi Bowl", description: "Tempura shrimp, fried yams, sticky rice, greens, pickled ginger, pineapple, pico, cucumber, avocado, dynamite drizzle, soy citrus, nori, sesame.", price: 20 },
      { name: "Pork Ramen Bowl", description: "Chicken miso broth, egg noodles, shredded pork, soft egg, green onion, corn, cabbage.", price: 16 },
      { name: "Quinoa Power Bowl", description: "Quinoa, arugula, tempura yam, pickled asparagus, chickpeas, tomato, cucumber, avocado, lime, tarragon Dijon.", price: 16 },
      { name: "Power Up: Grilled Shrimp (5 pc)", description: "Add to any salad.", price: 8 },
      { name: "Power Up: Chicken Breast (6oz)", description: "Grilled or Cajun-style. Add to any salad.", price: 8 },
      { name: "Power Up: Seared Salmon (3oz)", description: "Add to any salad.", price: 6 },
      { name: "Power Up: Seared Salmon (6oz)", description: "Add to any salad.", price: 10 },
    ],
  },
  {
    category: "Express Sandwiches", destination: "KITCHEN", sortOrder: 3,
    items: [
      { name: "Express Sandwich (Half)", description: "Honey ham, roast turkey, BLT, or rotating salad on white or multigrain. With soup, salad, or fries.", price: 12 },
      { name: "Express Sandwich (Full)", description: "Honey ham, roast turkey, BLT, or rotating salad on white or multigrain. With soup, salad, or fries.", price: 16 },
    ],
  },
  {
    category: "Handhelds", destination: "KITCHEN", sortOrder: 4,
    items: [
      { name: "Silver Burger", description: "House patty, leaf lettuce, tomato, red onion, mayo, mustard, pickle, whiskey cola BBQ, cheddar, double-smoked bacon.", price: 22 },
      { name: "Springs Burger", description: "House patty, leaf lettuce, tomato, red onion, mayo, mustard, pickle, whiskey cola BBQ. Add cheese $1.", price: 18 },
      { name: "Mushroom Swiss Burger", description: "House patty, leaf lettuce, tomato, garlic mayo, mustard, mushrooms & onion, Swiss.", price: 22 },
      { name: "Malibu Vegan Burger", description: "Veggie patty (rice, corn, black beans), spicy aioli, avocado, house BBQ, vegan cheese.", price: 17 },
      { name: "Steak Sandwich", description: "Grilled 6oz Alberta AAA flatiron, wild mushrooms, crispy onion ring, Texas garlic toast.", price: 26 },
      { name: "Chicken Ciabatta Club", description: "Grilled chicken breast, smoked bacon, Havarti, arugula, red onion, tomato, Pecorino aioli, ciabatta.", price: 20 },
      { name: "Seafood Melt", description: "Open-faced croissant, lobster, crab & shrimp salad, mayo, Swiss, scallion, charred lemon.", price: 20 },
      { name: "Turkey Apple Havarti Wrap", description: "House-roasted turkey, Havarti, spinach, apple, cucumber, dried cranberries, mayo, flour tortilla.", price: 18 },
      { name: "Beef & Cheddar Dip", description: "House slow-roasted beef, cheddar, garlic-buttered Italian Filone bun, sherry au jus.", price: 22 },
      { name: "Chicken Fingers Basket (4)", description: "With plum sauce or Frank's buffalo with ranch.", price: 16 },
    ],
  },
  {
    category: "Mains", destination: "KITCHEN", sortOrder: 5,
    items: [
      { name: "Steak Frites", description: "Grilled 6oz flatiron, truffle butter, fries, garlic aioli, House or Caesar salad. Sub mashed & vegetables.", price: 28 },
      { name: "Beef & Vegetable Stir-Fry", description: "Shaved roast beef, stir fry veggies, hoisin sesame-soy, chow mein, pineapple, cilantro, sesame, lime.", price: 24 },
      { name: "Vegetable Stir-Fry", description: "Stir fry veggies, hoisin sesame-soy, chow mein, pineapple, cilantro, sesame, lime (no beef).", price: 20 },
      { name: "Mexican Chicken Kabob", description: "Chicken breast & thigh kabob, spiced rice & black beans, Chef's veggies, cilantro lime drizzle, lime.", price: 22 },
      { name: "Cacio e Pepe", description: "Bucatini, cracked pepper, pecorino, butter. Add chicken or shrimp $6.", price: 16 },
      { name: "Spring Shrimp Risotto", description: "Peas, spinach, asparagus, creamy Parmesan rice, grilled Cajun shrimp, charred lemon.", price: 22 },
      { name: "Vegetarian Spring Risotto", description: "Peas, spinach, asparagus, creamy Parmesan rice, charred lemon (no shrimp).", price: 18 },
      { name: "Summer Salmon", description: "Cocoa BBQ-rubbed Atlantic salmon, pineapple pico, quinoa, Chef's vegetables, fresh lime.", price: 26 },
      { name: "Fish & Chips (1 piece)", description: "Beer-battered haddock, fries, tartar, coleslaw.", price: 15 },
      { name: "Fish & Chips (2 pieces)", description: "Beer-battered haddock, fries, tartar, coleslaw.", price: 20 },
    ],
  },
  {
    category: "Pizza", destination: "KITCHEN", sortOrder: 6,
    items: [
      { name: "Double Pepperoni Pizza (8\")", description: "Tomato marinara, double pepperoni, mozzarella, hot honey drizzle.", price: 22 },
      { name: "Double Pepperoni Pizza (12\")", description: "Tomato marinara, double pepperoni, mozzarella, hot honey drizzle.", price: 28 },
      { name: "Pulled Pork Pizza (8\")", description: "Tomato marinara, whiskey cola pulled pork, fried yam, corn, green onion, mozzarella, lime drizzle.", price: 22 },
      { name: "Pulled Pork Pizza (12\")", description: "Tomato marinara, whiskey cola pulled pork, fried yam, corn, green onion, mozzarella, lime drizzle.", price: 28 },
      { name: "Buffalo Chicken Caesar Pizza (8\")", description: "Caesar dressing, mozzarella, crispy chicken, bacon, buffalo drizzle, romaine, Parmesan, charred lemon.", price: 22 },
      { name: "Buffalo Chicken Caesar Pizza (12\")", description: "Caesar dressing, mozzarella, crispy chicken, bacon, buffalo drizzle, romaine, Parmesan, charred lemon.", price: 28 },
      { name: "Loaded Veggie Delight (8\")", description: "Tomato marinara, mixed cheese, artichokes, sun-dried tomato, spinach, peppers, red onion, olives, capers, honey-maple mascarpone drizzle.", price: 22 },
      { name: "Loaded Veggie Delight (12\")", description: "Tomato marinara, mixed cheese, artichokes, sun-dried tomato, spinach, peppers, red onion, olives, capers, honey-maple mascarpone drizzle.", price: 28 },
      { name: "Build Your Own Pizza (8\")", description: "Choose base. Extra cheese $3, protein $3, veggies $2 — record in note.", price: 15 },
      { name: "Build Your Own Pizza (12\")", description: "Choose base. Extra cheese $3, protein $3, veggies $2 — record in note.", price: 20 },
    ],
  },
  {
    category: "Desserts", destination: "KITCHEN", sortOrder: 7,
    items: [
      { name: "Vanilla Ice Cream (scoop)", description: "Plain, caramel, or chocolate sauce.", price: 3 },
      { name: "Reese's Peanut Butter Cup", price: 9 },
      { name: "Rotating Sorbet (2 scoops)", description: "With seasonal fruit.", price: 8 },
      { name: "White Chocolate Blueberry Cheesecake", description: "With blueberry compote.", price: 9 },
      { name: "House Made Tiramisu", description: "Mascarpone, coffee & Kahlua lady fingers, cocoa dust.", price: 9 },
    ],
  },
  {
    category: "Kids Menu", destination: "KITCHEN", sortOrder: 8,
    items: [
      { name: "Pasta & Garlic Toast", description: "Tomato, Alfredo, or butter & Parmesan. Includes ice cream + drink.", price: 10 },
      { name: "Chicken Fingers (2) & Fries", description: "Includes ice cream + drink.", price: 10 },
      { name: "Grilled Cheese & Fries", description: "Includes ice cream + drink.", price: 10 },
      { name: "Kids 8\" Pizza", description: "Cheese or pepperoni. Includes ice cream + drink.", price: 10 },
      { name: "Kids Burger", description: "Mustard, ketchup, pickles, red onion. Add cheese $1. Includes ice cream + drink.", price: 10 },
    ],
  },

  // ----- BAR -------------------------------------------------------------
  {
    // Pairing notes are shown on the POS tile so the server can suggest
    // a match alongside the food order. Keep each line tight — the
    // tile clamps descriptions to two lines.
    category: "Wine", destination: "BAR", sortOrder: 9,
    items: [
      { name: "Chatelain Sauvignon Blanc (6oz)", description: "Crisp Loire white, citrus and cut grass. Pairs with Fish Tacos, House Salad, Caesar.", price: 5.5 },
      { name: "Chatelain Sauvignon Blanc (9oz)", description: "Crisp Loire white, citrus and cut grass. Pairs with Fish Tacos, House Salad, Caesar.", price: 9.0 },
      { name: "Manos Chardonnay (6oz)", description: "Lightly oaked Argentine white, stone fruit and butter. Pairs with Summer Salmon, Shrimp Risotto, Chicken Club.", price: 5.5 },
      { name: "Manos Chardonnay (9oz)", description: "Lightly oaked Argentine white, stone fruit and butter. Pairs with Summer Salmon, Shrimp Risotto, Chicken Club.", price: 9.0 },
      { name: "Zenato Pinot Grigio (6oz)", description: "Lean Italian white, green apple and almond. Pairs with Cacio e Pepe, House Salad, Beef Dumplings.", price: 5.5 },
      { name: "Zenato Pinot Grigio (9oz)", description: "Lean Italian white, green apple and almond. Pairs with Cacio e Pepe, House Salad, Beef Dumplings.", price: 9.0 },
      { name: "Joya Rosé (6oz)", description: "Dry Mediterranean rosé, strawberry and herb. Pairs with Chicken Kabob, Fish Tacos, Korean Duck Wings.", price: 5.5 },
      { name: "Joya Rosé (9oz)", description: "Dry Mediterranean rosé, strawberry and herb. Pairs with Chicken Kabob, Fish Tacos, Korean Duck Wings.", price: 9.0 },
      { name: "Alamos Malbec (6oz)", description: "Argentine red, dark fruit and pepper. Pairs with Silver Burger, Steak Frites, Steak Sandwich.", price: 5.5 },
      { name: "Alamos Malbec (9oz)", description: "Argentine red, dark fruit and pepper. Pairs with Silver Burger, Steak Frites, Steak Sandwich.", price: 9.0 },
      { name: "Carmen Cabernet (6oz)", description: "Chilean red, blackcurrant and cedar. Pairs with Steak Sandwich, Mushroom Swiss, Beef & Cheddar Dip.", price: 5.5 },
      { name: "Carmen Cabernet (9oz)", description: "Chilean red, blackcurrant and cedar. Pairs with Steak Sandwich, Mushroom Swiss, Beef & Cheddar Dip.", price: 9.0 },
      { name: "Fontella Chianti (6oz)", description: "Tuscan Sangiovese, cherry and leather. Pairs with Pepperoni Pizza, Cacio e Pepe, Pulled Pork Sliders.", price: 5.5 },
      { name: "Fontella Chianti (9oz)", description: "Tuscan Sangiovese, cherry and leather. Pairs with Pepperoni Pizza, Cacio e Pepe, Pulled Pork Sliders.", price: 9.0 },
      { name: "50th Anniversary Red (6oz)", description: "House red — soft, round and versatile. Pairs with burgers, pizza, steak.", price: 5.0 },
      { name: "50th Anniversary Red (9oz)", description: "House red — soft, round and versatile. Pairs with burgers, pizza, steak.", price: 8.0 },
      { name: "50th Anniversary White (6oz)", description: "House white — balanced and clean. Pairs with salads, salmon, pasta.", price: 5.0 },
      { name: "50th Anniversary White (9oz)", description: "House white — balanced and clean. Pairs with salads, salmon, pasta.", price: 8.0 },
    ],
  },
  {
    category: "Beer · Domestic", destination: "BAR", sortOrder: 10,
    items: [
      { name: "Big Rock Traditional", description: "Calgary brown ale, malty and smooth. Pairs with Silver Burger, Chicken Wings, Beef & Cheddar Dip.", price: 7.75 },
      { name: "Bud", description: "American lager, clean and crisp. Pairs with wings, nachos, pizza.", price: 6.5 },
      { name: "Bud Light", description: "Light American lager, low body. Pairs with wings, nachos, salads.", price: 6.5 },
      { name: "Bud Light Lime", description: "Citrus-spiked light lager. Pairs with Tropical Fish Tacos, nachos, wings.", price: 6.5 },
      { name: "Canadian", description: "Classic Canadian lager, balanced and bready. Pairs with burgers, pizza, ribs.", price: 6.5 },
      { name: "Coors Light", description: "Crisp light lager, low bitterness. Pairs with wings, nachos, pizza.", price: 6.5 },
      { name: "Keith's", description: "Halifax pale ale, malty with a clean finish. Pairs with Fish & Chips, burgers, sandwiches.", price: 6.5 },
      { name: "Kokanee", description: "BC lager, light and refreshing. Pairs with nachos, wings, fries.", price: 6.5 },
      { name: "Molson Ultra", description: "Low-calorie lager, lean profile. Pairs with salads, sandwiches, wraps.", price: 6.5 },
      { name: "Sleeman Honey Brown", description: "Ontario brown ale, soft honey note. Pairs with Silver Burger, Beef Stir-Fry, Pulled Pork.", price: 7.75 },
      { name: "Village Blonde", description: "Calgary blonde ale, soft and approachable. Pairs with wings, sandwiches, salads.", price: 7.75 },
      { name: "Village Blacksmith", description: "Dark roasted ale, coffee and cocoa notes. Pairs with steak, pulled pork, burgers.", price: 7.75 },
      { name: "Wild Rose Velvet Fog", description: "Calgary wheat ale, citrus and clove. Pairs with salads, seafood, brunch.", price: 7.75 },
      { name: "Wild Rose IPA", description: "Hoppy and bitter, citrus and pine. Pairs with Buffalo Chicken Pizza, spicy wings, burgers.", price: 7.75 },
      { name: "Wild Rose Wraspberry", description: "Raspberry wheat ale, fruity and tart. Pairs with desserts, salads, brunch.", price: 7.75 },
    ],
  },
  {
    category: "Beer · Imported", destination: "BAR", sortOrder: 11,
    items: [
      { name: "Corona", description: "Mexican lager, dry with a citrus finish. Pairs with Tropical Fish Tacos, Mexican Chicken Kabob, nachos.", price: 8.0 },
      { name: "Guinness", description: "Irish dry stout, roasted and creamy. Pairs with Beef & Cheddar Dip, Steak Sandwich, burgers.", price: 8.0 },
      { name: "Heineken", description: "Dutch lager, lightly hoppy and crisp. Pairs with pizza, sandwiches, salads.", price: 8.0 },
      { name: "Kronenbourg Blanc", description: "French wheat beer with coriander and orange. Pairs with salads, seafood, brunch.", price: 8.0 },
      { name: "Kronenbourg Fruit", description: "Fruit-forward French wheat beer. Pairs with desserts, salads, brunch.", price: 8.0 },
      { name: "Whistler Forager", description: "Gluten-free pale ale, crisp and clean. Pairs with burgers, sandwiches, salads.", price: 8.0 },
    ],
  },
  {
    category: "Beer · Draught", destination: "BAR", sortOrder: 12,
    items: [
      { name: "50th Anniversary Ale (Sleeve)", description: "House anniversary ale, balanced and easy. Pairs with burgers, pizza, wings.", price: 5.25 },
      { name: "50th Anniversary Ale (Pint)", description: "House anniversary ale, balanced and easy. Pairs with burgers, pizza, wings.", price: 6.75 },
      { name: "50th Anniversary Ale (Pitcher)", description: "House anniversary ale, balanced and easy. Pairs with burgers, pizza, wings.", price: 19.0 },
      { name: "Zero Issue IPA (Sleeve)", description: "Calgary IPA, citrus and pine hops. Pairs with Buffalo Chicken Pizza, spicy wings, burgers.", price: 7.0 },
      { name: "Zero Issue IPA (Pint)", description: "Calgary IPA, citrus and pine hops. Pairs with Buffalo Chicken Pizza, spicy wings, burgers.", price: 10.0 },
      { name: "Zero Issue IPA (Pitcher)", description: "Calgary IPA, citrus and pine hops. Pairs with Buffalo Chicken Pizza, spicy wings, burgers.", price: 25.0 },
      { name: "Half Hitch Shotgun (Sleeve)", description: "Cochrane red ale, caramel notes. Pairs with Silver Burger, Steak Sandwich, Pulled Pork.", price: 6.5 },
      { name: "Half Hitch Shotgun (Pint)", description: "Cochrane red ale, caramel notes. Pairs with Silver Burger, Steak Sandwich, Pulled Pork.", price: 9.5 },
      { name: "Half Hitch Shotgun (Pitcher)", description: "Cochrane red ale, caramel notes. Pairs with Silver Burger, Steak Sandwich, Pulled Pork.", price: 23.0 },
      { name: "Coors Light Draught (Sleeve)", description: "Light lager on tap, crisp finish. Pairs with wings, nachos, pizza.", price: 6.5 },
      { name: "Coors Light Draught (Pint)", description: "Light lager on tap, crisp finish. Pairs with wings, nachos, pizza.", price: 9.5 },
      { name: "Coors Light Draught (Pitcher)", description: "Light lager on tap, crisp finish. Pairs with wings, nachos, pizza.", price: 23.0 },
      { name: "Alexander Keith's Light Ale (Sleeve)", description: "Halifax light ale, malty and clean. Pairs with Fish & Chips, sandwiches, salads.", price: 6.5 },
      { name: "Alexander Keith's Light Ale (Pint)", description: "Halifax light ale, malty and clean. Pairs with Fish & Chips, sandwiches, salads.", price: 9.5 },
      { name: "Alexander Keith's Light Ale (Pitcher)", description: "Halifax light ale, malty and clean. Pairs with Fish & Chips, sandwiches, salads.", price: 23.0 },
      { name: "Wild Rose Wred (Sleeve)", description: "Calgary red ale, caramel and toast. Pairs with burgers, pulled pork, ribs.", price: 6.5 },
      { name: "Wild Rose Wred (Pint)", description: "Calgary red ale, caramel and toast. Pairs with burgers, pulled pork, ribs.", price: 9.5 },
      { name: "Wild Rose Wred (Pitcher)", description: "Calgary red ale, caramel and toast. Pairs with burgers, pulled pork, ribs.", price: 23.0 },
      { name: "Stella Artois (Sleeve)", description: "Belgian pilsner, clean with a crisp bitter finish. Pairs with mussels, salads, pizza.", price: 7.5 },
      { name: "Stella Artois (Pint)", description: "Belgian pilsner, clean with a crisp bitter finish. Pairs with mussels, salads, pizza.", price: 10.5 },
      { name: "Stella Artois (Pitcher)", description: "Belgian pilsner, clean with a crisp bitter finish. Pairs with mussels, salads, pizza.", price: 26.0 },
    ],
  },
  {
    category: "Cider & Coolers", destination: "BAR", sortOrder: 13,
    items: [
      { name: "Strongbow Cider", description: "English apple cider, dry and crisp. Pairs with Pulled Pork Sliders, Turkey Wrap, salads.", price: 8.0 },
      { name: "Steigl Radler", description: "Austrian grapefruit shandy, bright and tart. Pairs with salads, brunch, Fish Tacos.", price: 9.0 },
      { name: "Okanagan Springs Pear Cider", description: "BC pear cider, soft and aromatic. Pairs with desserts, salads, pork.", price: 7.5 },
      { name: "Okanagan Springs Apple Cider", description: "BC apple cider, dry and crisp. Pairs with Pulled Pork, sandwiches, salads.", price: 7.5 },
    ],
  },
  {
    category: "Highballs", destination: "BAR", sortOrder: 14,
    items: [
      // Spirits use the same 1oz/$4.50 price tier; the server records
      // the actual spirit (rye, vodka, gin, etc.) in the line note so
      // the bar knows what to pour.
      { name: "Highball (1oz)", description: "Rye, vodka, gin, rum, tequila or whisky — specify in note. Rye/whisky with steak; gin/vodka with seafood; tequila with tacos.", price: 4.5 },
    ],
  },
  {
    category: "Non-Alcoholic", destination: "BAR", sortOrder: 15,
    items: [
      { name: "Heineken Zero", price: 5.5 },
      { name: "Bud Prohibition", price: 5.5 },
    ],
  },
];
