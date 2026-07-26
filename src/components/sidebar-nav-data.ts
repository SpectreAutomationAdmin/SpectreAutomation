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
export type NavItem = { href: string; label: string; perm?: PermCheck };
export type NavSection = { id: string; label: string; items: NavItem[] };

// ---------- Admin nav: top-level (no section) ----------
export const ADMIN_TOP_LEVEL: NavItem[] = [
  { href: "/app/admin", label: "Dashboard" },
  { href: "/app/admin/search", label: "Search", perm: "search:read" },
];

// ---------- Admin nav: grouped sections ----------
export const ADMIN_SECTIONS: NavSection[] = [
  {
    id: "membership",
    label: "Membership",
    items: [
      { href: "/app/admin/applications", label: "Applications", perm: "applications:read" },
      { href: "/app/admin/members", label: "Members", perm: "members:read" },
      { href: "/app/admin/milestones", label: "Club Milestones", perm: "members:read" },
      { href: "/app/admin/events", label: "Club Events", perm: "events:read" },
    ],
  },
  {
    id: "finance",
    label: "Finance",
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
      { href: "/app/admin/ops/payroll", label: "Payroll", perm: "payroll:read" },
      { href: "/app/admin/ops/floor-plans", label: "Floor Plans", perm: "hospitality:floor:view" },
    ],
  },
  {
    id: "hospitality",
    label: "Hospitality",
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
    items: [
      { href: "/app/admin/analytics", label: "Overview", perm: "kpi:read" },
      { href: "/app/admin/analytics/hospitality/prep-times", label: "Hospitality prep times", perm: "kpi:read" },
    ],
  },
  {
    id: "communications",
    label: "Communications",
    items: [
      { href: "/app/admin/notifications", label: "Notifications", perm: "notifications:read" },
      { href: "/app/admin/notifications/email-health", label: "Email health", perm: "notifications:read" },
      { href: "/app/admin/notifications/analytics", label: "Notification analytics", perm: "notifications:read" },
    ],
  },
  {
    id: "data",
    label: "Data",
    items: [
      { href: "/app/admin/imports", label: "Imports", perm: "settings:write" },
      { href: "/app/admin/imports/jonas", label: "Imports · Jonas GL", perm: "settings:write" },
      { href: "/app/admin/imports/templates", label: "Import templates", perm: "settings:write" },
    ],
  },
  {
    id: "configuration",
    label: "Configuration",
    items: [
      { href: "/app/admin/settings", label: "Settings", perm: "settings:read" },
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
// Sprint 2 B3 (2026-07-19) — Connected accounts entry hides itself
// when MAILBOX_INTEGRATION_ENABLED is false. Server-side page
// enforces the flag; sidebar suppression is a nicety.
export const ADMIN_PERSONAL: NavItem[] = [
  { href: "/app/admin/mfa", label: "My MFA" },
  { href: "/app/user/settings/connected-accounts", label: "Connected accounts" },
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
