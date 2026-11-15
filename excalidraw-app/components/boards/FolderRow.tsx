import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import React, { useEffect, useRef, useState } from "react";

import { DotsHorizontalIcon } from "@excalidraw/excalidraw/components/icons";

import { BoardMenu } from "./BoardMenu";

import type { FolderSummary } from "../../data/boards";

export const FolderRow = ({
  folder,
  count,
  active,
  menuOpen,
  renaming,
  portalRoot,
  onSelect,
  onMenuOpenChange,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onDelete,
}: {
  folder: FolderSummary;
  count: number;
  active: boolean;
  menuOpen: boolean;
  renaming: boolean;
  portalRoot: HTMLElement | null;
  onSelect: () => void;
  onMenuOpenChange: (open: boolean) => void;
  onStartRename: () => void;
  onCommitRename: (name: string) => void;
  onCancelRename: () => void;
  onDelete: () => void;
}) => {
  const [draft, setDraft] = useState(folder.name);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const selectingRef = useRef(false);

  useEffect(() => {
    if (!renaming) {
      return;
    }
    setDraft(folder.name);
    // after the menu returns focus to its trigger, so the input keeps it
    const timer = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => window.clearTimeout(timer);
  }, [renaming, folder.name]);

  if (renaming) {
    return (
      <input
        ref={inputRef}
        className="board-gallery__rail-input"
        aria-label="Folder name"
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
    );
  }

  return (
    <div className="board-gallery__rail-row">
      <button
        type="button"
        className={`board-gallery__rail-item${active ? " is-active" : ""}`}
        aria-current={active ? "true" : undefined}
        onClick={onSelect}
      >
        <span className="board-gallery__rail-name">{folder.name}</span>
        <span className="board-gallery__rail-count">{count}</span>
      </button>
      <span className={`board-gallery__rail-menu${menuOpen ? " is-open" : ""}`}>
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
            className="board-gallery__rail-menu-trigger"
            aria-label={`Actions for ${folder.name}`}
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
                onStartRename();
              }}
            >
              Rename
            </DropdownMenuPrimitive.Item>
            <DropdownMenuPrimitive.Item
              className="board-menu__item board-menu__item--danger"
              onSelect={() => {
                selectingRef.current = true;
                onDelete();
              }}
            >
              Delete folder
            </DropdownMenuPrimitive.Item>
          </BoardMenu>
        </DropdownMenuPrimitive.Root>
      </span>
    </div>
  );
};
