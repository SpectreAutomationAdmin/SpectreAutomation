"use client";

// Founder rule 2026-07-13 v15.14 — client-side disclosure control
// for the Statement of Financial Position's FS-Group summary rows.
//
// This is a minimal Client Component instantiated ONLY for FS-Group
// summary rows whose `accounts` array is populated. The parent
// server-rendered SOFP panel decides whether to render this
// component based on the payload's `showAccountDetail` flag +
// per-row account availability, so:
//
//   - Board / member / PDF payloads never include `accounts` → this
//     component never mounts → no disclosure UI leaks.
//   - Admin payloads with `coa:read` include `accounts` → this
//     component mounts and manages local expansion state.
//
// Expansion state is INTENTIONALLY local. It never persists to the
// server, so a new reporting period always renders every row
// collapsed on first mount (matching the founder's spec: "the
// collapsed state remains the normal presentation").
//
// Accessibility:
//   • `aria-expanded` mirrors the local state.
//   • `aria-controls` points at the sibling detail region.
//   • Enter / Space activate the toggle.
//   • The button is a real `<button>` so screen readers announce
//     the action verb; the sibling text remains selectable.

import { useCallback, useId, useState } from "react";

import type { SoFPRow } from "@/lib/reporting/statement-of-financial-position";

/** Currency formatter matching the SOFP presentation convention.
 *  Duplicated locally (kept small) so this island doesn't drag the
 *  entire body helpers module across the client boundary. */
function formatCurrency(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  const rounded = Math.round(v);
  if (rounded === 0) return "$0";
  const abs = Math.abs(rounded).toLocaleString("en-US");
  return rounded < 0 ? `($${abs})` : `$${abs}`;
}

function valueClass(value: number | null | undefined): string {
  if (value === null || value === undefined) return "text-club-green-900/70";
  return value < 0 ? "text-[#8b3520]" : "text-club-green-900";
}

const SOFP_GRID = "minmax(0, 1fr) 8rem 8rem";
const SOFP_GRID_GAP = "1.2rem";

export function SoFPFsGroupExpandable({ row }: { row: SoFPRow }) {
  const [expanded, setExpanded] = useState(false);
  const detailRegionId = useId();
  const onToggle = useCallback(() => setExpanded((prior) => !prior), []);
  const accounts = row.accounts ?? [];

  return (
    <div
      data-testid={`sofp-row-${row.key}`}
      data-kind="fs-group"
      data-fs-group-key={row.fsGroupKey ?? ""}
      data-expanded={expanded ? "true" : "false"}
      className="border-b border-club-sand/25"
    >
      {/* Summary row — clickable button anchoring the whole row so
          the disclosure works with keyboard + mouse alike. The
          numeric columns retain text-selection because they sit in
          a separate span the button doesn't cover. */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={detailRegionId}
        aria-label={
          expanded
            ? `Collapse underlying accounts for ${row.label ?? "this line"}`
            : `Expand underlying accounts for ${row.label ?? "this line"}`
        }
        data-testid={`sofp-row-${row.key}-toggle`}
        className="grid w-full items-center px-4 py-1.5 bg-club-cream/20 text-left transition-colors hover:bg-club-cream/40 focus:bg-club-cream/40 focus:outline-none focus-visible:ring-1 focus-visible:ring-club-green-900/40"
        style={{ gridTemplateColumns: `1.25rem ${SOFP_GRID}`, columnGap: SOFP_GRID_GAP }}
      >
        {/* Disclosure caret — WCAG-safe aria-hidden decoration. */}
        <span
          aria-hidden="true"
          data-testid={`sofp-row-${row.key}-caret`}
          className="inline-block text-[11px] text-club-green-800/60 select-none"
          style={{
            transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
            transformOrigin: "center",
            transition: "transform 180ms ease",
          }}
        >
          ▸
        </span>
        <span className="text-[13px] text-club-green-900">{row.label}</span>
        <span className={`text-right tabular-nums text-[13px] ${valueClass(row.current)}`}>
          {formatCurrency(row.current)}
        </span>
        <span className={`text-right tabular-nums text-[13px] ${valueClass(row.comparative)}`}>
          {formatCurrency(row.comparative)}
        </span>
      </button>

      {/* Detail region — kept in DOM regardless of expansion state so
          screen readers can announce it (visibility handled via
          hidden attribute). Restrained typography, indented from the
          summary row so it reads as subordinate detail rather than
          another statement line. */}
      <div
        id={detailRegionId}
        role="region"
        data-testid={`sofp-row-${row.key}-detail`}
        hidden={!expanded}
        className="bg-club-cream/10 border-t border-club-sand/25"
      >
        {accounts.map((account) => (
          <div
            key={account.accountCode}
            data-testid={`sofp-row-${row.key}-account-${account.accountCode}`}
            className="grid items-center px-4 py-1 pl-10 text-club-green-900/85"
            style={{ gridTemplateColumns: SOFP_GRID, columnGap: SOFP_GRID_GAP }}
          >
            <span className="text-[12px]">
              <span className="mr-2 tabular-nums text-club-green-800/60">{account.accountCode}</span>
              {account.accountName}
            </span>
            <span className={`text-right tabular-nums text-[12px] ${valueClass(account.current)}`}>
              {formatCurrency(account.current)}
            </span>
            <span className={`text-right tabular-nums text-[12px] ${valueClass(account.comparative)}`}>
              {formatCurrency(account.comparative)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
