"use client";

// Spectre Design Language — Component Gallery client.
//
// Renders every documented component variant in one page. All
// primitives are inlined here (not exported as library components)
// so the gallery is self-contained and any future changes to how
// production consumes the design language do not require touching
// this review artifact.

import { useState, type ReactNode } from "react";
import {
  IconArrowRight,
  IconArrowUpDown,
  IconBell,
  IconCheck,
  IconCheckCircle,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconClose,
  IconCog,
  IconEllipsis,
  IconInfo,
  IconPlus,
  IconSearch,
  IconUser,
  IconWarning,
} from "@/components/spectre/icons";

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

function Section({
  id,
  title,
  intent,
  children,
}: {
  id: string;
  title: string;
  intent: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-6" data-testid={`section-${id}`}>
      <div className="mb-6">
        <div
          className="text-[11px] font-semibold uppercase tracking-[0.08em]"
          style={{ color: "var(--spectre-text-muted)" }}
        >
          {id.replace(/-/g, " ")}
        </div>
        <h2
          className="mt-1 text-[20px] font-semibold leading-7"
          style={{ color: "var(--spectre-text-primary)" }}
        >
          {title}
        </h2>
        <p
          className="mt-1 text-[13px] leading-5"
          style={{ color: "var(--spectre-text-secondary)" }}
        >
          {intent}
        </p>
      </div>
      {children}
    </section>
  );
}

