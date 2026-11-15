import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import React, { useEffect, useRef, useState } from "react";

import { DotsHorizontalIcon } from "@excalidraw/excalidraw/components/icons";

import { boardPreviewURL } from "../../data/boards";

import { BoardMenu } from "./BoardMenu";

import type { BoardSummary, FolderSummary } from "../../data/boards";

const UNFILED = "";

const relativeTime = (iso: string) => {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) {
    return "";
  }
  const minutes = Math.round((Date.now() - then) / 60000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours} h ago`;
  }
  const days = Math.round(hours / 24);
  if (days === 1) {
    return "yesterday";
  }
  if (days < 30) {
    return `${days} days ago`;
  }
  return new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
};

export const BoardCard = ({
  board,
  folders,
  isCurrent,
  menuOpen,
  renaming,
  portalRoot,
  onOpen,
  onMenuOpenChange,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onMove,
  onDelete,
}: {
  board: BoardSummary;
  folders: FolderSummary[];
  isCurrent: boolean;
  menuOpen: boolean;
  renaming: boolean;
  portalRoot: HTMLElement | null;
  onOpen: () => void;
  onMenuOpenChange: (open: boolean) => void;
  onStartRename: () => void;
  onCommitRename: (name: string) => void;
  onCancelRename: () => void;
  onMove: (folderId: string) => void;
  onDelete: () => void;
}) => {
  const [draft, setDraft] = useState(board.name);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const selectingRef = useRef(false);

  useEffect(() => {
    if (!renaming) {
      return;
    }
    setDraft(board.name);
    // after the menu returns focus to its trigger, so the input keeps it
    const timer = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => window.clearTimeout(timer);
  }, [renaming, board.name]);

  return (
    <article className="board-card">
      <button
        type="button"
        className="board-card__open"
        onClick={onOpen}
        aria-label={`Open ${board.name}`}
      >
        {board.hasPreview ? (
          <img
            className="board-card__preview"
            src={boardPreviewURL(board)}
            alt=""
            loading="lazy"
            decoding="async"
          />
        ) : (
          <span className="board-card__preview board-card__preview--empty" />
        )}
      </button>

      {renaming ? (
        <div className="board-card__caption">
          <input
            ref={inputRef}
            className="board-card__rename"
            aria-label="Board name"
            value={draft}
            maxLength={120}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.stopPropagation();
                onCommitRename(draft);
              }
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                onCancelRename();
                menuButtonRef.current?.focus();
              }
            }}
            onBlur={onCancelRename}
          />
        </div>
      ) : (
        <div className="board-card__caption">
          <span className="board-card__name">{board.name}</span>
          <span className="board-card__meta">
            {isCurrent ? "Open now" : relativeTime(board.updatedAt)}
          </span>
        </div>
      )}

      {!renaming && (
        <span className={`board-card__menu${menuOpen ? " is-open" : ""}`}>
          <DropdownMenuPrimitive.Root
            open={menuOpen}
            onOpenChange={(open) => {
              if (open) {
                selectingRef.current = false;
              }
              onMenuOpenChange(open);
            }}
            modal={false}
          >
            <DropdownMenuPrimitive.Trigger
              ref={menuButtonRef}
              className="board-card__menu-trigger"
              aria-label={`Actions for ${board.name}`}
            >
              {DotsHorizontalIcon}
            </DropdownMenuPrimitive.Trigger>
            <BoardMenu
              portalRoot={portalRoot}
              onCloseAutoFocus={(event) => {
                if (selectingRef.current) {
                  selectingRef.current = false;
                  event.preventDefault();
                }
              }}
            >
              <DropdownMenuPrimitive.Item
                className="board-menu__item"
                onSelect={() => {
                  selectingRef.current = true;
                  onOpen();
                }}
              >
                Open
              </DropdownMenuPrimitive.Item>
              <DropdownMenuPrimitive.Item
                className="board-menu__item"
                onSelect={() => {
                  selectingRef.current = true;
                  onStartRename();
                }}
              >
                Rename
              </DropdownMenuPrimitive.Item>
              <DropdownMenuPrimitive.Separator className="board-menu__separator" />
              <DropdownMenuPrimitive.Label className="board-menu__label">
                Move to
              </DropdownMenuPrimitive.Label>
              <DropdownMenuPrimitive.RadioGroup
                value={board.folderId}
                onValueChange={(folderId) => {
                  selectingRef.current = true;
                  onMove(folderId);
                }}
              >
                <DropdownMenuPrimitive.RadioItem
                  className="board-menu__item"
                  value={UNFILED}
                >
                  <span className="board-menu__text">No folder</span>
                  <DropdownMenuPrimitive.ItemIndicator className="board-menu__indicator">
                    ✓
                  </DropdownMenuPrimitive.ItemIndicator>
                </DropdownMenuPrimitive.RadioItem>
                {folders.map((folder) => (
                  <DropdownMenuPrimitive.RadioItem
                    key={folder.id}
                    className="board-menu__item"
                    value={folder.id}
                  >
                    <span className="board-menu__text">{folder.name}</span>
                    <DropdownMenuPrimitive.ItemIndicator className="board-menu__indicator">
                      ✓
                    </DropdownMenuPrimitive.ItemIndicator>
                  </DropdownMenuPrimitive.RadioItem>
                ))}
              </DropdownMenuPrimitive.RadioGroup>
              <DropdownMenuPrimitive.Separator className="board-menu__separator" />
              <DropdownMenuPrimitive.Item
                className="board-menu__item board-menu__item--danger"
                disabled={isCurrent}
                title={
                  isCurrent
                    ? "This board is open. Open another board before deleting it."
                    : undefined
                }
                onSelect={() => {
                  selectingRef.current = true;
                  onDelete();
                }}
              >
                Delete
              </DropdownMenuPrimitive.Item>
            </BoardMenu>
          </DropdownMenuPrimitive.Root>
        </span>
      )}
    </article>
  );
};
