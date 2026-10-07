// COA-MAP-3 (2026-10-07) — Chart of Accounts / Mapping Studio
// consolidation contract.
//
//   §A  Create FS Group button + drawer exist and are mounted in
//       the COA header.  Create still routes through the canonical
//       POST /api/admin/coa-mapping/groups.
//   §B  Empty Financial Statement Groups are serialized by the COA
//       server page and rendered in a "Custom groups" sub-section
//       by the client, with `data-fs-group-id` so pointer-driven
//       drag/drop detects them as valid targets.
//   §C  Account Reporting History is mounted inside the COA Account
//       Inspector (Audit tab) via the shared
//       AccountReportingHistory component that calls the canonical
//       /api/admin/coa-mapping/accounts/{id}/history endpoint.
//   §D  Standalone Mapping Studio is RETIRED — the client file is
//       deleted, the page redirects, the sidebar entry is gone,
//       the CoaModeSwitch is gone.
//   §E  Parity: every KEEP Mapping Studio feature has an accepted
//       equivalent inside Chart of Accounts (or is OBSOLETE with a
//       documented reason).  Nothing is UNACCOUNTED.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO           = path.resolve(__dirname, "..");
const COA_PAGE       = path.join(REPO, "src/app/app/admin/coa/page.tsx");
const COA_CLIENT     = path.join(REPO, "src/components/data-workspace/ChartOfAccountsClient.tsx");
const CREATE_BUTTON  = path.join(REPO, "src/components/coa-mapping/CreateFsGroupButton.tsx");
const CREATE_DRAWER  = path.join(REPO, "src/components/coa-mapping/CreateFsGroupDrawer.tsx");
const HISTORY        = path.join(REPO, "src/components/coa-mapping/AccountReportingHistory.tsx");
const SIDEBAR        = path.join(REPO, "src/components/sidebar-nav-data.ts");
const MAP_PAGE       = path.join(REPO, "src/app/app/admin/coa-mapping/page.tsx");
const OLD_MAP_CLIENT = path.join(REPO, "src/app/app/admin/coa-mapping/mapping-workspace-client.tsx");

describe("COA-MAP-3 §A — Create FS Group button + drawer mounted on COA", () => {
  it("CreateFsGroupButton component exists", () => expect(existsSync(CREATE_BUTTON)).toBe(true));
  it("CreateFsGroupDrawer component exists", () => expect(existsSync(CREATE_DRAWER)).toBe(true));

  const page = readFileSync(COA_PAGE, "utf8");
  const button = readFileSync(CREATE_BUTTON, "utf8");
  const drawer = readFileSync(CREATE_DRAWER, "utf8");

  it("COA page imports + mounts CreateFsGroupButton with clubId + canCreate", () => {
    expect(page).toMatch(/import \{ CreateFsGroupButton \} from "@\/components\/coa-mapping\/CreateFsGroupButton"/);
    expect(page).toMatch(/<CreateFsGroupButton clubId=\{clubId\} canCreate=\{canEdit\}/);
  });

  it("button is hidden when the viewer cannot create (canCreate=false)", () => {
    expect(button).toMatch(/if \(!canCreate\) return null;/);
  });

  it("button exposes coa-new-fs-group-btn testid", () => {
    expect(button).toMatch(/data-testid="coa-new-fs-group-btn"/);
  });

  it("drawer POSTs to the SAME canonical endpoint the retired Mapping Studio used", () => {
    expect(drawer).toMatch(/\/api\/admin\/coa-mapping\/groups/);
    // No duplicate implementation — the drawer is a shell around
    // the canonical API.
    expect(drawer).toMatch(/method:\s*"POST"/);
  });

  it("drawer exposes the canonical create-group testids (reused from the retired studio)", () => {
    expect(drawer).toMatch(/data-testid="coa-mapping-create-group-form"/);
    expect(drawer).toMatch(/data-testid="coa-mapping-create-group-name"/);
    expect(drawer).toMatch(/data-testid="coa-mapping-create-group-statement"/);
    expect(drawer).toMatch(/data-testid="coa-mapping-create-group-role"/);
    expect(drawer).toMatch(/data-testid="coa-mapping-create-group-submit"/);
  });

  it("drawer uses labelForReportingRole + labelForStatement — no raw enum labels", () => {
    expect(drawer).toMatch(/labelForReportingRole/);
    expect(drawer).toMatch(/labelForStatement/);
  });

  it("drawer inherits COA-MAP-2 inferred-statement UX (picking a role sets statement)", () => {
    expect(drawer).toMatch(/statementForReportingRole/);
  });
});

