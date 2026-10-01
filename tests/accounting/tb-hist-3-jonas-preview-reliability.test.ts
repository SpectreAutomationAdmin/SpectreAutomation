// TB-HIST-3 (2026-10-01) — Jonas Preview reliability regression tests.
//
// Covers §8 A-I of the directive at a structural / source-pin level —
// the actual XLSX upload end-to-end flow is exercised by the staging
// Playwright spec after deploy. These tests lock the client-side
// hardening + server-action body-size config in place so the Preview
// cannot silently fail again.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "..", "..");
const FORM = readFileSync(path.join(REPO, "src", "app", "app", "admin", "imports", "jonas", "jonas-import-form.tsx"), "utf8");
const NEXT_CONFIG = readFileSync(path.join(REPO, "next.config.js"), "utf8");

describe("TB-HIST-3 · root-cause fix — server-action body-size limit", () => {
  it("next.config.js raises experimental.serverActions.bodySizeLimit above the 1 MB default", () => {
    expect(NEXT_CONFIG).toMatch(/experimental: \{[\s\S]*?serverActions: \{[\s\S]*?bodySizeLimit: "10mb"/);
  });

  it("the comment pins the root cause so a future refactor can't silently roll it back", () => {
    expect(NEXT_CONFIG).toMatch(/TB-HIST-3 \(2026-10-01\) — Jonas XLSX Trial Balance upload/);
    expect(NEXT_CONFIG).toMatch(/Server actions have a 1 MB request-body ceiling/);
  });
});

describe("TB-HIST-3 §B — visible pending state", () => {
  it("Preview button label swaps to 'Preparing preview…' while pending", () => {
    expect(FORM).toMatch(/stage === "preview-pending" \? "Preparing preview…" : "Preview"/);
  });

  it("Preview button carries aria-busy and the restrained progress bar", () => {
    expect(FORM).toMatch(/aria-busy=\{stage === "preview-pending" \|\| pending\}/);
    expect(FORM).toMatch(/data-testid="jonas-preview-progress"/);
    expect(FORM).toMatch(/role="progressbar"/);
  });

  it("No fake percentage leaks into the pending state", () => {
    const previewProgressBlock = FORM.match(/data-testid="jonas-preview-progress"[\s\S]{0,500}/)?.[0] ?? "";
    expect(previewProgressBlock).not.toMatch(/\b(17|42|83)%/);
    expect(previewProgressBlock).toMatch(/animate-pulse/);
  });
});

describe("TB-HIST-3 §C — double-submit guard", () => {
  it("onPreview short-circuits when `pending` is already true", () => {
    expect(FORM).toMatch(/function onPreview\(\) \{[\s\S]{0,600}if \(pending \|\| stage === "preview-pending"\) return;/);
  });

  it("the button is disabled when pending OR stage === 'preview-pending'", () => {
    expect(FORM).toMatch(/disabled=\{pending \|\| stage === "preview-pending" \|\| /);
  });
});

describe("TB-HIST-3 §E-F — error visibility", () => {
  it("onPreview wraps the server-action call in try/catch and surfaces the error", () => {
    expect(FORM).toMatch(/try \{[\s\S]*?const result = await previewJonasImport/);
    expect(FORM).toMatch(/\} catch \(err\) \{[\s\S]*?setSubmitError\("Preview failed: " \+ message\)/);
  });

  it("Errors from the server action's structured `{ error }` result also render", () => {
    expect(FORM).toMatch(/if \("error" in result\) \{[\s\S]*?setSubmitError\(result\.error\)/);
  });

  it("Error card renders when submitError is set", () => {
    expect(FORM).toMatch(/data-testid="jonas-submit-error"/);
  });
});

describe("TB-HIST-3 §H — filename + effective date remain visible across the preview cycle", () => {
  it("filename renders from `fields.filename` and is NOT cleared by onPreview", () => {
    expect(FORM).toMatch(/data-testid="field-source-filename"/);
    const onPreviewBlock = FORM.match(/function onPreview\(\) \{[\s\S]*?\}\n  \}/)?.[0] ?? "";
    expect(onPreviewBlock).not.toMatch(/setFields\(EMPTY\)/);
    expect(onPreviewBlock).not.toMatch(/filename: ""/);
  });

  it("effective-date input reads from fields.effectiveDateOverride (unchanged across preview)", () => {
    expect(FORM).toMatch(/data-testid="field-effective-date"/);
    expect(FORM).toMatch(/value=\{fields\.effectiveDateOverride\}/);
  });
});

describe("TB-HIST-3 §G — Preview must never create accounting records (structural guard)", () => {
  it("previewJonasImport never calls beginImportBatch / upsertSnapshot / commitImportBatch", () => {
    const actions = readFileSync(path.join(REPO, "src", "app", "app", "admin", "imports", "jonas", "actions.ts"), "utf8");
    const previewIdx = actions.indexOf("export async function previewJonasImport(");
    const commitIdx = actions.indexOf("export async function commitJonasImport(");
    expect(previewIdx).toBeGreaterThan(0);
    expect(commitIdx).toBeGreaterThan(previewIdx);
    const previewBody = actions.slice(previewIdx, commitIdx);
    // The preview path must stay strictly read-only — no writer calls.
    expect(previewBody).not.toMatch(/beginImportBatch\(/);
    expect(previewBody).not.toMatch(/upsertSnapshot\(/);
    expect(previewBody).not.toMatch(/commitImportBatch\(/);
    expect(previewBody).not.toMatch(/prisma\.(account|journalEntry|reportingLedgerBatch|reportingLedgerSnapshot|importBatch)\.(create|update|upsert|delete)/);
  });
});

describe("TB-HIST-3 §I — CSV preview path remains supported", () => {
  it("The 'Alternative — Paste CSV' textarea is still present in the form", () => {
    expect(FORM).toMatch(/<textarea[\s\S]{0,400}Alternative — Paste CSV|Paste CSV/i);
  });
});
