"use client";

// Searchable combobox — supports both single-select and multi-select
// modes from one component. Used by the COA mapping table's Type /
// Category / FS Group / Departments controls.
//
// Founder rule 2026-07-17 — modern-ERP single-column model:
//   • Each option occupies ONE row with ONE label. The internal
//     key column + subtitle column + optgroup headers that used
//     to crowd the dropdown are gone. Internal groupings still
//     live in the underlying data model (and `key` / `subtitle`
//     still flow into the search index), they just don't appear
//     in the visible UI.
//   • The popover sizes to the longest option (up to a sensible
//     max) so long labels are fully readable without horizontal
//     scrolling. Only the vertical scrollbar appears, and only
//     when needed.
//   • Rows are taller + padded for readability; hover + active +
//     selected states share a clean treatment.
//   • Keyboard nav scrolls the active row into view automatically.
//   • Multi mode (Departments) adds a leading checkbox; otherwise
//     the row is identical to the single-select layout.
//
// Design notes:
//   • Trigger looks like a Tailwind `input` so the four controls
//     visually align in the mapping table row + bulk bar.
//   • Popover renders inline (absolute-positioned); the COA
//     mapping card sets `overflow-visible` so the popover isn't
//     clipped by the sticky header chrome.
//   • Search input at the top of the popover filters options on
//     `label` AND `key` AND `subtitle` (case-insensitive
//     substring) so an operator can still type "wage" →
//     "Wages and Benefits" or "is_opex_wages" → same.
//   • Keyboard: ArrowDown / ArrowUp navigate the visible filtered
//     list, Enter selects (single) or toggles (multi), Escape
//     closes and returns focus to the trigger.

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

export type PickerOption = {
  value: string;
  label: string;
  /** Optional secondary string searched alongside `label` (e.g. an
   *  internal key like "IS_OPEX_WAGES" that operators may type). */
  key?: string;
  /** Optional secondary subtitle rendered next to the label
   *  (e.g. category accountType context). */
  subtitle?: string;
};

export type PickerOptionGroup = {
  label: string;
  options: PickerOption[];
};

type CommonProps = {
  options?: ReadonlyArray<PickerOption>;
  optgroups?: ReadonlyArray<PickerOptionGroup>;
  placeholder?: string;
  disabled?: boolean;
  testid: string;
  searchPlaceholder?: string;
  /** Wrapper element rendered around the popover. Most callers don't
   *  need this — pass a render-prop to customise. */
  emptyMessage?: ReactNode;
};

type SingleProps = CommonProps & {
  multi?: false;
  value: string | null;
  onChange: (next: string | null) => void;
};

type MultiProps = CommonProps & {
  multi: true;
  value: ReadonlyArray<string>;
  onChange: (next: string[]) => void;
};

export type SearchablePickerProps = SingleProps | MultiProps;

function flatten(options: ReadonlyArray<PickerOption> | undefined, optgroups: ReadonlyArray<PickerOptionGroup> | undefined): PickerOption[] {
  if (options) return [...options];
  if (optgroups) return optgroups.flatMap((g) => g.options);
  return [];
}

function matches(opt: PickerOption, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  if (opt.label.toLowerCase().includes(q)) return true;
  if (opt.key?.toLowerCase().includes(q)) return true;
  if (opt.subtitle?.toLowerCase().includes(q)) return true;
  return false;
}

