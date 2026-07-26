import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { hasPermission } from "@/lib/rbac";
import { getActiveClubId } from "@/lib/active-club";
import { InfoTip } from "@/components/InfoTip";
import { checkAccountDeletionSafety } from "@/lib/accounting/coa";
import { accountBalances } from "@/lib/accounting/balance";
import {
  createAccountAction,
  // updateAccountAction is intentionally NOT imported at page level.
  // Phase B — the workspace inspector calls updateAccountInspectorAction
  // directly. The redirect-driven updateAccountAction remains exported
  // from _actions.ts for legacy compatibility (any submit that lands
  // there still redirects to `?ok=updated`).
  archiveAccountAction,
  reactivateAccountAction,
  deleteAccountAction,
  bulkSetFundApplicabilityAction,
} from "./_actions";
import {
  KNOWN_FUND_KEYS,
  parseFundApplicability,
  type FundKey,
} from "@/lib/accounting/fund-applicability";
import { ChartOfAccountsClient, type DwAccountRow } from "@/components/data-workspace/ChartOfAccountsClient";
import ChartOfAccountsImportModal from "@/components/data-workspace/ChartOfAccountsImportModal";

// -----------------------------------------------------------------------
// Chart of Accounts — Data Workspace Foundation v1.0 (2026-07-18).
//
// This page is the FIRST production surface built on the Data Workspace
// Foundation. It preserves every legacy URL grammar so bookmarks, deep
// links, and the existing test suite continue to work unchanged:
//
//   ?modal=new                — opens the New Account modal
//   ?edit=<id>                — opens the Edit modal
//   ?delete=<id>              — opens the Delete confirmation
//   ?mode=fund                — Fund Applicability assignment saved view
//   ?showInactive=1           — includes archived accounts
//   ?fund=OPERATING|CAPITAL|BOTH|NONE — fund chip filter
//   ?ok=<verb>&num=<n>        — success banner after redirect-driven action
//   ?warning=<msg>            — amber banner
//   ?error=<msg>              — red banner
//   ?select=<id>              — opens the read-only inspector (Phase A)
//
// Legacy business rules preserved verbatim:
//   • Section grouping — Type → Category → FS Group → Account
//   • Fixed default sort — `accountNumber asc`
//   • Fund filter semantics (OPERATING / CAPITAL / BOTH / NONE)
//   • `?mode=fund` filters to P&L accounts only + adds the bulk fund
//     assignment form + per-row checkboxes
//   • Delete safety preflight (`checkAccountDeletionSafety`) with
//     Archive fallback when references exist
//   • `coa:read` gates the page; `coa:write` gates every mutation
//   • Every existing `data-testid` is preserved on the same DOM shape
//     the current e2e suite queries
//
// Editing surface for this integration phase:
//   • The read-only inspector opens on row click (?select=<id>).
//   • Its "Edit" primary action navigates to ?edit=<id> which opens the
//     LEGACY MODAL. Inspector-level editing is a follow-up sprint
//     (Phase B / phase 7 of the Data Workspace integration plan).
//
// Server actions (`_actions.ts`) are intentionally untouched during this
// integration.
// -----------------------------------------------------------------------

const TYPE_ORDER = ["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"] as const;
type AccountType = (typeof TYPE_ORDER)[number];

const DISABLED_TOOLTIP =
  "Your role does not have permission to maintain the Chart of Accounts. Contact your Club Controller if access is required.";

const ACCOUNTING_DEFAULT_FIELDS = [
  "defaultArAccountId",
  "defaultApAccountId",
  "defaultRetainedEarningsAccountId",
  "defaultCurrentYearEarningsAccountId",
  "defaultOperatingBankAccountId",
  "defaultReserveBankAccountId",
  "defaultMemberReceivablesAccountId",
  "defaultSalesTaxPayableAccountId",
] as const;

type SearchParams = {
  modal?: string;
  edit?: string;
  delete?: string;
  select?: string;
  ok?: string;
  num?: string;
  warning?: string;
  error?: string;
  showInactive?: string;
  fund?: string;
  mode?: string;
  /** Sprint 1 acceptance repair (2026-07-19).
   *  The concept HTML ships a small "Review states" floating panel
   *  that lets a design reviewer flip between state presets
   *  (default / selected / editing / error / …). The founder ruled
   *  this must stay as a design-QA affordance but MUST NOT reach
   *  real production users. Server-side we compute a `reviewMode`
   *  flag that is true only when NODE_ENV=development or the URL
   *  carries `?_review=1`. The client renders the panel exclusively
   *  when that flag is true. */
  _review?: string;
};

