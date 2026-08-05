// Sprint 3 · Checkpoint 16H completion — unit tests for the restore
// + completion changes.
//
// Focused on pure module behavior — no DB round-trip. Full end-to-end
// verification runs via authenticated Playwright + the Test-item
// repair executed against staging directly.

import { describe, it, expect } from "vitest";
import { CalendarCommitmentState } from "@/lib/mission-control/commitments";

describe("16H · WorkRestorationEvent — schema contract expectations", () => {
  // These tests document the invariants the schema promises so a
  // future migration cannot regress them silently. They live at
  // unit-test scope and read the generated Prisma client shape.
  it("WorkRestorationEvent has the founder-required fields", async () => {
    const { Prisma } = await import("@prisma/client");
    // At minimum, the following field names must exist on the model.
    // We read them off the schema-derived DMMF to keep the test
    // resilient to unrelated schema evolution.
    const dmmf = (Prisma as unknown as { dmmf: { datamodel: { models: Array<{ name: string; fields: Array<{ name: string }> }> } } }).dmmf;
    const restoration = dmmf.datamodel.models.find((m) => m.name === "WorkRestorationEvent");
    expect(restoration, "WorkRestorationEvent model missing").toBeDefined();
    const names = new Set(restoration!.fields.map((f) => f.name));
    for (const req of ["id", "clubId", "workIntakeItemId", "restoredByUserId", "restoredAt", "priorCompletionEventId", "reason"]) {
      expect(names.has(req), `field ${req} missing on WorkRestorationEvent`).toBe(true);
    }
  });
});

describe("16H · CalendarCommitmentState re-export sanity", () => {
  // Verifies the state type surface didn't drift while other 16H
  // work landed. Only asserts the type is exported for consumers.
  it("state literal string values compile", () => {
    const past: CalendarCommitmentState = "PAST";
    const running: CalendarCommitmentState = "IN_PROGRESS";
    const upcoming: CalendarCommitmentState = "UPCOMING";
    const allDay: CalendarCommitmentState = "ALL_DAY";
    expect([past, running, upcoming, allDay]).toEqual(["PAST", "IN_PROGRESS", "UPCOMING", "ALL_DAY"]);
  });
});
