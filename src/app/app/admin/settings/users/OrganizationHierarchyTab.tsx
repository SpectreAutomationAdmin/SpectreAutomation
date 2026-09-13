"use client";

// Organizational Foundation closeout (2026-09-13) — canonical Position
// tree view + minimal edit affordances (Add, Edit name/department/
// reports-to, Deactivate/Reactivate). Server-side validation lives in
// canonical services; this component is presentational + reads/writes
// via server actions.

import { useMemo, useState, useTransition } from "react";
import type { PositionNode } from "@/lib/organizational/position-tree";
import {
  createPositionAction,
  updatePositionAction,
  deactivatePositionAction,
  reactivatePositionAction,
  type OrgActionResult,
} from "./_org-actions";

export interface FlatPositionRef {
  id: string;
  name: string;
  code: string | null;
  departmentId: string | null;
  isActive: boolean;
}

export interface DepartmentRef {
  id: string;
  name: string;
}

interface Props {
  clubId: string;
  roots: PositionNode[];
  orphans: PositionNode[];
  allPositions: FlatPositionRef[];
  departments: DepartmentRef[];
}

export default function OrganizationHierarchyTab({
  clubId, roots, orphans, allPositions, departments,
}: Props) {
  // Defensive defaults — a stray undefined prop from a stale RSC
  // hydration should not crash the whole page (bug fix 2026-09-13).
  const safeRoots = Array.isArray(roots) ? roots : [];
  const safeOrphans = Array.isArray(orphans) ? orphans : [];
  const safeAllPositions = Array.isArray(allPositions) ? allPositions : [];
  const safeDepartments = Array.isArray(departments) ? departments : [];
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    const map: Record<string, boolean> = {};
    const walk = (n: PositionNode) => {
      map[n.id] = true;
      (n.children ?? []).forEach(walk);
    };
    safeRoots.forEach(walk);
    safeOrphans.forEach(walk);
    return map;
  });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [addingParentId, setAddingParentId] = useState<string | null | "root">(null);
  const [banner, setBanner] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  const departmentById = useMemo(
    () => Object.fromEntries(safeDepartments.map((d) => [d.id, d.name] as const)),
    [safeDepartments],
  );

  function toggle(id: string) {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  function handleResult(r: OrgActionResult) {
    if (r.ok) {
      setBanner({ tone: "ok", text: "Saved." });
      setEditingId(null);
      setAddingParentId(null);
      // Wait for revalidatePath to reload the page tree.
      setTimeout(() => window.location.reload(), 200);
    } else {
      setBanner({ tone: "error", text: r.message ?? "Failed." });
    }
  }

  const totalPositions = safeAllPositions.length;
  const activeCount = safeAllPositions.filter((p) => p.isActive).length;

  return (
    <section
      data-testid="organization-tab-canonical"
      className="mt-4"
    >
      <header className="mb-3 flex items-baseline justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold uppercase tracking-[0.06em] text-stone-500">
            Position hierarchy
          </h3>
          <p className="mt-0.5 text-[13px] text-stone-600">
            {activeCount} active {activeCount === 1 ? "position" : "positions"} · {totalPositions - activeCount} archived
          </p>
        </div>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => { setAddingParentId("root"); setEditingId(null); }}
          data-testid="org-add-root-position"
          disabled={isPending}
        >
          + Add position
        </button>
      </header>

      {banner ? (
        <div
          className={`mb-3 rounded-md border px-3 py-2 text-sm ${
            banner.tone === "ok"
              ? "border-green-700 bg-green-50 text-green-900"
              : "border-red-700 bg-red-50 text-red-900"
          }`}
          data-testid="org-action-banner"
        >
          {banner.text}
        </div>
      ) : null}

      {addingParentId === "root" ? (
        <PositionEditor
          mode="create"
          clubId={clubId}
          parentPositionId={null}
          allPositions={allPositions}
          departments={departments}
          onCancel={() => setAddingParentId(null)}
          onSubmit={(input) => {
            startTransition(async () => {
              const r = await createPositionAction(input);
              handleResult(r);
            });
          }}
        />
      ) : null}

      <ol className="mt-2 space-y-1" data-testid="org-tree-roots">
        {safeRoots.map((n) => (
          <PositionRow
            key={n.id}
            node={n}
            depth={0}
            expanded={expanded}
            toggle={toggle}
            editingId={editingId}
            setEditingId={setEditingId}
            addingParentId={addingParentId}
            setAddingParentId={setAddingParentId}
            allPositions={safeAllPositions}
            departments={safeDepartments}
            departmentById={departmentById}
            clubId={clubId}
            onSubmitUpdate={(id, input) => {
              startTransition(async () => {
                const r = await updatePositionAction(id, input);
                handleResult(r);
              });
            }}
            onSubmitCreateChild={(input) => {
              startTransition(async () => {
                const r = await createPositionAction(input);
                handleResult(r);
              });
            }}
            onDeactivate={(id) => {
              startTransition(async () => {
                const r = await deactivatePositionAction(id);
                handleResult(r);
              });
            }}
            onReactivate={(id) => {
              startTransition(async () => {
                const r = await reactivatePositionAction(id);
                handleResult(r);
              });
            }}
            isPending={isPending}
          />
        ))}
      </ol>

      {safeOrphans.length > 0 ? (
        <div className="mt-6">
          <h4 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-stone-500">
            Positions with an archived parent
          </h4>
          <ol className="mt-2 space-y-1">
            {safeOrphans.map((n) => (
              <PositionRow
                key={n.id}
                node={n}
                depth={0}
                expanded={expanded}
                toggle={toggle}
                editingId={editingId}
                setEditingId={setEditingId}
                addingParentId={addingParentId}
                setAddingParentId={setAddingParentId}
                allPositions={allPositions}
                departments={departments}
                departmentById={departmentById}
                clubId={clubId}
                onSubmitUpdate={(id, input) => {
                  startTransition(async () => {
                    const r = await updatePositionAction(id, input);
                    handleResult(r);
                  });
                }}
                onSubmitCreateChild={(input) => {
                  startTransition(async () => {
                    const r = await createPositionAction(input);
                    handleResult(r);
                  });
                }}
                onDeactivate={(id) => {
                  startTransition(async () => {
                    const r = await deactivatePositionAction(id);
                    handleResult(r);
                  });
                }}
                onReactivate={(id) => {
                  startTransition(async () => {
                    const r = await reactivatePositionAction(id);
                    handleResult(r);
                  });
                }}
                isPending={isPending}
              />
            ))}
          </ol>
        </div>
      ) : null}
    </section>
  );
}

