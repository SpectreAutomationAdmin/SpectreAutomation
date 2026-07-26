"use client";
// Concept B — Executive Briefing.
//
// Thesis: Verdict-first. Spectre's operational statement is the card
// title. Sender / attachment / timestamp are secondary metadata.

import type { ConceptProps } from "../review-client";
import { CATEGORY_OF, relativeFromISO } from "../fixtures";
import TabHost from "../shared/TabHost";

export default function ConceptB_ExecutiveBriefing({ fixture, state, onOpen, onCollapse, onResolve, resolveVerb }: ConceptProps) {
  const { isUnread, isExpanded, isResolved } = state;
  const category = CATEGORY_OF[fixture.lifecycleState];
  const whenRelative = fixture.conversation
    ? relativeFromISO(fixture.conversation.receivedAtISO)
    : (fixture.activity[fixture.activity.length - 1]?.at ?? "");

  return (
    <article
      className={`cb ${isUnread ? "cb--unread" : "cb--read"} ${isResolved ? "cb--resolved" : ""}`}
      data-testid={`concept-b-${fixture.id}`}
      data-unread={isUnread ? "true" : "false"}
      data-expanded={isExpanded ? "true" : "false"}
      data-resolved={isResolved ? "true" : "false"}
    >
      <button
        type="button"
        className="cb__surface"
        onClick={() => (isExpanded ? onCollapse() : onOpen())}
        aria-expanded={isExpanded}
        data-card-open="b"
        data-testid="card-primary"
      >
        <header className="cb__head">
          <p className="cb__eyebrow">
            <span className={`cb__cat cb__cat--${category}`}>
              {labelForState(fixture.lifecycleState, fixture.judgmentRequired)}
            </span>
            <span className="cb__eyebrow-sep">·</span>
            <span className="cb__entity-type">{prettyEntityType(fixture.entity.type)}</span>
            <span className="cb__eyebrow-sep">·</span>
            <span className="cb__entity-name">{fixture.entity.name}</span>
          </p>
          <time className="cb__when" title={fixture.conversation?.receivedAtISO ?? ""}>{whenRelative}</time>
        </header>
        <h3 className="cb__title">{fixture.intelligence.spectreFound}</h3>
        <p className="cb__matters">{fixture.intelligence.whyItMatters}</p>
        <p className="cb__action">
          <span className="cb__action-label">Recommended</span>
          <span className="cb__action-body">{fixture.intelligence.recommendedAction}</span>
        </p>
        <footer className="cb__foot">
          <span className="cb__meta">
            {fixture.conversation
              ? `Email from ${fixture.conversation.from}`
              : "System-generated"}
            {fixture.attachments.length
              ? ` · ${fixture.attachments.length} attachment${fixture.attachments.length === 1 ? "" : "s"}`
              : ""}
          </span>
          <span className="cb__confidence">
            <span className="cb__confidence-label">Confidence</span>
            <span className={`cb__confidence-value cb__confidence-value--${fixture.intelligence.confidence}`}>
              {fixture.intelligence.confidence}
            </span>
          </span>
        </footer>
      </button>

      {isExpanded ? (
        <div className="cb__expanded">
          <div className="cb__resolve-row">
            <button type="button" className="cb__resolve" onClick={onResolve} data-testid="resolve">
              {resolveVerb}
            </button>
          </div>
          <TabHost fixture={fixture} defaultTab={fixture.availableTabs.includes("invoice") ? "invoice" : fixture.availableTabs[0]} />
        </div>
      ) : null}

      <CbCss />
    </article>
  );
}

function labelForState(state: string, judgment: boolean): string {
  if (state === "RESOLVED") return "Resolved";
  if (state === "DEFERRED") return "Deferred";
  if (state === "INFORMATIONAL") return "Informational";
  if (judgment) return "Needs judgment";
  return "Open";
}
function prettyEntityType(t: string): string {
  return t.replace(/-/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

function CbCss() {
  return (
    <style dangerouslySetInnerHTML={{ __html: `
      .cb { background: #fdfaf1; border: 1px solid #ede6d3; border-radius: 4px; overflow: hidden; }
      .cb--unread { box-shadow: inset 3px 0 0 #2f4739; }
      .cb--resolved { opacity: 0.6; }
      .cb__surface { width: 100%; padding: 14px 16px; border: 0; background: transparent; text-align: left; cursor: pointer; font: inherit; display: block; }
      .cb__surface:hover { background: rgba(0,0,0,0.02); }
      .cb__head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-bottom: 6px; }
      .cb__eyebrow { margin: 0; font-size: 11px; color: #8a7f6a; letter-spacing: 0.4px; }
      .cb__eyebrow-sep { margin: 0 6px; }
      .cb__cat { text-transform: uppercase; font-weight: 700; letter-spacing: 0.8px; padding: 1px 6px; border-radius: 2px; }
      .cb__cat--active { background: #f4ecc9; color: #7a601f; }
      .cb__cat--terminal { background: #e6e2d8; color: #635a4a; }
      .cb__cat--informational { background: #e6e2d8; color: #635a4a; }
      .cb__entity-type { text-transform: uppercase; letter-spacing: 0.5px; }
      .cb__entity-name { color: #2b2b2b; }
      .cb__when { font-size: 11px; color: #8a7f6a; font-variant-numeric: tabular-nums; }

      .cb__title { margin: 4px 0 4px; font: 400 17px/1.35 "Iowan Old Style", Georgia, serif; color: #2b2b2b; }
      .cb--unread .cb__title { font-weight: 600; }
      .cb__matters { margin: 0 0 8px; font-size: 13px; color: #635a4a; line-height: 1.45; }

      .cb__action { margin: 0; display: flex; gap: 8px; align-items: baseline; padding: 8px 10px; background: #f6efdc; border-left: 3px solid #2f4739; border-radius: 3px; }
      .cb__action-label { font-size: 10px; letter-spacing: 1px; text-transform: uppercase; color: #8a7f6a; font-weight: 700; min-width: 90px; }
      .cb__action-body { font-size: 13px; color: #2b2b2b; }

      .cb__foot { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-top: 10px; padding-top: 8px; border-top: 1px dashed #ede6d3; }
      .cb__meta { font-size: 11px; color: #8a7f6a; }
      .cb__confidence { display: flex; align-items: baseline; gap: 6px; font-size: 11px; }
      .cb__confidence-label { color: #8a7f6a; text-transform: uppercase; letter-spacing: 0.6px; }
      .cb__confidence-value { text-transform: uppercase; font-weight: 700; letter-spacing: 0.6px; }
      .cb__confidence-value--high { color: #2f4739; }
      .cb__confidence-value--medium { color: #7a601f; }
      .cb__confidence-value--low, .cb__confidence-value--unresolved { color: #8a4227; }

      .cb__expanded { padding: 8px 16px 14px; border-top: 1px solid #ede6d3; background: #fefcf5; }
      .cb__resolve-row { display: flex; justify-content: flex-end; margin-bottom: 4px; }
      .cb__resolve { border: 1px solid #2f4739; background: #2f4739; color: #fdfaf1; padding: 6px 14px; border-radius: 4px; font-size: 12px; cursor: pointer; }
    ` }} />
  );
}
