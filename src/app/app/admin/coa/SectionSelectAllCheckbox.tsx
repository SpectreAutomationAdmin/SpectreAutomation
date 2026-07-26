"use client";

// Founder rule 2026-07-02 v15.3 — section-level select-all for the
// Fund Applicability assignment workflow.
//
// The CoA page in Fund mode renders one FS-Group section per
// revenue / expense group (e.g. "Membership Revenue — 31
// accounts"). This client component mounts a master checkbox
// inside the section header that:
//
//   1. Selects / deselects every row-level bulk checkbox in the
//      SAME section on click.
//   2. Reflects the current selection state — checked when all
//      rows in the section are ticked, indeterminate when some
//      but not all are ticked, unchecked when none.
//   3. Only affects rows that are actually rendered — so
//      pre-existing fund / active filters flow through naturally.
//   4. Posts nothing itself (no `name` attribute) — the row
//      checkboxes carry the accountIds that ship to the server
//      action.
//
// Kept intentionally small (single file, no shared state, no
// custom hooks) so the section headers stay a straight
// SSR-render with a client checkbox slotted in.

import { useEffect, useRef } from "react";

export function SectionSelectAllCheckbox({
  sectionKey,
  testId,
  label,
}: {
  /**
   * Value matched against `data-section-key` on the surrounding
   * section wrapper. The client component scopes every DOM query
   * to that wrapper so multiple sections on the same page never
   * cross-wire.
   */
  sectionKey: string;
  testId: string;
  /**
   * Accessible label for screen readers. Not rendered visually —
   * the visible label lives beside the checkbox on the page.
   */
  label: string;
}) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const master = ref.current;
    if (!master) return;

    // The section wrapper `[data-section-key=...]` is a Server
    // Component render, so it's present when this effect runs.
    const attr = `data-section-key="${sectionKey.replace(/"/g, '\\"')}"`;
    const query = `[${attr}] input[type="checkbox"][name="accountIds"]`;
    const rows = () =>
      Array.from(document.querySelectorAll<HTMLInputElement>(query));

    const recomputeMaster = () => {
      const list = rows();
      if (list.length === 0) {
        master.checked = false;
        master.indeterminate = false;
        return;
      }
      const checkedCount = list.filter((el) => el.checked).length;
      if (checkedCount === 0) {
        master.checked = false;
        master.indeterminate = false;
      } else if (checkedCount === list.length) {
        master.checked = true;
        master.indeterminate = false;
      } else {
        master.checked = false;
        master.indeterminate = true;
      }
    };

    const onMasterChange = () => {
      const list = rows();
      // The master's `checked` after the browser processed the
      // click is the target state for every row in the section.
      const target = master.checked;
      for (const el of list) el.checked = target;
      // Re-derive master state so the indeterminate cue is cleared
      // once every row is aligned.
      recomputeMaster();
    };

    const onRowChange = () => recomputeMaster();

    master.addEventListener("change", onMasterChange);
    const list = rows();
    for (const el of list) el.addEventListener("change", onRowChange);
    recomputeMaster();

    return () => {
      master.removeEventListener("change", onMasterChange);
      for (const el of list) el.removeEventListener("change", onRowChange);
    };
  }, [sectionKey]);

  return (
    <input
      ref={ref}
      type="checkbox"
      className="mr-2 align-middle"
      aria-label={label}
      // Wire the master into the bulk fund form so tabbing hits it,
      // but without a `name` attribute so no value is submitted.
      form="coa-bulk-fund-form"
      data-testid={testId}
      data-section-master-key={sectionKey}
    />
  );
}
