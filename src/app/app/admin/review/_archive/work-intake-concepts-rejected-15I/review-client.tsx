"use client";
// Sprint 3 Checkpoint 15I — Concept review harness (client).
//
// Renders the concept switcher, the fixture switcher, and the selected
// concept component. All read/expanded/resolved state is local React
// state — nothing is persisted, no DB write, no server action.

import { useCallback, useMemo, useState } from "react";
import type { WorkIntakeFixture, ConceptKey } from "./fixtures";
import { RESOLVE_ACTIONS } from "./fixtures";
import ConceptA_CorrespondenceQueue from "./concepts/ConceptA_CorrespondenceQueue";
import ConceptB_ExecutiveBriefing from "./concepts/ConceptB_ExecutiveBriefing";
import ConceptC_IntelligenceCaseFile from "./concepts/ConceptC_IntelligenceCaseFile";
import ConceptD_DecisionSentence from "./concepts/ConceptD_DecisionSentence";
import ConceptE_TimelineAnchor from "./concepts/ConceptE_TimelineAnchor";

interface Props {
  concepts: Array<{ key: string; slug: string; name: string; thesis: string }>;
  fixtures: WorkIntakeFixture[];
}

// Local per-fixture card state — read/expanded/resolved live here so
// concepts can share behaviour. Production wiring would replace this
// with a server-backed WorkIntakeItemRead table + resolveIntake action.
export interface CardState {
  isUnread: boolean;
  isExpanded: boolean;
  isResolved: boolean;
}

export interface ConceptProps {
  fixture: WorkIntakeFixture;
  state: CardState;
  onOpen: () => void;               // fires when user clicks the primary surface
  onCollapse: () => void;           // fires when user clicks an already-open card's collapse affordance
  onResolve: () => void;            // fires when user clicks the concept's resolve action
  resolveVerb: string;              // per-concept phrasing ("Resolve" / "Complete" / etc.)
}

type ViewMode = "single" | "compare";
type FeedFilter = "active" | "history";

