// Widget registry.
//
// Widgets are code, not data — each entry below is a known widget the platform
// knows how to render. Clubs can enable/disable widgets via ClubWidgetConfig;
// members can reorder enabled widgets via DashboardWidget.
//
// Adding a widget: add it here and render it in the member hub page.

import type { PermissionKey } from "./permissions";

export type WidgetMeta = {
  key: string;
  title: string;
  category: "ACCOUNT" | "CLUB" | "GOLF" | "DINING" | "ANNOUNCEMENTS";
  defaultEnabled: boolean;
  // Optional permission required to even *see* the widget (e.g. statements).
  requiredPermission?: PermissionKey;
  description: string;
};

export const WIDGETS: ReadonlyArray<WidgetMeta> = [
  { key: "WELCOME",                title: "Welcome",                  category: "CLUB",          defaultEnabled: true,  description: "A personal greeting at the top of the hub." },
  { key: "ACCOUNT_BALANCE",        title: "Account Balance",          category: "ACCOUNT",       defaultEnabled: true,  description: "Current balance and last payment." },
  { key: "ACCOUNT_AGING",          title: "Account Aging",            category: "ACCOUNT",       defaultEnabled: true,  description: "Aging snapshot — current/30/60/90/120+ buckets." },
  { key: "PAYMENT_METHOD_STATUS",  title: "Payment Method",           category: "ACCOUNT",       defaultEnabled: true,  description: "Primary / backup payment method status." },
  { key: "STATEMENTS",             title: "Statements",               category: "ACCOUNT",       defaultEnabled: true,  description: "Recent statements available for download.",
    requiredPermission: "self:statements:read" },
  { key: "RECENT_TRANSACTIONS",    title: "Recent Transactions",      category: "ACCOUNT",       defaultEnabled: true,  description: "Latest charges and payments." },
  { key: "UPCOMING_EVENTS",        title: "Upcoming Events",          category: "CLUB",          defaultEnabled: true,  description: "What's coming up at the club." },
  { key: "ANNOUNCEMENTS",          title: "Club Announcements",       category: "ANNOUNCEMENTS", defaultEnabled: true,  description: "News and updates from club leadership." },
  { key: "WEATHER",                title: "Conditions",               category: "GOLF",          defaultEnabled: true,  description: "Weather and course conditions." },
  { key: "UPCOMING_TEE_TIMES",     title: "Upcoming Tee Times",       category: "GOLF",          defaultEnabled: true,  description: "Your booked tee times." },
  { key: "LOTTERY_STATUS",         title: "Lottery Status",           category: "GOLF",          defaultEnabled: false, description: "Weekend lottery placement and results." },
  { key: "DRIVING_RANGE_CAMERA",   title: "Driving Range",            category: "GOLF",          defaultEnabled: false, description: "Live camera at the range." },
  { key: "LESSON_BOOKING",         title: "Lesson Booking",           category: "GOLF",          defaultEnabled: false, description: "Book a lesson with our professionals." },
  { key: "RESTAURANT_RECENT",      title: "Dining · Recent",          category: "DINING",        defaultEnabled: true,  description: "Recent dining-room purchases." },
  { key: "PRO_SHOP_RECENT",        title: "Pro Shop · Recent",        category: "DINING",        defaultEnabled: true,  description: "Recent Pro Shop purchases." },
  { key: "HOUSEHOLD",              title: "Household",                category: "ACCOUNT",       defaultEnabled: false, description: "Members of your household with privileges." },
  { key: "DOCUMENTS",              title: "Documents & Forms",        category: "ACCOUNT",       defaultEnabled: false, description: "Documents the club has shared with you." },
];

export function widgetsByKey(): Record<string, WidgetMeta> {
  return Object.fromEntries(WIDGETS.map((w) => [w.key, w]));
}
