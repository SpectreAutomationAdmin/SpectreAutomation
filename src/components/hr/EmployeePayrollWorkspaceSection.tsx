"use client";
// Slice A (2026-09-18) — Employee → Payroll canonical workspace.
//
// Founder-approved 8-section information architecture:
//   A. PAYROLL STATUS           — status / pay group / pay frequency / #
//   B. TAX & PAYMENT            — SIN / Direct Deposit / Federal TD1 / Provincial TD1
//   C. BASE COMPENSATION        — cadence / current rate / effective date / change / history
//   D. RECURRING EARNINGS       — canonical Phase 4 EmployeeRecurringPayrollComponent
//   E. ONE-TIME EARNINGS        — intentional empty state (Slice B)
//   F. BENEFITS & DEDUCTIONS    — intentional empty state (Slice C)
//   G. RETIREMENT               — RRSP "not enrolled / not configured" (Slice D)
//   H. IMPLEMENTATION & YTD     — Original Hire Date · Spectre Activation · YTD status
//
// This component owns the layout and section chrome only. All sensitive
// data rendering (SIN masking, banking masking, TD1 status) reuses the
// existing panels the previous Payroll tab already used. No new reveal
// APIs; no new sensitive-data code paths.

import { useState, useTransition } from "react";

type MaskedPayroll = {
  sinAccessible: boolean;
  sinMasked?: string | null;
  bankingAccessible: boolean;
  bankingMasked?: {
    holderName: string;
    accountMasked: string;
    status: string;
  } | null;
  taxAccessible: boolean;
  taxProfileMasked?: {
    province: string | null;
  } | null;
  federal?: unknown;
  provincial?: unknown;
};

type MoneyString = string; // Decimal stringified.

type CompensationRow = {
  id: string;
  cadence: "SALARY" | "HOURLY" | "COMMISSION" | "PIECE_RATE" | string;
  rate: MoneyString;
  currency: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
};

type OpeningBalanceStatus = "DRAFT" | "READY" | "ACTIVE" | "SUPERSEDED" | string;

export interface EmployeePayrollWorkspaceProps {
  employeeId: string;
  employeeNumber: string;
  employeeStatus: string;
  employeeName: string;
  originalHireDateIso: string | null;
  spectreActivatedAtIso: string | null;
  canEditHireDate: boolean;
  payGroup: {
    id: string;
    code: string;
    name: string;
    payFrequency: "WEEKLY" | "BIWEEKLY" | "SEMI_MONTHLY" | "MONTHLY" | string;
  } | null;
  payroll: MaskedPayroll | null;
  currentCompensation: CompensationRow | null;
  compensationHistoryCount: number;
  implementationDeclaration: {
    taxYear: number;
    mode: "ZERO_OPENING_YTD" | "MID_YEAR_MIGRATION" | string;
    firstSpectrePayDateIso: string | null;
  } | null;
  openingBalance: {
    id: string;
    taxYear: number;
    status: OpeningBalanceStatus;
    throughPayDateIso: string | null;
    ytdGross: MoneyString | null;
    ytdTaxable: MoneyString | null;
    ytdPensionable: MoneyString | null;
    ytdInsurable: MoneyString | null;
    ytdCppEE: MoneyString | null;
    ytdEiEE: MoneyString | null;
    ytdFederalTax: MoneyString | null;
    ytdProvincialTax: MoneyString | null;
    priorPayrollKind: string | null;
  } | null;
  actions: {
    updateOriginalHireDate: (
      employeeId: string,
      input: { hireDate: string | null },
    ) => Promise<{ ok: boolean; error?: string }>;
  };
  recurringComponentsSection: React.ReactNode;
  federalTd1Panel: React.ReactNode;
  provincialTd1Panel: React.ReactNode;
}

const monthNamesShort = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatCivilDate(iso: string | null | undefined): string {
  if (!iso) return "Not recorded";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Not recorded";
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  return `${monthNamesShort[m]} ${day}, ${y}`;
}

function formatMoney(v: MoneyString | null): string {
  if (v == null) return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-CA", { style: "currency", currency: "CAD" });
}

function humanFrequency(f: string | undefined | null): string {
  switch (f) {
    case "WEEKLY": return "Weekly";
    case "BIWEEKLY": return "Bi-weekly";
    case "SEMI_MONTHLY": return "Semi-Monthly";
    case "MONTHLY": return "Monthly";
    default: return f ?? "—";
  }
}

