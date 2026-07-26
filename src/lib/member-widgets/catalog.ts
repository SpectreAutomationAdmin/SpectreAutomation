// Member hub widget catalog — the single source of truth for which widgets
// can appear on a member's dashboard.
//
// `DashboardWidget.widgetType` rows must use one of these keys; the page
// renderer ignores any unknown type. Adding a new widget is:
//   1. Append an entry to `WIDGET_CATALOG`
//   2. Render its content in `src/app/app/member/page.tsx`
//   3. (Optional) seed it for existing members
//
// `category` groups widgets in the catalog page UI. `defaultEnabled` is the
// out-of-the-box set used for a newly-onboarded member.

export type WidgetKey =
  | "ACCOUNT_BALANCE"
  | "PAYMENT_METHOD_STATUS"
  | "WEATHER"
  | "UPCOMING_TEE_TIMES"
  | "DRIVING_RANGE_CAMERA"
  | "LESSON_BOOKING"
  | "PRO_SHOP_RECENT"
  | "RESTAURANT_RECENT"
  | "UPCOMING_EVENTS"
  | "LEAGUES"
  | "PRIVATE_EVENTS_INQUIRY";

export type WidgetCategory = "ACCOUNT" | "GOLF" | "DINING" | "EVENTS";

export type WidgetSize = "COMPACT" | "DETAILED";

export const WIDGET_SIZES: readonly WidgetSize[] = ["COMPACT", "DETAILED"];

export function isWidgetSize(value: string): value is WidgetSize {
  return value === "COMPACT" || value === "DETAILED";
}

export type WidgetCatalogEntry = {
  key: WidgetKey;
  title: string;
  description: string;
  category: WidgetCategory;
  defaultEnabled: boolean;
  // Initial size the widget takes when first added to a member's hub.
  // Members can toggle the size in-place at any time.
  defaultSize: WidgetSize;
};

export const WIDGET_CATALOG: WidgetCatalogEntry[] = [
  {
    key: "ACCOUNT_BALANCE",
    title: "Account Balance",
    description: "Current balance, last payment date, and a quick link to your account.",
    category: "ACCOUNT",
    defaultEnabled: true,
    defaultSize: "DETAILED",
  },
  {
    key: "PAYMENT_METHOD_STATUS",
    title: "Payment Method",
    description: "Status of the payment method(s) on file for dues and charges.",
    category: "ACCOUNT",
    defaultEnabled: true,
    defaultSize: "COMPACT",
  },
  {
    key: "WEATHER",
    title: "Conditions",
    description: "On-course weather and the day's cart-path notes.",
    category: "GOLF",
    defaultEnabled: true,
    defaultSize: "COMPACT",
  },
  {
    key: "UPCOMING_TEE_TIMES",
    title: "Upcoming Tee Times",
    description: "Your next few bookings with playing partners.",
    category: "GOLF",
    defaultEnabled: true,
    defaultSize: "DETAILED",
  },
  {
    key: "DRIVING_RANGE_CAMERA",
    title: "Driving Range",
    description: "Live look at the range, so you can see how busy it is before you head out.",
    category: "GOLF",
    defaultEnabled: false,
    defaultSize: "DETAILED",
  },
  {
    key: "LESSON_BOOKING",
    title: "Lesson Booking",
    description: "Schedule a session with the teaching professional.",
    category: "GOLF",
    defaultEnabled: false,
    defaultSize: "COMPACT",
  },
  {
    key: "PRO_SHOP_RECENT",
    title: "Pro Shop · Recent",
    description: "Your latest Pro Shop purchases.",
    category: "DINING",
    defaultEnabled: true,
    defaultSize: "DETAILED",
  },
  {
    key: "RESTAURANT_RECENT",
    title: "Dining · Recent",
    description: "Your most recent dining and bar charges.",
    category: "DINING",
    defaultEnabled: true,
    defaultSize: "DETAILED",
  },
  {
    key: "UPCOMING_EVENTS",
    title: "Upcoming Events",
    description: "Club events on the calendar, in date order.",
    category: "EVENTS",
    defaultEnabled: true,
    defaultSize: "DETAILED",
  },
  {
    key: "LEAGUES",
    title: "Leagues",
    description: "Standings and tee times for the leagues you've joined.",
    category: "GOLF",
    defaultEnabled: false,
    defaultSize: "COMPACT",
  },
  {
    key: "PRIVATE_EVENTS_INQUIRY",
    title: "Private Events",
    description: "Start an inquiry for a wedding, anniversary, or corporate function.",
    category: "EVENTS",
    defaultEnabled: false,
    defaultSize: "COMPACT",
  },
];

export const WIDGET_KEYS: readonly WidgetKey[] = WIDGET_CATALOG.map((w) => w.key);

export function isWidgetKey(value: string): value is WidgetKey {
  return (WIDGET_KEYS as readonly string[]).includes(value);
}

export function widgetEntry(key: WidgetKey): WidgetCatalogEntry {
  const found = WIDGET_CATALOG.find((w) => w.key === key);
  if (!found) throw new Error(`Unknown widget key: ${key}`);
  return found;
}

export function defaultEnabledKeys(): WidgetKey[] {
  return WIDGET_CATALOG.filter((w) => w.defaultEnabled).map((w) => w.key);
}

export function widgetsByCategory(): Record<WidgetCategory, WidgetCatalogEntry[]> {
  const groups: Record<WidgetCategory, WidgetCatalogEntry[]> = {
    ACCOUNT: [], GOLF: [], DINING: [], EVENTS: [],
  };
  for (const w of WIDGET_CATALOG) groups[w.category].push(w);
  return groups;
}
