import React, {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { gridIcon } from "@excalidraw/excalidraw/components/icons";

import {
  flushBoard,
  getBoardSessionSnapshot,
  setBoardName,
  subscribeBoardSession,
} from "../../data/boardSession";
import { updateBoard } from "../../data/boards";

import "./BoardHeader.scss";

export const BoardHeader = ({
  onOpenBoards,
  isCollaborating,
}: {
  onOpenBoards: () => void;
  isCollaborating: boolean;
}) => {
  const session = useSyncExternalStore(
    subscribeBoardSession,
    getBoardSessionSnapshot,
    getBoardSessionSnapshot,
  );
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const name = session?.name;
  useEffect(() => {
    document.title = name ? `${name} · Excalidraw` : "Excalidraw";
  }, [name]);

  useEffect(() => {
    if (!renaming) {
      return;
    }
    const timer = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => window.clearTimeout(timer);
  }, [renaming]);

  if (!session) {
    return null;
  }

  const status = isCollaborating
    ? "Live session"
    : session.status === "saving"
    ? "Saving…"
    : session.status === "error"
    ? "Save failed"
    : "Saved";

  const startRename = () => {
    setDraft(session.name);
    setError(null);
    setRenaming(true);
  };

  const commitRename = async () => {
    setRenaming(false);
    const name = draft.trim();
    if (!name || name === session.name) {
      return;
    }
    try {
      await updateBoard(session.id, { name });
      setBoardName(name);
      setError(null);
    } catch {
      setError("Rename failed");
    }
  };

  return (
    <div className="board-header">
      <button
        type="button"
        className="board-header__back"
        onClick={onOpenBoards}
        aria-label="All boards"
        title="All boards"
      >
        {gridIcon}
      </button>
      <div className="board-header__body">
        {renaming ? (
          <input
            ref={inputRef}
            className="board-header__input"
            aria-label="Board name"
            value={draft}
            maxLength={120}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void commitRename();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setRenaming(false);
              }
            }}
            onBlur={() => setRenaming(false)}
          />
        ) : (
          <button
            type="button"
            className="board-header__name"
            onClick={startRename}
            title="Rename board"
          >
            {session.name}
          </button>
        )}
        <span className="board-header__meta" aria-live="polite">
          <span
            className={`board-header__status is-${session.status}${
              isCollaborating ? " is-live" : ""
            }`}
          >
            {status}
          </span>
          {session.status === "error" && !isCollaborating && (
            <button
              type="button"
              className="board-header__retry"
              onClick={() => void flushBoard().catch(() => {})}
            >
              Retry
            </button>
          )}
          {error && <span className="board-header__error">{error}</span>}
        </span>
      </div>
    </div>
  );
};
