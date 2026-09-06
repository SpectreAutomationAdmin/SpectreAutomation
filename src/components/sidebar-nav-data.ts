// Admin sidebar navigation data.
//
// Pure data + types — no JSX. Lives in its own .ts module so server
// code and vitest tests can import the nav configuration without
// dragging the Sidebar's client-component JSX through the bundler.
//
// `Sidebar.tsx` re-imports the same constants and renders them.
// Permission gating, active-item highlighting, and the persisted
// collapse state all live in the React component; this file is
// just the source of truth for "what link goes where".

// "SUPER_ONLY" requires the platform super-admin role.
// A string or string[] is a permission key (or any-of when array).
// Undefined means visible to every admin who reached the layout.
export type PermCheck = string | string[] | "SUPER_ONLY";

// Sprint 3 · Checkpoint 15N — the Variant D sidebar icon system.
// Every top-level nav item, every section group, and every personal
// item carries a typed icon key. Sub-items inside a section stay
// text-only (their parent's icon carries the section identity —
// duplicating icons on children flattens the hierarchy the
// accordion establishes). See SidebarIcon.tsx for the SVG set.
import type { NavigationIconKey } from "./spectre/SidebarIcon";

export type NavItem = { href: string; label: string; perm?: PermCheck; icon?: NavigationIconKey };
export type NavSection = { id: string; label: string; items: NavItem[]; icon?: NavigationIconKey };

// ---------- Admin nav: top-level (no section) ----------
// Sprint 3 · Checkpoint 15M — "Dashboard" is renamed to "Mission
// Control" to match the founder-approved Variant D reference. The
// URL stays `/app/admin` so every existing bookmark, breadcrumb,
// and internal link keeps working; only the visible label + a11y
// label change. The duplicate top-level `Search` entry is also
// removed — the Spectre sidebar already renders a single search
// affordance at the top of the sidebar (see `SpectreSidebar.tsx`),
// so surfacing another one under Mission Control was noise.
export const ADMIN_TOP_LEVEL: NavItem[] = [
  { href: "/app/admin", label: "Mission Control", icon: "mission-control" },
];

