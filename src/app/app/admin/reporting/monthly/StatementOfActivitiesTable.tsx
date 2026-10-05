"use client";

// REPORT-PRESENTATION-1 §7-10 (2026-10-05) — client-side Statement of
// Activities table that owns expand/collapse state for FS-Group rows.
//
// The server component (MonthlyReportingPackageBody) passes the full
// row dataset (operatingRows + capitalRows) + column headers verbatim.
// This component:
//   • Renders every row via the existing visual language (bands,
//     totals, NOI, detail, etc.).
//   • For `kind === "fs-group"` rows: renders a chevron disclosure
//     control. Default state is COLLAPSED (per directive §7).
//   • For `kind === "fs-group-child"` rows: renders them ONLY when
//     the parent `groupKey` is in the local expanded set.
//
// Expansion is presentation state only — never affects totals, variance,
// Budget, YTD, or exported data (directive §10). The parent FS-Group
// row carries the authoritative aggregate.

import { useState } from "react";
import type {
  StatementOfActivitiesV2Row,
  StatementOfActivitiesV2Values,
} from "@/lib/reporting/statement-of-activities";

// ---------------------------------------------------------------------------
// Shared formatters (copied from MonthlyReportingPackageBody — kept
// in sync to keep the Statement visual language identical).
// ---------------------------------------------------------------------------

function formatStatementValue(value: number | null): string {
  if (value === null) return "—";
  if (value === 0) return "—";
  const abs = Math.abs(Math.round(value));
  const str = abs.toLocaleString("en-US");
  return value < 0 ? `(${str})` : str;
}

function formatStatementPct(value: number | null): string {
  if (value === null) return "—";
  if (value === 0) return "—";
  const pct = (value * 100).toFixed(1);
  return value > 0 ? `+${pct}%` : `${pct}%`;
}

function statementVarianceClass(value: number | null): string {
  if (value === null || value === 0) return "text-club-green-900/55";
  return value > 0 ? "text-[#3f7042] font-medium" : "text-[#8b3520] font-medium";
}

function statementChipClass(tone: "on-plan" | "watch" | "action"): string {
  switch (tone) {
    case "on-plan":
      return "border-club-green-700/40 bg-club-green-700/8 text-club-green-700";
    case "watch":
      return "border-[#b08a4a]/50 bg-[#b08a4a]/10 text-[#8a6d3a]";
    case "action":
      return "border-[#8b3520]/50 bg-[#8b3520]/8 text-[#8b3520]";
  }
}

const STATEMENT_GRID =
  "minmax(0, 1fr) 6.2rem 6.2rem 6.2rem 6.4rem 6.4rem 6.4rem 5rem";
const STATEMENT_GRID_GAP = "1rem";

// ---------------------------------------------------------------------------
// Row value cells — shared across every row kind that carries a 7-value
// payload.
// ---------------------------------------------------------------------------

function StatementValueCells({
  values, baseClass, valueClass, varianceClass,
}: {
  values: StatementOfActivitiesV2Values;
  baseClass: string;
  valueClass?: string;
  varianceClass?: string;
}) {
  return (
    <>
      <span className={`text-right tabular-nums ${baseClass} ${valueClass ?? ""}`}>
        {formatStatementValue(values.currentBudget)}
      </span>
      <span className={`text-right tabular-nums ${baseClass} ${valueClass ?? ""}`}>
        {formatStatementValue(values.currentActual)}
      </span>
      <span className={`text-right tabular-nums ${varianceClass ?? statementVarianceClass(values.currentVariance)}`}>
        {formatStatementValue(values.currentVariance)}
      </span>
      <span className={`text-right tabular-nums ${baseClass} ${valueClass ?? ""}`}>
        {formatStatementValue(values.ytdBudget)}
      </span>
      <span className={`text-right tabular-nums ${baseClass} ${valueClass ?? ""}`}>
        {formatStatementValue(values.ytdActual)}
      </span>
      <span className={`text-right tabular-nums ${varianceClass ?? statementVarianceClass(values.ytdVariance)}`}>
        {formatStatementValue(values.ytdVariance)}
      </span>
      <span className={`text-right tabular-nums ${varianceClass ?? statementVarianceClass(values.variancePct)}`}>
        {formatStatementPct(values.variancePct)}
      </span>
    </>
  );
}

// ---------------------------------------------------------------------------
// Row renderers
// ---------------------------------------------------------------------------

