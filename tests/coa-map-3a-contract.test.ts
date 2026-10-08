// COA-MAP-3A (2026-10-07) — Controller permissions + editable
// Account Inspector + canonical FS Group reassign.
//
//   §A  Role catalogue: CONTROLLER includes `coa:write`.
//   §B  COA page gates `canEdit` on `coa:write`.
//   §C  Inspector FS Group field is NO LONGER a direct-write
//       <select>.  It is display-only with a "Change…" button
//       that opens the canonical reassign drawer.
//   §D  updateAccountInspectorAction NO LONGER forwards
//       `fsGroupKey` to the service layer.
//   §E  New InspectorReassignFsGroupDrawer uses the shared
//       canonical API path (/preview + /reassign).
//   §F  Diagnostic whoami endpoint exists (staging-only, read-only).
//   §G  New role-grant endpoints are explicitly NOT created in
//       this slice (sensitive change requires founder consent).

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "..");
const PERMISSIONS = path.join(REPO, "src/lib/permissions.ts");
const COA_PAGE    = path.join(REPO, "src/app/app/admin/coa/page.tsx");
const COA_UI      = path.join(REPO, "src/components/data-workspace/ChartOfAccountsClient.tsx");
const COA_ACTIONS = path.join(REPO, "src/app/app/admin/coa/_actions.ts");
const DRAWER      = path.join(REPO, "src/components/coa-mapping/InspectorReassignFsGroupDrawer.tsx");
const WHOAMI      = path.join(REPO, "src/app/api/admin/testing/whoami/route.ts");
const GRANT       = path.join(REPO, "src/app/api/admin/testing/grant-controller-role/route.ts");

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/[ \t]+\/\/.*$/gm, "");
}

describe("COA-MAP-3A §A — CONTROLLER role has coa:write", () => {
  const src = readFileSync(PERMISSIONS, "utf8");

  it("CONTROLLER role catalogue entry grants both coa:read and coa:write", () => {
    // Narrow to the ROLE_PERMISSIONS.CONTROLLER grants block, not
    // the ROLES catalogue entry which only carries name+description.
    const idx = src.indexOf("ROLE_PERMISSIONS");
    expect(idx).toBeGreaterThan(0);
    const controllerIdx = src.indexOf("CONTROLLER:", idx);
    expect(controllerIdx).toBeGreaterThan(idx);
    const window = src.slice(controllerIdx, controllerIdx + 4000);
    expect(window).toMatch(/"coa:read",\s*"coa:write"/);
  });

  it("hasPermission is still role-driven (no bypass)", () => {
    const rbac = readFileSync(path.join(REPO, "src/lib/rbac.ts"), "utf8");
    expect(rbac).toMatch(/export function hasPermission/);
    expect(rbac).toMatch(/ROLE_PERMISSIONS\[role\]/);
  });
});

describe("COA-MAP-3A §B — COA page gates canEdit on coa:write", () => {
  const page = readFileSync(COA_PAGE, "utf8");

  it("page computes canEdit from hasPermission(coa:write)", () => {
    expect(page).toMatch(/const canEdit = hasPermission\(principal, clubId, "coa:write"\)/);
  });

  it("page passes canEdit to the client", () => {
    expect(page).toMatch(/canEdit=\{canEdit\}/);
  });
});

