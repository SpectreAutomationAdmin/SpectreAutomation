// Sprint 3 · Post-16H P0-repair (2026-08-06) — read-only aggregate
// audit against staging Coulee Ridge mailbox using the existing
// inspect-wi diagnostic endpoint (no new endpoint deploy required
// per founder §7).
//
// Iterates every visible email-backed Work Intake item in the
// Mission Control feed, calls inspect-wi for each, and buckets
// the results by attachment-chain shape.

import { test } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const availability = stagingCredsAvailable();

test.describe("P0 aggregate attachment-chain audit", () => {
  test.skip(!availability.ready, availability.reason ?? "creds unavailable");

  test("audit all WIs surfaced in Mission Control", async ({ context }) => {
    const page = await loginAsFounder(context, { landing: "/app/admin" });
    await page.waitForLoadState("networkidle");
    // Grab every card's MAIL-XXXX suffix from the feed.
    const suffixes = await page.locator(".spectre-mc-item").evaluateAll((els) =>
      els
        .map((el) => (el.textContent ?? "").match(/MAIL-([A-Z0-9]{4})/)?.[1]?.toLowerCase() ?? null)
        .filter((s): s is string => !!s),
    );
    console.log(`Feed cards: ${suffixes.length} — MAIL-${suffixes.map((s) => s.toUpperCase()).join(", MAIL-")}`);

    // Sprint 3 · Post-16H P0-hardening (2026-08-07) — §5 distinguish
    // legitimate deduplication from a genuine ingestion defect.
    // DEDUP_REUSES_EXISTING_CANONICAL_SOURCE: an attachment SHA
    //   matches an already-ingested document; per Sprint 3 · 15S
    //   design, the ApIntakeSource lives under the ORIGINAL email
    //   attachment and is NOT recreated for the retransmission.
    //   The parent WI is still correctly promoted (INVOICE_LIKELY)
    //   because the retransmitted email inherits its classification
    //   from the shared document analysis.
    // MISSING_APINTAKESOURCE_DEFECT: a non-inline PDF attachment
    //   is present with a distinct SHA (or no linked canonical
    //   intake at all) and no ApIntakeSource exists — the recovery
    //   sweep should catch these.
    const buckets: Record<string, Array<{ mail: string; classification: string; status: string; attachmentContentType: string | null; hasApIntakeSource: boolean; hasIngestedDocument: boolean }>> = {
      OK: [],
      "STALE_INFORMATIONAL — has attachment + IngestedDocument + ApIntakeSource but WI still INFORMATIONAL": [],
      "DEDUP_REUSES_EXISTING_CANONICAL_SOURCE — legit retransmission, source lives under original attachment": [],
      "MISSING_APINTAKESOURCE_DEFECT — non-inline PDF but no ApIntakeSource AND no dedup evidence": [],
      "MISSING_INGESTED_DOCUMENT — ApIntakeSource present but no IngestedDocument": [],
      "NO_ATTACHMENT_ROW — hasAttachments true but zero EmailAttachment rows": [],
      "ATTACHMENT_ALL_INLINE — no non-inline PDF": [],
      "NO_EMAIL_ORIGIN — WI has no linked EmailMessage": [],
    };

    for (const s of suffixes) {
      const res = await page.request.post(`${availability.baseURL}/api/ap-intelligence/inspect-wi`, {
        data: { wiIdSuffix4: s },
      });
      if (res.status() !== 200) continue;
      const b = await res.json();
      const wi = b.workIntakeItem ?? {};
      const emailMessages: Array<{ hasAttachments: boolean }> = b.emailMessages ?? [];
      const attachments: Array<{ isInline: boolean; contentType: string }> = b.emailAttachments ?? [];
      const apSourcesByAttachment: Array<unknown> = b.apIntakeSourcesByAttachment ?? [];
      const docs: Array<unknown> = b.ingestedDocuments ?? [];

      const entry = {
        mail: `MAIL-${s.toUpperCase()}`,
        classification: wi.classification ?? "?",
        status: wi.status ?? "?",
        attachmentContentType: attachments[0]?.contentType ?? null,
        hasApIntakeSource: apSourcesByAttachment.length > 0,
        hasIngestedDocument: docs.length > 0,
      };
      if (emailMessages.length === 0) {
        buckets["NO_EMAIL_ORIGIN — WI has no linked EmailMessage"].push(entry);
        continue;
      }
      const hasAtt = emailMessages.some((m) => m.hasAttachments);
      if (hasAtt && attachments.length === 0) {
        buckets["NO_ATTACHMENT_ROW — hasAttachments true but zero EmailAttachment rows"].push(entry);
        continue;
      }
      const nonInline = attachments.filter((a) => !a.isInline);
      if (nonInline.length === 0) {
        buckets["ATTACHMENT_ALL_INLINE — no non-inline PDF"].push(entry);
        continue;
      }
      if (apSourcesByAttachment.length === 0) {
        // Distinguish legitimate retransmission dedup from a genuine
        // ingestion defect. If the parent WI is already promoted to
        // INVOICE_LIKELY, its child canonical AP intake inherits from
        // an earlier retransmission's ApIntakeSource (Sprint 3 · 15S
        // design). If the parent is still INFORMATIONAL AND there's
        // no source, that's the recovery-sweep bucket.
        if (wi.classification === "INVOICE_LIKELY") {
          buckets["DEDUP_REUSES_EXISTING_CANONICAL_SOURCE — legit retransmission, source lives under original attachment"].push(entry);
        } else {
          buckets["MISSING_APINTAKESOURCE_DEFECT — non-inline PDF but no ApIntakeSource AND no dedup evidence"].push(entry);
        }
        continue;
      }
      if (docs.length === 0) {
        buckets["MISSING_INGESTED_DOCUMENT — ApIntakeSource present but no IngestedDocument"].push(entry);
        continue;
      }
      if (wi.classification === "INFORMATIONAL" || wi.status === "INFORMATIONAL") {
        buckets["STALE_INFORMATIONAL — has attachment + IngestedDocument + ApIntakeSource but WI still INFORMATIONAL"].push(entry);
        continue;
      }
      buckets.OK.push(entry);
    }
    for (const [k, v] of Object.entries(buckets)) {
      console.log(`\n[${v.length}] ${k}`);
      for (const e of v.slice(0, 10)) {
        console.log(`  ${e.mail}  status=${e.status}  classification=${e.classification}  contentType=${e.attachmentContentType}  hasApSource=${e.hasApIntakeSource}  hasDoc=${e.hasIngestedDocument}`);
      }
    }
  });
});
