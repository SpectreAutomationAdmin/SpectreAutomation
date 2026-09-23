// WEB-1 — Spectre marketing homepage (2026-09-22).
//
// Editorial private-club composition: warm ivory brand canvas, subtle
// paper grain, deep negative space, Source Serif 4 headlines set against
// Inter body copy. Real product surfaces (Mission Control, Work Intake)
// render inside razor-sharp product frames — no grain, no film blur.
// Narrative sequence follows §9-§21 of the WEB-1 brief; anchor ids match
// the nav + footer links so no destination is broken.
//
// This composition is imported by src/app/page.tsx when getActiveBranding()
// resolves to `platform` mode. Club-host branding continues to render its
// own ClubHome unchanged.

import "./marketing.css";
import { MarketingNav } from "./MarketingNav";
import { MarketingFooter } from "./MarketingFooter";
import { Wordmark } from "./Wordmark";
import { Reveal } from "./Reveal";
import { DisappearMoment } from "./DisappearMoment";
import { MissionControlMock } from "./MissionControlMock";

/* ---- Small inline SVG arrow used by CTAs ---- */
function Arrow() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" aria-hidden="true" className="mkt-cta-arrow">
      <path d="M4 12h16M14 6l6 6-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" strokeLinejoin="miter" />
    </svg>
  );
}

/* ---- SVG plate hero (dawn clubhouse abstraction; no third-party photography) ----
 * A restrained architectural illustration — leaded glass grid, oak column,
 * brass rule, morning light — communicating clubhouse without golf-tourism
 * imagery or stock photography. Fully vector so it stays razor-sharp at
 * any viewport and adds zero network cost. Renders behind the hero copy
 * with generous negative space.
 */
function HeroPlate() {
  // Restrained atmospheric plate — architectural morning light, no
  // literal windows or oak columns. Two soft radial washes suggest dawn
  // through a leaded window, and a single brass horizon rule anchors
  // the composition. Deliberately quiet so the hero copy remains
  // authoritative.
  return (
    <svg
      viewBox="0 0 1600 1000"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
    >
      <defs>
        <radialGradient id="dawnRight" cx="82%" cy="30%" r="60%">
          <stop offset="0%"   stopColor="#F7EAC7" stopOpacity="0.95" />
          <stop offset="60%"  stopColor="#F4EFE3" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#F4EFE3" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="dawnFar" cx="90%" cy="55%" r="35%">
          <stop offset="0%"   stopColor="#E7D4A5" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#E7D4A5" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="floor" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="#E9DEC4" stopOpacity="0" />
          <stop offset="100%" stopColor="#D4C39B" stopOpacity="0.35" />
        </linearGradient>
      </defs>
      {/* base warm wash */}
      <rect width="1600" height="1000" fill="#F4EFE3" />
      {/* morning light entering from the upper right */}
      <rect width="1600" height="1000" fill="url(#dawnRight)" />
      <rect width="1600" height="1000" fill="url(#dawnFar)" />
      {/* subtle floor gradient at the bottom */}
      <rect x="0" y="600" width="1600" height="400" fill="url(#floor)" />
      {/* single fine brass horizon rule */}
      <line x1="0" y1="640" x2="1600" y2="640" stroke="#A08658" strokeWidth="0.6" opacity="0.35" />
    </svg>
  );
}

