// Sprint 3 · Checkpoint 16G Stage F · §25 blind-holdout benchmark.
//
// Emails whose EXACT wording never appears in any test above or in
// the founder-review feed. If we regress to hardcoding subject
// strings or specific senders, these must still classify correctly.
//
// Reports per-dimension metrics at the end via console.log so the
// final checkpoint report can quote them verbatim.

import { describe, it, expect } from "vitest";
import { classifyWorkDomain, type WorkDomain } from "@/lib/mailbox/work-domain-classifier";

interface HoldoutCase {
  id: string;
  subject: string;
  bodyText: string;
  sender: { name: string; address: string };
  expectedDomain: WorkDomain;
  expectedSubtypeIncludes?: string;
  hasAttachment?: boolean;
  attachmentClass?: "INVOICE" | "STATEMENT" | null;
}

const CASES: HoldoutCase[] = [
  // MEMBERSHIP — novel wording, no reuse of any prior test/subject
  { id: "M01", subject: "Question about signing up", bodyText: "Hi there. My father-in-law spoke highly of your club and we'd love to know what's involved in joining and if there's an initiation fee.", sender: { name: "Elena Vazquez", address: "elena.vazquez@example.com" }, expectedDomain: "MEMBERSHIP", expectedSubtypeIncludes: "PROSPECT_INQUIRY" },
  { id: "M02", subject: "Waiting list availability", bodyText: "Could you let me know approximately how long the wait list is for corporate membership at the moment?", sender: { name: "R. Osborne", address: "rosborne@acmecorp.example" }, expectedDomain: "MEMBERSHIP", expectedSubtypeIncludes: "WAITLIST" },
  { id: "M03", subject: "My husband's application", bodyText: "Just checking in on the status of my husband's membership application submitted last month.", sender: { name: "Ana Chen", address: "ana.c@example.org" }, expectedDomain: "MEMBERSHIP", expectedSubtypeIncludes: "APPLICATION" },
  { id: "M04", subject: "Resignation notice", bodyText: "I am writing to resign my membership effective the end of the month due to relocation.", sender: { name: "Peter Malik", address: "pmalik@example.com" }, expectedDomain: "MEMBERSHIP", expectedSubtypeIncludes: "RESIGNATION" },

  // AP — attachment-backed and body-vocabulary
  { id: "P01", subject: "November invoice attached", bodyText: "Please find attached invoice INV-2311 for November services, total $4,842.90 due December 15.", sender: { name: "Northwood Landscaping", address: "billing@northwood-land.example" }, expectedDomain: "ACCOUNTS_PAYABLE", hasAttachment: true, attachmentClass: "INVOICE" },
  { id: "P02", subject: "Balance owing on account", bodyText: "Reminder that your account has a balance owing. Please remit payment at your convenience.", sender: { name: "Peak Supply", address: "accounting@peak-supply.example" }, expectedDomain: "ACCOUNTS_PAYABLE" },

  // AR
  { id: "R01", subject: "My account balance", bodyText: "Could you help me understand my member account balance? I received a notice about aging.", sender: { name: "T. Reid", address: "treid@example.org" }, expectedDomain: "ACCOUNTS_RECEIVABLE" },

  // PAYROLL
  { id: "Y01", subject: "Bi-weekly pay cutoff", bodyText: "The pay period closes Sunday. Please approve gross pay before Monday morning for direct deposit.", sender: { name: "HR", address: "hr@example.com" }, expectedDomain: "PAYROLL" },

  // COMMUNICATIONS — general professional message
  { id: "C01", subject: "Thanks for the meeting yesterday", bodyText: "Following up on our conversation. Attached is the deck we discussed.", sender: { name: "J. Martin", address: "jm@partner-firm.example" }, expectedDomain: "GENERAL" /* Communications-like but no strong signal → GENERAL */ },

  // OPERATIONS
  { id: "O01", subject: "HVAC on lower floor", bodyText: "The HVAC on the lower floor is making noise again — could grounds have a look?", sender: { name: "GM", address: "gm@example.com" }, expectedDomain: "OPERATIONS" },

  // INFORMATIONAL
  { id: "I01", subject: "Auto-Reply: Out of office", bodyText: "This is an automatic reply. I will be out of office until next week.", sender: { name: "M. Chen", address: "mchen@example.com" }, expectedDomain: "INFORMATIONAL" },

  // GENERAL / ambiguous — must NOT classify as AP
  { id: "G01", subject: "Quick chat?", bodyText: "Hi, do you have 15 minutes today?", sender: { name: "Someone", address: "someone@example.com" }, expectedDomain: "GENERAL" },
  { id: "G02", subject: "Question", bodyText: "Wondering if you had any thoughts on the earlier email.", sender: { name: "Prospect Person", address: "p@example.com" }, expectedDomain: "GENERAL" },
];

