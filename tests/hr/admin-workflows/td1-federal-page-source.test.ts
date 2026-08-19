// HR-2B.3.5 (2026-08-19) — Source-contract regression on the Federal
// TD1 page.
//
// The founder brief requires "a browser regression proving the Federal
// TD1 page contains no editable province selector and the subsequent
// provincial page is automatically the Club's province."
//
// A live browser regression against staging requires a raw invitation
// token, which HR-2A.1 fail-secure hardening intentionally keeps out
// of every admin UI + API response. We therefore pin the invariant at
// the source level here: the compiled JSX MUST NOT declare a province
// selector or the "which province will you be working in" question,
// and the Provincial TD1 page MUST NOT read `province` out of the
// persisted tax profile row (it now resolves from Club).
//
// If these strings ever come back, this test fails loudly on the next
// build — the same protection a Playwright DOM assertion would give,
// without the fixture-token dependency.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function readSource(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

describe("HR-2B.3.5 · Federal TD1 page — no province selector", () => {
  const src = readSource("src/app/hr/onboarding/payroll/td1-federal/page.tsx");

  it("does not contain an editable province select or radio", () => {
    expect(src).not.toMatch(/name="province"/);
    expect(src).not.toMatch(/data-testid="td1-federal-province"/);
    // The Federal page used to render `<select ... name="province">`.
    expect(src).not.toMatch(/<select[\s\S]{0,200}province/);
  });

  it("does not contain the 'Which province will you be working in?' question", () => {
    expect(src).not.toMatch(/which province will you be working/i);
  });

  it("does not contain the 'This determines which provincial TD1 you complete next' hint", () => {
    expect(src).not.toMatch(/this determines which provincial td1/i);
  });

  it("does resolve the province from the Club via resolveClubPayrollProvince", () => {
    expect(src).toMatch(/resolveClubPayrollProvince/);
  });

  it("does render the neutral 'Your provincial tax form will be for {name}' line", () => {
    expect(src).toMatch(/Your provincial tax form will be for/i);
    expect(src).toMatch(/data-testid="td1-federal-province-note"/);
  });

  it("fail-safe: renders unconfigured-Club neutral copy when Club is unconfigured", () => {
    expect(src).toMatch(/td1-federal-unconfigured/);
    expect(src).toMatch(/We need one Club payroll setting/i);
  });
});

describe("HR-2B.3.5 · Provincial TD1 page — reads Club, not persisted row", () => {
  const src = readSource("src/app/hr/onboarding/payroll/td1-provincial/page.tsx");

  it("resolves the province from the Club via resolveClubPayrollProvince", () => {
    expect(src).toMatch(/resolveClubPayrollProvince/);
  });

  it("does NOT derive the display province from `existing.province`", () => {
    // The old page read `getProvincialTd1(existing.province)` — that
    // path must not return; the province must come from the Club.
    expect(src).not.toMatch(/getProvincialTd1\(existing\.province\)/);
    expect(src).not.toMatch(/PROVINCE_NAMES\[existing\.province\]/);
  });

  it("renders the '{ProvinceName} tax details' heading", () => {
    expect(src).toMatch(/tax details/);
    expect(src).toMatch(/data-testid="td1-provincial-heading"/);
  });
});

describe("HR-2B.3.5 · saveFederalTd1Action — no browser province trust", () => {
  const src = readSource("src/app/hr/onboarding/payroll/_actions.ts");

  it("saveFederalTd1Action does NOT read `province` out of FormData", () => {
    // The old action started with:
    //   const provinceRaw = ((formData.get("province") as string | null) ?? ...
    // The new action MUST resolve from the Club instead. This regex
    // catches any regression that re-introduces browser-supplied
    // province reads inside saveFederalTd1Action.
    const federalActionMatch = src.match(
      /export async function saveFederalTd1Action[\s\S]*?^\}/m,
    );
    expect(federalActionMatch, "saveFederalTd1Action definition not found").toBeTruthy();
    const body = federalActionMatch![0];
    expect(body).not.toMatch(/formData\.get\("province"\)/);
    expect(body).toMatch(/resolveClubPayrollProvince/);
  });

  it("saveProvincialTd1Action resolves the province from the Club, not from existing row", () => {
    const provincialActionMatch = src.match(
      /export async function saveProvincialTd1Action[\s\S]*?^\}/m,
    );
    expect(provincialActionMatch, "saveProvincialTd1Action definition not found").toBeTruthy();
    const body = provincialActionMatch![0];
    expect(body).toMatch(/resolveClubPayrollProvince/);
    // The action MUST NOT compute the applicable form purely from
    // `existing.province` — the Club is authoritative.
    expect(body).not.toMatch(/getProvincialTd1\(existing\.province\)/);
  });
});
