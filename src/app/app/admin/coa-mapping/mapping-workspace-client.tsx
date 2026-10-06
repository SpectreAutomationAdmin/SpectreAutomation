"use client";

// COA-MAP-1 (2026-10-06) — Mapping Studio client island.
// COA-MAP-2 (2026-10-06) — Spectre-grade workspace:
//   • statement switcher (Income Statement / Balance Sheet / Cash Flow)
//   • search across number + name + group
//   • filter chips (All / Needs review / Unmapped / Tenant-created)
//   • Statement → Section → Group → Account hierarchy
//   • humanized reporting-role + statement labels (no raw enums)
//   • edge-triggered auto-scroll during drag
//   • hover drop-target affordance ("Move to {group}")
//   • Account Inspector with REPORTING HISTORY (effective-dated)
//   • quiet empty attention state
//
// All mutations still route through the staging-only COA-MAP-1 API.
// Period-aware effective-date UX (COA-MAP-1A) preserved verbatim.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  labelForReportingRole,
  labelForStatement,
  groupBySectionsForStatement,
  REPORTING_ROLES,
  statementForReportingRole,
  isReportingRole,
  type ReportingRole,
} from "@/lib/coa-mapping/reporting-role";

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

type HistoryRow = {
  fsGroupId: string;
  fsGroupName: string;
  statement: string;
  reportingRole: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
};

type FilterMode = "all" | "attention" | "unmapped" | "tenant";
type ActiveStatement = "INCOME_STATEMENT" | "BALANCE_SHEET" | "CASH_FLOW";

