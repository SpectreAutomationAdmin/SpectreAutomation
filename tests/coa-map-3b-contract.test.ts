// COA-MAP-3B (2026-10-07) — whoami hardening + Inspector header
// Edit action.
//
//   §A  Whoami diagnostic uses `getCurrentPrincipal()` (null-safe),
//       NOT `requirePrincipal()` which would throw and surface as
//       an HTTP 500 to the browser.
//   §B  Whoami returns a structured 401 payload when there is no
//       session, with cookiesPresent flag so the founder can see
//       whether her browser is even sending a cookie.
//   §C  Whoami's whole handler is wrapped in try/catch so any
//       unexpected server error becomes a structured 500 JSON
//       response rather than an opaque Next.js error page.
//   §D  Chart of Accounts Account Inspector shows a primary
//       Edit action in the HEAD meta row (beside the status
//       pills), not only in the footer.  Save / Cancel surface
//       there too while editing.
//   §E  canEdit = false still produces an "Edit (permission
//       required)" placeholder in the head so the founder sees
//       the state immediately.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO    = path.resolve(__dirname, "..");
const WHOAMI  = path.join(REPO, "src/app/api/admin/testing/whoami/route.ts");
const COA_UI  = path.join(REPO, "src/components/data-workspace/ChartOfAccountsClient.tsx");

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/[ \t]+\/\/.*$/gm, "");
}

describe("COA-MAP-3B §A — whoami uses null-safe principal resolution", () => {
  it("whoami route exists", () => expect(existsSync(WHOAMI)).toBe(true));

  const src = stripComments(readFileSync(WHOAMI, "utf8"));

  it("uses getCurrentPrincipal (nullable) instead of requirePrincipal (throws)", () => {
    expect(src).toMatch(/getCurrentPrincipal\(\)/);
    expect(src).not.toMatch(/requirePrincipal\(/);
  });

  it("resolves the Promise with .catch so a rejection becomes null, not a 500", () => {
    expect(src).toMatch(/getCurrentPrincipal\(\)\.catch\(\(\)\s*=>\s*null\)/);
  });
});

describe("COA-MAP-3B §B — unauthenticated requests get a structured 401", () => {
  const src = stripComments(readFileSync(WHOAMI, "utf8"));

  it("returns status 401 when there is no principal", () => {
    const idx = src.indexOf("if (!principal) {");
    expect(idx).toBeGreaterThan(0);
    const block = src.slice(idx, idx + 600);
    expect(block).toMatch(/status:\s*"unauthenticated"/);
    expect(block).toMatch(/status:\s*401/);
  });

  it("surfaces cookiesPresent so the founder can tell whether the browser is sending a session cookie", () => {
    expect(src).toMatch(/cookiesPresent:\s*Boolean\(req\.headers\.get\("cookie"\)\)/);
  });
});

describe("COA-MAP-3B §C — whole handler is wrapped in try/catch", () => {
  const src = stripComments(readFileSync(WHOAMI, "utf8"));

  it("handler body is a try { ... } catch (e) { ... } so any thrown error returns structured JSON", () => {
    expect(src).toMatch(/export async function GET\([^)]*\): Promise<NextResponse>\s*\{\s*try\s*\{/);
    expect(src).toMatch(/\}\s*catch\s*\(e\)\s*\{/);
  });

  it("catch branch returns status 500 with a human-readable reason string", () => {
    const idx = src.indexOf("catch (e)");
    expect(idx).toBeGreaterThan(0);
    const block = src.slice(idx, idx + 500);
    expect(block).toMatch(/status:\s*"error"/);
    expect(block).toMatch(/reason:\s*e instanceof Error \? e\.message : /);
    expect(block).toMatch(/status:\s*500/);
  });

  it("staging-only guard still returns 404 in production", () => {
    expect(src).toMatch(/if \(!isStaging\(\)\) \{\s*return NextResponse\.json/);
    expect(src).toMatch(/status:\s*404/);
  });
});

describe("COA-MAP-3B §D — Inspector header Edit action", () => {
  const src = readFileSync(COA_UI, "utf8");

  it("the primary Edit button is rendered in the Inspector HEAD meta row", () => {
    // Testid chosen so it CANNOT be confused with the footer Edit.
    expect(src).toMatch(/data-testid=\{`coa-inspector-head-edit-\$\{inspectorRow\.accountNumber\}`\}/);
  });

  it("the header Save + Cancel actions exist for edit mode", () => {
    expect(src).toMatch(/data-testid="coa-inspector-head-save"/);
    expect(src).toMatch(/data-testid="coa-inspector-head-discard"/);
  });

  it("the head Edit action lives inside the inspector-meta row (NOT the footer)", () => {
    // The Inspector template renders a different head for a few
    // modes; the Edit action goes in the "reader" head.  Search
    // from the LAST inspector-meta anchor forward to that block.
    const lastMetaIdx = src.lastIndexOf('className="spectre-dw-inspector-meta"');
    expect(lastMetaIdx).toBeGreaterThan(0);
    // Slice until the next tabs block, which is the natural end
    // of the head.
    const nextTabsIdx = src.indexOf("spectre-dw-inspector-tabs", lastMetaIdx);
    const metaBlock = src.slice(lastMetaIdx, nextTabsIdx > 0 ? nextTabsIdx : lastMetaIdx + 4000);
    expect(metaBlock).toMatch(/coa-inspector-head-edit-/);
  });

  it("the head Edit action is gated on inspectorMode === 'viewing' && props.canEdit", () => {
    const idx = src.indexOf("coa-inspector-head-edit-");
    const context = src.slice(Math.max(0, idx - 400), idx + 400);
    expect(context).toMatch(/inspectorMode === "viewing" && props\.canEdit/);
  });

  it("the pre-existing footer Edit button is preserved (not removed)", () => {
    // Keeping the footer action maintains compatibility with the
    // Phase B edit-state machinery; the head action is additive.
    expect(src).toMatch(/data-testid=\{`coa-edit-\$\{inspectorRow\.accountNumber\}`\}/);
  });
});

describe("COA-MAP-3B §E — permission-denied placeholder in the head", () => {
  const src = readFileSync(COA_UI, "utf8");

  it("when canEdit=false, the head renders 'Edit (permission required)' with the data-disabled-reason attribute", () => {
    const idx = src.indexOf("coa-inspector-head-edit-");
    const block = src.slice(idx, idx + 2000);
    expect(block).toMatch(/data-disabled-reason="no-coa-write"/);
    expect(block).toMatch(/Edit \(permission required\)/);
  });
});