export default function ConceptReviewClient({ concepts, fixtures }: Props) {
  const [conceptKey, setConceptKey] = useState<ConceptKey>("A");
  const [viewMode, setViewMode] = useState<ViewMode>("single");
  const [feedFilter, setFeedFilter] = useState<FeedFilter>("active");

  // Per-fixture card state. Seeded: unread = true for OPEN items;
  // read = true for RESOLVED. Resolved reflects the fixture's own state.
  const [cardStates, setCardStates] = useState<Record<string, CardState>>(() => {
    const seed: Record<string, CardState> = {};
    for (const f of fixtures) {
      seed[f.id] = {
        isUnread: f.lifecycleState === "OPEN" || f.lifecycleState === "IN_PROGRESS",
        isExpanded: false,
        isResolved: f.lifecycleState === "RESOLVED",
      };
    }
    return seed;
  });

  const activeConcept = concepts.find((c) => c.key === conceptKey) ?? concepts[0];

  const onOpen = useCallback((id: string) => {
    setCardStates((prev) => ({
      ...prev,
      [id]: { ...prev[id], isUnread: false, isExpanded: true },
    }));
  }, []);

  const onCollapse = useCallback((id: string) => {
    setCardStates((prev) => ({
      ...prev,
      // Note: collapse does NOT flip isUnread back to true — read state
      // persists per the shared contract.
      [id]: { ...prev[id], isExpanded: false },
    }));
  }, []);

  const onResolve = useCallback((id: string) => {
    setCardStates((prev) => ({
      ...prev,
      [id]: { ...prev[id], isResolved: true, isExpanded: false, isUnread: false },
    }));
  }, []);

  const resetAll = useCallback(() => {
    setCardStates(() => {
      const seed: Record<string, CardState> = {};
      for (const f of fixtures) {
        seed[f.id] = {
          isUnread: f.lifecycleState === "OPEN" || f.lifecycleState === "IN_PROGRESS",
          isExpanded: false,
          isResolved: f.lifecycleState === "RESOLVED",
        };
      }
      return seed;
    });
  }, [fixtures]);

  const visibleFixtures = useMemo(() => {
    // Active feed hides resolved items (matches the production loader
    // which filters status: notIn ["RESOLVED", "SUPPRESSED"]).
    // History feed shows only resolved items.
    return fixtures.filter((f) => {
      const s = cardStates[f.id];
      const resolved = s?.isResolved ?? f.lifecycleState === "RESOLVED";
      return feedFilter === "active" ? !resolved : resolved;
    });
  }, [fixtures, cardStates, feedFilter]);

  const renderConcept = useCallback(
    (conceptKey: ConceptKey, fixture: WorkIntakeFixture) => {
      const state = cardStates[fixture.id] ?? { isUnread: true, isExpanded: false, isResolved: false };
      const shared: ConceptProps = {
        fixture,
        state,
        onOpen: () => onOpen(fixture.id),
        onCollapse: () => onCollapse(fixture.id),
        onResolve: () => onResolve(fixture.id),
        resolveVerb: resolveVerbForConcept(conceptKey),
      };
      switch (conceptKey) {
        case "A": return <ConceptA_CorrespondenceQueue {...shared} />;
        case "B": return <ConceptB_ExecutiveBriefing {...shared} />;
        case "C": return <ConceptC_IntelligenceCaseFile {...shared} />;
        case "D": return <ConceptD_DecisionSentence {...shared} />;
        case "E": return <ConceptE_TimelineAnchor {...shared} />;
      }
    },
    [cardStates, onOpen, onCollapse, onResolve],
  );

  return (
    <div className="review-shell">
      <header className="review-head">
        <div className="review-head__title">
          <p className="review-eyebrow">Development · concept review</p>
          <h1>Work Intake — card concept comparison</h1>
          <p className="review-lede">
            Five substantially different ways to render the same Work Intake item. Compare like-for-like on
            identical fixture data. Nothing here writes to the database.
          </p>
        </div>
        <div className="review-head__actions">
          <button
            type="button"
            className="review-btn review-btn--ghost"
            onClick={resetAll}
            data-testid="reset-fixture-state"
          >
            Reset all card state
          </button>
        </div>
      </header>

      <nav className="review-controls" aria-label="Concept selector">
        <div className="review-controls__group">
          <span className="review-controls__label">View</span>
          <div className="review-toggle" role="tablist" aria-label="View mode">
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === "single"}
              className={`review-toggle__btn ${viewMode === "single" ? "review-toggle__btn--active" : ""}`}
              onClick={() => setViewMode("single")}
              data-testid="view-single"
            >
              Single concept
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === "compare"}
              className={`review-toggle__btn ${viewMode === "compare" ? "review-toggle__btn--active" : ""}`}
              onClick={() => setViewMode("compare")}
              data-testid="view-compare"
            >
              Compare all
            </button>
          </div>
        </div>

        <div className="review-controls__group">
          <span className="review-controls__label">Concept</span>
          <div className="review-tabs" role="tablist" aria-label="Concept">
            {concepts.map((c) => (
              <button
                type="button"
                key={c.key}
                role="tab"
                aria-selected={conceptKey === c.key}
                className={`review-tab ${conceptKey === c.key ? "review-tab--active" : ""}`}
                onClick={() => { setConceptKey(c.key as ConceptKey); setViewMode("single"); }}
                data-testid={`concept-${c.key}`}
                disabled={viewMode === "compare"}
              >
                <span className="review-tab__key">{c.key}</span>
                <span className="review-tab__name">{c.name}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="review-controls__group">
          <span className="review-controls__label">Feed</span>
          <div className="review-toggle" role="tablist" aria-label="Feed filter">
            <button
              type="button"
              role="tab"
              aria-selected={feedFilter === "active"}
              className={`review-toggle__btn ${feedFilter === "active" ? "review-toggle__btn--active" : ""}`}
              onClick={() => setFeedFilter("active")}
              data-testid="feed-active"
            >
              Active queue
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={feedFilter === "history"}
              className={`review-toggle__btn ${feedFilter === "history" ? "review-toggle__btn--active" : ""}`}
              onClick={() => setFeedFilter("history")}
              data-testid="feed-history"
            >
              Completed history
            </button>
          </div>
        </div>
      </nav>

      {viewMode === "single" ? (
        <section className="review-body">
          <div className="review-thesis" aria-live="polite">
            <span className="review-thesis__key">{activeConcept.key}</span>
            <span className="review-thesis__name">{activeConcept.name}</span>
            <span className="review-thesis__text">{activeConcept.thesis}</span>
          </div>

          {visibleFixtures.length === 0 ? (
            <p className="review-empty">No items in this view.</p>
          ) : (
            <ul className="review-feed" role="list" data-testid="concept-feed">
              {visibleFixtures.map((f) => (
                <li key={f.id} className="review-feed__item" data-testid={`feed-item-${f.id}`}>
                  {renderConcept(conceptKey, f)}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : (
        <section className="review-body">
          {visibleFixtures.length === 0 ? (
            <p className="review-empty">No items in this view.</p>
          ) : (
            visibleFixtures.map((f) => (
              <div key={f.id} className="review-compare-block">
                <header className="review-compare-block__head">
                  <h2>{f.fixtureLabel}</h2>
                  <p>{f.fixtureDescription}</p>
                </header>
                <div className="review-compare-block__grid">
                  {concepts.map((c) => (
                    <article key={c.key} className="review-compare-cell" data-testid={`compare-${c.key}-${f.id}`}>
                      <header className="review-compare-cell__head">
                        <span className="review-compare-cell__key">{c.key}</span>
                        <span className="review-compare-cell__name">{c.name}</span>
                      </header>
                      <div className="review-compare-cell__body">
                        {renderConcept(c.key as ConceptKey, f)}
                      </div>
                    </article>
                  ))}
                </div>
              </div>
            ))
          )}
        </section>
      )}

      <ReviewCss />
    </div>
  );
}

// Each concept picks its own resolve verb — the winning concept's verb
// guides the production terminology.
function resolveVerbForConcept(k: ConceptKey): string {
  switch (k) {
    case "A": return RESOLVE_ACTIONS.CLEAR;      // "Clear from Work Intake" — inbox mental model
    case "B": return RESOLVE_ACTIONS.RESOLVE;    // "Resolve" — verdict language
    case "C": return RESOLVE_ACTIONS.COMPLETE;   // "Complete" — case-close language
    case "D": return RESOLVE_ACTIONS.RESOLVE;    // action-sentence uses the verb it already surfaces
    case "E": return RESOLVE_ACTIONS.RESOLVE;
  }
}

// Scoped CSS — kept inline so the concept review is fully self-contained
// and does not touch globals.css (production visual tokens still apply).
function ReviewCss() {
  return (
    <style
      // Small, focused styles for the harness itself. Concepts use
      // their own inline styles (also scoped) so each concept can
      // embody a different visual bet without cross-contamination.
      dangerouslySetInnerHTML={{
        __html: `
        .review-shell { max-width: 1200px; margin: 0 auto; padding: 24px 20px 96px; color: var(--spectre-text-primary, #2b2b2b); }
        .review-head { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; margin-bottom: 20px; padding-bottom: 12px; border-bottom: 1px solid var(--spectre-border-hairline, #e6e2d8); }
        .review-eyebrow { margin: 0 0 4px; font-size: 11px; letter-spacing: 1.5px; text-transform: uppercase; color: #8a7f6a; font-weight: 600; }
        .review-head h1 { margin: 0; font: 400 24px/1.15 "Iowan Old Style", Georgia, serif; }
        .review-lede { margin: 6px 0 0; font-size: 13px; color: #635a4a; max-width: 640px; }
        .review-btn { border: 1px solid var(--spectre-border-hairline, #e6e2d8); background: transparent; padding: 6px 12px; border-radius: 4px; font-size: 12px; cursor: pointer; color: #635a4a; }
        .review-btn:hover { background: rgba(0,0,0,0.03); }
        .review-controls { display: flex; flex-wrap: wrap; gap: 20px; padding: 12px 0; margin-bottom: 24px; border-bottom: 1px solid var(--spectre-border-hairline, #e6e2d8); }
        .review-controls__group { display: flex; flex-direction: column; gap: 6px; }
        .review-controls__label { font-size: 10px; letter-spacing: 1.2px; text-transform: uppercase; color: #8a7f6a; font-weight: 600; }
        .review-toggle { display: inline-flex; border: 1px solid #ddd6c6; border-radius: 4px; overflow: hidden; }
        .review-toggle__btn { border: 0; background: #fbf7ee; padding: 6px 14px; font-size: 12px; cursor: pointer; color: #635a4a; }
        .review-toggle__btn--active { background: #2f4739; color: #fdfaf1; }
        .review-toggle__btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .review-tabs { display: inline-flex; gap: 4px; }
        .review-tab { display: inline-flex; align-items: center; gap: 6px; border: 1px solid #ddd6c6; background: #fbf7ee; padding: 6px 10px; font-size: 12px; cursor: pointer; border-radius: 4px; color: #635a4a; }
        .review-tab:hover:not(:disabled) { border-color: #2f4739; }
        .review-tab--active { background: #2f4739; color: #fdfaf1; border-color: #2f4739; }
        .review-tab__key { font-weight: 700; font-family: Georgia, serif; }
        .review-tab:disabled { opacity: 0.45; cursor: not-allowed; }
        .review-thesis { display: flex; align-items: baseline; gap: 10px; background: #f7f2e3; border: 1px solid #ede6d3; border-left-width: 3px; border-left-color: #2f4739; padding: 10px 14px; border-radius: 4px; margin-bottom: 18px; }
        .review-thesis__key { font-family: Georgia, serif; font-weight: 700; color: #2f4739; }
        .review-thesis__name { font-weight: 600; }
        .review-thesis__text { font-size: 13px; color: #635a4a; }
        .review-body { display: flex; flex-direction: column; gap: 12px; }
        .review-feed { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 8px; }
        .review-feed__item { }
        .review-empty { color: #8a7f6a; font-style: italic; padding: 24px 0; }
        .review-compare-block { border: 1px solid #ede6d3; padding: 14px; border-radius: 6px; background: #fefcf5; }
        .review-compare-block__head h2 { margin: 0; font: 400 16px/1.2 Georgia, serif; }
        .review-compare-block__head p { margin: 4px 0 12px; font-size: 12px; color: #8a7f6a; }
        .review-compare-block__grid { display: grid; grid-template-columns: 1fr; gap: 12px; }
        @media (min-width: 1100px) { .review-compare-block__grid { grid-template-columns: 1fr; } }
        .review-compare-cell { border: 1px solid #ede6d3; border-radius: 4px; overflow: hidden; background: #fdfaf1; }
        .review-compare-cell__head { display: flex; align-items: baseline; gap: 6px; padding: 6px 10px; background: #f5efdf; border-bottom: 1px solid #ede6d3; font-size: 11px; }
        .review-compare-cell__key { font-weight: 700; font-family: Georgia, serif; color: #2f4739; }
        .review-compare-cell__body { padding: 10px; }
        `,
      }}
    />
  );
}