type Props = {
  clubId: string;
  activeStatement: ActiveStatement;
  incomeStatement: ReadonlyArray<GroupLite>;
  balanceSheet: ReadonlyArray<GroupLite>;
  cashFlow: ReadonlyArray<GroupLite>;
  other: ReadonlyArray<GroupLite>;
  unmapped: ReadonlyArray<AccountLite>;
  attentionGroupIds: ReadonlyArray<string>;
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

  const [activeStatement, setActiveStatement] = useState<ActiveStatement>(props.activeStatement);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<FilterMode>("all");

  const allGroups = useMemo(
    () => [...props.incomeStatement, ...props.balanceSheet, ...props.cashFlow, ...props.other],
    [props.incomeStatement, props.balanceSheet, props.cashFlow, props.other],
  );
  const groupsById = useMemo(() => {
    const m = new Map<string, GroupLite>();
    for (const g of allGroups) m.set(g.id, g);
    return m;
  }, [allGroups]);
  const attentionSet = useMemo(() => new Set(props.attentionGroupIds), [props.attentionGroupIds]);

  const activeGroups: ReadonlyArray<GroupLite> =
    activeStatement === "BALANCE_SHEET" ? props.balanceSheet
    : activeStatement === "CASH_FLOW" ? props.cashFlow
    : props.incomeStatement;

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
        // BLOCKED path — the Reassign API returns a validation reason.
        // Prefix is preserved for existing error-copy contracts.
        setErrorText("BLOCKED: " + (body.validation?.reasons?.[0]?.message ?? body.error ?? "Reassignment blocked."));
        setState("error");
        return;
      }
      if (res.status === 422) {
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

  // -------- drag + edge-triggered auto-scroll ---------------------
  const scrollRafRef = useRef<number | null>(null);
  const scrollDirRef = useRef<number>(0);

  const stopAutoScroll = useCallback(() => {
    if (scrollRafRef.current != null) {
      cancelAnimationFrame(scrollRafRef.current);
      scrollRafRef.current = null;
    }
    scrollDirRef.current = 0;
  }, []);

  const stepAutoScroll = useCallback(() => {
    const dir = scrollDirRef.current;
    if (dir === 0) {
      scrollRafRef.current = null;
      return;
    }
    window.scrollBy({ top: dir * 18, left: 0, behavior: "auto" });
    scrollRafRef.current = requestAnimationFrame(stepAutoScroll);
  }, []);

  const updateAutoScroll = useCallback(
    (clientY: number) => {
      const vh = window.innerHeight;
      const edge = 80;
      let dir = 0;
      if (clientY < edge) dir = -1;
      else if (clientY > vh - edge) dir = 1;
      scrollDirRef.current = dir;
      if (dir !== 0 && scrollRafRef.current == null) {
        scrollRafRef.current = requestAnimationFrame(stepAutoScroll);
      } else if (dir === 0) {
        stopAutoScroll();
      }
    },
    [stepAutoScroll, stopAutoScroll],
  );

  function handleDragStart(e: React.DragEvent, account: AccountLite) {
    setDragging(account);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("application/x-spectre-account", account.id);
  }
  function handleDragEnd() {
    setDragging(null);
    setHoverGroupId(null);
    stopAutoScroll();
  }
  function handleDragOverGroup(e: React.DragEvent, groupId: string) {
    e.preventDefault();
    setHoverGroupId(groupId);
    updateAutoScroll(e.clientY);
  }
  function handleDragLeaveGroup(groupId: string) {
    setHoverGroupId((cur) => (cur === groupId ? null : cur));
  }
  async function handleDropOnGroup(e: React.DragEvent, groupId: string) {
    e.preventDefault();
    stopAutoScroll();
    if (!dragging) return;
    setHoverGroupId(null);
    setDragging(null);
    setSelected(dragging);
    await requestPreview(dragging.id, groupId);
  }

  useEffect(() => () => stopAutoScroll(), [stopAutoScroll]);

  // -------- COA-MAP-1A period-aware default effective-from -------
  const today = new Date();
  const currentPeriodStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const fiscalYearStart = new Date(Date.UTC(today.getUTCFullYear(), 0, 1));
  const currentPeriodIso = currentPeriodStart.toISOString().slice(0, 10);
  const fiscalYearIso = fiscalYearStart.toISOString().slice(0, 10);
  const todayIso = today.toISOString().slice(0, 10);

  // -------- search + filter ---------------------------------------
  const normalizedSearch = search.trim().toLowerCase();
  const filterActiveGroups = useMemo(() => {
    return activeGroups.filter((g) => {
      if (filter === "tenant" && !g.isTenantCreated) return false;
      if (filter === "attention" && !attentionSet.has(g.id)) return false;
      if (filter === "unmapped") return false;
      if (!normalizedSearch) return true;
      if (g.name.toLowerCase().includes(normalizedSearch)) return true;
      return g.accounts.some(
        (a) =>
          a.accountNumber.toLowerCase().includes(normalizedSearch) ||
          a.name.toLowerCase().includes(normalizedSearch),
      );
    });
  }, [activeGroups, filter, attentionSet, normalizedSearch]);

  const showUnmappedSection = filter === "all" || filter === "unmapped" || filter === "attention";
  const unmappedCount = props.unmapped.length;

  return (
    <section className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
      <div className="space-y-6" data-testid="coa-mapping-workspace">
        {/* Workspace controls — statement switcher + search + filters. */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3 border-b border-stone-200/70 pb-4">
          <StatementSwitcher
            active={activeStatement}
            hasBalanceSheet={props.balanceSheet.length > 0}
            hasCashFlow={props.cashFlow.length > 0}
            onChange={setActiveStatement}
          />
          <div className="flex-1 min-w-[220px]">
            <label className="sr-only" htmlFor="coa-mapping-search-input">
              Search accounts and groups
            </label>
            <input
              id="coa-mapping-search-input"
              data-testid="coa-mapping-search"
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search account number, account name, or group"
              className="w-full rounded border border-stone-200 bg-white px-3 py-1.5 text-sm text-stone-800 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-stone-300"
            />
          </div>
          <FilterChips filter={filter} onChange={setFilter} attentionCount={props.attentionGroupIds.length + unmappedCount} />
        </div>

        {/* Attention queue — unmapped + role-unclassified. */}
        {showUnmappedSection && (
          <section className="rounded border border-stone-200/70 bg-stone-50/60 p-4" data-testid="coa-mapping-unmapped">
            <div className="flex items-baseline justify-between">
              <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-500">
                Needs attention
              </h2>
              <span className="text-[11px] text-stone-500 tabular-nums" data-testid="coa-mapping-attention-count">
                {unmappedCount + props.attentionGroupIds.length}
              </span>
            </div>
            {unmappedCount === 0 && props.attentionGroupIds.length === 0 ? (
              <p className="mt-2 text-sm text-stone-600" data-testid="coa-mapping-empty-attention">
                All accounts mapped.
              </p>
            ) : (
              <>
                {unmappedCount > 0 && (
                  <div className="mt-3">
                    <p className="text-xs text-stone-500">
                      {unmappedCount === 1 ? "1 unmapped account" : `${unmappedCount} unmapped accounts`}
                    </p>
                    <ul className="mt-2 space-y-1">
                      {props.unmapped.map((a) => (
                        <AccountRow
                          key={a.id}
                          account={a}
                          onDragStart={handleDragStart}
                          onDragEnd={handleDragEnd}
                          onPick={() => setSelected(a)}
                          selected={selected?.id === a.id}
                        />
                      ))}
                    </ul>
                  </div>
                )}
                {props.attentionGroupIds.length > 0 && (
                  <div className="mt-3">
                    <p className="text-xs text-stone-500">
                      {props.attentionGroupIds.length === 1
                        ? "1 group has no reporting purpose set"
                        : `${props.attentionGroupIds.length} groups have no reporting purpose set`}
                    </p>
                    <ul className="mt-2 text-xs text-stone-600">
                      {props.attentionGroupIds.map((id) => {
                        const g = groupsById.get(id);
                        return g ? <li key={id}>{g.name}</li> : null;
                      })}
                    </ul>
                  </div>
                )}
              </>
            )}
          </section>
        )}

        {/* Statement hierarchy — Statement → Section → Group → Account. */}
        <StatementHierarchy
          statement={activeStatement}
          groups={filter === "unmapped" ? [] : filterActiveGroups}
          attentionSet={attentionSet}
          hoverGroupId={hoverGroupId}
          dragging={dragging}
          selected={selected}
          search={normalizedSearch}
          onDragOverGroup={handleDragOverGroup}
          onDragLeaveGroup={handleDragLeaveGroup}
          onDropOnGroup={handleDropOnGroup}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onPickAccount={(a) => setSelected(a)}
        />
      </div>

      {/* Inspector / preview / create-group panel. */}
      <aside className="space-y-6" data-testid="coa-mapping-inspector">
        <AccountInspector
          clubId={props.clubId}
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
            <div className="card-body text-sm text-rose-700" data-testid="coa-mapping-error">
              {errorText}
            </div>
          </div>
        )}
        <CreateGroupPanel clubId={props.clubId} activeStatement={activeStatement} />
      </aside>

      {/* Floating "Move to {group}" affordance while dragging. */}
      {dragging && hoverGroupId && groupsById.get(hoverGroupId) && (
        <div
          className="pointer-events-none fixed left-1/2 bottom-10 -translate-x-1/2 rounded border border-stone-800 bg-stone-900 px-3 py-1.5 text-xs font-semibold text-stone-50 shadow"
          data-testid="coa-mapping-drop-affordance"
        >
          Move to {groupsById.get(hoverGroupId)!.name}
        </div>
      )}
    </section>
  );
}

