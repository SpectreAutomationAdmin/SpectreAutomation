// Employee Portal Quick Links service tests (2026-08-27).

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  createQuickLink,
  updateQuickLink,
  deleteQuickLink,
  reorderQuickLinks,
  listQuickLinks,
  validateQuickLinkUrl,
  QUICK_LINK_MAX_COUNT,
} from "@/lib/employee-portal/quick-links";
import { resetDb, seedRbac } from "../../util/db";
import { makeAdminHrFixture, type AdminHrFixture } from "./_helpers";

describe("validateQuickLinkUrl — URL scheme allow-list", () => {
  it("accepts https:// URLs", () => {
    expect(validateQuickLinkUrl("https://example.com")).toBe("https://example.com/");
  });

  it("accepts Spectre-internal absolute paths", () => {
    expect(validateQuickLinkUrl("/employee/pay")).toBe("/employee/pay");
  });

  it("rejects http:// (must be https)", () => {
    expect(() => validateQuickLinkUrl("http://example.com")).toThrow();
  });

  it("rejects javascript: scheme", () => {
    expect(() => validateQuickLinkUrl("javascript:alert(1)")).toThrow();
  });

  it("rejects data: URIs", () => {
    expect(() => validateQuickLinkUrl("data:text/html,<script>alert(1)</script>")).toThrow();
  });

  it("rejects file:// URIs", () => {
    expect(() => validateQuickLinkUrl("file:///etc/passwd")).toThrow();
  });

  it("rejects arbitrary custom schemes", () => {
    expect(() => validateQuickLinkUrl("customscheme://foo")).toThrow();
  });

  it("rejects empty and malformed strings", () => {
    expect(() => validateQuickLinkUrl("")).toThrow();
    expect(() => validateQuickLinkUrl("not a url")).toThrow();
  });
});

describe("Employee Portal Quick Links service", () => {
  let fx: AdminHrFixture;

  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
    fx = await makeAdminHrFixture("QuickLinksFix");
  });

  it("list returns empty array for a Club with no configured links", async () => {
    const links = await listQuickLinks(fx.club.id);
    expect(links).toEqual([]);
  });

  it("create → list roundtrip preserves label, URL, order", async () => {
    const a = await createQuickLink(fx.clubAdmin, fx.club.id, {
      label: "Club Website",
      destinationType: "url",
      url: "https://example.com",
    });
    const b = await createQuickLink(fx.clubAdmin, fx.club.id, {
      label: "HR Policies",
      destinationType: "url",
      url: "https://hr.example.com/policies",
    });
    expect(a.sortOrder).toBe(0);
    expect(b.sortOrder).toBe(1);
    const links = await listQuickLinks(fx.club.id);
    expect(links.map((l) => l.label)).toEqual(["Club Website", "HR Policies"]);
  });

  it("rejects an invalid URL at create time", async () => {
    await expect(
      createQuickLink(fx.clubAdmin, fx.club.id, {
        label: "bad",
        destinationType: "url",
        url: "javascript:alert(1)",
      }),
    ).rejects.toThrow();
  });

  it("enforces the max-links cap", async () => {
    for (let i = 0; i < QUICK_LINK_MAX_COUNT; i++) {
      await createQuickLink(fx.clubAdmin, fx.club.id, {
        label: `L${i}`,
        destinationType: "url",
        url: `https://example.com/${i}`,
      });
    }
    await expect(
      createQuickLink(fx.clubAdmin, fx.club.id, {
        label: "over",
        destinationType: "url",
        url: "https://example.com/over",
      }),
    ).rejects.toThrow();
  });

  it("switching destination type url → file clears the url field", async () => {
    const link = await createQuickLink(fx.clubAdmin, fx.club.id, {
      label: "L", destinationType: "url", url: "https://example.com",
    });
    const updated = await updateQuickLink(fx.clubAdmin, fx.club.id, link.id, {
      destinationType: "file",
    });
    expect(updated.destinationType).toBe("file");
    expect(updated.url).toBeNull();
  });

  it("reorder rearranges sortOrder and rejects cross-tenant ids", async () => {
    const a = await createQuickLink(fx.clubAdmin, fx.club.id, {
      label: "A", destinationType: "url", url: "https://example.com/a",
    });
    const b = await createQuickLink(fx.clubAdmin, fx.club.id, {
      label: "B", destinationType: "url", url: "https://example.com/b",
    });
    const reordered = await reorderQuickLinks(fx.clubAdmin, fx.club.id, [b.id, a.id]);
    expect(reordered.map((l) => l.label)).toEqual(["B", "A"]);
    // Cross-tenant id refusal.
    const other = await makeAdminHrFixture("QuickLinksOther");
    const otherLink = await createQuickLink(other.clubAdmin, other.club.id, {
      label: "other", destinationType: "url", url: "https://example.com/other",
    });
    await expect(
      reorderQuickLinks(fx.clubAdmin, fx.club.id, [a.id, otherLink.id]),
    ).rejects.toThrow();
  });

  it("delete removes only the target link", async () => {
    const a = await createQuickLink(fx.clubAdmin, fx.club.id, {
      label: "A", destinationType: "url", url: "https://example.com/a",
    });
    const b = await createQuickLink(fx.clubAdmin, fx.club.id, {
      label: "B", destinationType: "url", url: "https://example.com/b",
    });
    await deleteQuickLink(fx.clubAdmin, fx.club.id, a.id);
    const remaining = await listQuickLinks(fx.club.id);
    expect(remaining.map((l) => l.id)).toEqual([b.id]);
  });

  it("tenant isolation — Club A links invisible to Club B", async () => {
    await createQuickLink(fx.clubAdmin, fx.club.id, {
      label: "A", destinationType: "url", url: "https://example.com/a",
    });
    const other = await makeAdminHrFixture("QuickLinksIsolate");
    const otherList = await listQuickLinks(other.club.id);
    expect(otherList).toEqual([]);
    // Admin of Club B cannot update Club A's link.
    const links = await listQuickLinks(fx.club.id);
    await expect(
      updateQuickLink(other.clubAdmin, other.club.id, links[0]!.id, { label: "hax" }),
    ).rejects.toThrow();
  });
});
