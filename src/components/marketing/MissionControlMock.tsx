// WEB-1 §12 — Faithful representation of Spectre's Mission Control surface,
// rendered as static SVG/HTML so the marketing page never depends on
// authenticated APIs or exposes real member/employee data.
//
// This is the PRODUCT layer per §6: crisp, precise, no grain, no film
// blur. The surrounding brand canvas stays tactile.

interface Row {
  time: string;
  kind: string;
  actor: string;
  title: string;
  detail: string;
  status: "action" | "attention" | "watch" | "info";
}

const NOW: Row[] = [
  { time: "07:42", kind: "Approval",  actor: "Marc Maldiney",  title: "Payroll · Semi-monthly",           detail: "$18,428.16 · 12 employees · calc v2 · ready for your review", status: "action" },
  { time: "07:31", kind: "Exception", actor: "AP",              title: "Cintas — May service",              detail: "Vendor recognised · GL suggested · one line differs from prior period",  status: "attention" },
  { time: "07:20", kind: "Signal",    actor: "AR",              title: "Collections — early trend",         detail: "House 4 · balance drifted 22 days · pattern change vs prior quarters",   status: "watch" },
];

const LATER: Row[] = [
  { time: "10:15", kind: "Meeting",    actor: "Finance",         title: "Committee packet — May",           detail: "Board reporting draft ready — commentary reconciled to KPIs",           status: "info"  },
  { time: "13:00", kind: "Onboarding", actor: "HR",              title: "Rebecca Chen — Turn week 1",       detail: "Documents complete · payroll enrolment prepared for Marc's review",      status: "info"  },
];

function StatusChip({ status }: { status: Row["status"] }) {
  const map: Record<Row["status"], { label: string; bg: string; fg: string }> = {
    action:    { label: "Needs approval",   bg: "#1A1E1A", fg: "#F4EFE3" },
    attention: { label: "Review",           bg: "#EEE7D2", fg: "#5B4A19" },
    watch:     { label: "Watching",         bg: "#EAE7DE", fg: "#5C5A54" },
    info:      { label: "Scheduled",        bg: "#F1EDE3", fg: "#8C8A83" },
  };
  const s = map[status];
  return (
    <span
      style={{
        display: "inline-flex", alignItems: "center", padding: "0.15rem 0.6rem",
        fontFamily: "var(--mkt-sans)", fontSize: "0.65rem", letterSpacing: "0.08em",
        textTransform: "uppercase", fontWeight: 500,
        background: s.bg, color: s.fg, borderRadius: "2px",
        border: status === "action" ? "1px solid #1A1E1A" : "1px solid rgba(26,30,26,0.08)",
      }}
    >
      {s.label}
    </span>
  );
}

function RowLine({ r }: { r: Row }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "3.5rem 1fr auto",
        alignItems: "center",
        gap: "1rem",
        padding: "1rem 1.15rem",
        borderTop: "1px solid rgba(26,30,26,0.07)",
      }}
    >
      <div style={{ fontFamily: "var(--mkt-sans)", fontSize: "0.72rem", color: "#8C8A83", letterSpacing: "0.02em" }}>
        {r.time}
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "baseline", flexWrap: "wrap" }}>
          <div style={{ fontFamily: "var(--mkt-sans)", fontSize: "0.66rem", letterSpacing: "0.14em", textTransform: "uppercase", color: "#A08658" }}>
            {r.kind}
          </div>
          <div style={{ fontFamily: "var(--mkt-sans)", fontSize: "0.68rem", color: "#64615A" }}>
            {r.actor}
          </div>
        </div>
        <div style={{ marginTop: "0.2rem", fontFamily: "var(--mkt-sans)", fontSize: "0.92rem", color: "#1A1E1A", fontWeight: 500 }}>
          {r.title}
        </div>
        <div style={{ marginTop: "0.15rem", fontFamily: "var(--mkt-sans)", fontSize: "0.82rem", color: "#64615A", lineHeight: 1.5 }}>
          {r.detail}
        </div>
      </div>
      <StatusChip status={r.status} />
    </div>
  );
}

export function MissionControlMock() {
  return (
    <div className="mkt-product-frame" style={{ maxWidth: "56rem", margin: "0 auto" }}>
      <div className="mkt-product-chrome">
        <span className="mkt-product-chrome-dot" />
        <span className="mkt-product-chrome-dot" />
        <span className="mkt-product-chrome-dot" />
        <span className="mkt-product-chrome-url">spectreautomation.com / app / mission-control</span>
      </div>
      <div style={{ background: "#FBFAF6" }}>
        <div style={{ padding: "1.5rem 1.5rem 0.4rem" }}>
          <div style={{ fontFamily: "var(--mkt-sans)", fontSize: "0.62rem", letterSpacing: "0.22em", textTransform: "uppercase", color: "#8C8A83", fontWeight: 500 }}>
            Coulee Ridge — Tuesday, September 22
          </div>
          <div style={{ fontFamily: "var(--font-source-serif-4), Georgia, serif", fontSize: "1.6rem", color: "#1A1E1A", marginTop: "0.35rem", letterSpacing: "-0.01em" }}>
            Good morning, Marc.
          </div>
          <div style={{ fontFamily: "var(--mkt-sans)", fontSize: "0.86rem", color: "#64615A", marginTop: "0.2rem" }}>
            One approval, one exception, one signal. Everything else is on track.
          </div>
        </div>
        <div style={{ marginTop: "1rem" }}>
          <div style={{ padding: "0 1.15rem", fontFamily: "var(--mkt-sans)", fontSize: "0.7rem", letterSpacing: "0.14em", textTransform: "uppercase", color: "#8C8A83", fontWeight: 500 }}>
            Now
          </div>
          <div>{NOW.map((r, i) => <RowLine r={r} key={i} />)}</div>
        </div>
        <div style={{ marginTop: "1.4rem", paddingBottom: "1rem" }}>
          <div style={{ padding: "0 1.15rem", fontFamily: "var(--mkt-sans)", fontSize: "0.7rem", letterSpacing: "0.14em", textTransform: "uppercase", color: "#8C8A83", fontWeight: 500 }}>
            Later today
          </div>
          <div>{LATER.map((r, i) => <RowLine r={r} key={i} />)}</div>
        </div>
      </div>
    </div>
  );
}
