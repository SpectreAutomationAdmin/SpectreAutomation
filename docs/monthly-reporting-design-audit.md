# Monthly Reporting Page — Executive Design Audit

**Target:** `/app/admin/reporting/monthly`
**Source file:** [src/app/app/admin/reporting/monthly/page.tsx](../src/app/app/admin/reporting/monthly/page.tsx)
**Service:** [src/lib/reporting/monthly-package.ts](../src/lib/reporting/monthly-package.ts)
**Standard:** [.claude/skills/executive-reporting-design/SKILL.md](../.claude/skills/executive-reporting-design/SKILL.md)
**Reference comp:** Saguaro / sample-club.netlify.app — private-club board package style; Deloitte/KPMG monthly finance package style

**Audit mode:** read-only. No code changes. The output is the
prioritized deficiency list that a redesign pass will work from.

---

## TL;DR

The page is **structurally complete** but **stylistically wrong**.
It correctly enumerates every section a finance committee expects
(executive summary → board briefing → visual summary → operating
stewardship → capital stewardship → financial statements →
operations → payroll → F&B). The data shape is right. The
problems are entirely in *feel*: the page reads as a competent
admin dashboard, not as a board package. A finance committee
member shown this page would assume they are looking at an
internal management tool, not the document prepared for them.

If we apply the squint test from the design standard: **the page
does not pass.** It looks like a Spectre admin module. It does
not look like a Deloitte / KPMG / private-club board package.

---

## Dimension-by-dimension comparison

### 1. Page shell

| Dimension | Saguaro / board package standard | Current Spectre page |
|---|---|---|
| Outer chrome | Quiet / receded. The report dominates ≥ 80% of viewport. | Loud. Admin sidebar (~220px) + TopBar + page-level left rail = ~30% of viewport is non-report chrome. |
| Container | Wide reading column with controlled whitespace on all sides. Often a centered max-width. | Edge-to-edge grid that fills the admin content area. No reading column discipline. |
| Visual hierarchy | "You are reading a document hosted in an app." | "You are using an app that happens to contain a document." |

### 2. Sidebar / admin chrome

| Dimension | Standard | Current |
|---|---|---|
| Admin sidebar | Should fade visually on reporting routes — softer borders, lighter background, possibly collapsed by default. | Full-strength admin sidebar with permission-gated section list. Identical to every other admin route. |
| TopBar | Should disappear or compress on the reporting route. | Same TopBar with club/user controls, no special treatment. |
| In-page section nav | If present, should read as a print TOC: serif, indented, restrained. | Tailwind-default rounded card with small grey labels — reads as an admin sub-nav. |

### 3. Typography

| Dimension | Standard | Current |
|---|---|---|
| Page title | Serif, large, weighted as a *club document* title (e.g. `font-serif text-4xl` minimum, possibly text-5xl). | `font-serif text-3xl` — too small to feel like a board document; reads as an admin page heading. |
| Eyebrows | Used selectively. Section eyebrows in small caps. | Eyebrows applied uniformly to every section (`Eyebrow + Title` pattern) — feels SaaS-templated. |
| KPI numbers | Serif, generous size, set as *values*, not stats. | Serif `text-3xl` — close, but cards are too small for the numbers to read as primary content. |
| Body copy | `text-stone-700` or darker, generous leading. | `text-stone-700` ✓ but no explicit `leading-relaxed` — paragraphs read tight. |
| Mono usage | Numbers in financial tables only. | Correct ✓ — but the page over-uses `font-mono` for tiny chip values, which reads as developer dashboard. |
| Tabular figures | Numbers should use `font-variant-numeric: tabular-nums` so columns align. | Not set anywhere — columns of dollar figures don't visually align across rows. |
| Headline font | Should consider a true editorial serif (Caslon / Garamond / Tiempos style). | Uses the project default Georgia stack — readable but generic, not "premium". |

### 4. Spacing

| Dimension | Standard | Current |
|---|---|---|
| Section gap | `mt-10` minimum, ideally larger between major sections on a board doc. | `mt-10` between sections ✓ but feels uniform — every section is given equal visual breathing room. |
| Card padding | Generous (`p-6` or `p-8`). | `p-5` on most cards, `p-4` on stewardship rows. Reads as admin density. |
| Horizontal rhythm | Reading column anchored; gutters expansive. | Edge-to-edge grid with `gap-3` / `gap-4` between cards — cards crowd each other. |
| Within-card whitespace | Headlines have air. Numbers breathe. | Tight. KPI cards stack title / number / subtitle with `mt-1`. Subtitle crowds the number. |
| Vertical density | Loose. A board page shows fewer items per screen. | High. Eight stewardship KPIs render in a 2-column grid — feels admin. |

