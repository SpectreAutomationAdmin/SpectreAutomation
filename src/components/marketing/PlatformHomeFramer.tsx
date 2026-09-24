// WEB-1B (2026-09-23) — Framer exact port.
//
// This composition is a native-Next.js reproduction of
// https://passionate-mindset-017743.framer.app/ per the WEB-1B brief.
// The Framer prototype is the authoritative visual specification;
// this file reproduces its section order, layout, typography and
// content while preserving Spectre's engineering foundation.
//
// Content deviations from Framer are limited to preserving correct
// Spectre product semantics (Marc = Payroll Admin; Chris = Controller)
// and avoiding fabricated club history, per §11 + §12 of the brief.

import "./web1b.css";
import { W1bNav } from "./W1bNav";
import { W1bReveal } from "./W1bReveal";

function ArrowRight({ size = 12, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" aria-hidden="true" className={className}>
      <path d="M4 12h16M14 6l6 6-6 6" stroke="currentColor" strokeWidth="1.75" strokeLinecap="square" strokeLinejoin="miter" />
    </svg>
  );
}

/* 1 · HERO ------------------------------------------------------------ */
function Hero() {
  return (
    <section className="w1b-dark w1b-hero w1b-hero-photo">
      <img
        src="/marketing/photography/spectre-hero-club-flag.jpg"
        alt="Golf flag framed by trees on a shaded course"
        className="w1b-hero-photo-img"
        loading="eager"
        fetchPriority="high"
        decoding="async"
      />
      <div className="w1b-hero-photo-scrim" aria-hidden="true" />
      <div className="w1b-container w1b-hero-inner-wrap">
        <W1bReveal>
          <div className="w1b-eyebrow" style={{ marginBottom: "1.75rem" }}>
            SPECTRE / AUTOMATION
          </div>
        </W1bReveal>
        <W1bReveal delayMs={80}>
          <h1 className="w1b-display" style={{ maxWidth: "32ch" }}>
            The Operating System for Private Clubs.
          </h1>
        </W1bReveal>
        <W1bReveal delayMs={160}>
          <p className="w1b-body" style={{ marginTop: "2rem" }}>
            Spectre quietly connects the people, information and workflows behind an exceptional
            private club — so your team can spend less time operating software and more time
            running the club.
          </p>
        </W1bReveal>
        <W1bReveal delayMs={240}>
          <div className="w1b-cta-row">
            <a href="mailto:hello@spectreautomation.com?subject=Spectre%20Demonstration" className="w1b-pill-cta">
              Request a Demonstration
            </a>
            <a href="#mission-control" className="w1b-text-link">Explore Spectre</a>
          </div>
        </W1bReveal>
      </div>
    </section>
  );
}

/* 2 · PHILOSOPHY ------------------------------------------------------ */
function Philosophy() {
  return (
    <section id="philosophy" className="w1b-cream w1b-section">
      <div className="w1b-container">
        <div className="w1b-2col">
          <W1bReveal>
            <div className="w1b-eyebrow">THE SPECTRE PHILOSOPHY</div>
          </W1bReveal>
          <div>
            <W1bReveal>
              <h2 className="w1b-display">Software should disappear.</h2>
            </W1bReveal>
            <W1bReveal delayMs={100}>
              <p className="w1b-body" style={{ marginTop: "2rem", maxWidth: "40em" }}>
                Club professionals did not come to work to navigate disconnected modules,
                duplicate information, remember obscure processes, or adapt their thinking to
                the software. Controllers came to manage financial strategy. General Managers
                came to lead their clubs. Department managers came to improve operations.
              </p>
            </W1bReveal>
            <W1bReveal delayMs={180}>
              <p className="w1b-body-strong">Spectre exists to remove that friction.</p>
            </W1bReveal>
          </div>
        </div>
      </div>
    </section>
  );
}

