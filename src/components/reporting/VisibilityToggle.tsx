"use client";

// MBR-VIS-1 (2026-10-11) — Visibility toggle button.
//
// Renders a small Eye / EyeOff icon that posts to
// `/api/admin/reporting/monthly/visibility` on click. Only mounted
// when `editing: true`.  Shows a muted "pending" dot when the
// current draft state differs from the previously published state
// so the Controller sees at a glance which rows carry unsaved
// changes.

// Inline eye icons so we don't introduce a new icon-library dep.
// Matches lucide-react's visual design (same stroke width + path
// shape) so the Spectre design language is preserved.
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

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
  /** Current DRAFT state. */
  hidden: boolean;
  /** Previously PUBLISHED state. When different from `hidden`, the
   *  toggle renders a small amber dot in the corner to signal
   *  pending edits. Omit to disable the diff indicator. */
  publishedHidden?: boolean;
  /** Compact size for row-level toggles; default size for cards. */
  size?: "sm" | "md";
  /** Accessible label — defaults to a reasonable component-key copy. */
  label?: string;
};

export function VisibilityToggle({
  reportingYear,
  reportingMonth,
  componentKey,
  hidden,
  publishedHidden,
  size = "md",
  label,
}: VisibilityToggleProps) {
  const router = useRouter();
  const [optimisticHidden, setOptimisticHidden] = useState(hidden);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const dim = size === "sm" ? 14 : 18;
  const Icon = optimisticHidden ? EyeOffIcon : EyeIcon;
  const pending =
    publishedHidden != null && optimisticHidden !== publishedHidden;

  async function onClick() {
    setError(null);
    const next = !optimisticHidden;
    setOptimisticHidden(next);
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
      // Rollback optimistic state on failure.
      setOptimisticHidden(hidden);
      setError(e instanceof Error ? e.message : "Toggle failed.");
    }
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isPending}
      aria-label={
        label ??
        `${optimisticHidden ? "Show" : "Hide"} ${componentKey} in published report`
      }
      title={
        error ??
        `${optimisticHidden ? "Hidden" : "Visible"} in published report${
          pending ? " · pending publish" : ""
        }`
      }
      data-testid={`visibility-toggle-${componentKey}`}
      data-component-key={componentKey}
      data-hidden={optimisticHidden ? "true" : "false"}
      data-pending={pending ? "true" : "false"}
      className={
        "relative inline-flex items-center justify-center rounded " +
        (size === "sm" ? "h-5 w-5" : "h-6 w-6") +
        " " +
        (optimisticHidden
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
