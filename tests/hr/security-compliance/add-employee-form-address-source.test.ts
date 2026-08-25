// HR mobile-hotfix continuation (2026-08-30) §1 — Admin-form address
// prefill wiring pins. Guards against a future refactor silently
// dropping the six home-address inputs from the Add Employee form.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function src(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

const form = src("src/app/app/admin/people/employees/new/AddEmployeeForm.tsx");
const route = src("src/app/api/people/employees/route.ts");

describe("HR mobile-hotfix · §1 admin address prefill — source wiring", () => {
  it("Add Employee form renders a labelled Home address section marked optional", () => {
    expect(form).toMatch(/data-testid="add-employee-home-address"/);
    expect(form).toMatch(/Home address/);
    expect(form).toMatch(/Optional — employee can add during onboarding/);
  });

  it("Add Employee form renders all six canonical inputs by name", () => {
    for (const name of [
      "homeAddressLine1", "homeAddressLine2",
      "homeCity", "homeProvince",
      "homePostalCode", "homeCountry",
    ]) {
      expect(form).toMatch(new RegExp(`name="${name}"`));
    }
  });

  it("Add Employee form defaults country to CA", () => {
    expect(form).toMatch(/id="homeCountry"[\s\S]{0,400}defaultValue="CA"/);
  });

  it("API route reads the six home-address fields off the form data", () => {
    for (const name of [
      "homeAddressLine1", "homeAddressLine2",
      "homeCity", "homeProvince",
      "homePostalCode", "homeCountry",
    ]) {
      expect(route).toMatch(new RegExp(`readOptionalString\\(fd, "${name}"\\)`));
    }
  });

  it("API route passes the six home-address fields into createEmployee", () => {
    // The createEmployee call has the fields listed by identifier.
    const createBlock = route.slice(route.indexOf("createEmployee(principal, clubId, {"));
    for (const name of [
      "homeAddressLine1", "homeAddressLine2",
      "homeCity", "homeProvince",
      "homePostalCode", "homeCountry",
    ]) {
      expect(createBlock).toMatch(new RegExp(`\\b${name},`));
    }
  });

  it("field values are OPTIONAL — form inputs never carry `required`", () => {
    // Extract just the Home address section block.
    const start = form.indexOf("add-employee-home-address");
    const end = form.indexOf("</section>", start);
    const section = form.slice(start, end);
    expect(section).not.toMatch(/required/);
  });
});
