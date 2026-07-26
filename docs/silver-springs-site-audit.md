# Silver Springs Golf & Country Club — Site Audit

Reference: https://www.silverspringsgolfclub.com/

This audit is the basis for the white-label public website we render at
`http://silver-springs.localtest.me:3000`. We do **not** scrape, hotlink, or
mirror copyrighted assets — every visual element is reproduced from scratch
using local tokens and original draft copy in the same tone.

## Corrections to the first version of this audit

The first version of this doc was written from the content notes in the
task prompt rather than from actually fetching the live site. After
inspecting the home page:

- **There is a 6-slide hero carousel**, not the static hero originally
  documented. Auto-advance with manual arrows + dot indicators; full-bleed.
  The headline ("Welcome to Silver Springs Golf & Country Club.") and the
  tagline ("Play golf. Enjoy life.") repeat across every slide — only the
  background photo changes. Now implemented in
  [src/components/club-public/HeroCarousel.tsx](../src/components/club-public/HeroCarousel.tsx).
- **An embedded YouTube video block appears below the hero.** Not yet
  implemented locally — tracked in `silver-springs-content-gaps.md`.
- **A "Calgary's Best Rated" badge/logo** appears lower on the page.
  Not yet implemented — same tracking doc.

Everything else in this audit was directly observed.

## 1. Page list

The live site exposes these top-level pages and one nested form:

| Slug | Title | Purpose |
|---|---|---|
| `/` | Home | Welcome, summary of pillars (golf, clubhouse, events, membership), member stories, contact |
| `/membership` | Membership | Categories, application invitation, contact CTA |
| `/golf` | Golf | Course overview, signature holes, conditions, course architect |
| `/trackman-range` | The Trackman Range | Year-round simulator + range bay description, member access |
| `/guest-information` | Guest Information | Visitor policy, dress code, pace of play |
| `/clubhouse` | Clubhouse | Dining rooms, lounge, locker rooms, member-only spaces |
| `/events` | Catering & Events | Private events, weddings, corporate, banquet capacity |
| `/events/request` | Event Request Form | Inquiry form (date, guest count, contact) |
| `/contact` | Contact | Address, phone, email, hours, map |
| `/member-area` | Member Area | Routes to the existing `/login` flow (already club-branded) |

## 2. Navigation structure

```
Home
Membership
Golf
  └ The Trackman Range
  └ Guest Information
Clubhouse
Catering & Events
  └ Event Request Form
Contact
Member Area
```

The "Member Area" item is the entry into the existing member portal at
`/login`. Login is already white-label branded for the club host (verified
in the white-label tenant resolver tests).

## 3. Visual language

A premium private-club site, not a SaaS dashboard.

| Layer | Reference impression | Local token |
|---|---|---|
| Background | Cream / warm off-white, never pure `#fff` | `bg-club-cream` (`#f8f5ef`) |
| Primary deep green | Hunter green for chrome + buttons | `club-green-700` (`#284829`), `club-green-800` (`#213a22`) |
| Mid green | Lighter accents, badges | `club-green-500` (`#3f7042`) |
| Pale green | Hero panel washes | `club-green-50/100` |
| Sand / stone | Section breaks | `club-sand` (`#ece5d3`), `club-stone` (`#e7e3da`) |
| Ink | Body text | `club-ink` (`#1a1f1a`) |
| Gold accent | Sparing — eyebrow keylines, "est." dates | `club-gold` (`#b08a4a`) |

Typography:

- Headings: **serif** (`Georgia, Cambria, Times New Roman`) — set in the
  existing Tailwind `font-serif` stack. Refined, traditional.
- Body: system sans (`-apple-system, BlinkMacSystemFont, Segoe UI…`).
- Eyebrows: `text-xs uppercase tracking-[0.3em]` in `text-club-green-700`.
- Generous line-height on hero / opening paragraphs (`leading-snug` or
  `leading-tight`).
- Page-level rhythm: large margins (`py-20`, `py-24`), centred max-width
  containers (`max-w-7xl`), generous gutter (`px-6` mobile, `px-8` desktop).

Button + chrome rules:

- Primary CTA: solid `bg-club-green-700`, white text, rounded `rounded-md`,
  `px-6 py-3` on marketing scale.
- Secondary CTA: ghost on cream, `btn-ghost` on white sections.
- Cards: subtle border + soft `shadow-card`, never harsh.

## 4. Header behavior

- Sticky top bar on scroll. Background goes from transparent over hero to
  cream once scrolled past the hero. We approximate this with `sticky top-0`
  + a translucent cream background to keep behavior consistent without a
  client-side scroll listener.
- Mobile: hamburger that toggles a full-width drawer (Phase-1 implementation
  is CSS-only `<details>` / `<summary>` to avoid client JS in marketing
  pages).
- The club wordmark sits left ("Silver Springs"). A subtle "Est. 1958"
  eyebrow above. Right side carries the nav links + a "Member Area" pill.

## 5. Footer structure

Three columns + bottom bar.

| Column | Content |
|---|---|
| Address | "1 Fairway Lane, Calgary, AB" — drawn from `Club.address` |
| Contact | Phone, email — placeholder values clearly tagged in content gaps |
| Visit | Hours, dress code link |

Bottom bar: copyright + small links (Membership, Contact, Member Area). The
copyright reads "© {year} Silver Springs Golf & Country Club" — no Spectre
brand anywhere on club-domain pages.

## 6. Imagery requirements

Per the rules in this task, we **do not hotlink** from the live site. The
imagery slots are reproduced with:

- Layered CSS gradients in the brand palette (`from-club-green-800/90 via-club-green-600/40`)
  to evoke the "rolling fairway at golden hour" feeling.
- Soft cream + sand panels to simulate clubhouse interior copy blocks.
- A small inventory of real-asset replacements is captured in
  [silver-springs-content-gaps.md](silver-springs-content-gaps.md).

## 7. Content blocks (recurring patterns)

| Pattern | Used on |
|---|---|
| Hero with eyebrow → headline → lede → CTA pair | Home, Membership, Golf, Clubhouse, Events |
| Two-column "pillar" alternating image/text | Home, Golf, Clubhouse |
| Testimonial / member-story quote with name + attribution | Home |
| Membership categories grid | Membership |
| Simple inquiry form (no payment processing) | Events → Event Request, Contact |
| Hours + address + phone block | Contact, footer |

All copy on these pages is **original draft tone-matched** to a private
club's voice. Real club copy is not reproduced verbatim. Where the live
site would surface a specific category fee, photographer credit, or
member name, we explicitly mark the slot as needing real content in the
content-gaps doc.

## 8. Mobile behavior

- Single column, generous vertical rhythm.
- Nav collapses to a `<details>` disclosure that toggles a stacked link
  list.
- Hero headline drops to `text-4xl` from `text-6xl`.
- CTA buttons full-width on `<sm` breakpoints.

## 9. Member Area routing

- Header link "Member Area" links to `/login` (NOT `/app/member`).
- `/login` rendered on a club domain is already Silver Springs branded
  (Phase 15 white-label work) — we deliberately don't duplicate that
  surface.
- After login, members continue into `/app/member` as before.
- `admin.silver-springs.localtest.me:3000/login` continues to be the
  staff entrypoint and is unchanged.

## 10. Links policy

- Internal links use relative paths (`/membership`, `/golf`).
- External links (golf course architect, etc.) would open in a new tab
  with `rel="noopener noreferrer"` — none currently in scope.
- No links point to live silverspringsgolfclub.com from these pages —
  we do not silently bounce visitors to the production site.
