// COA-MAP-1 (2026-10-06) — architecture + contract regressions.
//
//   §A  Schema: AccountFinancialStatementAssignment + reportingRole
//       are additive. Account.fsGroupId is PRESERVED (compat column).
//   §B  As-of resolver reads only from the effective-dated assignment
//       table — no direct Account.fsGroupId reads for the historical
//       lookup path.
//   §C  Validation: BS→IS and IS→BS blocked; FUND axis conflicts
//       produce WARNING (not BLOCKED).
//   §D  Reassignment service: closes prior assignment at
//       effectiveFrom, inserts new row, updates compatibility
//       Account.fsGroupId, writes audit row — atomically.
//   §E  Group service: default groups cannot be renamed/reparented
//       nor deleted when accounts assigned; tenant-created groups
//       can be fully edited.
//   §F  Role backfill is deterministic + null for unmapped keys.
//   §G  No account-name regex in COA mapping classification.
//   §H  Mapping Studio UI contract — critical data-testids present.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "..");
const SQLITE_SCHEMA = path.join(REPO, "prisma/schema.prisma");
const PG_SCHEMA     = path.join(REPO, "prisma-postgres/schema.prisma");
const RESOLVER      = path.join(REPO, "src/lib/coa-mapping/fs-group-asof-resolver.ts");
const VALIDATION    = path.join(REPO, "src/lib/coa-mapping/validation.ts");
const ASSIGN_SVC    = path.join(REPO, "src/lib/coa-mapping/assignment-service.ts");
const GROUP_SVC     = path.join(REPO, "src/lib/coa-mapping/group-service.ts");
const ROLE          = path.join(REPO, "src/lib/coa-mapping/reporting-role.ts");
const UI            = path.join(REPO, "src/app/app/admin/coa-mapping/mapping-workspace-client.tsx");

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/[ \t]+\/\/.*$/gm, "");
}

