"use client";

// MBR-VIS-2 (2026-10-11) — Visibility toggle button.
//
// Reads from the client-side VisibilityStateContext so clicks render
// INSTANTLY (every consumer re-renders on the same optimistic write,
// not after a server round-trip).  The Provider owns the API fetch,
// rollback, and audit — this component is a pure UI leaf.
//
// Explicit vs effective (directive §3) — the toggle's `hidden` prop
// MUST be the explicit saved value, never the effective (parent-
// cascaded) value.  A child row's toggle must not collapse to EyeOff
// just because its parent chapter is hidden.
//
// Falls back to local state when rendered OUTSIDE a Provider so the
// MBR-VIS-1 contract tests + any non-editing surface that imports
// this component still compiles.

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useVisibilityState } from "./VisibilityState";

function EyeIcon({ size }: { size: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon({ size }: { size: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
      <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
      <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
      <line x1="2" y1="2" x2="22" y2="22" />
    </svg>
  );
}

export type VisibilityToggleProps = {
  reportingYear: number;
  reportingMonth: number;
  componentKey: string;
  /** Server-passed explicit hidden state — used ONLY to seed the
   *  local fallback when rendered outside a VisibilityStateProvider.
   *  When inside a Provider, the context's `explicitHidden` wins. */
  hidden: boolean;
  /** Server-passed published hidden — same fallback behaviour. */
  publishedHidden?: boolean;
  size?: "sm" | "md";
  label?: string;
};

export function VisibilityToggle({
  reportingYear,
  reportingMonth,
  componentKey,
  hidden: fallbackHidden,
  publishedHidden: fallbackPublishedHidden,
  size = "md",
  label,
}: VisibilityToggleProps) {
  const ctx = useVisibilityState();
  const router = useRouter();

  // Fallback: local state when outside a Provider.
  const [localHidden, setLocalHidden] = useState(fallbackHidden);
  const [localError, setLocalError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const effectiveHidden = ctx ? ctx.explicitHidden(componentKey) : localHidden;
  const pending = ctx
    ? ctx.isPendingPublish(componentKey)
    : fallbackPublishedHidden != null && localHidden !== fallbackPublishedHidden;
  const errorToShow = ctx ? ctx.lastError : localError;

  const dim = size === "sm" ? 14 : 18;
  const Icon = effectiveHidden ? EyeOffIcon : EyeIcon;

  async function onClick() {
    const next = !effectiveHidden;
    if (ctx) {
      await ctx.setHidden(componentKey, next, { reportingYear, reportingMonth });
      return;
    }
    // Legacy fallback path.
    setLocalError(null);
    setLocalHidden(next);
    try {
      const res = await fetch("/api/admin/reporting/monthly/visibility", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reportingYear,
          reportingMonth,
          componentKey,
          hidden: next,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(body.error ?? "Toggle failed.");
      }
      startTransition(() => router.refresh());
    } catch (e) {
      setLocalHidden(effectiveHidden);
      setLocalError(e instanceof Error ? e.message : "Toggle failed.");
    }
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isPending}
      aria-label={
        label ??
        `${effectiveHidden ? "Show" : "Hide"} ${componentKey} in published report`
      }
      title={
        errorToShow ??
        `${effectiveHidden ? "Hidden" : "Visible"} in published report${
          pending ? " · pending publish" : ""
        }`
      }
      data-testid={`visibility-toggle-${componentKey}`}
      data-component-key={componentKey}
      data-hidden={effectiveHidden ? "true" : "false"}
      data-pending={pending ? "true" : "false"}
      className={
        "relative inline-flex items-center justify-center rounded " +
        (size === "sm" ? "h-5 w-5" : "h-6 w-6") +
        " " +
        (effectiveHidden
          ? "text-stone-400 hover:text-stone-600"
          : "text-club-green-700 hover:text-club-green-900") +
        " transition-colors disabled:opacity-50"
      }
    >
      <Icon size={dim} />
      {pending && (
        <span
          aria-hidden="true"
          className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-amber-500"
          data-testid={`visibility-pending-dot-${componentKey}`}
        />
      )}
    </button>
  );
}