function humanCadence(c: string | undefined | null): string {
  switch (c) {
    case "SALARY": return "Salary";
    case "HOURLY": return "Hourly";
    case "COMMISSION": return "Commission";
    case "PIECE_RATE": return "Piece rate";
    default: return c ?? "—";
  }
}

function humanImplementationMode(m: string | undefined | null): string {
  switch (m) {
    case "ZERO_OPENING_YTD": return "Beginning-of-year (no prior payroll YTD)";
    case "MID_YEAR_MIGRATION": return "Mid-year migration";
    default: return m ?? "—";
  }
}

function humanOpeningBalanceStatus(s: OpeningBalanceStatus): string {
  switch (s) {
    case "DRAFT": return "Draft";
    case "READY": return "Ready / validated";
    case "ACTIVE": return "Active";
    case "SUPERSEDED": return "Superseded";
    default: return String(s);
  }
}

function DL({ children }: { children: React.ReactNode }) {
  return (
    <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1.5 text-sm">
      {children}
    </dl>
  );
}
function Row({ label, children, testId }: { label: string; children: React.ReactNode; testId?: string }) {
  return (
    <>
      <dt className="text-stone-500">{label}</dt>
      <dd className="text-stone-900" data-testid={testId}>{children}</dd>
    </>
  );
}

