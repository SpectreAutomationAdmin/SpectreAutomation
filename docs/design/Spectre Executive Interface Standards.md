# Spectre Design Language v1.0
## Executive Interface Standards

**Status:** Locked until Version 2.0

This document defines the visual language for every screen in Spectre. These are implementation rules, not suggestions. Every interface must be evaluated against these standards before being considered complete.

It composes with — and does not restate — the two other locked design authorities:

- **[Spectre Design Language.md](Spectre%20Design%20Language.md)** — the token layer (colour hex, typography scale, spacing scale, radius, shadow, motion durations, theme system).
- **[Spectre Product Language.md](Spectre%20Product%20Language.md)** — the information layer (grammar, attention model, action grammar, canonical status vocabulary).

This document sits at the executive-standards layer above both. When any of the three conflict, this one wins for aesthetic / voice / evaluation decisions; the token doc wins for pixel-level values; the product doc wins for grammar and workflow rules.

---

## 1. Core Principle

Spectre is not a SaaS application.

Spectre is an executive operating system.

The interface should feel engineered rather than designed.

Users should feel:

- calm
- competent
- informed
- in control

They should never feel entertained.

---

## 2. Design DNA

Every screen should communicate four qualities.

### Calm

- No visual noise.
- No unnecessary decoration.
- No competing focal points.

### Confidence

- Information appears intentional.
- Layouts feel balanced.
- Nothing feels experimental.

### Precision

- Everything aligns.
- Everything has rhythm.
- Nothing feels approximate.

### Momentum

The interface always answers:

**What should I do next?**

---

## 3. Information Hierarchy

Every page contains **exactly one** dominant focal point.

Hierarchy:

1. Executive Focus
2. Primary Workspace
3. Supporting Information
4. Navigation
5. Utilities

If two regions compete equally for attention, redesign the page.

---

## 4. Typography

Typography creates hierarchy. **Borders never create hierarchy.**

### Greeting

- Largest text.
- Warm.
- Confident.
- Not oversized.

### Section Titles

- Uppercase or small caps.
- Wide tracking.
- Muted.

### Financial Values

- Use tabular numerals.
- Always align vertically.
- Never bold everything.
- Bold only significant figures.

### Supporting Text

- Quiet.
- Readable.
- Never light grey on white.
- Maintain accessibility.

### Body Copy

- 65–80 characters per line.
- Comfortable line height.
- Readable at a glance.

---

## 5. Layout

Spectre uses architecture. **Not cards.**

Pages consist of workspaces. Workspaces contain content. Cards are only used when content is genuinely independent. Avoid grids of disconnected widgets.

### Internal padding

- 32 px default.
- Never below 24 px.

### Vertical rhythm

- Consistent spacing throughout.
- Avoid compressed layouts.
- Whitespace communicates importance.

### Width

- Maximum content width approximately 1500 px.
- Very large monitors should breathe.

---

## 6. Colour Philosophy

Colour communicates meaning. **Never decoration.**

### Neutral

- 95 % of the interface.
- Backgrounds.
- Typography.
- Dividers.
- Navigation.

### Green

- Means confidence.
- Approval.
- Healthy state.
- Never branding.
- Never decorative.

### Amber

- Means observation required.
- Not danger.

### Red

- Reserved for genuine problems.
- Must be rare.

### Gold

- Reserved exclusively for achievement.
- Completion.
- Milestones.
- Board publication.
- Never routine buttons.

---

## 7. Surfaces

Avoid obvious white rectangles floating everywhere.

Instead:

- Create subtle layers.
- Workspaces emerge naturally from the background.
- Borders should almost disappear.
- Elevation should be extremely restrained.

---

## 8. Borders

Avoid heavy borders. Prefer:

- spacing
- alignment
- typography
- surface contrast

Only use borders where necessary.

---

## 9. Shadows

Minimal. Almost invisible.

Spectre should not resemble Material Design.

