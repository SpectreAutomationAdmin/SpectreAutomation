// WI-SYNC-1a (2026-10-18) — source-contract locks + classifier
// behavioural tests for the one-shot mailbox reconciliation slice.
//
// Covers directive §9 scenarios 2 (Outlook delete → Spectre
// removal) + 11 (folder move) + 12 (Graph failure retry) + 13
// (cursor recovery not applicable — this is probe-based) + 14
// (tenant isolation) at the contract level.  Full integration
// coverage against a controlled test mailbox is deferred to the
// WI-SYNC-1e acceptance matrix.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyProbe } from "../src/lib/mailbox/reconciliation";

const SYNC_TS = readFileSync(join(process.cwd(), "src/lib/mailbox/sync.ts"), "utf8");
const FEED_TS = readFileSync(join(process.cwd(), "src/lib/mission-control/email-intake.ts"), "utf8");
const RECON_TS = readFileSync(join(process.cwd(), "src/lib/mailbox/reconciliation.ts"), "utf8");
const PROVIDER_TS = readFileSync(join(process.cwd(), "src/lib/integrations/microsoft-graph-delegated.ts"), "utf8");
const ROUTE_TS = readFileSync(join(process.cwd(), "src/app/api/admin/mailbox/reconcile/route.ts"), "utf8");

