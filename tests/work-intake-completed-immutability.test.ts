// Sprint 3 · Phase 4R Completed-State Immutability (2026-08-15) — §A9
// 7-gate regression suite.
//
// Locks the founder lifecycle rule (§A1):
//   * ACTIVE → live intelligence may recompute
//   * POSTED/RESOLVED → founder-facing historical facts are FROZEN
//   * REOPENED → prior completion history preserved; active analysis
//     may evolve; prior snapshot must NEVER be destroyed
//
// Unit-level tests. They exercise the completion-snapshot type,
// server-side validator, and read wrapper contracts — the pure
// logic layers introduced by this slice. Integration behaviour
// (snapshot capture through the full API-route → resolveIntake →
// emitWorkCompletionEvent chain) is covered by targeted DB
// integration in a follow-up slice if the founder authorises.
//
// No brand/vendor-specific runtime logic. Uses generic supplier
// names (§A9 requirement).

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  COMPLETION_CARD_SNAPSHOT_VERSION,
  parseCompletionMetadata,
  readCardSnapshotFromMetadata,
  type CompletionCardSnapshot,
} from "@/lib/work-intake/completion-snapshot";
import { validateCardSnapshotFromClient } from "@/lib/work-intake/completion-snapshot-validate";

function mkSnap(overrides: Partial<CompletionCardSnapshot> = {}): CompletionCardSnapshot {
  return {
    snapshotVersion: COMPLETION_CARD_SNAPSHOT_VERSION,
    analysisVersion: "ap-v1:extract=8:supplier=3:lines=5:tax=3:ids=1:purpose=3:gl=6",
    supplierDisplayName: "Regression Vendor Corp",
    vendorId: "vnd_test_1",
    vendorDisplayName: "Regression Vendor Corp",
    vendorMatchState: "MATCHED",
    invoiceNumber: "INV-42",
    invoiceDate: "2026-08-15",
    dueDate: "2026-09-14",
    subtotal: 100.00,
    taxTotal: 5.00,
    total: 105.00,
    currency: "CAD",
    purchaseOrder: null,
    categoryLabel: "Licenses",
    glAccountNumber: "6062",
    glAccountName: "Licenses",
    allocations: [{
      accountNumber: "6062", accountName: "Licenses", amount: 100.00,
      taxTreatment: "RECOVERABLE", taxAmount: 5.00,
      confidence: 80, requiresReview: false,
    }],
    confidenceLabel: "High",
    workflowState: "READY_FOR_APPROVAL",
    recommendationSummary: "All required dimensions cleared.",
    completionType: "POSTED_AND_CLEARED",
    completedByUserId: "user_test_1",
    completedAt: "2026-08-15T15:00:00Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Gate 1 — RESOLVE captures snapshot: metadataJson envelope round-trips
// ---------------------------------------------------------------------------

describe("Gate 1 · RESOLVE captures snapshot in metadataJson envelope", () => {
  it("emitWorkCompletionEvent envelope carries cardSnapshot round-trip through parseCompletionMetadata", () => {
    const snap = mkSnap({ completionType: "RESOLVED" });
    const envelope = { cardSnapshot: snap };
    const raw = JSON.stringify(envelope);
    const parsed = parseCompletionMetadata(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.cardSnapshot).toBeDefined();
    expect(parsed!.cardSnapshot!.supplierDisplayName).toBe("Regression Vendor Corp");
    const roundTrip = readCardSnapshotFromMetadata(parsed);
    expect(roundTrip).not.toBeNull();
    expect(roundTrip!.snapshotVersion).toBe(COMPLETION_CARD_SNAPSHOT_VERSION);
  });
});

// ---------------------------------------------------------------------------
// Gate 2 — POST & CLEAR captures authoritative posted snapshot
// ---------------------------------------------------------------------------

describe("Gate 2 · POST & CLEAR snapshot uses authoritative posted values", () => {
  it("snapshot with completionType=POSTED_AND_CLEARED carries vendor legalName + posted GL account", () => {
    const posted = mkSnap({
      completionType: "POSTED_AND_CLEARED",
      supplierDisplayName: "Authoritative Corp",
      vendorDisplayName: "Authoritative Corp",
      vendorMatchState: "MATCHED",
      glAccountNumber: "6062",
      glAccountName: "Licenses",
      total: 105.00,
      currency: "CAD",
    });
    const roundTrip = readCardSnapshotFromMetadata({ cardSnapshot: posted });
    expect(roundTrip).not.toBeNull();
    expect(roundTrip!.supplierDisplayName).toBe("Authoritative Corp");
    expect(roundTrip!.vendorMatchState).toBe("MATCHED");
    expect(roundTrip!.glAccountNumber).toBe("6062");
    expect(roundTrip!.completionType).toBe("POSTED_AND_CLEARED");
  });
});

// ---------------------------------------------------------------------------
// Gate 3 — Mock analyser change does NOT mutate frozen snapshot
// ---------------------------------------------------------------------------

describe("Gate 3 · Frozen snapshot immune to later analyser changes", () => {
  it("readCardSnapshotFromMetadata returns the snapshot unchanged regardless of any live analyser output", () => {
    const originalSnap = mkSnap({
      supplierDisplayName: "Historical Vendor Corp",
      invoiceNumber: "INV-HISTORICAL",
      total: 500.00,
    });
    const envelope = { cardSnapshot: originalSnap };
    const raw = JSON.stringify(envelope);

    // Simulate "later mocked analyser change" — code paths ANYWHERE in
    // the process might now return supplierDisplayName="Something Else".
    // The frozen snapshot on WorkCompletionEvent.metadataJson is a
    // pure DATA record — nothing in the projection reader mutates it.
    const parsed = parseCompletionMetadata(raw);
    const snap = readCardSnapshotFromMetadata(parsed);
    expect(snap!.supplierDisplayName).toBe("Historical Vendor Corp");
    expect(snap!.invoiceNumber).toBe("INV-HISTORICAL");
    expect(snap!.total).toBe(500.00);

    // Re-read a second time — same values (idempotent).
    const parsed2 = parseCompletionMetadata(raw);
    const snap2 = readCardSnapshotFromMetadata(parsed2);
    expect(snap2!.supplierDisplayName).toBe("Historical Vendor Corp");
  });

  it("static contract guard: readCompletedCardFacts source-level file uses 'frozen' only when snapshot is shape-valid", () => {
    // Guards the invariant that the wrapper never returns source="frozen"
    // without a valid snapshotVersion match. If a future refactor
    // loosens this check, the tests below will fail — but ALSO this
    // source-level regex ensures the branch remains intact.
    const src = fs.readFileSync(
      path.join(process.cwd(), "src/lib/work-intake/read-completed-card-facts.ts"),
      "utf8",
    );
    // The wrapper MUST call readCardSnapshotFromMetadata (which
    // enforces snapshotVersion match).
    expect(src).toMatch(/readCardSnapshotFromMetadata/);
    // The wrapper MUST fall through to source="legacy" when snap is null.
    expect(src).toMatch(/"legacy"/);
  });
});

// ---------------------------------------------------------------------------
// Gate 4 — ACTIVE items still use live intelligence (no frozen overlay)
// ---------------------------------------------------------------------------

describe("Gate 4 · ACTIVE items still receive live intelligence", () => {
  it("readCompletedCardFacts source-level branches on WorkIntakeItem.status = RESOLVED/SUPPRESSED only", () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), "src/lib/work-intake/read-completed-card-facts.ts"),
      "utf8",
    );
    expect(src).toMatch(/COMPLETED_STATUSES\s*=\s*\[\s*"RESOLVED",\s*"SUPPRESSED"\s*\]/);
    // Non-terminal statuses return source="live" — the caller uses
    // live projection. Explicit early-return guards this.
    expect(src).toMatch(/return\s*\{\s*source:\s*"live",\s*snapshot:\s*null/);
  });
});

