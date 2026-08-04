// Sprint 3 · Checkpoint 16G Stage D — per-domain view-model contract
// tests. Ensures AP fields never leak onto a non-AP card and vice
// versa, and that primary actions + tabs match the domain.

import { describe, it, expect } from "vitest";
import { buildDomainViewModel } from "@/lib/mission-control/domain-view-models";

describe("16G Stage D · domain view-model contract", () => {
  const AP_FIELD_LABELS = ["VENDOR", "INVOICE", "AP STATUS", "AMOUNT"];

  it("MEMBERSHIP:WAITLIST card exposes PROSPECT / INQUIRY / RECEIVED / RESPONSE — NEVER AP fields", () => {
    const vm = buildDomainViewModel({
      workDomain: "MEMBERSHIP", workSubtype: "WAITLIST", workIntent: "RESPOND",
      senderDisplay: "Jane Doe", receivedLabel: "2 days ago", responseStatus: "Awaiting reply",
    });
    // Labels present.
    const labels = vm.fields.map((f) => f.label);
    expect(labels).toContain("Prospect / contact");
    expect(labels).toContain("Inquiry type");
    expect(labels).toContain("Received");
    expect(labels).toContain("Response status");
    // AP labels ABSENT.
    for (const bad of AP_FIELD_LABELS) {
      expect(labels).not.toContain(bad);
    }
    // Membership subtype rendered correctly.
    expect(vm.fields.find((f) => f.label === "Inquiry type")?.value).toBe("Waitlist");
    // No Invoice Review / Statement Review tabs.
    expect(vm.tabs).not.toContain("invoice");
    expect(vm.tabs).not.toContain("statement");
    // Primary action = Review & reply (per founder spec).
    expect(vm.primaryActions[0]?.label).toBe("Review & reply");
    // AP renderer suppressed.
    expect(vm.suppressApRenderer).toBe(true);
  });

  it("MEMBERSHIP:PROSPECT_INQUIRY renders 'Prospect inquiry' subtype", () => {
    const vm = buildDomainViewModel({ workDomain: "MEMBERSHIP", workSubtype: "PROSPECT_INQUIRY" });
    expect(vm.fields.find((f) => f.label === "Inquiry type")?.value).toBe("Prospect inquiry");
  });

  it("MEMBERSHIP:APPLICATION renders 'Application' subtype", () => {
    const vm = buildDomainViewModel({ workDomain: "MEMBERSHIP", workSubtype: "APPLICATION" });
    expect(vm.fields.find((f) => f.label === "Inquiry type")?.value).toBe("Application");
  });

  it("ACCOUNTS_PAYABLE card uses AP renderer path (suppressApRenderer=false)", () => {
    const vm = buildDomainViewModel({
      workDomain: "ACCOUNTS_PAYABLE", linkedIntelligenceInvoiceCount: 1,
    });
    expect(vm.suppressApRenderer).toBe(false);
    expect(vm.tabs).toContain("invoice");
    expect(vm.primaryActions[0]?.label).toContain("Review AP invoice");
  });

  it("ACCOUNTS_PAYABLE without invoice attachment uses 'Review' primary", () => {
    const vm = buildDomainViewModel({ workDomain: "ACCOUNTS_PAYABLE" });
    expect(vm.primaryActions[0]?.label).toBe("Review");
    expect(vm.tabs).not.toContain("invoice");
  });

  it("ACCOUNTS_PAYABLE with only STATEMENT attachment renders as 'Vendor statement'", () => {
    const vm = buildDomainViewModel({
      workDomain: "ACCOUNTS_PAYABLE", linkedIntelligenceStatementCount: 1,
    });
    expect(vm.domainLabel).toBe("Vendor statement");
    expect(vm.tabs).toContain("statement");
    expect(vm.tabs).not.toContain("invoice");
  });

  it("ACCOUNTS_RECEIVABLE renders Balance / Aging fields, NEVER AP fields", () => {
    const vm = buildDomainViewModel({ workDomain: "ACCOUNTS_RECEIVABLE" });
    const labels = vm.fields.map((f) => f.label);
    expect(labels).toContain("Member / account");
    expect(labels).toContain("Balance");
    expect(labels).toContain("Aging");
    expect(labels).toContain("Policy status");
    for (const bad of AP_FIELD_LABELS) expect(labels).not.toContain(bad);
    expect(vm.tabs).toContain("account_activity");
    expect(vm.tabs).toContain("aging");
    expect(vm.suppressApRenderer).toBe(true);
  });

  it("PAYROLL renders Pay period / Gross / Employees / Approval status", () => {
    const vm = buildDomainViewModel({ workDomain: "PAYROLL" });
    const labels = vm.fields.map((f) => f.label);
    expect(labels).toContain("Pay period");
    expect(labels).toContain("Gross / net total");
    expect(labels).toContain("Employees");
    expect(labels).toContain("Approval status");
    for (const bad of AP_FIELD_LABELS) expect(labels).not.toContain(bad);
    expect(vm.primaryActions[0]?.label).toBe("Review payroll");
  });

  it("GOVERNANCE renders Committee / Matter / Due date / Decision status", () => {
    const vm = buildDomainViewModel({ workDomain: "GOVERNANCE" });
    const labels = vm.fields.map((f) => f.label);
    expect(labels).toContain("Committee / board");
    expect(labels).toContain("Matter");
    expect(labels).toContain("Due date");
    expect(labels).toContain("Decision status");
    for (const bad of AP_FIELD_LABELS) expect(labels).not.toContain(bad);
  });

  it("OPERATIONS renders Area / Issue / Timing / Owner", () => {
    const vm = buildDomainViewModel({ workDomain: "OPERATIONS" });
    const labels = vm.fields.map((f) => f.label);
    expect(labels).toContain("Area");
    expect(labels).toContain("Issue / request");
    for (const bad of AP_FIELD_LABELS) expect(labels).not.toContain(bad);
  });

  it("INFORMATIONAL renders minimal Sender + Received (no AP fields, no Resolve as only action)", () => {
    const vm = buildDomainViewModel({ workDomain: "INFORMATIONAL" });
    for (const bad of AP_FIELD_LABELS) expect(vm.fields.map((f) => f.label)).not.toContain(bad);
    expect(vm.primaryActions[0]?.label).toBe("Mark reviewed");
  });

  it("GENERAL fallback renders Sender / Received / Response — never AP fields", () => {
    const vm = buildDomainViewModel({ workDomain: "GENERAL", senderDisplay: "Someone" });
    const labels = vm.fields.map((f) => f.label);
    expect(labels).toContain("Sender");
    for (const bad of AP_FIELD_LABELS) expect(labels).not.toContain(bad);
  });

  it("undefined workDomain falls back to GENERAL and never renders AP fields", () => {
    const vm = buildDomainViewModel({});
    expect(vm.domain).toBe("GENERAL");
    for (const bad of AP_FIELD_LABELS) expect(vm.fields.map((f) => f.label)).not.toContain(bad);
    expect(vm.suppressApRenderer).toBe(true);
  });

  it("every non-AP domain suppresses the AP renderer", () => {
    for (const d of ["MEMBERSHIP", "ACCOUNTS_RECEIVABLE", "PAYROLL", "COMMUNICATIONS", "GOVERNANCE", "OPERATIONS", "HOSPITALITY", "INFORMATIONAL", "GENERAL"]) {
      const vm = buildDomainViewModel({ workDomain: d });
      expect(vm.suppressApRenderer, `${d} must suppress AP renderer`).toBe(true);
    }
  });
});
