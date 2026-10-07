"use client";

// COA-MAP-3 (2026-10-07) — client-side trigger that opens the
// CreateFsGroupDrawer.  Mounted in the Chart of Accounts header
// actions next to "+ New account" so Controllers can create a
// Financial Statement Group without leaving COA.
//
// Hidden entirely when the viewer lacks `settings:write` — the
// server passes `canCreate` down after resolving the principal.

import { useState } from "react";
import { CreateFsGroupDrawer } from "@/components/coa-mapping/CreateFsGroupDrawer";

export function CreateFsGroupButton({
  clubId,
  canCreate,
}: {
  clubId: string;
  canCreate: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (!canCreate) return null;
  return (
    <>
      <button
        type="button"
        className="spectre-dw-btn secondary"
        onClick={() => setOpen(true)}
        data-testid="coa-new-fs-group-btn"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <rect x="3" y="4" width="18" height="4" rx="1" />
          <rect x="3" y="12" width="18" height="4" rx="1" />
          <path d="M12 20h.01" />
        </svg>
        New FS group
      </button>
      {open && (
        <CreateFsGroupDrawer
          clubId={clubId}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