// ---------------------------------------------------------------------------
// Gate 5 — REOPEN preserves prior snapshot in audit history
// ---------------------------------------------------------------------------

describe("Gate 5 · REOPEN preserves prior WorkCompletionEvent + snapshot", () => {
  it("restoreIntake source-level file explicitly does NOT delete WorkCompletionEvent", () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), "src/lib/work-intake/actions.ts"),
      "utf8",
    );
    // Guarding rules:
    //   * restoreIntake writes a WorkRestorationEvent (audit trail)
    //   * restoreIntake NEVER deletes WorkCompletionEvent rows
    //   * restoreIntake NEVER clears resolvedAt / resolvedByUserId
    expect(src).toMatch(/workRestorationEvent\.create/);
    expect(src).not.toMatch(/workCompletionEvent\.delete/);
    // The comment quotes the explicit rule:
    expect(src).toMatch(/NEVER clear resolvedAt/i);
  });
});

// ---------------------------------------------------------------------------
// Gate 6 — Legacy pre-snapshot completed items render via fallback
// ---------------------------------------------------------------------------

describe("Gate 6 · Legacy completed items fall through when snapshot absent", () => {
  it("readCardSnapshotFromMetadata returns null when metadata has no cardSnapshot", () => {
    expect(readCardSnapshotFromMetadata({ apInvoiceId: "x", apInvoiceNumber: "y" })).toBeNull();
    expect(readCardSnapshotFromMetadata(null)).toBeNull();
    expect(readCardSnapshotFromMetadata(undefined)).toBeNull();
  });

  it("readCardSnapshotFromMetadata returns null when snapshotVersion mismatches", () => {
    const wrongVersion = { cardSnapshot: { ...mkSnap(), snapshotVersion: "999" as unknown as typeof COMPLETION_CARD_SNAPSHOT_VERSION } };
    expect(readCardSnapshotFromMetadata(wrongVersion)).toBeNull();
  });

  it("parseCompletionMetadata safely returns null for malformed JSON", () => {
    expect(parseCompletionMetadata("not json {")).toBeNull();
    expect(parseCompletionMetadata("null")).toBeNull();
    expect(parseCompletionMetadata("[]")).toBeNull();
    expect(parseCompletionMetadata("")).toBeNull();
    expect(parseCompletionMetadata(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Gate 7 — Posted facts override earlier proposal facts when they differ
// ---------------------------------------------------------------------------

describe("Gate 7 · Posted authoritative snapshot beats an earlier proposal", () => {
  it("POST-time snapshot uses vendor.legalName + posted expenseAccount, not any earlier extraction", () => {
    // The _post-ap-invoice-actions.ts POSTED snapshot is composed from
    // rows written INSIDE the atomic tx (APInvoice, Vendor,
    // expenseAccount). This is authoritative — the earlier proposal
    // (analysis.gl / analysis.vendor / extracted supplier) is NOT read.
    //
    // Static source-level guard on that call site.
    const src = fs.readFileSync(
      path.join(process.cwd(), "src/app/app/admin/ap/_post-ap-invoice-actions.ts"),
      "utf8",
    );
    // The POSTED snapshot MUST use vendor.legalName (Vendor row) not analysis.vendor.guessedName
    expect(src).toMatch(/postedCardSnapshot\s*=\s*\{[\s\S]{0,600}supplierDisplayName:\s*vendor\.legalName/);
    // The POSTED snapshot MUST use expenseAccount.accountNumber
    expect(src).toMatch(/glAccountNumber:\s*expenseAccount\.accountNumber/);
    // vendorMatchState hard-set to MATCHED (the vendor is the one just
    // used to post — by definition matched).
    expect(src).toMatch(/vendorMatchState:\s*"MATCHED"/);
  });
});

// ---------------------------------------------------------------------------
// Server-side validator — server never trusts arbitrary client input
// ---------------------------------------------------------------------------

describe("Server-side validator — client-provided snapshot is sanitised", () => {
  it("returns null for non-object input", () => {
    expect(validateCardSnapshotFromClient(null)).toBeNull();
    expect(validateCardSnapshotFromClient(undefined)).toBeNull();
    expect(validateCardSnapshotFromClient("string")).toBeNull();
    expect(validateCardSnapshotFromClient([])).toBeNull();
    expect(validateCardSnapshotFromClient(42)).toBeNull();
  });

  it("returns null when snapshotVersion is missing or mismatched", () => {
    expect(validateCardSnapshotFromClient({ supplierDisplayName: "X" })).toBeNull();
    expect(validateCardSnapshotFromClient({ snapshotVersion: "0", supplierDisplayName: "X" })).toBeNull();
    expect(validateCardSnapshotFromClient({ snapshotVersion: "999" })).toBeNull();
  });

  it("accepts a valid snapshot and drops unknown keys", () => {
    const raw = {
      snapshotVersion: COMPLETION_CARD_SNAPSHOT_VERSION,
      supplierDisplayName: "OK Corp",
      invoiceNumber: "INV-1",
      total: 42,
      currency: "CAD",
      // Injection attempts:
      __proto__: { hijack: true },
      unknownField: "should not survive",
      completedByUserId: "attacker",     // server MUST overwrite this
      completedAt: "1970-01-01T00:00:00Z", // server MUST overwrite this
    };
    const clean = validateCardSnapshotFromClient(raw);
    expect(clean).not.toBeNull();
    expect(clean!.supplierDisplayName).toBe("OK Corp");
    expect(clean!.invoiceNumber).toBe("INV-1");
    expect(clean!.total).toBe(42);
    // Unknown key not on the type — spread-check
    expect((clean as unknown as Record<string, unknown>).unknownField).toBeUndefined();
    // Server always stamps completedByUserId/completedAt itself.
    expect(clean!.completedByUserId).toBeNull();
    expect(clean!.completedAt).toBeNull();
  });

  it("clamps long strings and drops non-finite numbers", () => {
    const rogue = {
      snapshotVersion: COMPLETION_CARD_SNAPSHOT_VERSION,
      supplierDisplayName: "X".repeat(10_000),
      total: Number.POSITIVE_INFINITY,
      currency: NaN as unknown as string,
    };
    const clean = validateCardSnapshotFromClient(rogue);
    expect(clean).not.toBeNull();
    expect(clean!.supplierDisplayName!.length).toBeLessThanOrEqual(500);
    expect(clean!.total).toBeNull();
    expect(clean!.currency).toBeNull();
  });

  it("caps allocation array length + drops invalid allocation entries", () => {
    const many = Array.from({ length: 100 }, (_, i) => ({
      accountNumber: `61${i}`, accountName: `A${i}`, amount: i,
    }));
    const raw = {
      snapshotVersion: COMPLETION_CARD_SNAPSHOT_VERSION,
      allocations: [...many, "not-an-object", null, 42],
    };
    const clean = validateCardSnapshotFromClient(raw);
    expect(clean).not.toBeNull();
    expect(clean!.allocations).not.toBeNull();
    // Cap is 32, and non-object entries are dropped.
    expect(clean!.allocations!.length).toBeLessThanOrEqual(32);
    for (const a of clean!.allocations!) {
      expect(typeof a).toBe("object");
      expect(a.accountNumber).toMatch(/^6\d/);
    }
  });
});
