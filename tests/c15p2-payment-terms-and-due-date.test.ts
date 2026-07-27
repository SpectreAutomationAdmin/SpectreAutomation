// Sprint 3 · Checkpoint 15P-2 (2026-07-27) — payment-terms
// precedence + due-date resolution unit tests.

import { describe, expect, it } from "vitest";
import {
  resolvePaymentTerms,
  parseExtractedTermsValue,
  SPECTRE_DEFAULT_TERMS_DAYS,
} from "@/lib/ap-intelligence/payment-terms-resolve";
import { resolveDueDate } from "@/lib/ap-intelligence/due-date-resolve";

describe("15P-2 · payment terms precedence", () => {
  it("VENDOR_PROFILE wins over every other source", () => {
    const r = resolvePaymentTerms({
      vendorProfileTermsDays: 45,
      extractedTerms: { kind: "NET_DAYS", days: 30 },
      priorInvoiceTermsDays: 60,
      clubDefaultTermsDays: 15,
    });
    expect(r.days).toBe(45);
    expect(r.source).toBe("VENDOR_PROFILE");
    expect(r.provenanceHuman).toBe("From vendor profile");
    expect(r.label).toBe("Net 45");
    expect(r.isAutoPay).toBe(false);
  });

  it("INVOICE_PDF wins when no vendor profile", () => {
    const r = resolvePaymentTerms({
      vendorProfileTermsDays: null,
      extractedTerms: { kind: "NET_DAYS", days: 60 },
      priorInvoiceTermsDays: 30,
    });
    expect(r.days).toBe(60);
    expect(r.source).toBe("INVOICE_PDF");
    expect(r.provenanceHuman).toBe("From invoice PDF");
  });

  it("AUTO_PAY from the extractor collapses to 0-day + isAutoPay=true", () => {
    const r = resolvePaymentTerms({
      vendorProfileTermsDays: null,
      extractedTerms: { kind: "AUTO_PAY" },
    });
    expect(r.days).toBe(0);
    expect(r.isAutoPay).toBe(true);
    expect(r.label).toBe("Auto-pay");
    expect(r.source).toBe("INVOICE_PDF");
  });

  it("PRIOR_INVOICE wins when no vendor profile and no extraction", () => {
    const r = resolvePaymentTerms({
      vendorProfileTermsDays: null,
      extractedTerms: null,
      priorInvoiceTermsDays: 15,
    });
    expect(r.days).toBe(15);
    expect(r.source).toBe("PRIOR_INVOICE");
    expect(r.provenanceHuman).toBe("From prior approved invoices");
  });

  it("CLUB_DEFAULT wins when nothing above resolved", () => {
    const r = resolvePaymentTerms({
      vendorProfileTermsDays: null,
      extractedTerms: null,
      priorInvoiceTermsDays: null,
      clubDefaultTermsDays: 21,
    });
    expect(r.days).toBe(21);
    expect(r.source).toBe("CLUB_DEFAULT");
    expect(r.provenanceHuman).toBe("Club default");
  });

  it("SPECTRE_DEFAULT falls to Net 30 with honest provenance", () => {
    const r = resolvePaymentTerms({});
    expect(r.days).toBe(SPECTRE_DEFAULT_TERMS_DAYS);
    expect(r.days).toBe(30);
    expect(r.source).toBe("SPECTRE_DEFAULT");
    // FOUNDER RULE: never label Spectre fallback as "From invoice PDF".
    expect(r.provenanceHuman).toBe("Spectre default");
    expect(r.provenanceHuman).not.toBe("From invoice PDF");
  });

  it("clamps a negative days value to the Spectre default", () => {
    const r = resolvePaymentTerms({ vendorProfileTermsDays: -5 });
    expect(r.days).toBe(30);
  });

  it("clamps a stupidly large days value to 365", () => {
    const r = resolvePaymentTerms({ vendorProfileTermsDays: 999999 });
    expect(r.days).toBe(365);
  });
});

