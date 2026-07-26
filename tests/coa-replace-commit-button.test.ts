// COA replace-on-commit modal — UI contract.
//
// Source-contract tests covering:
//   • Founder's exact title + body + button copy.
//   • Modal only renders when `plan.requiresConfirmation` is true.
//   • Cancel closes the modal and does NOT submit.
//   • Confirm submits the form with `confirmReplaceCoa=on`.
//   • Empty-COA path skips the modal and uses a direct Commit form.
//   • Page wires the success cookie + banner.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const MODAL = fs.readFileSync(
  path.resolve(
    process.cwd(),
    "src/app/app/admin/imports/[id]/CoaReplaceCommitButton.tsx",
  ),
  "utf8",
);
const PAGE = fs.readFileSync(
  path.resolve(
    process.cwd(),
    "src/app/app/admin/imports/[id]/page.tsx",
  ),
  "utf8",
);

describe("Founder copy — modal title / body / buttons", () => {
  it("uses the exact title 'Replace existing Chart of Accounts?'", () => {
    expect(MODAL).toContain("Replace existing Chart of Accounts?");
  });

  it("uses the exact body the founder approved (whitespace-collapsed)", () => {
    // The JSX body is wrapped across lines in source; collapse
    // whitespace so the assertion checks the rendered sentence
    // shape regardless of where Prettier broke the line.
    const collapsed = MODAL.replace(/\s+/g, " ");
    expect(collapsed).toContain(
      "This import will replace the current Chart of Accounts for this club.",
    );
    expect(collapsed).toContain(
      "Existing account mappings that are not included in this import will be removed or deactivated.",
    );
    expect(collapsed).toContain(
      "This may affect financial reporting, imports, and historical account mappings.",
    );
    expect(collapsed).toContain("Do you want to continue?");
  });

  it("renders both founder buttons — 'Cancel' + 'Replace Chart of Accounts'", () => {
    expect(MODAL).toContain("Cancel");
    expect(MODAL).toContain("Replace Chart of Accounts");
  });

  it("exposes the canonical testids for cancel + confirm + impact counts", () => {
    expect(MODAL).toContain('data-testid="coa-replace-modal"');
    expect(MODAL).toContain('data-testid="coa-replace-modal-title"');
    expect(MODAL).toContain('data-testid="coa-replace-modal-cancel"');
    expect(MODAL).toContain('data-testid="coa-replace-modal-confirm"');
    expect(MODAL).toContain('data-testid="coa-replace-existing"');
    expect(MODAL).toContain('data-testid="coa-replace-imported"');
    expect(MODAL).toContain('data-testid="coa-replace-matching"');
    expect(MODAL).toContain('data-testid="coa-replace-deactivate"');
  });
});

describe("Confirm flow — submits with confirmReplaceCoa=on", () => {
  it("submitWithConfirmation builds FormData with the flag set", () => {
    expect(MODAL).toMatch(/fd\.set\("confirmReplaceCoa", "on"\)/);
    expect(MODAL).toMatch(/await commitAction\(fd\)/);
  });

  it("never sends an allowPartial flag — COA imports always reject partial commits (founder rule 2026-07-20)", () => {
    expect(MODAL).not.toMatch(/allowPartial/);
    expect(MODAL).not.toMatch(/hasErrorRows/);
  });

  it("Cancel button closes the modal and never calls the action", () => {
    // The cancel handler only toggles `open` — no commitAction call inline.
    expect(MODAL).toMatch(/onClick=\{\(\) => setOpen\(false\)\}/);
  });
});

describe("Empty-COA path — no modal, direct commit", () => {
  it("when plan.requiresConfirmation is false, renders a plain Commit form (no modal)", () => {
    expect(MODAL).toMatch(/if \(!plan\.requiresConfirmation\)/);
    expect(MODAL).toContain('data-testid="coa-commit-direct"');
    expect(MODAL).toContain("<form action={commitAction}");
  });
});

describe("Page-level wiring", () => {
  it("commitAction passes confirmReplaceCoa through to commitBatch", () => {
    expect(PAGE).toMatch(/confirmReplaceCoa: formData\.get\("confirmReplaceCoa"\) === "on"/);
  });

  it("computes planCoaReplacement only for COA batches in the VALIDATED state", () => {
    expect(PAGE).toMatch(/batch\.domain === "COA" && batch\.status === "VALIDATED"/);
    expect(PAGE).toMatch(/planCoaReplacement\(p, batch\.id\)/);
  });

  it("renders the CoaReplaceCommitButton only when the COA lifecycle is VALIDATED_CLEAN", () => {
    expect(PAGE).toContain("<CoaReplaceCommitButton");
    expect(PAGE).toMatch(/plan=\{coaReplacementPlan\}/);
    // The button mount is now gated on the lifecycle state, not
    // on a raw error count — the page never even renders it when
    // there are errors. hasErrorRows is gone from the prop list.
    expect(PAGE).toMatch(/coaLifecycle === "VALIDATED_CLEAN" && coaReplacementPlan/);
    expect(PAGE).not.toMatch(/hasErrorRows=/);
  });

  it("non-COA Commit buttons stay on the pre-existing direct-form path", () => {
    // Non-COA branch still handles its own Commit / Commit anyway flow.
    expect(PAGE).toMatch(/batch\.status === "VALIDATED" && batch\.errorRows === 0/);
    expect(PAGE).toMatch(/batch\.status === "VALIDATED" && batch\.errorRows > 0/);
    expect(PAGE).toMatch(/allow partial commit/);
  });

  it("success cookie surfaces 'Chart of Accounts replaced successfully.'", () => {
    expect(PAGE).toContain('"Chart of Accounts replaced successfully."');
    expect(PAGE).toContain('spectre_import_success');
    expect(PAGE).toContain('data-testid="batch-detail-success"');
  });
});
