"use client";

// Sprint 1 correction (2026-07-19d) — Chart of Accounts Import
// Modal. Renders inside the CoA workspace at `/app/admin/coa` when
// the URL carries `?modal=import`. Reuses the existing production
// CoA import pipeline via `createCoaImportBatchFromModalAction` in
// `../../src/app/app/admin/coa/_import-actions.ts`, which delegates
// to the same `createBatch` / `applyCoaAutoMapping` / `validateBatch`
// library functions the generic imports page has always used.
//
// This modal is the ENTRY POINT ONLY — after a successful upload the
// server action redirects the operator to the existing batch-detail
// mapping page (`/app/admin/imports/<batchId>`). No parallel mapping
// UI is created here.

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createCoaImportBatchFromModalAction } from "@/app/app/admin/coa/_import-actions";

const MAX_FILE_BYTES = 10 * 1024 * 1024; // Must match the server-side cap.
const ACCEPTED_EXTS = [".xlsx", ".csv"] as const;
const ACCEPT_ATTR = ACCEPTED_EXTS.join(",");

type Props = {
  /** URL to return to when the modal closes — preserves everything
   *  except the `modal` param. Server-computed so we do not need to
   *  reason about which search params are meaningful. */
  closeHref: string;
  /** Server-side error surfaced via `?error=...` — the wrapper action
   *  bounces here with a message when parsing / validation fails. */
  initialError: string | null;
};

type Validation =
  | { kind: "none" }
  | { kind: "invalid-type"; ext: string }
  | { kind: "too-large"; bytes: number }
  | { kind: "empty" };

