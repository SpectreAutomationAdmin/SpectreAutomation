// Sprint 2 B3 (2026-07-19) — Mission Control connect prompt.
//
// Renders a restrained rail card that invites the current user to
// connect Outlook to Work Intake. Server-side gate:
//   • MAILBOX_INTEGRATION_ENABLED
//   • current user has permission to connect a mailbox
//   • current user has NO connected personal mailbox (any status
//     other than DISCONNECTED counts; DISCONNECTED still shows the
//     prompt because it invites reconnect)
//
// Per §12 of the B3 directive: this MUST NOT replace, hide, or weaken
// the real AP and AR feed. It is a secondary rail item.

import Link from "next/link";
export { loadMissionControlConnectPromptSpec } from "@/lib/mailbox/mission-control-prompt";

export default function MissionControlConnectPrompt({
  headline,
  copy,
  connectHref,
}: {
  headline: string;
  copy: string;
  connectHref: string;
}) {
  return (
    <section
      className="spectre-mc-rail-card"
      data-testid="mission-control-connect-prompt"
      aria-label="Connect Outlook"
    >
      <div className="spectre-mc-rail-head">
        <span className="t">Bring in email</span>
        <span className="a" style={{ color: "var(--spectre-text-muted)", fontSize: 11 }}>Optional</span>
      </div>
      <h3 style={{ fontSize: 14, fontWeight: 600, color: "var(--spectre-text-primary)", margin: "6px 0 6px" }}>
        {headline}
      </h3>
      <p style={{ fontSize: 12.5, color: "var(--spectre-text-secondary)", lineHeight: "18px", margin: 0 }}>
        {copy}
      </p>
      <div style={{ marginTop: 12 }}>
        <Link
          href={connectHref}
          className="spectre-dw-btn primary sm"
          data-testid="mission-control-connect-cta"
          style={{ fontSize: 12 }}
        >
          Connect Outlook
        </Link>
      </div>
    </section>
  );
}