// ---------- Admin nav: grouped sections ----------
export const ADMIN_SECTIONS: NavSection[] = [
  {
    id: "membership",
    label: "Membership",
    icon: "membership",
    items: [
      { href: "/app/admin/applications", label: "Applications", perm: "applications:read" },
      { href: "/app/admin/members", label: "Members", perm: "members:read" },
      { href: "/app/admin/milestones", label: "Club Milestones", perm: "members:read" },
      { href: "/app/admin/events", label: "Club Events", perm: "events:read" },
    ],
  },
  // HR-2A (2026-08-16) — People is the club-side administrative
  // beginning of the employee journey: directory + add-employee +
  // onboarding lifecycle. Placed directly after Membership so the
  // two rosters (club members / club employees) sit next to each
  // other in the founder-approved hospitality-oriented sequencing,
  // and BEFORE Finance so payroll-adjacent readiness cues are
  // upstream of the ledger surfaces that consume them.
  {
    id: "people",
    label: "People",
    icon: "people",
    items: [
      { href: "/app/admin/people/employees", label: "Employee Directory", perm: "hr:directory:view" },
      { href: "/app/admin/people/onboarding", label: "Onboarding", perm: "hr:onboarding:read" },
      // HR-2B.4 (2026-08-19) — Club-configurable onboarding
      // requirements (Documents & Credentials).
      { href: "/app/admin/people/onboarding-requirements", label: "Onboarding Requirements", perm: "hr:employee:write" },
      // HR-2C (2026-08-20) — Safety & Training compliance.
      { href: "/app/admin/people/safety-training", label: "Safety & Training", perm: "hr:training:read" },
    ],
  },
  {
    id: "finance",
    label: "Finance",
    icon: "finance",
    items: [
      { href: "/app/admin/finance", label: "Overview", perm: "ar:read" },
      { href: "/app/admin/collections", label: "Collections", perm: ["collections:work", "ar:read"] },
      { href: "/app/admin/financing", label: "Financing", perm: "financing:read" },
      { href: "/app/admin/gl", label: "General Ledger", perm: "gl:read" },
      { href: "/app/admin/periods", label: "Periods", perm: "gl:read" },
      { href: "/app/admin/coa", label: "Chart of Accounts", perm: "coa:read" },
      { href: "/app/admin/ops/budgets", label: "Budgets", perm: "budget:read" },
      { href: "/app/admin/opening-balances", label: "Opening balances", perm: "gl:post" },
      { href: "/app/admin/reports", label: "Reports", perm: ["reports:read", "reports:operating", "reports:financial"] },
    ],
  },
  {
    id: "ap",
    label: "Accounts Payable",
    icon: "accounts-payable",
    items: [
      { href: "/app/admin/ap", label: "Overview", perm: "ap:read" },
      { href: "/app/admin/ap/vendors", label: "Vendors", perm: "vendor:view" },
      { href: "/app/admin/ap/capture", label: "Capture Inbox", perm: "ap:capture:view" },
      { href: "/app/admin/ap/approvals", label: "My Approvals", perm: ["ap:invoice:approve", "ap:payment:approve"] },
    ],
  },
  {
    id: "operations",
    label: "Operations",
    icon: "operations",
    items: [
      { href: "/app/admin/ops", label: "Overview", perm: ["inventory:read", "inventory:view", "events:read", "lessons:view", "payroll:read", "assets:read"] },
      { href: "/app/admin/hospitality/reservations/floor", label: "Point of Sale", perm: ["inventory:read", "inventory:view"] },
      { href: "/app/admin/ops/pos/lounge", label: "Quick Sale / Bar", perm: ["inventory:read", "inventory:view"] },
      { href: "/app/admin/ops/pos/lounge/kitchen", label: "Kitchen chits", perm: ["inventory:read", "inventory:view"] },
      { href: "/app/admin/ops/pos/lounge/bar", label: "Bar chits", perm: ["inventory:read", "inventory:view"] },
      { href: "/app/admin/ops/pos/lounge/history", label: "Closed checks", perm: ["inventory:read", "inventory:view"] },
      { href: "/app/admin/ops/pos", label: "POS sales history", perm: ["inventory:read", "inventory:view"] },
      { href: "/app/admin/ops/tee-sheet", label: "Tee Sheet", perm: "events:read" },
      { href: "/app/admin/ops/tournaments", label: "Tournaments", perm: "events:read" },
      { href: "/app/admin/ops/private-events", label: "Private Events", perm: "events:private:read" },
      { href: "/app/admin/ops/lessons", label: "Lessons", perm: "lessons:view" },
      { href: "/app/admin/ops/inventory", label: "Inventory", perm: ["inventory:read", "inventory:view"] },
      { href: "/app/admin/ops/assets", label: "Capital Assets", perm: "assets:read" },
      { href: "/app/admin/ops/payroll", label: "Payroll (legacy)", perm: "payroll:read" },
      { href: "/app/admin/payroll/setup", label: "Payroll setup", perm: "payroll:read" },
      { href: "/app/admin/payroll/time", label: "Payroll time", perm: "payroll:timesheets:read" },
      { href: "/app/admin/payroll/process", label: "Payroll processing", perm: "payroll:read" },
      { href: "/app/admin/payroll/history", label: "Payroll history", perm: "payroll:read" },
      { href: "/app/admin/ops/floor-plans", label: "Floor Plans", perm: "hospitality:floor:view" },
    ],
  },
  {
    id: "hospitality",
    label: "Hospitality",
    // Sprint 3 · Checkpoint 15N — founder-required restrained
    // wine-glass glyph. Outline only, same 1.9 stroke as the rest.
    icon: "hospitality",
    items: [
      { href: "/app/admin/hospitality", label: "Overview", perm: "reservations:read" },
      { href: "/app/admin/hospitality/reservations", label: "Reservations", perm: "reservations:read" },
      { href: "/app/admin/hospitality/reservations/floor", label: "Floor Map", perm: "reservations:read" },
      { href: "/app/admin/hospitality/reservations/analytics", label: "Reservation Analytics", perm: "reservations:read" },
      { href: "/app/admin/hospitality/feedback", label: "Member Feedback", perm: "settings:read" },
    ],
  },
  {
    id: "governance",
    label: "Governance & Reporting",
    icon: "governance-reporting",
    items: [
      // Routes to the period-selection launcher, NOT directly to a
      // hardcoded reporting period. The launcher links into
      // `/app/admin/reporting/monthly?period=YYYY-MM` so the
      // controller picks the period before the document loads.
      { href: "/app/admin/governance/monthly-package", label: "Monthly Package", perm: "reports:board" },
      { href: "/app/admin/governance/board-committees", label: "Board & Committees", perm: "packages:read" },
      { href: "/app/admin/governance/packages", label: "Board Packages", perm: "packages:read" },
      { href: "/app/admin/governance/auditor", label: "Auditor Portal", perm: ["auditor:invite", "auditor:respond"] },
      { href: "/app/admin/governance/workflows", label: "Workflows", perm: "workflow:read" },
      { href: "/app/admin/dashboards", label: "Executive Dashboards", perm: "kpi:read" },
      { href: "/app/admin/insights", label: "Insights", perm: "insights:read" },
      { href: "/app/admin/documents", label: "Documents", perm: "documents:read" },
    ],
  },
  {
    id: "analytics",
    label: "Analytics",
    icon: "analytics",
    items: [
      { href: "/app/admin/analytics", label: "Overview", perm: "kpi:read" },
      { href: "/app/admin/analytics/hospitality/prep-times", label: "Hospitality prep times", perm: "kpi:read" },
    ],
  },
  {
    id: "communications",
    label: "Communications",
    icon: "communications",
    items: [
      { href: "/app/admin/notifications", label: "Notifications", perm: "notifications:read" },
      { href: "/app/admin/notifications/email-health", label: "Email health", perm: "notifications:read" },
      { href: "/app/admin/notifications/analytics", label: "Notification analytics", perm: "notifications:read" },
    ],
  },
  {
    id: "data",
    label: "Data",
    icon: "data",
    items: [
      { href: "/app/admin/imports", label: "Imports", perm: "settings:write" },
      { href: "/app/admin/imports/jonas", label: "Imports · Jonas GL", perm: "settings:write" },
      { href: "/app/admin/imports/templates", label: "Import templates", perm: "settings:write" },
    ],
  },
  {
    id: "configuration",
    label: "Configuration",
    icon: "configuration",
    items: [
      { href: "/app/admin/settings", label: "Settings", perm: "settings:read" },
      { href: "/app/admin/settings/users", label: "Tenant Users", perm: "users:invite" },
      { href: "/app/admin/feedback", label: "Anonymous Feedback", perm: "settings:read" },
      { href: "/app/admin/club-settings", label: "Club Settings", perm: "settings:read" },
      { href: "/app/admin/settings/domains", label: "Club domains", perm: "settings:write" },
      { href: "/app/admin/integrations", label: "Integrations", perm: "settings:write" },
      { href: "/app/admin/pos-mapping", label: "POS Mappings", perm: "settings:write" },
      { href: "/app/admin/settings/pos-printers", label: "POS Printers", perm: "settings:read" },
      { href: "/app/admin/devices", label: "Hardware Devices", perm: "settings:write" },
      { href: "/app/admin/security", label: "Security", perm: ["users:roles:write", "settings:write"] },
      { href: "/app/admin/api-keys", label: "API Keys", perm: "settings:write" },
      { href: "/app/admin/webhooks", label: "Webhooks", perm: "settings:write" },
      { href: "/app/admin/support/access", label: "Support access", perm: ["users:roles:write", "settings:write"] },
    ],
  },
  {
    id: "platform",
    label: "Spectre Platform",
    icon: "settings",
    items: [
      { href: "/app/admin/queues", label: "Queues", perm: "SUPER_ONLY" },
      { href: "/app/admin/pilot", label: "Pilot & Flags", perm: "SUPER_ONLY" },
      { href: "/app/admin/pilot/retrospective", label: "Pilot retrospective", perm: "SUPER_ONLY" },
      { href: "/app/admin/launch", label: "Launch Readiness", perm: "SUPER_ONLY" },
      { href: "/app/admin/pilot/readiness", label: "Pilot Readiness", perm: "SUPER_ONLY" },
      { href: "/app/admin/ops/system", label: "System Ops", perm: "SUPER_ONLY" },
      { href: "/app/admin/billing", label: "SaaS Billing", perm: "SUPER_ONLY" },
      { href: "/app/admin/saas", label: "SaaS Management", perm: "SUPER_ONLY" },
    ],
  },
];

