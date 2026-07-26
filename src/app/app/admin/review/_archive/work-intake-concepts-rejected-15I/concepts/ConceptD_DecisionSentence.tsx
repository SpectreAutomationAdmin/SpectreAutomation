"use client";
// Concept D — Decision Sentence.
//
// Thesis: One-sentence action per card. Every card reduces to a single
// verb-first sentence — if it can't, the item doesn't belong on Mission
// Control. The rest is receipts.

import type { ConceptProps } from "../review-client";
import { CATEGORY_OF, relativeFromISO } from "../fixtures";
import TabHost from "../shared/TabHost";

export default function ConceptD_DecisionSentence({ fixture, state, onOpen, onCollapse, onResolve, resolveVerb }: ConceptProps) {
  const { isUnread, isExpanded, isResolved } = state;
  const category = CATEGORY_OF[fixture.lifecycleState];
  const sentence = toDecisionSentence(fixture);

  return (
    <article
      className={`cd ${isUnread ? "cd--unread" : "cd--read"} ${isResolved ? "cd--resolved" : ""}`}
      data-testid={`concept-d-${fixture.id}`}
      data-unread={isUnread ? "true" : "false"}
      data-expanded={isExpanded ? "true" : "false"}
      data-resolved={isResolved ? "true" : "false"}
    >
      <button
        type="button"
        className="cd__surface"
        onClick={() => (isExpanded ? onCollapse() : onOpen())}
        aria-expanded={isExpanded}
        data-card-open="d"
        data-testid="card-primary"
      >
        <p className="cd__eyebrow">
          <span className={`cd__cat cd__cat--${category}`}>{labelForState(fixture.lifecycleState, fixture.judgmentRequired)}</span>
          <span className="cd__eyebrow-sep">·</span>
          <span>{prettyEntityType(fixture.entity.type)} · {fixture.entity.name}</span>
        </p>
        <p className="cd__sentence">{sentence}</p>
        <p className="cd__receipts">{buildReceipts(fixture)}</p>
      </button>

      {isExpanded ? (
        <div className="cd__expanded">
          <div className="cd__intel">
            <p className="cd__intel-h">What Spectre found</p>
            <p className="cd__intel-b">{fixture.intelligence.spectreFound}</p>
            {fixture.intelligence.issue ? (
              <>
                <p className="cd__intel-h cd__intel-h--issue">Why the sentence matters</p>
                <p className="cd__intel-b">{fixture.intelligence.whyItMatters}</p>
              </>
            ) : null}
          </div>
          <div className="cd__resolve-row">
            <button type="button" className="cd__resolve" onClick={onResolve} data-testid="resolve">
              {resolveVerb}
            </button>
          </div>
          <TabHost fixture={fixture} defaultTab={fixture.availableTabs.includes("invoice") ? "invoice" : fixture.availableTabs[0]} />
        </div>
      ) : null}

      <CdCss />
    </article>
  );
}

// Compresses the fixture into one action-first sentence. The rule is:
// verb + object + so-that clause. If Spectre couldn't recommend, the
// sentence still stands but the verb becomes "Review".
function toDecisionSentence(f: any): string {
  // Priority 1 — Spectre gave a real recommendation.
  if (f.intelligence.recommendedAction && f.intelligence.confidence !== "low" && f.intelligence.confidence !== "unresolved") {
    return f.intelligence.recommendedAction;
  }
  // Priority 2 — low confidence → surface the review sentence instead.
  return `Review this ${categoryHint(f)} — Spectre could not confidently classify it.`;
}
function categoryHint(f: any): string {
  if (f.invoice) return "invoice";
  if (f.entity.type === "member") return "member matter";
  if (f.entity.type === "employee") return "operational matter";
  return "item";
}
function buildReceipts(f: any): string {
  const bits: string[] = [];
  if (f.conversation) {
    bits.push(`Received via email from ${f.conversation.from}`);
    bits.push(relativeFromISO(f.conversation.receivedAtISO));
  } else {
    bits.push("System-generated");
  }
  if (f.attachments.length === 1) bits.push(`Attachment: ${f.attachments[0].filename}`);
  if (f.attachments.length > 1) bits.push(`${f.attachments.length} attachments`);
  if (f.invoice?.vendorGuess) bits.push(`Extracted vendor: ${f.invoice.vendorGuess}`);
  if (f.invoice?.total && f.invoice?.currency) bits.push(`${f.invoice.currency} ${f.invoice.total}`);
  return bits.join(" · ");
}
function labelForState(state: string, judgment: boolean): string {
  if (state === "RESOLVED") return "Done";
  if (state === "DEFERRED") return "Deferred";
  if (state === "INFORMATIONAL") return "FYI";
  if (judgment) return "Do";
  return "Open";
}
function prettyEntityType(t: string): string {
  return t.replace(/-/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

function CdCss() {
  return (
    <style dangerouslySetInnerHTML={{ __html: `
      .cd { background: #fdfaf1; border: 1px solid #ede6d3; border-radius: 4px; overflow: hidden; }
      .cd--unread { border-left: 3px solid #2f4739; }
      .cd--resolved { opacity: 0.6; }
      .cd__surface { width: 100%; padding: 16px 18px; border: 0; background: transparent; text-align: left; cursor: pointer; font: inherit; display: block; }
      .cd__surface:hover { background: rgba(0,0,0,0.02); }
      .cd__eyebrow { margin: 0 0 8px; font-size: 11px; color: #8a7f6a; letter-spacing: 0.4px; }
      .cd__eyebrow-sep { margin: 0 6px; }
      .cd__cat { text-transform: uppercase; font-weight: 700; letter-spacing: 0.9px; padding: 1px 6px; border-radius: 2px; }
      .cd__cat--active { background: #f4ecc9; color: #7a601f; }
      .cd__cat--terminal { background: #e6e2d8; color: #635a4a; }
      .cd__cat--informational { background: #e6e2d8; color: #635a4a; }
      .cd__sentence { margin: 0; font: 400 19px/1.35 "Iowan Old Style", Georgia, serif; color: #2b2b2b; }
      .cd--unread .cd__sentence { font-weight: 600; }
      .cd__receipts { margin: 8px 0 0; font-size: 12px; color: #8a7f6a; line-height: 1.45; }

      .cd__expanded { padding: 12px 18px 14px; border-top: 1px solid #ede6d3; background: #fefcf5; }
      .cd__intel { margin-bottom: 10px; }
      .cd__intel-h { margin: 0 0 2px; font-size: 10px; letter-spacing: 1px; text-transform: uppercase; color: #8a7f6a; font-weight: 700; }
      .cd__intel-h--issue { color: #8a4227; margin-top: 8px; }
      .cd__intel-b { margin: 0; font-size: 13px; line-height: 1.45; color: #2b2b2b; }
      .cd__resolve-row { display: flex; justify-content: flex-end; margin-bottom: 4px; }
      .cd__resolve { border: 1px solid #2f4739; background: #2f4739; color: #fdfaf1; padding: 6px 14px; border-radius: 4px; font-size: 12px; cursor: pointer; }
    ` }} />
  );
}
