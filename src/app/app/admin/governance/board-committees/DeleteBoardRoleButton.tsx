"use client";

// Row-level Delete button on the Board roster table. Confirm-gated;
// posts to `deleteBoardRoleAction`.

import { useTransition } from "react";

import { deleteBoardRoleAction } from "./_actions";

type Props = {
  roleId: string;
  label: string;
};

export function DeleteBoardRoleButton({ roleId, label }: Props) {
  const [isPending, startTransition] = useTransition();
  function handleClick() {
    if (
      !window.confirm(
        `Remove ${label} from the Board roster? This deletes the role record and the member's board access ends immediately. Past tenure history is lost.`,
      )
    ) {
      return;
    }
    startTransition(() => {
      void deleteBoardRoleAction(roleId);
    });
  }
  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={isPending}
      className="text-xs text-red-700 hover:underline disabled:opacity-60"
      data-testid={`board-role-delete-${roleId}`}
    >
      {isPending ? "Removing…" : "Remove"}
    </button>
  );
}