describe("COA-MAP-1 §A — additive schema", () => {
  it("SQLite + Postgres schemas define AccountFinancialStatementAssignment", () => {
    for (const p of [SQLITE_SCHEMA, PG_SCHEMA]) {
      const src = readFileSync(p, "utf8");
      expect(src).toMatch(/model AccountFinancialStatementAssignment \{/);
      expect(src).toMatch(/@@unique\(\[accountId, effectiveFrom\]\)/);
      expect(src).toMatch(/effectiveTo\s+DateTime\?/);
    }
  });

  it("SQLite + Postgres schemas add FinancialStatementGroup.reportingRole + isTenantCreated", () => {
    for (const p of [SQLITE_SCHEMA, PG_SCHEMA]) {
      const src = readFileSync(p, "utf8");
      const idx = src.indexOf("model FinancialStatementGroup");
      const body = idx >= 0 ? src.slice(idx, idx + 2500) : "";
      expect(body).toMatch(/reportingRole\s+String\?/);
      expect(body).toMatch(/isTenantCreated\s+Boolean/);
    }
  });

  it("Account.fsGroupId remains in schema (compatibility column)", () => {
    for (const p of [SQLITE_SCHEMA, PG_SCHEMA]) {
      const src = readFileSync(p, "utf8");
      // Match EXACTLY `model Account {` — avoids false hit on `model AccountAdjustment`.
      const idx = src.search(/^model Account \{/m);
      const body = idx >= 0 ? src.slice(idx, idx + 5000) : "";
      expect(body).toMatch(/fsGroupId\s+String\?/);
      expect(body).toMatch(/fsGroup\s+FinancialStatementGroup\?/);
    }
  });

  it("MappingChangeAudit model defined", () => {
    for (const p of [SQLITE_SCHEMA, PG_SCHEMA]) {
      const src = readFileSync(p, "utf8");
      expect(src).toMatch(/model MappingChangeAudit \{/);
    }
  });
});

describe("COA-MAP-1 §B — as-of resolver semantic", () => {
  const src = stripComments(readFileSync(RESOLVER, "utf8"));
  it("resolver queries only prisma.accountFinancialStatementAssignment", () => {
    expect(src).toMatch(/prisma\.accountFinancialStatementAssignment\.findFirst/);
    expect(src).toMatch(/prisma\.accountFinancialStatementAssignment\.findMany/);
    // Must NOT fall back to Account.fsGroupId for historical lookups.
    expect(src).not.toMatch(/prisma\.account\.findUnique/);
    expect(src).not.toMatch(/Account\.fsGroupId/);
  });

  it("resolver picks row where effectiveFrom <= asOf < effectiveTo", () => {
    expect(src).toMatch(/effectiveFrom: \{ lte: asOf \}/);
    expect(src).toMatch(/effectiveTo: null/);
    expect(src).toMatch(/effectiveTo: \{ gt: asOf \}/);
  });

  it("batch resolver returns Map<accountId, resolution>", () => {
    expect(src).toMatch(/resolveFinancialStatementGroupAsOfBatch/);
    expect(src).toMatch(/Map<string, AsOfResolution>/);
  });
});

describe("COA-MAP-1 §C — validation", () => {
  const src = stripComments(readFileSync(VALIDATION, "utf8"));

  it("BS account into IS group → BLOCKED (STATEMENT_MISMATCH_BS_INTO_IS)", () => {
    expect(src).toMatch(/STATEMENT_MISMATCH_BS_INTO_IS/);
    expect(src).toMatch(/accountIsBS && groupIsIS/);
  });

  it("IS account into BS group → BLOCKED (STATEMENT_MISMATCH_IS_INTO_BS)", () => {
    expect(src).toMatch(/STATEMENT_MISMATCH_IS_INTO_BS/);
    expect(src).toMatch(/accountIsIS && groupIsBS/);
  });

  it("CAPITAL account into Operating-role group → WARNING (not BLOCKED)", () => {
    expect(src).toMatch(/FUND_AXIS_CAPITAL_INTO_OPERATING/);
    const idx = src.indexOf("FUND_AXIS_CAPITAL_INTO_OPERATING");
    const near = src.slice(idx - 300, idx + 300);
    expect(near).toMatch(/"WARNING"/);
  });

  it("Group deletion blocked when assignments exist", () => {
    expect(src).toMatch(/GROUP_HAS_ASSIGNMENTS/);
  });

  it("Default group deletion blocked", () => {
    expect(src).toMatch(/DEFAULT_GROUP_PROTECTED/);
  });
});

describe("COA-MAP-1 §D — reassignment service atomicity + audit", () => {
  const src = stripComments(readFileSync(ASSIGN_SVC, "utf8"));

  it("wraps close-prior + insert-new + update-compat + audit in $transaction", () => {
    expect(src).toMatch(/prisma\.\$transaction\(async \(tx\) =>/);
  });

  it("closes prior assignment effectiveTo at the new effectiveFrom (half-open interval)", () => {
    expect(src).toMatch(/effectiveTo: input\.effectiveFrom/);
  });

  it("updates Account.fsGroupId as a compatibility shim", () => {
    expect(src).toMatch(/tx\.account\.update\(\{[\s\S]*?fsGroupId: input\.targetFsGroupId/);
  });

  it("writes MappingChangeAudit with ACCOUNT_REASSIGN action", () => {
    expect(src).toMatch(/action: "ACCOUNT_REASSIGN"/);
    expect(src).toMatch(/entityType: "Account"/);
  });

  it("BLOCKED outcomes do not touch the database", () => {
    const idx = src.indexOf('if (validation.outcome === "BLOCKED")');
    const slice = src.slice(idx, idx + 300);
    expect(slice).toMatch(/return \{\s*outcome: "BLOCKED",/);
  });
});

describe("COA-MAP-1 §E — group service protections", () => {
  const src = stripComments(readFileSync(GROUP_SVC, "utf8"));

  it("default group rename refused (DEFAULT_GROUP_RENAME_FORBIDDEN)", () => {
    expect(src).toMatch(/DEFAULT_GROUP_RENAME_FORBIDDEN/);
  });

  it("default group reparent refused", () => {
    expect(src).toMatch(/DEFAULT_GROUP_REPARENT_FORBIDDEN/);
  });

  it("tenant-created groups use key format TENANT_<SLUG>", () => {
    expect(src).toMatch(/`TENANT_\$\{slug\}`/);
  });

  it("role↔statement consistency enforced on create (ROLE_STATEMENT_MISMATCH)", () => {
    expect(src).toMatch(/ROLE_STATEMENT_MISMATCH/);
  });

  it("create / edit / delete each write a MappingChangeAudit row", () => {
    expect(src).toMatch(/action: "GROUP_CREATE"/);
    expect(src).toMatch(/action: "GROUP_EDIT"/);
    expect(src).toMatch(/action: "GROUP_DELETE"/);
  });
});

describe("COA-MAP-1 §F — deterministic role backfill", () => {
  const src = readFileSync(ROLE, "utf8");

  it("IS_PAYROLL → PAYROLL", () => {
    expect(src).toMatch(/if \(key === "IS_PAYROLL"[\s\S]*?\) return "PAYROLL"/);
  });

  it("IS_COGS family → COGS", () => {
    expect(src).toMatch(/key\.startsWith\("IS_COGS_"\)[\s\S]*?return "COGS"/);
  });

  it("IS_INTEREST_INCOME → INTEREST_INCOME", () => {
    expect(src).toMatch(/if \(key === "IS_INTEREST_INCOME"\) return "INTEREST_INCOME"/);
  });

  it("Unmapped keys → null (never silently misclassified)", () => {
    expect(src).toMatch(/\/\/ Unmapped — leave null[\s\S]*?return null;/);
  });

  it("REPORTING_ROLES includes OTHER as a catch-all for tenant-created groups", () => {
    expect(src).toMatch(/"OTHER",/);
  });
});

describe("COA-MAP-1 §G — No account-name regex in COA mapping classification", () => {
  for (const f of [RESOLVER, VALIDATION, ASSIGN_SVC, GROUP_SVC, ROLE]) {
    it(`${path.basename(f)} does not read account.name / accountName for classification`, () => {
      const src = stripComments(readFileSync(f, "utf8"));
      expect(src).not.toMatch(/\.name\.toLowerCase\(\)\.(includes|indexOf)/);
      expect(src).not.toMatch(/accountName\.(toLowerCase|includes|indexOf)/i);
      expect(src).not.toMatch(/\/food\/i/);
      expect(src).not.toMatch(/\/beverage\/i/);
    });
  }
});

describe("COA-MAP-1 §H — Mapping Studio UI contract", () => {
  const src = readFileSync(UI, "utf8");
  // COA-MAP-2B — the Preview panel + its period-aware fieldset are
  // now in a SHARED component mounted by both the Mapping Studio and
  // Account List drag/drop.  Preview testids live in the shared file.
  const SHARED_PREVIEW = path.join(REPO, "src/components/coa-mapping/MappingPreviewPanel.tsx");
  const sharedPreview = readFileSync(SHARED_PREVIEW, "utf8");

  for (const testid of [
    "coa-mapping-workspace",
    "coa-mapping-unmapped",
    "coa-mapping-inspector",
    "coa-mapping-inspector-empty",
    "coa-mapping-inspector-filled",
    "coa-mapping-inspector-group-select",
    "coa-mapping-inspector-preview-button",
    "coa-mapping-preview",
    "coa-mapping-preview-effective-from",
    "coa-mapping-preview-apply",
    "coa-mapping-preview-cancel",
    "coa-mapping-create-group-open",
    "coa-mapping-create-group-form",
    "coa-mapping-create-group-submit",
  ]) {
    it(`exposes [data-testid="${testid}"]`, () => {
      const slug = testid.replace(/-/g, "\\-");
      // Match either `data-testid="X"` (direct attribute) or
      // `??"X"` / `: "X"` (string literal passed through a prop
      // default inside the shared Preview component).
      const re = new RegExp(`(data-testid="|\\?\\?\\s*"|:\\s*")${slug}"`);
      expect(src.match(re) || sharedPreview.match(re)).toBeTruthy();
    });
  }

  it("drag-and-drop is wired: onDragStart + onDragOver + onDrop + onDragEnd", () => {
    expect(src).toMatch(/handleDragStart/);
    expect(src).toMatch(/handleDragOverGroup/);
    expect(src).toMatch(/handleDropOnGroup/);
    expect(src).toMatch(/handleDragEnd/);
    expect(src).toMatch(/draggable[\r\n]/);
  });

  it("keyboard alternative: Account Inspector exposes a group <select> + Preview button", () => {
    expect(src).toMatch(/data-testid="coa-mapping-inspector-group-select"/);
    expect(src).toMatch(/data-testid="coa-mapping-inspector-preview-button"/);
  });
});
