// COA-MAP-3C (2026-10-08) — restore whole-row drag.
//
// Founder reported losing the ability to drag and drop accounts
// between Financial Statement Groups.  Root cause: the account
// row's Name column wraps the name in a `<Link>` to the GL
// account page.  `isInteractiveTarget` in `useAccountDrag`
// treated `<a>` as always-interactive and short-circuited drag
// tracking — so a pointer-down on the natural grab point of a
// row (its name) never armed the hook.
//
// This slice:
//   §A  removes `A` + `role="link"` from the drag-blocking list
//       so clicking the name begins drag tracking;
//   §B  adds a one-shot capturing `click` suppression on
//       pointer-up when a drag was active, so dropping onto an
//       FS Group header that happens to overlap a <Link> does
//       NOT navigate the user away mid-drop;
//   §C  preserves the pure-click-navigates path (no movement →
//       no activation → native click → Link navigation).

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "..");
const HOOK = path.join(REPO, "src/components/coa-mapping/useAccountDrag.tsx");

describe("COA-MAP-3C §A — <a> + role=link no longer short-circuit drag", () => {
  const src = readFileSync(HOOK, "utf8");

  it("isInteractiveTarget does NOT list 'A' as a blocking tag", () => {
    // The exclusion list once included `"A"`.  The regression spec
    // asserts it is gone AND that the surrounding neighbours are
    // still present.
    expect(src).not.toMatch(/t === "A"/);
    expect(src).toMatch(/t === "INPUT" \|\| t === "BUTTON" \|\| t === "SELECT" \|\| t === "TEXTAREA" \|\| t === "LABEL"/);
  });

  it("isInteractiveTarget does NOT list role=\"link\" as blocking", () => {
    expect(src).not.toMatch(/role === "link"/);
    expect(src).toMatch(/role === "button" \|\| role === "menuitem" \|\| role === "checkbox"/);
  });

  it("data-no-row-drag opt-out is still honoured so individual elements can still block drag", () => {
    expect(src).toMatch(/hasAttribute\("data-no-row-drag"\)/);
  });
});

describe("COA-MAP-3C §B — one-shot synthetic-click suppression on drop", () => {
  const src = readFileSync(HOOK, "utf8");

  it("onUp installs a one-shot capturing click listener when wasActive=true", () => {
    expect(src).toMatch(/const suppressClick = \(ce: MouseEvent\) => \{/);
    expect(src).toMatch(/window\.addEventListener\("click", suppressClick, true\)/);
  });

  it("the suppression calls preventDefault + stopPropagation + stopImmediatePropagation", () => {
    expect(src).toMatch(/ce\.preventDefault\(\);/);
    expect(src).toMatch(/ce\.stopPropagation\(\);/);
    expect(src).toMatch(/ce\.stopImmediatePropagation\(\);/);
  });

  it("the suppression is self-removing (either on fire or on the next-tick setTimeout)", () => {
    expect(src).toMatch(/window\.removeEventListener\("click", suppressClick, true\)/);
    expect(src).toMatch(/setTimeout\(\(\) => window\.removeEventListener\("click", suppressClick, true\), 0\)/);
  });

  it("suppression is scoped to the wasActive branch (does NOT fire on short-click)", () => {
    const idx = src.indexOf("if (wasActive) {");
    expect(idx).toBeGreaterThan(0);
    const activeBlock = src.slice(idx, idx + 1500);
    expect(activeBlock).toMatch(/suppressClick/);
    // The ELSE branch (click-without-drag) must NOT install
    // suppression, else Link clicks would be silently eaten.
    const elseIdx = src.indexOf("} else {", idx);
    const elseBlock = src.slice(elseIdx, elseIdx + 500);
    expect(elseBlock).not.toMatch(/suppressClick/);
  });
});

describe("COA-MAP-3C §C — pure-click navigation preserved (no activation = no suppression)", () => {
  const src = readFileSync(HOOK, "utf8");

  it("the <6px pointerup branch just clears startRef — no click interception", () => {
    const idx = src.indexOf("} else {", src.indexOf("if (wasActive) {"));
    expect(idx).toBeGreaterThan(0);
    const block = src.slice(idx, idx + 600);
    expect(block).toMatch(/startRef\.current = null;/);
    expect(block).not.toMatch(/preventDefault/);
    expect(block).not.toMatch(/stopPropagation/);
  });
});