/* 3 · MISSION CONTROL ------------------------------------------------- */
function MissionControl() {
  return (
    <section id="mission-control" className="w1b-dark w1b-section">
      <div className="w1b-container">
        <W1bReveal>
          <div className="w1b-eyebrow">MISSION CONTROL</div>
        </W1bReveal>
        <W1bReveal delayMs={80}>
          <h2 className="w1b-display" style={{ maxWidth: "28ch" }}>
            Know what matters before you go looking for it.
          </h2>
        </W1bReveal>
        <W1bReveal delayMs={140}>
          <p className="w1b-body" style={{ marginTop: "2rem" }}>
            A workday begins with context, not a dashboard. Spectre prepares the priorities,
            exceptions and conversations that require your judgment.
          </p>
        </W1bReveal>

        <W1bReveal delayMs={220}>
          <div className="w1b-mc-frame">
            <div className="w1b-mc-sidebar">
              <span className="w1b-mc-sidebar-active">Mission Control</span>
              <span>Work Intake</span>
              <span>Approvals</span>
              <span>Finance</span>
              <span>People</span>
              <span>Members</span>
            </div>
            <div className="w1b-mc-main">
              <div className="w1b-mc-tenant">HILLSBOROUGH<br />COUNTRY CLUB</div>
              <div className="w1b-mc-greeting-row">
                <div>
                  <div className="w1b-mc-date">MONDAY, SEPTEMBER 22</div>
                  <div className="w1b-mc-greeting">Good morning, Alex.</div>
                </div>
                <div className="w1b-mc-status">17:42 &nbsp;&bull;&nbsp; All systems current</div>
              </div>
              <div className="w1b-mc-callout">
                <div>
                  <div className="w1b-mc-callout-eyebrow">REQUIRES YOUR JUDGMENT</div>
                  <div className="w1b-mc-callout-title">
                    Capital invoice: fairway irrigation controls &nbsp;&bull;&nbsp; $42,680
                  </div>
                </div>
                <a href="#confidence" className="w1b-mc-callout-review">
                  Review <ArrowRight size={12} />
                </a>
              </div>
              <div className="w1b-mc-priorities-eyebrow">TODAY&rsquo;S PRIORITIES</div>
              <ul className="w1b-mc-priorities-list">
                <li><span>03</span>Payroll exceptions to confirm</li>
                <li><span>02</span>Member account approvals</li>
                <li><span>01</span>Banquet event staffing variance</li>
              </ul>
            </div>
            <div className="w1b-mc-card">
              <div>CLUB ACTIVITY</div>
              <p>Morning tee sheet is 92% confirmed.</p>
              <p>Food &amp; beverage labor is on plan.</p>
              <p>Two approvals are waiting for context.</p>
            </div>
          </div>
        </W1bReveal>
      </div>
    </section>
  );
}

/* 4 · INTELLIGENCE ---------------------------------------------------- */
const INTEL_STEPS: Array<[string, string, string]> = [
  ["01", "INVOICE RECEIVED",   "Irrigation Systems Ltd. • PDF • $42,680"],
  ["02", "CONTEXT RECOGNIZED", "Vendor matched • Asset purchase identified"],
  ["03", "READY FOR REVIEW",   "Capitalize to Fairway Infrastructure • Review rationale →"],
];

function Intelligence() {
  return (
    <section id="intelligence" className="w1b-cream w1b-section">
      <div className="w1b-container">
        <div className="w1b-intelligence">
          <div>
            <W1bReveal>
              <div className="w1b-eyebrow">INTELLIGENCE WITHOUT THE THEATRE</div>
            </W1bReveal>
            <W1bReveal delayMs={80}>
              <h2 className="w1b-display" style={{ maxWidth: "16ch" }}>
                A colleague who notices what you might not.
              </h2>
            </W1bReveal>
            <W1bReveal delayMs={160}>
              <p className="w1b-body" style={{ marginTop: "2rem" }}>
                Spectre reads the work as it arrives, keeps the context, and prepares a
                recommendation. The professional remains in control — with the reason visible
                before any decision is made.
              </p>
            </W1bReveal>
          </div>
          <W1bReveal delayMs={180}>
            <div className="w1b-intel-steps">
              {INTEL_STEPS.map(([n, label, body]) => (
                <div key={n} className="w1b-intel-row">
                  <div className="w1b-intel-row-num">{n}</div>
                  <div className="w1b-intel-row-label">{label}</div>
                  <div className="w1b-intel-row-body">{body}</div>
                </div>
              ))}
            </div>
          </W1bReveal>
        </div>
      </div>
    </section>
  );
}

/* 5 · INFO LIVES ONCE ------------------------------------------------- */
const FLOW = ["Accounts Payable", "General Ledger", "Fixed Assets", "Cash Management", "Reporting"];

