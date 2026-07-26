// Spectre Design Language — icon set (Phase 1).
//
// 24 × 24 viewBox, 1.75 stroke-width, round caps + joins. Every icon
// is a stroked React component that inherits `currentColor` so the
// design-language accent, muted, and status tokens control colour.
//
// Size is controlled by callers via `size` prop (14 / 16 / 20 / 24 —
// per Design Language §8). The default is 16 to match the sidebar +
// button icon-to-label rhythm.
//
// Do NOT add domain-specific glyphs to this file. If a workflow
// needs its own iconography (a golf ball, a chef's hat), it ships in
// its own file — this set stays neutral and interface-general.

import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 16, children, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconSearch = (p: IconProps) => (
  <Icon {...p}><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></Icon>
);
export const IconBell = (p: IconProps) => (
  <Icon {...p}><path d="M6 8a6 6 0 0 1 12 0v5l1.5 2h-15L6 13z" /><path d="M10 19a2 2 0 0 0 4 0" /></Icon>
);
export const IconChevronRight = (p: IconProps) => (
  <Icon {...p}><path d="M9 6l6 6-6 6" /></Icon>
);
export const IconChevronLeft = (p: IconProps) => (
  <Icon {...p}><path d="M15 6l-6 6 6 6" /></Icon>
);
export const IconChevronDown = (p: IconProps) => (
  <Icon {...p}><path d="M6 9l6 6 6-6" /></Icon>
);
export const IconChevronUp = (p: IconProps) => (
  <Icon {...p}><path d="M6 15l6-6 6 6" /></Icon>
);
export const IconClose = (p: IconProps) => (
  <Icon {...p}><path d="M6 6l12 12" /><path d="M18 6L6 18" /></Icon>
);
export const IconPlus = (p: IconProps) => (
  <Icon {...p}><path d="M12 5v14" /><path d="M5 12h14" /></Icon>
);
export const IconCheck = (p: IconProps) => (
  <Icon {...p}><path d="M5 12l5 5L20 7" /></Icon>
);
export const IconArrowRight = (p: IconProps) => (
  <Icon {...p}><path d="M4 12h16" /><path d="M14 6l6 6-6 6" /></Icon>
);
export const IconEllipsis = (p: IconProps) => (
  <Icon {...p}><circle cx="6" cy="12" r="1.25" /><circle cx="12" cy="12" r="1.25" /><circle cx="18" cy="12" r="1.25" /></Icon>
);
export const IconUser = (p: IconProps) => (
  <Icon {...p}><circle cx="12" cy="8" r="4" /><path d="M4 20c1.5-4 5-6 8-6s6.5 2 8 6" /></Icon>
);
export const IconPanelLeft = (p: IconProps) => (
  <Icon {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></Icon>
);
export const IconMoon = (p: IconProps) => (
  <Icon {...p}><path d="M20 14.5A8 8 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z" /></Icon>
);
export const IconSun = (p: IconProps) => (
  <Icon {...p}><circle cx="12" cy="12" r="4" /><path d="M12 3v2" /><path d="M12 19v2" /><path d="M5.5 5.5l1.4 1.4" /><path d="M17.1 17.1l1.4 1.4" /><path d="M3 12h2" /><path d="M19 12h2" /><path d="M5.5 18.5l1.4-1.4" /><path d="M17.1 6.9l1.4-1.4" /></Icon>
);
export const IconMonitor = (p: IconProps) => (
  <Icon {...p}><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8" /><path d="M12 16v4" /></Icon>
);
export const IconHome = (p: IconProps) => (
  <Icon {...p}><path d="M4 11l8-7 8 7" /><path d="M6 10v9h12v-9" /></Icon>
);
export const IconInbox = (p: IconProps) => (
  <Icon {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 12h5l2 2h4l2-2h5" /></Icon>
);
export const IconCog = (p: IconProps) => (
  <Icon {...p}><circle cx="12" cy="12" r="3" /><path d="M12 3v2" /><path d="M12 19v2" /><path d="M5 5l1.5 1.5" /><path d="M17.5 17.5L19 19" /><path d="M3 12h2" /><path d="M19 12h2" /><path d="M5 19l1.5-1.5" /><path d="M17.5 6.5L19 5" /></Icon>
);
export const IconFileText = (p: IconProps) => (
  <Icon {...p}><path d="M14 3H6v18h12V7z" /><path d="M14 3v4h4" /><path d="M8 12h8" /><path d="M8 16h6" /></Icon>
);
export const IconWarning = (p: IconProps) => (
  <Icon {...p}><path d="M12 3l10 18H2z" /><path d="M12 10v5" /><path d="M12 18v.5" /></Icon>
);
export const IconInfo = (p: IconProps) => (
  <Icon {...p}><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 7.5v.5" /></Icon>
);
export const IconCheckCircle = (p: IconProps) => (
  <Icon {...p}><circle cx="12" cy="12" r="9" /><path d="M8 12l3 3 5-6" /></Icon>
);
export const IconAlertCircle = (p: IconProps) => (
  <Icon {...p}><circle cx="12" cy="12" r="9" /><path d="M12 8v5" /><path d="M12 16v.5" /></Icon>
);
export const IconLoader = (p: IconProps) => (
  <Icon {...p}><path d="M12 3v3" /><path d="M12 18v3" /><path d="M5.5 5.5l2.1 2.1" /><path d="M16.4 16.4l2.1 2.1" /><path d="M3 12h3" /><path d="M18 12h3" /><path d="M5.5 18.5l2.1-2.1" /><path d="M16.4 7.6l2.1-2.1" /></Icon>
);
export const IconArrowUpDown = (p: IconProps) => (
  <Icon {...p}><path d="M8 4v14" /><path d="M4 8l4-4 4 4" /><path d="M16 4v14" /><path d="M20 14l-4 4-4-4" /></Icon>
);
// Sprint 2 Checkpoint 14C additions — icons required by Mission
// Control email-derived Work Intake action buttons. Mail.Read
// (envelope), reply (curved arrow), edit, and clock.
export const IconMail = (p: IconProps) => (
  <Icon {...p}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 7l9 6 9-6" /></Icon>
);
export const IconReply = (p: IconProps) => (
  <Icon {...p}><path d="M9 8L4 12l5 4" /><path d="M4 12h9a6 6 0 0 1 6 6v1" /></Icon>
);
export const IconEdit = (p: IconProps) => (
  <Icon {...p}><path d="M4 20h4l10-10-4-4L4 16z" /><path d="M14 6l4 4" /></Icon>
);
export const IconClock = (p: IconProps) => (
  <Icon {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Icon>
);
export const IconUserPlus = (p: IconProps) => (
  <Icon {...p}><circle cx="10" cy="8" r="4" /><path d="M2 20c1-4 4-6 8-6s7 2 8 6" /><path d="M18 8v6" /><path d="M15 11h6" /></Icon>
);
export const IconSend = (p: IconProps) => (
  <Icon {...p}><path d="M4 12l16-8-8 16-2-6z" /></Icon>
);
