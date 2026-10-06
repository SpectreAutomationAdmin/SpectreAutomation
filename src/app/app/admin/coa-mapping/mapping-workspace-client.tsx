"use client";

// COA-MAP-1 (2026-10-06) — Mapping Studio client island.
//
// Implements:
//  - financial-statement hierarchy view (IS / BS / CF / other)
//  - drag-and-drop account → group reassignment (HTML5 DnD)
//  - keyboard-accessible fallback via Account Inspector
//  - destination highlighting during drag
//  - unmapped / attention queue
//  - inline create-group affordance
//  - reporting impact preview before Apply
//
// All mutations route through the staging-only COA-MAP-1 API.

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

type GroupLite = {
  id: string;
  key: string;
  name: string;
  statement: string;
  parentGroupId: string | null;
  reportingRole: string | null;
  isTenantCreated: boolean;
  sortOrder: number;
  accounts: ReadonlyArray<AccountLite>;
};

type AccountLite = {
  id: string;
  accountNumber: string;
  name: string;
  type: string;
  normalBalance: string;
  fsGroupId: string | null;
  fundApplicability: string | null;
};

type PreviewResult = {
  accountNumber: string;
  accountName: string;
  currentFsGroup: { id: string; name: string; statement: string } | null;
  targetFsGroup: { id: string; name: string; statement: string };
  rows: Array<{ key: string; label: string; beforeLabel: string; afterLabel: string; deltaLabel: string }>;
  note: string;
};

type Props = {
  clubId: string;
  incomeStatement: ReadonlyArray<GroupLite>;
  balanceSheet: ReadonlyArray<GroupLite>;
  cashFlow: ReadonlyArray<GroupLite>;
  other: ReadonlyArray<GroupLite>;
  unmapped: ReadonlyArray<AccountLite>;
};