interface RowProps {
  node: PositionNode;
  depth: number;
  expanded: Record<string, boolean>;
  toggle: (id: string) => void;
  editingId: string | null;
  setEditingId: (id: string | null) => void;
  addingParentId: string | null | "root";
  setAddingParentId: (id: string | null | "root") => void;
  allPositions: FlatPositionRef[];
  departments: DepartmentRef[];
  departmentById: Record<string, string>;
  clubId: string;
  onSubmitUpdate: (positionId: string, input: {
    clubId: string;
    name?: string;
    departmentId?: string | null;
    reportsToPositionId?: string | null;
    code?: string | null;
  }) => void;
  onSubmitCreateChild: (input: {
    clubId: string;
    name: string;
    departmentId?: string | null;
    reportsToPositionId?: string | null;
    code?: string | null;
  }) => void;
  onDeactivate: (positionId: string) => void;
  onReactivate: (positionId: string) => void;
  isPending: boolean;
}

function PositionRow(props: RowProps) {
  const {
    node, depth, expanded, toggle, editingId, setEditingId,
    addingParentId, setAddingParentId, allPositions, departments,
    departmentById, clubId, onSubmitUpdate, onSubmitCreateChild,
    onDeactivate, onReactivate, isPending,
  } = props;
  const isEditing = editingId === node.id;
  const isExpanded = expanded[node.id];
  const hasChildren = node.children.length > 0;

  return (
    <li data-testid={`org-node-${node.code ?? node.id}`} className={node.isActive ? "" : "opacity-60"}>
      <div
        className="rounded-md border border-stone-200 bg-white px-3 py-2"
        style={{ marginLeft: depth * 20 }}
      >
        <div className="flex items-center gap-2">
          {hasChildren ? (
            <button
              type="button"
              onClick={() => toggle(node.id)}
              className="inline-flex h-5 w-5 items-center justify-center rounded-sm text-stone-500 hover:bg-stone-100"
              aria-label={isExpanded ? "Collapse" : "Expand"}
              data-testid={`org-toggle-${node.code ?? node.id}`}
            >
              {isExpanded ? "▾" : "▸"}
            </button>
          ) : (
            <span className="inline-block w-5" />
          )}
          <div className="flex-1">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
              <span className="text-[14px] font-medium text-stone-900">{node.name}</span>
              {node.departmentName ? (
                <span className="text-[12px] text-stone-500">· {node.departmentName}</span>
              ) : null}
              {!node.isActive ? (
                <span className="rounded-full border border-stone-300 bg-stone-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-stone-500">Archived</span>
              ) : null}
            </div>
            <div className="mt-0.5 text-[12px] text-stone-600" data-testid={`org-occupants-${node.code ?? node.id}`}>
              {node.occupants.length === 0 ? (
                <span className="italic text-stone-400">Vacant</span>
              ) : (
                node.occupants.map((o, idx) => (
                  <span key={`${o.kind}:${o.id}`}>
                    {idx > 0 ? ", " : ""}
                    <span className="text-stone-800">{o.displayName}</span>
                  </span>
                ))
              )}
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => { setEditingId(isEditing ? null : node.id); setAddingParentId(null); }}
              data-testid={`org-edit-${node.code ?? node.id}`}
              disabled={isPending}
            >
              {isEditing ? "Cancel" : "Edit"}
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => { setAddingParentId(node.id); setEditingId(null); }}
              data-testid={`org-add-child-${node.code ?? node.id}`}
              disabled={isPending}
            >
              + Sub-position
            </button>
            {node.isActive ? (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => {
                  if (window.confirm(`Deactivate "${node.name}"? Occupants must be reassigned first.`)) {
                    onDeactivate(node.id);
                  }
                }}
                data-testid={`org-deactivate-${node.code ?? node.id}`}
                disabled={isPending}
              >
                Deactivate
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => onReactivate(node.id)}
                data-testid={`org-reactivate-${node.code ?? node.id}`}
                disabled={isPending}
              >
                Reactivate
              </button>
            )}
          </div>
        </div>

        {isEditing ? (
          <div className="mt-3 border-t border-stone-100 pt-3">
            <PositionEditor
              mode="edit"
              node={node}
              clubId={clubId}
              parentPositionId={node.reportsToPositionId}
              allPositions={allPositions}
              departments={departments}
              onCancel={() => setEditingId(null)}
              onSubmit={(input) => onSubmitUpdate(node.id, input)}
            />
          </div>
        ) : null}

        {addingParentId === node.id ? (
          <div className="mt-3 border-t border-stone-100 pt-3">
            <PositionEditor
              mode="create"
              clubId={clubId}
              parentPositionId={node.id}
              allPositions={allPositions}
              departments={departments}
              onCancel={() => setAddingParentId(null)}
              onSubmit={(input) => onSubmitCreateChild(input)}
            />
          </div>
        ) : null}
      </div>

      {hasChildren && isExpanded ? (
        <ol className="mt-1 space-y-1">
          {node.children.map((c) => (
            <PositionRow
              key={c.id}
              node={c}
              depth={depth + 1}
              expanded={expanded}
              toggle={toggle}
              editingId={editingId}
              setEditingId={setEditingId}
              addingParentId={addingParentId}
              setAddingParentId={setAddingParentId}
              allPositions={allPositions}
              departments={departments}
              departmentById={departmentById}
              clubId={clubId}
              onSubmitUpdate={onSubmitUpdate}
              onSubmitCreateChild={onSubmitCreateChild}
              onDeactivate={onDeactivate}
              onReactivate={onReactivate}
              isPending={isPending}
            />
          ))}
        </ol>
      ) : null}
    </li>
  );
}

