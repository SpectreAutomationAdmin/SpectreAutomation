// HR mobile-hotfix (2026-08-30) — founder terminology corrections.
//   Training → Safety & Training
//   Clocking In / Out → Clock In / Out
//   Tour walks Clock In / Out step between Scheduling + Paystubs.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function src(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

describe("HR mobile-hotfix · portal terminology + tour Clock In / Out step", () => {
  const home = src("src/app/employee/(authed)/page.tsx");
  const tour = src("src/components/employee/EmployeeTourOnFirstLogin.tsx");

  it("home widget label: Training tile now reads 'Safety & Training'", () => {
    expect(home).toMatch(/key: "training"[\s\S]{0,220}label: "Safety & Training"/);
    // Old bare 'Training' label with no ampersand must NOT appear as a widget label.
    expect(home).not.toMatch(/key: "training"[\s\S]{0,220}label: "Training"/);
  });

  it("home widget label: 'Clocking In / Out' → 'Clock In / Out'", () => {
    expect(home).toMatch(/key: "clocking-in-out"[\s\S]{0,220}label: "Clock In \/ Out"/);
    expect(home).not.toMatch(/label: "Clocking In \/ Out"/);
  });

  it("Clock In / Out widget carries a tourTarget so the guided tour can anchor to it", () => {
    expect(home).toMatch(/key: "clocking-in-out"[\s\S]{0,400}tourTarget: "clocking-in-out"/);
  });

  it("Tour STEPS include a Clock In / Out step between Scheduling and Paystubs", () => {
    const stepsBlock = tour.slice(tour.indexOf("const STEPS"), tour.indexOf("interface Props"));
    const iScheduling = stepsBlock.indexOf('"Scheduling"');
    const iClock = stepsBlock.indexOf('"Clock In / Out"');
    const iPaystubs = stepsBlock.indexOf('"Paystubs"');
    expect(iScheduling).toBeGreaterThan(-1);
    expect(iClock).toBeGreaterThan(iScheduling);
    expect(iPaystubs).toBeGreaterThan(iClock);
    expect(tour).toMatch(/data-tour-target="clocking-in-out"/);
  });

  it("Tour STEPS still include Safety & Training as the last-widget step before Profile", () => {
    const stepsBlock = tour.slice(tour.indexOf("const STEPS"), tour.indexOf("interface Props"));
    const iSafety = stepsBlock.indexOf('"Safety & Training"');
    const iProfile = stepsBlock.indexOf('"Profile"');
    expect(iSafety).toBeGreaterThan(-1);
    expect(iProfile).toBeGreaterThan(iSafety);
  });
});
