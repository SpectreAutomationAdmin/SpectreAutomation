// TA-1B closeout (2026-09-03) — Admin invitation landing page.
//
// Public route (no admin session required). Renders the correct
// activation shell based on server-side introspection of the invitation:
//
//   New user (invitation email has no matching User)
//     → InvitationActivationForm (Create your Spectre account)
//
//   Existing user + no current session
//     → sign-in prompt with return path back to this page
//
//   Existing user + session matches invitation email
//     → AcceptInvitationButton (single-click accept)
//
//   Existing user + session belongs to a different email
//     → safe refusal message
//
// Also marks the invitation OPENED on server-side render.

import { getCurrentUser } from "@/lib/session";
import { describeInvitationForLanding, markInvitationOpened } from "@/lib/tenant-admin/invitations";
import { InvitationActivationForm } from "./InvitationActivationForm";
import { AcceptInvitationButton } from "./AcceptInvitationButton";

export const dynamic = "force-dynamic";

interface Params { params: { token: string } }

export default async function InvitationActivationPage({ params }: Params) {
  const token = params.token;
  let summary: Awaited<ReturnType<typeof describeInvitationForLanding>>;
  try {
    summary = await describeInvitationForLanding(token);
  } catch {
    return renderMessage({
      title: "Invitation not found",
      body: "This invitation link is invalid, has already been activated, or has been revoked. Ask the person who invited you to send a new one.",
    });
  }

  if (summary.status === "ACTIVATED") {
    return renderMessage({
      title: "Invitation already activated",
      body: "This invitation has already been used. Sign in with your existing password, or ask the person who invited you to send a new one.",
      linkHref: "/login",
      linkText: "Go to sign-in",
    });
  }
  if (summary.status === "REVOKED") {
    return renderMessage({
      title: "Invitation revoked",
      body: "This invitation has been revoked. Ask the person who invited you to send a new one.",
    });
  }
  if (summary.status === "EXPIRED" || summary.expiresAt.getTime() < Date.now()) {
    return renderMessage({
      title: "Invitation expired",
      body: "This invitation has expired. Ask the person who invited you to send a new one.",
    });
  }

  try { await markInvitationOpened(token); } catch { /* ignore */ }

  const inviterLabel = summary.inviterName ?? "A Club Administrator";

  // Path branch (§4-§7).
  if (summary.requiresExistingUserSignIn) {
    const currentUser = await getCurrentUser();
    if (!currentUser) {
      return renderCard(summary, inviterLabel, (
        <div data-testid="invite-existing-user-signin">
          <p style={{ margin: "0 0 20px 0", fontSize: 14, color: "#4a453d", lineHeight: 1.55 }}>
            This email is already a Spectre account. Sign in to accept this invitation.
          </p>
          <a
            href={`/login?next=${encodeURIComponent(`/invite/${token}`)}`}
            style={ctaLinkStyle}
            data-testid="invite-signin-link"
          >
            Sign in to accept
          </a>
        </div>
      ));
    }
    // Signed in — is it the right account?
    if (currentUser.email.toLowerCase() !== summary.email.toLowerCase()) {
      return renderCard(summary, inviterLabel, (
        <div data-testid="invite-wrong-session">
          <p style={{ margin: "0 0 12px 0", fontSize: 14, color: "#7f1d1d", lineHeight: 1.55, background: "#fef2f2", border: "1px solid #b91c1c", padding: 12, borderRadius: 6 }}>
            This invitation was sent to <strong>{summary.email}</strong>, but you're signed in as <strong>{currentUser.email}</strong>.
          </p>
          <p style={{ margin: "0 0 20px 0", fontSize: 14, color: "#4a453d", lineHeight: 1.55 }}>
            Sign out and sign in as the invited account to accept.
          </p>
          <a
            href={`/api/logout?next=${encodeURIComponent(`/login?next=${encodeURIComponent(`/invite/${token}`)}`)}`}
            style={ctaLinkStyle}
            data-testid="invite-signout-link"
          >
            Sign out
          </a>
        </div>
      ));
    }
    // Correct session — one-click accept.
    return renderCard(summary, inviterLabel, (
      <AcceptInvitationButton token={token} />
    ));
  }

  // New-user path (A).
  return renderCard(summary, inviterLabel, (
    <InvitationActivationForm token={token} suggestedName={summary.displayName} />
  ));
}

function renderCard(
  summary: Awaited<ReturnType<typeof describeInvitationForLanding>>,
  inviterLabel: string,
  actionArea: React.ReactNode,
) {
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
          {summary.clubName}
        </div>
        <h1 style={{ marginTop: 8, marginBottom: 0, fontSize: 24, fontWeight: 600, color: "#1a1a1a" }}>
          {summary.requiresExistingUserSignIn ? "Accept your Spectre invitation" : "Create your Spectre account"}
        </h1>
        <p style={{ marginTop: 16, marginBottom: 24, fontSize: 14, color: "#4a453d", lineHeight: 1.5 }}>
          {inviterLabel} has invited you to help operate {summary.clubName} on Spectre.
        </p>
        <dl
          style={{
            marginBottom: 24, padding: 16, background: "#f9f5eb", borderRadius: 6, fontSize: 13,
            display: "grid", gridTemplateColumns: "auto 1fr", columnGap: 12, rowGap: 6,
          }}
        >
          <dt style={{ color: "#6b6357", fontWeight: 500 }}>Email</dt>
          <dd style={{ color: "#1a1a1a", margin: 0 }} data-testid="invite-email">{summary.email}</dd>
          {summary.displayTitle ? (
            <>
              <dt style={{ color: "#6b6357", fontWeight: 500 }}>Title</dt>
              <dd style={{ color: "#1a1a1a", margin: 0 }} data-testid="invite-title">{summary.displayTitle}</dd>
            </>
          ) : null}
          <dt style={{ color: "#6b6357", fontWeight: 500 }}>Expires</dt>
          <dd style={{ color: "#1a1a1a", margin: 0 }}>{summary.expiresAt.toDateString()}</dd>
        </dl>
        {actionArea}
      </div>
    </main>
  );
}

function renderMessage(args: { title: string; body: string; linkHref?: string; linkText?: string }) {
  return (
    <main
      style={{
        minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
        background: "var(--spectre-surface-cream, #f6f1e6)", padding: "48px 16px",
      }}
    >
      <div
        style={{
          maxWidth: 480, width: "100%", background: "white", borderRadius: 8,
          boxShadow: "0 2px 32px rgba(0,0,0,0.06)", padding: 40,
        }}
        data-testid="invite-message-card"
      >
        <h1 style={{ marginTop: 0, marginBottom: 12, fontSize: 22, fontWeight: 600, color: "#1a1a1a" }}>
          {args.title}
        </h1>
        <p style={{ margin: 0, color: "#4a453d", fontSize: 14, lineHeight: 1.5 }}>{args.body}</p>
        {args.linkHref && args.linkText ? (
          <p style={{ marginTop: 24 }}>
            <a href={args.linkHref} style={ctaLinkStyle}>{args.linkText}</a>
          </p>
        ) : null}
      </div>
    </main>
  );
}

const ctaLinkStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "10px 20px",
  background: "#1e3a2a",
  color: "white",
  textDecoration: "none",
  borderRadius: 6,
  fontSize: 14,
  fontWeight: 600,
};
