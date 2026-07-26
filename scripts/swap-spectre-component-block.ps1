# Replace the old Spectre component-block in globals.css with the
# new Phase 1 component classes. Preserves everything before line 268
# (the legacy .card/.btn/.page-title/.table-base block) and everything
# from line 626 onward (the Print Mode block for the Monthly
# Reporting Package + chart animations).
$file = "src/app/globals.css"
$content = Get-Content $file
$before = $content[0..266]   # up to and including the blank line before line 268
$after  = $content[625..($content.Count - 1)]  # from line 626 onward
$new = @'
/* ============================================================
 * Spectre Design Language — Phase 1 component classes
 *
 * The full authoring guidance for these classes lives in
 * `docs/design/Spectre Design Language.md`. Every class references
 * the semantic `--spectre-*` tokens above; nothing hardcodes a hex.
 *
 * Legacy classes (`.card`, `.btn`, `.page-title`, `.table-base`,
 * etc.) are UNTOUCHED and continue to serve every un-migrated
 * surface. The Monthly Reporting Package, POS lounge, Member
 * Portal, and every other admin route render pixel-identical
 * before and after this file changes.
 * ============================================================ */

@layer components {
  /* --- Shell + workspace ---------------------------------------- */
  .spectre-shell {
    background-color: var(--spectre-canvas);
    color: var(--spectre-text-primary);
    min-height: 100vh;
    font-family: var(--font-inter), Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    font-feature-settings: "cv11" 1, "ss01" 1;
  }
  .spectre-sidebar {
    background-color: var(--spectre-sidebar);
    border-right: 1px solid var(--spectre-border-hairline);
    color: var(--spectre-text-primary);
    display: flex;
    flex-direction: column;
    width: var(--spectre-sidebar-w-expanded);
    transition: width var(--spectre-motion-slow) var(--spectre-ease);
    flex-shrink: 0;
  }
  .spectre-sidebar[data-collapsed="true"] {
    width: var(--spectre-sidebar-w-collapsed);
  }
  .spectre-topbar {
    background-color: var(--spectre-topbar);
    border-bottom: 1px solid var(--spectre-border-hairline);
    color: var(--spectre-text-primary);
    height: var(--spectre-topbar-h);
    display: flex;
    align-items: center;
    padding: 0 var(--spectre-space-4);
    gap: var(--spectre-space-3);
  }
  .spectre-workspace {
    background-color: var(--spectre-canvas);
    color: var(--spectre-text-primary);
    padding: var(--spectre-workspace-pad-y) var(--spectre-workspace-pad-x);
    min-height: calc(100vh - var(--spectre-topbar-h));
  }
  @media (max-width: 1023px) {
    .spectre-workspace { padding: 20px; }
  }
  @media (max-width: 767px) {
    .spectre-workspace { padding: 16px; }
  }

  /* --- Nav items ------------------------------------------------- */
  .spectre-nav-item {
    display: flex;
    align-items: center;
    gap: var(--spectre-space-3);
    padding: 8px 12px;
    margin: 1px 8px;
    color: var(--spectre-text-secondary);
    border-radius: var(--spectre-radius-button);
    font-size: var(--spectre-type-nav-size);
    line-height: var(--spectre-type-nav-line);
    font-weight: 500;
    text-decoration: none;
    transition:
      background-color var(--spectre-motion-fast) var(--spectre-ease),
      color var(--spectre-motion-fast) var(--spectre-ease);
    position: relative;
    white-space: nowrap;
  }
  .spectre-nav-item:hover {
    background-color: var(--spectre-surface-hover);
    color: var(--spectre-text-primary);
  }
  .spectre-nav-item.spectre-nav-item--active {
    background-color: var(--spectre-accent-soft);
    color: var(--spectre-text-primary);
  }
  .spectre-nav-item.spectre-nav-item--active::before {
    content: "";
    position: absolute;
    left: -8px;
    top: 8px;
    bottom: 8px;
    width: 2px;
    border-radius: 0 2px 2px 0;
    background: var(--spectre-accent);
  }
  .spectre-nav-item .spectre-nav-icon {
    flex-shrink: 0;
    width: 16px;
    height: 16px;
    color: currentColor;
    opacity: 0.72;
  }
  .spectre-nav-item.spectre-nav-item--active .spectre-nav-icon {
    opacity: 1;
    color: var(--spectre-accent);
  }
  .spectre-nav-section-header {
    padding: 12px 20px 4px;
    font-size: var(--spectre-type-label-size);
    line-height: var(--spectre-type-label-line);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 600;
    color: var(--spectre-text-muted);
  }

  /* --- Buttons --------------------------------------------------- */
  .spectre-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--spectre-space-2);
    padding: 8px 14px;
    font-size: var(--spectre-type-button-size);
    line-height: var(--spectre-type-button-line);
    font-weight: 500;
    border-radius: var(--spectre-radius-button);
    border: 1px solid transparent;
    background: transparent;
    color: var(--spectre-text-primary);
    cursor: pointer;
    text-decoration: none;
    transition:
      background-color var(--spectre-motion-fast) var(--spectre-ease),
      border-color var(--spectre-motion-fast) var(--spectre-ease),
      color var(--spectre-motion-fast) var(--spectre-ease);
    font-family: inherit;
  }
  .spectre-btn:disabled,
  .spectre-btn[aria-disabled="true"] {
    opacity: 0.5;
    cursor: not-allowed;
    pointer-events: none;
  }
  .spectre-btn:focus-visible {
    outline: none;
    box-shadow: var(--spectre-shadow-focus);
  }
  .spectre-btn--primary {
    background: var(--spectre-accent);
    color: var(--spectre-text-inverse);
  }
  .spectre-btn--primary:hover { background: var(--spectre-accent-hover); }
  .spectre-btn--secondary {
    background: var(--spectre-surface);
    color: var(--spectre-text-primary);
    border-color: var(--spectre-border-default);
  }
  .spectre-btn--secondary:hover {
    background: var(--spectre-surface-hover);
    border-color: var(--spectre-border-strong);
  }
  .spectre-btn--ghost { background: transparent; color: var(--spectre-text-secondary); }
  .spectre-btn--ghost:hover { background: var(--spectre-surface-hover); color: var(--spectre-text-primary); }
  .spectre-btn--danger { background: var(--spectre-status-error); color: var(--spectre-text-inverse); }
  .spectre-btn--danger:hover { filter: brightness(0.94); }
  .spectre-btn--sm { padding: 5px 10px; font-size: 12px; line-height: 14px; }
  .spectre-btn--lg { padding: 10px 18px; font-size: 14px; line-height: 18px; }
  .spectre-btn--icon { padding: 7px; }
  .spectre-btn--loading { position: relative; color: transparent !important; }
  .spectre-btn--loading::after {
    content: "";
    position: absolute;
    width: 14px; height: 14px;
    border: 2px solid currentColor;
    border-top-color: transparent;
    border-radius: 999px;
    color: var(--spectre-text-primary);
    animation: spectre-spin 900ms linear infinite;
  }
  .spectre-btn--primary.spectre-btn--loading::after { color: var(--spectre-text-inverse); }

  /* --- Inputs ---------------------------------------------------- */
  .spectre-input,
  .spectre-textarea,
  .spectre-select {
    display: block;
    width: 100%;
    padding: 8px 12px;
    font-size: var(--spectre-type-body-size);
    line-height: var(--spectre-type-body-line);
    color: var(--spectre-text-primary);
    background: var(--spectre-surface);
    border: 1px solid var(--spectre-border-default);
    border-radius: var(--spectre-radius-input);
    font-family: inherit;
    transition:
      border-color var(--spectre-motion-fast) var(--spectre-ease),
      background-color var(--spectre-motion-fast) var(--spectre-ease);
  }
  .spectre-input::placeholder,
  .spectre-textarea::placeholder { color: var(--spectre-text-subtle); }
  .spectre-input:hover,
  .spectre-textarea:hover,
  .spectre-select:hover { border-color: var(--spectre-border-strong); }
  .spectre-input:focus,
  .spectre-textarea:focus,
  .spectre-select:focus {
    outline: none;
    border-color: var(--spectre-accent);
    box-shadow: var(--spectre-shadow-focus);
  }
  .spectre-input:disabled,
  .spectre-textarea:disabled,
  .spectre-select:disabled {
    background: var(--spectre-canvas-sunken);
    color: var(--spectre-text-subtle);
    cursor: not-allowed;
  }
  .spectre-textarea { min-height: 88px; resize: vertical; }
  .spectre-search {
    padding-left: 34px;
    background-image: none;
  }
  .spectre-label {
    display: block;
    font-size: var(--spectre-type-label-size);
    line-height: var(--spectre-type-label-line);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    font-weight: 600;
    color: var(--spectre-text-muted);
    margin-bottom: var(--spectre-space-2);
  }
  .spectre-help {
    font-size: var(--spectre-type-caption-size);
    line-height: var(--spectre-type-caption-line);
    color: var(--spectre-text-muted);
    margin-top: 6px;
  }
  .spectre-help--error { color: var(--spectre-status-error); }

  /* --- Checkbox / Radio / Toggle -------------------------------- */
  .spectre-check,
  .spectre-radio {
    appearance: none;
    display: inline-block;
    width: 16px; height: 16px;
    border: 1px solid var(--spectre-border-strong);
    background: var(--spectre-surface);
    cursor: pointer;
    transition: background-color var(--spectre-motion-fast) var(--spectre-ease), border-color var(--spectre-motion-fast) var(--spectre-ease);
    position: relative;
    vertical-align: middle;
  }
  .spectre-check { border-radius: 4px; }
  .spectre-radio { border-radius: 999px; }
  .spectre-check:hover, .spectre-radio:hover { border-color: var(--spectre-accent); }
  .spectre-check:focus-visible, .spectre-radio:focus-visible { outline: none; box-shadow: var(--spectre-shadow-focus); }
  .spectre-check:checked, .spectre-radio:checked {
    background: var(--spectre-accent);
    border-color: var(--spectre-accent);
  }
  .spectre-check:checked::after {
    content: "";
    position: absolute;
    left: 4px; top: 1px;
    width: 5px; height: 9px;
    border: solid var(--spectre-text-inverse);
    border-width: 0 1.75px 1.75px 0;
    transform: rotate(45deg);
  }
  .spectre-radio:checked::after {
    content: "";
    position: absolute;
    left: 4px; top: 4px;
    width: 6px; height: 6px;
    background: var(--spectre-text-inverse);
    border-radius: 999px;
  }

  .spectre-toggle {
    appearance: none;
    position: relative;
    width: 34px; height: 20px;
    border-radius: 999px;
    background: var(--spectre-border-default);
    cursor: pointer;
    transition: background-color var(--spectre-motion-fast) var(--spectre-ease);
    vertical-align: middle;
    border: none;
  }
  .spectre-toggle::after {
    content: "";
    position: absolute;
    top: 2px; left: 2px;
    width: 16px; height: 16px;
    border-radius: 999px;
    background: var(--spectre-surface);
    box-shadow: 0 1px 2px rgba(15, 17, 21, 0.15);
    transition: transform var(--spectre-motion-fast) var(--spectre-ease);
  }
  .spectre-toggle:checked { background: var(--spectre-accent); }
  .spectre-toggle:checked::after { transform: translateX(14px); }
  .spectre-toggle:focus-visible { outline: none; box-shadow: var(--spectre-shadow-focus); }

  /* --- Badges --------------------------------------------------- */
  .spectre-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 8px;
    font-size: var(--spectre-type-caption-size);
    line-height: var(--spectre-type-caption-line);
    font-weight: 500;
    border-radius: var(--spectre-radius-pill);
    background: var(--spectre-canvas-sunken);
    color: var(--spectre-text-secondary);
    border: 1px solid var(--spectre-border-hairline);
  }
  .spectre-badge--success { background: var(--spectre-status-success-bg); color: var(--spectre-status-success); border-color: transparent; }
  .spectre-badge--warning { background: var(--spectre-status-warning-bg); color: var(--spectre-status-warning); border-color: transparent; }
  .spectre-badge--error   { background: var(--spectre-status-error-bg);   color: var(--spectre-status-error);   border-color: transparent; }
  .spectre-badge--info    { background: var(--spectre-status-info-bg);    color: var(--spectre-status-info);    border-color: transparent; }
  .spectre-badge--accent  { background: var(--spectre-accent-soft);       color: var(--spectre-accent);         border-color: transparent; }

  /* --- Cards + Panels ------------------------------------------- */
  .spectre-card {
    background: var(--spectre-surface);
    border: 1px solid var(--spectre-border-hairline);
    border-radius: var(--spectre-radius-card);
    box-shadow: var(--spectre-shadow-subtle);
    transition: box-shadow var(--spectre-motion-base) var(--spectre-ease), border-color var(--spectre-motion-fast) var(--spectre-ease);
  }
  .spectre-card--interactive:hover {
    box-shadow: var(--spectre-shadow-elevated);
    border-color: var(--spectre-border-default);
  }
  .spectre-card-header {
    padding: var(--spectre-space-4) var(--spectre-space-6);
    border-bottom: 1px solid var(--spectre-border-hairline);
    display: flex; align-items: center; justify-content: space-between;
  }
  .spectre-card-body { padding: var(--spectre-space-6); }
  .spectre-card-footer {
    padding: var(--spectre-space-3) var(--spectre-space-6);
    border-top: 1px solid var(--spectre-border-hairline);
    display: flex; align-items: center; justify-content: flex-end; gap: var(--spectre-space-2);
  }
  .spectre-panel {
    background: var(--spectre-surface);
    border: 1px solid var(--spectre-border-hairline);
    border-radius: var(--spectre-radius-panel);
    padding: var(--spectre-space-6);
  }

  /* --- Dialog + Drawer + Popover + Tooltip ---------------------- */
  .spectre-dialog-backdrop {
    position: fixed; inset: 0;
    background: rgba(0, 0, 0, 0.42);
    display: flex; align-items: center; justify-content: center;
    padding: var(--spectre-space-4);
    z-index: 60;
    animation: spectre-fade-in var(--spectre-motion-base) var(--spectre-ease) both;
  }
  .spectre-dialog {
    background: var(--spectre-surface-elevated);
    color: var(--spectre-text-primary);
    border-radius: var(--spectre-radius-dialog);
    box-shadow: var(--spectre-shadow-dialog);
    border: 1px solid var(--spectre-border-hairline);
    width: 100%;
    max-width: 480px;
    animation: spectre-dialog-in var(--spectre-motion-slow) var(--spectre-ease) both;
  }
  .spectre-dialog-header {
    padding: var(--spectre-space-4) var(--spectre-space-6);
    border-bottom: 1px solid var(--spectre-border-hairline);
    font-size: var(--spectre-type-h3-size);
    line-height: var(--spectre-type-h3-line);
    font-weight: 600;
  }
  .spectre-dialog-body { padding: var(--spectre-space-6); }
  .spectre-dialog-footer {
    padding: var(--spectre-space-3) var(--spectre-space-6);
    border-top: 1px solid var(--spectre-border-hairline);
    display: flex; justify-content: flex-end; gap: var(--spectre-space-2);
  }

  .spectre-popover {
    background: var(--spectre-surface-elevated);
    border: 1px solid var(--spectre-border-hairline);
    border-radius: var(--spectre-radius-panel);
    box-shadow: var(--spectre-shadow-floating);
    padding: var(--spectre-space-3);
    animation: spectre-pop-in var(--spectre-motion-base) var(--spectre-ease) both;
  }
  .spectre-tooltip {
    background: var(--spectre-text-primary);
    color: var(--spectre-text-inverse);
    padding: 5px 8px;
    font-size: var(--spectre-type-caption-size);
    line-height: 1;
    border-radius: 5px;
    white-space: nowrap;
    box-shadow: var(--spectre-shadow-floating);
    animation: spectre-fade-in var(--spectre-motion-fast) var(--spectre-ease) both;
  }

  /* --- Tabs ----------------------------------------------------- */
  .spectre-tabs {
    display: flex;
    gap: 0;
    border-bottom: 1px solid var(--spectre-border-hairline);
  }
  .spectre-tab {
    padding: 8px 14px;
    font-size: var(--spectre-type-body-sm-size);
    line-height: var(--spectre-type-body-sm-line);
    color: var(--spectre-text-secondary);
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    cursor: pointer;
    font-family: inherit;
    font-weight: 500;
    transition: color var(--spectre-motion-fast) var(--spectre-ease), border-color var(--spectre-motion-fast) var(--spectre-ease);
    margin-bottom: -1px;
  }
  .spectre-tab:hover { color: var(--spectre-text-primary); }
  .spectre-tab[aria-selected="true"] {
    color: var(--spectre-text-primary);
    border-bottom-color: var(--spectre-accent);
  }
  .spectre-tab:focus-visible { outline: none; box-shadow: var(--spectre-shadow-focus); border-radius: 4px 4px 0 0; }

  /* --- Breadcrumbs --------------------------------------------- */
  .spectre-crumbs {
    display: flex; align-items: center; gap: 6px;
    font-size: var(--spectre-type-body-sm-size);
    color: var(--spectre-text-muted);
  }
  .spectre-crumbs a { color: var(--spectre-text-muted); text-decoration: none; transition: color var(--spectre-motion-fast) var(--spectre-ease); }
  .spectre-crumbs a:hover { color: var(--spectre-text-primary); }
  .spectre-crumbs .sep { color: var(--spectre-text-subtle); }
  .spectre-crumbs [aria-current="page"] { color: var(--spectre-text-primary); font-weight: 500; }

  /* --- Pagination ---------------------------------------------- */
  .spectre-pager { display: inline-flex; gap: 2px; align-items: center; }
  .spectre-pager button, .spectre-pager a {
    min-width: 32px; height: 32px;
    display: inline-flex; align-items: center; justify-content: center;
    padding: 0 8px;
    font-size: var(--spectre-type-body-sm-size);
    color: var(--spectre-text-secondary);
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--spectre-radius-button);
    cursor: pointer;
    transition: background-color var(--spectre-motion-fast) var(--spectre-ease), color var(--spectre-motion-fast) var(--spectre-ease);
    font-family: inherit;
    text-decoration: none;
  }
  .spectre-pager button:hover, .spectre-pager a:hover { background: var(--spectre-surface-hover); color: var(--spectre-text-primary); }
  .spectre-pager [aria-current="page"] { background: var(--spectre-accent-soft); color: var(--spectre-accent); font-weight: 500; }
  .spectre-pager :focus-visible { outline: none; box-shadow: var(--spectre-shadow-focus); }

  /* --- Toast + Alert ------------------------------------------- */
  .spectre-toast {
    display: flex; gap: var(--spectre-space-3);
    padding: var(--spectre-space-3) var(--spectre-space-4);
    background: var(--spectre-surface-elevated);
    color: var(--spectre-text-primary);
    border: 1px solid var(--spectre-border-default);
    border-radius: var(--spectre-radius-panel);
    box-shadow: var(--spectre-shadow-floating);
    min-width: 280px;
    max-width: 400px;
    animation: spectre-toast-in var(--spectre-motion-slow) var(--spectre-ease) both;
  }
  .spectre-toast--success { border-left: 3px solid var(--spectre-status-success); }
  .spectre-toast--warning { border-left: 3px solid var(--spectre-status-warning); }
  .spectre-toast--error   { border-left: 3px solid var(--spectre-status-error); }
  .spectre-toast--info    { border-left: 3px solid var(--spectre-status-info); }

  .spectre-alert {
    display: flex; gap: var(--spectre-space-3);
    padding: var(--spectre-space-3) var(--spectre-space-4);
    border-radius: var(--spectre-radius-panel);
    background: var(--spectre-surface);
    border: 1px solid var(--spectre-border-hairline);
    color: var(--spectre-text-primary);
    font-size: var(--spectre-type-body-size);
    line-height: var(--spectre-type-body-line);
  }
  .spectre-alert--success { background: var(--spectre-status-success-bg); border-color: transparent; color: var(--spectre-status-success); }
  .spectre-alert--warning { background: var(--spectre-status-warning-bg); border-color: transparent; color: var(--spectre-status-warning); }
  .spectre-alert--error   { background: var(--spectre-status-error-bg);   border-color: transparent; color: var(--spectre-status-error); }
  .spectre-alert--info    { background: var(--spectre-status-info-bg);    border-color: transparent; color: var(--spectre-status-info); }

  /* --- Progress + Spinner + Skeleton --------------------------- */
  .spectre-progress {
    height: 6px; width: 100%;
    background: var(--spectre-canvas-sunken);
    border-radius: 999px;
    overflow: hidden;
  }
  .spectre-progress-bar {
    height: 100%;
    background: var(--spectre-accent);
    border-radius: 999px;
    transition: width var(--spectre-motion-slow) var(--spectre-ease);
  }
  .spectre-spinner {
    display: inline-block;
    width: 16px; height: 16px;
    border: 2px solid var(--spectre-border-default);
    border-top-color: var(--spectre-accent);
    border-radius: 999px;
    animation: spectre-spin 900ms linear infinite;
    vertical-align: middle;
  }
  .spectre-skeleton {
    background: linear-gradient(90deg,
      var(--spectre-canvas-sunken) 0%,
      var(--spectre-surface-hover) 50%,
      var(--spectre-canvas-sunken) 100%);
    background-size: 200% 100%;
    animation: spectre-shimmer 1600ms linear infinite;
    border-radius: var(--spectre-radius-input);
  }

  /* --- Table ---------------------------------------------------- */
  .spectre-table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--spectre-type-table-size);
    line-height: var(--spectre-type-table-line);
    color: var(--spectre-text-primary);
    font-variant-numeric: tabular-nums;
  }
  .spectre-table thead th {
    padding: 10px 16px;
    text-align: left;
    font-size: var(--spectre-type-label-size);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    font-weight: 600;
    color: var(--spectre-text-muted);
    background: var(--spectre-canvas-sunken);
    border-bottom: 1px solid var(--spectre-border-default);
    white-space: nowrap;
  }
  .spectre-table thead th button {
    display: inline-flex; align-items: center; gap: 4px;
    background: transparent; border: none; padding: 0;
    color: inherit; font: inherit; letter-spacing: inherit; text-transform: inherit;
    cursor: pointer;
  }
  .spectre-table tbody td {
    padding: 12px 16px;
    border-bottom: 1px solid var(--spectre-border-hairline);
    vertical-align: middle;
  }
  .spectre-table tbody tr:hover { background: var(--spectre-surface-hover); }
  .spectre-table tbody tr[data-selected="true"] { background: var(--spectre-accent-soft); }
  .spectre-table--dense thead th { padding: 8px 12px; }
  .spectre-table--dense tbody td { padding: 8px 12px; }
  .spectre-table-empty {
    padding: var(--spectre-space-12) var(--spectre-space-6);
    text-align: center;
    color: var(--spectre-text-muted);
  }

  /* --- Chart placeholder --------------------------------------- */
  .spectre-chart-placeholder {
    background: repeating-linear-gradient(
      45deg,
      var(--spectre-canvas-sunken) 0px,
      var(--spectre-canvas-sunken) 6px,
      transparent 6px,
      transparent 12px
    );
    border: 1px dashed var(--spectre-border-default);
    border-radius: var(--spectre-radius-panel);
    color: var(--spectre-text-muted);
    display: flex; align-items: center; justify-content: center;
    font-size: var(--spectre-type-caption-size);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-weight: 600;
  }

  /* --- Divider --------------------------------------------------- */
  .spectre-divider {
    height: 1px;
    background: var(--spectre-border-hairline);
    border: none;
    margin: var(--spectre-space-4) 0;
  }

  /* --- Kbd hint pill for keyboard shortcuts --------------------- */
  .spectre-kbd {
    display: inline-flex; align-items: center; gap: 2px;
    padding: 2px 6px;
    font-size: 11px;
    font-family: "JetBrains Mono", "SF Mono", ui-monospace, monospace;
    color: var(--spectre-text-muted);
    background: var(--spectre-surface);
    border: 1px solid var(--spectre-border-default);
    border-radius: 4px;
    line-height: 1.2;
  }
}

@keyframes spectre-spin {
  to { transform: rotate(360deg); }
}
@keyframes spectre-shimmer {
  0%   { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
@keyframes spectre-fade-in {
  from { opacity: 0; }
  to   { opacity: 1; }
}
@keyframes spectre-dialog-in {
  from { opacity: 0; transform: translateY(-4px); }
  to   { opacity: 1; transform: translateY(0); }
}
@keyframes spectre-pop-in {
  from { opacity: 0; transform: translateY(-4px); }
  to   { opacity: 1; transform: translateY(0); }
}
@keyframes spectre-toast-in {
  from { opacity: 0; transform: translateX(6px); }
  to   { opacity: 1; transform: translateX(0); }
}

/* Scoped reduced-motion — ONLY zeroes transitions on `spectre-*`
 * classes. Legacy chart animations, reporting transitions, and any
 * non-`spectre-*` motion elsewhere are unaffected. */
@media (prefers-reduced-motion: reduce) {
  [class*="spectre-"] {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
    transition-delay: 0ms !important;
  }
}
'@ -split "`n"
Set-Content -Path $file -Value ($before + $new + $after) -Encoding utf8
Write-Output ("Wrote " + $file + " (" + ($before.Count + $new.Count + $after.Count) + " lines)")
