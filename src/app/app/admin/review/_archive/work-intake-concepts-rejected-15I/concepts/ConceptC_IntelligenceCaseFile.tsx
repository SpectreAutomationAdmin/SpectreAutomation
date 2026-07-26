"use client";
// Concept C — Intelligence Case File.
//
// Thesis: Structured case. Named sections (Case type, Status, Evidence,
// Findings, Confidence, Open question, Recommended action) make
// Spectre's reasoning legible.

import type { ConceptProps } from "../review-client";
import { CATEGORY_OF, relativeFromISO, formatBytes } from "../fixtures";
import TabHost from "../shared/TabHost";

export default function ConceptC_IntelligenceCaseFile({ fixture, state, onOpen, onCollapse, onResolve, resolveVerb }: ConceptProps) {
  const { isUnread, isExpanded, isResolved } = state;
  const category = CATEGORY_OF[fixture.lifecycleState];
  const whenRelative = fixture.conversation
    ? relativeFromISO(fixture.conversation.receivedAtISO)
    : (fixture.activity[fixture.activity.length - 1]?.at ?? "");

  return (
    <article
      className={`cc ${isUnread ? "cc--unread" : "cc--read"} ${isResolved ? "cc--resolved" : ""}`}
      data-testid={`concept-c-${fixture.id}`}
      data-unread={isUnread ? "true" : "false"}
      data-expanded={isExpanded ? "true" : "false"}
      data-resolved={isResolved ? "true" : "false"}
    >
      <button
        type="button"
        className="cc__surface"
        onClick={() => (isExpanded ? onCollapse() : onOpen())}
        aria-expanded={isExpanded}
        data-card-open="c"
        data-testid="card-primary"
      >
        <header className="cc__head">
          <div>
            <p className="cc__case-h">Case · {caseType(fixture)}</p>
            <h3 className="cc__title">{fixture.intelligence.spectreFound}</h3>
          </div>
          <div className="cc__head-meta">
            <span className={`cc__status cc__status--${category}`}>{labelForState(fixture.lifecycleState, fixture.judgmentRequired)}</span>
            <time className="cc__when">{whenRelative}</time>
          </div>
        </header>

        <dl className="cc__grid">
          <div>
            <dt>Entity</dt>
            <dd>
              {fixture.entity.name}
              <span className="cc__entity-sub">{fixture.entity.contextLine}</span>
            </dd>
          </div>
          <div>
            <dt>Evidence</dt>
            <dd>{evidenceLine(fixture)}</dd>
          </div>
          {fixture.intelligence.issue ? (
            <div className="cc__grid-issue">
              <dt>Open question</dt>
              <dd>{fixture.intelligence.issue}</dd>
            </div>
          ) : null}
          <div>
            <dt>Confidence</dt>
            <dd className={`cc__conf cc__conf--${fixture.intelligence.confidence}`}>{fixture.intelligence.confidence}</dd>
          </div>
          <div>
            <dt>Recommended action</dt>
            <dd className="cc__rec">{fixture.intelligence.recommendedAction}</dd>
          </div>
        </dl>
      </button>

      {isExpanded ? (
        <div className="cc__expanded">
          <div className="cc__resolve-row">
            <button type="button" className="cc__resolve" onClick={onResolve} data-testid="resolve">
              {resolveVerb}
            </button>
          </div>
          <TabHost fixture={fixture} defaultTab={fixture.availableTabs.includes("invoice") ? "invoice" : fixture.availableTabs[0]} />
        </div>
      ) : null}
      <CcCss />
    </article>
  );
}

function caseType(f: any): string {
  if (f.invoice) return "AP invoice review";
  if (f.entity.type === "member") return "Member matter";
  if (f.entity.type === "employee") return "Operational matter";
  return "Correspondence review";
}
function evidenceLine(f: any): string {
  const bits: string[] = [];
  if (f.conversation) bits.push(`1 email from ${f.conversation.from}`);
  if (f.attachments.length) {
    bits.push(`${f.attachments.length} attachment${f.attachments.length === 1 ? "" : "s"} (${f.attachments.map((a: any) => formatBytes(a.byteLength)).join(", ")})`);
  }
  if (f.invoice?.findings?.length) bits.push(`${f.invoice.findings.length} analyser finding${f.invoice.findings.length === 1 ? "" : "s"}`);
  if (bits.length === 0) bits.push("System-generated signal");
  return bits.join(" · ");
}
function labelForState(state: string, judgment: boolean): string {
  if (state === "RESOLVED") return "Case closed";
  if (state === "DEFERRED") return "On hold";
  if (state === "INFORMATIONAL") return "Informational";
  if (judgment) return "Awaiting decision";
  return "Open";
}

function CcCss() {
  return (
    <style dangerouslySetInnerHTML={{ __html: `
      .cc { background: #fdfaf1; border: 1px solid #ede6d3; border-radius: 4px; overflow: hidden; }
      .cc--unread { border-color: #2f4739; }
      .cc--resolved { opacity: 0.6; }
      .cc__surface { width: 100%; padding: 14px 16px; border: 0; background: transparent; text-align: left; cursor: pointer; font: inherit; display: block; }
      .cc__surface:hover { background: rgba(0,0,0,0.02); }
      .cc__head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 10px; }
      .cc__case-h { margin: 0; font-size: 10px; letter-spacing: 1.4px; text-transform: uppercase; color: #8a7f6a; font-weight: 700; }
      .cc__title { margin: 4px 0 0; font: 400 15px/1.35 "Iowan Old Style", Georgia, serif; }
      .cc--unread .cc__title { font-weight: 600; }
      .cc__head-meta { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
      .cc__status { font-size: 10px; text-transform: uppercase; letter-spacing: 0.7px; padding: 2px 6px; border-radius: 2px; }
      .cc__status--active { background: #f4ecc9; color: #7a601f; }
      .cc__status--terminal { background: #e6e2d8; color: #635a4a; }
      .cc__status--informational { background: #e6e2d8; color: #635a4a; }
      .cc__when { font-size: 11px; color: #8a7f6a; font-variant-numeric: tabular-nums; }

      .cc__grid { display: grid; grid-template-columns: max-content 1fr; row-gap: 6px; column-gap: 14px; margin: 0; }
      .cc__grid > div { display: contents; }
      .cc__grid dt { font-size: 10px; text-transform: uppercase; letter-spacing: 1.1px; color: #8a7f6a; font-weight: 600; padding-top: 2px; }
      .cc__grid dd { margin: 0; font-size: 13px; color: #2b2b2b; line-height: 1.4; }
      .cc__entity-sub { display: block; font-size: 11px; color: #8a7f6a; margin-top: 1px; }
      .cc__grid-issue dd { color: #8a4227; }
      .cc__conf { text-transform: uppercase; font-weight: 700; font-size: 12px; letter-spacing: 0.6px; }
      .cc__conf--high { color: #2f4739; }
      .cc__conf--medium { color: #7a601f; }
      .cc__conf--low, .cc__conf--unresolved { color: #8a4227; }
      .cc__rec { font-weight: 500; }

      .cc__expanded { padding: 8px 16px 14px; border-top: 1px solid #ede6d3; background: #fefcf5; }
      .cc__resolve-row { display: flex; justify-content: flex-end; margin-bottom: 4px; }
      .cc__resolve { border: 1px solid #2f4739; background: #2f4739; color: #fdfaf1; padding: 6px 14px; border-radius: 4px; font-size: 12px; cursor: pointer; }
    ` }} />
  );
}
