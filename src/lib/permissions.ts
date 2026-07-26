// Permission catalogue. Each permission key is `<domain>:<action>` and is
// granted to one or more roles via RolePermission (see prisma/seed.ts).
//
// Granular permissions are the source of truth. Roles are just convenient
// bundles. UI/route guards always check a permission, never a role.
//
// Adding a permission: add it here, add it to seedRolePermissions in seed.ts.

export const PERMISSIONS = {
  // System / platform
  "system:super_admin": { name: "Spectre super admin", category: "SYSTEM" },
  "system:audit:read": { name: "Read audit logs", category: "SYSTEM" },

  // Clubs (Spectre staff-only)
  "clubs:create": { name: "Create clubs", category: "SYSTEM" },
  "clubs:update": { name: "Update club settings", category: "SYSTEM" },

  // Users / permissions
  "users:read": { name: "View users", category: "USERS" },
  "users:invite": { name: "Invite users", category: "USERS" },
  "users:roles:write": { name: "Change user roles", category: "USERS" },

  // Member management
  "members:read": { name: "View members", category: "MEMBERS" },
  "members:write": { name: "Edit members", category: "MEMBERS" },
  "members:suspend": { name: "Suspend or restore member access", category: "MEMBERS" },

  // Applications
  "applications:read": { name: "View applications", category: "APPLICATIONS" },
  "applications:review": { name: "Approve/deny/waitlist applications", category: "APPLICATIONS" },
  "applications:assign": { name: "Assign reviewers", category: "APPLICATIONS" },
  "applications:documents:read": { name: "View applicant documents", category: "APPLICATIONS" },
  "applications:documents:upload": { name: "Upload applicant documents (admin side)", category: "APPLICATIONS" },

  // AR / billing / collections
  "ar:read": { name: "View AR", category: "AR" },
  "ar:write": { name: "Post charges/payments/credits", category: "AR" },
  "ar:adjust": { name: "Post adjustments (credit memos, write-offs)", category: "AR" },
  "ar:void": { name: "Void/reverse posted transactions", category: "AR" },
  "ar:statements:issue": { name: "Issue statements", category: "AR" },
  "ar:disputes:work": { name: "Manage member disputes", category: "AR" },
  "ar:notes:write": { name: "Add notes to a member account", category: "AR" },
  "collections:work": { name: "Send notices, suspend access", category: "AR" },
  "collections:templates:write": { name: "Edit notice templates", category: "AR" },
  "collections:stages:write": { name: "Configure collection stages", category: "AR" },

  // Payment methods
  "payment_methods:read": { name: "View payment methods (metadata)", category: "AR" },
  "payment_methods:write": { name: "Add/remove payment methods", category: "AR" },

  // Financing
  "financing:read": { name: "View financing agreements", category: "FINANCING" },
  "financing:write": { name: "Create/modify financing agreements", category: "FINANCING" },

  // Accounting / GL
  "gl:read": { name: "Read general ledger", category: "ACCOUNTING" },
  "gl:post": { name: "Post journal entries", category: "ACCOUNTING" },
  "gl:reverse": { name: "Reverse posted journal entries", category: "ACCOUNTING" },
  "gl:close_period": { name: "Close / reopen / lock accounting periods", category: "ACCOUNTING" },
  "coa:read": { name: "Read chart of accounts", category: "ACCOUNTING" },
  "coa:write": { name: "Create/edit accounts and FS groups", category: "ACCOUNTING" },

  // AP & Vendor management (Phase 4)
  "ap:read":                  { name: "Read AP module",                       category: "AP" },
  "vendor:view":              { name: "View vendors",                         category: "AP" },
  "vendor:create":            { name: "Create vendors (DRAFT)",               category: "AP" },
  "vendor:edit":              { name: "Edit vendor profile",                  category: "AP" },
  "vendor:approve":           { name: "Approve vendors for use",              category: "AP" },
  "vendor:banking:edit":      { name: "Add/modify vendor banking",            category: "AP" },
  "vendor:banking:approve":   { name: "Verify and activate vendor banking",   category: "AP" },
  "ap:invoice:view":          { name: "View AP invoices",                     category: "AP" },
  "ap:invoice:create":        { name: "Create AP invoice drafts",             category: "AP" },
  "ap:invoice:edit":          { name: "Edit AP invoice drafts",               category: "AP" },
  "ap:invoice:approve":       { name: "Approve AP invoices",                  category: "AP" },
  "ap:invoice:post":          { name: "Post AP invoices to GL",               category: "AP" },
  "ap:invoice:void":          { name: "Void or reverse posted AP invoices",   category: "AP" },
  "ap:payment:create":        { name: "Create payment batches / payments",    category: "AP" },
  "ap:payment:approve":       { name: "Approve payment batches",              category: "AP" },
  "ap:payment:process":       { name: "Process / post vendor payments",       category: "AP" },
  "ap:exception:override":    { name: "Override AP exceptions",               category: "AP" },
  "ap:report:view":           { name: "View AP reports (aging, register, recon)", category: "AP" },
  "ap:capture:view":          { name: "View capture inbox",                   category: "AP" },
  "ap:capture:upload":        { name: "Upload to capture inbox",              category: "AP" },
  // legacy aliases — kept to preserve existing role grants pre-Phase-4
  "ap:enter":                 { name: "(legacy) AP invoice entry",            category: "AP" },
  "ap:approve":               { name: "(legacy) AP invoice approval",         category: "AP" },

  // Payroll
  "payroll:read":              { name: "Read payroll",                  category: "PAYROLL" },
  "payroll:write":             { name: "Process payroll",               category: "PAYROLL" },
  "payroll:employees:manage":  { name: "Manage employees",              category: "PAYROLL" },
  "payroll:timesheets:read":   { name: "Read timesheets",               category: "PAYROLL" },
  "payroll:timesheets:approve":{ name: "Approve timesheets",            category: "PAYROLL" },
  "payroll:run":               { name: "Run / post payroll",            category: "PAYROLL" },
  "payroll:approve":           { name: "Approve payroll run",           category: "PAYROLL" },

  // Events / private events
  "events:read":               { name: "View events",                   category: "EVENTS" },
  "events:write":              { name: "Create/cancel events",          category: "EVENTS" },
  "events:private:read":       { name: "View private events",           category: "EVENTS" },
  "events:private:manage":     { name: "Manage private events",         category: "EVENTS" },

  // Inventory / pro shop
  "inventory:read":            { name: "Read inventory",                category: "INVENTORY" },
  "inventory:write":           { name: "Adjust inventory",              category: "INVENTORY" },
  "inventory:view":            { name: "View inventory module",         category: "INVENTORY" },
  "inventory:adjust":          { name: "Post inventory adjustments",    category: "INVENTORY" },
  "inventory:receive":         { name: "Post inventory receivings",     category: "INVENTORY" },
  "inventory:count":           { name: "Run inventory counts",          category: "INVENTORY" },
  "inventory:transfer":        { name: "Transfer inventory",            category: "INVENTORY" },

  // Hospitality / dining reservations (Phase 18C)
  "reservations:read":         { name: "View dining reservations",      category: "HOSPITALITY" },
  "reservations:manage":       { name: "Create, seat, cancel, no-show reservations", category: "HOSPITALITY" },
  "reservations:settings":     { name: "Configure reservation policies", category: "HOSPITALITY" },
  "reservations:self":         { name: "Member books their own reservation", category: "HOSPITALITY" },
  // Step 32 — floor-plan editor (draft + publish).
  "hospitality:floor:view":    { name: "View floor-plan layouts",       category: "HOSPITALITY" },
  "hospitality:floor:edit":    { name: "Edit floor-plan layouts (drafts)", category: "HOSPITALITY" },
  "hospitality:floor:publish": { name: "Publish floor-plan layouts to the live POS map", category: "HOSPITALITY" },

  // Lessons
  "lessons:view":              { name: "View lessons",                  category: "LESSONS" },
  "lessons:manage":            { name: "Book / cancel lessons",         category: "LESSONS" },
  "lessons:approve":           { name: "Approve completed lessons (Head Pro)", category: "LESSONS" },

  // Capital assets
  "assets:read":               { name: "View capital assets",           category: "ASSETS" },
  "assets:manage":             { name: "Create / edit capital assets",  category: "ASSETS" },
  "assets:depreciate":         { name: "Run monthly depreciation",      category: "ASSETS" },
  "assets:dispose":            { name: "Dispose of capital assets",     category: "ASSETS" },

  // Budgeting
  "budget:read":               { name: "View budgets / forecasts",      category: "BUDGET" },
  "budget:edit":               { name: "Edit budget / forecast lines",  category: "BUDGET" },
  "budget:approve":            { name: "Approve / publish budgets",     category: "BUDGET" },

  // Reporting
  "reports:operating": { name: "Operating reports", category: "REPORTING" },
  "reports:financial": { name: "Financial statements", category: "REPORTING" },
  "reports:board": { name: "Board / finance-committee package", category: "REPORTING" },

  // Phase 6 — enterprise reporting / governance / docs / KPIs
  "reports:read":      { name: "View saved reports + report runs",   category: "REPORTING" },
  "reports:write":     { name: "Create / edit saved reports",        category: "REPORTING" },
  "reports:export":    { name: "Export reports (CSV / PDF / etc.)",  category: "REPORTING" },
  "packages:read":     { name: "View reporting packages",            category: "REPORTING" },
  "packages:write":    { name: "Create / edit reporting packages",   category: "REPORTING" },
  "packages:approve":  { name: "Approve / finalize packages",        category: "REPORTING" },
  "packages:distribute": { name: "Distribute packages to recipients", category: "REPORTING" },

  "auditor:invite":    { name: "Invite external auditor",            category: "GOVERNANCE" },
  "auditor:revoke":    { name: "Revoke auditor access",              category: "GOVERNANCE" },
  "auditor:respond":   { name: "Respond to audit requests",          category: "GOVERNANCE" },

  "notifications:read":  { name: "View notifications",               category: "COMMS" },
  "notifications:write": { name: "Manage templates / preferences",   category: "COMMS" },
  "notifications:send":  { name: "Send / dispatch notifications",    category: "COMMS" },

  "documents:read":    { name: "Read documents",                     category: "DOCUMENTS" },
  "documents:write":   { name: "Upload / edit documents",            category: "DOCUMENTS" },
  "documents:delete":  { name: "Soft-delete / restore documents",    category: "DOCUMENTS" },

  "kpi:read":          { name: "View KPI dashboards",                category: "KPI" },
  "kpi:write":         { name: "Manage KPI definitions / thresholds", category: "KPI" },

  "workflow:read":     { name: "View workflows",                     category: "GOVERNANCE" },
  "workflow:write":    { name: "Create / manage workflows",          category: "GOVERNANCE" },
  "workflow:approve":  { name: "Approve workflow steps",             category: "GOVERNANCE" },

  "insights:read":     { name: "View cross-module insights",         category: "INSIGHTS" },
  "insights:write":    { name: "Manage insight rules",               category: "INSIGHTS" },

  "settings:read":     { name: "Read club settings",                 category: "SETTINGS" },
  "settings:write":    { name: "Edit club settings",                 category: "SETTINGS" },

  "search:read":       { name: "Use global search",                  category: "SETTINGS" },

  // Member portal (granted to MEMBER role)
  "self:account:read": { name: "View own member account", category: "MEMBER_PORTAL" },
  "self:profile:write": { name: "Edit own profile/household/preferences", category: "MEMBER_PORTAL" },
  "self:payment_methods:write": { name: "Manage own payment methods", category: "MEMBER_PORTAL" },
  "self:events:register": { name: "Register for events", category: "MEMBER_PORTAL" },
  "self:statements:read": { name: "Read own statements", category: "MEMBER_PORTAL" },
  "self:disputes:open": { name: "Open billing disputes", category: "MEMBER_PORTAL" },
} as const;