export default function MappingWorkspaceClient(props: Props) {
  const router = useRouter();
  const [dragging, setDragging] = useState<AccountLite | null>(null);
  const [hoverGroupId, setHoverGroupId] = useState<string | null>(null);
  const [selected, setSelected] = useState<AccountLite | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [pendingTargetGroupId, setPendingTargetGroupId] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "previewing" | "applying" | "error">("idle");
  const [errorText, setErrorText] = useState<string | null>(null);
  const [confirmWarnings, setConfirmWarnings] = useState(false);

  const allGroups = useMemo(
    () => [...props.incomeStatement, ...props.balanceSheet, ...props.cashFlow, ...props.other],
    [props.incomeStatement, props.balanceSheet, props.cashFlow, props.other],
  );

  async function requestPreview(accountId: string, targetGroupId: string) {
    setState("previewing");
    setErrorText(null);
    setConfirmWarnings(false);
    try {
      const res = await fetch("/api/admin/coa-mapping/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clubId: props.clubId, accountId, targetFsGroupId: targetGroupId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(body.error ?? "Preview failed");
      }
      const data = (await res.json()) as PreviewResult;
      setPreview(data);
      setPendingTargetGroupId(targetGroupId);
      setState("idle");
    } catch (e) {
      setErrorText(e instanceof Error ? e.message : "Preview failed");
      setState("error");
    }
  }

  async function applyReassignment(targetGroupId: string, accountId: string, effectiveFromISO: string, acknowledge = false) {
    setState("applying");
    setErrorText(null);
    try {
      const res = await fetch(`/api/admin/coa-mapping/accounts/${accountId}/reassign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clubId: props.clubId,
          targetFsGroupId: targetGroupId,
          effectiveFrom: effectiveFromISO,
          acknowledgeWarnings: acknowledge,
        }),
      });
      const body = await res.json().catch(() => ({ error: res.statusText }));
      if (res.status === 409) {
        setErrorText("BLOCKED: " + (body.validation?.reasons?.[0]?.message ?? body.error ?? "Reassignment blocked."));
        setState("error");
        return;
      }
      if (res.status === 422) {
        // Warning path — ask for acknowledgement before re-applying.
        setErrorText(
          "WARNING: " +
            (body.validation?.reasons?.[0]?.message ?? "Review the warning and confirm to proceed."),
        );
        setConfirmWarnings(true);
        setState("idle");
        return;
      }
      if (!res.ok) {
        setErrorText(body.error ?? "Reassignment failed");
        setState("error");
        return;
      }
      // OK — refresh.
      setPreview(null);
      setSelected(null);
      setPendingTargetGroupId(null);
      router.refresh();
      setState("idle");
    } catch (e) {
      setErrorText(e instanceof Error ? e.message : "Reassignment failed");
      setState("error");
    }
  }

  function handleDragStart(e: React.DragEvent, account: AccountLite) {
    setDragging(account);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("application/x-spectre-account", account.id);
  }
  function handleDragEnd() {
    setDragging(null);
    setHoverGroupId(null);
  }
  function handleDragOverGroup(e: React.DragEvent, groupId: string) {
    e.preventDefault();
    setHoverGroupId(groupId);
  }
  async function handleDropOnGroup(e: React.DragEvent, groupId: string) {
    e.preventDefault();
    if (!dragging) return;
    setHoverGroupId(null);
    setDragging(null);
    setSelected(dragging);
    await requestPreview(dragging.id, groupId);
  }

  // COA-MAP-1A (2026-10-06) — period-aware default effective-from
  // dates. Financial statement mappings normally change on reporting
  // boundaries, not literal "today". We expose:
  //   - current reporting period start
  //   - fiscal year start
  //   - custom date
  // When the first two resolve to the same date, the UI collapses
  // them intelligently.
  const today = new Date();
  const currentPeriodStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const fiscalYearStart = new Date(Date.UTC(today.getUTCFullYear(), 0, 1));
  const currentPeriodIso = currentPeriodStart.toISOString().slice(0, 10);
  const fiscalYearIso = fiscalYearStart.toISOString().slice(0, 10);
  const todayIso = today.toISOString().slice(0, 10);

  return (
    <section className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      <div className="lg:col-span-2 space-y-6" data-testid="coa-mapping-workspace">
        <GroupSection
          title="Income Statement"
          groups={props.incomeStatement}
          onDragOverGroup={handleDragOverGroup}
          onDropOnGroup={handleDropOnGroup}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onPickAccount={(a) => setSelected(a)}
          hoverGroupId={hoverGroupId}
          testPrefix="is"
        />
        <GroupSection
          title="Balance Sheet"
          groups={props.balanceSheet}
          onDragOverGroup={handleDragOverGroup}
          onDropOnGroup={handleDropOnGroup}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onPickAccount={(a) => setSelected(a)}
          hoverGroupId={hoverGroupId}
          testPrefix="bs"
        />
        {props.cashFlow.length > 0 && (
          <GroupSection
            title="Cash Flow"
            groups={props.cashFlow}
            onDragOverGroup={handleDragOverGroup}
            onDropOnGroup={handleDropOnGroup}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onPickAccount={(a) => setSelected(a)}
            hoverGroupId={hoverGroupId}
            testPrefix="cf"
          />
        )}
        <section className="card" data-testid="coa-mapping-unmapped">
          <div className="card-body">
            <h2 className="section-title text-lg">Unmapped Accounts</h2>
            <p className="text-xs text-stone-500">
              Accounts with no Financial Statement Group assignment. These do not
              contribute to any canonical reporting metric until mapped.
            </p>
            {props.unmapped.length === 0 ? (
              <div className="mt-3 text-xs text-stone-500">No unmapped accounts.</div>
            ) : (
              <ul className="mt-3 space-y-1">
                {props.unmapped.map((a) => (
                  <AccountRow
                    key={a.id}
                    account={a}
                    onDragStart={handleDragStart}
                    onDragEnd={handleDragEnd}
                    onPick={() => setSelected(a)}
                  />
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>

      {/* Inspector / preview / create-group panel. */}
      <aside className="space-y-6" data-testid="coa-mapping-inspector">
        <AccountInspector
          account={selected}
          allGroups={allGroups}
          onRequestPreview={requestPreview}
        />
        {preview && (
          <PreviewPanel
            preview={preview}
            errorText={errorText}
            confirmWarnings={confirmWarnings}
            onCancel={() => {
              setPreview(null);
              setPendingTargetGroupId(null);
              setErrorText(null);
              setConfirmWarnings(false);
            }}
            onApply={async (effectiveFromISO) => {
              if (!selected || !pendingTargetGroupId) return;
              await applyReassignment(pendingTargetGroupId, selected.id, effectiveFromISO, confirmWarnings);
            }}
            currentPeriodIso={currentPeriodIso}
            fiscalYearIso={fiscalYearIso}
            todayIso={todayIso}
            applying={state === "applying"}
          />
        )}
        {!preview && errorText && (
          <div className="card">
            <div className="card-body text-sm text-rose-600" data-testid="coa-mapping-error">
              {errorText}
            </div>
          </div>
        )}
        <CreateGroupPanel clubId={props.clubId} />
      </aside>
    </section>
  );
}

function GroupSection(props: {
  title: string;
  groups: ReadonlyArray<GroupLite>;
  onDragOverGroup: (e: React.DragEvent, groupId: string) => void;
  onDropOnGroup: (e: React.DragEvent, groupId: string) => void;
  onDragStart: (e: React.DragEvent, account: AccountLite) => void;
  onDragEnd: () => void;
  onPickAccount: (a: AccountLite) => void;
  hoverGroupId: string | null;
  testPrefix: string;
}) {
  if (props.groups.length === 0) return null;
  return (
    <section className="card" data-testid={`coa-mapping-section-${props.testPrefix}`}>
      <div className="card-body">
        <h2 className="section-title text-lg">{props.title}</h2>
      </div>
      <div className="divide-y">
        {props.groups.map((g) => (
          <div
            key={g.id}
            className={`px-4 py-3 ${props.hoverGroupId === g.id ? "bg-club-cream" : ""}`}
            data-testid={`coa-mapping-group-${g.id}`}
            data-group-key={g.key}
            onDragOver={(e) => props.onDragOverGroup(e, g.id)}
            onDragLeave={() => props.hoverGroupId === g.id}
            onDrop={(e) => props.onDropOnGroup(e, g.id)}
          >
            <div className="flex items-baseline justify-between">
              <div>
                <span className="font-semibold">{g.name}</span>
                {g.isTenantCreated && (
                  <span className="ml-2 badge badge-sand text-[9px]">tenant</span>
                )}
                {g.reportingRole && (
                  <span className="ml-2 text-[11px] uppercase tracking-wider text-stone-500">
                    role: {g.reportingRole}
                  </span>
                )}
              </div>
              <div className="text-[11px] text-stone-500">{g.accounts.length} accounts</div>
            </div>
            {g.accounts.length > 0 && (
              <ul className="mt-2 space-y-1" data-testid={`coa-mapping-group-accounts-${g.id}`}>
                {g.accounts.map((a) => (
                  <AccountRow
                    key={a.id}
                    account={a}
                    onDragStart={props.onDragStart}
                    onDragEnd={props.onDragEnd}
                    onPick={() => props.onPickAccount(a)}
                  />
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function AccountRow(props: {
  account: AccountLite;
  onDragStart: (e: React.DragEvent, account: AccountLite) => void;
  onDragEnd: () => void;
  onPick: () => void;
}) {
  const a = props.account;
  return (
    <li
      draggable
      onDragStart={(e) => props.onDragStart(e, a)}
      onDragEnd={props.onDragEnd}
      onClick={props.onPick}
      className="cursor-grab rounded border border-club-sand/40 bg-club-cream px-2 py-1 text-xs hover:bg-club-sand/40"
      data-testid={`coa-mapping-account-${a.accountNumber}`}
      data-account-id={a.id}
    >
      <span className="font-mono">{a.accountNumber}</span>
      <span className="ml-2">{a.name}</span>
      <span className="ml-2 text-[10px] uppercase tracking-wider text-stone-500">{a.type}</span>
    </li>
  );
}

function AccountInspector(props: {
  account: AccountLite | null;
  allGroups: ReadonlyArray<GroupLite>;
  onRequestPreview: (accountId: string, targetGroupId: string) => Promise<void>;
}) {
  const [targetGroupId, setTargetGroupId] = useState<string>("");
  if (!props.account) {
    return (
      <section className="card" data-testid="coa-mapping-inspector-empty">
        <div className="card-body text-sm text-stone-500">
          Pick or drag an account to inspect it. The inspector is the
          keyboard-accessible alternative to drag-and-drop.
        </div>
      </section>
    );
  }
  const a = props.account;
  const currentGroup = props.allGroups.find((g) => g.id === a.fsGroupId);
  return (
    <section className="card" data-testid="coa-mapping-inspector-filled">
      <div className="card-body space-y-3">
        <h2 className="section-title text-lg">Account Inspector</h2>
        <div className="text-sm">
          <div><span className="font-mono">{a.accountNumber}</span> — {a.name}</div>
          <div className="text-xs text-stone-500">Type: {a.type} · Normal: {a.normalBalance}</div>
          {a.fundApplicability && (
            <div className="text-xs text-stone-500">Fund applicability: {a.fundApplicability}</div>
          )}
          <div className="text-xs text-stone-500">Current group: {currentGroup?.name ?? "(unmapped)"}</div>
        </div>
        <label className="block text-xs text-stone-600">
          Change Financial Statement Group
          <select
            data-testid="coa-mapping-inspector-group-select"
            className="mt-1 block w-full rounded border border-club-sand px-2 py-1 text-sm"
            value={targetGroupId}
            onChange={(e) => setTargetGroupId(e.target.value)}
          >
            <option value="">— pick a group —</option>
            {props.allGroups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.statement.replace(/_/g, " ")} · {g.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="btn-primary"
          disabled={!targetGroupId}
          data-testid="coa-mapping-inspector-preview-button"
          onClick={() => void props.onRequestPreview(a.id, targetGroupId)}
        >
          Preview reassignment
        </button>
      </div>
    </section>
  );
}

type EffectiveMode = "current-period" | "fiscal-year" | "custom";

function PreviewPanel(props: {
  preview: PreviewResult;
  errorText: string | null;
  confirmWarnings: boolean;
  onApply: (effectiveFromISO: string) => Promise<void>;
  onCancel: () => void;
  currentPeriodIso: string;
  fiscalYearIso: string;
  todayIso: string;
  applying: boolean;
}) {
  // COA-MAP-1A (2026-10-06) — period-aware effective-date picker.
  //
  // Default = current reporting period start (the common case).
  // When the current period start === fiscal year start (e.g.
  // Coulee January), collapse the two radio options into one so the
  // Controller doesn't see redundant choices.
  const collapsePeriodAndFiscalYear = props.currentPeriodIso === props.fiscalYearIso;
  const [mode, setMode] = useState<EffectiveMode>("current-period");
  const [customIso, setCustomIso] = useState<string>(props.todayIso);
  const effectiveFromIso =
    mode === "current-period" ? props.currentPeriodIso
    : mode === "fiscal-year" ? props.fiscalYearIso
    : customIso;

  const prettyDate = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
      year: "numeric", month: "long", day: "numeric", timeZone: "UTC",
    });
  };

  // Historical-consequence note. Quiet, non-alarming.
  const effectiveFromDate = new Date(effectiveFromIso);
  const todayDate = new Date(props.todayIso);
  const isHistorical = effectiveFromDate.getTime() < todayDate.getTime();
  const historicalNote = isHistorical
    ? `This change will update unpublished reporting from ${prettyDate(effectiveFromIso)} forward. ` +
      `Published Board packages will not change.`
    : null;

  return (
    <section className="card" data-testid="coa-mapping-preview">
      <div className="card-body space-y-3">
        <h2 className="section-title text-lg">Reporting Impact Preview</h2>
        <div className="text-xs text-stone-500">{props.preview.note}</div>
        <table className="table-base w-full text-xs">
          <thead>
            <tr><th className="text-left">Metric</th><th className="text-left">Before</th><th className="text-left">After</th></tr>
          </thead>
          <tbody>
            {props.preview.rows.map((r) => (
              <tr key={r.key} data-testid={`coa-mapping-preview-row-${r.key}`}>
                <td className="text-left">{r.label}</td>
                <td className="text-left">{r.beforeLabel}</td>
                <td className="text-left">{r.afterLabel}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <ul className="text-xs text-stone-600">
          {props.preview.rows.map((r) => (
            <li key={`delta-${r.key}`}>{r.deltaLabel}</li>
          ))}
        </ul>

        <fieldset className="rounded border border-club-sand p-3" data-testid="coa-mapping-preview-effective-fieldset">
          <legend className="px-1 text-xs font-semibold uppercase tracking-wider text-stone-500">
            Apply this mapping from
          </legend>
          <label className="mt-1 flex items-start gap-2 text-xs">
            <input
              type="radio"
              name="effective-mode"
              checked={mode === "current-period"}
              onChange={() => setMode("current-period")}
              data-testid="coa-mapping-effective-current-period"
            />
            <span>
              <strong>
                {collapsePeriodAndFiscalYear
                  ? "Current reporting period / fiscal year"
                  : "Current reporting period"}
              </strong>
              <br />
              <span className="text-stone-500">{prettyDate(props.currentPeriodIso)}</span>
            </span>
          </label>
          {!collapsePeriodAndFiscalYear && (
            <label className="mt-1 flex items-start gap-2 text-xs">
              <input
                type="radio"
                name="effective-mode"
                checked={mode === "fiscal-year"}
                onChange={() => setMode("fiscal-year")}
                data-testid="coa-mapping-effective-fiscal-year"
              />
              <span>
                <strong>Beginning of fiscal year</strong>
                <br />
                <span className="text-stone-500">{prettyDate(props.fiscalYearIso)}</span>
              </span>
            </label>
          )}
          <label className="mt-1 flex items-start gap-2 text-xs">
            <input
              type="radio"
              name="effective-mode"
              checked={mode === "custom"}
              onChange={() => setMode("custom")}
              data-testid="coa-mapping-effective-custom"
            />
            <span className="flex-1">
              <strong>Choose another date</strong>
              <br />
              <input
                type="date"
                data-testid="coa-mapping-preview-effective-from"
                value={customIso}
                onChange={(e) => { setMode("custom"); setCustomIso(e.target.value); }}
                className="mt-1 block w-full rounded border border-club-sand px-2 py-1"
              />
            </span>
          </label>
        </fieldset>

        {historicalNote && (
          <div
            className="rounded border border-stone-200 bg-stone-50 p-2 text-xs text-stone-700"
            data-testid="coa-mapping-historical-note"
          >
            {historicalNote}
          </div>
        )}

        {props.errorText && (
          <div className="rounded border border-amber-400 bg-amber-50 p-2 text-xs text-amber-900">
            {props.errorText}
            {props.confirmWarnings && (
              <div className="mt-1 text-[11px] text-amber-900">
                Press Apply again to confirm.
              </div>
            )}
          </div>
        )}
        <div className="flex gap-2">
          <button
            type="button"
            className="btn-primary"
            disabled={props.applying}
            data-testid="coa-mapping-preview-apply"
            onClick={() => void props.onApply(effectiveFromIso)}
          >
            {props.applying ? "Applying…" : props.confirmWarnings ? "Apply (confirm warning)" : "Apply"}
          </button>
          <button type="button" className="btn-secondary" onClick={props.onCancel} data-testid="coa-mapping-preview-cancel">
            Cancel
          </button>
        </div>
      </div>
    </section>
  );
}

function CreateGroupPanel({ clubId }: { clubId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [statement, setStatement] = useState<"INCOME_STATEMENT" | "BALANCE_SHEET" | "CASH_FLOW">("INCOME_STATEMENT");
  const [role, setRole] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/coa-mapping/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clubId,
          name,
          statement,
          reportingRole: role || null,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error ?? "Create failed");
        return;
      }
      setName("");
      setRole("");
      setOpen(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Create failed");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <section className="card">
        <div className="card-body">
          <button type="button" className="btn-secondary" onClick={() => setOpen(true)} data-testid="coa-mapping-create-group-open">
            + Financial Statement Group
          </button>
        </div>
      </section>
    );
  }
  return (
    <section className="card" data-testid="coa-mapping-create-group-form">
      <div className="card-body space-y-2">
        <h2 className="section-title text-lg">Create group</h2>
        <label className="block text-xs">
          Name
          <input
            data-testid="coa-mapping-create-group-name"
            className="mt-1 block w-full rounded border border-club-sand px-2 py-1 text-sm"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="block text-xs">
          Statement
          <select
            data-testid="coa-mapping-create-group-statement"
            className="mt-1 block w-full rounded border border-club-sand px-2 py-1 text-sm"
            value={statement}
            onChange={(e) => setStatement(e.target.value as typeof statement)}
          >
            <option value="INCOME_STATEMENT">Income Statement</option>
            <option value="BALANCE_SHEET">Balance Sheet</option>
            <option value="CASH_FLOW">Cash Flow</option>
          </select>
        </label>
        <label className="block text-xs">
          Reporting role (optional)
          <input
            data-testid="coa-mapping-create-group-role"
            className="mt-1 block w-full rounded border border-club-sand px-2 py-1 text-sm"
            placeholder="e.g. OTHER_INCOME"
            value={role}
            onChange={(e) => setRole(e.target.value)}
          />
        </label>
        {error && <div className="text-xs text-rose-600">{error}</div>}
        <div className="flex gap-2">
          <button type="button" className="btn-primary" onClick={submit} disabled={busy || !name.trim()} data-testid="coa-mapping-create-group-submit">
            {busy ? "Creating…" : "Create"}
          </button>
          <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>Cancel</button>
        </div>
      </div>
    </section>
  );
}