function Row({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={["flex flex-wrap items-center gap-3", className].filter(Boolean).join(" ")}
    >
      {children}
    </div>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      className="rounded-spectre-panel p-6"
      style={{
        background: "var(--spectre-surface)",
        border: "1px solid var(--spectre-border-hairline)",
      }}
    >
      <div
        className="mb-4 text-[11px] font-semibold uppercase tracking-[0.08em]"
        style={{ color: "var(--spectre-text-muted)" }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Gallery
// ---------------------------------------------------------------------------

export function SpectreGallery() {
  const [tab, setTab] = useState<"overview" | "typography" | "form" | "table">("overview");
  const [checkbox, setCheckbox] = useState(true);
  const [toggle, setToggle] = useState(true);
  const [radio, setRadio] = useState<"a" | "b">("a");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [pageIndex, setPageIndex] = useState(2);

  return (
    <div className="max-w-[1200px] mx-auto">
      {/* Page header */}
      <header className="mb-8">
        <div
          className="text-[11px] font-semibold uppercase tracking-[0.08em]"
          style={{ color: "var(--spectre-text-muted)" }}
        >
          Spectre · Phase 1
        </div>
        <h1
          className="mt-1 text-[32px] font-semibold leading-10 tracking-[-0.02em]"
          style={{ color: "var(--spectre-text-primary)" }}
        >
          Design Language Gallery
        </h1>
        <p
          className="mt-2 text-[14px] leading-6 max-w-[720px]"
          style={{ color: "var(--spectre-text-secondary)" }}
        >
          Every documented component variant, rendered on the new application shell using only <code
            style={{
              fontFamily: "JetBrains Mono, ui-monospace, monospace",
              background: "var(--spectre-canvas-sunken)",
              padding: "2px 6px",
              borderRadius: 4,
              fontSize: 12,
            }}
          >{`--spectre-*`}</code> tokens. The source of truth is <code
            style={{
              fontFamily: "JetBrains Mono, ui-monospace, monospace",
              background: "var(--spectre-canvas-sunken)",
              padding: "2px 6px",
              borderRadius: 4,
              fontSize: 12,
            }}
          >docs/design/Spectre Design Language.md</code>. This page is a review artifact and is not linked from production navigation.
        </p>
      </header>

      {/* Tabs */}
      <div className="spectre-tabs mb-6" role="tablist">
        {(["overview", "typography", "form", "table"] as const).map((t) => (
          <button
            key={t}
            className="spectre-tab capitalize"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>

      {/* All sections rendered regardless of tab so Playwright captures
          the entire gallery in one screenshot. Tabs are for UX. */}
      <div className="grid gap-12">
        {/* ============================================================
            TYPOGRAPHY
           ============================================================ */}
        <Section id="typography" title="Typography" intent="One family (Inter), six roles. Serif is deliberately absent — that belongs to the Monthly Reporting Package.">
          <Group label="Type scale">
            <div className="grid gap-6">
              {[
                { role: "Display", cls: "text-spectre-display font-semibold tracking-[-0.02em]", note: "32 / 40 · 600" },
                { role: "H1", cls: "text-spectre-h1 font-semibold tracking-[-0.015em]", note: "24 / 32 · 600" },
                { role: "H2", cls: "text-spectre-h2 font-semibold tracking-[-0.01em]", note: "20 / 28 · 600" },
                { role: "H3", cls: "text-spectre-h3 font-semibold", note: "16 / 24 · 600" },
                { role: "Body", cls: "text-spectre-body", note: "14 / 22 · 400" },
                { role: "Body small", cls: "text-spectre-body-sm", note: "13 / 20 · 400" },
                { role: "Caption", cls: "text-spectre-caption", note: "12 / 16 · 400" },
                { role: "Label", cls: "text-spectre-label font-semibold uppercase tracking-[0.06em]", note: "11 / 14 · 600 · UPPERCASE" },
              ].map((t) => (
                <div key={t.role} className="grid grid-cols-[160px_1fr_120px] items-baseline gap-6">
                  <span className="text-[11px] uppercase tracking-[0.08em] font-semibold" style={{ color: "var(--spectre-text-muted)" }}>{t.role}</span>
                  <span className={t.cls} style={{ color: "var(--spectre-text-primary)" }}>
                    The quick brown fox jumps over the lazy dog
                  </span>
                  <span className="text-[11px] text-right" style={{ color: "var(--spectre-text-muted)", fontFamily: "JetBrains Mono, monospace" }}>{t.note}</span>
                </div>
              ))}
            </div>
          </Group>
        </Section>

        {/* ============================================================
            BUTTONS
           ============================================================ */}
        <Section id="buttons" title="Buttons" intent="Six states — primary, secondary, ghost, danger, icon-only, loading, disabled. Focus ring is the accent ring token. No shadow on rest.">
          <Group label="Variants">
            <Row>
              <button className="spectre-btn spectre-btn--primary">Primary</button>
              <button className="spectre-btn spectre-btn--secondary">Secondary</button>
              <button className="spectre-btn spectre-btn--ghost">Ghost</button>
              <button className="spectre-btn spectre-btn--danger">Danger</button>
              <button className="spectre-btn spectre-btn--secondary spectre-btn--icon" aria-label="Options">
                <IconEllipsis size={16} />
              </button>
              <button className="spectre-btn spectre-btn--primary spectre-btn--loading">Loading</button>
              <button className="spectre-btn spectre-btn--primary" disabled>Disabled</button>
            </Row>
          </Group>
          <Group label="Sizes">
            <Row>
              <button className="spectre-btn spectre-btn--primary spectre-btn--sm">Small</button>
              <button className="spectre-btn spectre-btn--primary">Default</button>
              <button className="spectre-btn spectre-btn--primary spectre-btn--lg">Large</button>
              <button className="spectre-btn spectre-btn--secondary">
                <IconPlus size={14} /> New item
              </button>
              <button className="spectre-btn spectre-btn--secondary">
                Continue <IconArrowRight size={14} />
              </button>
            </Row>
          </Group>
        </Section>

        {/* ============================================================
            INPUTS
           ============================================================ */}
        <Section id="inputs" title="Inputs" intent="Text · password · search · textarea · select · checkbox · radio · toggle. Every control shares the same border/background/focus contract.">
          <Group label="Text, password, search, textarea">
            <div className="grid grid-cols-2 gap-6">
              <div>
                <label className="spectre-label" htmlFor="i1">Email</label>
                <input id="i1" type="email" className="spectre-input" placeholder="you@club.example" />
                <div className="spectre-help">We&rsquo;ll only email you about your account.</div>
              </div>
              <div>
                <label className="spectre-label" htmlFor="i2">Password</label>
                <input id="i2" type="password" className="spectre-input" placeholder="••••••••" />
              </div>
              <div>
                <label className="spectre-label" htmlFor="i3">Search</label>
                <div className="relative">
                  <IconSearch size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: "var(--spectre-text-muted)" }} />
                  <input id="i3" type="search" className="spectre-input spectre-search" placeholder="Search members, invoices, applications…" />
                </div>
              </div>
              <div>
                <label className="spectre-label" htmlFor="i4">Preferred contact</label>
                <select id="i4" className="spectre-select">
                  <option>Email</option>
                  <option>Phone</option>
                  <option>SMS</option>
                </select>
              </div>
              <div className="col-span-2">
                <label className="spectre-label" htmlFor="i5">Note to file</label>
                <textarea id="i5" className="spectre-textarea" placeholder="Add context for the record…" />
                <div className="spectre-help spectre-help--error">This field is required.</div>
              </div>
              <div>
                <label className="spectre-label" htmlFor="i6">Disabled</label>
                <input id="i6" className="spectre-input" value="Locked value" disabled readOnly />
              </div>
            </div>
          </Group>

          <Group label="Checkbox · radio · toggle">
            <div className="grid grid-cols-3 gap-6">
              <div className="flex flex-col gap-2">
                <div className="text-[11px] font-semibold uppercase tracking-[0.06em]" style={{ color: "var(--spectre-text-muted)" }}>Checkbox</div>
                <label className="flex items-center gap-2 text-[13px]" style={{ color: "var(--spectre-text-primary)" }}>
                  <input type="checkbox" className="spectre-check" checked={checkbox} onChange={(e) => setCheckbox(e.target.checked)} />
                  Enrol in monthly digest
                </label>
                <label className="flex items-center gap-2 text-[13px]" style={{ color: "var(--spectre-text-primary)" }}>
                  <input type="checkbox" className="spectre-check" disabled />
                  Locked option
                </label>
              </div>
              <div className="flex flex-col gap-2">
                <div className="text-[11px] font-semibold uppercase tracking-[0.06em]" style={{ color: "var(--spectre-text-muted)" }}>Radio</div>
                <label className="flex items-center gap-2 text-[13px]" style={{ color: "var(--spectre-text-primary)" }}>
                  <input type="radio" name="r1" className="spectre-radio" checked={radio === "a"} onChange={() => setRadio("a")} />
                  Weekly cadence
                </label>
                <label className="flex items-center gap-2 text-[13px]" style={{ color: "var(--spectre-text-primary)" }}>
                  <input type="radio" name="r1" className="spectre-radio" checked={radio === "b"} onChange={() => setRadio("b")} />
                  Monthly cadence
                </label>
              </div>
              <div className="flex flex-col gap-2">
                <div className="text-[11px] font-semibold uppercase tracking-[0.06em]" style={{ color: "var(--spectre-text-muted)" }}>Toggle</div>
                <label className="flex items-center gap-3 text-[13px]" style={{ color: "var(--spectre-text-primary)" }}>
                  <input type="checkbox" className="spectre-toggle" checked={toggle} onChange={(e) => setToggle(e.target.checked)} />
                  Enable auto-post to Board
                </label>
                <label className="flex items-center gap-3 text-[13px]" style={{ color: "var(--spectre-text-primary)" }}>
                  <input type="checkbox" className="spectre-toggle" disabled />
                  Advanced diagnostics (locked)
                </label>
              </div>
            </div>
          </Group>
        </Section>

        {/* ============================================================
            NAVIGATION
           ============================================================ */}
        <Section id="navigation" title="Navigation" intent="Tabs · breadcrumbs · pagination. Every affordance carries a visible focus ring on keyboard entry.">
          <Group label="Tabs">
            <div className="spectre-tabs" role="tablist">
              <button className="spectre-tab" role="tab" aria-selected="true">Overview</button>
              <button className="spectre-tab" role="tab" aria-selected="false">Activity</button>
              <button className="spectre-tab" role="tab" aria-selected="false">Settings</button>
              <button className="spectre-tab" role="tab" aria-selected="false" disabled>Archive</button>
            </div>
          </Group>
          <Group label="Breadcrumbs">
            <nav aria-label="Breadcrumb" className="spectre-crumbs">
              <a href="#">Home</a>
              <span className="sep"><IconChevronRight size={12} /></span>
              <a href="#">Admin</a>
              <span className="sep"><IconChevronRight size={12} /></span>
              <a href="#">Design System</a>
              <span className="sep"><IconChevronRight size={12} /></span>
              <span aria-current="page">Gallery</span>
            </nav>
          </Group>
          <Group label="Pagination">
            <div className="spectre-pager">
              <button aria-label="Previous"><IconChevronLeft size={14} /></button>
              <button>1</button>
              <button aria-current={pageIndex === 2 ? "page" : undefined} onClick={() => setPageIndex(2)}>2</button>
              <button aria-current={pageIndex === 3 ? "page" : undefined} onClick={() => setPageIndex(3)}>3</button>
              <button>4</button>
              <button>5</button>
              <span style={{ color: "var(--spectre-text-muted)" }}>…</span>
              <button>24</button>
              <button aria-label="Next"><IconChevronRight size={14} /></button>
            </div>
          </Group>
        </Section>

        {/* ============================================================
            FEEDBACK
           ============================================================ */}
        <Section id="feedback" title="Feedback" intent="Toast · alert · badge · progress · spinner · skeleton. Status colours never fill the entire canvas — only badge / alert / iconography.">
          <Group label="Alerts">
            <div className="grid gap-3">
              <div className="spectre-alert spectre-alert--info">
                <IconInfo size={16} />
                <div><strong>Heads up.</strong> This is an informational message with no action required.</div>
              </div>
              <div className="spectre-alert spectre-alert--success">
                <IconCheckCircle size={16} />
                <div><strong>Applied.</strong> Your reconciliation posted at 08:14 EDT with zero variance.</div>
              </div>
              <div className="spectre-alert spectre-alert--warning">
                <IconWarning size={16} />
                <div><strong>Attention.</strong> AR ageing has crossed the policy threshold for two accounts.</div>
              </div>
              <div className="spectre-alert spectre-alert--error">
                <IconWarning size={16} />
                <div><strong>Failed.</strong> The batch import halted at line 42 with a missing account code.</div>
              </div>
            </div>
          </Group>
          <Group label="Toasts">
            <div className="grid grid-cols-2 gap-3">
              <div className="spectre-toast spectre-toast--success">
                <IconCheckCircle size={16} style={{ color: "var(--spectre-status-success)" }} />
                <div className="min-w-0">
                  <div className="text-[13px] font-medium">Package published</div>
                  <div className="text-[12px]" style={{ color: "var(--spectre-text-muted)" }}>Sent to five committee chairs</div>
                </div>
                <button className="spectre-btn spectre-btn--ghost spectre-btn--sm spectre-btn--icon" aria-label="Dismiss">
                  <IconClose size={12} />
                </button>
              </div>
              <div className="spectre-toast spectre-toast--info">
                <IconInfo size={16} style={{ color: "var(--spectre-status-info)" }} />
                <div className="min-w-0">
                  <div className="text-[13px] font-medium">New activity</div>
                  <div className="text-[12px]" style={{ color: "var(--spectre-text-muted)" }}>Chen party of six for tonight</div>
                </div>
              </div>
              <div className="spectre-toast spectre-toast--warning">
                <IconWarning size={16} style={{ color: "var(--spectre-status-warning)" }} />
                <div className="min-w-0">
                  <div className="text-[13px] font-medium">Ageing threshold</div>
                  <div className="text-[12px]" style={{ color: "var(--spectre-text-muted)" }}>Two accounts crossed the 60-day line</div>
                </div>
              </div>
              <div className="spectre-toast spectre-toast--error">
                <IconWarning size={16} style={{ color: "var(--spectre-status-error)" }} />
                <div className="min-w-0">
                  <div className="text-[13px] font-medium">Import failed</div>
                  <div className="text-[12px]" style={{ color: "var(--spectre-text-muted)" }}>Missing account code on line 42</div>
                </div>
              </div>
            </div>
          </Group>
          <Group label="Badges">
            <Row>
              <span className="spectre-badge">Draft</span>
              <span className="spectre-badge spectre-badge--success">Published</span>
              <span className="spectre-badge spectre-badge--warning">Under review</span>
              <span className="spectre-badge spectre-badge--error">Failed</span>
              <span className="spectre-badge spectre-badge--info">Scheduled</span>
              <span className="spectre-badge spectre-badge--accent">Featured</span>
            </Row>
          </Group>
          <Group label="Progress · spinner · skeleton">
            <div className="grid grid-cols-2 gap-6">
              <div>
                <div className="spectre-progress"><div className="spectre-progress-bar" style={{ width: "68%" }} /></div>
                <div className="mt-2 text-[12px]" style={{ color: "var(--spectre-text-muted)" }}>68% of 1,254 rows imported</div>
              </div>
              <div className="flex items-center gap-3">
                <span className="spectre-spinner" />
                <span className="text-[13px]" style={{ color: "var(--spectre-text-secondary)" }}>Reconciling ledger…</span>
              </div>
              <div className="col-span-2 grid gap-2">
                <div className="spectre-skeleton" style={{ height: 16, width: "40%" }} />
                <div className="spectre-skeleton" style={{ height: 12, width: "70%" }} />
                <div className="spectre-skeleton" style={{ height: 12, width: "62%" }} />
              </div>
            </div>
          </Group>
        </Section>

        {/* ============================================================
            CONTAINERS
           ============================================================ */}
        <Section id="containers" title="Containers" intent="Card · panel · dialog · popover · tooltip. Every container declares its elevation via a token; nothing hardcodes a shadow value.">
          <Group label="Card">
            <div className="grid grid-cols-2 gap-4">
              <div className="spectre-card">
                <div className="spectre-card-header">
                  <div className="text-[16px] font-semibold" style={{ color: "var(--spectre-text-primary)" }}>Reconciliation</div>
                  <button className="spectre-btn spectre-btn--ghost spectre-btn--icon" aria-label="Options">
                    <IconEllipsis size={16} />
                  </button>
                </div>
                <div className="spectre-card-body">
                  <p className="text-[14px]" style={{ color: "var(--spectre-text-secondary)" }}>
                    Sixty-three lines reconciled. Zero variance. The batch closed at 06:41 EDT.
                  </p>
                </div>
                <div className="spectre-card-footer">
                  <button className="spectre-btn spectre-btn--ghost">Dismiss</button>
                  <button className="spectre-btn spectre-btn--primary">Open batch</button>
                </div>
              </div>
              <div className="spectre-card spectre-card--interactive">
                <div className="spectre-card-body">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-[0.08em]" style={{ color: "var(--spectre-text-muted)" }}>Hospitality</div>
                      <div className="mt-1 text-[16px] font-semibold" style={{ color: "var(--spectre-text-primary)" }}>Founders&rsquo; evening</div>
                      <div className="mt-1 text-[13px]" style={{ color: "var(--spectre-text-secondary)" }}>Friday · 84 covers · dining room A</div>
                    </div>
                    <span className="spectre-badge spectre-badge--accent">Featured</span>
                  </div>
                </div>
              </div>
            </div>
          </Group>
          <Group label="Panel">
            <div className="spectre-panel">
              <div className="text-[16px] font-semibold" style={{ color: "var(--spectre-text-primary)" }}>Weekly digest</div>
              <p className="mt-1 text-[14px]" style={{ color: "var(--spectre-text-secondary)" }}>Panels carry less chrome than cards — no border-radius on the inner sections, no footer rules. Use for grouped controls or configuration blocks.</p>
            </div>
          </Group>
          <Group label="Dialog · popover · tooltip">
            <Row>
              <button className="spectre-btn spectre-btn--secondary" onClick={() => setDialogOpen(true)}>Open dialog</button>
              <div className="relative inline-block">
                <div className="spectre-popover">
                  <div className="text-[13px] font-medium" style={{ color: "var(--spectre-text-primary)" }}>Popover surface</div>
                  <div className="mt-1 text-[12px]" style={{ color: "var(--spectre-text-muted)" }}>Static preview — used for dropdowns, filter menus.</div>
                </div>
              </div>
              <div className="inline-block spectre-tooltip">Tooltip — 12px, tight, high-contrast.</div>
            </Row>
          </Group>
        </Section>

        {/* ============================================================
            TABLES
           ============================================================ */}
        <Section id="tables" title="Tables" intent="Standard · dense · empty state · loading · sorting · selection. Tabular numerals, column headers in uppercase label type.">
          <Group label="Standard + sorting + selection">
            <div className="rounded-spectre-table overflow-hidden border" style={{ borderColor: "var(--spectre-border-hairline)" }}>
              <table className="spectre-table">
                <thead>
                  <tr>
                    <th style={{ width: 40 }}><input type="checkbox" className="spectre-check" /></th>
                    <th>
                      <button>Applicant <IconArrowUpDown size={12} /></button>
                    </th>
                    <th>Household</th>
                    <th>Status</th>
                    <th className="text-right">Sponsorship</th>
                    <th>Received</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td><input type="checkbox" className="spectre-check" /></td>
                    <td>James Hendrick</td>
                    <td>Two adults, one junior</td>
                    <td><span className="spectre-badge spectre-badge--warning">Under review</span></td>
                    <td className="text-right">$4,000</td>
                    <td>Jul 8, 2026</td>
                  </tr>
                  <tr data-selected="true">
                    <td><input type="checkbox" className="spectre-check" defaultChecked /></td>
                    <td>Marie DuPont</td>
                    <td>Two adults</td>
                    <td><span className="spectre-badge spectre-badge--warning">Under review</span></td>
                    <td className="text-right">$4,000</td>
                    <td>Jul 6, 2026</td>
                  </tr>
                  <tr>
                    <td><input type="checkbox" className="spectre-check" /></td>
                    <td>Andrew Kowalski</td>
                    <td>Two adults, two juniors</td>
                    <td><span className="spectre-badge spectre-badge--success">Approved</span></td>
                    <td className="text-right">$4,000</td>
                    <td>Jul 2, 2026</td>
                  </tr>
                  <tr>
                    <td><input type="checkbox" className="spectre-check" /></td>
                    <td>Rebecca Chen</td>
                    <td>One adult</td>
                    <td><span className="spectre-badge">Draft</span></td>
                    <td className="text-right">—</td>
                    <td>Jun 30, 2026</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </Group>
          <Group label="Dense">
            <div className="rounded-spectre-table overflow-hidden border" style={{ borderColor: "var(--spectre-border-hairline)" }}>
              <table className="spectre-table spectre-table--dense">
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Description</th>
                    <th className="text-right">Debit</th>
                    <th className="text-right">Credit</th>
                    <th className="text-right">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  <tr><td>1000</td><td>Operating cash</td><td className="text-right">14,204.11</td><td className="text-right">—</td><td className="text-right">14,204.11</td></tr>
                  <tr><td>2010</td><td>Accounts payable</td><td className="text-right">—</td><td className="text-right">5,902.50</td><td className="text-right">(5,902.50)</td></tr>
                  <tr><td>4100</td><td>Dues revenue</td><td className="text-right">—</td><td className="text-right">2,340.00</td><td className="text-right">(2,340.00)</td></tr>
                </tbody>
              </table>
            </div>
          </Group>
          <Group label="Empty · loading">
            <div className="grid grid-cols-2 gap-4">
              <div className="rounded-spectre-table overflow-hidden border" style={{ borderColor: "var(--spectre-border-hairline)" }}>
                <table className="spectre-table">
                  <thead>
                    <tr><th>Applicant</th><th>Status</th><th>Received</th></tr>
                  </thead>
                  <tbody>
                    <tr><td colSpan={3} className="spectre-table-empty">
                      <div className="text-[14px] font-medium" style={{ color: "var(--spectre-text-primary)" }}>No applications yet</div>
                      <div className="mt-1 text-[13px]" style={{ color: "var(--spectre-text-muted)" }}>Submitted applications will appear here.</div>
                    </td></tr>
                  </tbody>
                </table>
              </div>
              <div className="rounded-spectre-table overflow-hidden border p-4" style={{ borderColor: "var(--spectre-border-hairline)", background: "var(--spectre-surface)" }}>
                <div className="grid gap-2">
                  <div className="spectre-skeleton" style={{ height: 14, width: "40%" }} />
                  <div className="spectre-skeleton" style={{ height: 10, width: "70%" }} />
                  <div className="spectre-skeleton" style={{ height: 10, width: "62%" }} />
                  <div className="spectre-skeleton" style={{ height: 10, width: "55%" }} />
                </div>
              </div>
            </div>
          </Group>
        </Section>

        {/* ============================================================
            CHARTS (placeholder only)
           ============================================================ */}
        <Section id="charts" title="Charts" intent="Placeholders only. Chart primitives are not part of Phase 1 — the Monthly Reporting Package owns the reporting-chart system and no operational chart is redesigned here.">
          <Group label="Placeholder">
            <div className="grid grid-cols-2 gap-4">
              <div className="spectre-chart-placeholder" style={{ height: 200 }}>Bar chart — placeholder</div>
              <div className="spectre-chart-placeholder" style={{ height: 200 }}>Line chart — placeholder</div>
            </div>
          </Group>
        </Section>

        {/* ============================================================
            SHELL — visible sidebar/topbar already surrounds the page
           ============================================================ */}
        <Section id="shell-notes" title="Application shell" intent="The sidebar (248 px expanded / 72 collapsed) and 64-px top bar are already visible around this page. Try collapsing the sidebar, cycling themes via the top bar, and opening the user menu.">
          <div className="spectre-panel">
            <ul
              className="grid gap-2 text-[13px]"
              style={{ color: "var(--spectre-text-secondary)" }}
            >
              <li><strong style={{ color: "var(--spectre-text-primary)" }}>Sidebar collapse.</strong> Icons align on collapse; hover shows the label as a title attribute. No content jumps.</li>
              <li><strong style={{ color: "var(--spectre-text-primary)" }}>Active state.</strong> Accent-soft background + 2-px accent bar on the left edge. No glow.</li>
              <li><strong style={{ color: "var(--spectre-text-primary)" }}>Top bar.</strong> Breadcrumbs left; search / notifications / theme / user right. 64-px height.</li>
              <li><strong style={{ color: "var(--spectre-text-primary)" }}>Workspace.</strong> Sits flush inside the shell — no floating card, no rounded pane. Padding is 32/20/16 by breakpoint.</li>
              <li><strong style={{ color: "var(--spectre-text-primary)" }}>Theme toggle.</strong> Cycles light → dark → system. Persisted in localStorage. No FOUC on refresh.</li>
            </ul>
          </div>
        </Section>
      </div>

      {/* Dialog */}
      {dialogOpen && (
        <div className="spectre-dialog-backdrop" onClick={() => setDialogOpen(false)}>
          <div
            className="spectre-dialog"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="dlg-title"
          >
            <div className="spectre-dialog-header" id="dlg-title">Confirm publication</div>
            <div className="spectre-dialog-body">
              <p className="text-[14px]" style={{ color: "var(--spectre-text-secondary)" }}>
                This publishes the May 2026 Board Package to all committee chairs. This action cannot be undone from this dialog.
              </p>
            </div>
            <div className="spectre-dialog-footer">
              <button className="spectre-btn spectre-btn--ghost" onClick={() => setDialogOpen(false)}>Cancel</button>
              <button className="spectre-btn spectre-btn--primary" onClick={() => setDialogOpen(false)}>Publish</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
