// TA-1B (2026-09-03) — Admin invitation activation page.
//
// Public route (no admin session required). Renders a minimal activation
// form: display the club + inviter, collect password + confirmation,
// then POST to /api/invite/activate. On success, redirects to /login.
//
// Also marks the invitation OPENED on server-side render — first visit
// updates the open timestamp so the founder can see the invitee has
// clicked through even before they finish.

import { redirect } from "next/navigation";
import { findInvitationByToken, markInvitationOpened } from "@/lib/tenant-admin/invitations";
import { InvitationActivationForm } from "./InvitationActivationForm";

export const dynamic = "force-dynamic";

interface Params { params: { token: string } }

export default async function InvitationActivationPage({ params }: Params) {
  const token = params.token;
  const invitation = await findInvitationByToken(token);

  if (!invitation) {
    return renderMessage({
      title: "Invitation not found",
      body: "This invitation link is invalid, has already been activated, or has been revoked. Ask the person who invited you to send a new one.",
    });
  }
  if (invitation.status === "ACTIVATED") {
    return renderMessage({
      title: "Invitation already activated",
      body: "This invitation has already been used. Sign in with your existing password, or ask the person who invited you to send a new one.",
      linkHref: "/login",
      linkText: "Go to sign-in",
    });
  }
  if (invitation.status === "REVOKED") {
    return renderMessage({
      title: "Invitation revoked",
      body: "This invitation has been revoked. Ask the person who invited you to send a new one.",
    });
  }
  if (invitation.status === "EXPIRED" || invitation.expiresAt.getTime() < Date.now()) {
    return renderMessage({
      title: "Invitation expired",
      body: "This invitation has expired. Ask the person who invited you to send a new one.",
    });
  }

  // Best-effort — mark opened. Never throw.
  try { await markInvitationOpened(token); } catch { /* ignore */ }

  const inviterLabel = invitation.invitedBy?.name || invitation.invitedBy?.email || "A Club Administrator";

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--spectre-surface-cream, #f6f1e6)",
        padding: "48px 16px",
      }}
    >
      <div
        style={{
          maxWidth: 480,
          width: "100%",
          background: "white",
          borderRadius: 8,
          boxShadow: "0 2px 32px rgba(0,0,0,0.06)",
          padding: 40,
        }}
        data-testid="invite-activation-card"
      >
        <div
          style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "#6b6357" }}
          data-testid="invite-club-name"
        >
          {invitation.club.name}
        </div>
        <h1 style={{ marginTop: 8, marginBottom: 0, fontSize: 24, fontWeight: 600, color: "#1a1a1a" }}>
          Activate your Spectre access
        </h1>
        <p style={{ marginTop: 16, marginBottom: 24, fontSize: 14, color: "#4a453d", lineHeight: 1.5 }}>
          {inviterLabel} has invited you to help operate {invitation.club.name} on Spectre. Set a password below to
          activate your access.
        </p>

        <dl
          style={{
            marginBottom: 24,
            padding: 16,
            background: "#f9f5eb",
            borderRadius: 6,
            fontSize: 13,
            display: "grid",
            gridTemplateColumns: "auto 1fr",
            columnGap: 12,
            rowGap: 6,
          }}
        >
          <dt style={{ color: "#6b6357", fontWeight: 500 }}>Email</dt>
          <dd style={{ color: "#1a1a1a", margin: 0 }} data-testid="invite-email">{invitation.email}</dd>
          {invitation.displayTitle ? (
            <>
              <dt style={{ color: "#6b6357", fontWeight: 500 }}>Title</dt>
              <dd style={{ color: "#1a1a1a", margin: 0 }} data-testid="invite-title">{invitation.displayTitle}</dd>
            </>
          ) : null}
          <dt style={{ color: "#6b6357", fontWeight: 500 }}>Expires</dt>
          <dd style={{ color: "#1a1a1a", margin: 0 }}>{invitation.expiresAt.toDateString()}</dd>
        </dl>

        <InvitationActivationForm token={token} suggestedName={invitation.displayName ?? ""} />
      </div>
    </main>
  );
}

function renderMessage(args: { title: string; body: string; linkHref?: string; linkText?: string }) {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--spectre-surface-cream, #f6f1e6)",
        padding: "48px 16px",
      }}
    >
      <div
        style={{
          maxWidth: 480,
          width: "100%",
          background: "white",
          borderRadius: 8,
          boxShadow: "0 2px 32px rgba(0,0,0,0.06)",
          padding: 40,
        }}
        data-testid="invite-message-card"
      >
        <h1 style={{ marginTop: 0, marginBottom: 12, fontSize: 22, fontWeight: 600, color: "#1a1a1a" }}>
          {args.title}
        </h1>
        <p style={{ margin: 0, color: "#4a453d", fontSize: 14, lineHeight: 1.5 }}>{args.body}</p>
        {args.linkHref && args.linkText ? (
          <p style={{ marginTop: 24 }}>
            <a
              href={args.linkHref}
              style={{
                display: "inline-block",
                padding: "8px 16px",
                background: "#1e3a2a",
                color: "white",
                textDecoration: "none",
                borderRadius: 4,
                fontSize: 14,
                fontWeight: 500,
              }}
            >
              {args.linkText}
            </a>
          </p>
        ) : null}
      </div>
    </main>
  );
}