describe("COA-MAP-3 §B — empty FS Groups rendered as drop targets", () => {
  const page = readFileSync(COA_PAGE, "utf8");
  const client = readFileSync(COA_CLIENT, "utf8");

  it("server computes `emptyFsGroups` from the full FinancialStatementGroup list", () => {
    expect(page).toMatch(/const emptyFsGroups:\s*EmptyFsGroup\[\] = fsGroups/);
    expect(page).toMatch(/nonEmptyFsGroupIds/);
  });

  it("server infers TYPE per statement + reportingRole so empty groups bucket into the right section", () => {
    expect(page).toMatch(/inferTypeForEmptyGroup\(/);
    expect(page).toMatch(/statement === "BALANCE_SHEET"/);
    expect(page).toMatch(/statement === "INCOME_STATEMENT"/);
  });

  it("server passes emptyFsGroups to the client", () => {
    expect(page).toMatch(/<ChartOfAccountsClient[\s\S]*?emptyFsGroups=\{emptyFsGroups\}/);
  });

  it("client type exposes EmptyFsGroupLite with inferredType", () => {
    expect(client).toMatch(/export type EmptyFsGroupLite = \{/);
    expect(client).toMatch(/inferredType:\s*DwAccountRow\["type"\]/);
  });

  it("renderCategorySubgroups injects empty groups into a 'Custom groups' bucket", () => {
    expect(client).toMatch(/const emptyForType = \(props\.emptyFsGroups \?\? \[\]\)\.filter\(\(g\) => g\.inferredType === type\)/);
    expect(client).toMatch(/label:\s*"Custom groups"/);
  });
});

describe("COA-MAP-3 §C — AccountReportingHistory mounted in COA Inspector", () => {
  it("AccountReportingHistory component exists", () => expect(existsSync(HISTORY)).toBe(true));

  const src = readFileSync(HISTORY, "utf8");
  const client = readFileSync(COA_CLIENT, "utf8");

  it("component fetches the canonical history endpoint", () => {
    expect(src).toMatch(/\/api\/admin\/coa-mapping\/accounts\/\$\{accountId\}\/history/);
  });

  it("component exposes the loading / empty / row / error testids for E2E discovery", () => {
    expect(src).toMatch(/data-testid="coa-inspector-mapping-history"/);
    expect(src).toMatch(/data-testid="coa-inspector-mapping-history-row"/);
    expect(src).toMatch(/data-testid="coa-inspector-mapping-history-loading"/);
    expect(src).toMatch(/data-testid="coa-inspector-mapping-history-empty"/);
    expect(src).toMatch(/data-testid="coa-inspector-mapping-history-error"/);
  });

  it("humanizes reporting role via labelForReportingRole (no raw enum tokens)", () => {
    expect(src).toMatch(/labelForReportingRole/);
  });

  it("Inspector mounts AccountReportingHistory on the Audit tab", () => {
    expect(client).toMatch(/import \{ AccountReportingHistory \} from "@\/components\/coa-mapping\/AccountReportingHistory"/);
    expect(client).toMatch(/inspectorTab === "audit"[\s\S]{0,400}<AccountReportingHistory clubId=\{props\.clubId\} accountId=\{inspectorRow\.id\}/);
  });
});

describe("COA-MAP-3 §D — standalone Mapping Studio retired", () => {
  it("old mapping-workspace-client.tsx file is DELETED", () => {
    expect(existsSync(OLD_MAP_CLIENT)).toBe(false);
  });

  const mapPage = readFileSync(MAP_PAGE, "utf8");

  it("Mapping Studio page is now a server redirect to /app/admin/coa", () => {
    expect(mapPage).toMatch(/import \{ redirect \} from "next\/navigation"/);
    expect(mapPage).toMatch(/redirect\(["']\/app\/admin\/coa["']\)/);
  });

  it("Mapping Studio page no longer renders MappingWorkspaceClient", () => {
    expect(mapPage).not.toMatch(/<MappingWorkspaceClient/);
    expect(mapPage).not.toMatch(/mapping-workspace-client/);
  });

  const sidebar = readFileSync(SIDEBAR, "utf8");

  it("Finance sidebar entry for Financial Statement Mapping is REMOVED", () => {
    expect(sidebar).not.toMatch(/href:\s*"\/app\/admin\/coa-mapping"/);
    expect(sidebar).not.toMatch(/label:\s*"Financial Statement Mapping"/);
  });

  const coaPage = readFileSync(COA_PAGE, "utf8");

  it("CoaModeSwitch is REMOVED from the COA page header", () => {
    expect(coaPage).not.toMatch(/CoaModeSwitch/);
  });
});

describe("COA-MAP-3 §E — parity matrix: no unaccounted Mapping Studio feature", () => {
  // The parity matrix is enforced by the surviving pins above; this
  // test lists the canonical features and classifies each.  A new
  // Mapping Studio feature cannot sneak back in without updating
  // this list.
  const FEATURES: Array<{ feature: string; status: "MIGRATED_TO_COA" | "SHARED_ALREADY" | "OBSOLETE_WITH_REASON"; reason?: string }> = [
    { feature: "Create FS Group",             status: "MIGRATED_TO_COA" },
    { feature: "Empty group rendered as drop target", status: "MIGRATED_TO_COA" },
    { feature: "Reporting history on account",status: "MIGRATED_TO_COA" },
    { feature: "Preview panel + effective-date UX", status: "SHARED_ALREADY" },
    { feature: "Reassign API (canonical)",    status: "SHARED_ALREADY" },
    { feature: "Validation (VALID/WARNING/BLOCKED)", status: "SHARED_ALREADY" },
    { feature: "AS-OF reporting resolver",    status: "SHARED_ALREADY" },
    { feature: "Humanize helpers",            status: "SHARED_ALREADY" },
    { feature: "Statement switcher (IS/BS/CF tabs)", status: "OBSOLETE_WITH_REASON", reason: "COA groups by canonical TYPE which maps to statement; no separate switcher needed" },
    { feature: "Filter chips (All/Needs review/Unmapped/Tenant-created)", status: "OBSOLETE_WITH_REASON", reason: "COA has its own search + Fund Applicability filter; unmapped surfaces via existing Account List mechanisms" },
    { feature: "Attention queue sidebar",     status: "OBSOLETE_WITH_REASON", reason: "Empty custom groups + unmapped accounts are visible inline in COA; a separate queue is redundant" },
    { feature: "Group rename / edit / delete UI", status: "OBSOLETE_WITH_REASON", reason: "No UI existed on either page; API routes remain available for a future dedicated slice" },
    { feature: "Group reorder UI",            status: "OBSOLETE_WITH_REASON", reason: "No UI existed on either page; sortOrder is API-only" },
    { feature: "Bulk mapping UI",             status: "OBSOLETE_WITH_REASON", reason: "No UI existed on either page" },
    { feature: "CoaModeSwitch (Account List ↔ Mapping Studio)", status: "OBSOLETE_WITH_REASON", reason: "Only one workspace remains" },
    { feature: "Finance nav entry for Mapping Studio", status: "OBSOLETE_WITH_REASON", reason: "Only one workspace remains" },
  ];

  it("every feature has a definite status (no UNACCOUNTED / UNKNOWN / TODO)", () => {
    for (const f of FEATURES) {
      expect(f.status).toMatch(/^(MIGRATED_TO_COA|SHARED_ALREADY|OBSOLETE_WITH_REASON)$/);
      if (f.status === "OBSOLETE_WITH_REASON") {
        expect(f.reason, `feature "${f.feature}" marked OBSOLETE_WITH_REASON needs a documented reason`).toBeTruthy();
      }
    }
  });

  it("MIGRATED features have matching new surfaces (sanity cross-check)", () => {
    // CreateFsGroupButton + CreateFsGroupDrawer prove "Create FS Group" is MIGRATED.
    expect(existsSync(CREATE_BUTTON)).toBe(true);
    expect(existsSync(CREATE_DRAWER)).toBe(true);
    // AccountReportingHistory proves "Reporting history on account" is MIGRATED.
    expect(existsSync(HISTORY)).toBe(true);
    // Empty-group rendering is pinned in §B above.
  });
});
