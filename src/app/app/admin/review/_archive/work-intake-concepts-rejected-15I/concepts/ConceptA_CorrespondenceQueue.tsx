"use client";
// Concept A — Correspondence Queue.
//
// Thesis: Volume-first. Dense single-row cards inspired by a premium
// inbox client; depth lives inside expansion. See §4 of
// docs/design/work-intake-card-concepts.md.

import type { ConceptProps } from "../review-client";
import { CATEGORY_OF, relativeFromISO } from "../fixtures";
import TabHost from "../shared/TabHost";

export default function ConceptA_CorrespondenceQueue({ fixture, state, onOpen, onCollapse, onResolve, resolveVerb }: ConceptProps) {
  const { isUnread, isExpanded, isResolved } = state;
  const category = CATEGORY_OF[fixture.lifecycleState];
  const senderLabel = fixture.conversation?.from ?? "System";
  const whenRelative = fixture.conversation
    ? relativeFromISO(fixture.conversation.receivedAtISO)
    : (fixture.activity[fixture.activity.length - 1]?.at ?? "");

  return (
    <article
      className={`ca ${isUnread ? "ca--unread" : "ca--read"} ${isResolved ? "ca--resolved" : ""}`}
      data-testid={`concept-a-${fixture.id}`}
      data-unread={isUnread ? "true" : "false"}
      data-expanded={isExpanded ? "true" : "false"}
      data-resolved={isResolved ? "true" : "false"}
    >
      <button
        type="button"
        className="ca__row"
        onClick={() => (isExpanded ? onCollapse() : onOpen())}
        aria-expanded={isExpanded}
        aria-label={`${isUnread ? "Unread. " : ""}${senderLabel}. ${fixture.intelligence.spectreFound}`}
        data-card-open="a"
        data-testid="card-primary"
      >
        {isUnread ? <span className="ca__dot" aria-hidden="true" /> : <span className="ca__dot ca__dot--empty" aria-hidden="true" />}
        <span className="ca__entity">
          <span className="ca__entity-name">{fixture.entity.name}</span>
          <span className="ca__entity-type">{prettyEntityType(fixture.entity.type)}</span>
        </span>
        <span className="ca__synopsis">
          <span className="ca__synopsis-h">{shortStatement(fixture.intelligence)}</span>
          <span className="ca__synopsis-b">{fixture.intelligence.recommendedAction}</span>
        </span>
        <span className={`ca__status ca__status--${category}`}>{labelForState(fixture.lifecycleState, fixture.judgmentRequired)}</span>
        <time className="ca__when" title={fixture.conversation?.receivedAtISO ?? ""}>{whenRelative}</time>
      </button>
      {isExpanded ? (
        <div className="ca__expanded">
          <ExpandedTop fixture={fixture} onResolve={onResolve} resolveVerb={resolveVerb} />
          <TabHost fixture={fixture} defaultTab={fixture.availableTabs.includes("invoice") ? "invoice" : fixture.availableTabs[0]} />
        </div>
      ) : null}
      <CaCss />
    </article>
  );
}

function ExpandedTop({ fixture, onResolve, resolveVerb }: { fixture: any; onResolve: () => void; resolveVerb: string }) {
  return (
    <div className="ca__ex-top">
      <div className="ca__ex-intel">
        <p className="ca__ex-label">Spectre found</p>
        <p className="ca__ex-body">{fixture.intelligence.spectreFound}</p>
        {fixture.intelligence.issue ? (
          <>
            <p className="ca__ex-label ca__ex-label--issue">Issue</p>
            <p className="ca__ex-body">{fixture.intelligence.issue}</p>
          </>
        ) : null}
      </div>
      <div className="ca__ex-actions">
        <button type="button" className="ca__resolve" onClick={onResolve} data-testid="resolve">
          {resolveVerb}
        </button>
      </div>
    </div>
  );
}

function labelForState(state: string, judgment: boolean): string {
  if (state === "RESOLVED") return "Resolved";
  if (state === "DEFERRED") return "Deferred";
  if (state === "INFORMATIONAL") return "Informational";
  if (judgment) return "Needs decision";
  return "Open";
}
function shortStatement(intel: { spectreFound: string; issue: string | null }): string {
  return intel.issue ?? intel.spectreFound;
}
function prettyEntityType(t: string): string {
  return t.replace(/-/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

function CaCss() {
  return (
    <style dangerouslySetInnerHTML={{ __html: `
      .ca { background: #fdfaf1; border: 1px solid #ede6d3; border-left: 3px solid transparent; border-radius: 4px; overflow: hidden; }
      .ca--unread { border-left-color: #2f4739; }
      .ca--resolved { opacity: 0.6; }
      .ca__row { display: grid; grid-template-columns: 14px 200px 1fr max-content max-content; align-items: center; gap: 12px; width: 100%; padding: 10px 14px; border: 0; background: transparent; cursor: pointer; text-align: left; font: inherit; }
      .ca__row:hover { background: rgba(0,0,0,0.02); }
      .ca__dot { width: 8px; height: 8px; border-radius: 50%; background: #2f4739; }
      .ca__dot--empty { background: transparent; }
      .ca__entity { display: flex; flex-direction: column; min-width: 0; }
      .ca__entity-name { font-size: 13px; font-weight: 600; color: #2b2b2b; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ca--read .ca__entity-name { font-weight: 500; color: #4a4a4a; }
      .ca__entity-type { font-size: 10px; color: #8a7f6a; text-transform: uppercase; letter-spacing: 0.6px; }
      .ca__synopsis { display: flex; flex-direction: column; min-width: 0; }
      .ca__synopsis-h { font-size: 13px; color: #2b2b2b; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ca--unread .ca__synopsis-h { font-weight: 600; }
      .ca__synopsis-b { font-size: 11px; color: #635a4a; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ca__status { font-size: 10px; letter-spacing: 0.6px; text-transform: uppercase; padding: 2px 8px; border-radius: 2px; }
      .ca__status--active { background: #f4ecc9; color: #7a601f; }
      .ca__status--terminal { background: #e6e2d8; color: #635a4a; }
      .ca__status--informational { background: #e6e2d8; color: #635a4a; }
      .ca__when { font-size: 11px; color: #8a7f6a; font-variant-numeric: tabular-nums; min-width: 60px; text-align: right; }

      .ca__expanded { padding: 12px 14px 14px; border-top: 1px solid #ede6d3; background: #fefcf5; }
      .ca__ex-top { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; margin-bottom: 4px; }
      .ca__ex-intel { flex: 1; }
      .ca__ex-label { margin: 0 0 2px; font-size: 10px; letter-spacing: 1px; text-transform: uppercase; color: #8a7f6a; font-weight: 600; }
      .ca__ex-label--issue { color: #8a4227; margin-top: 8px; }
      .ca__ex-body { margin: 0; font-size: 13px; line-height: 1.45; color: #2b2b2b; }
      .ca__ex-actions { flex: 0 0 auto; }
      .ca__resolve { border: 1px solid #2f4739; background: #2f4739; color: #fdfaf1; padding: 6px 12px; border-radius: 4px; font-size: 12px; cursor: pointer; }
    ` }} />
  );
}
