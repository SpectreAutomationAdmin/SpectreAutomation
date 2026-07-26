"use client";

// Step 32 — Floor-plan editor client component.
//
// Lean v1 — no drag-and-drop. Each row in the draft is editable
// inline (X/Y/W/H/shape/capacity/tableNumber). The SVG preview on
// the left mirrors what the server POS map will render after
// publish. Servers never see this editor; they see the LIVE map at
// /app/admin/hospitality/reservations/floor.

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  startDraftAction,
  addTableFromPaletteAction,
  updateTableAction,
  archiveTableAction,
  discardDraftAction,
  publishDraftAction,
  validatePublishAction,
} from "./_actions";
import {
  computeSpacingIssues,
  offenderIdSet,
  MIN_CLEARANCE_PX,
  nextSequentialDisplayName,
  PALETTE_DEFAULTS,
  type PaletteKind,
  type SpacingIssue,
} from "@/lib/hospitality/floor-plan-geometry";

type Shape = "ROUND" | "SQUARE" | "RECTANGLE";

// Step 36 — Optimistic drop state. While the server creates the real
// DiningFloorPlanTable row we render a synthesized "ghost" tile so
// the canvas updates instantly. The ghost is removed when the server
// returns (success → refresh swaps in the real row; failure →
// silently remove + show error). Publish is disabled while any ghost
// is still pending so the admin can't publish a layout that doesn't
// yet exist server-side.
type PendingDrop = {
  tempId: string;
  kind: PaletteKind;
  xPos: number;
  yPos: number;
  width: number;
  height: number;
  capacity: number;
  shape: Shape;
  displayName: string;
};

type EditorTable = {
  id: string;
  tableNumber: string;
  displayName: string | null;
  shape: Shape;
  capacity: number;
  xPos: number;
  yPos: number;
  width: number;
  height: number;
  rotation: number;
  archived: boolean;
  sourceDiningTableId: string | null;
};

type EditorPlan = {
  id: string;
  status: "DRAFT" | "LIVE" | "ARCHIVED";
  name: string;
  versionNumber: number;
  publishedAt: string | null;
  tables: EditorTable[];
};

type Area = {
  id: string;
  name: string;
  canvasWidth: number;
  canvasHeight: number;
};

