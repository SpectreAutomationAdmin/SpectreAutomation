// Navigation discoverability audit.
//
//   npm run nav:audit
//
// Walks every page.tsx under src/app/app/{admin,member} and decides
// whether each one is reachable through the UI by:
//
//   1. Searching the rest of the source tree for any `href="<route>"` or
//      `href='<route>'` string literal that lands on the page.
//   2. Excluding self-references (a page linking to itself doesn't make
//      it discoverable).
//   3. Treating dynamic segments ([id], [token], ...) as parent-route
//      hits — if the parent list/detail page is linked, the dynamic
//      child is implicitly reachable via the row.
//
// Output is grouped: LINKED FROM NAV (Sidebar), LINKED FROM PARENT
// PAGE, URL-ONLY (orphans), INTERNAL (allowlisted as not intended for
// founders).
//
// Exit 0 always — the audit is informational. A founder-facing
// `Discoverability` check can run this and fail CI later if we want;
// for now the value is the report.

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const APP_ROOT = path.join(ROOT, "src", "app", "app");
const SRC_ROOT = path.join(ROOT, "src");

// Routes that are deliberately not in the founder-facing nav. Most are
// landing/redirect helpers or super-admin-only platform pages already
// gated behind SUPER_ONLY in the sidebar (which still counts as linked).
const INTERNAL_ALLOWLIST = new Set<string>([
  "/app/admin/marketplace",          // listing surface, not in MVP scope
  "/app/admin/dashboards",           // executive dashboard index (linked via /admin/dashboards/[key])
  "/app/admin/governance",           // governance index — sub-pages are linked
  "/app/admin/compliance",           // compliance index (sub-pages used in audit packages)
  "/app/admin/notifications",        // sidebar lists analytics + email-health; index itself is just a list
  "/app/admin/support",              // support index — /support/access is the operable surface
  "/app/admin/security/kms",         // KMS console — super-admin-only operational page
  "/app/admin/webhooks/[id]/rotation", // child of webhooks
  "/app/admin/imports/[id]",         // detail of imports list
  "/app/admin/governance/packages/[id]",
  "/app/admin/compliance/[id]",
  "/app/admin/ap/invoices/[id]",
  "/app/admin/ap/payments/[id]",
  "/app/admin/ap/vendors/[id]",
  "/app/admin/applications/[id]",
  "/app/admin/coa/new",              // sub-form of /coa
  "/app/admin/gl/new",               // sub-form of /gl
  "/app/admin/gl/[id]",
  "/app/admin/gl/account/[id]",
  "/app/admin/members/[id]/approve",
  "/app/admin/members/[id]/financing/new",
  "/app/admin/opening-balances/[id]/subledgers",
  "/app/admin/pilot/go-live/[id]",
  "/app/admin/pilot/onboarding",
  "/app/admin/pilot/onboarding/[id]",
  "/app/admin/pilot/playbook",
  "/app/admin/pilot/training",
  "/app/admin/dashboards/[key]",
  "/app/admin/analytics/hospitality",                       // index folder
  "/app/admin/analytics/hospitality/prep-times/[station]",  // station detail
  "/app/admin/hospitality/reservations/[id]",               // detail of reservation list
  "/app/admin/ops/budgets/[id]",
  "/app/admin/ops/tournaments/conflicts",
  "/app/admin/reports/balance-sheet",
  "/app/admin/reports/income-statement",
  "/app/admin/reports/trial-balance",
  "/app/admin/reports/department-pnl",
  "/app/admin/members/invites",     // child of members list
  // member-side detail routes
  "/app/member/account/statements/[id]",
  "/app/member/dining/[id]",
  "/app/member/reservations/[id]",
  "/app/member/reservations/new",
  "/app/member/tournaments/[id]",
  "/app/member/tournaments/[id]/score/[roundId]",
  "/app/member/widgets",
  "/app/member/billing",
]);

function listPageRoutes(dir: string, base: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listPageRoutes(full, base + "/" + entry.name));
    } else if (entry.isFile() && entry.name === "page.tsx") {
      out.push(base);
    }
  }
  return out;
}

function readSourceFiles(dir: string, acc: string[] = []): string[] {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) readSourceFiles(full, acc);
    else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

function parentOf(route: string): string {
  // /a/b/[id] → /a/b ; /a/b/c → /a/b
  const segs = route.split("/").filter(Boolean);
  segs.pop();
  return "/" + segs.join("/");
}

type Verdict = "LINKED_FROM_NAV" | "LINKED_FROM_PARENT" | "URL_ONLY" | "INTERNAL";

