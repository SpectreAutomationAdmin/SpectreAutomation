"use client";

// Phase 2 — Settings workspace proof.
//
// Client wrapper for the club-profile form. Wraps the server-action
// form with a Product-Language §12 save-state indicator (unchanged /
// unsaved / saving / saved / failed) driven by:
//
//   • `useFormStatus`  — surfaces the `pending` state while the
//                        server action is in-flight (React RSC).
//   • `useFormState`   — carries the last completed result back so
//                        we can render "Saved just now" or an inline
//                        error without adding a new toast primitive.
//   • local `dirty`    — computed by comparing every input's current
//                        value against its initial `defaultValue` in
//                        an `onChange` listener on the form.
//
// The server action itself is unchanged — this component only wraps
// it and does not touch persistence.

import { useEffect, useMemo, useRef, useState } from "react";
import { useFormStatus, useFormState } from "react-dom";
import type { ReactNode } from "react";

export type SaveResult =
  | { ok: true; savedAt: string }
  | { ok: false; error: string }
  | null;

/** Live status of the form the user is editing. Rendered near the
 *  primary save action. Never dominates the layout. */
type FormPhase = "unchanged" | "unsaved" | "saving" | "saved" | "failed";

function phaseCopy(phase: FormPhase, savedAt?: string, error?: string): { label: string; tone: "muted" | "info" | "success" | "error" } {
  switch (phase) {
    case "unchanged":
      return { label: "No unsaved changes", tone: "muted" };
    case "unsaved":
      return { label: "Unsaved changes", tone: "info" };
    case "saving":
      return { label: "Saving…", tone: "info" };
    case "saved":
      return { label: savedAt ? `Saved at ${savedAt}` : "Saved", tone: "success" };
    case "failed":
      return { label: error ? `Failed to save · ${error}` : "Failed to save", tone: "error" };
  }
}

// -----------------------------------------------------------------------------
// SaveStatusChip — small, non-dominant status pill near the save action.
// -----------------------------------------------------------------------------

function SaveStatusChip({ phase, savedAt, error }: { phase: FormPhase; savedAt?: string; error?: string }) {
  const { label, tone } = phaseCopy(phase, savedAt, error);
  const badgeClass = (() => {
    switch (tone) {
      case "success": return "spectre-badge spectre-badge--success";
      case "error":   return "spectre-badge spectre-badge--error";
      case "info":    return "spectre-badge spectre-badge--info";
      case "muted":   return "spectre-badge";
    }
  })();
  return (
    <span
      className={badgeClass}
      data-testid="settings-save-status"
      data-phase={phase}
      aria-live="polite"
    >
      {label}
    </span>
  );
}

// -----------------------------------------------------------------------------
// SavingButton — extends the primary save button with a spinner while
// the server action is pending. Uses `spectre-btn--loading` from the
// design language rather than a bespoke pattern.
// -----------------------------------------------------------------------------

function SavingButton({ dirty }: { dirty: boolean }) {
  const status = useFormStatus();
  const disabled = status.pending || !dirty;
  const cls = [
    "spectre-btn",
    "spectre-btn--primary",
    status.pending ? "spectre-btn--loading" : "",
  ].filter(Boolean).join(" ");
  return (
    <button
      type="submit"
      className={cls}
      disabled={disabled}
      aria-disabled={disabled}
      data-testid="settings-save-button"
    >
      Save changes
    </button>
  );
}

// -----------------------------------------------------------------------------
// ClubProfileForm — client wrapper around the server action. Owns:
//   • the `dirty` state (has any input changed?)
//   • the `useFormState` result surface
//   • the save-status chip placement
// The actual <input>/<label>/<textarea> markup is passed as `children`
// so the server component composes the fields exactly as the Product
// Language configuration grammar prescribes.
// -----------------------------------------------------------------------------

export function ClubProfileForm({
  action,
  children,
}: {
  action: (prevState: SaveResult, formData: FormData) => Promise<SaveResult>;
  children: ReactNode;
}) {
  const [state, formAction] = useFormState<SaveResult, FormData>(action, null);
  const [dirty, setDirty] = useState(false);
  const initialRef = useRef<Map<string, string> | null>(null);

  // Capture the initial (defaulted) value of every named input the
  // first time the form renders. Compare against the current value on
  // every input event to compute `dirty`. This is CSS-free and does
  // not require React state per-field.
  const onFormMount = (form: HTMLFormElement | null) => {
    if (!form || initialRef.current) return;
    const snap = new Map<string, string>();
    for (const el of Array.from(form.elements)) {
      const node = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      if (!node.name) continue;
      snap.set(node.name, readValue(node));
    }
    initialRef.current = snap;
  };

  const onInput = (e: React.FormEvent<HTMLFormElement>) => {
    const snap = initialRef.current;
    if (!snap) return;
    const form = e.currentTarget;
    let anyChanged = false;
    for (const el of Array.from(form.elements)) {
      const node = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      if (!node.name) continue;
      const before = snap.get(node.name);
      const now = readValue(node);
      if (before !== now) { anyChanged = true; break; }
    }
    setDirty(anyChanged);
  };

  // On a successful save, reset the initial snapshot to the current
  // values so the next edit toggles dirty again.
  useEffect(() => {
    if (state && state.ok && initialRef.current) {
      const form = document.querySelector<HTMLFormElement>('form[data-testid="settings-club-profile-form"]');
      if (form) {
        const snap = new Map<string, string>();
        for (const el of Array.from(form.elements)) {
          const node = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
          if (!node.name) continue;
          snap.set(node.name, readValue(node));
        }
        initialRef.current = snap;
        setDirty(false);
      }
    }
  }, [state]);

  const phase: FormPhase = useMemo(() => {
    // useFormStatus lives inside the child button; from here we
    // reason about phase via the return value + dirty.
    if (state && state.ok === false) return "failed";
    if (state && state.ok && !dirty) return "saved";
    if (dirty) return "unsaved";
    return "unchanged";
  }, [dirty, state]);

  const savedAt = state && state.ok ? state.savedAt : undefined;
  const errorMessage = state && state.ok === false ? state.error : undefined;

  return (
    <form
      ref={onFormMount}
      action={formAction}
      onInput={onInput}
      className="grid gap-spectre-6"
      data-testid="settings-club-profile-form"
      noValidate
    >
      {children}
      <div className="flex items-center justify-between gap-spectre-3 pt-spectre-3 border-t" style={{ borderColor: "var(--spectre-border-hairline)" }}>
        <SaveStatusChip phase={phase} savedAt={savedAt} error={errorMessage} />
        <div className="flex items-center gap-spectre-2">
          <SavingButton dirty={dirty} />
        </div>
      </div>
    </form>
  );
}

function readValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): string {
  if (el instanceof HTMLInputElement) {
    if (el.type === "checkbox" || el.type === "radio") return el.checked ? "1" : "0";
    return el.value;
  }
  return el.value;
}