describe("15P-2 · extractor terms parser", () => {
  it("parses 'Net 30' → NET_DAYS(30)", () => {
    expect(parseExtractedTermsValue("Net 30")).toEqual({ kind: "NET_DAYS", days: 30 });
  });
  it("parses 'Net 45 days' → NET_DAYS(45)", () => {
    expect(parseExtractedTermsValue("Net 45 days")).toEqual({ kind: "NET_DAYS", days: 45 });
  });
  it("parses 'Auto-pay (charged automatically)' → AUTO_PAY", () => {
    expect(parseExtractedTermsValue("Auto-pay (charged automatically)")).toEqual({ kind: "AUTO_PAY" });
  });
  it("parses 'Due on receipt' → NET_DAYS(0)", () => {
    expect(parseExtractedTermsValue("Due on receipt")).toEqual({ kind: "NET_DAYS", days: 0 });
  });
  it("returns null on unknown strings", () => {
    expect(parseExtractedTermsValue("foobar")).toBeNull();
    expect(parseExtractedTermsValue("")).toBeNull();
    expect(parseExtractedTermsValue(null)).toBeNull();
    expect(parseExtractedTermsValue(undefined)).toBeNull();
  });
});

describe("15P-2 · due date resolution", () => {
  const july22 = new Date("2026-07-22T00:00:00.000Z");
  const july30 = new Date("2026-07-30T00:00:00.000Z");
  const aug21 = new Date("2026-08-21T00:00:00.000Z");

  it("Net 30 from invoice date 2026-07-22 → due 2026-08-21", () => {
    const r = resolveDueDate({ invoiceDate: july22, termsDays: 30, isAutoPay: false });
    expect(r.dueDate.toISOString()).toBe(aug21.toISOString());
    expect(r.source).toBe("COMPUTED_FROM_TERMS");
    expect(r.provenanceHuman).toBe("Invoice date + 30 days");
  });

  it("explicit invoice due date WINS over any terms calculation", () => {
    const explicit = new Date("2026-07-25T00:00:00.000Z");
    const r = resolveDueDate({
      explicitInvoiceDueDate: explicit,
      invoiceDate: july22,
      termsDays: 30,             // would otherwise compute Aug 21
      isAutoPay: false,
    });
    expect(r.dueDate.toISOString()).toBe(explicit.toISOString());
    expect(r.source).toBe("INVOICE_PDF");
    expect(r.provenanceHuman).toBe("Due date on invoice");
    // Founder rule: "Do not silently replace an explicit invoice due
    // date with Net 30." Even if terms are Net 30 the result must be
    // the explicit date.
    expect(r.dueDate.toISOString()).not.toBe(aug21.toISOString());
  });

  it("auto-pay collapses to invoice date", () => {
    const r = resolveDueDate({ invoiceDate: july22, termsDays: 30, isAutoPay: true });
    expect(r.dueDate.toISOString()).toBe(july22.toISOString());
    expect(r.source).toBe("AUTO_PAY");
  });

  it("Net 8 → due July 30", () => {
    const r = resolveDueDate({ invoiceDate: july22, termsDays: 8, isAutoPay: false });
    expect(r.dueDate.toISOString()).toBe(july30.toISOString());
    expect(r.provenanceHuman).toBe("Invoice date + 8 days");
  });

  it("Net 1 uses singular 'day' in the provenance line", () => {
    const r = resolveDueDate({ invoiceDate: july22, termsDays: 1, isAutoPay: false });
    expect(r.provenanceHuman).toBe("Invoice date + 1 day");
  });

  it("negative termsDays clamped to 0 (same day)", () => {
    const r = resolveDueDate({ invoiceDate: july22, termsDays: -10, isAutoPay: false });
    expect(r.dueDate.toISOString()).toBe(july22.toISOString());
  });
});
