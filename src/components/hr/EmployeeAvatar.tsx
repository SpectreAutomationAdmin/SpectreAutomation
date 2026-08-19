// HR-2A (2026-08-16) — EmployeeAvatar.
//
// Small, restrained avatar used by both the Employee Directory and
// the Employee Profile shell. Renders the profile photo when a
// `photoUrl` is supplied; falls back to the employee's initials on
// a subtle stone-tone background so the directory keeps a
// consistent visual rhythm even when photos are missing.
//
// Rendering discipline:
//   • Never renders a cartoon, gradient, or high-saturation ring.
//   • Initials are serif (matching Spectre's editorial headings)
//     and sized proportionally to the avatar.
//   • The background is a monochrome stone tint — no per-employee
//     colour hashing, which reads as SaaS-app noise on a
//     private-club surface.
//
// This component NEVER fetches sensitive employee data. It takes
// only the two name inputs required to render initials plus an
// optional photo URL the parent already resolved.

import { cn } from "@/lib/ui";

export interface EmployeeAvatarProps {
  firstName: string | null | undefined;
  lastName: string | null | undefined;
  /** Optional pre-resolved photo URL (e.g. signed R2 URL or the
   *  document-preview route). When null / undefined, initials render. */
  photoUrl?: string | null;
  /** Rendered pixel diameter. Default 40 — matches directory row height. */
  size?: number;
  className?: string;
}

function initialsFor(firstName: string | null | undefined, lastName: string | null | undefined): string {
  const f = (firstName ?? "").trim();
  const l = (lastName ?? "").trim();
  const initials = `${f.charAt(0)}${l.charAt(0)}`.toUpperCase();
  return initials.length > 0 ? initials : "•";
}

export default function EmployeeAvatar({
  firstName,
  lastName,
  photoUrl,
  size = 40,
  className,
}: EmployeeAvatarProps) {
  const dim = { width: size, height: size };
  if (photoUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- signed URL / data URI; Next/Image would require an allowlist we don't want at this surface
      <img
        src={photoUrl}
        alt=""
        aria-hidden
        className={cn("rounded-full object-cover ring-1 ring-stone-200", className)}
        style={dim}
      />
    );
  }
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center rounded-full bg-stone-100 text-stone-600 font-serif ring-1 ring-stone-200 select-none",
        className,
      )}
      style={{ ...dim, fontSize: Math.round(size * 0.42) }}
      aria-hidden
    >
      {initialsFor(firstName, lastName)}
    </span>
  );
}