### 5. Color

| Dimension | Standard | Current |
|---|---|---|
| Palette | Restrained — paper / ink / one accent + tone semantics. | Uses club-green + amber + red + neutral palette. Correct semantically, but applied with admin frequency (status chips on nearly every block). |
| Backgrounds | Mostly off-white / cream; cards on white; nothing tints. | Mostly white-on-white. Loses the "premium paper" feel a board doc has. The page sits on stone background but cards don't read as distinct paper. |
| Status chips | Used sparingly — major signals only. | Used liberally — every section has a Demo / Live chip + many internal tone chips. Visual noise. |
| Borders | Hairline, low contrast. | `border-stone-200` ✓ but every card has one — borders accumulate and look like an admin grid. |
| Accent colors | One accent thread connecting the document. | Three accent strokes (green, amber, brown) used per chart — feels arbitrary not editorial. |

### 6. KPI hierarchy

| Dimension | Standard | Current |
|---|---|---|
| Headline KPIs | 3-to-6 hero cards, generously sized, dominate the executive section. | Six KPIs render in a `lg:grid-cols-3` (or 2 on smaller). Each is a small left-accent card. Not dominant. |
| Card size | Large enough that the number is the page's primary visual element. | KPI numbers compete with body copy at the same vertical level. |
| Comparator placement | Comparator (vs budget / vs PY) belongs adjacent to the number, possibly inline. | Comparator is in a small grey subtitle below the number. Reads as a SaaS subtitle. |
| So-what narration | Each KPI should have a sentence of implication. | Subtitle is mechanical ("vs $14.10M budget · +3.7%"); no interpretive sentence. |
| Tone signal | One tone per KPI; restrained. | Tone left-border accent ✓ but combined with green/amber chip text + arrow phrasing — overwrought. |

### 7. Narrative prominence

| Dimension | Standard | Current |
|---|---|---|
| Opening narrative | A 1–2 sentence editorial headline that lets the reader skip the rest. | Present (`pkg.executiveSummary.headline`) ✓ — but rendered at `text-sm`, same size as body copy. Lost. |
| Per-section narrative | Every section opens with prose. | Only Executive Summary, Board Briefing, and Visual Summary have prose. Stewardship blocks, financial statements, operations, payroll, F&B all jump straight to data with at most a one-line description. |
| Board briefing cards | Each card carries a sentence that frames the metric chips. | ✓ — this is the closest section to right. But narrative font size is `text-sm` and reads as an admin tooltip. |
| Statements introduction | Even a statement section should be introduced ("Revenue ran ahead of plan; expense discipline held"). | Header strip only — table jumps in cold. |
| Footer "what's next" | A board pack often closes with management commentary or a "next month's focus". | Footer is metadata only (period, prepared date, demo/live legend). No editorial close. |

### 8. Executive feel

| Dimension | Standard | Current |
|---|---|---|
| Document identity | Should read like a *named* document (e.g. *"Silver Springs Golf & Country Club — Finance Committee Monthly Package, May 2026"*). | Header says `Monthly Board Reporting Package` (eyebrow) + club name. Closer to a SaaS page title than a document cover. |
| Cover page | Often a discrete cover panel: club crest / wordmark, period in serif, prepared-for line. | No cover. Header strip with KPI cards immediately below. |
| Prepared-by attribution | Standard at top or bottom of the package. | Has "Prepared for Finance Committee · Board of Directors" but no preparer attribution (CFO, controller). |
| Signature / sign-off space | Some packages leave room for management signature. | Absent. |
| Page numbering / section numbering | Print convention. | None. |
| Sidebar nav copy | Should read as a TOC: "Section 1. Executive Summary" / serif / restrained. | Renders as `Executive Summary` in sans, hover background — admin sidebar pattern. |

### 9. Board readiness