function FsGroupRow({
  row, expanded, onToggle,
}: {
  row: StatementOfActivitiesV2Row;
  expanded: boolean;
  onToggle: () => void;
}) {
  if (!row.values) return null;
  const canExpand = row.isExpandable === true;
  return (
    <div
      data-testid={`soa-row-${row.key}`}
      data-kind="fs-group"
      data-expanded={expanded ? "true" : "false"}
      className="grid items-center px-4 py-1.5 bg-club-cream/25 border-b border-club-sand/35 hover:bg-club-cream/45 font-serif"
      style={{ gridTemplateColumns: STATEMENT_GRID, columnGap: STATEMENT_GRID_GAP }}
    >
      <span className="flex items-center gap-2 text-[13px] text-club-green-900">
        {canExpand ? (
          <button
            type="button"
            onClick={onToggle}
            data-testid={`soa-row-${row.key}-toggle`}
            aria-expanded={expanded}
            aria-label={expanded ? `Collapse ${row.label}` : `Expand ${row.label}`}
            className="flex h-4 w-4 shrink-0 items-center justify-center text-[9px] leading-none text-club-green-800/70 hover:text-club-green-900 focus:outline-none focus-visible:ring-1 focus-visible:ring-club-green-700/50 rounded-sm"
          >
            {expanded ? "⌄" : "›"}
          </button>
        ) : (
          <span aria-hidden="true" className="inline-block h-4 w-4 shrink-0" />
        )}
        <span className="font-medium">{row.label}</span>
      </span>
      <StatementValueCells
        values={row.values}
        baseClass="text-[13px] text-club-green-900"
      />
    </div>
  );
}

function FsGroupChildRow({ row }: { row: StatementOfActivitiesV2Row }) {
  if (!row.values) return null;
  return (
    <div
      data-testid={`soa-row-${row.key}`}
      data-kind="fs-group-child"
      data-group-key={row.groupKey}
      className="grid items-center pl-10 pr-4 py-1 bg-white/60 border-b border-club-sand/15 hover:bg-club-cream/35"
      style={{ gridTemplateColumns: STATEMENT_GRID, columnGap: STATEMENT_GRID_GAP }}
    >
      <span className="flex items-baseline gap-2 text-[12.5px] text-club-green-900/80">
        {row.accountNumber ? (
          <span className="font-mono text-[11px] text-club-green-800/55 tabular-nums">
            {row.accountNumber}
          </span>
        ) : null}
        <span>{row.label}</span>
      </span>
      <StatementValueCells
        values={row.values}
        baseClass="text-[12.5px] text-club-green-900/85"
      />
    </div>
  );
}