describe("WI-SYNC-1a · delta tombstone branch wires WI suppression", () => {
  it("imports handleEmailEvidenceDeleted from email-materializer", () => {
    expect(SYNC_TS).toMatch(/handleEmailEvidenceDeleted.*from.*email-materializer/);
  });
  it("calls handleEmailEvidenceDeleted inside the `norm.isRemoved` branch", () => {
    const removedBranch = SYNC_TS.slice(SYNC_TS.indexOf("norm.isRemoved"));
    expect(removedBranch).toMatch(/handleEmailEvidenceDeleted\(\s*\{[\s\S]*clubId:[\s\S]*emailMessageId:/);
  });
  it("still sets EmailMessage.softDeletedAt before invoking the WI transition", () => {
    const removedBranch = SYNC_TS.slice(SYNC_TS.indexOf("norm.isRemoved"));
    const softDeleteIdx = removedBranch.indexOf("softDeletedAt: new Date");
    const handlerIdx = removedBranch.indexOf("handleEmailEvidenceDeleted(");
    expect(softDeleteIdx).toBeGreaterThanOrEqual(0);
    expect(handlerIdx).toBeGreaterThan(softDeleteIdx);
  });
});

describe("WI-SYNC-1a · email-intake feed filter respects softDeletedAt", () => {
  it("filters emailOrigins to primary + emailMessage.softDeletedAt == null", () => {
    expect(FEED_TS).toMatch(/emailOrigins:\s*\{\s*some:\s*\{\s*role:\s*"PRIMARY",\s*emailMessage:\s*\{\s*softDeletedAt:\s*null/);
  });
  it("preserves the existing SUPPRESSED status filter", () => {
    expect(FEED_TS).toMatch(/status:\s*\{\s*notIn:\s*\[\s*"SUPPRESSED"\s*\]\s*\}/);
  });
});

describe("WI-SYNC-1a · reconciliation service", () => {
  it("exports reconcileMailbox + classifyProbe + the five dispositions", () => {
    expect(RECON_TS).toMatch(/export async function reconcileMailbox/);
    expect(RECON_TS).toMatch(/export function classifyProbe/);
    for (const d of [
      '"PRESENT_INBOX"',
      '"PRESENT_OTHER_FOLDER"',
      '"DELETED"',
      '"INACCESSIBLE_RETRYABLE"',
      '"INACCESSIBLE_PERMANENT"',
    ]) {
      expect(RECON_TS).toContain(d);
    }
  });
  it("blocks cross-tenant: refuses when mailbox.clubId !== args.clubId", () => {
    expect(RECON_TS).toMatch(/mailbox does not belong to the stated club/);
  });
  it("refuses non-CONNECTED mailboxes before any Graph call", () => {
    expect(RECON_TS).toMatch(/mailbox is not CONNECTED/);
  });
  it("only enumerates EmailMessage with matching clubId + mailboxConnectionId + softDeletedAt null", () => {
    const findManyBlock = RECON_TS.slice(RECON_TS.indexOf("prisma.emailMessage.findMany"));
    expect(findManyBlock).toMatch(/clubId:\s*args\.clubId/);
    expect(findManyBlock).toMatch(/mailboxConnectionId:\s*args\.mailboxConnectionId/);
    expect(findManyBlock).toMatch(/softDeletedAt:\s*null/);
  });
  it("applyTombstone is idempotent — only writes when softDeletedAt is null", () => {
    expect(RECON_TS).toMatch(/if\s*\(!existing\.softDeletedAt\)/);
  });
  it("applyTombstone enforces a defence-in-depth clubId guard", () => {
    expect(RECON_TS).toMatch(/if\s*\(existing\.clubId\s*!==\s*args\.clubId\)/);
  });
  it("delegates WI transition to handleEmailEvidenceDeleted", () => {
    expect(RECON_TS).toMatch(/handleEmailEvidenceDeleted\(/);
  });
});

describe("WI-SYNC-1a · classifyProbe behavioural outcomes", () => {
  const base = {
    emailMessageId: "em_1",
    graphMessageId: "AAk...",
    subject: "x",
    senderAddress: "a@b.c",
    receivedAt: new Date(),
    linkedWorkIntakeItemId: null,
    linkedWorkIntakeStatus: null,
    hasApIntakeSource: false,
    probeOutcome: "PRESENT" as const,
  };
  const folderNames = {
    "folder-inbox": "Inbox (Inbox)",
    "folder-deleted": "Deleted Items (Deleted Items)",
    "folder-archive": "Archive (Archive)",
  };

  it("PRESENT in inbox → NONE", () => {
    const r = classifyProbe({
      base,
      probe: { outcome: "PRESENT", parentFolderId: "folder-inbox" },
      inboxFolderId: "folder-inbox",
      folderNames,
    });
    expect(r.disposition).toBe("PRESENT_INBOX");
    expect(r.action).toBe("NONE");
  });

  it("PRESENT in Deleted Items → TOMBSTONE_AND_SUPPRESS", () => {
    const r = classifyProbe({
      base,
      probe: { outcome: "PRESENT", parentFolderId: "folder-deleted" },
      inboxFolderId: "folder-inbox",
      folderNames,
    });
    expect(r.disposition).toBe("PRESENT_OTHER_FOLDER");
    expect(r.action).toBe("TOMBSTONE_AND_SUPPRESS");
    expect(r.reason).toMatch(/Deleted Items/);
  });

  it("PRESENT in Archive → TOMBSTONE_AND_SUPPRESS (feed matches mailbox)", () => {
    const r = classifyProbe({
      base,
      probe: { outcome: "PRESENT", parentFolderId: "folder-archive" },
      inboxFolderId: "folder-inbox",
      folderNames,
    });
    expect(r.disposition).toBe("PRESENT_OTHER_FOLDER");
    expect(r.action).toBe("TOMBSTONE_AND_SUPPRESS");
  });

  it("Graph 404 → DELETED → TOMBSTONE_AND_SUPPRESS", () => {
    const r = classifyProbe({
      base,
      probe: { outcome: "DELETED", httpStatus: 404 },
      inboxFolderId: "folder-inbox",
      folderNames,
    });
    expect(r.disposition).toBe("DELETED");
    expect(r.action).toBe("TOMBSTONE_AND_SUPPRESS");
  });

  it("Graph 429 → INACCESSIBLE_RETRYABLE → SKIP (no tombstone)", () => {
    const r = classifyProbe({
      base,
      probe: {
        outcome: "INACCESSIBLE_RETRYABLE",
        httpStatus: 429,
        errorCode: "throttled",
        retryAfterSeconds: 10,
      },
      inboxFolderId: "folder-inbox",
      folderNames,
    });
    expect(r.disposition).toBe("INACCESSIBLE_RETRYABLE");
    expect(r.action).toBe("SKIP_INACCESSIBLE_RETRYABLE");
    expect(r.reason).toMatch(/retry/);
  });

  it("Graph 503 → INACCESSIBLE_RETRYABLE → SKIP (defends against mass soft-delete during Graph outage)", () => {
    const r = classifyProbe({
      base,
      probe: {
        outcome: "INACCESSIBLE_RETRYABLE",
        httpStatus: 503,
        errorCode: "service_unavailable",
      },
      inboxFolderId: "folder-inbox",
      folderNames,
    });
    expect(r.disposition).toBe("INACCESSIBLE_RETRYABLE");
    expect(r.action).toBe("SKIP_INACCESSIBLE_RETRYABLE");
  });

  it("Graph 403 → INACCESSIBLE_PERMANENT → SKIP (no tombstone, surfaced)", () => {
    const r = classifyProbe({
      base,
      probe: {
        outcome: "INACCESSIBLE_PERMANENT",
        httpStatus: 403,
        errorCode: "forbidden",
      },
      inboxFolderId: "folder-inbox",
      folderNames,
    });
    expect(r.disposition).toBe("INACCESSIBLE_PERMANENT");
    expect(r.action).toBe("SKIP_INACCESSIBLE_PERMANENT");
  });

  it("Network error (retryable) → SKIP (no tombstone)", () => {
    const r = classifyProbe({
      base,
      probe: { outcome: "INACCESSIBLE_RETRYABLE", errorCode: "network_error" },
      inboxFolderId: "folder-inbox",
      folderNames,
    });
    expect(r.action).toBe("SKIP_INACCESSIBLE_RETRYABLE");
  });
});

describe("WI-SYNC-1a · Microsoft Graph provider — probeMessage + getWellKnownFolder", () => {
  it("exports probeMessage with the five outcomes", () => {
    expect(PROVIDER_TS).toMatch(/probeMessage\(args:\s*ProbeMessageArgs\):\s*Promise<ProbeMessageResult>/);
    for (const o of ['"PRESENT"', '"DELETED"', '"INACCESSIBLE_RETRYABLE"', '"INACCESSIBLE_PERMANENT"']) {
      expect(PROVIDER_TS).toContain(o);
    }
  });
  it("probeMessage does not throw for ordinary mailbox errors", () => {
    const impl = PROVIDER_TS.slice(PROVIDER_TS.indexOf("async probeMessage("));
    // Returns {outcome:"DELETED"} on 404
    expect(impl).toMatch(/res\.status === 404 \|\| res\.status === 410/);
    expect(impl).toMatch(/outcome:\s*"DELETED"/);
    // Returns INACCESSIBLE_RETRYABLE on 429/503/5xx
    expect(impl).toMatch(/res\.status === 429 \|\| res\.status === 503/);
    expect(impl).toMatch(/outcome:\s*"INACCESSIBLE_RETRYABLE"/);
    // Returns INACCESSIBLE_PERMANENT on 401/403
    expect(impl).toMatch(/res\.status === 401 \|\| res\.status === 403/);
    expect(impl).toMatch(/outcome:\s*"INACCESSIBLE_PERMANENT"/);
  });
  it("probeMessage endpoint is a GET + ImmutableId Prefer header", () => {
    const impl = PROVIDER_TS.slice(PROVIDER_TS.indexOf("async probeMessage("));
    expect(impl).toMatch(/graph\.microsoft\.com\/v1\.0\/me\/messages\//);
    expect(impl).toMatch(/method:\s*"GET"/);
    expect(impl).toMatch(/IdType="ImmutableId"/);
  });
  it("getWellKnownFolder resolves inbox/deleteditems/archive by name", () => {
    expect(PROVIDER_TS).toMatch(/mailFolders\/\$\{encodeURIComponent\(args\.wellKnownName\)\}/);
    expect(PROVIDER_TS).toMatch(/"inbox" \| "archive" \| "deleteditems"/);
  });
});

describe("WI-SYNC-1a · admin reconcile API route", () => {
  it("defaults to DRY_RUN; apply requires explicit ?apply=1", () => {
    expect(ROUTE_TS).toMatch(/const dryRun = url\.searchParams\.get\("apply"\) !== "1"/);
  });
  it("rejects when caller is not the mailbox owner (and not SUPER_ADMIN)", () => {
    expect(ROUTE_TS).toMatch(/mailbox_not_owned/);
    expect(ROUTE_TS).toMatch(/SUPER_ADMIN/);
  });
  it("tenant-guards the specified mailboxConnectionId against the active clubId", () => {
    expect(ROUTE_TS).toMatch(/mailbox_wrong_tenant/);
  });
  it("422 when the mailbox is not CONNECTED", () => {
    expect(ROUTE_TS).toMatch(/mailbox_not_connected/);
  });
  it("writes audit rows for both dry-run and apply", () => {
    expect(ROUTE_TS).toMatch(/mailbox\.reconcile\.dry-run/);
    expect(ROUTE_TS).toMatch(/mailbox\.reconcile\.apply/);
  });
});
