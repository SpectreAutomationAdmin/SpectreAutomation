// WI-SYNC-1h (2026-10-18) — regression protection for the manual
// Feed Sync refresh.  Pins the following invariants:
//
//   §1 The refresh handler calls reverifyWorkIntakeEmails, which
//      probes every open-WI email directly against Graph (NOT just
//      a Spectre DB read, NOT just an isRead-only fetch).
//   §2 The reverify service classifies via classifyProbe + applies
//      tombstone through applyTombstone — inheriting the main
//      sweep's delete-loop prevention + archive preservation.
//   §3 Archive is NEVER tombstoned on reverify.
//   §4 Financial preservation — the reverify path never touches
//      APInvoice / ApIntakeSource / JournalEntry / Approval /
//      Payment.
//   §5 No duplicate WIs — the reverify path never calls
//      upsertEmailIntake or workIntakeItem.create.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REVERIFY = readFileSync(
  join(process.cwd(), "src/lib/mailbox/reverify-active.ts"),
  "utf8",
);
const REFRESH = readFileSync(
  join(process.cwd(), "src/app/api/mission-control/refresh-mailbox/route.ts"),
  "utf8",
);
const RECONCILE = readFileSync(
  join(process.cwd(), "src/lib/mailbox/reconciliation.ts"),
  "utf8",
);

describe("WI-SYNC-1h §1 · refresh handler calls Graph for folder presence", () => {
  it("refresh-mailbox route imports and calls reverifyWorkIntakeEmails", () => {
    expect(REFRESH).toMatch(/reverifyWorkIntakeEmails/);
  });
  it("refresh handler no longer uses the isRead-only $select hack", () => {
    expect(REFRESH).not.toMatch(/\$select=isRead(?!,)/);
  });
  it("reverify service fetches each message via probeMessage (not just isRead)", () => {
    expect(REVERIFY).toMatch(/provider\.probeMessage\(/);
    expect(REVERIFY).toMatch(/provider\.getWellKnownFolder/);
  });
});

describe("WI-SYNC-1h §2 · reverify shares classification + bypasses historical-archive guard", () => {
  it("imports classifyProbe from reconciliation.ts", () => {
    expect(REVERIFY).toMatch(
      /import\s*\{\s*classifyProbe\s*\}\s*from\s*"\.\/reconciliation"/,
    );
  });
  it("acts on PRESENT_DELETED_ITEMS via completeOutlookDetectedDelete (bypasses archive guard)", () => {
    expect(REVERIFY).toMatch(
      /case "PRESENT_DELETED_ITEMS":[\s\S]*?completeOutlookDetectedDelete\(/,
    );
  });
  it("acts on DELETED (Graph 404) via completeOutlookDetectedDelete", () => {
    expect(REVERIFY).toMatch(/case "DELETED":[\s\S]*?completeOutlookDetectedDelete\(/);
  });
  it("completeOutlookDetectedDelete does NOT consult outlookArchiveMutation", () => {
    // The archive guard is the exact thing we're bypassing — if
    // this test ever fails, the reverify tombstone is back under
    // the historical-archive guard and the WI-SYNC-1h regression
    // is live again.
    const fn = REVERIFY.match(/async function completeOutlookDetectedDelete\([\s\S]*?^}/m);
    expect(fn).toBeTruthy();
    expect(fn![0]).not.toMatch(/outlookArchiveMutation/);
  });
  it("reverify module consults outlookDeleteMutation for loop prevention", () => {
    expect(REVERIFY).toMatch(/outlookDeleteMutation\.findFirst/);
    expect(REVERIFY).toMatch(/EVIDENCE_DELETE_RECONCILED/);
  });
  it("reverify module preserves RESOLVED/SUPPRESSED early return + userDismissedAt", () => {
    expect(REVERIFY).toMatch(/status === "RESOLVED" \|\| link\.workIntakeItem\.status === "SUPPRESSED"/);
    expect(REVERIFY).toMatch(/link\.workIntakeItem\.userDismissedAt/);
  });
  it("reverify module captures statusBeforeSuppression + writes EVIDENCE_DELETED", () => {
    expect(REVERIFY).toMatch(/statusBeforeSuppression:\s*captureBefore/);
    expect(REVERIFY).toMatch(/action:\s*"EVIDENCE_DELETED"/);
  });
  it("acts on PRESENT_INBOX by updating isRead only when it changed", () => {
    expect(REVERIFY).toMatch(
      /case "PRESENT_INBOX":[\s\S]*?probe\.isRead !== r\.currentIsRead/,
    );
    expect(REVERIFY).toMatch(
      /case "PRESENT_INBOX":[\s\S]*?emailMessage\.update[\s\S]*?isRead:\s*probe\.isRead/,
    );
  });
});

describe("WI-SYNC-1h §3 · archive is not tombstoned", () => {
  it("PRESENT_ARCHIVE increments archivePreservedCount, never calls applyTombstone", () => {
    // The switch arm for PRESENT_ARCHIVE must NOT contain applyTombstone.
    const match = REVERIFY.match(/case "PRESENT_ARCHIVE":[\s\S]*?break;/);
    expect(match).toBeTruthy();
    expect(match![0]).not.toMatch(/applyTombstone/);
    expect(match![0]).toMatch(/archivePreservedCount/);
  });
  it("classifyProbe emits SKIP_ARCHIVE_DEFERRED for archive folder", () => {
    expect(RECONCILE).toMatch(/disposition:\s*"PRESENT_ARCHIVE"/);
    expect(RECONCILE).toMatch(/action:\s*"SKIP_ARCHIVE_DEFERRED"/);
  });
});

describe("WI-SYNC-1h §4 · financial preservation", () => {
  it("reverify service does not touch AP / journal / approval / payment tables", () => {
    for (const forbidden of [
      /prisma\.aPInvoice\./,
      /prisma\.apIntakeSource\./,
      /prisma\.journalEntry\./,
      /prisma\.approvalRequest\./,
      /prisma\.vendorPayment\./,
    ]) {
      expect(REVERIFY).not.toMatch(forbidden);
    }
  });
});

describe("WI-SYNC-1h §5 · no WI duplication", () => {
  it("reverify never creates a new WorkIntakeItem", () => {
    expect(REVERIFY).not.toMatch(/workIntakeItem\.create/);
    expect(REVERIFY).not.toMatch(/upsertEmailIntake/);
  });
  it("reverify reads WIs + updates existing ones; never creates new ones", () => {
    // The suppression transaction legitimately calls
    // workIntakeItem.update, but the module must never call
    // workIntakeItem.create.
    expect(REVERIFY).toMatch(/prisma\.workIntakeItem\.findMany/);
    expect(REVERIFY).not.toMatch(/prisma\.workIntakeItem\.create/);
  });
});

describe("WI-SYNC-1h · bounding + idempotency", () => {
  it("limits reverify to 50 WIs by default (configurable up to 100)", () => {
    expect(REVERIFY).toMatch(/const limit = Math\.min\(100,\s*Math\.max\(1,\s*args\.limit \?\? 50\)\)/);
  });
  it("filters out already-softDeleted emails (nothing to reverify)", () => {
    expect(REVERIFY).toMatch(/if \(em\.softDeletedAt\) continue;/);
  });
  it("skips WIs in RESOLVED or SUPPRESSED state", () => {
    expect(REVERIFY).toMatch(
      /status:\s*\{\s*in:\s*\["OPEN",\s*"IN_PROGRESS",\s*"DEFERRED",\s*"INFORMATIONAL"\]\s*\}/,
    );
  });
});