interface EditorProps {
  mode: "create" | "edit";
  clubId: string;
  parentPositionId: string | null;
  node?: PositionNode;
  allPositions: FlatPositionRef[];
  departments: DepartmentRef[];
  onCancel: () => void;
  onSubmit: (input: {
    clubId: string;
    name: string;
    code?: string | null;
    departmentId?: string | null;
    reportsToPositionId?: string | null;
  }) => void;
}

function PositionEditor({
  mode, clubId, parentPositionId, node, allPositions, departments, onCancel, onSubmit,
}: EditorProps) {
  const [name, setName] = useState(node?.name ?? "");
  const [code, setCode] = useState(node?.code ?? "");
  const [departmentId, setDepartmentId] = useState<string>(node?.departmentId ?? "");
  const [reportsToPositionId, setReportsToPositionId] = useState<string>(
    node?.reportsToPositionId ?? parentPositionId ?? "",
  );

  // Exclude self + descendants from the reports-to picker to prevent
  // obvious cycles at the UI level (server also enforces).
  const excludeIds = useMemo(() => {
    if (!node) return new Set<string>();
    const set = new Set<string>([node.id]);
    const walk = (n: PositionNode) => { set.add(n.id); n.children.forEach(walk); };
    walk(node);
    return set;
  }, [node]);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({
          clubId,
          name: name.trim(),
          code: code.trim() ? code.trim() : null,
          departmentId: departmentId === "" ? null : departmentId,
          reportsToPositionId: reportsToPositionId === "" ? null : reportsToPositionId,
        });
      }}
      className="grid grid-cols-1 gap-3 sm:grid-cols-2"
      data-testid={mode === "create" ? "org-create-form" : "org-edit-form"}
    >
      <label className="label col-span-1">
        <span className="text-[12px] text-stone-600">Position name</span>
        <input
          className="input mt-1 w-full"
          type="text" required maxLength={120}
          value={name} onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Assistant Superintendent"
          autoFocus
        />
      </label>
      <label className="label col-span-1">
        <span className="text-[12px] text-stone-600">Code (optional)</span>
        <input
          className="input mt-1 w-full"
          type="text" maxLength={60}
          value={code} onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))}
          placeholder="e.g. ASSISTANT_SUPERINTENDENT"
        />
      </label>
      <label className="label col-span-1">
        <span className="text-[12px] text-stone-600">Department</span>
        <select
          className="select mt-1 w-full"
          value={departmentId}
          onChange={(e) => setDepartmentId(e.target.value)}
        >
          <option value="">— No department —</option>
          {departments.map((d) => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </select>
      </label>
      <label className="label col-span-1">
        <span className="text-[12px] text-stone-600">Reports to</span>
        <select
          className="select mt-1 w-full"
          value={reportsToPositionId}
          onChange={(e) => setReportsToPositionId(e.target.value)}
          data-testid="org-reports-to-select"
        >
          <option value="">— None (top of hierarchy) —</option>
          {allPositions
            .filter((p) => p.isActive && !excludeIds.has(p.id))
            .map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
        </select>
      </label>
      <div className="col-span-1 sm:col-span-2 mt-1 flex justify-end gap-2">
        <button type="button" className="btn btn-secondary btn-sm" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary btn-sm" data-testid="org-editor-save">
          {mode === "create" ? "Add position" : "Save changes"}
        </button>
      </div>
    </form>
  );
}