function InfoLivesOnce() {
  return (
    <section id="information" className="w1b-dark w1b-section">
      <div className="w1b-container">
        <W1bReveal>
          <div className="w1b-eyebrow">ONE CONNECTED SYSTEM</div>
        </W1bReveal>
        <W1bReveal delayMs={80}>
          <h2 className="w1b-display">Information should live once.</h2>
        </W1bReveal>
        <W1bReveal delayMs={140}>
          <p className="w1b-body" style={{ marginTop: "2rem" }}>
            One fact. One source of truth. One authoritative home. If Spectre already knows
            something, your team should never have to enter it again.
          </p>
        </W1bReveal>
        <W1bReveal delayMs={220}>
          <div className="w1b-flow-row">
            {FLOW.map((node, i) => (
              <div key={node} className="w1b-flow-node">
                {i > 0 && <ArrowRight size={12} className="w1b-flow-node-arrow" />}
                {node}
              </div>
            ))}
          </div>
        </W1bReveal>
      </div>
    </section>
  );
}

/* 6 · CONNECTED CLUB OPERATIONS --------------------------------------- */
const OPS: Array<{ label: string; items: string[] }> = [
  { label: "FINANCE",    items: ["Accounts Payable", "Accounting", "Payroll", "Treasury"] },
  { label: "PEOPLE",     items: ["HR", "Employee Onboarding", "Scheduling", "Timekeeping"] },
  { label: "MEMBERS",    items: ["Member Database", "Accounts", "Billing", "Communications"] },
  { label: "OPERATIONS", items: ["Work Intake", "Approvals", "Documents", "Operational Intelligence"] },
];

function ConnectedOps() {
  return (
    <section id="connected" className="w1b-cream w1b-section">
      <div className="w1b-container">
        <div className="w1b-ops-header">
          <div>
            <W1bReveal>
              <div className="w1b-eyebrow">PURPOSE-BUILT CLUB OPERATIONS</div>
            </W1bReveal>
            <W1bReveal delayMs={80}>
              <h2 className="w1b-display" style={{ maxWidth: "22ch" }}>
                One operating system. Every part of the club.
              </h2>
            </W1bReveal>
          </div>
          <W1bReveal delayMs={140} className="w1b-ops-inset">
            <img
              src="/marketing/photography/spectre-irons-detail.jpg"
              alt="Two irons resting on turf"
              loading="lazy"
              decoding="async"
            />
          </W1bReveal>
        </div>
        <W1bReveal delayMs={200}>
          <div className="w1b-ops-grid">
            {OPS.map((g) => (
              <div key={g.label}>
                <div className="w1b-ops-eyebrow">{g.label}</div>
                <ul className="w1b-ops-list">
                  {g.items.map((i) => <li key={i}>{i}</li>)}
                </ul>
              </div>
            ))}
          </div>
        </W1bReveal>
      </div>
    </section>
  );
}

/* 7 · CONFIDENCE ------------------------------------------------------ */
function Confidence() {
  return (
    <section id="confidence" className="w1b-dark w1b-section">
      <div className="w1b-container">
        <div className="w1b-intelligence">
          <div>
            <W1bReveal>
              <div className="w1b-eyebrow">CONFIDENCE</div>
            </W1bReveal>
            <W1bReveal delayMs={80}>
              <h2 className="w1b-display" style={{ maxWidth: "16ch" }}>
                Confidence is more valuable than speed.
              </h2>
            </W1bReveal>
            <W1bReveal delayMs={160}>
              <p className="w1b-body" style={{ marginTop: "2rem" }}>
                Every important screen answers the same questions: What am I looking at? Why does
                it matter? What should I do next? And what happens if I do it?
              </p>
            </W1bReveal>
          </div>
          <W1bReveal delayMs={220}>
            <div className="w1b-conf-frame">
              <div className="w1b-conf-eyebrow">APPROVAL / CAPITAL PURCHASE</div>
              <div className="w1b-conf-title">Fairway irrigation controls</div>
              <div className="w1b-conf-body">
                This purchase matches the approved 2026 capital plan. Spectre recommends
                capitalization to Fairway Infrastructure; the source invoice and prior approvals
                are attached to this decision.
              </div>
              <div className="w1b-conf-actions">
                <a href="#final" className="w1b-conf-approve">Approve with recommendation</a>
                <a href="#final" className="w1b-conf-review">Review source</a>
              </div>
            </div>
          </W1bReveal>
        </div>
      </div>
    </section>
  );
}