Shadows communicate depth. Not decoration.

---

## 10. Corners

- Moderately rounded.
- Never exaggerated.
- Not sharp.
- Consistent across every component.

---

## 11. Navigation

Navigation is framing. **Not content.**

- Reduce contrast.
- Reduce weight.
- Reduce attention.
- The page should dominate.

### Icons

- Never emoji.
- Never colourful.
- Never playful.
- Use one consistent icon family.
- Thin strokes.
- Optically aligned.
- Monochrome.

---

## 12. Motion

Everything moves with purpose.

Animation exists only when explaining:

- arrival
- transition
- completion
- state change

Never animate for entertainment.

### Duration

- 200–300 ms.
- Never bounce.
- Never overshoot.
- Never spring dramatically.
- Movement should glide.

---

## 13. AI Behaviour

AI never interrupts. Never opens chat bubbles. Never blocks work.

AI appears as:

- observations
- recommendations
- prepared work
- drafts
- summaries

The user should feel:

**Spectre has already done the thinking.**

---

## 14. Workspaces

Every workspace answers:

- What happened?
- Why?
- What should I do?

No workspace should merely display information.

---

## 15. Empty States

Never say:

> "No invoices."

Instead:

> Excellent. Your invoice queue is clear.

Use positive language. Celebrate progress quietly.

---

## 16. Tables

Tables are professional tools.

- Avoid excessive zebra striping.
- Avoid dense borders.
- Increase row height.
- Improve readability.

Financial software should not resemble Excel.

---

## 17. Forms

- Reduce visible fields.
- Group related information.
- Progressive disclosure.
- Never overwhelm.

---

## 18. Dashboard Rule

Mission Control is **NOT** a dashboard.

Never use:

- random KPI cards
- decorative graphs
- meaningless widgets

Everything displayed must help someone decide something.

---

## 19. Executive Rule

Every screen should elevate the user.

Before adding anything, ask:

> Does this help someone think? Or merely click?

If it merely creates work — remove it.

---

## 20. Spectre Identity Test

Before shipping any screen answer:

> Can this screen be mistaken for Asana · Monday · ClickUp · HubSpot · Atlassian · Salesforce?

If yes — it is not finished.

---

## 21. Apple Test

Remove the logo. Would Apple ship this layout?

If no:

- Simplify.
- Strengthen hierarchy.
- Improve typography.
- Reduce noise.

---

## 22. Porsche Test

Close your eyes. Imagine this screen as a dashboard inside a Porsche.

Would every control feel intentional?

If not:

- Remove something.
- Refine something.
- Improve alignment.

---

## 23. Augusta Test

Does this look expensive because it contains expensive things?

Or because every detail feels considered?

If the former — redesign.

---

## 24. Spectre Test

Every screen must answer **YES**.

- ✔ I know where to look first.
- ✔ I know what matters.
- ✔ I know what happens next.
- ✔ I trust this information.
- ✔ I feel more competent than thirty seconds ago.

If any answer is NO — the design is incomplete.

---

## Forbidden Patterns

Claude Code must avoid these patterns unless explicitly instructed otherwise.

- ❌ Emoji icons
- ❌ Generic KPI card dashboards
- ❌ Thick borders
- ❌ Material Design shadows
- ❌ Colourful icons
- ❌ Random accent colours
- ❌ Excessive rounded corners
- ❌ Widget overload
- ❌ Equal visual weight everywhere
- ❌ Dense toolbars
- ❌ Floating action buttons
- ❌ Empty whitespace without purpose
- ❌ Decorative gradients
- ❌ Generic SaaS hero headers
- ❌ "Welcome back" marketing copy
- ❌ Generic Figma community aesthetics

---

## Final Principle

Spectre should feel like **Bloomberg redesigned by Apple for executives who run private clubs**.

Not because it is minimalist.

Not because it is luxurious.

Because every pixel demonstrates respect for the professional using it.