export function SearchablePicker(props: SearchablePickerProps) {
  const {
    options,
    optgroups,
    placeholder = "Select…",
    disabled,
    testid,
    searchPlaceholder = "Type to search…",
    emptyMessage,
  } = props;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  // Founder rule 2026-07-17 §8: keyboard nav must auto-scroll the
  // highlighted row into view. We keep one DOM ref per option
  // (keyed by value) so arrow keys can pull the active row up
  // even when the list is longer than the popover.
  const optionRefs = useRef<Map<string, HTMLLIElement>>(new Map());

  // Flatten options for label lookup and keyboard nav.
  const allOptions = useMemo(() => flatten(options, optgroups), [options, optgroups]);
  const optionByValue = useMemo(() => {
    const m = new Map<string, PickerOption>();
    for (const o of allOptions) m.set(o.value, o);
    return m;
  }, [allOptions]);

  // Founder rule 2026-07-17: render a single flat list. Optgroup
  // headers are NOT shown in the popover anymore — the operator
  // only needs the label to pick a value. We still iterate
  // optgroups when filtering so `key` / `subtitle` search
  // continues to work for grouped inputs (FS Group).
  const visibleOptions = useMemo(() => {
    return allOptions.filter((o) => matches(o, query));
  }, [allOptions, query]);

  // Trigger label.
  const triggerLabel = useMemo(() => {
    if (props.multi) {
      const codes = (props.value ?? [])
        .map((v) => optionByValue.get(v))
        .filter(Boolean) as PickerOption[];
      if (codes.length === 0) return placeholder;
      return codes.map((o) => o.label).join(", ");
    }
    if (props.value == null || props.value === "") return placeholder;
    return optionByValue.get(props.value)?.label ?? props.value;
  }, [props, optionByValue, placeholder]);

  const isEmptyLabel =
    props.multi ? (props.value?.length ?? 0) === 0 : !props.value;

  // ── Outside click + Escape close ───────────────────────────────
  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (wrapperRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // ── Focus the search input + reset the active row when opening ─
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    // setTimeout so the input is in the DOM when we focus.
    setTimeout(() => searchInputRef.current?.focus(), 0);
  }, [open]);

  // Reset active index whenever the visible-options list shrinks
  // past it (search query narrows the list).
  useEffect(() => {
    if (activeIndex >= visibleOptions.length) {
      setActiveIndex(Math.max(0, visibleOptions.length - 1));
    }
  }, [visibleOptions.length, activeIndex]);

  // Scroll the active row into view whenever activeIndex changes
  // (keyboard nav). Use `block: "nearest"` so a click-driven
  // hover-update doesn't cause a sudden jump — only out-of-view
  // moves scroll.
  useEffect(() => {
    if (!open) return;
    const active = visibleOptions[activeIndex];
    if (!active) return;
    const node = optionRefs.current.get(active.value);
    node?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open, visibleOptions]);

  const onTriggerKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setOpen(true);
    }
  };

  const onPopoverKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(visibleOptions.length - 1, i + 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const opt = visibleOptions[activeIndex];
      if (opt) selectOption(opt);
      return;
    }
  };

  function selectOption(opt: PickerOption) {
    if (props.multi) {
      const set = new Set(props.value);
      if (set.has(opt.value)) set.delete(opt.value);
      else set.add(opt.value);
      props.onChange([...set]);
    } else {
      props.onChange(opt.value);
      setOpen(false);
      triggerRef.current?.focus();
    }
  }

  return (
    <div className="relative" ref={wrapperRef}>
      <button
        type="button"
        ref={triggerRef}
        onClick={() => !disabled && setOpen((v) => !v)}
        onKeyDown={onTriggerKey}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-testid={`${testid}-trigger`}
        data-empty={isEmptyLabel ? "true" : undefined}
        className={
          "input text-xs w-full text-left flex items-center justify-between gap-1 " +
          (isEmptyLabel ? "text-stone-400 " : "text-stone-800 ") +
          (disabled ? "opacity-60 cursor-not-allowed" : "cursor-pointer")
        }
      >
        <span className="truncate">{triggerLabel}</span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className="shrink-0 text-stone-500"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && !disabled && (
        <div
          role="listbox"
          aria-multiselectable={props.multi ? "true" : undefined}
          data-testid={`${testid}-popover`}
          onKeyDown={onPopoverKey}
          // Width: stretch from the trigger's width up to a sane
          // max so long option labels stay fully readable. `w-max`
          // sizes to the widest CHILD without forcing horizontal
          // scroll; `max-w-[28rem]` keeps it from blowing out on
          // a very long label. `min-w-full` ensures the popover
          // is never narrower than the trigger it opens from.
          // `overflow-x-hidden` is the final belt-and-braces
          // guarantee that no horizontal scrollbar ever appears
          // — long labels truncate gracefully via the row's
          // `whitespace-nowrap` + `text-ellipsis` instead.
          className="absolute z-50 mt-1 w-max min-w-full max-w-[28rem] max-h-[20rem] overflow-y-auto overflow-x-hidden rounded-md border border-stone-200 bg-white shadow-lg"
        >
          <div className="sticky top-0 z-10 bg-white border-b border-stone-100 p-1.5">
            <input
              ref={searchInputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={searchPlaceholder}
              data-testid={`${testid}-search`}
              className="input text-xs w-full"
            />
          </div>
          {visibleOptions.length === 0 ? (
            <div className="px-3.5 py-2.5 text-xs text-stone-500" data-testid={`${testid}-empty`}>
              {emptyMessage ?? "No matches."}
            </div>
          ) : (
            <ul role="group" className="py-0.5">
              {visibleOptions.map((opt) => {
                const isSelected = props.multi
                  ? (props.value as ReadonlyArray<string>).includes(opt.value)
                  : props.value === opt.value;
                const isActive = visibleOptions[activeIndex]?.value === opt.value;
                return (
                  <li
                    key={opt.value}
                    role="option"
                    aria-selected={isSelected}
                    data-testid={`${testid}-option-${opt.value}`}
                    data-active={isActive ? "true" : undefined}
                    ref={(el) => {
                      if (el) optionRefs.current.set(opt.value, el);
                      else optionRefs.current.delete(opt.value);
                    }}
                    onMouseEnter={() => {
                      const idx = visibleOptions.findIndex((o) => o.value === opt.value);
                      if (idx >= 0) setActiveIndex(idx);
                    }}
                    onClick={() => selectOption(opt)}
                    // Single-column, taller rows, generous padding,
                    // hover/active/selected treatments. `truncate`
                    // would clip long labels with an ellipsis; we
                    // instead let the popover grow to fit (capped
                    // by max-w on the outer container) so the
                    // operator can always read the full name.
                    className={
                      "flex items-center gap-2 px-3.5 py-2 text-sm cursor-pointer leading-tight " +
                      (isActive
                        ? "bg-club-green-50 text-club-green-900 "
                        : isSelected
                          ? "bg-stone-50 text-stone-900 "
                          : "text-stone-800 hover:bg-stone-50 ")
                    }
                  >
                    {props.multi && (
                      <input
                        type="checkbox"
                        checked={isSelected}
                        readOnly
                        aria-hidden="true"
                        className="h-3.5 w-3.5 shrink-0 pointer-events-none"
                      />
                    )}
                    <span className="flex-1 whitespace-nowrap">{opt.label}</span>
                    {!props.multi && isSelected && (
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="3"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                        className="shrink-0 text-club-green-700"
                      >
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