| Dimension | Standard | Current |
|---|---|---|
| Print test | `Cmd+P` produces a board-pack PDF. | Print would produce an admin screenshot — sidebar + TopBar + cards. Fails. |
| Demo/Live mixing | If any section is demo, it is honestly labelled and the reader knows. | ✓ Demo / Live chips are honest. Good. |
| Export controls | Disabled with honest reason copy when renderer is missing. | ✓ Done. Good. |
| Tone consistency | Numbers, narrative, headlines all sound like one author. | Headline copy is editorial; KPI subtitles are mechanical; chip copy is terse. Three voices. |
| Page balance | The reader can hand the printout to a board chair without edits. | The reader would print, then re-build in a Word template. The page is not the artifact. |

### 10. Private-club specificity

| Dimension | Standard | Current |
|---|---|---|
| Vocabulary | Dues subsidy, initiation fee operating subsidy, NOI before depreciation, F&B subsidy of dues, capital reserve coverage, etc. | ✓ Present in the KPI labels and the service. Vocabulary is correct. |
| Club rituals | Headers, seal/wordmark, "Prepared for the Finance Committee", fiscal year convention (Jul-Jun). | Fiscal year label ✓ ; "Prepared for Finance Committee" ✓ ; no club seal/wordmark. |
| Member-facing tone | Even the management language reflects "stewardship" framing. | Uses "Stewardship" sectioning ✓ — best part of the page. |
| Anti-SaaS check | No DAU/MAU/churn/NPS/retention. | ✓ Passes. |
| Club-specific narrative | "Member rounds are running 6% ahead of plan" — real club voice. | Present in `boardBriefing.operations.narrative` ✓ but buried at `text-sm` and not differentiated visually from any other body copy. |

---

## Top 20 deficiencies — prioritized for redesign

Ordered by impact on the squint test (1 = biggest betrayal of the
board-package feel; 20 = smallest).

| # | Severity | Deficiency | Why it fails the standard |
|---|---|---|---|
| 1 | Critical | The admin sidebar + TopBar render at full strength alongside the report. | The page is a *report*; the chrome should fade. Right now ~30% of the viewport is non-report admin chrome. Standard says the report should dominate ≥ 80% of the viewport. |
| 2 | Critical | No cover panel or "document identity" treatment. The page opens with a header strip immediately followed by a KPI grid. | A board package opens with a cover: club identity / period / prepared-for. Without it, the page reads as a dashboard, not a document. |
| 3 | Critical | Page title is `font-serif text-3xl` — too small. The club name does not read as the title of a club document. | Board documents lead with a *prominent* document title. The current title is sized like an admin page heading. |
| 4 | Critical | Edge-to-edge content fills the admin content area; no reading column / max-width discipline. | Premium documents have controlled measure (≤ ~960px reading width). Our page sprawls. |
| 5 | High | KPI cards are too small and too packed (`lg:grid-cols-3`). The numbers do not dominate. | In a board package, the headline KPIs are *the* visual moment of the executive summary. Right now they read as a stats grid. |
| 6 | High | Card padding is `p-5` (`p-4` in some places). Reads as admin density. | Standard calls for `p-6` minimum on board-style cards, with hero KPIs closer to `p-8`. |
| 7 | High | Tight `gap-3` / `gap-4` between cards in every grid. Cards crowd each other. | Whitespace between cards should feel intentional. Right now it feels economical. |
| 8 | High | No tabular-figure numeric alignment (`font-variant-numeric: tabular-nums`). Dollar columns in statement tables don't align visually. | A financial statement that doesn't align dollar columns reads as scaffolded, not engraved. |
| 9 | High | Body copy and headlines render at the same `text-sm` size, so the editorial narrative does not dominate over the tables. | Standard rule: narrative comes before tables. Right now narrative is *adjacent to* tables, same weight. |
| 10 | High | Executive headline (`pkg.executiveSummary.headline`) renders at `text-sm` — invisible relative to the KPI grid. | This is the most important sentence on the page. It should be `text-lg` italic serif at minimum. |
| 11 | High | "Demo data" chips appear on nearly every section. Visual noise. | Honest sourcing ✓ — but the chip pattern is repeated so often it becomes admin grid styling. Should be footnoted once or grouped, not stamped on every card. |
| 12 | Medium | Eyebrow + Title pattern is applied uniformly to every section. Reads as SaaS-templated. | An editorial document varies its section openers (lead paragraph / pullquote / numbered heading). The same `Eyebrow + Title` block repeating 9× is monotonous. |
| 13 | Medium | Status tone chips overused — every project row, every briefing card, every KPI. | Chips are loud. Standard says use sparingly; reserve for board-relevant escalation. |
| 14 | Medium | Page-level left rail looks like an admin sub-nav (rounded card, sans labels, hover background). | Should look like a print TOC (serif, indented, restrained, no hover state if not interactive). |
| 15 | Medium | No section numbering (`I. Executive Summary`, `II. Board Briefing` …). | Print convention. Helps the reader find their place; also reinforces document-ness. |
| 16 | Medium | Sparklines are inline SVG with one axis label at the start, middle, and end. They read as widget chrome, not editorial charts. | Editorial charts have y-axis labels, a single value annotation at the latest point, and a caption explaining the slope. |
| 17 | Medium | Stewardship KPI rows render in a 2-column grid with status dot + name + actual / budget / benchmark inline. Reads as a metrics list. | Should read as a *scorecard* — single column, ample whitespace, possibly numbered, with explanatory sentence breaking onto its own line. |
| 18 | Medium | No editorial closing (management commentary, "next month's focus"). | Board packages usually close with management's forward-look. We end on metadata. |
| 19 | Low | Default Georgia serif stack — fine, but generic. | A premium board package uses a distinctive editorial serif (Caslon / Tiempos / GT Sectra style). The Georgia fallback is "competent", not "expensive". |
| 20 | Low | No club seal / monogram / wordmark in the header. | Real private clubs reference their identity at the top of the document. The current page renders the club name in text only. |