/* 8 · CLUB IDENTITY --------------------------------------------------- */
const CLUB_TILES = [
  { label: "CEDAR RIDGE\nCOUNTRY CLUB",       bg: "#3D1E12" },
  { label: "THE LAKES\nGOLF & COUNTRY CLUB",  bg: "#1E3226" },
  { label: "NORTHFIELD\nCLUB",                bg: "#382A1E" },
];

function ClubIdentity() {
  return (
    <section id="club-identity" className="w1b-cream w1b-section w1b-identity-section">
      <div className="w1b-identity-band" aria-hidden="true">
        <img
          src="/marketing/photography/spectre-course-atmosphere.jpg"
          alt=""
          loading="lazy"
          decoding="async"
        />
      </div>
      <div className="w1b-container">
        <W1bReveal>
          <div className="w1b-eyebrow">PRIVATE CLUB IDENTITY</div>
        </W1bReveal>
        <W1bReveal delayMs={80}>
          <h2 className="w1b-display">Your club. Not ours.</h2>
        </W1bReveal>
        <W1bReveal delayMs={140}>
          <p className="w1b-body" style={{ marginTop: "2rem", maxWidth: "44em" }}>
            Spectre provides the architecture. The club remains the identity — in its name,
            crest, people, photography and accent.
          </p>
        </W1bReveal>
        <W1bReveal delayMs={220}>
          <div className="w1b-clubs">
            {CLUB_TILES.map((t) => (
              <div key={t.label} className="w1b-club-tile" style={{ background: t.bg }}>
                <div>{t.label.split("\n").map((line, i) => <span key={i}>{line}{i === 0 && <br/>}</span>)}</div>
              </div>
            ))}
          </div>
        </W1bReveal>
      </div>
    </section>
  );
}

/* 9 · FINAL ----------------------------------------------------------- */
function Final() {
  return (
    <section id="final" className="w1b-dark w1b-final w1b-final-photo">
      <img
        src="/marketing/photography/spectre-18-flag.jpg"
        alt="Red eighteenth-hole flag against the sky"
        className="w1b-final-photo-img"
        loading="lazy"
        decoding="async"
      />
      <div className="w1b-container w1b-final-inner">
        <W1bReveal>
          <div className="w1b-eyebrow" style={{ margin: "0 0 2rem" }}>THE RESULT</div>
        </W1bReveal>
        <W1bReveal delayMs={80}>
          <h2 className="w1b-display">
            Finally.<br />
            This is how club management software should have always worked.
          </h2>
        </W1bReveal>
        <W1bReveal delayMs={200}>
          <div className="w1b-final-tag">
            Spectre Automation<br />
            The Operating System for Private Clubs.
          </div>
        </W1bReveal>
        <W1bReveal delayMs={280}>
          <div className="w1b-final-actions">
            <a href="mailto:hello@spectreautomation.com?subject=Spectre%20Demonstration"
               className="w1b-pill-cta">
              Request a Demonstration
            </a>
            <a href="#philosophy" className="w1b-text-link">Discover the Spectre Philosophy</a>
          </div>
        </W1bReveal>
      </div>
    </section>
  );
}

/* 10 · FOOTER --------------------------------------------------------- */
function Footer() {
  return (
    <footer className="w1b-dark w1b-footer">
      <div className="w1b-container">
        <div className="w1b-nav-wordmark">SPECTRE / AUTOMATION</div>
        <p className="w1b-footer-lead">Built for the people who run exceptional clubs.</p>
        <ul className="w1b-footer-nav">
          <li><a href="#connected">Product</a></li>
          <li><a href="#final">Company</a></li>
          <li><a href="#final">Security</a></li>
          <li><a href="#final">Privacy</a></li>
          <li><a href="mailto:hello@spectreautomation.com">Contact</a></li>
        </ul>
      </div>
    </footer>
  );
}

/* Composed page ------------------------------------------------------- */
export function PlatformHomeFramer() {
  return (
    <main className="spectre-web1b" data-web1b="platform-home">
      <W1bNav />
      <Hero />
      <Philosophy />
      <MissionControl />
      <Intelligence />
      <InfoLivesOnce />
      <ConnectedOps />
      <Confidence />
      <ClubIdentity />
      <Final />
      <Footer />
    </main>
  );
}
