import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import React, { useEffect, useRef, useState } from "react";

import { DotsHorizontalIcon } from "@excalidraw/excalidraw/components/icons";

import { boardPreviewURL } from "../../data/boards";

import { BoardMenu } from "./BoardMenu";

import type { BoardSummary, FolderSummary } from "../../data/boards";

const UNFILED = "";

const STAR_PATH =
  "M316.9 18C311.6 7 300.4 0 288.1 0s-23.4 7-28.8 18L195 150.3 51.4 171.5c-12 1.8-22 10.2-25.7 21.7s-.7 24.2 7.9 32.7L137.8 329 113.2 474.7c-2 12 3 24.2 12.9 31.3s23 8 33.8 2.3l128.3-68.5 128.3 68.5c10.8 5.7 23.9 4.9 33.8-2.3s14.9-19.3 12.9-31.3L438.5 329 542.7 225.9c8.6-8.5 11.7-21.2 7.9-32.7s-13.7-19.9-25.7-21.7L381.2 150.3 316.9 18z";

const StarIcon = ({ filled }: { filled: boolean }) => (
  <svg
    aria-hidden="true"
    focusable="false"
    viewBox="0 0 576 512"
    fill={filled ? "currentColor" : "none"}
    stroke="currentColor"
    strokeWidth={40}
    strokeLinejoin="round"
  >
    <path d={STAR_PATH} />
  </svg>
);

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
  onToggleFavorite,
  onDuplicate,
  onDelete,
  onRestore,
  onPurge,
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
  onToggleFavorite: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onRestore: () => void;
  onPurge: () => void;
}) => {
  const [draft, setDraft] = useState(board.name);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const selectingRef = useRef(false);
  const deleted = board.deletedAt !== null;

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
    <article className={`board-card${deleted ? " board-card--deleted" : ""}`}>
      <button
        type="button"
        className="board-card__open"
        onClick={onOpen}
        disabled={deleted}
        aria-label={deleted ? `${board.name}, deleted` : `Open ${board.name}`}
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
            {isCurrent
              ? "Open now"
              : deleted
              ? `Deleted ${relativeTime(board.deletedAt!)}`
              : relativeTime(board.updatedAt)}
          </span>
        </div>
      )}

      {!renaming && !deleted && (
        <span className="board-card__star">
          <button
            type="button"
            className={`board-card__star-toggle${
              board.favorite ? " is-favorite" : ""
            }`}
            aria-label={
              board.favorite
                ? `Remove ${board.name} from favorites`
                : `Add ${board.name} to favorites`
            }
            aria-pressed={board.favorite}
            onClick={onToggleFavorite}
          >
            <StarIcon filled={board.favorite} />
          </button>
        </span>
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
              {deleted ? (
                <>
                  <DropdownMenuPrimitive.Item
                    className="board-menu__item"
                    onSelect={() => {
                      selectingRef.current = true;
                      onRestore();
                    }}
                  >
                    Restore
                  </DropdownMenuPrimitive.Item>
                  <DropdownMenuPrimitive.Separator className="board-menu__separator" />
                  <DropdownMenuPrimitive.Item
                    className="board-menu__item board-menu__item--danger"
                    onSelect={() => {
                      selectingRef.current = true;
                      onPurge();
                    }}
                  >
                    Delete forever
                  </DropdownMenuPrimitive.Item>
                </>
              ) : (
                <>
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
                  <DropdownMenuPrimitive.Item
                    className="board-menu__item"
                    onSelect={() => {
                      selectingRef.current = true;
                      onDuplicate();
                    }}
                  >
                    Duplicate
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
                </>
              )}
            </BoardMenu>
          </DropdownMenuPrimitive.Root>
        </span>
      )}
    </article>
  );
};
