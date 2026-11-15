import { gridIcon } from "@excalidraw/excalidraw/components/icons";
import { Dialog } from "@excalidraw/excalidraw/components/Dialog";
import { Button } from "@excalidraw/excalidraw/components/Button";
import React, { useCallback, useEffect, useMemo, useState } from "react";

import {
  createBoard,
  createFolder,
  deleteBoard,
  deleteFolder,
  fetchGallery,
  renameFolder,
  updateBoard,
} from "../data/boards";

import "./BoardGallery.scss";

import type { BoardGalleryData, BoardSummary } from "../data/boards";

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

const BoardCard = ({
  board,
  folders,
  onOpen,
  onChanged,
}: {
  board: BoardSummary;
  folders: { id: string; name: string }[];
  onOpen: () => void;
  onChanged: () => void;
}) => {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(board.name);
  const [busy, setBusy] = useState(false);

  const commitName = async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      await updateBoard(board.id, { name: name.trim() || board.name });
      setRenaming(false);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="board-card">
      <button type="button" className="board-card__open" onClick={onOpen}>
        <span className="board-card__name">{renaming ? board.name : name}</span>
        <span className="board-card__meta">
          {relativeTime(board.updatedAt)}
        </span>
      </button>

      {renaming ? (
        <div className="board-card__row">
          <input
            className="board-card__input"
            value={name}
            autoFocus
            maxLength={120}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                void commitName();
              }
              if (event.key === "Escape") {
                setName(board.name);
                setRenaming(false);
              }
            }}
          />
          <Button onSelect={commitName} type="button">
            Save
          </Button>
          <Button
            onSelect={() => {
              setName(board.name);
              setRenaming(false);
            }}
            type="button"
          >
            Cancel
          </Button>
        </div>
      ) : (
        <div className="board-card__row board-card__row--actions">
          <button
            type="button"
            className="board-card__action"
            onClick={() => {
              setName(board.name);
              setRenaming(true);
            }}
          >
            Rename
          </button>
          <select
            className="board-card__action board-card__select"
            value={board.folderId}
            aria-label="Folder"
            onChange={async (event) => {
              await updateBoard(board.id, { folderId: event.target.value });
              onChanged();
            }}
          >
            <option value={UNFILED}>No folder</option>
            {folders.map((folder) => (
              <option key={folder.id} value={folder.id}>
                {folder.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="board-card__action board-card__action--danger"
            onClick={async () => {
              if (
                window.confirm(
                  `Delete "${board.name}" and its drawing? This cannot be undone.`,
                )
              ) {
                await deleteBoard(board.id);
                onChanged();
              }
            }}
          >
            Delete
          </button>
        </div>
      )}
    </div>
  );
};

export const BoardGallery = ({ onClose }: { onClose: () => void }) => {
  const [data, setData] = useState<BoardGalleryData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string | null>(null);
  const [newBoardName, setNewBoardName] = useState("");
  const [newFolderName, setNewFolderName] = useState("");
  const [addingFolder, setAddingFolder] = useState(false);

  const reload = useCallback(async () => {
    try {
      setData(await fetchGallery());
      setError(null);
    } catch (e: any) {
      setError(e.message || "could not load the gallery");
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const openBoard = (id: string) => {
    window.location.assign(`/b/${id}`);
  };

  const visibleBoards = useMemo(() => {
    if (!data || filter === null) {
      return data?.boards ?? [];
    }
    return data.boards.filter((board) => board.folderId === filter);
  }, [data, filter]);

  const create = async () => {
    const board = await createBoard({
      name: newBoardName.trim() || undefined,
      folderId: filter ?? undefined,
    });
    setNewBoardName("");
    openBoard(board.id);
  };

  return (
    <Dialog
      onCloseRequest={onClose}
      title={"Boards"}
      size={"wide"}
      className="board-gallery"
    >
      <div className="board-gallery__body">
        {error ? (
          <div className="board-gallery__empty">
            <p>Your boards live behind your login.</p>
            <p className="board-gallery__hint">{error}</p>
          </div>
        ) : (
          <>
            <div className="board-gallery__filters">
              <button
                type="button"
                className={`board-gallery__chip${
                  filter === null ? " is-active" : ""
                }`}
                onClick={() => setFilter(null)}
              >
                All
              </button>
              {data?.folders.map((folder) => (
                <span key={folder.id} className="board-gallery__chip-group">
                  <button
                    type="button"
                    className={`board-gallery__chip${
                      filter === folder.id ? " is-active" : ""
                    }`}
                    onClick={() => setFilter(folder.id)}
                    onDoubleClick={async () => {
                      const name = window.prompt("Folder name", folder.name);
                      if (name?.trim()) {
                        await renameFolder(folder.id, name.trim());
                        await reload();
                      }
                    }}
                    title="Double click to rename"
                  >
                    {folder.name}
                  </button>
                  <button
                    type="button"
                    className="board-gallery__chip-delete"
                    aria-label={`Delete folder ${folder.name}`}
                    onClick={async () => {
                      if (
                        window.confirm(
                          `Delete the folder "${folder.name}"? Its boards stay, unfiled.`,
                        )
                      ) {
                        await deleteFolder(folder.id);
                        if (filter === folder.id) {
                          setFilter(null);
                        }
                        await reload();
                      }
                    }}
                  >
                    ×
                  </button>
                </span>
              ))}
              <button
                type="button"
                className={`board-gallery__chip${
                  filter === UNFILED && data ? " is-active" : ""
                }`}
                onClick={() => setFilter(UNFILED)}
              >
                Unfiled
              </button>

              {addingFolder ? (
                <span className="board-gallery__new-folder">
                  <input
                    className="board-card__input"
                    placeholder="Folder name"
                    autoFocus
                    value={newFolderName}
                    onChange={(event) => setNewFolderName(event.target.value)}
                    onKeyDown={async (event) => {
                      if (event.key === "Enter" && newFolderName.trim()) {
                        await createFolder(newFolderName.trim());
                        setNewFolderName("");
                        setAddingFolder(false);
                        await reload();
                      }
                      if (event.key === "Escape") {
                        setAddingFolder(false);
                      }
                    }}
                  />
                </span>
              ) : (
                <button
                  type="button"
                  className="board-gallery__chip board-gallery__chip--ghost"
                  onClick={() => setAddingFolder(true)}
                >
                  New folder
                </button>
              )}
            </div>

            <div className="board-gallery__grid">
              <div className="board-card board-card--new">
                <div className="board-card__row">
                  <input
                    className="board-card__input board-card__input--new"
                    placeholder="Name the board"
                    value={newBoardName}
                    onChange={(event) => setNewBoardName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        void create();
                      }
                    }}
                  />
                  <Button onSelect={create} type="button">
                    New board
                  </Button>
                </div>
              </div>

              {visibleBoards.map((board) => (
                <BoardCard
                  key={board.id}
                  board={board}
                  folders={data?.folders ?? []}
                  onOpen={() => openBoard(board.id)}
                  onChanged={reload}
                />
              ))}
            </div>

            {data && visibleBoards.length === 0 && (
              <p className="board-gallery__hint">
                No boards here yet. Name one above and it opens in the editor.
              </p>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
};

export const BoardGalleryButton = ({ onOpen }: { onOpen: () => void }) => (
  <button
    type="button"
    className="board-gallery-button"
    onClick={onOpen}
    title="Boards"
    aria-label="Boards"
  >
    {gridIcon}
  </button>
);