// -------- Statement switcher --------------------------------------
function StatementSwitcher(props: {
  active: ActiveStatement;
  hasBalanceSheet: boolean;
  hasCashFlow: boolean;
  onChange: (s: ActiveStatement) => void;
}) {
  const options: Array<{ value: ActiveStatement; label: string; testid: string }> = [
    { value: "INCOME_STATEMENT", label: "Income Statement", testid: "coa-mapping-statement-is" },
  ];
  if (props.hasBalanceSheet) {
    options.push({ value: "BALANCE_SHEET", label: "Balance Sheet", testid: "coa-mapping-statement-bs" });
  }
  if (props.hasCashFlow) {
    options.push({ value: "CASH_FLOW", label: "Cash Flow", testid: "coa-mapping-statement-cf" });
  }
  return (
    <div
      role="tablist"
      aria-label="Financial statement"
      className="inline-flex items-center gap-1 rounded border border-stone-200 bg-white p-0.5"
      data-testid="coa-mapping-statement-switcher"
    >
      {options.map((o) => {
        const isActive = o.value === props.active;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={isActive}
            data-testid={o.testid}
            onClick={() => props.onChange(o.value)}
            className={
              "rounded px-3 py-1 text-xs font-semibold transition-colors " +
              (isActive
                ? "bg-stone-900 text-white"
                : "text-stone-600 hover:bg-stone-100")
            }
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// -------- Filter chips --------------------------------------------
function FilterChips(props: {
  filter: FilterMode;
  attentionCount: number;
  onChange: (f: FilterMode) => void;
}) {
  const chips: Array<{ value: FilterMode; label: string; testid: string }> = [
    { value: "all",       label: "All",             testid: "coa-mapping-filter-all" },
    { value: "attention", label: "Needs review",    testid: "coa-mapping-filter-attention" },
    { value: "unmapped",  label: "Unmapped",        testid: "coa-mapping-filter-unmapped" },
    { value: "tenant",    label: "Tenant-created",  testid: "coa-mapping-filter-tenant" },
  ];
  return (
    <div className="flex items-center gap-1" data-testid="coa-mapping-filters">
      {chips.map((c) => {
        const isActive = c.value === props.filter;
        return (
          <button
            key={c.value}
            type="button"
            data-testid={c.testid}
            onClick={() => props.onChange(c.value)}
            className={
              "rounded-full px-3 py-1 text-[11px] font-semibold transition-colors " +
              (isActive
                ? "bg-stone-900 text-white"
                : "border border-stone-200 bg-white text-stone-600 hover:bg-stone-100")
            }
          >
            {c.label}
          </button>
        );
      })}
    </div>
  );
}

// -------- Statement hierarchy -------------------------------------
function StatementHierarchy(props: {
  statement: ActiveStatement;
  groups: ReadonlyArray<GroupLite>;
  attentionSet: Set<string>;
  hoverGroupId: string | null;
  dragging: AccountLite | null;
  selected: AccountLite | null;
  search: string;
  onDragOverGroup: (e: React.DragEvent, groupId: string) => void;
  onDragLeaveGroup: (groupId: string) => void;
  onDropOnGroup: (e: React.DragEvent, groupId: string) => void;
  onDragStart: (e: React.DragEvent, account: AccountLite) => void;
  onDragEnd: () => void;
  onPickAccount: (a: AccountLite) => void;
}) {
  const testPrefix = props.statement === "BALANCE_SHEET" ? "bs" : props.statement === "CASH_FLOW" ? "cf" : "is";
  const sections = useMemo(
    () => groupBySectionsForStatement(props.statement, props.groups),
    [props.statement, props.groups],
  );

  if (sections.length === 0) {
    return (
      <section
        className="rounded border border-stone-200/70 bg-white px-5 py-8"
        data-testid={`coa-mapping-section-${testPrefix}`}
      >
        <p className="text-sm text-stone-500">
          {props.search
            ? "No accounts or groups match that search."
            : `No ${labelForStatement(props.statement)} groups.`}
        </p>
      </section>
    );
  }

  return (
    <section
      className="rounded border border-stone-200/70 bg-white"
      data-testid={`coa-mapping-section-${testPrefix}`}
      data-statement={props.statement}
    >
      {sections.map((sec, i) => (
        <div
          key={sec.label}
          className={i === 0 ? "" : "border-t border-stone-200/70"}
        >
          <h3 className="sticky top-0 z-10 bg-white px-5 py-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-500">
            {sec.label}
          </h3>
          <ul className="divide-y divide-stone-100">
            {sec.groups.map((g) => (
              <GroupRow
                key={g.id}
                group={g}
                attention={props.attentionSet.has(g.id)}
                hovered={props.hoverGroupId === g.id}
                dragging={props.dragging}
                selected={props.selected}
                onDragOverGroup={props.onDragOverGroup}
                onDragLeaveGroup={props.onDragLeaveGroup}
                onDropOnGroup={props.onDropOnGroup}
                onDragStart={props.onDragStart}
                onDragEnd={props.onDragEnd}
                onPickAccount={props.onPickAccount}
              />
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

// -------- One group row -------------------------------------------
function GroupRow(props: {
  group: GroupLite;
  attention: boolean;
  hovered: boolean;
  dragging: AccountLite | null;
  selected: AccountLite | null;
  onDragOverGroup: (e: React.DragEvent, groupId: string) => void;
  onDragLeaveGroup: (groupId: string) => void;
  onDropOnGroup: (e: React.DragEvent, groupId: string) => void;
  onDragStart: (e: React.DragEvent, account: AccountLite) => void;
  onDragEnd: () => void;
  onPickAccount: (a: AccountLite) => void;
}) {
  const g = props.group;
  const [expanded, setExpanded] = useState<boolean>(true);
  const roleLabel = g.reportingRole && isReportingRole(g.reportingRole)
    ? labelForReportingRole(g.reportingRole)
    : null;

  // Drop-eligibility ring during drag. Groups in the SAME statement
  // as the dragged account's current group are the quiet-valid set;
  // we keep the ring neutral in resting state.
  const dragActive = props.dragging != null;
  const ringClass = dragActive
    ? props.hovered
      ? "bg-stone-100"
      : "bg-white hover:bg-stone-50"
    : "bg-white";

  return (
    <li
      className={`px-5 py-3 ${ringClass}`}
      data-testid={`coa-mapping-group-${g.id}`}
      data-group-key={g.key}
      data-attention={props.attention ? "true" : "false"}
      onDragOver={(e) => props.onDragOverGroup(e, g.id)}
      onDragLeave={() => props.onDragLeaveGroup(g.id)}
      onDrop={(e) => props.onDropOnGroup(e, g.id)}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-baseline justify-between text-left"
        aria-expanded={expanded}
      >
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-semibold text-stone-900">{g.name}</span>
          {g.isTenantCreated && (
            <span className="rounded bg-stone-100 px-1.5 py-[1px] text-[10px] font-semibold uppercase tracking-wider text-stone-600">
              Tenant
            </span>
          )}
          {roleLabel && (
            <span className="text-[11px] text-stone-500">· {roleLabel}</span>
          )}
          {props.attention && (
            <span className="text-[11px] font-semibold text-amber-700">· Needs review</span>
          )}
        </div>
        <span className="text-[11px] tabular-nums text-stone-500">
          {g.accounts.length} {g.accounts.length === 1 ? "account" : "accounts"}
        </span>
      </button>
      {expanded && g.accounts.length > 0 && (
        <ul className="mt-2 space-y-1" data-testid={`coa-mapping-group-accounts-${g.id}`}>
          {g.accounts.map((a) => (
            <AccountRow
              key={a.id}
              account={a}
              onDragStart={props.onDragStart}
              onDragEnd={props.onDragEnd}
              onPick={() => props.onPickAccount(a)}
              selected={props.selected?.id === a.id}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

// -------- One account row -----------------------------------------
function AccountRow(props: {
  account: AccountLite;
  onDragStart: (e: React.DragEvent, account: AccountLite) => void;
  onDragEnd: () => void;
  onPick: () => void;
  selected?: boolean;
}) {
  const a = props.account;
  return (
    <li
      draggable
      onDragStart={(e) => props.onDragStart(e, a)}
      onDragEnd={props.onDragEnd}
      onClick={props.onPick}
      className={
        "flex cursor-grab items-baseline gap-3 rounded px-2 py-1 text-xs transition-colors active:cursor-grabbing " +
        (props.selected
          ? "bg-stone-900/95 text-stone-50"
          : "text-stone-700 hover:bg-stone-100")
      }
      data-testid={`coa-mapping-account-${a.accountNumber}`}
      data-account-id={a.id}
    >
      <span className={
        "w-[52px] shrink-0 font-mono text-[11px] tabular-nums " +
        (props.selected ? "text-stone-200" : "text-stone-500")
      }>
        {a.accountNumber}
      </span>
      <span className="flex-1 truncate">{a.name}</span>
    </li>
  );
}

// -------- Account Inspector ---------------------------------------
function AccountInspector(props: {
  clubId: string;
  account: AccountLite | null;
  allGroups: ReadonlyArray<GroupLite>;
  onRequestPreview: (accountId: string, targetGroupId: string) => Promise<void>;
}) {
  const [targetGroupId, setTargetGroupId] = useState<string>("");
  const [history, setHistory] = useState<ReadonlyArray<HistoryRow>>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  useEffect(() => {
    setTargetGroupId("");
    setHistory([]);
    if (!props.account) return;
    let cancelled = false;
    setHistoryLoading(true);
    fetch(`/api/admin/coa-mapping/accounts/${props.account.id}/history?clubId=${encodeURIComponent(props.clubId)}`)
      .then((r) => (r.ok ? r.json() : Promise.resolve({ history: [] })))
      .then((data) => {
        if (!cancelled) setHistory((data.history as ReadonlyArray<HistoryRow>) ?? []);
      })
      .catch(() => { if (!cancelled) setHistory([]); })
      .finally(() => { if (!cancelled) setHistoryLoading(false); });
    return () => { cancelled = true; };
  }, [props.account, props.clubId]);

  if (!props.account) {
    return (
      <section className="card" data-testid="coa-mapping-inspector-empty">
        <div className="card-body text-sm text-stone-500">
          Select an account to see its reporting mapping, accounting metadata,
          and history.
        </div>
      </section>
    );
  }
  const a = props.account;
  const currentGroup = props.allGroups.find((g) => g.id === a.fsGroupId);
  const groupsByStatement = {
    INCOME_STATEMENT: props.allGroups.filter((g) => g.statement === "INCOME_STATEMENT"),
    BALANCE_SHEET:    props.allGroups.filter((g) => g.statement === "BALANCE_SHEET"),
    CASH_FLOW:        props.allGroups.filter((g) => g.statement === "CASH_FLOW"),
  };

  return (
    <section className="card" data-testid="coa-mapping-inspector-filled">
      <div className="card-body space-y-4">
        <div>
          <div className="font-mono text-xs text-stone-500 tabular-nums">{a.accountNumber}</div>
          <div className="text-base font-semibold text-stone-900">{a.name}</div>
        </div>

        <section className="space-y-2 border-t border-stone-200/70 pt-3">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-stone-500">
            Financial reporting
          </h3>
          <dl className="space-y-1 text-sm">
            <InspectorField label="Financial Statement" value={currentGroup ? labelForStatement(currentGroup.statement) : "—"} />
            <InspectorField
              label="Financial Statement Group"
              value={currentGroup?.name ?? "Unmapped"}
            />
            <InspectorField
              label="Reporting Purpose"
              value={currentGroup?.reportingRole && isReportingRole(currentGroup.reportingRole)
                ? labelForReportingRole(currentGroup.reportingRole)
                : "—"}
            />
          </dl>
        </section>

        <section className="space-y-2 border-t border-stone-200/70 pt-3">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-stone-500">
            Accounting
          </h3>
          <dl className="space-y-1 text-sm">
            <InspectorField label="Account Type" value={titleize(a.type)} />
            <InspectorField label="Normal Balance" value={titleize(a.normalBalance)} />
            {a.fundApplicability && (
              <InspectorField label="Fund" value={titleize(a.fundApplicability)} />
            )}
          </dl>
        </section>

        <section className="space-y-2 border-t border-stone-200/70 pt-3" data-testid="coa-mapping-reporting-history">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-stone-500">
            Reporting history
          </h3>
          {historyLoading ? (
            <p className="text-xs text-stone-400">Loading…</p>
          ) : history.length === 0 ? (
            <p className="text-xs text-stone-500">No historical mapping yet.</p>
          ) : (
            <ol className="space-y-2">
              {history.map((h, i) => (
                <li
                  key={`${h.fsGroupId}-${h.effectiveFrom}-${i}`}
                  data-testid="coa-mapping-reporting-history-row"
                  className="rounded border border-stone-200/70 px-3 py-2 text-xs"
                >
                  <div className="font-semibold text-stone-800">{h.fsGroupName}</div>
                  <div className="text-[11px] text-stone-500">
                    {formatRange(h.effectiveFrom, h.effectiveTo)}
                    {h.reportingRole && isReportingRole(h.reportingRole) && (
                      <> · {labelForReportingRole(h.reportingRole)}</>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section className="space-y-2 border-t border-stone-200/70 pt-3">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-stone-500">
            Change mapping
          </h3>
          <label className="block text-xs text-stone-600">
            Move to
            <select
              data-testid="coa-mapping-inspector-group-select"
              className="mt-1 block w-full rounded border border-stone-200 bg-white px-2 py-1 text-sm"
              value={targetGroupId}
              onChange={(e) => setTargetGroupId(e.target.value)}
            >
              <option value="">— pick a group —</option>
              {(["INCOME_STATEMENT", "BALANCE_SHEET", "CASH_FLOW"] as const).map((stmt) => {
                const list = groupsByStatement[stmt];
                if (list.length === 0) return null;
                return (
                  <optgroup key={stmt} label={labelForStatement(stmt)}>
                    {list.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </optgroup>
                );
              })}
            </select>
          </label>
          <button
            type="button"
            className="btn-primary"
            disabled={!targetGroupId}
            data-testid="coa-mapping-inspector-preview-button"
            onClick={() => void props.onRequestPreview(a.id, targetGroupId)}
          >
            Preview change
          </button>
        </section>
      </div>
    </section>
  );
}

function InspectorField(props: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-[11px] text-stone-500">{props.label}</dt>
      <dd className="truncate text-sm text-stone-900">{props.value}</dd>
    </div>
  );
}

function titleize(s: string): string {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()).replace(/_/g, " ");
}

function formatRange(fromISO: string, toISO: string | null): string {
  const pretty = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
      year: "numeric", month: "short", day: "numeric", timeZone: "UTC",
    });
  };
  return `${pretty(fromISO)} – ${toISO ? pretty(toISO) : "Present"}`;
}

// -------- Preview Panel (COA-MAP-1A UX preserved) ------------------
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

  const effectiveFromDate = new Date(effectiveFromIso);
  const todayDate = new Date(props.todayIso);
  const isHistorical = effectiveFromDate.getTime() < todayDate.getTime();
  const historicalNote = isHistorical
    ? `This change will update unpublished reporting from ${prettyDate(effectiveFromIso)} forward. ` +
      `Published Board packages will not change.`
    : null;

  const currentLabel = props.preview.currentFsGroup?.name ?? "Unmapped";
  const proposedLabel = props.preview.targetFsGroup.name;

  return (
    <section className="card" data-testid="coa-mapping-preview">
      <div className="card-body space-y-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-500">
          Reporting impact
        </h2>
        <div className="space-y-1">
          <div className="text-xs text-stone-500">
            <span className="font-mono tabular-nums">{props.preview.accountNumber}</span>
            {" · "}
            {props.preview.accountName}
          </div>
          <div className="text-sm">
            <span className="text-stone-500">Current</span>
            {" · "}
            <span className="text-stone-900">{currentLabel}</span>
          </div>
          <div className="text-sm">
            <span className="text-stone-500">Proposed</span>
            {" · "}
            <span className="font-semibold text-stone-900">{proposedLabel}</span>
          </div>
        </div>
        <table className="table-base w-full text-xs">
          <thead>
            <tr><th className="text-left">Metric</th><th className="text-left">Before</th><th className="text-left">After</th></tr>
          </thead>
          <tbody>
            {props.preview.rows.map((r) => (
              <tr key={r.key} data-testid={`coa-mapping-preview-row-${r.key}`}>
                <td className="text-left">{r.label}</td>
                <td className="text-left">{humanizeLabel(r.beforeLabel)}</td>
                <td className="text-left">{humanizeLabel(r.afterLabel)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <ul className="text-xs text-stone-600">
          {props.preview.rows.map((r) => (
            <li key={`delta-${r.key}`}>{humanizeLabel(r.deltaLabel)}</li>
          ))}
        </ul>

        <fieldset className="rounded border border-stone-200 p-3" data-testid="coa-mapping-preview-effective-fieldset">
          <legend className="px-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-500">
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
                className="mt-1 block w-full rounded border border-stone-200 px-2 py-1"
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
          <div
            className={
              "rounded border p-2 text-xs " +
              (props.errorText.startsWith("BLOCKED")
                ? "border-rose-300 bg-rose-50 text-rose-900"
                : "border-amber-300 bg-amber-50 text-amber-900")
            }
          >
            {humanizePreviewError(props.errorText)}
            {props.confirmWarnings && (
              <div className="mt-1 text-[11px]">
                Press Review &amp; Apply to confirm this change.
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
            {props.applying ? "Applying…" : props.confirmWarnings ? "Review & Apply" : "Apply"}
          </button>
          <button type="button" className="btn-secondary" onClick={props.onCancel} data-testid="coa-mapping-preview-cancel">
            Cancel
          </button>
        </div>
      </div>
    </section>
  );
}

function humanizeLabel(s: string): string {
  // The preview service returns labels like "Income Statement" already,
  // but older rows may contain raw enum tokens. Strip underscores and
  // title-case anything that looks like an enum.
  if (/^[A-Z][A-Z_]+$/.test(s)) return titleize(s);
  return s;
}

function humanizePreviewError(err: string): string {
  // Preserve the BLOCKED/WARNING prefix for existing contracts but
  // present a soft readable sentence to the Controller.
  if (err.startsWith("BLOCKED:")) return err.replace(/^BLOCKED:\s*/, "").trim() || "This mapping is not allowed.";
  if (err.startsWith("WARNING:")) return err.replace(/^WARNING:\s*/, "").trim() || "This change needs your attention.";
  return err;
}

// -------- Create Group panel (humanized Reporting Purpose) --------
function CreateGroupPanel({ clubId, activeStatement }: { clubId: string; activeStatement: ActiveStatement }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [statement, setStatement] = useState<"INCOME_STATEMENT" | "BALANCE_SHEET" | "CASH_FLOW">(activeStatement);
  const [role, setRole] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { setStatement(activeStatement); }, [activeStatement]);

  // If the Controller picks a reporting purpose, infer the statement.
  useEffect(() => {
    if (!role || !isReportingRole(role)) return;
    const inferred = statementForReportingRole(role);
    if (inferred === "INCOME_STATEMENT" || inferred === "BALANCE_SHEET") {
      setStatement(inferred);
    }
  }, [role]);

  const roleOptions = useMemo(() => {
    return REPORTING_ROLES.filter((r) => {
      const owning = statementForReportingRole(r);
      if (owning === "ANY") return true;
      return owning === statement;
    });
  }, [statement]);

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
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setOpen(true)}
            data-testid="coa-mapping-create-group-open"
          >
            + Financial Statement Group
          </button>
        </div>
      </section>
    );
  }
  return (
    <section className="card" data-testid="coa-mapping-create-group-form">
      <div className="card-body space-y-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-500">
          Create Financial Statement Group
        </h2>
        <label className="block text-xs text-stone-600">
          Name
          <input
            data-testid="coa-mapping-create-group-name"
            className="mt-1 block w-full rounded border border-stone-200 bg-white px-2 py-1 text-sm"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Investment Income"
          />
        </label>
        <label className="block text-xs text-stone-600">
          Financial Statement
          <select
            data-testid="coa-mapping-create-group-statement"
            className="mt-1 block w-full rounded border border-stone-200 bg-white px-2 py-1 text-sm"
            value={statement}
            onChange={(e) => setStatement(e.target.value as typeof statement)}
          >
            <option value="INCOME_STATEMENT">{labelForStatement("INCOME_STATEMENT")}</option>
            <option value="BALANCE_SHEET">{labelForStatement("BALANCE_SHEET")}</option>
            <option value="CASH_FLOW">{labelForStatement("CASH_FLOW")}</option>
          </select>
        </label>
        <label className="block text-xs text-stone-600">
          Reporting Purpose
          <select
            data-testid="coa-mapping-create-group-role"
            className="mt-1 block w-full rounded border border-stone-200 bg-white px-2 py-1 text-sm"
            value={role}
            onChange={(e) => setRole(e.target.value)}
          >
            <option value="">— choose a reporting purpose —</option>
            {roleOptions.map((r) => (
              <option key={r} value={r}>
                {labelForReportingRole(r as ReportingRole)}
              </option>
            ))}
          </select>
        </label>
        {error && <div className="text-xs text-rose-700">{error}</div>}
        <div className="flex gap-2">
          <button type="button" className="btn-primary" onClick={submit} disabled={busy || !name.trim()} data-testid="coa-mapping-create-group-submit">
            {busy ? "Creating…" : "Create group"}
          </button>
          <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>Cancel</button>
        </div>
      </div>
    </section>
  );
}
