// MBR-VIS-5 (2026-10-11) — shared visibility types for the Monthly
// Reporting Package body + its auxiliary components (ChapterTitleToggle,
// CardVisibilityWrapper).  Extracted from MonthlyReportingPackageBody.tsx
// so leaf components can import the type without a circular dep on the
// 9k-line body file.

export type MonthlyBodyVisibilityConfig = {
  source: "draft" | "published";
  entries: Record<string, boolean>;
};
