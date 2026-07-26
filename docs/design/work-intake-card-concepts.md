# Work Intake Card — Concept Exploration

**Status**: Draft · founder concept review pending
**Sprint**: 3, Checkpoint 15I
**Related**:
- [docs/design/workflow-surface-state-model.md](./workflow-surface-state-model.md) — the canonical 15-state lifecycle every workflow item traverses (governs which state names the concepts use)
- [docs/design/workflow-surface-foundation.md](./workflow-surface-foundation.md) — parent workflow spec
- [docs/adr/0001-work-intake-origin-architecture.md](../adr/0001-work-intake-origin-architecture.md) — WorkIntakeItem is source-neutral; orchestration state lives on the canonical row; origins live in link tables. Concepts must respect this.

## 1 · Product problem this checkpoint solves

The current Mission Control Work Intake card conflates five personas in one surface: email viewer, AP review screen, operational intelligence briefing, task card, permanent record. Five things reading with equal weight makes none of them scannable in five seconds.

A card also has no way to leave the queue. Items pile up. Work Intake is meant to be a *queue* — a transient list of unresolved work — not the permanent archive. The archive belongs to the entity's timeline.

## 2 · Non-goals for this checkpoint

- Not replacing the production card.
- Not writing schema migrations.
- Not building the full entity timeline UX.
- Not deploying anything.
- Not selecting the winning concept — that is the founder's decision after localhost review.

## 3 · Shared interaction contract (all concepts implement this)

| Behaviour | Contract |
|---|---|
| **Unread hierarchy** | Bolder title/summary weight, optional small unread dot, optional stronger left rail. No prominent "UNREAD" pill. |
| **Read on open** | Clicking the card's primary surface both marks-read AND expands. Read state persists across refresh + session. Merely loading the feed does NOT mark cards read. |
| **Per-user read state** | Read state is per-user, not global — two admins working the same queue see their own unread counts. (New table proposed: `WorkIntakeItemRead`.) |
| **Card is the CTA** | No redundant collapsed-state buttons (Open Review / View PDF / View Email / Reply are removed). Actions live inside the relevant expanded tab. |
| **Contextual tabs** | Only tabs relevant to the item render. A non-AP item does NOT show an empty Invoice Review tab. |
| **Resolve = state transition, not delete** | Completing the item transitions its lifecycle state (per `workflow-surface-state-model.md`) so it leaves the active feed. The underlying email, document, extraction, findings, evidence, and activity rows are preserved. The item continues to appear on the associated entity's permanent timeline. A history/completed filter surfaces resolved items. |
| **Entity link** | Every card shows its linked entity (Vendor / Member / Employee / Contact / Committee / Project) with a small affordance toward the entity's timeline. |
| **Intelligence hierarchy** | Every card separates: source facts · Spectre's interpretation · confidence/uncertainty · risk or consequence · recommended next action. Source facts and AI conclusions are visually distinguishable. |

Every concept below embodies this shared contract — they differ in **how** they surface the same information, not **whether**.

## 4 · Concept theses

Each concept is a bet on a different mental model for "what is this card asking me to do?" The goal of the concept review is to find the model that reads fastest and most honestly for the founder's actual queue.

### Concept A — Correspondence Queue
**Thesis**: Volume comes first. The founder sees ten items across two clubs before breakfast; if each one is a full briefing block, she'll scan the top three and archive-bomb the rest. Treat the queue like a premium inbox — dense collapsed rows, real hierarchy on hover/read state, and a single scannable intelligence summary. Expansion is where depth lives.

**Tests**: Does information density beat individual card depth for a founder-scale queue?

**Distinguishing traits**: Single-row collapsed height. Sender · subject · one-line Spectre synopsis · status chip · timestamp. Reads left-to-right like an inbox but the "subject" is Spectre's operational summary, not the raw email subject.

### Concept B — Executive Briefing
**Thesis**: The founder does not want to read email; she wants to know what is happening and what to decide. Lead with Spectre's conclusion. The source (email / attachment) is background evidence, referenced but not front and centre.

**Tests**: Does verdict-first framing let the founder skip past mechanically routine items faster and focus her judgment on the ones that need it?

**Distinguishing traits**: Card title IS Spectre's operational statement ("Microsoft invoice — vendor not on file"). Subtitle is the recommended action. A `Why it matters` line sits above the fold. Sender/attachment/timestamp are in a discreet metadata strip below.

### Concept C — Intelligence Case File
**Thesis**: For items where Spectre reached a real conclusion with real evidence, treat the card as a case with structure. Section labels — Case type · Status · Evidence · Findings · Confidence · Open question · Recommended action — make Spectre's reasoning legible, and the founder can audit it before acting.

**Tests**: Does explicit structure raise trust in AI conclusions, or does the labelling feel bureaucratic?

**Distinguishing traits**: Named sections stack vertically. Confidence rendered as a discrete word (`High`, `Medium`, `Low unresolved question`), not as a percentage bar. Evidence rows are linked, not free-text. No detective / dossier styling — same Spectre chrome as everything else.