function validateFile(file: File): Validation {
  const ext = "." + (file.name.split(".").pop() ?? "").toLowerCase();
  if (!ACCEPTED_EXTS.includes(ext as (typeof ACCEPTED_EXTS)[number])) {
    return { kind: "invalid-type", ext };
  }
  if (file.size === 0) return { kind: "empty" };
  if (file.size > MAX_FILE_BYTES) return { kind: "too-large", bytes: file.size };
  return { kind: "none" };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export default function ChartOfAccountsImportModal({ closeHref, initialError }: Props) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [validation, setValidation] = useState<Validation>({ kind: "none" });
  const [dragActive, setDragActive] = useState(false);
  const [pending, startTransition] = useTransition();
  const [clientError, setClientError] = useState<string | null>(null);
  const dropZoneRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  // Focus trap + focus return. On open, remember what had focus and
  // move focus into the dialog. On close, restore it. Esc closes.
  useEffect(() => {
    openerRef.current = (document.activeElement as HTMLElement | null) ?? null;
    // Small delay so the modal is mounted before we focus into it.
    const raf = requestAnimationFrame(() => {
      dropZoneRef.current?.focus();
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (pending) return; // Do not close mid-upload.
        e.preventDefault();
        router.replace(closeHref);
      }
      if (e.key === "Tab" && dialogRef.current) {
        const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
          "button, [href], input, [tabindex]:not([tabindex='-1'])",
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("keydown", onKey);
      openerRef.current?.focus?.();
    };
  }, [router, closeHref, pending]);

  const chooseFile = useCallback((next: File | null) => {
    setClientError(null);
    if (!next) {
      setFile(null);
      setValidation({ kind: "none" });
      return;
    }
    const v = validateFile(next);
    setValidation(v);
    setFile(v.kind === "none" ? next : null);
  }, []);

  const onDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(true);
  };
  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Only clear when the pointer leaves the drop zone itself, not a
    // child element hovering back and forth.
    if (dropZoneRef.current && !dropZoneRef.current.contains(e.relatedTarget as Node)) {
      setDragActive(false);
    }
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    const dropped = e.dataTransfer.files?.[0] ?? null;
    chooseFile(dropped);
  };

  const removeFile = () => {
    chooseFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const onDropZoneKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fileInputRef.current?.click();
    }
  };

  const guardCloseClick = (e: React.MouseEvent) => {
    if (pending) {
      e.preventDefault();
      if (!window.confirm("Upload is in progress. Cancel it and close?")) return;
    }
  };

  // Backdrop click closes ONLY when the click is on the backdrop
  // itself, never on a child of the dialog. Matches the existing
  // `AccountModal` behaviour in the CoA workspace.
  const onBackdropClick = (e: React.MouseEvent) => {
    if (pending) return;
    if (e.target === e.currentTarget) {
      router.replace(closeHref);
    }
  };

  // Server-error message: prefer client-side validation feedback, then
  // fall back to the URL `?error=` message the server action bounced
  // with. Clearing the URL error requires either dismissing the modal
  // or replacing the file, so a stale server error does not linger.
  const errorMessage =
    clientError ??
    (validation.kind === "invalid-type"
      ? `Unsupported file type ("${validation.ext}"). Upload an .xlsx workbook or a .csv file.`
      : validation.kind === "too-large"
        ? `File is ${formatBytes(validation.bytes)}. The maximum is 10 MB.`
        : validation.kind === "empty"
          ? "The selected file is empty."
          : initialError);

  const canProceed = !!file && validation.kind === "none" && !pending;

  const handleSubmit = () => {
    if (!file || validation.kind !== "none") {
      setClientError("Choose a valid .xlsx or .csv file first.");
      return;
    }
    // Sprint 3 Checkpoint 15I-3 (2026-07-27) — Build FormData from
    // the React `file` state, NOT `new FormData(form)`.
    //
    // Why: `new FormData(form)` reads `<input type="file">.files`,
    // which browsers only populate when the user picks via the
    // native file picker. Files added via drag-and-drop live only
    // in component state — the input's FileList stays empty because
    // the DataTransfer API doesn't cross into <input>. That meant
    // the visible "selected file" card came from React state, the
    // submitted FormData was empty, and the server correctly bounced
    // with "Choose an .xlsx or .csv file before submitting."
    //
    // Building the FormData manually from state closes both the
    // drop path and the click path with a single guarantee: whatever
    // the user visibly selected is what gets uploaded.
    const fd = new FormData();
    fd.append("file", file, file.name);
    startTransition(() => {
      void createCoaImportBatchFromModalAction(fd);
    });
  };

  return (
    <div
      className="spectre-dw-import-backdrop"
      onClick={onBackdropClick}
      data-testid="coa-import-modal-backdrop"
    >
      <div
        ref={dialogRef}
        className="spectre-dw-import-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="coa-import-title"
        data-testid="coa-import-modal"
      >
        <div className="spectre-dw-import-head">
          <div>
            <div className="spectre-dw-import-eyebrow">Data · Chart of Accounts</div>
            <h2 id="coa-import-title">Import chart of accounts</h2>
            <p>Upload an Excel workbook (.xlsx) or a CSV file containing your club’s account listing. Valid rows will be auto-mapped to your existing categories, FS groups, and departments before anything is committed.</p>
          </div>
          <Link
            href={closeHref}
            className="spectre-dw-import-close"
            aria-label="Close import modal"
            data-testid="coa-import-modal-close"
            onClick={guardCloseClick}
            replace
          >
            <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"><path d="M6 6l12 12" /><path d="M18 6L6 18" /></svg>
          </Link>
        </div>

        <form
          className="spectre-dw-import-body"
          onSubmit={(e) => {
            e.preventDefault();
            handleSubmit();
          }}
          data-testid="coa-import-modal-form"
        >
          {file ? (
            <div className="spectre-dw-import-file" data-testid="coa-import-selected-file">
              <div className="ic">
                <svg viewBox="0 0 24 24" width={22} height={22} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M6 3h9l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
                  <path d="M14 3v5h5" />
                </svg>
              </div>
              <div className="meta">
                <div className="name" data-testid="coa-import-selected-file-name">{file.name}</div>
                <div className="sub">
                  <span data-testid="coa-import-selected-file-type">{file.name.toLowerCase().endsWith(".xlsx") ? "Excel workbook" : "CSV file"}</span>
                  <span aria-hidden="true"> · </span>
                  <span data-testid="coa-import-selected-file-size">{formatBytes(file.size)}</span>
                </div>
              </div>
              <button
                type="button"
                className="spectre-dw-btn tertiary sm"
                onClick={removeFile}
                data-testid="coa-import-remove-file"
                disabled={pending}
              >
                Replace file
              </button>
            </div>
          ) : (
            <div
              ref={dropZoneRef}
              className={`spectre-dw-import-drop${dragActive ? " on" : ""}${errorMessage ? " err" : ""}`}
              role="button"
              tabIndex={0}
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={onDropZoneKeyDown}
              onDragEnter={onDragEnter}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
              data-testid="coa-import-dropzone"
              data-drag-active={dragActive ? "true" : "false"}
              aria-label="Drop a file here or click to browse"
            >
              <div className="ic">
                <svg viewBox="0 0 24 24" width={26} height={26} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
                  <path d="M12 3v13" />
                  <path d="M7 8l5-5 5 5" />
                </svg>
              </div>
              <div className="primary">Drag and drop your file here</div>
              <div className="secondary">or <span className="link">browse files</span></div>
              <div className="hint">Excel (.xlsx) or CSV, up to 10 MB</div>
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            name="file"
            accept={ACCEPT_ATTR}
            className="spectre-dw-import-file-input"
            onChange={(e) => chooseFile(e.target.files?.[0] ?? null)}
            data-testid="coa-import-file-input"
            aria-hidden="true"
            tabIndex={-1}
          />

          {errorMessage && (
            <div
              className="spectre-dw-import-error"
              role="alert"
              data-testid="coa-import-error"
            >
              {errorMessage}
            </div>
          )}

          <div className="spectre-dw-import-guide">
            <div className="spectre-dw-import-guide-heading">Column expectations</div>
            <ul>
              <li>
                <b>Required</b>: account number, account name
              </li>
              <li>
                <b>Optional</b>: type · category · FS group · department · fund applicability
              </li>
              <li>
                Every row is validated before anything is committed. You will see per-row confidence, mismatches, and unmatched values on the next screen — nothing posts to the ledger until you approve.
              </li>
            </ul>
            <a
              href="/api/imports/coa/template"
              className="spectre-dw-import-template-link"
              data-testid="coa-import-template-link"
              download
            >
              <svg viewBox="0 0 24 24" width={12} height={12} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v13" /><path d="M7 12l5 5 5-5" /><path d="M4 20h16" /></svg>
              <span>Download the CoA template (.xlsx)</span>
            </a>
          </div>

          <div className="spectre-dw-import-foot">
            <Link
              href={closeHref}
              className="spectre-dw-btn tertiary"
              onClick={guardCloseClick}
              data-testid="coa-import-cancel"
              replace
            >
              Cancel
            </Link>
            <button
              type="submit"
              className="spectre-dw-btn primary"
              disabled={!canProceed}
              data-testid="coa-import-submit"
              aria-busy={pending ? "true" : "false"}
            >
              {pending ? "Uploading…" : "Upload and continue"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