function classify(route: string, sidebarRoutes: Set<string>, linkIndex: Map<string, Set<string>>, pageFile: string): Verdict {
  if (INTERNAL_ALLOWLIST.has(route)) return "INTERNAL";
  if (sidebarRoutes.has(route)) return "LINKED_FROM_NAV";
  // Parent / dynamic shortcut: if any LINK in the codebase points at this
  // exact route AND it's not just the page linking to itself, treat as
  // linked from a parent page.
  const linkers = linkIndex.get(route);
  if (linkers && [...linkers].some((f) => f !== pageFile)) return "LINKED_FROM_PARENT";
  // Look for dynamic-segment ancestors. e.g. /admin/foo/[id]/bar — if
  // /admin/foo OR /admin/foo/[id] is linked we count the leaf as
  // reachable through the parent record.
  let cursor = parentOf(route);
  while (cursor && cursor !== "/" && cursor !== "/app") {
    if (sidebarRoutes.has(cursor)) return "LINKED_FROM_PARENT";
    const parentLinkers = linkIndex.get(cursor);
    if (parentLinkers && parentLinkers.size > 0) return "LINKED_FROM_PARENT";
    cursor = parentOf(cursor);
  }
  return "URL_ONLY";
}

function main() {
  // 1. Discover every page route in the app/* tree.
  const admin = listPageRoutes(path.join(APP_ROOT, "admin"), "/app/admin");
  const member = listPageRoutes(path.join(APP_ROOT, "member"), "/app/member");
  const all = [...admin, ...member].sort();

  // 2. Pull every Sidebar route out of components/Sidebar.tsx as the
  //    authoritative "main nav" list.
  const sidebarPath = path.join(SRC_ROOT, "components", "Sidebar.tsx");
  const sidebarSrc = fs.existsSync(sidebarPath) ? fs.readFileSync(sidebarPath, "utf8") : "";
  const sidebarRoutes = new Set<string>();
  for (const m of sidebarSrc.matchAll(/href:\s*["']([^"']+)["']/g)) {
    sidebarRoutes.add(m[1]);
  }

  // 3. Build a map of route → files that reference it via `href=`.
  const linkIndex = new Map<string, Set<string>>();
  const sources = readSourceFiles(SRC_ROOT);
  for (const file of sources) {
    const src = fs.readFileSync(file, "utf8");
    for (const m of src.matchAll(/href=["'](\/app\/[^"'?#]+)["']/g)) {
      const route = m[1];
      if (!linkIndex.has(route)) linkIndex.set(route, new Set());
      linkIndex.get(route)!.add(file);
    }
    // also pick up redirect("/app/...") so we see programmatic links too
    for (const m of src.matchAll(/redirect\(\s*[`"'](\/app\/[^"`'?#]+)[`"']\s*\)/g)) {
      const route = m[1];
      if (!linkIndex.has(route)) linkIndex.set(route, new Set());
      linkIndex.get(route)!.add(file);
    }
  }

  // 4. Classify every page.
  const verdicts: Record<Verdict, string[]> = {
    LINKED_FROM_NAV: [],
    LINKED_FROM_PARENT: [],
    URL_ONLY: [],
    INTERNAL: [],
  };
  for (const route of all) {
    const pageFile = path.join(APP_ROOT, route.replace("/app/", "").replace(/\//g, path.sep), "page.tsx");
    const verdict = classify(route, sidebarRoutes, linkIndex, pageFile);
    verdicts[verdict].push(route);
  }

  // 5. Render.
  const out: string[] = [];
  out.push("Spectre navigation discoverability audit");
  out.push("=========================================");
  out.push("");
  out.push(`Total page routes:    ${all.length}`);
  out.push(`Linked in sidebar:    ${verdicts.LINKED_FROM_NAV.length}`);
  out.push(`Linked from parent:   ${verdicts.LINKED_FROM_PARENT.length}`);
  out.push(`URL-only (orphans):   ${verdicts.URL_ONLY.length}`);
  out.push(`Internal/allowlisted: ${verdicts.INTERNAL.length}`);
  out.push("");

  function section(title: string, list: string[]) {
    out.push(title);
    out.push("-".repeat(title.length));
    for (const r of list) out.push(`  ${r}`);
    out.push("");
  }
  section("LINKED FROM NAV (Sidebar)", verdicts.LINKED_FROM_NAV);
  section("LINKED FROM PARENT PAGE", verdicts.LINKED_FROM_PARENT);
  section("URL-ONLY  (NOT discoverable from the UI — fix these)", verdicts.URL_ONLY);
  section("INTERNAL / ALLOWLISTED (deliberately not in the founder nav)", verdicts.INTERNAL);

  // eslint-disable-next-line no-console
  console.log(out.join("\n"));
  process.exit(verdicts.URL_ONLY.length > 0 ? 1 : 0);
}

main();