describe("16G Stage F · blind holdout", () => {
  const results: Array<{ id: string; expected: string; predicted: string; correct: boolean; falseAp: boolean; falseVendor: boolean; correctGeneral: boolean }> = [];

  for (const c of CASES) {
    it(`${c.id}: '${c.subject.slice(0, 30)}' → ${c.expectedDomain}${c.expectedSubtypeIncludes ? ":" + c.expectedSubtypeIncludes : ""}`, () => {
      const d = classifyWorkDomain({
        subject: c.subject, bodyText: c.bodyText,
        senderName: c.sender.name, senderAddress: c.sender.address, senderDomain: c.sender.address.split("@")[1],
        hasAttachments: c.hasAttachment,
        attachments: c.hasAttachment ? [{ filename: "attached.pdf", classification: c.attachmentClass ?? null }] : [],
      });
      const correct = d.selectedDomain === c.expectedDomain;
      const falseAp = c.expectedDomain !== "ACCOUNTS_PAYABLE" && d.selectedDomain === "ACCOUNTS_PAYABLE";
      const falseVendor = c.expectedDomain !== "ACCOUNTS_PAYABLE" && d.alternatives.some((a) => a.domain === "ACCOUNTS_PAYABLE" && a.confidence > 0.4);
      const correctGeneral = c.expectedDomain === "GENERAL" && d.selectedDomain === "GENERAL";
      results.push({ id: c.id, expected: c.expectedDomain, predicted: d.selectedDomain, correct, falseAp, falseVendor, correctGeneral });
      expect(d.selectedDomain, `${c.id}: expected ${c.expectedDomain}, got ${d.selectedDomain}`).toBe(c.expectedDomain);
      if (c.expectedSubtypeIncludes) {
        expect(d.selectedSubtype).toBe(c.expectedSubtypeIncludes);
      }
    });
  }

  it("__blind_holdout_metrics", () => {
    // Consolidated metrics — run after all above.
    const total = results.length;
    const top1Correct = results.filter((r) => r.correct).length;
    const falseAp = results.filter((r) => r.falseAp).length;
    const falseVendor = results.filter((r) => r.falseVendor).length;
    const generalCases = results.filter((r) => r.expected === "GENERAL");
    const correctGeneral = generalCases.filter((r) => r.correct).length;
    const membershipCases = results.filter((r) => r.expected === "MEMBERSHIP");
    const membershipRecall = membershipCases.filter((r) => r.correct).length;

    const metrics = {
      cases: total,
      domain_top1_accuracy: `${top1Correct}/${total} = ${((100 * top1Correct) / total).toFixed(1)}%`,
      false_ap_classification_rate: `${falseAp}/${total} = ${((100 * falseAp) / total).toFixed(1)}%`,
      false_vendor_identification_rate: `${falseVendor}/${total} = ${((100 * falseVendor) / total).toFixed(1)}%`,
      correct_general_fallback_rate: `${correctGeneral}/${generalCases.length || 1} = ${((100 * correctGeneral) / Math.max(generalCases.length, 1)).toFixed(1)}%`,
      membership_recall: `${membershipRecall}/${membershipCases.length} = ${((100 * membershipRecall) / Math.max(membershipCases.length, 1)).toFixed(1)}%`,
    };
    // Print via stderr so the metric line is visible in vitest output.
    process.stderr.write(`\n=== 16G BLIND HOLDOUT METRICS ===\n${JSON.stringify(metrics, null, 2)}\n`);
    // Hard bar: false-AP rate MUST be 0% on this holdout.
    expect(falseAp).toBe(0);
    // Membership must have full recall on this holdout.
    expect(membershipRecall).toBe(membershipCases.length);
  });
});
