"use client";

// v-slice-1-followup-8 (2026-09-16) — Opening YTD Balances founder
// workspace. Contains:
//   * Editor dialog per employee (draft / save / validate / activate)
//   * Bulk validate + bulk activate + zero-YTD-for-all confirmations
//   * CSV import dialog (template download, upload preview, commit)
//
// All destructive/lifecycle gestures open a modal dialog with
// position: fixed; inset: 0 — the same clip-safe pattern the payroll
// action modals use. No clipped inline dropdowns.

import { useState } from "react";
import Link from "next/link";

type OpeningStatus = "MISSING" | "DRAFT" | "VALIDATED" | "ACTIVE" | "SUPERSEDED";
type PriorPayrollKind = "PRIOR_SYSTEM_SAME_EMPLOYER" | "PRIOR_EMPLOYER" | "PRIOR_ADJUSTMENT";

export interface EmployeeRow {
  employeeId: string;
  employeeNumber: string | null;
  displayName: string;
  openingBalanceId: string | null;
  status: OpeningStatus;
  values: {
    ytdGrossEarnings: string;
    ytdTaxableEarnings: string;
    ytdPensionableEarnings: string;
    ytdInsurableEarnings: string;
    ytdCppEE_Base: string;
    ytdCppEE_FirstAdd: string;
    ytdCppEE: string;
    ytdCpp2EE: string;
    ytdEiEE: string;
    ytdFederalTax: string;
    ytdProvincialTax: string;
    ytdCppER_Base: string;
    ytdCppER_FirstAdd: string;
    ytdCppER: string;
    ytdCpp2ER: string;
    ytdEiER: string;
  } | null;
  throughPayDate: string | null;
  priorPayrollKind: PriorPayrollKind | null;
  activatedAt: string | null;
}

interface Props {
  taxYear: number;
  clubId: string;
  canWrite: boolean;
  employees: EmployeeRow[];
  firstSpectrePayDate: string | null;
  actions: {
    saveDraft: (fd: FormData) => Promise<void>;
    validate: (fd: FormData) => Promise<void>;
    activate: (fd: FormData) => Promise<void>;
    bulkValidate: (fd: FormData) => Promise<void>;
    bulkActivate: (fd: FormData) => Promise<void>;
    importCsv: (fd: FormData) => Promise<void>;
  };
}

const KIND_LABELS: Record<PriorPayrollKind, string> = {
  PRIOR_SYSTEM_SAME_EMPLOYER: "Previous payroll system — same employer",
  PRIOR_EMPLOYER: "Previous employer (different business)",
  PRIOR_ADJUSTMENT: "Opening balance adjustment / correction",
};

