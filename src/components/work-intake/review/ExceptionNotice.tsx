// AP-UX-1a (2026-10-13) — reusable ExceptionNotice primitive.
//
// Restrained outlined card used anywhere Spectre needs to surface
// an "attention required" state above (or near) the content it
// qualifies — e.g. the Invoice Details card's vendor-match
// exception.
//
// Design posture:
//   - No oversized dashboard chrome.  Thin 1 px hairline + warm
//     ivory background matching the WI-2A review namespace tokens.
//   - Icon slot is restrained — a single stroked glyph the caller
//     picks; the component does NOT inject stoplight red fills.
//   - Up to two contextual actions (primary + ghost).  Actions are
//     always rendered by the caller — the primitive owns no
//     mutation behaviour of its own and never asserts a successful
//     operation.
//   - Entrance animation is a brief 150 ms fade + 4 px translate.
//     Honours `prefers-reduced-motion` (the animation collapses to
//     an instant appearance when the user has reduced motion on).
//   - No continuous pulsing / breathing — motion fires once on
//     mount per the AP-UX-1a §3 directive.

import type { ReactNode } from "react";

export type ExceptionNoticeTone = "attention" | "informational";

export interface ExceptionAction {
  label: string;
  href?: string;
  onClick?: () => void;
  variant?: "primary" | "ghost";
  disabled?: boolean;
  /** Opens in a new tab when `href` + `external: true`.
   *  The caller is responsible for including rel="noreferrer". */
  external?: boolean;
}

export interface ExceptionNoticeProps {
  /** Short, declarative headline — e.g. "Vendor match required". */
  headline: string;
  /** One sentence of grounded context.  Never speculative.  The
   *  caller composes this from authoritative state fields. */
  body: ReactNode;
  /** Optional icon slot — a restrained stroked glyph.  Caller
   *  controls — primitive never fabricates a stoplight colour. */
  icon?: ReactNode;
  /** 0, 1, or 2 contextual actions.  Primary first, ghost second. */
  actions?: ExceptionAction[];
  /** Visual weight.  `attention` = warm gold hairline + muted
   *  ivory background.  `informational` = neutral hairline for
   *  non-blocking context. */
  tone?: ExceptionNoticeTone;
  /** Data-attribute testid for Playwright targeting. */
  testid?: string;
}

const ACTION_CLASS: Record<"primary" | "ghost", string> = {
  primary: "ap-ux-exception-action ap-ux-exception-action--primary",
  ghost: "ap-ux-exception-action ap-ux-exception-action--ghost",
};

function AlertGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
      <path
        d="M10 3l7.5 13.5h-15L10 3z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path
        d="M10 8v4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <circle cx="10" cy="14.5" r="0.9" fill="currentColor" />
    </svg>
  );
}

export default function ExceptionNotice({
  headline,
  body,
  icon,
  actions,
  tone = "attention",
  testid,
}: ExceptionNoticeProps) {
  return (
    <aside
      className={`ap-ux-exception ap-ux-exception--${tone}`}
      role="status"
      aria-live="polite"
      data-testid={testid ?? "ap-ux-exception"}
      data-tone={tone}
    >
      <div className="ap-ux-exception-icon" aria-hidden="true">
        {icon ?? <AlertGlyph />}
      </div>
      <div className="ap-ux-exception-body">
        <div className="ap-ux-exception-headline">{headline}</div>
        <div className="ap-ux-exception-text">{body}</div>
      </div>
      {actions && actions.length > 0 ? (
        <div className="ap-ux-exception-actions">
          {actions.slice(0, 2).map((a, i) => {
            const className = ACTION_CLASS[a.variant ?? (i === 0 ? "primary" : "ghost")];
            if (a.href) {
              return (
                <a
                  key={`${a.label}-${i}`}
                  href={a.disabled ? undefined : a.href}
                  className={className}
                  data-testid={`ap-ux-exception-action-${i}`}
                  aria-disabled={a.disabled ? "true" : undefined}
                  target={a.external ? "_blank" : undefined}
                  rel={a.external ? "noreferrer" : undefined}
                >
                  {a.label}
                </a>
              );
            }
            return (
              <button
                key={`${a.label}-${i}`}
                type="button"
                className={className}
                onClick={a.onClick}
                disabled={a.disabled}
                data-testid={`ap-ux-exception-action-${i}`}
              >
                {a.label}
              </button>
            );
          })}
        </div>
      ) : null}
    </aside>
  );
}