describe("COA-MAP-3A §C — Inspector FS Group is NOT a direct-write <select>", () => {
  const ui = readFileSync(COA_UI, "utf8");

  it("Inspector FS Group field is display-only (no inline <select onChange>)", () => {
    // The old pattern was:
    //   <select ... value={form.fsGroupKey} onChange={(e) => onPatch("fsGroupKey", ...)} ... />
    expect(ui).not.toMatch(/onChange=\{\(e\) => onPatch\("fsGroupKey"/);
    // The new pattern is the display + Change button.
    expect(ui).toMatch(/data-testid="coa-inspector-field-fsgroup-display"/);
    expect(ui).toMatch(/data-testid="coa-inspector-field-fsgroup-change-btn"/);
  });

  it("Change button opens the canonical reassign drawer", () => {
    expect(ui).toMatch(/import \{ InspectorReassignFsGroupDrawer \} from "@\/components\/coa-mapping\/InspectorReassignFsGroupDrawer"/);
    expect(ui).toMatch(/<InspectorReassignFsGroupDrawer/);
    expect(ui).toMatch(/onRequestReassignFsGroup\?\s*:\s*\(\)\s*=>\s*void/);
  });

  it("Change button is gated on canEdit", () => {
    expect(ui).toMatch(/canEdit && onRequestReassignFsGroup && \(/);
  });
});

describe("COA-MAP-3A §D — server action no longer forwards fsGroupKey", () => {
  const src = stripComments(readFileSync(COA_ACTIONS, "utf8"));

  it("updateAccountInspectorAction does NOT pass fsGroupKey to updateAccount", () => {
    // Scope narrowly to the Inspector action body (NOT the legacy
    // updateAccountAction, which is unused by current UI but still
    // exported for back-compat).
    const fnIdx = src.indexOf("export async function updateAccountInspectorAction");
    expect(fnIdx).toBeGreaterThan(0);
    // The function body ends at the next `export async function` or
    // at a visible closing brace at column 0 — slice to the next
    // top-level export.
    const nextExport = src.indexOf("export async function", fnIdx + 10);
    const body = src.slice(fnIdx, nextExport > 0 ? nextExport : fnIdx + 4000);
    expect(body).not.toMatch(/fsGroupKey:\s*fdString\(formData, "fsGroupKey"\)/);
    expect(body).toMatch(/const \{ account, warnings \} = await updateAccount\(/);
  });

  it("the permission fast-fail still enforces coa:write on the server", () => {
    expect(src).toMatch(/hasPermission\(p, clubId, "coa:write"\)/);
  });
});

describe("COA-MAP-3A §E — InspectorReassignFsGroupDrawer uses canonical API", () => {
  it("drawer file exists", () => expect(existsSync(DRAWER)).toBe(true));
  const src = stripComments(readFileSync(DRAWER, "utf8"));

  it("drawer POSTs to /api/admin/coa-mapping/preview", () => {
    expect(src).toMatch(/\/api\/admin\/coa-mapping\/preview/);
  });

  it("drawer POSTs to /api/admin/coa-mapping/accounts/{id}/reassign", () => {
    expect(src).toMatch(/\/api\/admin\/coa-mapping\/accounts\/\$\{accountId\}\/reassign/);
  });

  it("drawer forwards 409 / 422 BLOCKED / WARNING semantics", () => {
    expect(src).toMatch(/res\.status === 409/);
    expect(src).toMatch(/res\.status === 422/);
  });

  it("drawer mounts the shared MappingPreviewPanel (one canonical UI)", () => {
    expect(src).toMatch(/<MappingPreviewPanel\s/);
    expect(src).toMatch(/import \{\s*MappingPreviewPanel,\s*type MappingPreviewResult,?\s*\} from "@\/components\/coa-mapping\/MappingPreviewPanel"/);
  });

  it("drawer root carries coa-inspector-reassign-fsgroup-drawer testid", () => {
    expect(src).toMatch(/data-testid="coa-inspector-reassign-fsgroup-drawer"/);
  });
});

describe("COA-MAP-3A §F — whoami diagnostic (read-only, staging-only)", () => {
  it("whoami route exists", () => expect(existsSync(WHOAMI)).toBe(true));
  const src = stripComments(readFileSync(WHOAMI, "utf8"));

  it("exposes GET handler", () => {
    expect(src).toMatch(/export async function GET\(/);
  });

  it("is staging-only (404 in production)", () => {
    expect(src).toMatch(/isStaging\(\)/);
    expect(src).toMatch(/"Not available in production\."/);
  });

  it("returns the principal + memberships + permission booleans", () => {
    expect(src).toMatch(/isSuperAdmin\(principal\)/);
    expect(src).toMatch(/principal\.memberships\.map\(/);
    expect(src).toMatch(/hasPermission\(principal, clubId \|\| null, perm\)/);
  });

  it("checks at minimum coa:read + coa:write + settings:write", () => {
    expect(src).toMatch(/"coa:read"/);
    expect(src).toMatch(/"coa:write"/);
    expect(src).toMatch(/"settings:write"/);
  });

  it("is read-only (no Prisma mutations)", () => {
    expect(src).not.toMatch(/prisma\.[a-z]+\.(create|update|delete|upsert|createMany|updateMany|deleteMany)/);
  });
});

describe("COA-MAP-3A §G — NO role-granting endpoint shipped in this slice", () => {
  it("grant-controller-role endpoint is NOT present", () => {
    // Role mutations are sensitive and require founder consent.
    // This slice reports the diagnosis via whoami; the grant is
    // intentionally left to a separate, founder-approved slice.
    expect(existsSync(GRANT)).toBe(false);
  });
});