---

## What is already right (do not regress)

So the redesign pass doesn't accidentally undo good work:

- **Vocabulary is correct.** All KPI names are private-club specific
  (dues subsidy, initiation fee operating subsidy, NOI before
  depreciation, F&B covers, capital reserve coverage). No SaaS-isms
  to scrub.
- **Section coverage matches a real board pack.** Executive summary,
  board briefing, visual summary, operating + capital stewardship,
  five financial statements, operations stats, payroll, F&B.
  Structure-as-built is what a Saguaro-style pack contains.
- **Honest demo/live labelling.** Every section declares its source.
  Export controls are disabled with honest copy. This is the
  hardest cultural part to get right and we have it.
- **Fiscal-year convention is correct.** `FY2026 (Jul-Jun)` and the
  "11 months elapsed" framing are accurate for a private club's
  fiscal calendar.
- **The board-briefing narrative cards are conceptually right.**
  Operations / Financial Health / Capital Program with status +
  narrative + supporting chips — this matches Saguaro. It just
  needs the typography upgrade.
- **The page builds and renders.** CSS is healthy after the
  baseline restore. No infrastructure work to redo.
- **Permission gating is correct** (`reports:board` after the seed
  fix). Board roles can land here; lower roles are redirected.

---

## What a redesign pass should *not* do

- Do not change the underlying data shape of
  `MonthlyReportingPackage`. The interface is fine.
- Do not add new KPIs or remove existing ones. The set matches the
  spec.
- Do not change permission gating.
- Do not re-introduce SaaS dashboard idioms while "modernizing":
  no full-tile colour fills, no growth-arrow emojis, no
  date-range toggles on a *monthly* package.
- Do not break the demo/live source chips entirely while quieting
  them — replace with a single consolidated source legend.

---

## Suggested redesign approach (for the eventual fix step)

A redesign pass will probably need to:

1. Introduce a "reporting layout" wrapper that hides or compresses
   the admin sidebar + TopBar while on `/app/admin/reporting/**`.
2. Add a cover panel before any KPIs.
3. Upgrade typography: scale all section headings up, distinguish
   narrative copy from supporting copy, add `tabular-nums`.
4. Re-think the executive KPI grid as a two-column "hero numbers"
   layout, larger, with comparator inline.
5. Replace the page-level left rail with a quiet serif TOC styled
   as a document index.
6. Consolidate Demo/Live source declarations into a single legend.
7. Add an editorial closing block (management commentary).
8. Upgrade the sparklines to editorial charts with value
   annotations.

But none of this happens in this audit step. The audit's only
deliverable is this document.

---

## Verdict

The page is a **correct admin module** masquerading as a **board
package**. The data is right; the chrome and typography are not.
A redesign focused on (a) hiding admin chrome, (b) upgrading
typography and whitespace, (c) elevating narrative over tables,
and (d) introducing document conventions (cover, section numbers,
editorial close) would move this from "admin dashboard for the
finance committee" to "board package that happens to be served
by an app".

Estimated work: a single focused redesign pass — the underlying
data shape, sections, and vocabulary do not need to change.

**End of audit. No code modified.**
