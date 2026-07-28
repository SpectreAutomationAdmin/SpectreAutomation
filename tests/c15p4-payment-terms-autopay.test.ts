// Sprint 3 · Checkpoint 15P-4 (2026-07-28) — payment-terms
// Auto-pay provenance. Founder-observed defect: an invoice whose
// extractor found auto-pay wording was rendered as
// "Net 0 · From invoice PDF", indistinguishable from a true
// due-on-receipt Net 0. The distinction now:
//
//   AUTO_PAY extracted  → { days: 0, isAutoPay: true,
//                           provenanceHuman: "Auto-pay — charged
//                           automatically" }
//   NET_DAYS(0)         → { days: 0, isAutoPay: false,
//                           provenanceHuman: "From invoice PDF" }
//   no evidence         → Spectre default 30

import { describe, expect, it } from "vitest";
import { resolvePaymentTerms } from "@/lib/ap-intelligence/payment-terms-resolve";

describe("15P-4 · Auto-pay is distinguished from a true Net 0", () => {
  it("AUTO_PAY carries its own honest provenance label", () => {
    const r = resolvePaymentTerms({
      vendorProfileTermsDays: null,
      extractedTerms: { kind: "AUTO_PAY" },
    });
    expect(r.days).toBe(0);
    expect(r.isAutoPay).toBe(true);
    expect(r.label).toBe("Auto-pay");
    // 15P-4: distinct label — NOT the generic "From invoice PDF".
    expect(r.provenanceHuman).toBe("Auto-pay — charged automatically");
    expect(r.provenanceHuman).not.toBe("From invoice PDF");
  });

  it("An explicit Net 0 from the extractor keeps the generic invoice-PDF label", () => {
    const r = resolvePaymentTerms({
      vendorProfileTermsDays: null,
      extractedTerms: { kind: "NET_DAYS", days: 0 },
    });
    expect(r.days).toBe(0);
    expect(r.isAutoPay).toBe(false);
    expect(r.provenanceHuman).toBe("From invoice PDF");
  });

  it("No extractor evidence → Spectre default of 30 (not Net 0)", () => {
    const r = resolvePaymentTerms({});
    expect(r.days).toBe(30);
    expect(r.isAutoPay).toBe(false);
    expect(r.provenanceHuman).toBe("Spectre default");
  });

  it("Vendor profile Net 30 still wins even when extractor found AUTO_PAY (rare but correct)", () => {
    const r = resolvePaymentTerms({
      vendorProfileTermsDays: 30,
      extractedTerms: { kind: "AUTO_PAY" },
    });
    expect(r.days).toBe(30);
    expect(r.isAutoPay).toBe(false);
    expect(r.provenanceHuman).toBe("From vendor profile");
  });
});
