/**
 * Canonical kebab-case slug derived from a chapter's visible label.
 *
 * The naming convention 2026-06-19: every chapter's section id is
 * `chapterIdFor(label)`. There is no separate, manually-maintained
 * id field — the visible label is the single source of truth.
 *
 * Conversion rules:
 *   - `&` becomes `and` (with surrounding spaces collapsed) so the
 *     ampersand is preserved as a readable word, not stripped.
 *   - All other non-alphanumerics collapse to single dashes.
 *   - Leading/trailing dashes are trimmed.
 *
 * Examples (asserted by tests/reporting-chapter-id-convention.test.ts):
 *   "Executive Opening"      → "executive-opening"
 *   "Financial Performance"  → "financial-performance"
 *   "AR Aging"               → "ar-aging"
 *   "Departmental P&L"       → "departmental-p-and-l"
 *   "Weather & Utilization"  → "weather-and-utilization"
 *   "F&B Statistics"         → "f-and-b-statistics"
 *   "Operations & Analytics" → "operations-and-analytics"
 *
 * Lives in `src/lib/reporting/` (not the React component file) so
 * server-side code AND vitest tests can import the slugify function
 * without dragging JSX through their respective build pipelines.
 */
export function chapterIdFor(label: string): string {
  return label
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