// Personal items — always visible to every admin, unsectioned at the bottom.
// Sprint 3 · Checkpoint 15M — "Connected accounts" is removed from
// the sidebar. The mailbox connection is now surfaced in the Mission
// Control header as a "Feed synced" status pill; the underlying
// /app/user/settings/connected-accounts route still exists for the
// reconnect workflow, but is reached via the header status pill
// instead of a sidebar entry.
export const ADMIN_PERSONAL: NavItem[] = [
  { href: "/app/admin/mfa", label: "My MFA", icon: "mfa" },
];

// ---------- Member portal nav (unchanged from prior behavior) ----------
export const MEMBER_NAV: NavItem[] = [
  { href: "/app/member", label: "Member Hub" },
  { href: "/app/member/onboarding", label: "Onboarding" },
  { href: "/app/member/account", label: "My Account" },
  { href: "/app/member/payment-methods", label: "Payment Methods" },
  { href: "/app/member/profile", label: "Profile & Household" },
  { href: "/app/member/reservations", label: "Dining Reservations" },
  { href: "/app/member/dining", label: "Dining History" },
  { href: "/app/member/events", label: "Events" },
  { href: "/app/member/tournaments", label: "Tournaments" },
];

// ---------- Employee Portal nav (HR-2B.5 §32) ----------
//
// Permanent Employee Portal. Not administrative — an employee
// cannot see admin, finance, mission-control, or configuration
// surfaces from here. Route root is `/employee/**` and is guarded
// by the spectre_employee_session cookie (see slice 6).
// HR-2C Shell Refinement (2026-08-24) — Persistent portal navigation
// is Home + Profile ONLY. Functional destinations (Schedule /
// Availability / Pay / Safety & Training / Documents) are reached
// from Home widgets and remain accessible by direct URL /
// bookmark. This is intentional — the widgets are the primary
// launchers now. Route removal is a NAV change only; the routes
// themselves and their EmployeePortalPrincipal server-side gates
// are unchanged.
export const EMPLOYEE_NAV: Array<NavItem & { tourTarget?: string }> = [
  { href: "/employee", label: "Home" },
  { href: "/employee/profile", label: "Profile", tourTarget: "profile" },
];
