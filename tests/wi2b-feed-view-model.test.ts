// WI-2B (2026-09-27) — unit tests for the Work Intake feed
// view-model adapter and timestamp formatter. These do NOT touch
// Prisma or the network; they exercise the pure mapping logic.

import { describe, expect, it } from "vitest";
import { toFeedRow, toFeedRows } from "@/lib/work-intake/feed-view-model";
import { formatFeedTimestamp } from "@/lib/work-intake/format-feed-timestamp";
import type { WorkItem } from "@/lib/mission-control/index";

function baseItem(overrides: Partial<WorkItem>): WorkItem {
  return {
    id: "wi-1",
    state: "info",
    idTag: "WI-1",
    title: "Untitled",
    sender: { from: "Someone" },
    timestamp: "2026-09-27T12:00:00Z",
    timestampLabel: "just now",
    actions: [],
    sortTimestamp: "2026-09-27T12:00:00Z",
    ...overrides,
  } as WorkItem;
}

const ZONE = "America/Edmonton";
const CTX = { clubTimezone: ZONE, nowIso: "2026-09-27T20:00:00Z" };

describe("formatFeedTimestamp", () => {
  it("formats same-day timestamps as 'Today · h:mm AM/PM'", () => {
    // 2026-09-27T20:00Z is 14:00 Edmonton (MDT UTC-6). Same day.
    const out = formatFeedTimestamp("2026-09-27T18:30:00Z", ZONE, "2026-09-27T20:00:00Z");
    expect(out).toMatch(/^Today · \d{1,2}:\d{2} (AM|PM)$/);
    expect(out).toContain("Today");
  });

  it("formats prior-day timestamps as 'Yesterday · h:mm AM/PM'", () => {
    // now = 2026-09-27T20:00Z (14:00 MDT). Yesterday in Edmonton is
    // 2026-09-26. Pick 2026-09-26T22:00Z = 16:00 MDT on the 26th.
    const out = formatFeedTimestamp("2026-09-26T22:00:00Z", ZONE, "2026-09-27T20:00:00Z");
    expect(out).toMatch(/^Yesterday · \d{1,2}:\d{2} (AM|PM)$/);
  });

  it("returns empty string for missing/invalid input", () => {
    expect(formatFeedTimestamp(null, ZONE)).toBe("");
    expect(formatFeedTimestamp(undefined, ZONE)).toBe("");
    expect(formatFeedTimestamp("not-a-date", ZONE)).toBe("");
  });

  it("uses club timezone, not server timezone", () => {
    // 2026-09-27T05:30Z is 23:30 previous night (MDT). In Edmonton
    // that is still "Yesterday" relative to a mid-morning today.
    const out = formatFeedTimestamp(
      "2026-09-27T05:30:00Z",
      ZONE,
      "2026-09-27T20:00:00Z",
    );
    // 23:30 MDT on the 26th is "Yesterday" for a viewer whose local
    // now is 14:00 MDT on the 27th.
    expect(out.startsWith("Yesterday")).toBe(true);
  });
});

describe("toFeedRow — status mapping", () => {
  it("state='judgment' → 'Requires your judgment' with tone 'judgment'", () => {
    const row = toFeedRow(baseItem({ state: "judgment" }), CTX);
    expect(row.status).toEqual({ label: "Requires your judgment", tone: "judgment" });
  });

  it("state='approval' + workDomain='PAYROLL' → 'Needs confirmation'", () => {
    const row = toFeedRow(baseItem({ state: "approval", workDomain: "PAYROLL" }), CTX);
    expect(row.status).toEqual({ label: "Needs confirmation", tone: "confirm" });
  });

  it("state='approval' + workDomain != PAYROLL → 'Ready for review'", () => {
    const row = toFeedRow(baseItem({ state: "approval", workDomain: "ACCOUNTS_PAYABLE" }), CTX);
    expect(row.status).toEqual({ label: "Ready for review", tone: "review" });
  });

  it("state='info' → 'FYI' with tone 'fyi'", () => {
    const row = toFeedRow(baseItem({ state: "info" }), CTX);
    expect(row.status).toEqual({ label: "FYI", tone: "fyi" });
  });

  it("state='comm' and 'auto' both fall through to FYI (no strong claim)", () => {
    expect(toFeedRow(baseItem({ state: "comm" }), CTX).status.label).toBe("FYI");
    expect(toFeedRow(baseItem({ state: "auto" }), CTX).status.label).toBe("FYI");
  });
});