function Pill({ tone, children }: { tone: "ok" | "warn" | "neutral"; children: React.ReactNode }) {
  const cls =
    tone === "ok"
      ? "bg-[#dcfce7] text-[#166534]"
      : tone === "warn"
        ? "bg-amber-100 text-amber-800"
        : "bg-stone-200 text-stone-700";
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold tracking-wide uppercase ${cls}`}>
      {children}
    </span>
  );
}

export default function EmployeePayrollWorkspaceSection(props: EmployeePayrollWorkspaceProps) {
  const {
    employeeId,
    employeeNumber,
    employeeStatus,
    originalHireDateIso,
    spectreActivatedAtIso,
    canEditHireDate,
    payGroup,
    payroll,
    currentCompensation,
    compensationHistoryCount,
    implementationDeclaration,
    openingBalance,
    actions,
    recurringComponentsSection,
    federalTd1Panel,
    provincialTd1Panel,
  } = props;

  const [editingHire, setEditingHire] = useState(false);
  const [hireDraft, setHireDraft] = useState(
    originalHireDateIso ? originalHireDateIso.slice(0, 10) : "",
  );
  const [hireError, setHireError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  return (
    <section className="spectre-person-body" data-testid="employee-tab-body-payroll">
      <h2 className="spectre-person-section-title">Payroll</h2>

      {/* ============================================================
          A. PAYROLL STATUS
          ============================================================ */}
      <div className="spectre-person-section" data-testid="payroll-status">
        <div className="spectre-person-section-head">
          <h3 className="spectre-person-eyebrow">Payroll Status</h3>
        </div>
        <DL>
          <Row label="Payroll status" testId="payroll-status-lifecycle">
            {employeeStatus === "ACTIVE" ? <Pill tone="ok">Active</Pill> : <Pill tone="neutral">{employeeStatus}</Pill>}
          </Row>
          <Row label="Pay group" testId="payroll-status-paygroup">
            {payGroup ? payGroup.name : <span className="text-stone-500">Not assigned</span>}
          </Row>
          <Row label="Pay frequency" testId="payroll-status-frequency">
            {payGroup ? humanFrequency(payGroup.payFrequency) : "—"}
          </Row>
          <Row label="Employee #" testId="payroll-status-number">{employeeNumber}</Row>
        </DL>
      </div>

      {/* ============================================================
          B. TAX & PAYMENT
          ============================================================ */}
      <div className="spectre-person-section" data-testid="payroll-tax-payment">
        <div className="spectre-person-section-head">
          <h3 className="spectre-person-eyebrow">Tax &amp; Payment</h3>
        </div>
        <div className="spectre-person-columns mt-2">
          <div className="spectre-person-col-left space-y-4">
            <div data-testid="payroll-sin">
              <div className="text-[11px] uppercase tracking-wide text-stone-500">Social Insurance Number</div>
              {payroll?.sinAccessible ? (
                payroll.sinMasked ? (
                  <p className="text-base font-mono text-stone-900">{payroll.sinMasked}</p>
                ) : (
                  <p className="text-sm text-stone-500">Not yet submitted</p>
                )
              ) : (
                <p className="text-xs text-stone-500">Requires Payroll Admin access</p>
              )}
            </div>
            <div data-testid="payroll-banking">
              <div className="text-[11px] uppercase tracking-wide text-stone-500">Direct deposit</div>
              {payroll?.bankingAccessible ? (
                payroll.bankingMasked ? (
                  <div>
                    <p className="text-sm text-stone-900">{payroll.bankingMasked.holderName}</p>
                    <p className="text-sm font-mono text-stone-700">
                      Account ending in {payroll.bankingMasked.accountMasked.slice(-4)}
                    </p>
                    <p className="mt-1">
                      {payroll.bankingMasked.status === "VERIFIED"
                        ? <Pill tone="ok">Verified</Pill>
                        : <Pill tone="warn">{payroll.bankingMasked.status.replace(/_/g, " ").toLowerCase()}</Pill>}
                    </p>
                  </div>
                ) : (
                  <p className="text-sm text-stone-500">Not yet submitted</p>
                )
              ) : (
                <p className="text-xs text-stone-500">Requires Payroll Admin access</p>
              )}
            </div>
          </div>
          <div className="spectre-person-col-right space-y-4">
            <div data-testid="payroll-td1-federal">
              <div className="text-[11px] uppercase tracking-wide text-stone-500">Federal TD1</div>
              {federalTd1Panel}
            </div>
            <div data-testid="payroll-td1-provincial">
              <div className="text-[11px] uppercase tracking-wide text-stone-500">Provincial TD1</div>
              {provincialTd1Panel}
            </div>
          </div>
        </div>
      </div>

      {/* ============================================================
          C. BASE COMPENSATION
          ============================================================ */}
      <div className="spectre-person-section" data-testid="payroll-base-compensation">
        <div className="spectre-person-section-head">
          <h3 className="spectre-person-eyebrow">Base Compensation</h3>
        </div>
        {currentCompensation ? (
          <DL>
            <Row label="Type" testId="payroll-comp-cadence">{humanCadence(currentCompensation.cadence)}</Row>
            <Row label={currentCompensation.cadence === "SALARY" ? "Annual rate" : "Rate"} testId="payroll-comp-rate">
              {formatMoney(currentCompensation.rate)}{currentCompensation.cadence === "HOURLY" ? " / hr" : ""}
            </Row>
            <Row label="Effective" testId="payroll-comp-effective">
              {formatCivilDate(currentCompensation.effectiveFrom)}
            </Row>
            <Row label="History">
              {compensationHistoryCount > 1 ? (
                <span className="text-stone-700">{compensationHistoryCount} entries — see Employment tab</span>
              ) : (
                <span className="text-stone-500">First compensation record</span>
              )}
            </Row>
          </DL>
        ) : (
          <p className="mt-3 text-sm text-stone-500">No compensation record on file.</p>
        )}
      </div>

      {/* ============================================================
          D. RECURRING EARNINGS
          ============================================================ */}
      <div data-testid="payroll-recurring-earnings-slot">
        {recurringComponentsSection}
      </div>

      {/* ============================================================
          E. ONE-TIME EARNINGS
          ============================================================ */}
      <div className="spectre-person-section" data-testid="payroll-one-time-earnings">
        <div className="spectre-person-section-head">
          <h3 className="spectre-person-eyebrow">One-Time Earnings</h3>
        </div>
        <p className="mt-2 text-sm text-stone-500">No one-time earnings scheduled.</p>
        <p className="mt-1 text-xs text-stone-400">
          One-time bonuses and adjustments will be enterable here in a later slice.
        </p>
      </div>

      {/* ============================================================
          F. BENEFITS & DEDUCTIONS
          ============================================================ */}
      <div className="spectre-person-section" data-testid="payroll-benefits-deductions">
        <div className="spectre-person-section-head">
          <h3 className="spectre-person-eyebrow">Benefits &amp; Deductions</h3>
        </div>
        <p className="mt-2 text-sm text-stone-500">No active benefits or recurring deductions.</p>
        <p className="mt-1 text-xs text-stone-400">
          Long-term disability and health-benefits enrolment will land in a later slice.
        </p>
      </div>

      {/* ============================================================
          G. RETIREMENT
          ============================================================ */}
      <div className="spectre-person-section" data-testid="payroll-retirement">
        <div className="spectre-person-section-head">
          <h3 className="spectre-person-eyebrow">Retirement</h3>
        </div>
        <DL>
          <Row label="RRSP">
            <span className="text-stone-500">Not enrolled</span>
          </Row>
          <Row label="Club plan">
            <span className="text-stone-500">Not configured</span>
          </Row>
        </DL>
        <p className="mt-2 text-xs text-stone-400">
          A dedicated RRSP plan model with employer matching lands in a later slice. Manual
          pairing of two independent recurring components is intentionally not offered here.
        </p>
      </div>

      {/* ============================================================
          H. IMPLEMENTATION & YTD
          ============================================================ */}
      <div className="spectre-person-section" data-testid="payroll-implementation-ytd">
        <div className="spectre-person-section-head">
          <h3 className="spectre-person-eyebrow">Implementation &amp; YTD</h3>
        </div>

        {/* Dates ---------------------------------------------------- */}
        <DL>
          <Row label="Original Hire Date" testId="employee-original-hire-date">
            {editingHire ? (
              <form
                className="flex items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  setHireError(null);
                  startTransition(async () => {
                    const iso = hireDraft ? new Date(hireDraft + "T00:00:00.000Z").toISOString() : null;
                    const res = await actions.updateOriginalHireDate(employeeId, { hireDate: iso });
                    if (!res.ok) {
                      setHireError(res.error ?? "Failed to update hire date.");
                      return;
                    }
                    setEditingHire(false);
                  });
                }}
              >
                <input
                  type="date"
                  name="hireDate"
                  value={hireDraft}
                  onChange={(e) => setHireDraft(e.target.value)}
                  className="rounded border border-stone-300 px-2 py-1 text-sm"
                  data-testid="employee-original-hire-date-input"
                />
                <button
                  type="submit"
                  disabled={isPending}
                  className="rounded bg-stone-900 text-white px-2.5 py-1 text-xs"
                  data-testid="employee-original-hire-date-save"
                >
                  {isPending ? "Saving…" : "Save"}
                </button>
                <button
                  type="button"
                  className="rounded border border-stone-300 px-2.5 py-1 text-xs"
                  onClick={() => { setEditingHire(false); setHireError(null); setHireDraft(originalHireDateIso?.slice(0, 10) ?? ""); }}
                >
                  Cancel
                </button>
              </form>
            ) : (
              <span className="inline-flex items-center gap-2">
                <span>{formatCivilDate(originalHireDateIso)}</span>
                {canEditHireDate && (
                  <button
                    type="button"
                    className="text-xs text-blue-700 hover:underline"
                    onClick={() => setEditingHire(true)}
                    data-testid="employee-original-hire-date-edit"
                  >
                    Edit
                  </button>
                )}
              </span>
            )}
            {hireError && <p className="mt-1 text-xs text-red-600">{hireError}</p>}
          </Row>
          <Row label="Spectre Activation" testId="employee-spectre-activation-date">
            <span>{formatCivilDate(spectreActivatedAtIso)}</span>
            <span className="ml-2 text-xs text-stone-500">(system record)</span>
          </Row>
        </DL>

        {/* Implementation declaration ------------------------------- */}
        <div className="mt-5" data-testid="payroll-implementation-declaration">
          <div className="text-[11px] uppercase tracking-wide text-stone-500">Payroll Implementation</div>
          {implementationDeclaration ? (
            <DL>
              <Row label="Mode">{humanImplementationMode(implementationDeclaration.mode)}</Row>
              <Row label="Tax year">{implementationDeclaration.taxYear}</Row>
              {implementationDeclaration.firstSpectrePayDateIso && (
                <Row label="First Spectre pay date">
                  {formatCivilDate(implementationDeclaration.firstSpectrePayDateIso)}
                </Row>
              )}
            </DL>
          ) : (
            <div className="mt-1">
              <Pill tone="warn">Not configured</Pill>
              <p className="mt-2 text-xs text-stone-500">
                The Club has not declared its 2026 payroll implementation position. Choose
                whether Spectre is the sole payroll system for 2026 or whether prior payroll
                exists from another provider.
              </p>
              <a
                href="/app/admin/payroll/setup#payroll-implementation"
                className="mt-2 inline-block text-xs text-blue-700 hover:underline"
                data-testid="payroll-implementation-configure-link"
              >
                Configure Payroll Implementation →
              </a>
            </div>
          )}
        </div>

        {/* Opening YTD --------------------------------------------- */}
        <div className="mt-5" data-testid="payroll-opening-ytd">
          <div className="text-[11px] uppercase tracking-wide text-stone-500">Opening YTD</div>
          {implementationDeclaration?.mode === "MID_YEAR_MIGRATION" ? (
            openingBalance ? (
              <div className="mt-2">
                <div className="flex items-center gap-2">
                  <Pill tone={openingBalance.status === "ACTIVE" ? "ok" : "neutral"}>
                    {humanOpeningBalanceStatus(openingBalance.status)}
                  </Pill>
                  {openingBalance.throughPayDateIso && (
                    <span className="text-xs text-stone-500">
                      through {formatCivilDate(openingBalance.throughPayDateIso)}
                    </span>
                  )}
                </div>
                <div className="mt-3 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-xs">
                  <div className="col-span-2 mt-1 text-[10px] uppercase tracking-wide text-stone-400">Earnings</div>
                  <span className="text-stone-500">Gross</span>       <span className="font-mono">{formatMoney(openingBalance.ytdGross)}</span>
                  <span className="text-stone-500">Taxable</span>     <span className="font-mono">{formatMoney(openingBalance.ytdTaxable)}</span>
                  <span className="text-stone-500">Pensionable</span> <span className="font-mono">{formatMoney(openingBalance.ytdPensionable)}</span>
                  <span className="text-stone-500">Insurable</span>   <span className="font-mono">{formatMoney(openingBalance.ytdInsurable)}</span>

                  <div className="col-span-2 mt-2 text-[10px] uppercase tracking-wide text-stone-400">Employee deductions</div>
                  <span className="text-stone-500">CPP</span>         <span className="font-mono">{formatMoney(openingBalance.ytdCppEE)}</span>
                  <span className="text-stone-500">EI</span>          <span className="font-mono">{formatMoney(openingBalance.ytdEiEE)}</span>
                  <span className="text-stone-500">Federal tax</span> <span className="font-mono">{formatMoney(openingBalance.ytdFederalTax)}</span>
                  <span className="text-stone-500">Provincial tax</span> <span className="font-mono">{formatMoney(openingBalance.ytdProvincialTax)}</span>
                </div>
                <a
                  href={`/app/admin/payroll/opening-balances?employeeId=${employeeId}`}
                  className="mt-3 inline-block text-xs text-blue-700 hover:underline"
                  data-testid="opening-ytd-manage-link"
                >
                  {openingBalance.status === "ACTIVE" ? "View / correct →" : "Edit opening YTD →"}
                </a>
                <p className="mt-2 text-[10px] text-stone-400">
                  Values are the opening YTD entered for migration from the prior payroll system.
                </p>
              </div>
            ) : (
              <div className="mt-2">
                <Pill tone="warn">Not started</Pill>
                <p className="mt-2 text-xs text-stone-500">
                  The Club is on Mid-year migration. This employee needs opening YTD entered.
                </p>
                <a
                  href={`/app/admin/payroll/opening-balances?employeeId=${employeeId}`}
                  className="mt-2 inline-block text-xs text-blue-700 hover:underline"
                  data-testid="opening-ytd-set-link"
                >
                  Set opening YTD →
                </a>
              </div>
            )
          ) : implementationDeclaration?.mode === "ZERO_OPENING_YTD" ? (
            <div className="mt-2">
              <Pill tone="ok">Beginning-of-year</Pill>
              <p className="mt-2 text-xs text-stone-500">
                Spectre is the sole payroll system for {implementationDeclaration.taxYear}. No opening YTD required.
              </p>
            </div>
          ) : (
            <p className="mt-2 text-xs text-stone-500">Opening YTD becomes relevant once Payroll Implementation is configured.</p>
          )}
        </div>
      </div>
    </section>
  );
}