function fmtMoney(v: string | null | undefined): string {
  if (v == null) return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return `$${n.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function statusLabel(s: OpeningStatus): string {
  return s === "ACTIVE" ? "Active"
    : s === "VALIDATED" ? "Ready"
    : s === "DRAFT" ? "Draft"
    : s === "SUPERSEDED" ? "Superseded"
    : "Not started";
}

function statusColor(s: OpeningStatus): string {
  return s === "ACTIVE" ? "text-emerald-700 bg-emerald-50"
    : s === "VALIDATED" ? "text-blue-700 bg-blue-50"
    : s === "DRAFT" ? "text-amber-800 bg-amber-50"
    : s === "SUPERSEDED" ? "text-stone-500 bg-stone-100"
    : "text-stone-600 bg-stone-100";
}

export default function OpeningBalancesWorkspace(props: Props) {
  const { taxYear, clubId: _clubId, canWrite, employees, firstSpectrePayDate, actions } = props;
  void _clubId;

  const readyCount = employees.filter((e) => e.status === "VALIDATED").length;
  const draftCount = employees.filter((e) => e.status === "DRAFT").length;
  const activeCount = employees.filter((e) => e.status === "ACTIVE").length;

  const [openEditor, setOpenEditor] = useState<EmployeeRow | null>(null);
  const [csvOpen, setCsvOpen] = useState(false);
  const [bulkValidateOpen, setBulkValidateOpen] = useState(false);
  const [bulkActivateOpen, setBulkActivateOpen] = useState(false);

  return (
    <div data-testid="opening-balances-workspace">
      {canWrite && (
        <div className="mt-4 flex flex-wrap items-center gap-2" data-testid="opening-balances-bulk-controls">
          <button
            type="button"
            onClick={() => setCsvOpen(true)}
            data-testid="opening-balances-open-csv"
            className="inline-flex items-center gap-1 rounded border border-stone-300 bg-white hover:bg-stone-50 px-3 py-1.5 text-[13px] text-stone-800"
          >
            Import CSV…
          </button>
          <a
            href="/app/admin/payroll/setup/opening-balances/template"
            data-testid="opening-balances-download-template"
            className="inline-flex items-center gap-1 rounded border border-stone-300 bg-white hover:bg-stone-50 px-3 py-1.5 text-[13px] text-stone-800"
          >
            Download CSV template
          </a>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => setBulkValidateOpen(true)}
            disabled={draftCount === 0}
            data-testid="opening-balances-bulk-validate-open"
            className={
              "inline-flex items-center gap-1 rounded px-3 py-1.5 text-[13px] " +
              (draftCount === 0
                ? "border border-stone-200 bg-stone-100 text-stone-400 cursor-not-allowed"
                : "border border-stone-300 bg-white hover:bg-stone-50 text-stone-800")
            }
          >
            Validate all drafts ({draftCount})
          </button>
          <button
            type="button"
            onClick={() => setBulkActivateOpen(true)}
            disabled={readyCount === 0}
            data-testid="opening-balances-bulk-activate-open"
            className={
              "inline-flex items-center gap-1 rounded px-3 py-1.5 text-[13px] " +
              (readyCount === 0
                ? "border border-stone-200 bg-stone-100 text-stone-400 cursor-not-allowed"
                : "border border-emerald-700 bg-emerald-700 hover:bg-emerald-800 text-white")
            }
          >
            Activate all ready ({readyCount})
          </button>
        </div>
      )}

      <section className="mt-4" data-testid="opening-balances-table-section">
        <div className="overflow-x-auto rounded-lg border border-stone-200">
          <table className="w-full text-sm" data-testid="opening-balances-table">
            <thead className="bg-stone-50 text-stone-600 text-[12px]">
              <tr>
                <th className="text-left px-3 py-2 font-medium">Employee</th>
                <th className="text-left px-3 py-2 font-medium">Employee #</th>
                <th className="text-right px-3 py-2 font-medium">Gross YTD</th>
                <th className="text-right px-3 py-2 font-medium">CPP</th>
                <th className="text-right px-3 py-2 font-medium">EI</th>
                <th className="text-right px-3 py-2 font-medium">Income Tax</th>
                <th className="text-left px-3 py-2 font-medium">Status</th>
                {canWrite && <th className="text-right px-3 py-2 font-medium">Action</th>}
              </tr>
            </thead>
            <tbody>
              {employees.length === 0 ? (
                <tr>
                  <td colSpan={canWrite ? 8 : 7} className="px-3 py-6 text-center text-stone-500">
                    No active employees at this Club.
                  </td>
                </tr>
              ) : (
                employees.map((e) => {
                  const fedProv =
                    e.values
                      ? (Number(e.values.ytdFederalTax) + Number(e.values.ytdProvincialTax)).toString()
                      : null;
                  return (
                    <tr
                      key={e.employeeId}
                      className="border-t border-stone-100 hover:bg-stone-50"
                      data-testid={`opening-balances-row-${e.employeeId.slice(-8)}`}
                    >
                      <td className="px-3 py-2 text-stone-900">{e.displayName}</td>
                      <td className="px-3 py-2 text-stone-600 tabular-nums">{e.employeeNumber ?? "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(e.values?.ytdGrossEarnings ?? null)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(e.values?.ytdCppEE ?? null)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(e.values?.ytdEiEE ?? null)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(fedProv)}</td>
                      <td className="px-3 py-2">
                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11.5px] font-medium ${statusColor(e.status)}`}>
                          {statusLabel(e.status)}
                        </span>
                      </td>
                      {canWrite && (
                        <td className="px-3 py-2 text-right">
                          <button
                            type="button"
                            onClick={() => setOpenEditor(e)}
                            data-testid={`opening-balances-open-editor-${e.employeeId.slice(-8)}`}
                            className="text-[12.5px] text-blue-700 hover:underline"
                          >
                            {e.status === "MISSING"
                              ? "Enter opening balance"
                              : e.status === "ACTIVE"
                                ? "View"
                                : "Edit"}
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      {openEditor && (
        <EditorDialog
          employee={openEditor}
          taxYear={taxYear}
          firstSpectrePayDate={firstSpectrePayDate}
          saveDraftAction={actions.saveDraft}
          validateAction={actions.validate}
          activateAction={actions.activate}
          onClose={() => setOpenEditor(null)}
        />
      )}

      {csvOpen && (
        <CsvImportDialog
          taxYear={taxYear}
          firstSpectrePayDate={firstSpectrePayDate}
          importAction={actions.importCsv}
          onClose={() => setCsvOpen(false)}
        />
      )}

      {bulkValidateOpen && (
        <BulkConfirmDialog
          title="Validate all drafts?"
          body={`Marks every DRAFT opening balance as Ready. ${draftCount} balance${draftCount === 1 ? "" : "s"} will be validated. Rows with numeric issues will be skipped and reported.`}
          confirmLabel="Validate all drafts"
          testId="bulk-validate"
          action={actions.bulkValidate}
          hiddenFields={{ taxYear: String(taxYear) }}
          onClose={() => setBulkValidateOpen(false)}
        />
      )}

      {bulkActivateOpen && (
        <BulkConfirmDialog
          title="Activate all ready balances?"
          body={
            `Activating makes these balances the authoritative opening YTD source. ${readyCount} ready balance${readyCount === 1 ? "" : "s"} will be activated. ` +
            "Once activated, Spectre will consume them at Prepare / Calculate time. Corrections after activation require an explicit supersede."
          }
          confirmLabel="Activate all ready"
          testId="bulk-activate"
          action={actions.bulkActivate}
          hiddenFields={{ taxYear: String(taxYear) }}
          onClose={() => setBulkActivateOpen(false)}
        />
      )}

      <p className="mt-4 text-[12px] text-stone-500" data-testid="opening-balances-summary-counts">
        {activeCount} active · {readyCount} ready · {draftCount} draft ·{" "}
        {employees.filter((e) => e.status === "MISSING").length} not started
      </p>
      <p className="mt-2 text-[12px] text-stone-500">
        Once every employee is Active, return to{" "}
        <Link href="/app/admin/payroll" className="text-blue-700 hover:underline">Finance → Payroll</Link>{" "}
        and re-Prepare the pay period. The MISSING_OPENING_YTD blocker will clear.
      </p>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Editor dialog
// -----------------------------------------------------------------------------
function EditorDialog(props: {
  employee: EmployeeRow;
  taxYear: number;
  firstSpectrePayDate: string | null;
  saveDraftAction: (fd: FormData) => Promise<void>;
  validateAction: (fd: FormData) => Promise<void>;
  activateAction: (fd: FormData) => Promise<void>;
  onClose: () => void;
}) {
  const e = props.employee;
  const isActive = e.status === "ACTIVE";
  const throughDefault =
    e.throughPayDate?.slice(0, 10)
    ?? props.firstSpectrePayDate?.slice(0, 10)
    ?? "";
  const [kind, setKind] = useState<PriorPayrollKind>(e.priorPayrollKind ?? "PRIOR_SYSTEM_SAME_EMPLOYER");

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="opening-balance-editor-title"
      data-testid="opening-balances-editor-dialog"
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)",
        display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50,
      }}
      onClick={(evt) => { if (evt.target === evt.currentTarget) props.onClose(); }}
    >
      <div style={{
        background: "#ffffff", borderRadius: 8, maxWidth: 720, width: "100%",
        margin: "0 16px", padding: 24, boxShadow: "0 20px 40px rgba(0,0,0,0.15)",
        maxHeight: "88vh", overflowY: "auto",
      }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
          <div>
            <h2 id="opening-balance-editor-title" style={{ margin: 0, fontSize: 18, fontWeight: 600, color: "#1c1917" }}>
              Opening YTD balance — {e.displayName}
            </h2>
            <p style={{ margin: "4px 0 0 0", fontSize: 12, color: "#78716c" }}>
              Employee {e.employeeNumber ?? "—"} · Tax year {props.taxYear}
              {isActive ? " · Read-only (Active)" : ""}
            </p>
          </div>
          <span
            data-testid="opening-balances-editor-status-badge"
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11.5px] font-medium ${statusColor(e.status)}`}
          >
            {statusLabel(e.status)}
          </span>
        </div>

        {isActive && (
          <p style={{
            margin: "12px 0",
            padding: "8px 12px",
            fontSize: 12.5,
            borderRadius: 4,
            background: "#f0fdf4",
            color: "#14532d",
            border: "1px solid #bbf7d0",
          }}>
            This balance is Active and used by Prepare / Calculate. To correct it, save a new draft and activate — the current row will be superseded.
          </p>
        )}

        <form action={props.saveDraftAction} data-testid="opening-balances-editor-form" style={{ marginTop: 16 }}>
          <input type="hidden" name="employeeId" value={e.employeeId} />
          <input type="hidden" name="taxYear" value={props.taxYear} />

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
            <div>
              <label style={{ display: "block", fontSize: 12, color: "#57534e", marginBottom: 4 }}>
                Through pay date <span style={{ color: "#b91c1c" }}>*</span>
              </label>
              <input
                name="throughPayDate"
                type="date"
                required
                defaultValue={throughDefault}
                readOnly={isActive}
                data-testid="opening-balances-editor-throughPayDate"
                style={{ width: "100%", height: 34, padding: "0 8px", border: "1px solid #d0c9bd", borderRadius: 4, fontSize: 13 }}
              />
              <p style={{ margin: "2px 0 0 0", fontSize: 11, color: "#78716c" }}>
                The date on/before which the amounts below are cumulative.
              </p>
            </div>
            <div>
              <label style={{ display: "block", fontSize: 12, color: "#57534e", marginBottom: 4 }}>
                Source of this opening balance
              </label>
              <select
                name="priorPayrollKind"
                value={kind}
                onChange={(evt) => setKind(evt.target.value as PriorPayrollKind)}
                disabled={isActive}
                data-testid="opening-balances-editor-priorPayrollKind"
                style={{ width: "100%", height: 34, padding: "0 8px", border: "1px solid #d0c9bd", borderRadius: 4, fontSize: 13, background: "white" }}
              >
                <option value="PRIOR_SYSTEM_SAME_EMPLOYER">{KIND_LABELS.PRIOR_SYSTEM_SAME_EMPLOYER}</option>
                <option value="PRIOR_EMPLOYER">{KIND_LABELS.PRIOR_EMPLOYER}</option>
                <option value="PRIOR_ADJUSTMENT">{KIND_LABELS.PRIOR_ADJUSTMENT}</option>
              </select>
              <p style={{ margin: "2px 0 0 0", fontSize: 11, color: "#78716c" }}>
                {kind === "PRIOR_SYSTEM_SAME_EMPLOYER" && "Same employer / BN. Contributes to CPP + EI annual maximums this year."}
                {kind === "PRIOR_EMPLOYER" && "Different employer / BN. Recorded for T4 continuity; does NOT reduce this employer's CPP/EI caps."}
                {kind === "PRIOR_ADJUSTMENT" && "Correction / reconciliation for this employer. Same-employer semantics."}
              </p>
            </div>
          </div>

          <h3 style={{ margin: "0 0 8px 0", fontSize: 13, fontWeight: 600, color: "#292524", textTransform: "uppercase", letterSpacing: 0.4 }}>Earnings</h3>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
            <NumField name="ytdGrossEarnings" label="Gross earnings YTD" defaultValue={e.values?.ytdGrossEarnings} readOnly={isActive} />
            <NumField name="ytdTaxableEarnings" label="Taxable earnings YTD" defaultValue={e.values?.ytdTaxableEarnings} readOnly={isActive} />
            <NumField name="ytdPensionableEarnings" label="Pensionable earnings YTD (CPP base)" defaultValue={e.values?.ytdPensionableEarnings} readOnly={isActive} />
            <NumField name="ytdInsurableEarnings" label="Insurable earnings YTD (EI base)" defaultValue={e.values?.ytdInsurableEarnings} readOnly={isActive} />
          </div>

          <h3 style={{ margin: "0 0 8px 0", fontSize: 13, fontWeight: 600, color: "#292524", textTransform: "uppercase", letterSpacing: 0.4 }}>Employee deductions</h3>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
            <NumField name="ytdCppEE" label="CPP (T4 Box 16 total)" defaultValue={e.values?.ytdCppEE} readOnly={isActive} />
            <NumField name="ytdCpp2EE" label="CPP2 (Box 16A)" defaultValue={e.values?.ytdCpp2EE} readOnly={isActive} />
            <NumField name="ytdCppEE_Base" label="CPP base component (of Box 16)" defaultValue={e.values?.ytdCppEE_Base} readOnly={isActive} />
            <NumField name="ytdCppEE_FirstAdd" label="CPP first-additional component (of Box 16)" defaultValue={e.values?.ytdCppEE_FirstAdd} readOnly={isActive} />
            <NumField name="ytdEiEE" label="EI premiums (Box 18)" defaultValue={e.values?.ytdEiEE} readOnly={isActive} />
            <NumField name="ytdFederalTax" label="Federal income tax withheld" defaultValue={e.values?.ytdFederalTax} readOnly={isActive} />
            <NumField name="ytdProvincialTax" label="Provincial income tax withheld" defaultValue={e.values?.ytdProvincialTax} readOnly={isActive} />
          </div>

          <h3 style={{ margin: "0 0 8px 0", fontSize: 13, fontWeight: 600, color: "#292524", textTransform: "uppercase", letterSpacing: 0.4 }}>Employer amounts</h3>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
            <NumField name="ytdCppER" label="Employer CPP (total)" defaultValue={e.values?.ytdCppER} readOnly={isActive} />
            <NumField name="ytdCpp2ER" label="Employer CPP2" defaultValue={e.values?.ytdCpp2ER} readOnly={isActive} />
            <NumField name="ytdCppER_Base" label="Employer CPP base component" defaultValue={e.values?.ytdCppER_Base} readOnly={isActive} />
            <NumField name="ytdCppER_FirstAdd" label="Employer CPP first-additional" defaultValue={e.values?.ytdCppER_FirstAdd} readOnly={isActive} />
            <NumField name="ytdEiER" label="Employer EI premiums" defaultValue={e.values?.ytdEiER} readOnly={isActive} />
          </div>

          <label style={{ display: "block", fontSize: 12, color: "#57534e", marginBottom: 4 }}>Notes (optional)</label>
          <textarea
            name="notes"
            defaultValue={undefined}
            readOnly={isActive}
            data-testid="opening-balances-editor-notes"
            rows={2}
            style={{ width: "100%", padding: "6px 8px", border: "1px solid #d0c9bd", borderRadius: 4, fontSize: 13, background: "white" }}
          />

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 20, flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={props.onClose}
              data-testid="opening-balances-editor-cancel"
              style={{
                padding: "8px 16px", fontSize: 14, border: "1px solid #d0c9bd",
                background: "transparent", borderRadius: 4, cursor: "pointer",
              }}
            >
              Close
            </button>
            {!isActive && (
              <>
                <button
                  type="submit"
                  data-testid="opening-balances-editor-save-draft"
                  style={{
                    padding: "8px 16px", fontSize: 14, border: "1px solid #d0c9bd",
                    background: "white", color: "#292524", borderRadius: 4, cursor: "pointer", fontWeight: 500,
                  }}
                >
                  Save draft
                </button>
              </>
            )}
          </div>
        </form>

        {!isActive && e.openingBalanceId && (
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 8, flexWrap: "wrap" }}>
            {e.status === "DRAFT" && (
              <form action={props.validateAction} style={{ display: "inline" }}>
                <input type="hidden" name="id" value={e.openingBalanceId} />
                <button
                  type="submit"
                  data-testid="opening-balances-editor-validate"
                  style={{
                    padding: "8px 16px", fontSize: 14, border: "1px solid #1e40af",
                    background: "white", color: "#1e40af", borderRadius: 4, cursor: "pointer", fontWeight: 500,
                  }}
                >
                  Validate → Ready
                </button>
              </form>
            )}
            <form action={props.activateAction} style={{ display: "inline" }}>
              <input type="hidden" name="id" value={e.openingBalanceId} />
              <button
                type="submit"
                data-testid="opening-balances-editor-activate"
                style={{
                  padding: "8px 16px", fontSize: 14, border: "none",
                  background: "#166534", color: "white", borderRadius: 4, cursor: "pointer", fontWeight: 500,
                }}
              >
                Activate opening balance
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}

function NumField(props: {
  name: string;
  label: string;
  defaultValue?: string;
  readOnly?: boolean;
}) {
  return (
    <div>
      <label style={{ display: "block", fontSize: 12, color: "#57534e", marginBottom: 4 }}>{props.label}</label>
      <input
        name={props.name}
        type="number"
        step="0.01"
        min="0"
        defaultValue={props.defaultValue ?? ""}
        readOnly={props.readOnly}
        data-testid={`opening-balances-editor-${props.name}`}
        style={{
          width: "100%", height: 32, padding: "0 8px", border: "1px solid #d0c9bd",
          borderRadius: 4, fontSize: 13, textAlign: "right", background: props.readOnly ? "#fafaf9" : "white",
        }}
      />
    </div>
  );
}

// -----------------------------------------------------------------------------
// CSV import dialog
// -----------------------------------------------------------------------------
function CsvImportDialog(props: {
  taxYear: number;
  firstSpectrePayDate: string | null;
  importAction: (fd: FormData) => Promise<void>;
  onClose: () => void;
}) {
  const [csvText, setCsvText] = useState("");
  const [rowCount, setRowCount] = useState(0);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="opening-balances-csv-title"
      data-testid="opening-balances-csv-dialog"
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)",
        display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50,
      }}
      onClick={(evt) => { if (evt.target === evt.currentTarget) props.onClose(); }}
    >
      <div style={{
        background: "#ffffff", borderRadius: 8, maxWidth: 640, width: "100%",
        margin: "0 16px", padding: 24, boxShadow: "0 20px 40px rgba(0,0,0,0.15)",
        maxHeight: "88vh", overflowY: "auto",
      }}>
        <h2 id="opening-balances-csv-title" style={{ margin: 0, fontSize: 18, fontWeight: 600, color: "#1c1917" }}>
          Import Opening Balances from CSV
        </h2>
        <p style={{ margin: "8px 0 12px 0", fontSize: 13, color: "#57534e", lineHeight: 1.55 }}>
          Every valid row commits as a Draft. Rows with errors are reported inline and do not create partial data.
          Employee matching uses <span style={{ fontFamily: "monospace" }}>employeeNumber</span> — do not rely on names.
        </p>
        <form action={props.importAction} encType="multipart/form-data">
          <input type="hidden" name="taxYear" value={props.taxYear} />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
            <div>
              <label style={{ display: "block", fontSize: 12, color: "#57534e", marginBottom: 4 }}>Through pay date <span style={{ color: "#b91c1c" }}>*</span></label>
              <input
                type="date"
                name="throughPayDate"
                required
                defaultValue={props.firstSpectrePayDate?.slice(0, 10) ?? ""}
                data-testid="opening-balances-csv-throughPayDate"
                style={{ width: "100%", height: 34, padding: "0 8px", border: "1px solid #d0c9bd", borderRadius: 4, fontSize: 13 }}
              />
            </div>
            <div>
              <label style={{ display: "block", fontSize: 12, color: "#57534e", marginBottom: 4 }}>Rows detected</label>
              <input
                type="text"
                readOnly
                value={String(rowCount)}
                data-testid="opening-balances-csv-rowcount"
                style={{ width: "100%", height: 34, padding: "0 8px", border: "1px solid #d0c9bd", borderRadius: 4, fontSize: 13, background: "#fafaf9" }}
              />
            </div>
          </div>
          <label style={{ display: "block", fontSize: 12, color: "#57534e", marginBottom: 4 }}>
            CSV text <span style={{ color: "#b91c1c" }}>*</span>
          </label>
          <textarea
            name="csvText"
            required
            value={csvText}
            onChange={(e) => {
              setCsvText(e.target.value);
              const lines = e.target.value.split(/\r?\n/).filter((l) => l.trim().length > 0);
              setRowCount(Math.max(0, lines.length - 1));
            }}
            rows={10}
            data-testid="opening-balances-csv-textarea"
            placeholder="Paste CSV content here — header row first, then one row per employee."
            style={{ width: "100%", padding: "8px", border: "1px solid #d0c9bd", borderRadius: 4, fontSize: 12, fontFamily: "monospace", background: "white" }}
          />
          <p style={{ margin: "6px 0 0 0", fontSize: 11, color: "#78716c" }}>
            Download the template above for the exact header row.
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 20 }}>
            <button
              type="button"
              onClick={props.onClose}
              data-testid="opening-balances-csv-cancel"
              style={{
                padding: "8px 16px", fontSize: 14, border: "1px solid #d0c9bd",
                background: "transparent", borderRadius: 4, cursor: "pointer",
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              data-testid="opening-balances-csv-submit"
              style={{
                padding: "8px 16px", fontSize: 14, border: "none",
                background: "#1e40af", color: "white", borderRadius: 4, cursor: "pointer", fontWeight: 500,
              }}
            >
              Import as drafts
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Bulk confirm dialog
// -----------------------------------------------------------------------------
function BulkConfirmDialog(props: {
  title: string;
  body: string;
  confirmLabel: string;
  testId: string;
  action: (fd: FormData) => Promise<void>;
  hiddenFields: Record<string, string>;
  onClose: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={`opening-balances-${props.testId}-title`}
      data-testid={`opening-balances-${props.testId}-dialog`}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)",
        display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50,
      }}
      onClick={(evt) => { if (evt.target === evt.currentTarget) props.onClose(); }}
    >
      <div style={{
        background: "#ffffff", borderRadius: 8, maxWidth: 480, width: "100%",
        margin: "0 16px", padding: 24, boxShadow: "0 20px 40px rgba(0,0,0,0.15)",
      }}>
        <h2 id={`opening-balances-${props.testId}-title`} style={{ margin: 0, fontSize: 18, fontWeight: 600, color: "#1c1917" }}>
          {props.title}
        </h2>
        <p style={{ margin: "12px 0 16px 0", fontSize: 14, lineHeight: 1.55, color: "#44403c" }}>{props.body}</p>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            type="button"
            onClick={props.onClose}
            data-testid={`opening-balances-${props.testId}-cancel`}
            style={{
              padding: "8px 16px", fontSize: 14, border: "1px solid #d0c9bd",
              background: "transparent", borderRadius: 4, cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <form action={props.action} style={{ display: "inline" }}>
            {Object.entries(props.hiddenFields).map(([k, v]) => (
              <input key={k} type="hidden" name={k} value={v} />
            ))}
            <button
              type="submit"
              data-testid={`opening-balances-${props.testId}-confirm`}
              style={{
                padding: "8px 16px", fontSize: 14, border: "none",
                background: "#166534", color: "white", borderRadius: 4, cursor: "pointer", fontWeight: 500,
              }}
            >
              {props.confirmLabel}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