describe("toFeedRow — icon mapping", () => {
  it("AP invoice review → invoice icon", () => {
    const row = toFeedRow(
      baseItem({ workDomain: "ACCOUNTS_PAYABLE", classification: "AP_INVOICE_REVIEW" }),
      CTX,
    );
    expect(row.icon).toBe("invoice");
  });

  it("AP statement / consolidation → ap icon", () => {
    const row = toFeedRow(baseItem({ workDomain: "ACCOUNTS_PAYABLE" }), CTX);
    expect(row.icon).toBe("ap");
  });

  it("Payroll → payroll icon", () => {
    const row = toFeedRow(baseItem({ workDomain: "PAYROLL" }), CTX);
    expect(row.icon).toBe("payroll");
  });

  it("AR / Membership / Communications → member icon", () => {
    expect(toFeedRow(baseItem({ workDomain: "ACCOUNTS_RECEIVABLE" }), CTX).icon).toBe("member");
    expect(toFeedRow(baseItem({ workDomain: "MEMBERSHIP" }), CTX).icon).toBe("member");
    expect(toFeedRow(baseItem({ workDomain: "COMMUNICATIONS" }), CTX).icon).toBe("member");
  });

  it("Unknown / Governance / Operations → chart fallback", () => {
    expect(toFeedRow(baseItem({ workDomain: "GOVERNANCE" }), CTX).icon).toBe("chart");
    expect(toFeedRow(baseItem({ workDomain: "OPERATIONS" }), CTX).icon).toBe("chart");
    expect(toFeedRow(baseItem({}), CTX).icon).toBe("chart");
  });
});

describe("toFeedRow — action label + review href", () => {
  it("info / comm items render as View, others as Review", () => {
    expect(toFeedRow(baseItem({ state: "info" }), CTX).actionLabel).toBe("View");
    expect(toFeedRow(baseItem({ state: "comm" }), CTX).actionLabel).toBe("View");
    expect(toFeedRow(baseItem({ state: "judgment" }), CTX).actionLabel).toBe("Review");
    expect(toFeedRow(baseItem({ state: "approval" }), CTX).actionLabel).toBe("Review");
  });

  it("WI-2B.1: reviewHref uses workIntakeItemId, not WorkItem.id (email loader emits wi_ prefix)", () => {
    // Email/AR loaders set id="wi_<uuid>" and workIntakeItemId="<uuid>".
    const row = toFeedRow(
      baseItem({ id: "wi_abc-123", workIntakeItemId: "abc-123" }),
      CTX,
    );
    expect(row.reviewHref).toBe("/app/admin/work-intake/review/abc-123");
    // The prefixed presentation id must NEVER appear in the URL.
    expect(row.reviewHref).not.toContain("wi_");
  });

  it("WI-2B.1: reviewHref URL-encodes special chars in the canonical id", () => {
    const row = toFeedRow(
      baseItem({ id: "wi_slash/id", workIntakeItemId: "slash/id x" }),
      CTX,
    );
    expect(row.reviewHref).toBe("/app/admin/work-intake/review/slash%2Fid%20x");
  });

  it("WI-2B.1: loader-only items fall back to action[0].href (domain page)", () => {
    // e.g. loadPendingAPInvoiceItems returns id=APInvoice.id with no
    // workIntakeItemId and an action href pointing to the invoice.
    const row = toFeedRow(
      baseItem({
        id: "invoice-999",
        workIntakeItemId: undefined,
        actions: [
          { key: "approve", label: "Review & approve", kind: "primary", href: "/app/admin/ap/invoices/invoice-999" },
        ],
      }),
      CTX,
    );
    expect(row.reviewHref).toBe("/app/admin/ap/invoices/invoice-999");
  });

  it("WI-2B.1: unroutable items return undefined reviewHref (feed renders inert button)", () => {
    const row = toFeedRow(
      baseItem({ id: "orphan", workIntakeItemId: undefined, actions: [] }),
      CTX,
    );
    expect(row.reviewHref).toBeUndefined();
  });
});

describe("toFeedRows — batch mapping", () => {
  it("maps an empty list to []", () => {
    expect(toFeedRows([], CTX)).toEqual([]);
  });

  it("preserves order", () => {
    const out = toFeedRows(
      [baseItem({ id: "a" }), baseItem({ id: "b" }), baseItem({ id: "c" })],
      CTX,
    );
    expect(out.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
});