export default async function COAPage({ searchParams }: { searchParams: SearchParams }) {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });
  if (!hasPermission(principal, clubId, "coa:read")) redirect("/app/admin");

  const showInactive = searchParams.showInactive === "1";
  const accountWhere = { clubId, ...(showInactive ? {} : { isActive: true }) };
  const rawFund = searchParams.fund?.trim().toUpperCase() ?? "";
  const fundFilter: "OPERATING" | "CAPITAL" | "BOTH" | "NONE" | null =
    rawFund === "OPERATING" || rawFund === "CAPITAL" || rawFund === "BOTH" || rawFund === "NONE"
      ? (rawFund as "OPERATING" | "CAPITAL" | "BOTH" | "NONE")
      : null;
  const fundMode = searchParams.mode === "fund";
  const canEdit = hasPermission(principal, clubId, "coa:write");

  const [allAccounts, profile, categories, fsGroups, departments, balances, lastUpdatedAudit] = await Promise.all([
    prisma.account.findMany({
      where: accountWhere,
      include: { category: true, fsGroup: true, defaultDepartment: true, parent: true },
      orderBy: [{ accountNumber: "asc" }],
    }),
    prisma.clubProfile.findUnique({ where: { clubId } }),
    prisma.accountCategory.findMany({ where: { clubId }, orderBy: { sortOrder: "asc" } }),
    prisma.financialStatementGroup.findMany({ where: { clubId }, orderBy: { sortOrder: "asc" } }),
    prisma.department.findMany({ where: { clubId }, orderBy: { sortOrder: "asc" } }),
    // Sprint 1 acceptance repair (2026-07-19) — pull current account
    // balances from the canonical accounting projection so the Balance
    // column and section totals reconcile to Trial Balance. We use
    // `naturalBalance` from `accountBalances(...)` — do NOT invert
    // signs in the UI. See src/lib/accounting/balance.ts:20-42 for the
    // AccountBalance shape and the `naturalBalance = normalBalance === "DEBIT" ? signed : -signed` rule.
    accountBalances(clubId, { asOf: new Date() }),
    // Last CoA-scoped mutation from the audit log. Any action string
    // beginning with `coa.` is a genuine Chart of Accounts change
    // (`coa.account.create`, `coa.account.update`, `coa.account.archive`,
    // `coa.account.delete`, `coa.account.bulk-fund-applicability`).
    // Import-side rows (`import.coa.*`) are intentionally excluded —
    // the founder-approved concept only surfaces direct CoA edits here.
    prisma.auditLog.findFirst({
      where: { clubId, entityType: "Account", action: { startsWith: "coa." } },
      orderBy: { createdAt: "desc" },
      include: { user: true },
    }),
  ]);

  const accounts = allAccounts.filter((a) => {
    if (fundMode && a.type !== "REVENUE" && a.type !== "EXPENSE") return false;
    if (!fundFilter) return true;
    const rawFa = (a as unknown as { fundApplicability: string | null }).fundApplicability;
    const funds = new Set<FundKey>(parseFundApplicability(rawFa));
    const isPL = a.type === "REVENUE" || a.type === "EXPENSE";
    switch (fundFilter) {
      case "OPERATING": return funds.has("OPERATING");
      case "CAPITAL":   return funds.has("CAPITAL");
      case "BOTH":      return funds.has("OPERATING") && funds.has("CAPITAL");
      case "NONE":      return isPL && funds.size === 0;
    }
  });

  const unmappedPlCount = allAccounts.filter((a) => {
    const isPL = a.type === "REVENUE" || a.type === "EXPENSE";
    if (!isPL) return false;
    const raw = (a as unknown as { fundApplicability: string | null }).fundApplicability;
    return raw == null || String(raw).trim().length === 0;
  }).length;

  const controlAccountIds = new Set<string>();
  if (profile) {
    const p = profile as unknown as Record<string, string | null | undefined>;
    for (const field of ACCOUNTING_DEFAULT_FIELDS) {
      const id = p[field];
      if (id) controlAccountIds.add(id);
    }
  }

  // Build a lookup for balances so the row serialiser runs in O(1). The
  // authoritative sign per account is `naturalBalance` — see the
  // Sprint 1 acceptance repair comment above.
  const balanceById = new Map<string, number>();
  for (const b of balances) balanceById.set(b.accountId, Number(b.naturalBalance));

  // Serialise accounts into the client-side row shape. Deriving the
  // validation state here keeps the client component small and avoids
  // duplicating the "isPL && no funds" rule across two files.
  const clientRows: DwAccountRow[] = accounts.map((a) => {
    const rawFa = (a as unknown as { fundApplicability: string | null }).fundApplicability;
    const fundKeys = parseFundApplicability(rawFa) as Array<"OPERATING" | "CAPITAL">;
    const isPL = a.type === "REVENUE" || a.type === "EXPENSE";
    const fundValidation: DwAccountRow["fundValidation"] =
      isPL && fundKeys.length === 0
        ? "blocked"
        : isPL && fundKeys.length === 1
          ? "ok"   // single-fund is fine
          : "ok";
    return {
      id: a.id,
      accountNumber: a.accountNumber,
      name: a.name,
      description: a.description ?? null,
      type: a.type as AccountType,
      categoryKey: a.category?.key ?? "__uncategorised__",
      categoryLabel: a.category?.name ?? "Uncategorised",
      categorySortOrder: a.category?.sortOrder ?? 9999,
      fsGroupKey: a.fsGroup?.key ?? "__no_fs_group__",
      fsGroupLabel: a.fsGroup?.name ?? "Other",
      fsGroupSortOrder: a.fsGroup?.sortOrder ?? 9999,
      departmentLabel: a.defaultDepartment?.name ?? null,
      fundKeys,
      fundApplicabilityRaw: rawFa ?? "",
      fundValidation,
      isActive: a.isActive,
      isControl: controlAccountIds.has(a.id),
      isBank: a.isBankAccount ?? false,
      isCash: a.isCashAccount ?? false,
      isTaxRelevant: a.isTaxRelevant ?? false,
      isPL,
      parentAccountNumber: (a as { parent?: { accountNumber?: string } | null }).parent?.accountNumber ?? null,
      allowManualPosting: (a as { allowManualPosting?: boolean }).allowManualPosting ?? true,
      updatedAt: (a as { updatedAt?: Date }).updatedAt ? new Date((a as { updatedAt: Date }).updatedAt).toISOString() : new Date(0).toISOString(),
      balance: balanceById.get(a.id) ?? 0,
    };
  });

  // Derive the founder-approved "Last updated <when> by <who>" header
  // metadata. Uses the audit log ordered by createdAt desc; renders a
  // graceful "No changes yet" when the club is fresh.
  const lastUpdated = lastUpdatedAudit
    ? {
        isoTimestamp: lastUpdatedAudit.createdAt.toISOString(),
        actorName: lastUpdatedAudit.user?.name ?? "the system",
      }
    : null;

  // Phase B — dropdown option lists for the inspector's inline edit
  // form. Pass the SAME lookups the legacy modal used.
  const categoryOptions = categories.map((c) => ({ key: c.key, label: c.name, type: c.type }));
  const fsGroupOptions  = fsGroups.map((g) => ({ key: g.key, label: g.name, statement: g.statement }));
  const departmentOptions = departments.map((d) => ({ key: d.code, label: d.name }));
  const parentOptions = accounts.map((a) => ({ id: a.id, accountNumber: a.accountNumber, name: a.name }));

  const totalCount = accounts.length;
  const activeCount = accounts.filter((a) => a.isActive).length;

  // Modal / inspector state — driven entirely by URL search params.
  //   ?modal=new     → New Account modal (create only)
  //   ?delete=<id>   → Delete confirmation (with safety preflight)
  //   ?edit=<id>     → workspace inspector, edit mode (Phase B)
  //   ?select=<id>   → workspace inspector, viewing mode
  const isNewModal = searchParams.modal === "new";
  // Sprint 1 correction (2026-07-19d) — CoA-specific Import modal
  // opens on `?modal=import`. It reuses the existing production
  // import pipeline via `createCoaImportBatchFromModalAction` in
  // `./_import-actions.ts` — no parallel engine. Direct navigation
  // to this URL is honoured; server-side permission check on
  // `settings:write` guards render + action (below).
  const isImportModal = searchParams.modal === "import";
  const editId = searchParams.edit ?? null;
  const deleteId = searchParams.delete ?? null;
  const selectId = searchParams.select ?? null;
  const deleteAccount = deleteId
    ? accounts.find((a) => a.id === deleteId) ?? (await prisma.account.findFirst({ where: { id: deleteId, clubId } }))
    : null;
  const deleteSafety = deleteAccount
    ? await checkAccountDeletionSafety(principal, deleteAccount.id)
    : null;

  // Phase B — saved view resolution. `fund` and `inactive` are
  // server-decided (they change the query); `needs-attention`,
  // `unassigned-fs`, `recently-changed` are client-side predicates.
  const requestedView = typeof (searchParams as { view?: string }).view === "string" ? (searchParams as { view?: string }).view : undefined;
  const savedView = fundMode
    ? "fund"
    : showInactive
      ? "inactive"
      : requestedView && ["needs-attention", "unassigned-fs", "recently-changed"].includes(requestedView)
        ? requestedView
        : "all-active";

  return (
    <div style={{ margin: "calc(-1 * var(--spectre-workspace-pad-y)) calc(-1 * var(--spectre-workspace-pad-x))" }}>
      {/* ------------------------------ RESULT BANNERS */}
      {searchParams.ok && (
        <div className="spectre-dw-banner ok" data-testid="coa-banner-ok">
          <span>
            <b>{labelForOk(searchParams.ok)}</b>
            {searchParams.num ? ` ${searchParams.num}` : ""}
            {searchParams.warning && (
              <span style={{ marginLeft: 8, color: "var(--spectre-status-warning)", fontWeight: 500 }} data-testid="coa-banner-warning">
                ⚠ {searchParams.warning}
              </span>
            )}
          </span>
        </div>
      )}
      {!searchParams.ok && searchParams.warning && (
        <div className="spectre-dw-banner warn" data-testid="coa-banner-warning">
          <span>⚠ {searchParams.warning}</span>
        </div>
      )}
      {searchParams.error && (
        <div className="spectre-dw-banner error" data-testid="coa-banner-error">
          <span>{searchParams.error}</span>
        </div>
      )}
      {unmappedPlCount > 0 && fundFilter !== "NONE" && (
        <div className="spectre-dw-banner warn" data-testid="coa-banner-unmapped-fund">
          <span>
            <b>{unmappedPlCount}</b> Profit &amp; Loss account{unmappedPlCount === 1 ? "" : "s"} do{unmappedPlCount === 1 ? "es" : ""} not have a Fund Applicability assigned. The Monthly Reporting Package will exclude {unmappedPlCount === 1 ? "it" : "them"} from every Operating and Capital total until fixed.
          </span>
          <Link
            href="/app/admin/coa?mode=fund&fund=NONE"
            className="spectre-dw-btn secondary sm"
            data-testid="coa-banner-unmapped-fund-review"
          >
            Review accounts →
          </Link>
        </div>
      )}
      {!canEdit && (isNewModal || editId != null || deleteId != null) && (
        <div className="spectre-dw-banner warn" data-testid="coa-banner-permission-denied">
          <span>{DISABLED_TOOLTIP}</span>
        </div>
      )}

      {/* ------------------------------ HEADER */}
      <div className="spectre-dw-header">
        <div className="spectre-dw-header-crumb">Finance · General Ledger</div>
        <div className="spectre-dw-header-row">
          <div>
            <h1 className="spectre-dw-title">
              {fundMode ? "Fund Applicability — Assignment" : "Chart of Accounts"}
            </h1>
            <div className="spectre-dw-title-meta">
              {fundMode ? (
                <>
                  <span className="k">Assign every P&amp;L account to Operating, Capital, or both.</span>
                  <span className="sep">·</span>
                  <span>Balance-sheet accounts are hidden here — Fund Applicability is a P&amp;L concept.</span>
                </>
              ) : (
                <>
                  <span className="k">GAAP fund structure</span>
                  <span className="sep">·</span>
                  <span><b>{totalCount.toLocaleString()}</b> account{totalCount === 1 ? "" : "s"}{showInactive ? "" : ", "}<b>{activeCount.toLocaleString()}</b> active</span>
                  {lastUpdated ? (
                    <>
                      <span className="sep">·</span>
                      <span data-testid="coa-last-updated">
                        Last updated <b title={lastUpdated.isoTimestamp}>{formatRelativeTime(lastUpdated.isoTimestamp)}</b> by <b>{lastUpdated.actorName}</b>
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="sep">·</span>
                      <span data-testid="coa-last-updated" className="k">No changes yet</span>
                    </>
                  )}
                  <span className="sep">·</span>
                  <span>Fiscal year <b>{new Date().getFullYear()}</b></span>
                </>
              )}
            </div>
          </div>
          <div className="spectre-dw-header-actions">
            <Link
              href={`/app/admin/coa?${showInactive ? "" : "showInactive=1&"}${fundMode ? "mode=fund" : ""}`.replace(/[?&]$/, "")}
              className="spectre-dw-btn tertiary"
              data-testid="coa-toggle-inactive"
            >
              {showInactive ? "Hide inactive" : "Show inactive"}
            </Link>
            {fundMode ? (
              <Link className="spectre-dw-btn secondary" href="/app/admin/coa" data-testid="coa-fund-mode-exit">
                ← Back to Chart of Accounts
              </Link>
            ) : (
              <Link className="spectre-dw-btn secondary" href="/app/admin/coa?mode=fund" data-testid="coa-fund-mode-enter">
                Fund Applicability
              </Link>
            )}
            {/* Sprint 1 correction (2026-07-19d) — Import now opens a
                CoA-specific modal at `?modal=import` on THIS page. It
                no longer navigates to the generic multi-domain import
                page. Preserving every existing search param means the
                operator returns to their current filters, saved view,
                and selected account when the modal closes.
                Export is unchanged: it links to the CSV endpoint with
                the current filter params forwarded so a filtered view
                exports the same set the operator sees. */}
            {hasPermission(principal, clubId, "settings:write") && (
              <Link
                className="spectre-dw-btn secondary"
                href={(() => {
                  const q = new URLSearchParams();
                  if (showInactive) q.set("showInactive", "1");
                  if (fundMode) q.set("mode", "fund");
                  if (fundFilter) q.set("fund", fundFilter);
                  if (selectId) q.set("select", selectId);
                  q.set("modal", "import");
                  return `/app/admin/coa?${q.toString()}`;
                })()}
                data-testid="coa-import-btn"
                replace
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round"><path d="M4 4h13l3 3v13H4z"/><path d="M8 4v5h9"/></svg>
                Import
              </Link>
            )}
            <a
              className="spectre-dw-btn secondary"
              href={`/api/admin/coa/export.csv${new URLSearchParams(Object.entries({
                ...(showInactive ? { showInactive: "1" } : {}),
                ...(fundMode ? { mode: "fund" } : {}),
                ...(fundFilter ? { fund: fundFilter } : {}),
              }).filter(([, v]) => v != null && v !== "")).toString() ? `?${new URLSearchParams(Object.entries({
                ...(showInactive ? { showInactive: "1" } : {}),
                ...(fundMode ? { mode: "fund" } : {}),
                ...(fundFilter ? { fund: fundFilter } : {}),
              }).filter(([, v]) => v != null && v !== "")).toString()}` : ""}`}
              data-testid="coa-export-btn"
              download
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round"><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/><path d="M12 3v13"/><path d="M7 8l5-5 5 5"/></svg>
              Export
            </a>
            {canEdit ? (
              <Link className="spectre-dw-btn primary" href="/app/admin/coa?modal=new" data-testid="coa-new-account-btn">
                + New account
              </Link>
            ) : (
              <button
                type="button"
                className="spectre-dw-btn primary"
                disabled
                title={DISABLED_TOOLTIP}
                data-testid="coa-new-account-btn"
                data-disabled-reason="no-coa-write"
              >
                + New account
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ------------------------------ BULK FUND FORM (fund-mode only)
           The row checkboxes in the client component post into THIS
           form via the `form="coa-bulk-fund-form"` attribute. Kept
           server-rendered so submission works exactly as it did on
           the legacy page. Hidden visually — the workspace toolbar
           surfaces the "Apply" affordance next to the fund tags. */}
      {canEdit && fundMode && (
        <form
          id="coa-bulk-fund-form"
          action={bulkSetFundApplicabilityAction}
          data-testid="coa-bulk-fund-form"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "10px 32px",
            background: "var(--spectre-canvas-sunken)",
            borderBottom: "1px solid var(--spectre-border-hairline)",
            fontSize: 12,
          }}
        >
          <span style={{ fontSize: 10.5, letterSpacing: "0.10em", textTransform: "uppercase", color: "var(--spectre-text-muted)", fontWeight: 700 }}>
            Bulk fund applicability:
          </span>
          {KNOWN_FUND_KEYS.map((k) => (
            <label key={k} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, fontWeight: 500, color: "var(--spectre-text-primary)" }} data-testid={`coa-bulk-fund-${k}`}>
              <input type="checkbox" name="fundApplicability" value={k} className="spectre-dw-check" />
              <span style={{ textTransform: "capitalize" }}>{k.toLowerCase()}</span>
            </label>
          ))}
          <button type="submit" className="spectre-dw-btn secondary sm" data-testid="coa-bulk-fund-submit">
            Apply to selected
          </button>
          <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--spectre-text-muted)", fontWeight: 500 }}>
            Balance-sheet accounts in the selection are silently skipped.
          </span>
        </form>
      )}

      {/* ------------------------------ CLIENT WORKSPACE */}
      <ChartOfAccountsClient
        rows={clientRows}
        canEdit={canEdit}
        disabledTooltip={DISABLED_TOOLTIP}
        fundMode={fundMode}
        showInactive={showInactive}
        fundFilter={fundFilter}
        savedView={savedView}
        totalAccounts={totalCount}
        activeAccounts={activeCount}
        lastUpdatedLabel={lastUpdated ? formatRelativeTime(lastUpdated.isoTimestamp) : ""}
        lastUpdatedActor={lastUpdated?.actorName ?? null}
        /* Sprint 1 regression fix (2026-07-19b).
           Previously this was `NODE_ENV=development || ?_review=1`.
           The founder saw the Review-states toggle on production
           because a shared dev server runs NODE_ENV=development for
           every user, so every Club Admin saw the design-QA control.
           The rule the founder now wants: the panel appears ONLY
           when the URL EXPLICITLY carries `?_review=1`. NODE_ENV
           alone does not enable it — a Club Admin visiting the CoA
           page on a dev server no longer sees it. The `?_review=1`
           marker is an intentional, discoverable, and easy-to-remove
           opt-in that internal design QA and the automated
           regression suite can trigger, while real users never
           accidentally end up on that URL. */
        reviewMode={searchParams._review === "1"}
        unmappedPlCount={unmappedPlCount}
        currentSelectId={selectId}
        currentEditId={editId}
        categoryOptions={categoryOptions}
        fsGroupOptions={fsGroupOptions}
        departmentOptions={departmentOptions}
        parentOptions={parentOptions}
      />

      {/*
        Phase B — legacy edit-modal presentation is retired.
        `?edit=<id>` now opens the inspector in edit mode via the
        client component. `?modal=new` (create) and `?delete=<id>`
        (safe delete + Archive fallback) are unchanged.
      */}
      {canEdit && isNewModal && (
        <AccountModal
          mode="new"
          accounts={accounts}
          categories={categories}
          fsGroups={fsGroups}
          departments={departments}
        />
      )}
      {canEdit && deleteAccount && deleteSafety && (
        <DeleteModal account={deleteAccount} safety={deleteSafety} />
      )}

      {/* Sprint 1 correction (2026-07-19d) — CoA-specific Import modal.
          Server-side rendered only when `?modal=import` AND the user
          has `settings:write` (the same permission the shared imports
          library gates every mutation on). A read-only user hitting
          the URL directly gets nothing rendered — server authority.
          The `closeHref` is computed from the current search params
          minus `modal` and `error` so refresh / back / close return
          the operator to their exact previous filter + selection
          state. */}
      {isImportModal && hasPermission(principal, clubId, "settings:write") && (
        <ChartOfAccountsImportModal
          closeHref={(() => {
            const q = new URLSearchParams();
            if (showInactive) q.set("showInactive", "1");
            if (fundMode) q.set("mode", "fund");
            if (fundFilter) q.set("fund", fundFilter);
            if (selectId) q.set("select", selectId);
            const s = q.toString();
            return s ? `/app/admin/coa?${s}` : "/app/admin/coa";
          })()}
          initialError={typeof searchParams.error === "string" ? searchParams.error : null}
        />
      )}
    </div>
  );
}

