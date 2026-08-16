import { useEffect, useSyncExternalStore } from "react";
import {
  getCanUndoSnapshot,
  subscribeUndo,
  undoLastLocalChange,
} from "../utils/localNgEngine";
import { UndoIcon } from "./icons";

export function UndoControl() {
  const canUndo = useSyncExternalStore(
    subscribeUndo,
    getCanUndoSnapshot,
    getCanUndoSnapshot,
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key.toLocaleLowerCase() !== "z" ||
        (!event.ctrlKey && !event.metaKey) ||
        event.shiftKey ||
        event.altKey
      ) return;
      if (!getCanUndoSnapshot()) return;
      event.preventDefault();
      undoLastLocalChange();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <button
      type="button"
      className="nav-undo"
      disabled={!canUndo}
      onClick={undoLastLocalChange}
      // The tooltip carries the full explanation; the accessible name stays
      // the short word so it reads well in a screen reader's control list.
      aria-label="Undo"
      title="Undo last local change (Ctrl/Cmd+Z)"
    >
      <UndoIcon />
    </button>
  );
}