function StatementRow({
  row, isCapitalSection, expandedGroups, onToggleGroup,
}: {
  row: StatementOfActivitiesV2Row;
  isCapitalSection: boolean;
  expandedGroups: Set<string>;
  onToggleGroup: (groupKey: string) => void;
}) {
  switch (row.kind) {
    case "fs-group":
      return (
        <FsGroupRow
          row={row}
          expanded={row.groupKey ? expandedGroups.has(row.groupKey) : false}
          onToggle={() => row.groupKey && onToggleGroup(row.groupKey)}
        />
      );
    case "fs-group-child":
      // Only render children whose parent is currently expanded.
      if (!row.groupKey || !expandedGroups.has(row.groupKey)) return null;
      return <FsGroupChildRow row={row} />;
    case "section-band":
      return (
        <div
          data-testid={`soa-row-${row.key}`}
          className="px-4 py-2 uppercase tracking-[0.18em] text-[10.5px] text-[#a08850] bg-[#e8dfc8]/70 border-y border-club-sand/40"
          style={{ gridColumn: "1 / -1" }}
        >
          {row.label}
        </div>
      );
    case "capital-band":
      return (
        <div
          data-testid={`soa-row-${row.key}`}
          className="px-4 py-2 uppercase tracking-[0.18em] text-[10.5px] text-[#4a6280] bg-[#d4e0ec]/55 border-y border-[#bcd0e2]/50"
          style={{ gridColumn: "1 / -1" }}
        >
          {row.label}
        </div>
      );
    case "capital-divider":
      return (
        <div
          data-testid={`soa-row-${row.key}`}
          className="px-4 py-2 uppercase tracking-[0.22em] text-[11px] text-[#4a6280] text-center bg-[#d4e0ec]/70 border-y border-[#bcd0e2]"
          style={{ gridColumn: "1 / -1" }}
        >
          {row.label}
        </div>
      );
    case "capital-intro":
      return (
        <div
          data-testid={`soa-row-${row.key}`}
          className="px-4 py-3 italic text-[13px] leading-snug text-club-green-900/75"
          style={{ gridColumn: "1 / -1" }}
        >
          {row.text}
        </div>
      );
    case "commentary":
      return (
        <div
          data-testid={`soa-row-${row.key}`}
          data-kind="commentary"
          className="px-6 py-2 italic text-[12.5px] leading-snug text-club-green-900/70 bg-club-cream/40"
          style={{ gridColumn: "1 / -1" }}
        >
          {row.text}
        </div>
      );
    case "noi-band": {
      if (!row.values) return null;
      return (
        <div
          data-testid={`soa-row-${row.key}`}
          data-kind="noi-band"
          className="grid items-center px-4 py-3 bg-club-green-900 text-club-cream font-serif"
          style={{ gridTemplateColumns: STATEMENT_GRID, columnGap: STATEMENT_GRID_GAP }}
        >
          <span className="font-semibold text-[14px]">{row.label}</span>
          <StatementValueCells
            values={row.values}
            baseClass="text-[13.5px] text-club-cream font-medium"
          />
        </div>
      );
    }
    case "noi-after": {
      if (!row.values) return null;
      return (
        <div
          data-testid={`soa-row-${row.key}`}
          data-kind="noi-after"
          className="grid items-center px-4 py-2.5 bg-[#e8dfc8]/55 border-y border-club-sand/40 font-serif italic"
          style={{ gridTemplateColumns: STATEMENT_GRID, columnGap: STATEMENT_GRID_GAP }}
        >
          <span className="font-semibold text-[13px] text-club-green-900">{row.label}</span>
          <StatementValueCells
            values={row.values}
            baseClass="text-[13px] text-club-green-900 font-semibold"
          />
        </div>
      );
    }
    case "capital-total": {
      if (!row.values) return null;
      return (
        <div
          data-testid={`soa-row-${row.key}`}
          data-kind="capital-total"
          className="grid items-center px-4 py-2.5 bg-[#d4e0ec]/60 border-y border-[#bcd0e2] font-serif italic"
          style={{ gridTemplateColumns: STATEMENT_GRID, columnGap: STATEMENT_GRID_GAP }}
        >
          <span className="font-semibold text-[13px] text-club-green-900">{row.label}</span>
          <StatementValueCells
            values={row.values}
            baseClass="text-[13px] text-club-green-900 font-semibold"
          />
        </div>
      );
    }
    case "net-combined": {
      if (!row.values) return null;
      return (
        <div
          data-testid={`soa-row-${row.key}`}
          data-kind="net-combined"
          className="grid items-center px-4 py-3 bg-[#e8dfc8]/85 border-y border-club-sand font-serif italic"
          style={{ gridTemplateColumns: STATEMENT_GRID, columnGap: STATEMENT_GRID_GAP }}
        >
          <span className="font-semibold text-[14px] text-club-green-900">{row.label}</span>
          <StatementValueCells
            values={row.values}
            baseClass="text-[13.5px] text-club-green-900 font-semibold"
          />
        </div>
      );
    }
    case "subtotal":
    case "total": {
      if (!row.values) return null;
      const isTotal = row.kind === "total";
      return (
        <div
          data-testid={`soa-row-${row.key}`}
          data-kind={row.kind}
          className={`grid items-center px-4 py-2 ${
            isTotal
              ? "bg-[#e8dfc8]/65 border-y border-club-sand/55"
              : "bg-[#e8dfc8]/35 border-y border-club-sand/30"
          } font-serif italic`}
          style={{ gridTemplateColumns: STATEMENT_GRID, columnGap: STATEMENT_GRID_GAP }}
        >
          <span className="font-semibold text-[13px] text-club-green-900">{row.label}</span>
          <StatementValueCells
            values={row.values}
            baseClass="text-[13px] text-club-green-900 font-semibold"
          />
        </div>
      );
    }
    case "depreciation":
    case "detail":
    default: {
      if (!row.values) return null;
      return (
        <div
          data-testid={`soa-row-${row.key}`}
          data-kind="detail"
          className={`grid items-center px-4 py-1.5 ${
            isCapitalSection ? "bg-club-cream/10" : "bg-club-cream/20"
          } border-b border-club-sand/25 hover:bg-club-cream/45`}
          style={{ gridTemplateColumns: STATEMENT_GRID, columnGap: STATEMENT_GRID_GAP }}
        >
          <span className="flex items-center gap-2 text-[13px] text-club-green-900">
            {row.label}
            {row.chip ? (
              <span
                data-testid={`soa-row-${row.key}-chip`}
                className={`inline-flex items-center rounded-sm border px-1.5 py-0.5 text-[9.5px] uppercase tracking-[0.18em] ${statementChipClass(row.chip.tone)}`}
              >
                {row.chip.label}
              </span>
            ) : null}
          </span>
          <StatementValueCells
            values={row.values}
            baseClass="text-[13px] text-club-green-900"
          />
        </div>
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Table shell — operating + capital sections with shared expand state
// ---------------------------------------------------------------------------

type ColumnHeaders = {
  category: string;
  currentBudget: string;
  currentActual: string;
  currentVariance: string;
  ytdBudget: string;
  ytdActual: string;
  ytdVariance: string;
  variancePct: string;
};

function StatementColumnHeaderRow({ headers }: { headers: ColumnHeaders }) {
  return (
    <div
      data-testid="soa-column-headers"
      className="grid items-end px-4 py-2 uppercase tracking-[0.18em] text-[10px] text-club-green-800/60 bg-[#e8dfc8]/40 border-y border-club-sand/40"
      style={{ gridTemplateColumns: STATEMENT_GRID, columnGap: STATEMENT_GRID_GAP }}
    >
      <span className="text-left">{headers.category}</span>
      <span className="text-right">{headers.currentBudget}</span>
      <span className="text-right">{headers.currentActual}</span>
      <span className="text-right">{headers.currentVariance}</span>
      <span className="text-right">{headers.ytdBudget}</span>
      <span className="text-right">{headers.ytdActual}</span>
      <span className="text-right">{headers.ytdVariance}</span>
      <span className="text-right">{headers.variancePct}</span>
    </div>
  );
}

export function StatementOfActivitiesTable({
  operatingRows,
  capitalRows,
  columnHeaders,
}: {
  operatingRows: ReadonlyArray<StatementOfActivitiesV2Row>;
  capitalRows: ReadonlyArray<StatementOfActivitiesV2Row>;
  columnHeaders: ColumnHeaders;
}) {
  // Default COLLAPSED (per directive §7). Expansion is per-group,
  // viewer-session local — never affects totals / Budget / variance.
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const onToggleGroup = (groupKey: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      return next;
    });
  };

  return (
    <>
      {/* Operating section table */}
      <div
        data-testid="soa-table-operating"
        className="mt-6 overflow-hidden rounded-md border border-club-sand/60"
      >
        <StatementColumnHeaderRow headers={columnHeaders} />
        {operatingRows.map((row) => (
          <StatementRow
            key={row.key}
            row={row}
            isCapitalSection={false}
            expandedGroups={expandedGroups}
            onToggleGroup={onToggleGroup}
          />
        ))}
      </div>

      {/* Capital section — divider band + capital subtable with its own column headers. */}
      <div data-testid="soa-table-capital" className="mt-4">
        <div
          className="grid"
          style={{ gridTemplateColumns: STATEMENT_GRID, columnGap: STATEMENT_GRID_GAP }}
        >
          {capitalRows
            .filter((r) => r.kind === "capital-divider" || r.kind === "capital-intro")
            .map((row) => (
              <StatementRow
                key={row.key}
                row={row}
                isCapitalSection={true}
                expandedGroups={expandedGroups}
                onToggleGroup={onToggleGroup}
              />
            ))}
        </div>
        <div className="mt-3 overflow-hidden rounded-md border border-[#bcd0e2]/70">
          <div
            data-testid="soa-capital-column-headers"
            className="grid items-end px-4 py-2 uppercase tracking-[0.18em] text-[10px] text-[#4a6280] bg-[#d4e0ec]/40 border-b border-[#bcd0e2]/50"
            style={{ gridTemplateColumns: STATEMENT_GRID, columnGap: STATEMENT_GRID_GAP }}
          >
            <span className="text-left">Capital Fund Activity</span>
            <span className="text-right">{columnHeaders.currentBudget}</span>
            <span className="text-right">{columnHeaders.currentActual}</span>
            <span className="text-right">{columnHeaders.currentVariance}</span>
            <span className="text-right">{columnHeaders.ytdBudget}</span>
            <span className="text-right">{columnHeaders.ytdActual}</span>
            <span className="text-right">{columnHeaders.ytdVariance}</span>
            <span className="text-right">{columnHeaders.variancePct}</span>
          </div>
          {capitalRows
            .filter((r) => r.kind !== "capital-divider" && r.kind !== "capital-intro")
            .map((row) => (
              <StatementRow
                key={row.key}
                row={row}
                isCapitalSection={true}
                expandedGroups={expandedGroups}
                onToggleGroup={onToggleGroup}
              />
            ))}
        </div>
      </div>
    </>
  );
}