// -----------------------------------------------------------------------
// New Account modal — kept as-is per founder brief ("Do NOT redesign New
// Account during this sprint"). The legacy edit branch has been retired
// as part of Phase B; `?edit=<id>` now opens the workspace inspector.
// -----------------------------------------------------------------------

type ModalProps = {
  mode: "new";
  accounts: Array<{ id: string; accountNumber: string; name: string }>;
  categories: Array<{ id: string; key: string; name: string; type: string }>;
  fsGroups: Array<{ id: string; key: string; name: string; statement: string }>;
  departments: Array<{ id: string; code: string; name: string }>;
};

function AccountModal({ accounts, categories, fsGroups, departments }: ModalProps) {
  const titleText = "New account";
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 px-4"
      data-testid="coa-account-modal"
      role="dialog"
      aria-modal="true"
      aria-label={titleText}
    >
      <div className="card w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between border-b border-stone-200 px-6 py-3">
          <h2 className="font-serif text-xl text-club-ink">{titleText}</h2>
          <Link href="/app/admin/coa" className="text-stone-500 hover:text-club-ink text-xl leading-none" data-testid="coa-modal-close" aria-label="Close">×</Link>
        </div>
        <form action={createAccountAction} className="px-6 py-4 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="label">Account number *</label>
              <input className="input font-mono" name="accountNumber" required maxLength={40} defaultValue="" data-testid="coa-modal-number" />
            </div>
            <div>
              <label className="label">Type *</label>
              <select className="select" name="type" required defaultValue="EXPENSE" data-testid="coa-modal-type">
                <option value="ASSET">Asset</option>
                <option value="LIABILITY">Liability</option>
                <option value="EQUITY">Equity</option>
                <option value="REVENUE">Revenue</option>
                <option value="EXPENSE">Expense</option>
              </select>
            </div>
          </div>
          <div>
            <label className="label">Name *</label>
            <input className="input" name="name" required maxLength={200} defaultValue="" data-testid="coa-modal-name" />
          </div>
          <div>
            <label className="label">Description</label>
            <textarea className="textarea" name="description" rows={2} maxLength={2000} defaultValue="" />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="label">Category</label>
              <select className="select" name="categoryKey" defaultValue="">
                <option value="">— None —</option>
                {categories.map((c) => <option key={c.id} value={c.key}>{c.name} ({c.type})</option>)}
              </select>
            </div>
            <div>
              <label className="label">FS group</label>
              <select className="select" name="fsGroupKey" defaultValue="" data-testid="coa-modal-fsgroup">
                <option value="">— None —</option>
                {fsGroups.map((g) => <option key={g.id} value={g.key}>{g.name} ({g.statement})</option>)}
              </select>
            </div>
          </div>
          <div data-testid="coa-modal-fund-applicability">
            <label className="label">
              Fund Applicability
              <span className="ml-2 text-xs text-stone-500 font-normal">Profit &amp; Loss accounts only</span>
            </label>
            <input type="hidden" name="_fundApplicabilityForm" value="1" />
            <div className="flex flex-wrap gap-4 mt-1">
              {KNOWN_FUND_KEYS.map((k) => (
                <label key={k} className="flex items-center gap-2 text-sm" data-testid={`coa-modal-fund-${k}`}>
                  <input type="checkbox" name="fundApplicability" value={k} />
                  <span className="capitalize">{k.toLowerCase()}</span>
                </label>
              ))}
            </div>
            <p className="mt-1 text-xs text-stone-500">
              Determines whether this account rolls into the Operating Fund, Capital Fund, or both in the Monthly Reporting Package. Balance-sheet accounts do not carry a fund tag.
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="label">Parent account</label>
              <select className="select" name="parentAccountNumber" defaultValue="">
                <option value="">— None —</option>
                {accounts.map((a) => <option key={a.id} value={a.accountNumber}>{a.accountNumber} · {a.name}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Default department</label>
              <select className="select" name="defaultDepartmentCode" defaultValue="">
                <option value="">— None —</option>
                {departments.map((d) => <option key={d.id} value={d.code}>{d.name}</option>)}
              </select>
            </div>
          </div>
          <fieldset className="grid grid-cols-2 md:grid-cols-3 gap-2 pt-2">
            <legend className="label">Flags</legend>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="isControlAccount" /> Control account</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="isBankAccount" /> Bank account</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="isCashAccount" /> Cash account</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="isTaxRelevant" /> Tax-relevant</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="allowManualPosting" defaultChecked /> Allow manual posting</label>
          </fieldset>
          <div className="flex justify-end gap-2 border-t border-stone-200 pt-4">
            <Link href="/app/admin/coa" className="btn btn-secondary">Cancel</Link>
            <button type="submit" className="btn btn-primary" data-testid="coa-modal-submit">
              Create account
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

type DeleteModalProps = {
  account: { id: string; accountNumber: string; name: string };
  safety: Awaited<ReturnType<typeof checkAccountDeletionSafety>>;
};

function DeleteModal({ account, safety }: DeleteModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 px-4" data-testid="coa-delete-modal" role="dialog" aria-modal="true" aria-label={`Delete account ${account.accountNumber}`}>
      <div className="card w-full max-w-lg">
        <div className="flex items-center justify-between border-b border-stone-200 px-6 py-3">
          <h2 className="font-serif text-xl text-club-ink">Delete account {account.accountNumber}?</h2>
          <Link href="/app/admin/coa" className="text-stone-500 hover:text-club-ink text-xl leading-none" aria-label="Close">×</Link>
        </div>
        <div className="px-6 py-4 space-y-3">
          <p className="text-sm text-stone-700"><span className="font-mono">{account.accountNumber}</span> · {account.name}</p>
          {safety.canDelete ? (
            <>
              <p className="text-sm text-stone-700">This account has no posted activity and no other workflow depends on it. Deletion is safe and irreversible.</p>
              <div className="flex justify-end gap-2 pt-2">
                <Link href="/app/admin/coa" className="btn btn-secondary">Cancel</Link>
                <form action={deleteAccountAction} className="inline">
                  <input type="hidden" name="accountId" value={account.id} />
                  <button type="submit" className="btn btn-danger" data-testid="coa-delete-confirm">Delete account</button>
                </form>
              </div>
            </>
          ) : (
            <>
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800" data-testid="coa-delete-blocked">
                <p className="font-medium">Cannot delete — this account is in use:</p>
                <ul className="mt-1 list-disc list-inside space-y-0.5">
                  {safety.blockers.map((b) => (
                    <li key={b.kind} data-testid={`coa-delete-blocker-${b.kind}`}>{b.message}</li>
                  ))}
                </ul>
              </div>
              <p className="text-sm text-stone-700">Archive this account instead. Archived accounts stay visible in historical reports but won&apos;t appear in new-transaction selectors.</p>
              <div className="flex justify-end gap-2 pt-2">
                <Link href="/app/admin/coa" className="btn btn-secondary">Cancel</Link>
                <form action={archiveAccountAction} className="inline">
                  <input type="hidden" name="accountId" value={account.id} />
                  <button type="submit" className="btn btn-primary" data-testid="coa-archive-instead">Archive instead</button>
                </form>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// Sprint 1 acceptance repair — server-computed relative time for the
// "Last updated N ago" header meta. Renders in the RSC so it is
// deterministic per request; the exact ISO timestamp travels in
// the title attribute so a hover reveals the precise moment and a
// screen reader can read it via the title.
function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diffMs = now - then;
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return "moments ago";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} day${day === 1 ? "" : "s"} ago`;
  const wk = Math.floor(day / 7);
  if (wk < 5) return `${wk} wk ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo} mo ago`;
  const yr = Math.floor(day / 365);
  return `${yr} yr${yr === 1 ? "" : "s"} ago`;
}

function labelForOk(ok: string): string {
  switch (ok) {
    case "created": return "Account created:";
    case "updated": return "Account updated:";
    case "archived": return "Account archived:";
    case "reactivated": return "Account reactivated:";
    case "deleted": return "Account deleted:";
    case "bulk-fund": return "Fund applicability updated on";
    default: return ok;
  }
}