export type PermissionKey = keyof typeof PERMISSIONS;

export function allPermissionKeys(): PermissionKey[] {
  return Object.keys(PERMISSIONS) as PermissionKey[];
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------
export const ROLES = {
  SUPER_ADMIN: { name: "Spectre Super Admin", description: "Cross-tenant Spectre platform administrator." },
  CLUB_ADMIN: { name: "Club Administrator", description: "Full administrative access at a single club." },
  GENERAL_MANAGER: { name: "General Manager", description: "Club leadership; broad operating access." },
  CONTROLLER: { name: "Controller", description: "Finance lead; GL, AP, AR, reporting." },
  FINANCE_ADMIN: { name: "Finance Admin", description: "Finance operations: AR, billing, collections." },
  DEPARTMENT_MANAGER: { name: "Department Manager", description: "Department-level operating access." },
  PRO_SHOP_MANAGER: { name: "Pro Shop Manager", description: "Inventory, retail, and pro-shop operations." },
  F_AND_B_MANAGER: { name: "F&B Manager", description: "Food & beverage operations." },
  EVENT_MANAGER: { name: "Event Manager", description: "Club and private event operations." },
  PAYROLL_ADMIN: { name: "Payroll Admin", description: "Payroll and timekeeping." },
  MEMBER: { name: "Member", description: "Member portal access for their own account only." },
  STAFF: { name: "Staff", description: "Operational staff; limited read access." },
  AUDITOR_READ_ONLY: { name: "Auditor (Read Only)", description: "External auditor; read-only, audited access." },
  BOARD_READ_ONLY: { name: "Board (Read Only)", description: "Board / finance-committee reporting access." },
} as const;

export type RoleKey = keyof typeof ROLES;

// Curated per-role permission grants. Edit this map to retune RBAC; the seed
// script projects it into the RolePermission table on every reset.
//
// Principle: least privilege. Promote only when the role's job demands it.
export const ROLE_PERMISSIONS: Record<RoleKey, PermissionKey[]> = {
  SUPER_ADMIN: allPermissionKeys(), // intentionally everything

  CLUB_ADMIN: [
    "users:read", "users:invite", "users:roles:write",
    "members:read", "members:write", "members:suspend",
    "applications:read", "applications:review", "applications:assign",
    "applications:documents:read", "applications:documents:upload",
    "ar:read", "ar:write", "ar:adjust", "ar:void",
    "ar:statements:issue", "ar:disputes:work", "ar:notes:write",
    "collections:work", "collections:templates:write", "collections:stages:write",
    "payment_methods:read", "payment_methods:write",
    "financing:read", "financing:write",
    // Founder rule 2026-06-30 v13.2 — CLUB_ADMIN is READ-ONLY on
    // the Chart of Accounts by default. CONTROLLER and SUPER_ADMIN
    // own COA maintenance. A Controller can later delegate
    // `coa:write` to a specific Club Admin through the
    // permissions / role-management system; the UI + server
    // actions gate on the permission key, not the role name, so
    // delegation works without code changes.
    "gl:read", "coa:read",
    "ap:read",
    "vendor:view", "vendor:create", "vendor:edit", "vendor:approve",
    "vendor:banking:edit", "vendor:banking:approve",
    "ap:invoice:view", "ap:invoice:create", "ap:invoice:edit", "ap:invoice:approve",
    "ap:invoice:post", "ap:invoice:void",
    "ap:payment:create", "ap:payment:approve", "ap:payment:process",
    "ap:exception:override",
    "ap:report:view",
    "ap:capture:view", "ap:capture:upload",
    "ap:enter",
    "events:read", "events:write",
    "events:private:read", "events:private:manage",
    "inventory:read", "inventory:view", "inventory:write",
    "inventory:adjust", "inventory:receive", "inventory:count", "inventory:transfer",
    "lessons:view", "lessons:manage", "lessons:approve",
    "reservations:read", "reservations:manage", "reservations:settings",
    "hospitality:floor:view", "hospitality:floor:edit", "hospitality:floor:publish",
    "payroll:read", "payroll:write",
    "payroll:employees:manage", "payroll:timesheets:read", "payroll:timesheets:approve",
    "payroll:run", "payroll:approve",
    "assets:read", "assets:manage", "assets:depreciate", "assets:dispose",
    "budget:read", "budget:edit", "budget:approve",
    "reports:operating", "reports:financial", "reports:board",
    "system:audit:read",
    // Phase 6
    "reports:read", "reports:write", "reports:export",
    "packages:read", "packages:write", "packages:approve", "packages:distribute",
    "auditor:invite", "auditor:revoke",
    "notifications:read", "notifications:write", "notifications:send",
    "documents:read", "documents:write", "documents:delete",
    "kpi:read", "kpi:write",
    "workflow:read", "workflow:write", "workflow:approve",
    "insights:read", "insights:write",
    "settings:read", "settings:write",
    "search:read",
  ],

  GENERAL_MANAGER: [
    "users:read",
    "members:read", "members:write", "members:suspend",
    "applications:read", "applications:review", "applications:assign",
    "applications:documents:read",
    "ar:read", "ar:adjust", "ar:disputes:work",
    "collections:work", "collections:templates:write",
    "payment_methods:read",
    "financing:read",
    "gl:read", "coa:read",
    "ap:read",
    "vendor:view", "vendor:approve", "vendor:banking:approve",
    "ap:invoice:view", "ap:invoice:approve",
    "ap:payment:approve",
    "ap:exception:override",
    "ap:report:view",
    "ap:approve",
    "events:read", "events:write",
    "events:private:read", "events:private:manage",
    "inventory:read", "inventory:view",
    "lessons:view", "lessons:approve",
    "payroll:read", "payroll:approve",
    "assets:read", "assets:dispose",
    "budget:read", "budget:approve",
    "reports:operating", "reports:financial", "reports:board",
    // Phase 6
    "reports:read", "reports:export",
    "packages:read", "packages:approve", "packages:distribute",
    "auditor:invite", "auditor:revoke",
    "notifications:read", "notifications:write", "notifications:send",
    "documents:read", "documents:write",
    "kpi:read", "kpi:write",
    "workflow:read", "workflow:approve",
    "insights:read", "insights:write",
    "settings:read", "settings:write",
    "search:read",
  ],

  CONTROLLER: [
    "members:read",
    "ar:read", "ar:write", "ar:adjust", "ar:void",
    "ar:statements:issue", "ar:disputes:work", "ar:notes:write",
    "collections:work",
    "payment_methods:read",
    "financing:read", "financing:write",
    "gl:read", "gl:post", "gl:reverse", "gl:close_period",
    "coa:read", "coa:write",
    "ap:read",
    "vendor:view", "vendor:create", "vendor:edit", "vendor:approve",
    "vendor:banking:edit", "vendor:banking:approve",
    "ap:invoice:view", "ap:invoice:create", "ap:invoice:edit",
    "ap:invoice:approve", "ap:invoice:post", "ap:invoice:void",
    "ap:payment:create", "ap:payment:approve", "ap:payment:process",
    "ap:exception:override",
    "ap:report:view",
    "ap:capture:view", "ap:capture:upload",
    "ap:enter", "ap:approve",
    "inventory:read", "inventory:view", "inventory:write",
    "inventory:adjust", "inventory:receive", "inventory:count", "inventory:transfer",
    "lessons:view",
    "reservations:read", "reservations:manage", "reservations:settings",
    "hospitality:floor:view", "hospitality:floor:edit", "hospitality:floor:publish",
    "payroll:read", "payroll:write",
    "payroll:employees:manage", "payroll:timesheets:read", "payroll:timesheets:approve",
    "payroll:run", "payroll:approve",
    "assets:read", "assets:manage", "assets:depreciate", "assets:dispose",
    "budget:read", "budget:edit", "budget:approve",
    "reports:operating", "reports:financial", "reports:board",
    "system:audit:read",
    // Phase 6
    "reports:read", "reports:write", "reports:export",
    "packages:read", "packages:write", "packages:approve",
    "auditor:invite", "auditor:revoke", "auditor:respond",
    "notifications:read", "notifications:write", "notifications:send",
    "documents:read", "documents:write",
    "kpi:read", "kpi:write",
    "workflow:read", "workflow:approve",
    "insights:read", "insights:write",
    "settings:read", "settings:write",
    "search:read",
  ],

  FINANCE_ADMIN: [
    "members:read",
    "ar:read", "ar:write", "ar:notes:write",
    "ar:statements:issue",
    "collections:work",
    "payment_methods:read",
    "financing:read",
    "gl:read", "coa:read",
    "ap:read",
    "vendor:view", "vendor:create", "vendor:edit",
    "ap:invoice:view", "ap:invoice:create", "ap:invoice:edit",
    "ap:payment:create",
    "ap:report:view",
    "ap:capture:view", "ap:capture:upload",
    "ap:enter",
    "inventory:read", "inventory:view",
    "payroll:read", "payroll:timesheets:read",
    "assets:read",
    "budget:read", "budget:edit",
    "reports:operating", "reports:financial",
    // Phase 6
    "reports:read", "reports:export",
    "packages:read",
    "notifications:read",
    "documents:read", "documents:write",
    "kpi:read",
    "workflow:read",
    "search:read",
  ],

  DEPARTMENT_MANAGER: [
    "members:read",
    "events:read",
    "inventory:read", "inventory:view",
    "reports:operating",
    "vendor:view",
    "ap:invoice:view", "ap:invoice:approve",
    "payroll:timesheets:read", "payroll:timesheets:approve",
    "budget:read", "budget:edit",
    // Hospitality / operations analytics — surfaces prep-time KPIs
    // for the department they manage. Read-only.
    "kpi:read",
  ],

  PRO_SHOP_MANAGER: [
    "members:read",
    "inventory:read", "inventory:write",
    "inventory:view", "inventory:adjust", "inventory:receive",
    "inventory:count", "inventory:transfer",
    "lessons:view", "lessons:manage",
    "reports:operating",
  ],

  F_AND_B_MANAGER: [
    "members:read",
    "events:read",
    "inventory:view", "inventory:adjust", "inventory:receive",
    "inventory:count",
    "events:private:read", "events:private:manage",
    "reports:operating",
    // Kitchen/bar prep-time analytics — this is the role most
    // directly responsible for service-time performance.
    "kpi:read",
    // Hospitality reservations — F&B owns the floor.
    "reservations:read", "reservations:manage", "reservations:settings",
    "hospitality:floor:view", "hospitality:floor:edit", "hospitality:floor:publish",
  ],

  EVENT_MANAGER: [
    "members:read",
    "events:read", "events:write",
    "events:private:read", "events:private:manage",
    "reports:operating",
  ],

  PAYROLL_ADMIN: [
    "payroll:read", "payroll:write",
    "payroll:employees:manage", "payroll:timesheets:read",
    "payroll:timesheets:approve", "payroll:run", "payroll:approve",
    "reports:operating",
  ],

  MEMBER: [
    "self:account:read",
    "self:profile:write",
    "self:payment_methods:write",
    "self:events:register",
    "self:statements:read",
    "self:disputes:open",
    "reservations:self",
  ],

  STAFF: [
    "members:read",
    "events:read",
  ],

  AUDITOR_READ_ONLY: [
    "members:read",
    "ar:read",
    "financing:read",
    "gl:read", "coa:read",
    "ap:read",
    "vendor:view",
    "ap:invoice:view",
    "ap:report:view",
    "reports:financial", "reports:board",
    "system:audit:read",
    // Phase 6
    "reports:read", "reports:export",
    "packages:read",
    "auditor:respond",
    "documents:read",
    "search:read",
  ],

  BOARD_READ_ONLY: [
    "reports:financial", "reports:board",
    // Phase 6
    "reports:read",
    "packages:read",
    "kpi:read",
    "documents:read",
    "search:read",
  ],
};
