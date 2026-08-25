// HR mobile-hotfix (2026-08-30) §1 — Address in Onboarding source
// wiring pins. Behavioural coverage lives in
// onboarding-address-step.test.ts.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function src(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}
function exists(rel: string): boolean {
  return existsSync(resolve(process.cwd(), rel));
}

describe("HR mobile-hotfix · §1 Address in onboarding — source wiring", () => {
  const service       = src("src/lib/hr/employee-self-service.ts");
  const employees     = src("src/lib/hr/employees.ts");
  const continuation  = src("src/lib/hr/onboarding-continuation.ts");
  const actions       = src("src/app/hr/onboarding/about-you/_actions.ts");

  it("ack kind vocabulary includes about_you_address_confirmation", () => {
    expect(service).toMatch(/"about_you_address_confirmation"/);
  });

  it("exports acknowledgeSelfAddressStep + updateOnboardingHomeAddress + getOnboardingHomeAddress", () => {
    expect(service).toMatch(/export async function acknowledgeSelfAddressStep/);
    expect(service).toMatch(/export async function updateOnboardingHomeAddress/);
    expect(service).toMatch(/export async function getOnboardingHomeAddress/);
  });

  it("updateOnboardingHomeAddress refuses empty street or empty city", () => {
    // The service enforces both fields — an accidental Continue click
    // must not advance the step.
    expect(service).toMatch(/if \(!line1After \|\| !cityAfter\)/);
    expect(service).toMatch(/"Please enter your street address\."/);
    expect(service).toMatch(/"City is required\."/);
  });

  it("address audit payload never persists the raw street address", () => {
    // Audit meta carries presence flags + city/province only — the
    // street lines are intentionally NOT duplicated across the audit
    // stream. Any change here needs founder review.
    const fn = service.slice(service.indexOf("updateOnboardingHomeAddress"));
    const auditBlock = fn.slice(fn.indexOf("audit(null, {"), fn.indexOf("});", fn.indexOf("audit(null, {")));
    expect(auditBlock).not.toMatch(/homeAddressLine1:\s*before/);
    expect(auditBlock).not.toMatch(/homeAddressLine1:\s*data/);
    expect(auditBlock).not.toMatch(/homeAddressLine2/);
    expect(auditBlock).toMatch(/hadLine1:\s*Boolean/);
    expect(auditBlock).toMatch(/hadCity:\s*Boolean/);
  });

  it("continuation resolver reads addressAck and routes to /about-you/address between contact + employment", () => {
    expect(continuation).toMatch(/aboutYouAddress:\s*"\/hr\/onboarding\/about-you\/address"/);
    expect(continuation).toMatch(/kind:\s*"about_you_address_confirmation"/);
    // Order: address check comes AFTER contactDone and BEFORE employmentDone.
    const body = continuation.slice(continuation.indexOf("if (!nameDone)"));
    const iContact = body.indexOf("if (!contactDone)");
    const iAddress = body.indexOf("if (!addressDone)");
    const iEmployment = body.indexOf("if (!employmentDone)");
    expect(iContact).toBeGreaterThan(-1);
    expect(iAddress).toBeGreaterThan(iContact);
    expect(iEmployment).toBeGreaterThan(iAddress);
  });

  it("saveContactAction now redirects to /about-you/address, not directly to /employment", () => {
    // The contact action's tail redirect changed as part of this slice.
    const contactBlock = actions.slice(actions.indexOf("saveContactAction"), actions.indexOf("saveAddressAction"));
    expect(contactBlock).toMatch(/redirect\("\/hr\/onboarding\/about-you\/address"\)/);
    expect(contactBlock).not.toMatch(/redirect\("\/hr\/onboarding\/about-you\/employment"\)/);
  });

  it("saveAddressAction composes updateOnboardingHomeAddress + acknowledgeSelfAddressStep", () => {
    expect(actions).toMatch(/export async function saveAddressAction/);
    const fn = actions.slice(actions.indexOf("saveAddressAction"));
    expect(fn).toMatch(/updateOnboardingHomeAddress\(actor,\s*patch\)/);
    expect(fn).toMatch(/acknowledgeSelfAddressStep\(actor\)/);
    // On success, moves to employment; on error, returns to /about-you/address.
    expect(fn).toMatch(/redirect\("\/hr\/onboarding\/about-you\/employment"\)/);
    expect(fn).toMatch(/withErr\("\/hr\/onboarding\/about-you\/address"/);
  });

  it("the address page file exists at the canonical URL", () => {
    expect(exists("src/app/hr/onboarding/about-you/address/page.tsx")).toBe(true);
    const page = src("src/app/hr/onboarding/about-you/address/page.tsx");
    // Prefill hook + confirm-or-enter copy.
    expect(page).toMatch(/getOnboardingHomeAddress/);
    expect(page).toMatch(/Confirm & continue/);
  });

  it("createEmployee + updateEmployee accept homeAddress* fields (admin optional prefill)", () => {
    // Type signatures widened.
    expect(employees).toMatch(/CreateEmployeeInput[\s\S]{0,1200}homeAddressLine1\?:/);
    expect(employees).toMatch(/UpdateEmployeeInput[\s\S]{0,1200}homeAddressLine1\?:/);
    // Writer branches wire the fields through.
    expect(employees).toMatch(/homeAddressLine1:\s*input\.homeAddressLine1\s*\?\?\s*null/);
    expect(employees).toMatch(/if \(input\.homeAddressLine1 !== undefined\) data\.homeAddressLine1 = input\.homeAddressLine1/);
    // Province + country are uppercased.
    expect(employees).toMatch(/homeProvince:\s*input\.homeProvince\s*\?\s*input\.homeProvince\.toUpperCase\(\)\s*:\s*null/);
  });
});
