"use client";
// Concept E — Timeline Anchor.
//
// Thesis: Entity-first. Card is split — left column is the intake item
// (compressed), right column is a mini-timeline of the linked entity's
// recent activity. When the entity is unresolved, the right column
// becomes the "match this entity" primary CTA.

import type { ConceptProps } from "../review-client";
import { CATEGORY_OF, relativeFromISO } from "../fixtures";
import TabHost from "../shared/TabHost";

export default function ConceptE_TimelineAnchor({ fixture, state, onOpen, onCollapse, onResolve, resolveVerb }: ConceptProps) {
  const { isUnread, isExpanded, isResolved } = state;
  const category = CATEGORY_OF[fixture.lifecycleState];
  const entityResolved = !!fixture.entity.recentEvents;

  return (
    <article
      className={`ce ${isUnread ? "ce--unread" : "ce--read"} ${isResolved ? "ce--resolved" : ""}`}
      data-testid={`concept-e-${fixture.id}`}
      data-unread={isUnread ? "true" : "false"}
      data-expanded={isExpanded ? "true" : "false"}
      data-resolved={isResolved ? "true" : "false"}
    >
      <button
        type="button"
        className="ce__surface"
        onClick={() => (isExpanded ? onCollapse() : onOpen())}
        aria-expanded={isExpanded}
        data-card-open="e"
        data-testid="card-primary"
      >
        <div className="ce__grid">
          {/* LEFT — the intake item, compressed to essentials */}
          <div className="ce__left">
            <p className="ce__eyebrow">
              <span className={`ce__cat ce__cat--${category}`}>{labelForState(fixture.lifecycleState, fixture.judgmentRequired)}</span>
              <span className="ce__when">
                {fixture.conversation ? relativeFromISO(fixture.conversation.receivedAtISO) : (fixture.activity[fixture.activity.length - 1]?.at ?? "")}
              </span>
            </p>
            <h3 className="ce__title">{fixture.intelligence.spectreFound}</h3>
            {fixture.intelligence.issue ? (
              <p className="ce__issue">{fixture.intelligence.issue}</p>
            ) : null}
            <p className="ce__rec">
              <span className="ce__rec-label">Next</span>
              <span>{fixture.intelligence.recommendedAction}</span>
            </p>
          </div>

          {/* RIGHT — the linked entity's mini timeline OR unresolved CTA */}
          <aside className="ce__right" aria-label={`${fixture.entity.name} context`}>
            <p className="ce__ent-head">
              <span className="ce__ent-type">{prettyEntityType(fixture.entity.type)}</span>
              {fixture.entity.timelineHref ? (
                <span className="ce__ent-link" aria-hidden="true">See timeline →</span>
              ) : null}
            </p>
            <p className="ce__ent-name">{fixture.entity.name}</p>
            {entityResolved ? (
              <>
                <p className="ce__ent-context">{fixture.entity.contextLine}</p>
                <ol className="ce__timeline" role="list">
                  {(fixture.entity.recentEvents ?? []).map((ev, i) => (
                    <li key={i} className="ce__t-row">
                      <span className="ce__t-when">{ev.whenRelative}</span>
                      <span className="ce__t-label">{ev.label}</span>
                    </li>
                  ))}
                </ol>
              </>
            ) : (
              <div className="ce__unresolved">
                <p className="ce__unres-line">
                  <strong>{fixture.entity.contextLine}.</strong> This is the operational blocker for the item on the left.
                </p>
                <p className="ce__unres-cta">Match or create this {prettyEntityType(fixture.entity.type).toLowerCase()} to unblock.</p>
              </div>
            )}
          </aside>
        </div>
      </button>

      {isExpanded ? (
        <div className="ce__expanded">
          <div className="ce__resolve-row">
            <button type="button" className="ce__resolve" onClick={onResolve} data-testid="resolve">
              {resolveVerb}
            </button>
          </div>
          <TabHost fixture={fixture} defaultTab={fixture.availableTabs.includes("invoice") ? "invoice" : fixture.availableTabs[0]} />
        </div>
      ) : null}
      <CeCss />
    </article>
  );
}