### Concept D — Decision Sentence (Claude-designed)
**Thesis**: Every card should reduce to a single sentence starting with the verb the founder needs to perform. If the card cannot be reduced to one sentence, the item does not belong on Mission Control — it belongs on a background analyst queue. The rest of the card is the receipts.

Formally: `<verb> <object> <so-that clause>` — for example, `"Match Microsoft Corporation to a Spectre vendor so this invoice can proceed to AP."` The receipts sit below in a compact evidence strip.

**Tests**: Does forcing every item into an action-first sentence surface which items lack a clear next step (i.e. surface bad classifications)? And does the founder read faster when every card looks like a to-do list rather than a briefing?

**Distinguishing traits**: One sentence at the top, ~18–20pt serif — the action itself. Underneath: a two-line receipts strip (`Received via email from Chris Turcato · Attachment: 93458725404.pdf · Extracted vendor: Microsoft Corporation`). Confidence is implicit in whether the sentence has a subject at all — if Spectre can't recommend, the card says `"Review this invoice — Spectre could not classify it"`, still one sentence.

### Concept E — Timeline Anchor (Claude-designed)
**Thesis**: A work intake item read out of context is a false alarm. This invoice from Microsoft — is it their 42nd this year (business as usual), or their first (unusual)? Whose invoices normally look like this? The card's most useful frame isn't its own content — it's where it sits in the entity's history. Anchor the card to the entity, and let the entity's recent activity be the primary context strip.

**Tests**: Does entity-first framing help the founder tell "expected" from "unexpected" work more quickly? And does knowing the entity's history change the recommended action from "review" to "auto-approve like the last 41"?

**Distinguishing traits**: Card is split. Left column (2/3 width) is the intake item — compressed to its essentials. Right column (1/3 width) is a mini-timeline of the entity: last 5 events, "Vendor since 2017", "Open invoices: 1", "Last payment: Jul 3". A small `See full timeline →` affordance jumps to the entity's dedicated timeline surface. When the entity is unresolved (Microsoft, not yet matched to a Spectre vendor record), the right column shows a "Match this vendor" callout instead — turning the entity gap into the primary CTA.

## 5 · Shared visual standards

- Same Spectre chrome: `card`, `Badge`, `btn-primary/secondary/sm`, `table-base`.
- Ivory canvas, deep-green primary, muted-gold accents. No neon. No emojis. No dark-mode dependency.
- Confidence is a word, never a percentage bar or a coloured meter.
- The read/unread distinction is typographic (weight + subtle rail), not a coloured badge.
- Timestamp is relative (`3h ago`) with the absolute date as a hover title.
- All concepts render the same fixture set (see §6) so the founder can compare like-for-like.

## 6 · Fixtures each concept renders

| # | Scenario | Purpose |
|---|---|---|
| 1 | Microsoft invoice (Chris Turcato sender, `93458725404.pdf`, vendor not matched) | Distinguish sender from extracted vendor; unresolved vendor-record match |
| 2 | Member matter (non-AP) | Prove contextual tabs — no Invoice Review shown |
| 3 | Employee / operational matter | Different entity type, different recommended action shape |
| 4 | Resolved / completed | Read-state + completed-view behaviour |
| 5 | Uncertain classification | Spectre-honest presentation of low confidence |

## 7 · What the concepts do NOT test in this checkpoint

- Real DB-backed read state (fixtures use React state).
- Real state-machine transitions (fixtures use React state; the production transition path is `workflow-surface-state-model.md` §3 territory).
- Full entity timeline surface (concepts show the *link*; the timeline surface itself is a later checkpoint).
- Multi-user race conditions on read state (out of scope for concept review).
- Keyboard-only navigation *of the resolve flow* (basic keyboard support on card open/close/tab-switch IS tested).

## 8 · Selection criteria the founder will apply

- Five-second comprehension of "what is this asking me?"
- Clarity of Spectre's conclusion vs. source fact vs. uncertainty
- Read/unread distinction without visual noise
- Contextual tab correctness
- Confidence that "Resolve" is safe (i.e. the underlying data is preserved)
- Consistency with Spectre's premium/restrained visual language
- Fit with a real founder queue of ~10–30 items per morning

## 9 · Path from selected concept to production (out of scope for this checkpoint — captured for context)

Once the founder selects a concept:

1. Add `WorkIntakeItemRead(workIntakeItemId, userId, readAt)` table + Prisma migration (staging + local).
2. Extend the mission-control loader to project per-user read state.
3. Replace `EmailIntakeCard.tsx` with the selected concept's component.
4. Wire the resolve action to the appropriate state transition per `workflow-surface-state-model.md` §3.
5. Ship the entity-timeline read surface for the entity types the concept links to.
6. Deploy behind a feature flag; A/B against the current card; retire the old card.

None of the above happens in the concept-review checkpoint.
