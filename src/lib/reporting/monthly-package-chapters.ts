// Single source of truth for the Monthly Reporting Package chapter
// registry.
//
// Used by THREE callers, in lockstep:
//   • `src/app/app/admin/reporting/layout.tsx` (admin reporting
//      shell's left chapter rail)
//   • `src/app/app/reports/monthly-package/[id]/layout.tsx` (board
//      reporting shell's left chapter rail)
//   • `src/app/app/print/monthly-package/page.tsx` (PDF export's
//      auto-generated table of contents)
//
// All three derive from the same array so the rail + the TOC never
// drift apart. To add or rename a chapter, edit ONLY this file.
//
// The shared `ReportingChapter` shape is the public contract the
// chapter rail (in `src/components/reporting/ReportingShell.tsx`)
// expects: `{ number, label, group }`. The section id is derived
// from `label` via `chapterIdFor()` so the rail / TOC anchors stay
// consistent.

import type { ReportingChapter } from "@/components/reporting/ReportingShell";

export const MONTHLY_REPORTING_CHAPTERS: ReadonlyArray<ReportingChapter> = [
  // MEMBER OVERVIEW — the chair's first three reads.
  { number: "I",    label: "Executive Opening",       group: "Member Overview" },
  { number: "II",   label: "Financial Performance",   group: "Member Overview" },
  { number: "III",  label: "Stewardship Dashboard",   group: "Member Overview" },

  // FINANCIAL STATEMENTS — five Saguaro-style board statements.
  { number: "IV",   label: "Statement of Activities", group: "Financial Statements" },
  { number: "V",    label: "Capital Fund",            group: "Financial Statements" },
  { number: "VI",   label: "Capital Projects",        group: "Financial Statements" },
  { number: "VII",  label: "Financial Position",      group: "Financial Statements" },
  { number: "VIII", label: "AR Aging",                group: "Financial Statements" },

  // OPERATIONS & ANALYTICS — six operational chapters.
  { number: "IX",   label: "Operating Statistics",    group: "Operations & Analytics" },
  { number: "X",    label: "Departmental P&L",        group: "Operations & Analytics" },
  { number: "XI",   label: "Weather & Utilization",   group: "Operations & Analytics" },
  { number: "XII",  label: "Payroll Analysis",        group: "Operations & Analytics" },
  { number: "XIII", label: "F&B Statistics",          group: "Operations & Analytics" },
  { number: "XIV",  label: "Inventory Analysis",      group: "Operations & Analytics" },
];
