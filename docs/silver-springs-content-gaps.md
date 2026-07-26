# Silver Springs Public Site — Content Gaps

The public site at `http://silver-springs.localtest.me:3000` is built with
tone-matched draft copy and CSS-rendered imagery so the experience feels
polished in local development without scraping the live site. Before any
real pilot demo, the items below need real assets and copy supplied by
the club.

## Imagery — required real assets

| Slot | Page(s) | Local fallback | Real asset needed |
|---|---|---|---|
| **Hero carousel — slide 1: Course · Morning** | Home | CSS gradient (green → light green) with "Course · Morning" tag | Wide shot of the course in early morning light (≥ 1920×1080). |
| **Hero carousel — slide 2: Course · Golden hour** | Home | Amber + green gradient | Course at golden hour, ideally a signature hole. |
| **Hero carousel — slide 3: Clubhouse exterior at dusk** | Home | Stone + green gradient | Clubhouse exterior, lights on. |
| **Hero carousel — slide 4: Dining · Main room** | Home | Stone + amber + gold gradient | Interior of the main dining room with table setting. |
| **Hero carousel — slide 5: Wedding on the lawn** | Home | Cream + sand + green gradient | Wedding ceremony or reception on property. |
| **Hero carousel — slide 6: Trackman bay** | Home | Charcoal + deep green gradient | Interior of a Trackman simulator bay in use. |
| **Hero embedded video** | Home (below carousel) | **Not yet rendered locally — slot pending.** | Either a YouTube embed (same as live site) or a local MP4. Needs explicit hosting/CDN decision. |
| **"Calgary's Best Rated" badge** | Home (lower section) | **Not yet rendered locally — slot pending.** | The award badge graphic + the award-issuing body, year, and any legal text required. |
| Course pillars | Home (golf section), Golf | Tiled gradient blocks | 3–4 photos of signature holes, ideally the same hole in different seasons. |
| Trackman bay | The Trackman Range | Dark-green / charcoal gradient | Interior photo of the simulator bay. |
| Clubhouse interior | Home (clubhouse), Clubhouse | Cream + sand panel | Dining room, lounge, locker room shots. |
| Wedding / event setup | Catering & Events | Cream panel with green accent | Table-setting, banquet, ceremony photos. |
| Member story portraits | Home (testimonials) | None (text only) | Headshots of the quoted members (with their permission). |

Every carousel slide is currently labelled at bottom-right with its asset
slot name (e.g. `Course · Morning`) so the placeholder nature is unambiguous.
Replacing a slide is: drop a `webp`/`jpg` into `public/club-imagery/silver-springs/`
and swap the gradient class for a `background-image` URL in the SLIDES array
in `src/components/club-public/HeroCarousel.tsx`. The audit + asset slot
names are the contract.

## Copy — needs real content

| Block | Page | Draft | Real |
|---|---|---|---|
| Course architect attribution | Golf | Omitted | Architect name + year |
| Course conditions / agronomy notes | Golf | General prose | Specific bent-grass cultivars, greens speed, etc. |
| Membership categories + fees | Membership | Categories named, fee table headers only | Real category names + initiation / dues amounts |
| Member testimonials | Home | Three draft quotes attributed to "James W., Member since 2014" etc. with realistic but invented names | Either: real quoted members (with permission) OR clearly labelled "Sample testimonial" |
| Dress code | Guest Information, Clubhouse | Generic private-club rules | Club's actual dress code |
| Pace of play target | Guest Information | "4 hr 15 min" placeholder value | Club's published target |
| Phone + email | Contact, footer | Format-only ("(403) 555-0100") | Real numbers |
| Hours of operation | Contact, footer | Seasonal ranges | Real hours |

## Compliance / legal

| Item | Why |
|---|---|
| Privacy policy link | Required at footer for a real-world site (PIPEDA in Alberta). Currently the footer has no link. |
| Terms of use | Same. |
| Photo consent for member portraits | If real member portraits replace the textual testimonials. |
| Wedding deposit policy | Catering & Events form is inquiry-only — the live business workflow probably has a separate deposit step. Out of scope for this audit, but worth a note. |

## Operational

| Item | Page | Note |
|---|---|---|
| Event Request form destination | `/events/request` | Today the inquiry posts to a service stub that records a `clubAnnouncement`-shape row. A real form would email the events coordinator and write to a dedicated `EventInquiry` table. Captured in `docs/remediation-backlog.md`. |
| Contact form destination | `/contact` | Same shape as above. |

## What is intentionally NOT placeholder

To make the visible-vs-real distinction explicit:

- **Brand wordmark "Silver Springs"** — sourced from `Club.wordmark` in the DB.
- **Address "1 Fairway Lane, Calgary, AB"** — from `Club.address` in seed.
- **Founded year "1958"** — from `Club.foundedYear`.
- **Primary green** — from `Club.primaryColor`.

These are real database-backed values, not text we typed into the page.
Replacing them is a settings change, not a code change.
