"use client";

// Phase 4R rev-4 (2026-08-15) — global search UI.
//
// Compact command-search pattern:
//   • Collapsed = magnifying-glass icon button (matches existing
//     `spectre-btn--icon` chrome).
//   • Active   = inline input in the topbar's left rail, with a
//     compact grouped dropdown of predictive results.
//
// Design rules per founder brief §2, §6, §7, §8:
//   • Click icon → expand + focus input;
//   • typing begins immediately;
//   • Escape closes;
//   • outside-click closes;
//   • debounced fetch (~200 ms) with stale-response protection;
//   • keyboard up/down/enter navigation across all results;
//   • grouped by entity type (VENDORS · AP INVOICES);
//   • restrained typography — no oversized cards, no neon;
//   • navigates via Next router to canonical destinations;
//   • no internal MAIL-XXXX identifiers leaked.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { IconSearch } from "./icons";
import type { GlobalSearchGrouped, GlobalSearchResult } from "@/lib/search/global-search";

const DEBOUNCE_MS = 200;
const MIN_QUERY_LEN = 2;

type Row = GlobalSearchResult & { groupLabel: string };

function flattenGrouped(g: GlobalSearchGrouped): Row[] {
  const out: Row[] = [];
  for (const v of g.vendors) out.push({ ...v, groupLabel: "VENDORS" });
  for (const inv of g.invoices) out.push({ ...inv, groupLabel: "AP INVOICES" });
  return out;
}

export function GlobalSearch() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GlobalSearchGrouped | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeRow, setActiveRow] = useState(0);

  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Stale-response protection — each fetch gets an incrementing id;
  // handlers only apply their response when their id is still the
  // latest one issued.
  const queryIdRef = useRef(0);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const closePanel = useCallback(() => {
    setOpen(false);
    setQuery("");
    setResults(null);
    setError(null);
    setActiveRow(0);
    if (abortRef.current) abortRef.current.abort();
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
  }, []);

  // Focus the input on open.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Outside-click / Escape close.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current && !rootRef.current.contains(t)) closePanel();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closePanel();
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, closePanel]);

  // Debounced fetch.
  useEffect(() => {
    if (!open) return;
    const trimmed = query.trim();
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    if (trimmed.length < MIN_QUERY_LEN) {
      setResults(null);
      setError(null);
      setLoading(false);
      return;
    }
    debounceTimerRef.current = setTimeout(async () => {
      const id = ++queryIdRef.current;
      if (abortRef.current) abortRef.current.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/search/global?q=${encodeURIComponent(trimmed)}`, {
          signal: ctrl.signal,
          headers: { Accept: "application/json" },
        });
        if (id !== queryIdRef.current) return; // stale
        if (!res.ok) {
          setError(`Search error (HTTP ${res.status})`);
          setResults(null);
        } else {
          const body = (await res.json()) as GlobalSearchGrouped;
          if (id !== queryIdRef.current) return; // stale
          setResults(body);
          setActiveRow(0);
        }
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        if (id !== queryIdRef.current) return;
        setError("Search failed.");
        setResults(null);
      } finally {
        if (id === queryIdRef.current) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, [query, open]);

  const rows = results ? flattenGrouped(results) : [];
  const activate = (row: Row) => {
    closePanel();
    router.push(row.href);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveRow((i) => Math.min(rows.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveRow((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      const r = rows[activeRow];
      if (r) {
        e.preventDefault();
        activate(r);
      }
    }
  };

  // Render — collapsed icon OR expanded input + dropdown.
  return (
    <div ref={rootRef} className="spectre-global-search" data-testid="spectre-global-search">
      {open ? (
        <div className="spectre-global-search-expanded" data-testid="spectre-global-search-expanded">
          <IconSearch size={14} />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded={rows.length > 0 || loading || !!error}
            aria-controls="spectre-global-search-dropdown"
            aria-autocomplete="list"
            data-testid="spectre-global-search-input"
            placeholder="Search Spectre…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          {query.trim().length >= MIN_QUERY_LEN && (open || loading) ? (
            <div
              id="spectre-global-search-dropdown"
              className="spectre-global-search-dropdown"
              role="listbox"
              data-testid="spectre-global-search-dropdown"
              data-state={loading ? "loading" : error ? "error" : rows.length === 0 ? "empty" : "results"}
            >
              {loading ? (
                <div className="spectre-global-search-status" data-testid="spectre-global-search-loading">
                  Searching…
                </div>
              ) : error ? (
                <div className="spectre-global-search-status spectre-global-search-status--error">
                  {error}
                </div>
              ) : rows.length === 0 ? (
                <div className="spectre-global-search-status" data-testid="spectre-global-search-empty">
                  No matches for &ldquo;{query.trim()}&rdquo;.
                </div>
              ) : (
                <>
                  {renderGroup("VENDORS", results!.vendors, rows, activeRow, activate)}
                  {renderGroup("AP INVOICES", results!.invoices, rows, activeRow, activate)}
                </>
              )}
            </div>
          ) : null}
        </div>
      ) : (
        <button
          ref={triggerRef}
          type="button"
          aria-label="Search Spectre"
          className="spectre-btn spectre-btn--ghost spectre-btn--icon"
          data-testid="spectre-global-search-trigger"
          onClick={() => setOpen(true)}
        >
          <IconSearch size={16} />
        </button>
      )}
    </div>
  );
}

function renderGroup(
  label: string,
  items: GlobalSearchResult[],
  allRows: Row[],
  activeRowIdx: number,
  activate: (r: Row) => void,
) {
  if (items.length === 0) return null;
  return (
    <div className="spectre-global-search-group" data-testid={`spectre-global-search-group-${label.toLowerCase().replace(/\s+/g, "-")}`}>
      <div className="spectre-global-search-group-label">{label}</div>
      {items.map((it) => {
        const rowIdx = allRows.findIndex((r) => r.id === it.id && r.entityType === it.entityType);
        const active = rowIdx === activeRowIdx;
        return (
          <button
            key={`${it.entityType}:${it.id}`}
            type="button"
            role="option"
            aria-selected={active}
            data-active={active ? "true" : "false"}
            data-testid={`spectre-global-search-row-${it.entityType.toLowerCase()}`}
            className={`spectre-global-search-row${active ? " is-active" : ""}`}
            onClick={() => activate(allRows[rowIdx])}
            onMouseEnter={() => {
              // Match keyboard highlight to hovered row.
              const el = document.querySelector<HTMLElement>(
                `[data-testid="spectre-global-search-row-${it.entityType.toLowerCase()}"]`,
              );
              el?.focus();
            }}
          >
            <div className="spectre-global-search-row-primary">{it.primaryLabel}</div>
            <div className="spectre-global-search-row-secondary">{it.secondaryLabel}</div>
          </button>
        );
      })}
    </div>
  );
}