function labelForState(state: string, judgment: boolean): string {
  if (state === "RESOLVED") return "Resolved";
  if (state === "DEFERRED") return "Deferred";
  if (state === "INFORMATIONAL") return "Informational";
  if (judgment) return "Needs decision";
  return "Open";
}
function prettyEntityType(t: string): string {
  return t.replace(/-/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

function CeCss() {
  return (
    <style dangerouslySetInnerHTML={{ __html: `
      .ce { background: #fdfaf1; border: 1px solid #ede6d3; border-radius: 4px; overflow: hidden; }
      .ce--unread { border-left: 3px solid #2f4739; }
      .ce--resolved { opacity: 0.6; }
      .ce__surface { width: 100%; padding: 0; border: 0; background: transparent; text-align: left; cursor: pointer; font: inherit; display: block; }
      .ce__surface:hover { background: rgba(0,0,0,0.02); }
      .ce__grid { display: grid; grid-template-columns: 2fr 1fr; gap: 0; }
      @media (max-width: 720px) { .ce__grid { grid-template-columns: 1fr; } }
      .ce__left { padding: 14px 16px; }
      .ce__right { padding: 14px 16px; background: #f7f2e3; border-left: 1px solid #ede6d3; }
      @media (max-width: 720px) { .ce__right { border-left: 0; border-top: 1px solid #ede6d3; } }
      .ce__eyebrow { margin: 0 0 6px; display: flex; align-items: baseline; justify-content: space-between; gap: 8px; font-size: 11px; color: #8a7f6a; }
      .ce__cat { text-transform: uppercase; font-weight: 700; letter-spacing: 0.9px; padding: 1px 6px; border-radius: 2px; }
      .ce__cat--active { background: #f4ecc9; color: #7a601f; }
      .ce__cat--terminal { background: #e6e2d8; color: #635a4a; }
      .ce__cat--informational { background: #e6e2d8; color: #635a4a; }
      .ce__when { font-variant-numeric: tabular-nums; }

      .ce__title { margin: 4px 0 6px; font: 400 15px/1.35 "Iowan Old Style", Georgia, serif; color: #2b2b2b; }
      .ce--unread .ce__title { font-weight: 600; }
      .ce__issue { margin: 0 0 8px; font-size: 12px; color: #8a4227; }
      .ce__rec { margin: 0; display: flex; gap: 6px; align-items: baseline; font-size: 13px; }
      .ce__rec-label { font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: #8a7f6a; font-weight: 700; min-width: 32px; }

      .ce__ent-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; margin: 0 0 4px; }
      .ce__ent-type { font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: #8a7f6a; font-weight: 700; }
      .ce__ent-link { font-size: 10px; color: #2f4739; }
      .ce__ent-name { margin: 0 0 4px; font: 400 14px/1.2 "Iowan Old Style", Georgia, serif; font-weight: 600; }
      .ce__ent-context { margin: 0 0 8px; font-size: 11px; color: #635a4a; }

      .ce__timeline { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 3px; }
      .ce__t-row { display: flex; gap: 6px; font-size: 11px; }
      .ce__t-when { color: #8a7f6a; min-width: 60px; font-variant-numeric: tabular-nums; }
      .ce__t-label { color: #2b2b2b; }

      .ce__unresolved { margin-top: 4px; padding: 8px 10px; background: #f6e3d8; border-left: 3px solid #8a4227; border-radius: 3px; }
      .ce__unres-line { margin: 0 0 4px; font-size: 12px; color: #2b2b2b; }
      .ce__unres-cta { margin: 0; font-size: 11px; color: #8a4227; font-weight: 600; }

      .ce__expanded { padding: 8px 16px 14px; border-top: 1px solid #ede6d3; background: #fefcf5; }
      .ce__resolve-row { display: flex; justify-content: flex-end; margin-bottom: 4px; }
      .ce__resolve { border: 1px solid #2f4739; background: #2f4739; color: #fdfaf1; padding: 6px 14px; border-radius: 4px; font-size: 12px; cursor: pointer; }
    ` }} />
  );
}
