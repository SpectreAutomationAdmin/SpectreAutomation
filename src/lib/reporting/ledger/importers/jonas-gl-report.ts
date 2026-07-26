// Jonas GL importer — human-readable report formatter.
//
// Takes a `JonasImporterResult` and produces a plain-text report
// suitable for surfacing in the admin UI, persisting to an audit
// log, or printing to stdout during CLI imports.
//
// Report shape (sample at the bottom of this file):
//
//   Jonas GL Import — <filename>
//   Club: <clubId>   Period: <period-end>   Status: <status>
//   Import ID: <importId>   Snapshot ID: <snapshotId>
//
//   ── Diagnostics ────────────────────────────────────────────
//   Rows parsed:               <n>
//   Accounts mapped:           <n>  (override <n>, range <n>,
//                                    Jonas-type-hint <n>)
//   Accounts unmapped:         <n>
//
//   Reconciliation:            <PASS / FAIL>
//     Total debits:  $<...>
//     Total credits: $<...>
//     Delta:         $<...>
//
//   ── Errors ────────────────────────────────────────────────
//   <only when present>
//
//   ── Warnings ──────────────────────────────────────────────
//   <only when present>

import type {
  JonasImportDiagnostics,
  JonasImporterResult,
} from "@/lib/reporting/ledger/importers/jonas-gl-importer";

/** Format the report. Pure function; deterministic given inputs. */
export function formatJonasImportReport(args: {
  clubId: string;
  filename: string;
  periodEnd: Date;
  result: JonasImporterResult;
}): string {
  const { clubId, filename, periodEnd, result } = args;
  const { diagnostics } = result;

  const lines: string[] = [];
  lines.push(`Jonas GL Import — ${filename}`);
  lines.push(
    `Club: ${clubId}   Period: ${periodEnd.toISOString().slice(0, 10)}   Status: ${result.status.toUpperCase()}`,
  );
  lines.push(
    `Import ID: ${result.importId}   Snapshot ID: ${result.snapshotId ?? "—"}`,
  );
  lines.push("");
  lines.push(divider("Diagnostics"));
  lines.push(`Rows parsed:               ${diagnostics.rowCount}`);
  lines.push(
    `Accounts mapped:           ${diagnostics.mappingCoverage.mapped}  ` +
      `(override ${diagnostics.mappingCoverage.fromOverride}, ` +
      `range ${diagnostics.mappingCoverage.fromRangeRule}, ` +
      `Jonas-type-hint ${diagnostics.mappingCoverage.fromJonasTypeHint})`,
  );
  lines.push(`Accounts unmapped:         ${diagnostics.mappingCoverage.unmapped}`);
  lines.push("");
  lines.push(
    `Reconciliation:            ${diagnostics.reconciliation.isBalanced ? "PASS" : "FAIL"}`,
  );
  lines.push(
    `  Total debits:  ${formatMoney(diagnostics.reconciliation.totalDebits)}`,
  );
  lines.push(
    `  Total credits: ${formatMoney(diagnostics.reconciliation.totalCredits)}`,
  );
  lines.push(
    `  Delta:         ${formatMoney(diagnostics.reconciliation.delta)}`,
  );

  if (hasErrors(diagnostics)) {
    lines.push("");
    lines.push(divider("Errors"));
    for (const e of diagnostics.fileErrors) {
      lines.push(`  [file:${e.kind}] ${e.message}`);
      if (e.seenHeaders) {
        lines.push(`    seen headers: ${e.seenHeaders.join(", ")}`);
      }
    }
    for (const e of diagnostics.rowErrors) {
      lines.push(
        `  [row line ${e.lineNumber}] ${e.column ? `(${e.column}) ` : ""}${e.message}`,
      );
    }
    for (const e of diagnostics.mappingErrors) {
      lines.push(
        `  [mapping line ${e.lineNumber}] account ${e.accountNumber} '${e.accountDescription}': ${e.message}`,
      );
    }
  }

  if (diagnostics.warnings.length > 0) {
    lines.push("");
    lines.push(divider("Warnings"));
    for (const w of diagnostics.warnings) {
      lines.push(
        `  [line ${w.lineNumber}] ${w.column ? `(${w.column}) ` : ""}${w.message}`,
      );
    }
  }

  if (result.status === "duplicate-no-op") {
    lines.push("");
    lines.push("Result: bit-identical CSV already imported; no new snapshot written.");
  } else if (result.status === "succeeded") {
    lines.push("");
    lines.push(
      `Result: snapshot ${result.snapshotId} committed in batch ${result.batchId}` +
        (result.replacedCount > 0 ? " (replaced a prior snapshot)." : "."),
    );
  } else {
    lines.push("");
    lines.push(`Result: import ABORTED — no snapshot written.`);
  }

  return lines.join("\n");
}

function divider(title: string): string {
  const padded = ` ${title} `;
  const totalWidth = 60;
  const dashesEach = Math.max(2, Math.floor((totalWidth - padded.length) / 2));
  return "─".repeat(dashesEach) + padded + "─".repeat(dashesEach);
}

function formatMoney(amount: number): string {
  const sign = amount < 0 ? "-" : "";
  const abs = Math.abs(amount);
  return `${sign}$${abs.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function hasErrors(diagnostics: JonasImportDiagnostics): boolean {
  return (
    diagnostics.fileErrors.length > 0 ||
    diagnostics.rowErrors.length > 0 ||
    diagnostics.mappingErrors.length > 0
  );
}