/* ---- 1 · HERO ---- */
function Hero() {
  return (
    <section className="mkt-surface-ivory mkt-grain-warm" style={{ "--mkt-grain-alpha": 0.06 } as React.CSSProperties}>
      <div style={{ position: "relative", overflow: "hidden" }}>
        <div style={{ position: "absolute", inset: 0 }}>
          <HeroPlate />
        </div>
        <div className="mkt-container" style={{ position: "relative", paddingBlock: "clamp(9rem, 15vw, 13rem)" }}>
          <Reveal>
            <div className="mkt-eyebrow" style={{ marginBottom: "2.5rem" }}>
              <Wordmark variant="eyebrow" />
            </div>
          </Reveal>
          <Reveal delayMs={80}>
            <h1 className="mkt-display-lg" style={{ maxWidth: "18ch", margin: 0 }}>
              The Operating System for <span className="mkt-italic">Private Clubs.</span>
            </h1>
          </Reveal>
          <Reveal delayMs={160}>
            <p className="mkt-lede" style={{ marginTop: "2rem" }}>
              Spectre quietly connects the people, information and workflows behind an exceptional
              private club so the team can spend less time operating software and more time
              running the club.
            </p>
          </Reveal>
          <Reveal delayMs={220}>
            <div style={{ marginTop: "2.75rem", display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
              <a href="#final" className="mkt-cta mkt-cta-primary">
                Request a Demonstration <Arrow />
              </a>
              <a href="#mission-control" className="mkt-cta mkt-cta-secondary">
                Explore Spectre
              </a>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

/* ---- 3 · MISSION CONTROL ---- */
function MissionControl() {
  return (
    <section id="mission-control" className="mkt-surface-ivory mkt-grain-warm"
             style={{ "--mkt-grain-alpha": 0.055 } as React.CSSProperties}>
      <div className="mkt-container" style={{ paddingBlock: "var(--mkt-section-y)" }}>
        <div className="grid gap-16 md:gap-24 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)] lg:items-center">
          <Reveal>
            <div>
              <div className="mkt-eyebrow" style={{ marginBottom: "1.5rem" }}>Mission Control</div>
              <h2 className="mkt-headline" style={{ margin: 0 }}>
                Begin your day knowing <span className="mkt-italic">exactly</span> what deserves your attention.
              </h2>
              <p className="mkt-lede" style={{ marginTop: "1.75rem" }}>
                Approvals ready. Exceptions surfaced. Signals noted before you started looking.
                Mission Control answers a single, quiet question — <em>what matters this morning</em> —
                so the team spends the rest of the day on the work only they can do.
              </p>
              <hr className="mkt-rule" style={{ margin: "2rem 0 1rem" }} />
              <ul className="flex flex-col gap-3">
                {[
                  ["Approvals",  "Payroll · AP · department review — each with the context you need to act."],
                  ["Exceptions", "The one line that changed, the vendor that behaved unusually, the balance that drifted."],
                  ["Signals",    "Patterns that matter — before they become a Monday-morning problem."],
                ].map(([k, v]) => (
                  <li key={k as string} className="grid" style={{ gridTemplateColumns: "8rem 1fr", gap: "1rem" }}>
                    <div className="mkt-eyebrow" style={{ color: "var(--mkt-text)" }}>{k}</div>
                    <div className="mkt-body" style={{ margin: 0 }}>{v}</div>
                  </li>
                ))}
              </ul>
            </div>
          </Reveal>
          <Reveal delayMs={120}>
            <MissionControlMock />
          </Reveal>
        </div>
      </div>
    </section>
  );
}

/* ---- 4 · INTELLIGENCE ---- */
function Intelligence() {
  const steps = [
    ["Invoice arrives",   "email · attachment · portal"],
    ["Spectre reads it",  "vendor · dates · line items"],
    ["Context recognised", "prior coding · GL history"],
    ["Recommendation prepared", "GL · department · approver"],
    ["Human approves",    "one deliberate action · Spectre posts"],
  ];
  return (
    <section id="intelligence" className="mkt-surface-slate mkt-grain-dark"
             style={{ "--mkt-grain-alpha": 0.05 } as React.CSSProperties}>
      <div className="mkt-container" style={{ paddingBlock: "var(--mkt-section-y)" }}>
        <Reveal>
          <div className="mkt-eyebrow" style={{ marginBottom: "1.75rem" }}>Intelligence</div>
        </Reveal>
        <Reveal delayMs={80}>
          <h2 className="mkt-headline" style={{ margin: 0, maxWidth: "22ch" }}>
            A colleague who notices <span className="mkt-italic">what you might not.</span>
          </h2>
        </Reveal>
        <Reveal delayMs={140}>
          <p className="mkt-lede" style={{ marginTop: "2rem", color: "#B5B0A2" }}>
            Intelligence without the theatre. No chatbots bolted onto the side. Spectre notices
            patterns as your work moves through it and quietly prepares the answer — but the
            professional in the chair remains authoritative.
          </p>
        </Reveal>

        <Reveal delayMs={220}>
          <div style={{ marginTop: "3.5rem", borderTop: "1px solid var(--mkt-rule-dark)", paddingTop: "2rem" }}>
            <div className="mkt-eyebrow" style={{ marginBottom: "1.25rem" }}>Example — an invoice</div>
            <ol className="mkt-steps" style={{ paddingLeft: 0 }}>
              {steps.map(([title, detail], i) => (
                <li key={title as string} style={{ listStyle: "none" }}>
                  <div style={{ fontFamily: "var(--mkt-serif)", fontSize: "0.9rem", color: "#8C8A83" }}>
                    0{i + 1}
                  </div>
                  <div style={{
                    fontFamily: "var(--mkt-sans)", fontSize: "0.95rem", color: "#EFE9DC",
                    fontWeight: 500, marginTop: "0.6rem", letterSpacing: "-0.005em",
                  }}>
                    {title}
                  </div>
                  <div className="mkt-body" style={{ color: "#8C8A83", marginTop: "0.35rem" }}>
                    {detail}
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/* ---- 5 · INFORMATION SHOULD LIVE ONCE ---- */
function InformationOnce() {
  const flow = ["Accounts Payable", "General Ledger", "Fixed Assets", "Treasury", "Reporting"];
  const flow2 = ["Onboarding", "HR", "Scheduling", "Timekeeping", "Payroll", "General Ledger"];
  return (
    <section id="information" className="mkt-surface-parchment mkt-grain-warm"
             style={{ "--mkt-grain-alpha": 0.08 } as React.CSSProperties}>
      <div className="mkt-container" style={{ paddingBlock: "var(--mkt-section-y)" }}>
        <Reveal>
          <div className="mkt-eyebrow" style={{ marginBottom: "1.75rem" }}>Principle</div>
        </Reveal>
        <Reveal delayMs={80}>
          <h2 className="mkt-headline" style={{ margin: 0, maxWidth: "20ch" }}>
            Information should <span className="mkt-italic">live once.</span>
          </h2>
        </Reveal>
        <Reveal delayMs={140}>
          <p className="mkt-lede" style={{ marginTop: "2rem" }}>
            One fact. One source of truth. One authoritative home. Information moves through
            Spectre — the team never re-enters the same number into three disconnected modules.
          </p>
        </Reveal>

        <Reveal delayMs={200}>
          <div style={{ marginTop: "3.5rem", display: "grid", gap: "2.5rem" }}>
            <FlowLine label="Finance" chain={flow} />
            <FlowLine label="People"  chain={flow2} />
          </div>
        </Reveal>
      </div>
    </section>
  );
}

function FlowLine({ label, chain }: { label: string; chain: string[] }) {
  return (
    <div>
      <div className="mkt-eyebrow" style={{ marginBottom: "1rem", color: "var(--mkt-text)" }}>{label}</div>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.5rem 0.85rem" }}>
        {chain.map((node, i) => (
          <span key={node} style={{ display: "inline-flex", alignItems: "center", gap: "0.75rem" }}>
            <span style={{
              fontFamily: "var(--mkt-serif)",
              fontSize: "clamp(1.35rem, 2.2vw, 1.85rem)",
              letterSpacing: "-0.01em",
              color: "var(--mkt-ink)",
              borderBottom: "1px solid rgba(26,30,26,0.25)",
              paddingBottom: "0.2rem",
            }}>
              {node}
            </span>
            {i < chain.length - 1 && (
              <span style={{ color: "var(--mkt-brass)", opacity: 0.75, fontFamily: "var(--mkt-serif)", fontSize: "1.4rem" }}>→</span>
            )}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ---- 6 · WORK INTAKE ---- */
function WorkIntake() {
  const arrivals: Array<{ kind: string; from: string; subject: string; state: string }> = [
    { kind: "Email",     from: "toro@irrigation.ca",         subject: "Turfmaster invoice — May service",     state: "Vendor · Invoice · Ready" },
    { kind: "Document",  from: "member 4218",                subject: "Assessment appeal — page 1 of 3",     state: "Request · Committee · Queued" },
    { kind: "Approval",  from: "F&B / Christina",            subject: "Wine order — cellar restock",         state: "Approval · Budget checked" },
    { kind: "Question",  from: "front desk",                 subject: "Guest fee for tomorrow's outing?",    state: "Question · Answered from policy" },
  ];
  return (
    <section id="work-intake" className="mkt-surface-warm mkt-grain-warm"
             style={{ "--mkt-grain-alpha": 0.06 } as React.CSSProperties}>
      <div className="mkt-container" style={{ paddingBlock: "var(--mkt-section-y)" }}>
        <div className="grid gap-16 md:gap-24 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] lg:items-start">
          <Reveal>
            <div>
              <div className="mkt-eyebrow" style={{ marginBottom: "1.5rem" }}>Work Intake</div>
              <h2 className="mkt-headline" style={{ margin: 0 }}>
                Work arrives. <span className="mkt-italic">Spectre understands it.</span>
              </h2>
              <p className="mkt-lede" style={{ marginTop: "1.75rem" }}>
                Email, invoices, documents, approvals, questions — Spectre reads what arrived,
                classifies it, connects the relevant history, and moves the team into the workflow
                that actually addresses it. No shuffling between inboxes and modules.
              </p>
            </div>
          </Reveal>
          <Reveal delayMs={140}>
            <div className="mkt-product-frame">
              <div className="mkt-product-chrome">
                <span className="mkt-product-chrome-dot" />
                <span className="mkt-product-chrome-dot" />
                <span className="mkt-product-chrome-dot" />
                <span className="mkt-product-chrome-url">app / work-intake</span>
              </div>
              <div style={{ background: "#FBFAF6" }}>
                {arrivals.map((a) => (
                  <div key={a.subject} style={{
                    display: "grid",
                    gridTemplateColumns: "5rem 1fr auto",
                    gap: "1rem",
                    padding: "1.15rem 1.25rem",
                    borderTop: "1px solid rgba(26,30,26,0.07)",
                    alignItems: "center",
                  }}>
                    <div style={{ fontFamily: "var(--mkt-sans)", fontSize: "0.66rem", letterSpacing: "0.14em", textTransform: "uppercase", color: "#A08658", fontWeight: 500 }}>
                      {a.kind}
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontFamily: "var(--mkt-sans)", fontSize: "0.92rem", color: "#1A1E1A", fontWeight: 500 }}>
                        {a.subject}
                      </div>
                      <div style={{ fontFamily: "var(--mkt-sans)", fontSize: "0.78rem", color: "#8C8A83", marginTop: "0.2rem" }}>
                        {a.from}
                      </div>
                    </div>
                    <div style={{ fontFamily: "var(--mkt-sans)", fontSize: "0.72rem", color: "#64615A", letterSpacing: "0.02em", textAlign: "right" }}>
                      {a.state}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

/* ---- 7 · CONNECTED CLUB OPERATIONS ---- */
function ConnectedOps() {
  const groups: Array<{ eyebrow: string; heading: string; items: string[] }> = [
    { eyebrow: "Finance",     heading: "Accounts Payable · Accounting · Payroll · Treasury · Fixed Assets · Budgeting & Reporting", items: [] },
    { eyebrow: "People",      heading: "HR · Onboarding · Scheduling · Timekeeping · Employee Portal",                              items: [] },
    { eyebrow: "Members",     heading: "Database · Accounts · Billing · Communications · Club Activity",                            items: [] },
    { eyebrow: "Operations",  heading: "Work Intake · Approvals · Documents · Operational Intelligence",                            items: [] },
  ];
  return (
    <section id="connected" className="mkt-surface-slate-deep mkt-grain-dark"
             style={{ "--mkt-grain-alpha": 0.06 } as React.CSSProperties}>
      <div className="mkt-container" style={{ paddingBlock: "var(--mkt-section-y)" }}>
        <Reveal>
          <div className="mkt-eyebrow" style={{ marginBottom: "1.75rem" }}>Connected Club Operations</div>
        </Reveal>
        <Reveal delayMs={80}>
          <h2 className="mkt-headline" style={{ margin: 0, maxWidth: "22ch" }}>
            One operating system. <span className="mkt-italic">Not four.</span>
          </h2>
        </Reveal>
        <Reveal delayMs={140}>
          <p className="mkt-lede" style={{ marginTop: "2rem", color: "#B5B0A2" }}>
            The domains of a private club — finance, people, members, operations — are capabilities
            of a single operating system, not disconnected products the team has to reconcile by
            hand each week.
          </p>
        </Reveal>
        <div style={{ marginTop: "3.5rem" }}>
          {groups.map((g, i) => (
            <Reveal key={g.eyebrow} delayMs={i * 80}>
              <div
                className="mkt-connected-row"
                style={{
                  paddingBlock: "1.6rem",
                  borderTop: i === 0 ? "1px solid var(--mkt-rule-dark)" : undefined,
                  borderBottom: "1px solid var(--mkt-rule-dark)",
                }}
              >
                <div className="mkt-eyebrow" style={{ color: "var(--mkt-brass-soft)" }}>{g.eyebrow}</div>
                <div className="mkt-connected-headline">
                  {g.heading}
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ---- 8 · CONFIDENCE ---- */
function Confidence() {
  const questions = [
    "What am I looking at?",
    "Why does it matter?",
    "What should I do next?",
    "What happens if I do it?",
  ];
  return (
    <section id="confidence" className="mkt-surface-warm mkt-grain-warm"
             style={{ "--mkt-grain-alpha": 0.06 } as React.CSSProperties}>
      <div className="mkt-container" style={{ paddingBlock: "var(--mkt-section-y)" }}>
        <div className="grid gap-16 md:gap-24 lg:grid-cols-2 lg:items-center">
          <Reveal>
            <div>
              <div className="mkt-eyebrow" style={{ marginBottom: "1.5rem" }}>Confidence</div>
              <h2 className="mkt-headline" style={{ margin: 0 }}>
                Confidence is more valuable than <span className="mkt-italic">speed.</span>
              </h2>
              <p className="mkt-lede" style={{ marginTop: "1.75rem" }}>
                Every meaningful Spectre screen quietly answers four questions before the
                professional has to ask them. Routine actions remain effortless. Meaningful
                irreversible actions are made deliberate.
              </p>
            </div>
          </Reveal>
          <Reveal delayMs={120}>
            <ul className="flex flex-col" style={{ borderTop: "1px solid var(--mkt-rule)" }}>
              {questions.map((q, i) => (
                <li key={q} style={{ display: "grid", gridTemplateColumns: "3.5rem 1fr", gap: "1.25rem", padding: "1.6rem 0", borderBottom: "1px solid var(--mkt-rule)", alignItems: "baseline" }}>
                  <span style={{ fontFamily: "var(--mkt-serif)", color: "var(--mkt-brass)", fontSize: "0.95rem" }}>0{i + 1}</span>
                  <span style={{ fontFamily: "var(--mkt-serif)", fontSize: "clamp(1.35rem, 2.3vw, 1.7rem)", color: "var(--mkt-ink)", letterSpacing: "-0.008em" }}>
                    {q}
                  </span>
                </li>
              ))}
            </ul>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

/* ---- 9 · CLUB IDENTITY ---- */
function ClubIdentity() {
  return (
    <section id="club-identity" className="mkt-surface-ivory mkt-grain-warm"
             style={{ "--mkt-grain-alpha": 0.055 } as React.CSSProperties}>
      <div className="mkt-container" style={{ paddingBlock: "var(--mkt-section-y)" }}>
        <div className="grid gap-16 md:gap-20 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-center">
          <Reveal>
            <div>
              <div className="mkt-eyebrow" style={{ marginBottom: "1.5rem" }}>Club Identity</div>
              <h2 className="mkt-headline" style={{ margin: 0 }}>
                Your club. <span className="mkt-italic">Not ours.</span>
              </h2>
              <p className="mkt-lede" style={{ marginTop: "1.75rem" }}>
                Spectre provides the architecture. The club provides the identity. Wordmark,
                crest, restrained accent, imagery, operational tone — the member experience
                belongs to the club, always.
              </p>
            </div>
          </Reveal>
          <Reveal delayMs={120}>
            {/* A tenant plaque — synthetic Coulee Ridge demonstration. */}
            <div className="mkt-product-frame" style={{ padding: "3rem 2.5rem", background: "#F1EDE3" }}>
              <div style={{ fontFamily: "var(--mkt-sans)", fontSize: "0.65rem", letterSpacing: "0.22em", textTransform: "uppercase", color: "#8C8A83", fontWeight: 500 }}>
                Tenant · Coulee Ridge
              </div>
              <div style={{
                fontFamily: "var(--mkt-serif)",
                fontSize: "clamp(2rem, 4vw, 2.75rem)",
                color: "#1A1E1A",
                letterSpacing: "-0.015em",
                lineHeight: 1.05,
                marginTop: "0.75rem",
              }}>
                Coulee Ridge Golf &amp; Country Club
              </div>
              <div style={{ marginTop: "1.25rem", display: "inline-flex", alignItems: "center", gap: "0.75rem" }}>
                <span style={{ width: "0.75rem", height: "0.75rem", background: "#2F5832", borderRadius: "50%" }} aria-hidden="true" />
                <span style={{ fontFamily: "var(--mkt-sans)", fontSize: "0.85rem", color: "#64615A" }}>
                  Restrained accent · club heritage green
                </span>
              </div>
              <hr className="mkt-rule" style={{ margin: "1.75rem 0" }} />
              <div style={{ fontFamily: "var(--mkt-serif)", fontStyle: "italic", color: "#64615A", fontSize: "0.95rem", lineHeight: 1.5 }}>
                Members since 1927.<br />
                Weekend lunch service resumes at eleven.
              </div>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

/* ---- 10 · THE PORSCHE PRINCIPLE ---- */
function PorschePrinciple() {
  return (
    <section id="porsche" className="mkt-surface-ink mkt-grain-dark"
             style={{ "--mkt-grain-alpha": 0.06 } as React.CSSProperties}>
      <div className="mkt-editorial" style={{ paddingBlock: "var(--mkt-section-y)" }}>
        <Reveal>
          <div className="mkt-eyebrow" style={{ marginBottom: "2rem" }}>The Porsche Principle</div>
        </Reveal>
        <Reveal delayMs={80}>
          <h2 className="mkt-display" style={{ margin: 0, maxWidth: "18ch" }}>
            Every control exactly <span className="mkt-italic">where it belongs.</span>
          </h2>
        </Reveal>
        <Reveal delayMs={160}>
          <div className="grid gap-10 md:gap-16 md:grid-cols-2 mt-16">
            <p className="mkt-body" style={{ color: "#B5B0A2", maxWidth: "26em" }}>
              Great design does not require unfamiliar controls. It makes familiar controls feel
              inevitable. Engineering serves the experience — never the other way around.
            </p>
            <p className="mkt-body" style={{ color: "#B5B0A2", maxWidth: "26em" }}>
              Every workflow intentional. Every interaction inevitable. Every screen designed
              rather than assembled.
            </p>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/* ---- 11 · FOUR OUTCOMES ---- */
function FourOutcomes() {
  const items: Array<[string, string]> = [
    ["Clarity",    "I immediately understand what matters."],
    ["Confidence", "I trust what I see and understand why."],
    ["Flow",       "Work naturally leads to the next step."],
    ["Competence", "I finish feeling meaningful work was accomplished."],
  ];
  return (
    <section className="mkt-surface-warm mkt-grain-warm"
             style={{ "--mkt-grain-alpha": 0.055 } as React.CSSProperties}>
      <div className="mkt-container" style={{ paddingBlock: "var(--mkt-section-y)" }}>
        <Reveal>
          <div className="mkt-eyebrow" style={{ marginBottom: "2rem" }}>Four Outcomes</div>
        </Reveal>
        <Reveal delayMs={80}>
          <h2 className="mkt-headline" style={{ margin: 0, maxWidth: "22ch" }}>
            What using Spectre <span className="mkt-italic">actually feels like.</span>
          </h2>
        </Reveal>
        <div style={{ marginTop: "3.5rem", borderTop: "1px solid var(--mkt-rule)" }}>
          {items.map(([k, v], i) => (
            <Reveal key={k} delayMs={i * 60}>
              <div style={{
                display: "grid",
                gridTemplateColumns: "minmax(0, 14rem) minmax(0, 1fr)",
                gap: "2rem",
                paddingBlock: "1.75rem",
                borderBottom: "1px solid var(--mkt-rule)",
                alignItems: "baseline",
              }}>
                <div style={{ fontFamily: "var(--mkt-serif)", fontSize: "clamp(1.6rem, 2.4vw, 2rem)", color: "var(--mkt-ink)", letterSpacing: "-0.012em" }}>
                  {k}
                </div>
                <div style={{ fontFamily: "var(--mkt-serif)", fontStyle: "italic", fontSize: "clamp(1.1rem, 1.6vw, 1.35rem)", color: "var(--mkt-text-muted)" }}>
                  {v}
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ---- 12 · FINAL BRAND MOMENT ---- */
function Final() {
  return (
    <section id="final" className="mkt-surface-slate-deep mkt-grain-dark"
             style={{ "--mkt-grain-alpha": 0.055 } as React.CSSProperties}>
      <div className="mkt-editorial" style={{ paddingBlock: "clamp(6rem, 10vw, 10rem)" }}>
        <Reveal>
          <div className="mkt-eyebrow" style={{ marginBottom: "3rem" }}>
            <Wordmark variant="eyebrow" />
          </div>
        </Reveal>
        <Reveal delayMs={80}>
          <h2 className="mkt-display-lg" style={{ margin: 0 }}>
            Finally.
          </h2>
        </Reveal>
        <Reveal delayMs={200}>
          <h2 className="mkt-headline" style={{ margin: "1.25em 0 0", maxWidth: "22ch", color: "#EFE9DC" }}>
            This is how club management software should have <span className="mkt-italic">always worked.</span>
          </h2>
        </Reveal>
        <Reveal delayMs={280}>
          <div style={{ marginTop: "3.5rem", display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
            <a href="mailto:hello@spectreautomation.com?subject=Spectre%20Demonstration"
               className="mkt-cta mkt-cta-primary"
               style={{ background: "#EFE9DC", color: "#1A1E1A", borderColor: "#EFE9DC" }}>
              Request a Demonstration <Arrow />
            </a>
            <a href="#disappear" className="mkt-cta mkt-cta-secondary">
              Discover the Spectre Philosophy
            </a>
          </div>
        </Reveal>
        <Reveal delayMs={360}>
          <p className="mkt-body" style={{ marginTop: "4rem", color: "#8C8A83", fontStyle: "italic", fontFamily: "var(--mkt-serif)" }}>
            Spectre Automation — The Operating System for Private Clubs.
          </p>
        </Reveal>
      </div>
    </section>
  );
}

/* ---- Composed page ---- */
export function PlatformHomeV2() {
  return (
    <main className="spectre-marketing" data-web1="platform-home">
      <MarketingNav />
      <Hero />
      <DisappearMoment />
      <MissionControl />
      <Intelligence />
      <InformationOnce />
      <WorkIntake />
      <ConnectedOps />
      <Confidence />
      <ClubIdentity />
      <PorschePrinciple />
      <FourOutcomes />
      <Final />
      <MarketingFooter />
    </main>
  );
}