export function FloorPlanEditor({
  area,
  live,
  draft,
  canEdit,
  canPublish,
}: {
  area: Area;
  live: EditorPlan | null;
  draft: EditorPlan | null;
  canEdit: boolean;
  canPublish: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  // Step 34/36 — selected table drives the canvas drag highlight.
  // (Step 36: the inline TableRow form is gone; double-click is the
  // edit path now.) `liveSpacingIssues` is recomputed client-side
  // on every render from the same helper the server uses, so admins
  // see "L3 overlaps L4" as they drag.
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null);
  // Step 36 — optimistic drops. Cleared whenever a router.refresh()
  // brings back the real row (we keep the ghost until its successor
  // appears, identified by a matching xPos/yPos/displayName).
  const [pendingDrops, setPendingDrops] = useState<PendingDrop[]>([]);
  // Step 37 — optimistic existing-table drag overrides. Keyed by
  // tableId; while the move is in flight we render the tile at the
  // optimistic xPos/yPos so React's pointerup → server-action →
  // router.refresh roundtrip never snaps the tile back to its old
  // persisted coordinates for a frame. On failure we drop the
  // override and the tile reverts visually to prevXPos/prevYPos.
  type PendingMove = {
    tableId: string;
    xPos: number;
    yPos: number;
    prevXPos: number;
    prevYPos: number;
  };
  const [pendingMoves, setPendingMoves] = useState<Record<string, PendingMove>>({});

  // Ghosts rendered as full EditorTable rows so canvas + spacing
  // logic treat them the same as real tables.
  const ghostTables = useMemo<EditorTable[]>(() => {
    return pendingDrops.map((p) => ({
      id: p.tempId,
      tableNumber: "…",
      displayName: p.displayName,
      shape: p.shape,
      capacity: p.capacity,
      xPos: p.xPos,
      yPos: p.yPos,
      width: p.width,
      height: p.height,
      rotation: 0,
      archived: false,
      sourceDiningTableId: null,
    }));
  }, [pendingDrops]);

  // Step 37 — fold pendingMoves into draft.tables BEFORE appending
  // ghost tiles. Spacing validation + canvas both pick up the
  // optimistic position automatically since liveSpacingIssues
  // derives from this same memo.
  const draftWithGhosts = useMemo<EditorPlan | null>(() => {
    if (!draft) return null;
    const overridden = draft.tables.map((t) => {
      const move = pendingMoves[t.id];
      if (!move) return t;
      return { ...t, xPos: move.xPos, yPos: move.yPos };
    });
    if (ghostTables.length === 0) return { ...draft, tables: overridden };
    return { ...draft, tables: [...overridden, ...ghostTables] };
  }, [draft, ghostTables, pendingMoves]);

  const liveSpacingIssues = useMemo<SpacingIssue[]>(() => {
    if (!draftWithGhosts) return [];
    return computeSpacingIssues(draftWithGhosts.tables);
  }, [draftWithGhosts]);
  const offenderIds = useMemo(() => offenderIdSet(liveSpacingIssues), [liveSpacingIssues]);
  // Step 33 — confirm-before-publish dialog state. Holds the pre-flight
  // validate result so the admin sees exactly which rows block publish
  // before clicking Confirm.
  const [publishConfirm, setPublishConfirm] = useState<{
    issues: Array<{ planTableId: string | null; tableNumber: string | null; message: string }>;
  } | null>(null);

  function refresh() { router.refresh(); }

  function startDraft() {
    setError(null); setInfo(null);
    startTransition(async () => {
      const r = await startDraftAction(area.id);
      if (!r.ok) { setError(r.error); return; }
      setInfo("Draft opened. Edit tables, then Publish when ready.");
      refresh();
    });
  }

  // Step 33 — open the publish confirm dialog after a pre-flight
  // validate so the admin sees blockers BEFORE clicking Confirm.
  function openPublishConfirm() {
    if (!draft) return;
    setError(null); setInfo(null);
    startTransition(async () => {
      const r = await validatePublishAction(draft.id);
      if (!r.ok) { setError(r.error); return; }
      setPublishConfirm({ issues: r.data.issues });
    });
  }

  function confirmPublish() {
    if (!draft) return;
    setError(null); setInfo(null);
    startTransition(async () => {
      const r = await publishDraftAction(draft.id);
      if (!r.ok) { setError(r.error); return; }
      setInfo(`Published. ${r.data.summary.created} created, ${r.data.summary.updated} updated, ${r.data.summary.archived} archived. Live POS floor map will use the new layout.`);
      setPublishConfirm(null);
      refresh();
    });
  }

  // Step 34/37/38 — drag-end handler. Called by PreviewCanvas after the
  // user releases pointer on a table.
  //
  // Step 38 flicker fix: previously we cleared `pendingMoves[tableId]`
  // right after `router.refresh()`. But router.refresh is asynchronous —
  // it schedules a refetch of the server data and returns immediately.
  // Clearing the override before the new persisted draft prop arrived
  // meant React rendered one or more frames where the override was gone
  // but the page's `draft.tables[id].xPos` was still the OLD coord.
  // The user saw the tile snap back to its starting position, then
  // teleport to the destination. The fix is to leave the override in
  // place after a successful save and let `reconcilePendingMovesEffect`
  // (below) drop it once the persisted prop catches up. Failures still
  // clear immediately and reset to the pre-drag position.
  function commitDragMove(tableId: string, xPos: number, yPos: number) {
    if (!draft) return;
    const persisted = draft.tables.find((t) => t.id === tableId);
    if (!persisted) return;
    const prevXPos = persisted.xPos;
    const prevYPos = persisted.yPos;
    setError(null);
    setPendingMoves((prev) => ({
      ...prev,
      [tableId]: { tableId, xPos, yPos, prevXPos, prevYPos },
    }));
    startTransition(async () => {
      const r = await updateTableAction(tableId, { xPos, yPos });
      if (!r.ok) {
        // Drop the override — tile reverts visually to prev coords.
        setPendingMoves((prev) => {
          const next = { ...prev };
          delete next[tableId];
          return next;
        });
        setError(`Move could not be saved. Reverted to previous position.${r.error ? ` (${r.error})` : ""}`);
        return;
      }
      // Refresh and let the reconciliation effect clear the override
      // exactly when persisted matches. NO explicit setPendingMoves
      // here — that's the whole point of step 38.
      refresh();
    });
  }

  // Step 38 — reconcile pendingMoves against the persisted draft.
  //
  // After commitDragMove fires `router.refresh()`, the page re-fetches
  // and a NEW `draft` prop eventually arrives where the moved row's
  // xPos/yPos match the override. At that moment the override is
  // redundant and we drop it. Done as a useEffect (not inline in
  // commitDragMove's success branch) because router.refresh is async —
  // clearing pre-refresh produced the snap-back flicker step 37
  // intended to eliminate.
  useEffect(() => {
    if (!draft) return;
    const ids = Object.keys(pendingMoves);
    if (ids.length === 0) return;
    let changed = false;
    const next: Record<string, typeof pendingMoves[string]> = {};
    for (const id of ids) {
      const move = pendingMoves[id]!;
      const persisted = draft.tables.find((t) => t.id === id);
      if (persisted && persisted.xPos === move.xPos && persisted.yPos === move.yPos) {
        changed = true;
        continue;
      }
      next[id] = move;
    }
    if (changed) setPendingMoves(next);
  }, [draft, pendingMoves]);

  // Step 36 — optimistic palette drop. Insert a ghost row IMMEDIATELY
  // so the canvas updates with no perceived latency, then fire the
  // server action in the background. On success the router refresh
  // swaps in the real row; we remove the ghost. On failure we remove
  // the ghost AND surface the server error. Publish is disabled
  // while any ghost is still pending so the admin can't push a
  // layout that doesn't yet exist server-side.
  function commitPaletteDrop(kind: PaletteKind, xPos: number, yPos: number) {
    if (!draft) return;
    const defaults = PALETTE_DEFAULTS[kind];
    if (!defaults) { setError(`Unknown palette kind "${kind}".`); return; }
    setError(null);

    // Local-only id; never leaves the client. The "temp_" prefix is
    // checked by drag-disable / publish-gate / row-lookup code paths.
    const tempId = `temp_${Math.random().toString(36).slice(2, 10)}_${pendingDrops.length}`;
    // Provisional display name — same helper the server uses, fed
    // the real draft tables + already-pending ghosts so the suffix
    // doesn't collide as the admin drops several in a row.
    const seedTables = [...draft.tables, ...ghostTables];
    const displayName = nextSequentialDisplayName(kind, seedTables);

    const ghost: PendingDrop = {
      tempId, kind, xPos, yPos,
      width: defaults.width,
      height: defaults.height,
      capacity: defaults.capacity,
      shape: defaults.shape,
      displayName,
    };
    setPendingDrops((prev) => [...prev, ghost]);

    startTransition(async () => {
      const r = await addTableFromPaletteAction(draft.id, { kind, xPos, yPos });
      if (!r.ok) {
        // Roll back the ghost and surface the error.
        setPendingDrops((prev) => prev.filter((p) => p.tempId !== tempId));
        setError(r.error);
        return;
      }
      // Step 37 — Real row exists now. Refresh first so the new
      // EditorTable arrives in `draft.tables`, THEN drop the ghost so
      // we never double-render. Selection sticks; the modal does NOT
      // auto-open — double-click is the only path to the edit modal
      // so dropping multiple tiles in a row doesn't constantly pop a
      // modal in the admin's face.
      refresh();
      setPendingDrops((prev) => prev.filter((p) => p.tempId !== tempId));
      setSelectedTableId(r.data.id);
    });
  }

  // Step 35 — double-click on a tile (handled inside PreviewCanvas)
  // opens this modal. Carries the table id; modal pulls the live row
  // from the draft.
  const [editModalId, setEditModalId] = useState<string | null>(null);
  const editingTable = useMemo(() => {
    if (!editModalId || !draft) return null;
    return draft.tables.find((t) => t.id === editModalId) ?? null;
  }, [editModalId, draft]);

  // Step 39 — keyboard delete. Pressing Delete or Backspace removes
  // the currently selected table from the draft (with confirm). Gated:
  //  - only when a draft is open + admin has edit permission
  //  - only when a real (non-ghost) table is selected
  //  - never while typing in an input/textarea/select/contentEditable
  //  - never while any modal is open (edit modal or publish confirm)
  // Reuses the same archiveTableAction path as the modal's Remove
  // button, so server-side blockers (open POS check / active reservation
  // / SEATED party) still apply.
  useEffect(() => {
    if (!draft || !canEdit) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      if (!selectedTableId) return;
      if (selectedTableId.startsWith("temp_")) return;
      if (editModalId || publishConfirm) return;
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        if (target.isContentEditable) return;
      }
      const tile = draft!.tables.find((row) => row.id === selectedTableId);
      if (!tile) return;
      e.preventDefault();
      if (!confirm(
        `Remove "${tile.tableNumber}" from this draft? Historical orders and reservations stay queryable. Servers see the live layout until you Publish.`,
      )) return;
      startTransition(async () => {
        const r = await archiveTableAction(selectedTableId);
        if (!r.ok) { setError(r.error); return; }
        setSelectedTableId(null);
        refresh();
      });
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [draft, canEdit, selectedTableId, editModalId, publishConfirm]);

  function discard() {
    if (!draft) return;
    if (!confirm("Discard this draft? Unpublished changes will be lost.")) return;
    setError(null); setInfo(null);
    startTransition(async () => {
      const r = await discardDraftAction(draft.id);
      if (!r.ok) { setError(r.error); return; }
      setInfo("Draft discarded.");
      refresh();
    });
  }

  const planForPreview = draftWithGhosts ?? live;
  const hasPendingDrops = pendingDrops.length > 0;
  // Step 37 — pending existing-table drag saves also block Publish:
  // pushing a layout with un-persisted positions to live would lose
  // the drag the admin just made.
  const hasPendingMoves = Object.keys(pendingMoves).length > 0;
  const hasPendingWrites = hasPendingDrops || hasPendingMoves;
  // Set of ids currently mid-save so PreviewCanvas can render them
  // with a subtle saving cue (opacity).
  const savingIds = useMemo<Set<string>>(
    () => new Set(Object.keys(pendingMoves)),
    [pendingMoves],
  );

  return (
    <div className="grid grid-cols-1 gap-4 p-4 lg:grid-cols-[1fr_360px]">
      {/* Preview canvas */}
      <div data-testid="floor-plan-preview" className="card card-body">
        <div className="flex items-baseline justify-between">
          <h2 className="section-title text-base">Layout preview — {area.name}</h2>
          <span className="text-xs text-stone-500">
            {draft ? `Editing draft v${draft.versionNumber}` : live
              ? `Live v${live.versionNumber}`
              : "No layout yet"}
          </span>
        </div>
        <PreviewCanvas
          area={area}
          plan={planForPreview}
          // Step 34 — drag is enabled only when a draft is active.
          // The live view stays read-only.
          isDraft={planForPreview === draftWithGhosts}
          selectedTableId={selectedTableId}
          onSelectTable={(id) => setSelectedTableId(id)}
          onCommitDragMove={commitDragMove}
          // Step 35/36 — palette drop + double-click edit.
          onPaletteDrop={commitPaletteDrop}
          onOpenEditModal={(id) => setEditModalId(id)}
          offenderIds={offenderIds}
          // Step 37 — ids whose moves are in flight, for the saving cue.
          savingIds={savingIds}
          canEdit={canEdit && planForPreview === draftWithGhosts}
        />
        {/* Step 34 — live validation panel under the canvas. Only
            shown when editing a draft; reflects what the publish
            confirm modal will say later. */}
        {planForPreview === draftWithGhosts && liveSpacingIssues.length > 0 && (
          <div
            data-testid="floor-plan-spacing-issues"
            className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900"
          >
            <div className="font-medium">
              Spacing issues ({liveSpacingIssues.length}) — Publish is blocked
              until resolved.
            </div>
            <ul className="mt-1 list-disc pl-5">
              {liveSpacingIssues.map((s) => (
                <li
                  key={`${s.aId}-${s.bId}`}
                  onClick={() => setSelectedTableId(s.aId)}
                  className="cursor-pointer hover:underline"
                  title="Click to select the offending table"
                >
                  {s.message}
                </li>
              ))}
            </ul>
            <p className="mt-1 text-[10px] opacity-80">
              Minimum spacing: {MIN_CLEARANCE_PX}px.
            </p>
          </div>
        )}
      </div>

      {/* Step 36 — right rail is now a dedicated Table Palette.
          The old per-row Tables list was removed because admins were
          editing tables by double-clicking the tile on the canvas;
          the list duplicated that path and ate the entire side
          panel. Editing flows through the double-click modal; the
          modal also carries the Remove action. */}
      <aside className="card card-body flex flex-col gap-3">
        {error && <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
        {info && <div className="rounded-md border border-club-green-300 bg-club-green-50 px-3 py-2 text-sm text-club-green-800">{info}</div>}

        {/* Status header */}
        <div className="text-xs">
          <div className="font-medium text-stone-900">
            {draft ? "🟡 Unpublished draft" : live ? "🟢 Live layout" : "No plan yet"}
          </div>
          <div className="text-stone-500">
            {draft
              ? `Servers still see ${live ? `v${live.versionNumber}` : "no layout"} until you Publish.`
              : "Servers see this layout on the POS floor map."}
          </div>
        </div>

        {/* Action bar */}
        <div className="flex flex-wrap gap-2">
          {!draft && canEdit && (
            <button disabled={pending} onClick={startDraft} className="btn btn-primary btn-sm">
              {pending ? "Working…" : "Start a draft"}
            </button>
          )}
          {draft && canPublish && (
            <button
              disabled={pending || hasPendingDrops || hasPendingMoves}
              onClick={openPublishConfirm}
              className="btn btn-primary btn-sm"
              title={hasPendingWrites ? "Wait for in-flight changes to save before publishing." : undefined}
              data-testid="publish-button"
            >
              {pending
                ? "Working…"
                : hasPendingDrops
                  ? "Saving drops…"
                  : hasPendingMoves
                    ? "Saving moves…"
                    : "Publish / Make live"}
            </button>
          )}
          {draft && canEdit && (
            <button disabled={pending} onClick={discard} className="btn btn-secondary btn-sm">
              Discard draft
            </button>
          )}
        </div>

        {/* Step 36 — the right rail's primary content. The palette
            grows to fill the panel; uniform tile size, four kinds. */}
        {draft && canEdit ? (
          <AddTablePalette pending={pending} />
        ) : (
          <div className="rounded-md border border-stone-200 bg-stone-50 px-3 py-4 text-xs text-stone-500">
            {!draft && live ? (
              <>Start a draft to add or rearrange tables. Servers see <strong>v{live.versionNumber}</strong> until you publish.</>
            ) : (
              <>This layout is read-only. Ask an admin with floor-plan edit access to make changes.</>
            )}
          </div>
        )}

        {/* Editor tip — fills the leftover space without re-introducing
            a noisy table list. Mirrors the same vocabulary used in the
            palette + double-click modal. */}
        {draft && canEdit && (
          <div className="mt-auto rounded-md border border-stone-200 bg-white px-3 py-2 text-[11px] leading-relaxed text-stone-600">
            <div className="font-medium text-stone-800">Editing tips</div>
            <ul className="mt-1 list-disc pl-4">
              <li>Drag a shape from the palette onto the canvas to add a table.</li>
              <li>Drag a tile to reposition. Snaps to a 10px grid.</li>
              <li>Double-click a tile to rename, resize, or remove.</li>
            </ul>
          </div>
        )}
      </aside>

      {/* Step 33 — publish confirm modal. Surfaces validation issues
          before publish so the admin sees what's blocking, and makes
          the (high-impact) "push to live POS" gesture intentional. */}
      {publishConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setPublishConfirm(null)}
        >
          <div
            data-testid="publish-confirm"
            className="w-full max-w-lg rounded-lg bg-white p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="font-serif text-xl">Publish floor plan?</h2>
            <p className="mt-2 text-sm text-stone-600">
              Publishing pushes this layout to the <strong>live POS floor map</strong>{" "}
              that servers are using right now. Tables added in this draft will appear;
              tables you removed will disappear. This can&rsquo;t be undone — you would
              need to start a new draft to revert.
            </p>
            {publishConfirm.issues.length > 0 ? (
              <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                <div className="font-medium">Issues block this publish — fix and retry:</div>
                <ul className="mt-1 list-disc pl-5">
                  {publishConfirm.issues.map((i, idx) => (
                    <li key={idx}>
                      {i.tableNumber ? <strong>{i.tableNumber}</strong> : "Layout"}: {i.message}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <div className="mt-3 rounded-md border border-club-green-200 bg-club-green-50 px-3 py-2 text-xs text-club-green-800">
                No issues found. Ready to publish.
              </div>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setPublishConfirm(null)}
                disabled={pending}
                className="btn btn-secondary btn-sm"
              >
                Cancel
              </button>
              <button
                onClick={confirmPublish}
                disabled={pending || publishConfirm.issues.length > 0}
                className="btn btn-primary btn-sm"
              >
                {pending ? "Publishing…" : "Confirm & publish"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Step 35/36 — double-click edit modal. Opens on double-click
          of a tile in the canvas OR after a palette drop. As of
          step 36 this modal also carries the Remove (archive) action
          — the right-rail Tables list is gone, so this is the sole
          editing path for an existing tile. Server-side archive
          blockers (open checks / active reservations / SEATED) still
          apply via archiveTableAction. */}
      {editingTable && (
        <EditTableModal
          table={editingTable}
          area={area}
          pending={pending}
          onSave={(patch) => {
            startTransition(async () => {
              const r = await updateTableAction(editingTable.id, patch);
              if (!r.ok) { setError(r.error); return; }
              setEditModalId(null);
              refresh();
            });
          }}
          onRemove={() => {
            if (!confirm(`Remove "${editingTable.tableNumber}" from the layout? Historical orders and reservations stay queryable. The change applies to this draft; servers see the live layout until you Publish.`)) return;
            startTransition(async () => {
              const r = await archiveTableAction(editingTable.id);
              if (!r.ok) { setError(r.error); return; }
              setEditModalId(null);
              refresh();
            });
          }}
          onCancel={() => setEditModalId(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Preview canvas — read-only SVG mirror of the live POS floor map.
// ---------------------------------------------------------------------------

function PreviewCanvas({
  area, plan, isDraft, selectedTableId, onSelectTable, onCommitDragMove,
  onPaletteDrop, onOpenEditModal, offenderIds, savingIds, canEdit,
}: {
  area: Area;
  plan: EditorPlan | null;
  isDraft: boolean;
  selectedTableId: string | null;
  onSelectTable: (id: string | null) => void;
  onCommitDragMove: (id: string, xPos: number, yPos: number) => void;
  // Step 35/36 — palette drop + double-click edit.
  onPaletteDrop?: (kind: PaletteKind, xPos: number, yPos: number) => void;
  onOpenEditModal?: (id: string) => void;
  offenderIds: Set<string>;
  // Step 37 — ids whose drag-move is mid-save. We render them with a
  // subtle opacity so the admin sees the save is in progress.
  savingIds?: Set<string>;
  canEdit: boolean;
}) {
  const W = area.canvasWidth, H = area.canvasHeight;
  const svgRef = useRef<SVGSVGElement | null>(null);
  // Step 39 — drag state moves to a REF (no React re-render on each
  // pointermove). Every pointermove mutates the `<g>` element's
  // `transform` attribute directly, so the tile follows the cursor
  // at native browser frame rate. The only React-state update is
  // `setDraggingId` on pointerdown (to switch cursor styles) and
  // `setDraggingId(null)` on pointerup. The committed coord is
  // handed to the parent via onCommitDragMove → pendingMoves
  // overlay → one final render at the new position.
  // Step 42 — Floating HTML ghost drag. The SVG <g> stays put while
  // the user drags; a position:fixed div at viewport level follows
  // the cursor. This is how Figma/Miro/Notion-style editors achieve
  // a true "attached to the mouse" feeling — the ghost is not subject
  // to SVG viewBox scaling, parent layout, React reconciliation, or
  // any of the constraints that bit earlier attempts.
  type FloatingDrag = {
    tableId: string;
    startViewBoxX: number;
    startViewBoxY: number;
    viewBoxWidth: number;
    viewBoxHeight: number;
    ghostPxWidth: number;
    ghostPxHeight: number;
    shape: Shape;
    label: string;
    capacity: number;
  };
  const [floatingDrag, setFloatingDrag] = useState<FloatingDrag | null>(null);
  // Ghost position (client coords). Updated via direct DOM mutation
  // every pointermove — no React re-render during drag. The state
  // above sets the *initial* style attributes (so the first render
  // already places the ghost under the cursor); subsequent moves
  // bypass React.
  const ghostElRef = useRef<HTMLDivElement | null>(null);
  const ghostPosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  // Used to flip cursor style + dim the original SVG tile.
  const [draggingId, setDraggingId] = useState<string | null>(null);
  // Step 41 — debug overlay. Stores the most recent cursor position
  // (client + viewBox coords) so we can render a HUD comparing it
  // against the dragged tile's center. Gated by `?debug=1` URL flag
  // (or `?debug=floor-plan`) so it stays out of the way for normal
  // admin use. setDebugDragInfo IS a React state setter — we accept
  // its re-render cost only when debug mode is on; with the URL flag
  // off the setter still fires but the overlay component is unmounted.
  const [debugDragInfo, setDebugDragInfo] = useState<{
    clientX: number; clientY: number;
    viewBoxX: number; viewBoxY: number;
    tileClientX: number; tileClientY: number;
    distance: number;
  } | null>(null);
  // Read directly from window.location.search per-call (no state /
  // useEffect). Avoids any SSR hydration / mount-timing surprise that
  // could cause the flag to be missed when a fast script like
  // Playwright invokes pointerdown immediately after navigation.
  function isDebugMode(): boolean {
    if (typeof window === "undefined") return false;
    const params = new URLSearchParams(window.location.search);
    const flag = params.get("debug");
    return flag === "1" || flag === "floor-plan";
  }

  // Pixel → viewBox conversion. The SVG uses preserveAspectRatio
  // "xMidYMid meet", so it scales the smaller axis to fit and
  // letterboxes the other. We treat the pixel grid as uniformly
  // scaled (the viewBox aspect ratio matches the container's
  // aspectRatio CSS, so there's no letterbox in practice).
  function clientToViewBox(clientX: number, clientY: number): { x: number; y: number } {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * W;
    const y = ((clientY - rect.top) / rect.height) * H;
    return { x, y };
  }

  function clampToCanvas(t: { xPos: number; yPos: number; width: number; height: number }) {
    const minX = t.width / 2;
    const maxX = W - t.width / 2;
    const minY = t.height / 2;
    const maxY = H - t.height / 2;
    return {
      x: Math.max(minX, Math.min(maxX, t.xPos)),
      y: Math.max(minY, Math.min(maxY, t.yPos)),
    };
  }

  // Step 42 — Floating HTML ghost drag.
  //
  // The original SVG <g> stays put (dimmed) during drag. A position:fixed
  // <div> at viewport level follows the cursor. We update its
  // `left/top` style directly via a ref on every pointermove, bypassing
  // React entirely on the hot path. The ghost is not constrained by
  // SVG viewBox, canvas bounds, or layout scaling — only by what the
  // browser draws at the viewport.
  //
  //   onPointerDown(e, t):
  //     1. Set pointer capture on the <g> so subsequent pointermove /
  //        pointerup fire here regardless of cursor position.
  //     2. Set floatingDrag state with the tile snapshot (size, shape,
  //        label) and the SVG-rect-derived ghost pixel dimensions.
  //     3. Initialize ghostPosRef to the current cursor.
  //     4. React renders the ghost div with style.left/top from
  //        ghostPosRef — first paint already has the ghost under cursor.
  //
  //   onPointerMove(e):
  //     - ghostPosRef.current = { x: e.clientX, y: e.clientY }
  //     - if ghostElRef.current, set its style.left/top synchronously.
  //     - The CSS `transform: translate(-50%, -50%)` centers the div
  //       on (left, top), so visual center == cursor.
  //
  //   onPointerUp(e):
  //     - Convert e.clientX/Y to viewBox coords (only here).
  //     - Clamp to canvas + snap to grid + commit via onCommitDragMove.
  //     - Clear floatingDrag → ghost unmounts → SVG tile undims.
  function onPointerDown(e: React.PointerEvent<SVGGElement>, t: EditorTable) {
    if (!isDraft || !canEdit || t.archived || t.id.startsWith("temp_")) {
      onSelectTable(t.id);
      return;
    }
    e.stopPropagation();
    const target = e.currentTarget as SVGGElement;
    target.setPointerCapture(e.pointerId);
    onSelectTable(t.id);
    const svgRect = svgRef.current?.getBoundingClientRect();
    if (!svgRect) return;
    const scaleX = svgRect.width / W;
    const scaleY = svgRect.height / H;
    ghostPosRef.current = { x: e.clientX, y: e.clientY };
    setFloatingDrag({
      tableId: t.id,
      startViewBoxX: t.xPos,
      startViewBoxY: t.yPos,
      viewBoxWidth: t.width,
      viewBoxHeight: t.height,
      ghostPxWidth: t.width * scaleX,
      ghostPxHeight: t.height * scaleY,
      shape: t.shape,
      label: t.displayName ?? `Table ${t.tableNumber}`,
      capacity: t.capacity,
    });
    setDraggingId(t.id);
    if (isDebugMode()) {
      updateDebugFromGhost(e.clientX, e.clientY);
    }
  }

  // Step 42 — debug HUD now measures the GHOST element's center vs
  // the cursor. The SVG tile no longer moves during drag; only the
  // ghost does, so it's the only meaningful comparison.
  function updateDebugFromGhost(clientX: number, clientY: number) {
    const el = ghostElRef.current;
    if (!el) {
      setDebugDragInfo(null);
      return;
    }
    const box = el.getBoundingClientRect();
    const tileClientX = box.left + box.width / 2;
    const tileClientY = box.top + box.height / 2;
    const distance = Math.hypot(clientX - tileClientX, clientY - tileClientY);
    setDebugDragInfo({
      clientX, clientY,
      viewBoxX: 0, viewBoxY: 0, // unused in step 42; ghost lives in client coords
      tileClientX, tileClientY,
      distance,
    });
  }

  function onPointerMove(e: React.PointerEvent<SVGGElement>) {
    if (!floatingDrag) return;
    ghostPosRef.current = { x: e.clientX, y: e.clientY };
    const el = ghostElRef.current;
    if (el) {
      el.style.left = `${e.clientX}px`;
      el.style.top = `${e.clientY}px`;
    }
    if (isDebugMode()) {
      updateDebugFromGhost(e.clientX, e.clientY);
    }
  }

  function onPointerUp(e: React.PointerEvent<SVGGElement>) {
    if (!floatingDrag) return;
    const final = ghostPosRef.current;
    const cursor = clientToViewBox(final.x, final.y);
    const movedFar =
      Math.abs(cursor.x - floatingDrag.startViewBoxX) > 0.5
      || Math.abs(cursor.y - floatingDrag.startViewBoxY) > 0.5;
    if (movedFar) {
      const clamped = clampToCanvas({
        xPos: cursor.x, yPos: cursor.y,
        width: floatingDrag.viewBoxWidth, height: floatingDrag.viewBoxHeight,
      });
      const snappedX = Math.round(clamped.x / 10) * 10;
      const snappedY = Math.round(clamped.y / 10) * 10;
      onCommitDragMove(floatingDrag.tableId, snappedX, snappedY);
    }
    setFloatingDrag(null);
    setDraggingId(null);
    setDebugDragInfo(null);
    // pointer capture is released automatically on pointerup, but be
    // defensive in case the browser kept it.
    try {
      (e.currentTarget as SVGGElement).releasePointerCapture(e.pointerId);
    } catch { /* ignore */ }
  }

  return (
    <div
      className="mt-2 relative w-full select-none"
      style={{ aspectRatio: `${W} / ${H}`, maxHeight: 480 }}
    >
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        // Step 40 — overflow:visible lets the dragged <g> escape the
        // canvas viewBox while the cursor moves outside; clamp +
        // snap pull it back to a legal coord on release. Without
        // this, the SVG (default overflow:hidden) clips the tile
        // mid-drag and the user perceives "lag" toward the edges.
        style={{ overflow: "visible" }}
        className="absolute inset-0 w-full h-full bg-stone-50 rounded touch-none"
        // Step 35 — HTML5 drag-over / drop from the right-rail palette.
        // The palette items set `dataTransfer.setData('application/x-spectre-table-shape', shape)`;
        // we read it on drop, convert client coords to viewBox coords,
        // snap to a 10-px grid, and fire onPaletteDrop.
        onDragOver={(e) => {
          if (!isDraft || !canEdit) return;
          // Default cursor only when the source is our palette type.
          if (Array.from(e.dataTransfer.types).includes("application/x-spectre-table-shape")) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
          }
        }}
        onDrop={(e) => {
          if (!isDraft || !canEdit || !onPaletteDrop) return;
          const kind = e.dataTransfer.getData("application/x-spectre-table-shape");
          // Step 36 — BAR_STOOL joins the accepted set. Schema-wise
          // it persists as a small ROUND; the palette kind survives
          // only as the auto-generated display name "Bar Stool N".
          if (kind !== "ROUND" && kind !== "SQUARE" && kind !== "RECTANGLE" && kind !== "BAR_STOOL") return;
          e.preventDefault();
          const vb = clientToViewBox(e.clientX, e.clientY);
          const snappedX = Math.round(vb.x / 10) * 10;
          const snappedY = Math.round(vb.y / 10) * 10;
          onPaletteDrop(kind as PaletteKind, snappedX, snappedY);
        }}
      >
        <rect x="0" y="0" width={W} height={H} fill="#faf7f1" />
        {plan?.tables
          .filter((t) => !t.archived)
          .map((t) => {
            // Step 39 — render reads only persisted/optimistic coords.
            // The transient drag position lives in `dragRef` and is
            // applied via direct `setAttribute("transform", ...)` on
            // the `<g>` element during pointermove, so React never
            // re-renders per pointermove.
            const isDragging = draggingId === t.id;
            const cx = t.xPos;
            const cy = t.yPos;
            const w = t.width, h = t.height;
            const isOffender = offenderIds.has(t.id);
            const isSelected = selectedTableId === t.id;
            // Step 36 — ghost tiles (in-flight palette drops) render
            // slightly translucent so the admin sees the save status.
            const isGhost = t.id.startsWith("temp_");
            // Step 37 — existing tiles currently mid-save (drag move
            // queued to the server) get a subtle opacity cue too.
            const isSaving = savingIds?.has(t.id) ?? false;
            const baseFill = t.shape === "ROUND" ? "#dbe7f5" : t.shape === "SQUARE" ? "#fce7d2" : "#e5f0db";
            const baseStroke = t.shape === "ROUND" ? "#1e4f8f" : t.shape === "SQUARE" ? "#a85a1f" : "#3f6b1c";
            // Step 34 — offender tables paint red regardless of shape.
            // Selected tables get a darker stroke.
            const fill = isOffender ? "#fde2e2" : baseFill;
            const stroke = isOffender ? "#b91c1c" : isSelected ? "#111" : baseStroke;
            const strokeWidth = isOffender || isSelected ? 3 : 2;
            return (
              <g
                key={t.id}
                data-testid={isGhost ? `floor-plan-tile-ghost-${t.id}` : `floor-plan-tile-${t.tableNumber}`}
                data-saving={isSaving ? "true" : undefined}
                // Step 38 — surface the rendered coordinate on the
                // tile so Playwright tests can read it without re-doing
                // SVG viewBox math. These reflect the OPTIMISTIC
                // position (pendingMoves overlay), i.e. exactly what
                // the admin sees on screen.
                data-x={cx}
                data-y={cy}
                // Step 42 — dim the original SVG tile while the
                // floating ghost is in flight. The ghost is the
                // primary visual; dimming the source avoids the
                // "two tables visible" double-image effect.
                opacity={isDragging ? 0.3 : isGhost ? 0.55 : isSaving ? 0.8 : 1}
                onPointerDown={(e) => onPointerDown(e, t)}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                onDoubleClick={(e) => {
                  // Step 35/36 — double-click opens the edit modal.
                  // In-flight ghost tiles (temp_*) have no DB row yet,
                  // so don't open until the server returns.
                  if (!isDraft || !canEdit || t.archived || t.id.startsWith("temp_")) return;
                  e.stopPropagation();
                  onOpenEditModal?.(t.id);
                }}
                style={{ cursor: isDraft && canEdit ? (isDragging ? "grabbing" : "grab") : "pointer", touchAction: "none" }}
                transform={t.rotation ? `rotate(${t.rotation} ${cx} ${cy})` : undefined}
              >
                {t.shape === "ROUND" ? (
                  <ellipse cx={cx} cy={cy} rx={w / 2} ry={h / 2}
                    fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
                ) : (
                  <rect x={cx - w / 2} y={cy - h / 2} width={w} height={h}
                    rx={t.shape === "RECTANGLE" ? 10 : 6}
                    fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
                )}
                <text x={cx} y={cy - 2} textAnchor="middle" fontSize={14} fontWeight={600}
                  fill={isOffender ? "#7f1d1d" : stroke}>
                  {t.displayName ?? `Table ${t.tableNumber}`}
                </text>
                <text x={cx} y={cy + 14} textAnchor="middle" fontSize={11}
                  fill={isOffender ? "#7f1d1d" : stroke} opacity={0.75}>
                  seats {t.capacity}
                </text>
              </g>
            );
          })}
      </svg>
      {/* Step 42 — Floating HTML drag ghost.
          position:fixed at viewport level. Center is at (left, top)
          via `transform: translate(-50%, -50%)` so updating the
          inline left/top inside onPointerMove keeps the ghost
          centered on the cursor. The ghost is not inside the SVG so
          no viewBox scaling / clip / overflow rules apply to it. */}
      {floatingDrag && (
        <div
          ref={ghostElRef}
          data-testid="floor-plan-floating-drag-ghost"
          style={{
            position: "fixed",
            left: ghostPosRef.current.x,
            top: ghostPosRef.current.y,
            transform: "translate(-50%, -50%)",
            width: floatingDrag.ghostPxWidth,
            height: floatingDrag.ghostPxHeight,
            pointerEvents: "none",
            zIndex: 9999,
            backgroundColor:
              floatingDrag.shape === "ROUND" ? "#dbe7f5"
              : floatingDrag.shape === "SQUARE" ? "#fce7d2"
              : "#e5f0db",
            border: `2.5px solid ${
              floatingDrag.shape === "ROUND" ? "#1e4f8f"
              : floatingDrag.shape === "SQUARE" ? "#a85a1f"
              : "#3f6b1c"
            }`,
            borderRadius: floatingDrag.shape === "ROUND" ? "50%"
              : floatingDrag.shape === "RECTANGLE" ? 10
              : 6,
            opacity: 0.92,
            boxShadow: "0 10px 24px rgba(0,0,0,0.25)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            fontWeight: 600,
            fontSize: Math.max(10, Math.min(14, floatingDrag.ghostPxHeight * 0.18)),
            color:
              floatingDrag.shape === "ROUND" ? "#1e4f8f"
              : floatingDrag.shape === "SQUARE" ? "#a85a1f"
              : "#3f6b1c",
            userSelect: "none",
          }}
        >
          <span data-testid="floor-plan-floating-drag-ghost-label">{floatingDrag.label}</span>
          <span style={{ fontSize: "0.8em", opacity: 0.75, fontWeight: 500 }}>
            seats {floatingDrag.capacity}
          </span>
        </div>
      )}

      {/* Step 41 — Drag debug overlay. Renders only when ?debug=1
          (or ?debug=floor-plan) is in the URL AND a drag is in
          flight. Shows cursor coords, measured tile-shape center,
          and pixel distance. Color codes:
            green  ≤ 2px  (passes the absolute-cursor-lock contract)
            yellow ≤ 5px
            red    > 5px
      */}
      {debugDragInfo && (
        <div
          data-testid="floor-plan-debug-hud"
          data-distance={debugDragInfo.distance.toFixed(2)}
          className="pointer-events-none absolute top-2 left-2 rounded-md bg-stone-900/85 px-3 py-2 font-mono text-[11px] leading-tight text-white shadow-md"
        >
          <div>
            cursor&nbsp;&nbsp;
            <span data-testid="debug-cursor-xy">{debugDragInfo.clientX.toFixed(1)}, {debugDragInfo.clientY.toFixed(1)}</span>
          </div>
          <div>
            tile&nbsp;&nbsp;&nbsp;&nbsp;
            <span data-testid="debug-tile-xy">{debugDragInfo.tileClientX.toFixed(1)}, {debugDragInfo.tileClientY.toFixed(1)}</span>
          </div>
          <div>
            distance{" "}
            <span
              data-testid="debug-distance"
              style={{
                color: debugDragInfo.distance <= 2
                  ? "#86efac" /* green-300 */
                  : debugDragInfo.distance <= 5
                    ? "#fde047" /* yellow-300 */
                    : "#fca5a5" /* red-300 */,
              }}
            >
              {debugDragInfo.distance.toFixed(2)} px
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-row editor + add-table form
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Step 35 — Add Tables palette.
//
// Three draggable shape cards on the right rail. Each card sets the
// HTML5 dataTransfer payload to its shape; the PreviewCanvas reads
// it on drop and calls addTableFromPaletteAction. No mouse-coord
// math here — the canvas owns the conversion.
//
// `pending` disables the cursor while a server action is in flight
// (drag is still possible but the visual cue tells the admin to
// wait for the previous drop to land).
// ---------------------------------------------------------------------------
// Step 36 — four palette kinds: Round / Square / Rectangle / Bar
// Stool. Bar Stool persists as a small round (the schema only carries
// ROUND/SQUARE/RECTANGLE) but auto-names "Bar Stool N" so service
// staff understand it on the floor map.
function AddTablePalette({ pending }: { pending: boolean }) {
  const kinds: Array<{
    kind: PaletteKind;
    label: string;
    description: string;
  }> = [
    // Step 40 — every drop is auto-named "Table N" regardless of
    // shape. Tooltip copy reflects this so admins know what to expect.
    { kind: "ROUND",     label: "Round",     description: "Round table · seats 4 · auto-named Table N" },
    { kind: "SQUARE",    label: "Square",    description: "Square table · seats 4 · auto-named Table N" },
    { kind: "RECTANGLE", label: "Rectangle", description: "Rectangle table · seats 6 · auto-named Table N" },
    { kind: "BAR_STOOL", label: "Bar Stool", description: "Bar stool · seats 1 · auto-named Table N" },
  ];
  return (
    <div data-testid="add-tables-palette" className="rounded-md border border-stone-200 bg-stone-50 px-3 py-3">
      <div className="text-sm font-medium text-stone-900">Table palette</div>
      <p className="mt-0.5 text-[11px] text-stone-500">
        Drag a shape onto the canvas. The new table appears instantly and saves in the background.
      </p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        {kinds.map((k) => (
          <div
            key={k.kind}
            data-testid={`palette-kind-${k.kind.toLowerCase()}`}
            draggable={!pending}
            onDragStart={(e) => {
              e.dataTransfer.setData("application/x-spectre-table-shape", k.kind);
              e.dataTransfer.effectAllowed = "copy";
            }}
            className={`flex aspect-square cursor-grab flex-col items-center justify-center rounded-md border border-stone-300 bg-white text-stone-700 transition-colors hover:border-stone-500 hover:bg-stone-50 ${pending ? "opacity-50" : ""}`}
            title={k.description}
          >
            <PaletteShapeGlyph kind={k.kind} />
            <span className="mt-1 text-[11px] font-medium">{k.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function PaletteShapeGlyph({ kind }: { kind: PaletteKind }) {
  if (kind === "ROUND") {
    return (
      <svg viewBox="0 0 40 40" className="h-9 w-9" aria-hidden="true">
        <ellipse cx={20} cy={20} rx={14} ry={14} fill="#dbe7f5" stroke="#1e4f8f" strokeWidth={2} />
      </svg>
    );
  }
  if (kind === "SQUARE") {
    return (
      <svg viewBox="0 0 40 40" className="h-9 w-9" aria-hidden="true">
        <rect x={6} y={6} width={28} height={28} rx={4} fill="#fce7d2" stroke="#a85a1f" strokeWidth={2} />
      </svg>
    );
  }
  if (kind === "RECTANGLE") {
    return (
      <svg viewBox="0 0 40 40" className="h-9 w-9" aria-hidden="true">
        <rect x={2} y={10} width={36} height={20} rx={4} fill="#e5f0db" stroke="#3f6b1c" strokeWidth={2} />
      </svg>
    );
  }
  // Bar Stool — small round disc, smaller than the regular Round
  // glyph so the visual hierarchy on the palette matches the
  // operational one (a stool is a single seat).
  return (
    <svg viewBox="0 0 40 40" className="h-9 w-9" aria-hidden="true">
      <ellipse cx={20} cy={20} rx={8} ry={8} fill="#efe4d2" stroke="#7c5a2a" strokeWidth={2} />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Step 35 — Edit table modal.
//
// Opens on double-click (canvas) OR after a palette drop. Edits
// table number / display name / shape / capacity / width / height /
// rotation in one place. Capacity changes suggest a sensible size
// but never force.
// ---------------------------------------------------------------------------
function EditTableModal({
  table, area, pending, onSave, onRemove, onCancel,
}: {
  table: EditorTable;
  area: Area;
  pending: boolean;
  onSave: (patch: Partial<{
    tableNumber: string;
    displayName: string | null;
    shape: Shape;
    capacity: number;
    width: number;
    height: number;
    rotation: number;
  }>) => void;
  // Step 36 — Remove is the modal's responsibility now that the
  // right-rail Tables list is gone. The button confirms and then
  // delegates to archiveTableAction in the parent.
  onRemove: () => void;
  onCancel: () => void;
}) {
  const [tableNumber, setTableNumber] = useState(table.tableNumber);
  const [displayName, setDisplayName] = useState(table.displayName ?? "");
  const [shape, setShape] = useState<Shape>(table.shape);
  const [capacity, setCapacity] = useState<number>(table.capacity);
  const [width, setWidth] = useState<number>(table.width);
  const [height, setHeight] = useState<number>(table.height);
  const [error, setError] = useState<string | null>(null);

  function submit() {
    setError(null);
    if (!tableNumber.trim()) {
      setError("Table number is required.");
      return;
    }
    if (capacity < 1 || capacity > 24) {
      setError("Capacity must be between 1 and 24.");
      return;
    }
    if (width < 30 || height < 30) {
      setError("Width and height must each be at least 30 px.");
      return;
    }
    onSave({
      tableNumber: tableNumber.trim(),
      displayName: displayName.trim() ? displayName.trim() : null,
      shape, capacity, width, height,
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onCancel}
    >
      <div
        data-testid="edit-table-modal"
        className="w-full max-w-md rounded-lg bg-white p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="font-serif text-xl">Edit table — {table.tableNumber}</h2>
        <p className="mt-1 text-xs text-stone-500">
          Changes apply to the draft. Publish to push them to the live POS map.
        </p>
        {error && (
          <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </div>
        )}
        <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
          <label className="col-span-1">
            <span className="block text-[10px] uppercase tracking-wide text-stone-500">Table number</span>
            <input
              className="input text-xs w-full"
              value={tableNumber}
              onChange={(e) => setTableNumber(e.target.value)}
              placeholder={`${area.name.slice(0, 1).toUpperCase()}1`}
            />
          </label>
          <label className="col-span-1">
            <span className="block text-[10px] uppercase tracking-wide text-stone-500">Display name</span>
            <input
              className="input text-xs w-full"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Round 1"
            />
          </label>
          <label>
            <span className="block text-[10px] uppercase tracking-wide text-stone-500">Shape</span>
            <select
              className="input text-xs w-full"
              value={shape}
              onChange={(e) => setShape(e.target.value as Shape)}
            >
              <option value="ROUND">Round</option>
              <option value="SQUARE">Square</option>
              <option value="RECTANGLE">Rectangle</option>
            </select>
          </label>
          <label>
            <span className="block text-[10px] uppercase tracking-wide text-stone-500">Capacity</span>
            <input
              type="number"
              min={1}
              max={24}
              className="input text-xs w-full"
              value={capacity}
              onChange={(e) => setCapacity(Math.max(1, Math.min(24, Number(e.target.value) || 1)))}
            />
          </label>
          <label>
            <span className="block text-[10px] uppercase tracking-wide text-stone-500">Width</span>
            <input
              type="number"
              min={30}
              max={400}
              className="input text-xs w-full"
              value={width}
              onChange={(e) => setWidth(Number(e.target.value) || 80)}
            />
          </label>
          <label>
            <span className="block text-[10px] uppercase tracking-wide text-stone-500">Height</span>
            <input
              type="number"
              min={30}
              max={400}
              className="input text-xs w-full"
              value={height}
              onChange={(e) => setHeight(Number(e.target.value) || 80)}
            />
          </label>
        </div>
        <div className="mt-5 flex items-center justify-between gap-2">
          <button
            onClick={onRemove}
            disabled={pending}
            data-testid="edit-table-modal-remove"
            className="text-xs font-medium text-red-700 hover:underline disabled:opacity-50"
          >
            Remove table
          </button>
          <div className="flex gap-2">
            <button onClick={onCancel} disabled={pending} className="btn btn-secondary btn-sm">
              Cancel
            </button>
            <button onClick={submit} disabled={pending} className="btn btn-primary btn-sm">
              {pending ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

