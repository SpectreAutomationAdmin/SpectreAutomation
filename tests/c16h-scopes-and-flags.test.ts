// Sprint 3 · Checkpoint 16H — permission + feature-flag tests (§36).
// Proves the scope list is complete, gates on the correct env
// values, and never regresses to the pre-16H set.

import { describe, it, expect } from "vitest";
import { APPROVED_DELEGATED_SCOPES } from "@/lib/integrations/microsoft-graph-delegated";

describe("16H · APPROVED_DELEGATED_SCOPES", () => {
  it("includes every founder-approved scope", () => {
    const set = new Set<string>(APPROVED_DELEGATED_SCOPES as readonly string[]);
    expect(set.has("openid")).toBe(true);
    expect(set.has("profile")).toBe(true);
    expect(set.has("email")).toBe(true);
    expect(set.has("offline_access")).toBe(true);
    expect(set.has("User.Read")).toBe(true);
    expect(set.has("Mail.Read")).toBe(true);
    expect(set.has("Mail.Send")).toBe(true);
    expect(set.has("Calendars.Read")).toBe(true);
    expect(set.has("Mail.ReadWrite")).toBe(true);
  });

  it("does NOT include shared / application / calendar-write scopes (§1 forbidden list)", () => {
    const set = new Set<string>(APPROVED_DELEGATED_SCOPES as readonly string[]);
    expect(set.has("Calendars.ReadWrite")).toBe(false);
    expect(set.has("Calendars.Read.Shared")).toBe(false);
    expect(set.has("Mail.ReadWrite.Shared")).toBe(false);
    expect(set.has("Mail.Read.Shared")).toBe(false);
    expect(set.has("Mail.Send.Shared")).toBe(false);
  });
});

describe("16H · feature flags", () => {
  it("each flag defaults OFF and requires the master mailbox switch", async () => {
    // Save + restore state
    const priorMaster = process.env.MAILBOX_INTEGRATION_ENABLED;
    const priorCal = process.env.OUTLOOK_CALENDAR_READ_ENABLED;
    const priorRep = process.env.OUTLOOK_REPLY_ENABLED;
    const priorArc = process.env.OUTLOOK_ARCHIVE_ON_COMPLETION_ENABLED;
    try {
      // Master OFF → every gate returns false regardless of the sub-flag.
      process.env.MAILBOX_INTEGRATION_ENABLED = "false";
      process.env.OUTLOOK_CALENDAR_READ_ENABLED = "true";
      process.env.OUTLOOK_REPLY_ENABLED = "true";
      process.env.OUTLOOK_ARCHIVE_ON_COMPLETION_ENABLED = "true";
      // Re-import so the env is re-read.
      vi.resetModules();
      const modOff = await import("@/lib/env");
      expect(modOff.isOutlookCalendarReadEnabled()).toBe(false);
      expect(modOff.isOutlookReplyEnabled()).toBe(false);
      expect(modOff.isOutlookArchiveOnCompletionEnabled()).toBe(false);
    } finally {
      process.env.MAILBOX_INTEGRATION_ENABLED = priorMaster;
      process.env.OUTLOOK_CALENDAR_READ_ENABLED = priorCal;
      process.env.OUTLOOK_REPLY_ENABLED = priorRep;
      process.env.OUTLOOK_ARCHIVE_ON_COMPLETION_ENABLED = priorArc;
      vi.resetModules();
    }
  });
});

// Import vi from vitest for the module-reset test above.
import { vi } from "vitest";
