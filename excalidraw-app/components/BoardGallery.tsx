import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { Dialog } from "@excalidraw/excalidraw/components/Dialog";
import { FilledButton } from "@excalidraw/excalidraw/components/FilledButton";
import {
  gridIcon,
  PlusIcon,
  searchIcon,
} from "@excalidraw/excalidraw/components/icons";

import { setBoardName } from "../data/boardSession";
import { filterAndSortBoards } from "../data/boardList";
import {
  createBoard,
  createFolder,
  deleteBoard,
  deleteFolder,
  duplicateBoard,
  fetchGallery,
  getBoardIdFromPath,
  renameFolder,
  restoreBoard,
  saveBoard,
  updateBoard,
} from "../data/boards";

import { BoardCard } from "./boards/BoardCard";
import { FolderRow } from "./boards/FolderRow";
import { BOARD_TEMPLATES, buildTemplate } from "./boards/templates";

import "./BoardGallery.scss";

import type { BoardSort } from "../data/boardList";
import type {
  BoardGalleryData,
  BoardSummary,
  FolderSummary,
} from "../data/boards";
import type { BoardTemplateId } from "./boards/templates";

const UNFILED = "";
const NO_BOARDS: BoardSummary[] = [];
const NO_FOLDERS: FolderSummary[] = [];

type Confirm =
  | { kind: "board"; board: BoardSummary; purge: boolean }
  | { kind: "folder"; folder: FolderSummary };

export const BoardGallery = ({
  onClose,
  onOpenBoard,
}: {
  onClose: () => void;
  onOpenBoard: (id: string) => void;
}) => {
  const [data, setData] = useState<BoardGalleryData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<BoardSort>("recent");
  const [folderFilter, setFolderFilter] = useState<string | null>(null);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [trashOnly, setTrashOnly] = useState(false);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [openFolderMenuId, setOpenFolderMenuId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [addingFolder, setAddingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [creating, setCreating] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const currentBoardId = getBoardIdFromPath();

  const bodyRef = useCallback((node: HTMLDivElement | null) => {
    setPortalRoot(node?.closest<HTMLElement>(".Modal") ?? null);
  }, []);

  const reload = useCallback(async () => {
    try {
      setData(await fetchGallery());
      setError(null);
    } catch (e: any) {
      setError(e?.message || "could not load the gallery");
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (window.matchMedia("(pointer: fine)").matches) {
      searchRef.current?.focus();
    }
  }, []);

  useEffect(() => {
    if (confirm) {
      const timer = window.setTimeout(() => cancelRef.current?.focus());
      return () => window.clearTimeout(timer);
    }
  }, [confirm]);

  const fail = (e: any, fallback: string) =>
    setActionError(e?.message || fallback);

  const focusSearch = () => window.setTimeout(() => searchRef.current?.focus());

  const boards = data?.boards ?? NO_BOARDS;
  const folders = data?.folders ?? NO_FOLDERS;

  const activeBoards = useMemo(
    () => boards.filter((board) => board.deletedAt === null),
    [boards],
  );
  const trashBoards = useMemo(
    () => boards.filter((board) => board.deletedAt !== null),
    [boards],
  );
  const favoritesCount = activeBoards.filter((board) => board.favorite).length;

  const counts = useMemo(() => {
    const total = new Map<string, number>();
    for (const board of activeBoards) {
      total.set(board.folderId, (total.get(board.folderId) ?? 0) + 1);
    }
    return total;
  }, [activeBoards]);

  const visible = useMemo(
    () =>
      filterAndSortBoards(
        boards,
        {
          folderId: favoritesOnly || trashOnly ? null : folderFilter,
          favorites: favoritesOnly,
          trash: trashOnly,
        },
        query,
        sort,
      ),
    [boards, folderFilter, favoritesOnly, trashOnly, query, sort],
  );

  const showAll = () => {
    setFolderFilter(null);
    setFavoritesOnly(false);
    setTrashOnly(false);
  };

  const showFavorites = () => {
    setFolderFilter(null);
    setFavoritesOnly(true);
    setTrashOnly(false);
  };

  const showFolder = (folderId: string | null) => {
    setFolderFilter(folderId);
    setFavoritesOnly(false);
    setTrashOnly(false);
  };

  const showTrash = () => {
    setFolderFilter(null);
    setFavoritesOnly(false);
    setTrashOnly(true);
  };

  const openBoard = (id: string) => {
    if (id === currentBoardId) {
      onClose();
      return;
    }
    onOpenBoard(id);
  };

  const create = async () => {
    if (creating) {
      return;
    }
    setCreating(true);
    try {
      const board = await createBoard({ folderId: folderFilter ?? undefined });
      onOpenBoard(board.id);
    } catch (e: any) {
      fail(e, "Could not create the board.");
    } finally {
      setCreating(false);
    }
  };

  const createFromTemplate = async (template: BoardTemplateId) => {
    if (creating) {
      return;
    }
    setCreating(true);
    try {
      const board = await createBoard({ folderId: folderFilter ?? undefined });
      await saveBoard({
        id: board.id,
        roomKey: board.roomKey,
        revision: 0,
        elements: buildTemplate(template),
      });
      setTemplatesOpen(false);
      onOpenBoard(board.id);
    } catch (e: any) {
      fail(e, "Could not create the board from the template.");
      setTemplatesOpen(false);
      await reload();
    } finally {
      setCreating(false);
    }
  };

  const renameBoard = async (board: BoardSummary, name: string) => {
    setRenamingId(null);
    const trimmed = name.trim();
    if (!trimmed || trimmed === board.name) {
      focusSearch();
      return;
    }
    try {
      await updateBoard(board.id, { name: trimmed });
      if (board.id === currentBoardId) {
        setBoardName(trimmed);
      }
      await reload();
    } catch (e: any) {
      fail(e, "Could not rename the board.");
    } finally {
      focusSearch();
    }
  };

  const moveBoard = async (board: BoardSummary, folderId: string) => {
    if (folderId === board.folderId) {
      return;
    }
    try {
      await updateBoard(board.id, { folderId });
      await reload();
    } catch (e: any) {
      fail(e, "Could not move the board.");
    } finally {
      focusSearch();
    }
  };

  const toggleFavorite = async (board: BoardSummary) => {
    try {
      await updateBoard(board.id, { favorite: !board.favorite });
      await reload();
    } catch (e: any) {
      fail(e, "Could not update the favorite.");
    }
  };

  const duplicate = async (board: BoardSummary) => {
    try {
      await duplicateBoard(board.id);
      await reload();
    } catch (e: any) {
      fail(e, "Could not duplicate the board.");
    }
  };

  const restore = async (board: BoardSummary) => {
    try {
      await restoreBoard(board.id);
      await reload();
    } catch (e: any) {
      fail(e, "Could not restore the board.");
    }
  };

  const addFolder = async () => {
    const name = newFolderName.trim();
    if (!name || creatingFolder) {
      return;
    }
    setCreatingFolder(true);
    try {
      await createFolder(name);
      setNewFolderName("");
      setAddingFolder(false);
      await reload();
    } catch (e: any) {
      fail(e, "Could not create the folder.");
    } finally {
      setCreatingFolder(false);
    }
  };

  const renameFolderTo = async (folder: FolderSummary, name: string) => {
    setRenamingFolderId(null);
    const trimmed = name.trim();
    if (!trimmed || trimmed === folder.name) {
      focusSearch();
      return;
    }
    try {
      await renameFolder(folder.id, trimmed);
      await reload();
    } catch (e: any) {
      fail(e, "Could not rename the folder.");
    } finally {
      focusSearch();
    }
  };

  const closeConfirm = () => {
    setConfirm(null);
    focusSearch();
  };

  const confirmDelete = async () => {
    if (!confirm || confirmBusy) {
      return;
    }
    setConfirmBusy(true);
    try {
      if (confirm.kind === "board") {
        await deleteBoard(confirm.board.id, { purge: confirm.purge });
      } else {
        await deleteFolder(confirm.folder.id);
        if (folderFilter === confirm.folder.id) {
          setFolderFilter(null);
        }
      }
      setConfirm(null);
      await reload();
    } catch (e: any) {
      fail(e, "Could not delete it.");
      setConfirm(null);
    } finally {
      setConfirmBusy(false);
      focusSearch();
    }
  };

  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Escape") {
      return;
    }
    if (query) {
      event.preventDefault();
      event.stopPropagation();
      setQuery("");
    }
  };

  const emptyState = () => {
    if (query) {
      return (
        <>
          <p className="board-gallery__state-text">
            No boards match “{query}”.
          </p>
          <FilledButton
            variant="outlined"
            color="muted"
            onClick={() => setQuery("")}
          >
            Clear search
          </FilledButton>
        </>
      );
    }
    if (trashOnly) {
      return (
        <p className="board-gallery__state-text">
          Trash is empty. Deleted boards stay here for 30 days.
        </p>
      );
    }
    if (favoritesOnly) {
      return (
        <p className="board-gallery__state-text">
          No favorites yet. Star a board to keep it close.
        </p>
      );
    }
    if (folderFilter !== null) {
      return (
        <p className="board-gallery__state-text">
          This folder is empty. Move a board here from its menu.
        </p>
      );
    }
    return (
      <p className="board-gallery__state-text">
        No boards yet. Start with New board.
      </p>
    );
  };

  const confirmCopy = confirm
    ? confirm.kind === "folder"
      ? {
          title: `Delete the folder “${confirm.folder.name}”?`,
          body: "Its boards stay, unfiled.",
          action: "Delete",
          purge: false,
        }
      : confirm.purge
      ? {
          title: `Delete “${confirm.board.name}” forever?`,
          body: "The drawing and its images go with it. This cannot be undone.",
          action: "Delete forever",
          purge: true,
        }
      : {
          title: `Move “${confirm.board.name}” to the trash?`,
          body: "You can restore it for 30 days.",
          action: "Move to trash",
          purge: false,
        }
    : null;

  return (
    <Dialog
      onCloseRequest={onClose}
      title="Boards"
      size="wide"
      className="board-gallery"
      autofocus={false}
    >
      <div className="board-gallery__body" ref={bodyRef}>
        <div className="board-gallery__header">
          <label className="board-gallery__search">
            {searchIcon}
            <input
              ref={searchRef}
              type="text"
              placeholder="Search boards"
              aria-label="Search boards"
              value={query}
              disabled={!data}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onSearchKeyDown}
            />
          </label>
          <select
            className="board-gallery__sort"
            aria-label="Sort boards"
            value={sort}
            disabled={!data}
            onChange={(event) => setSort(event.target.value as BoardSort)}
          >
            <option value="recent">Recent</option>
            <option value="name">Name</option>
          </select>
          <FilledButton
            className="board-gallery__new"
            icon={PlusIcon}
            status={creating ? "loading" : null}
            disabled={trashOnly}
            onClick={create}
          >
            New board
          </FilledButton>
          <FilledButton
            className="board-gallery__templates"
            variant="outlined"
            color="muted"
            disabled={!data || trashOnly}
            onClick={() => setTemplatesOpen(true)}
          >
            Templates
          </FilledButton>
        </div>

        {actionError && (
          <p className="board-gallery__alert" role="alert">
            {actionError}
          </p>
        )}

        <div className="board-gallery__panes">
          <nav className="board-gallery__rail" aria-label="Folders">
            <button
              type="button"
              className={`board-gallery__rail-item${
                !favoritesOnly && !trashOnly && folderFilter === null
                  ? " is-active"
                  : ""
              }`}
              aria-current={
                !favoritesOnly && !trashOnly && folderFilter === null
                  ? "true"
                  : undefined
              }
              onClick={showAll}
            >
              <span className="board-gallery__rail-name">All</span>
              <span className="board-gallery__rail-count">
                {activeBoards.length}
              </span>
            </button>
            <button
              type="button"
              className={`board-gallery__rail-item${
                favoritesOnly ? " is-active" : ""
              }`}
              aria-current={favoritesOnly ? "true" : undefined}
              onClick={showFavorites}
            >
              <span className="board-gallery__rail-name">Favorites</span>
              <span className="board-gallery__rail-count">
                {favoritesCount}
              </span>
            </button>
            <button
              type="button"
              className={`board-gallery__rail-item${
                !favoritesOnly && !trashOnly && folderFilter === UNFILED
                  ? " is-active"
                  : ""
              }`}
              aria-current={
                !favoritesOnly && !trashOnly && folderFilter === UNFILED
                  ? "true"
                  : undefined
              }
              onClick={() => showFolder(UNFILED)}
            >
              <span className="board-gallery__rail-name">Unfiled</span>
              <span className="board-gallery__rail-count">
                {counts.get(UNFILED) ?? 0}
              </span>
            </button>

            {folders.length > 0 && (
              <div className="board-gallery__rail-divider" />
            )}

            {folders.map((folder) => (
              <FolderRow
                key={folder.id}
                folder={folder}
                count={counts.get(folder.id) ?? 0}
                active={
                  !favoritesOnly && !trashOnly && folderFilter === folder.id
                }
                menuOpen={openFolderMenuId === folder.id}
                renaming={renamingFolderId === folder.id}
                portalRoot={portalRoot}
                onSelect={() => showFolder(folder.id)}
                onMenuOpenChange={(open) =>
                  setOpenFolderMenuId(open ? folder.id : null)
                }
                onStartRename={() => setRenamingFolderId(folder.id)}
                onCommitRename={(name) => renameFolderTo(folder, name)}
                onCancelRename={() => setRenamingFolderId(null)}
                onDelete={() => setConfirm({ kind: "folder", folder })}
              />
            ))}

            <div className="board-gallery__rail-divider" />

            {addingFolder ? (
              <input
                className="board-gallery__rail-input"
                placeholder="Folder name"
                aria-label="Folder name"
                autoFocus
                value={newFolderName}
                disabled={creatingFolder}
                onChange={(event) => setNewFolderName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    event.stopPropagation();
                    void addFolder();
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    setNewFolderName("");
                    setAddingFolder(false);
                  }
                }}
                onBlur={() => {
                  setNewFolderName("");
                  setAddingFolder(false);
                }}
              />
            ) : (
              <button
                type="button"
                className="board-gallery__rail-new"
                disabled={!data}
                onClick={() => setAddingFolder(true)}
              >
                {PlusIcon}
                New folder
              </button>
            )}

            <div className="board-gallery__rail-divider" />

            <button
              type="button"
              className={`board-gallery__rail-item board-gallery__rail-trash${
                trashOnly ? " is-active" : ""
              }`}
              aria-current={trashOnly ? "true" : undefined}
              onClick={showTrash}
            >
              <span className="board-gallery__rail-name">Trash</span>
              <span className="board-gallery__rail-count">
                {trashBoards.length}
              </span>
            </button>
          </nav>

          <div className="board-gallery__main">
            {error ? (
              <div className="board-gallery__state">
                <p className="board-gallery__state-text">{error}</p>
                <FilledButton
                  variant="outlined"
                  color="muted"
                  onClick={() => void reload()}
                >
                  Try again
                </FilledButton>
              </div>
            ) : !data ? (
              <div className="board-gallery__state" role="status">
                <p className="board-gallery__state-text">Loading boards…</p>
              </div>
            ) : visible.length === 0 ? (
              <div className="board-gallery__state">{emptyState()}</div>
            ) : (
              <div className="board-gallery__grid">
                {visible.map((board) => (
                  <BoardCard
                    key={board.id}
                    board={board}
                    folders={folders}
                    isCurrent={board.id === currentBoardId}
                    menuOpen={openMenuId === board.id}
                    renaming={renamingId === board.id}
                    portalRoot={portalRoot}
                    onOpen={() => openBoard(board.id)}
                    onMenuOpenChange={(open) =>
                      setOpenMenuId(open ? board.id : null)
                    }
                    onStartRename={() => setRenamingId(board.id)}
                    onCommitRename={(name) => renameBoard(board, name)}
                    onCancelRename={() => setRenamingId(null)}
                    onMove={(folderId) => moveBoard(board, folderId)}
                    onToggleFavorite={() => toggleFavorite(board)}
                    onDuplicate={() => void duplicate(board)}
                    onDelete={() =>
                      setConfirm({ kind: "board", board, purge: false })
                    }
                    onRestore={() => void restore(board)}
                    onPurge={() =>
                      setConfirm({ kind: "board", board, purge: true })
                    }
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {confirm && confirmCopy && (
        <Dialog
          className="board-confirm"
          size="small"
          title={confirmCopy.title}
          onCloseRequest={closeConfirm}
          autofocus={false}
        >
          <p className="board-confirm__text">{confirmCopy.body}</p>
          <div className="board-confirm__actions">
            <FilledButton
              ref={cancelRef}
              variant="outlined"
              color="muted"
              onClick={closeConfirm}
            >
              Cancel
            </FilledButton>
            <FilledButton
              color="danger"
              status={confirmBusy ? "loading" : null}
              onClick={confirmDelete}
            >
              {confirmCopy.action}
            </FilledButton>
          </div>
        </Dialog>
      )}

      {templatesOpen && (
        <Dialog
          className="board-templates"
          size="small"
          title="New from a template"
          onCloseRequest={() => setTemplatesOpen(false)}
          autofocus={false}
        >
          <div className="board-templates__list">
            {BOARD_TEMPLATES.map((template, index) => (
              <button
                key={template.id}
                type="button"
                className="board-templates__item"
                disabled={creating}
                autoFocus={index === 0}
                onClick={() => void createFromTemplate(template.id)}
              >
                <span className="board-templates__name">{template.name}</span>
                <span className="board-templates__description">
                  {template.description}
                </span>
              </button>
            ))}
          </div>
        </Dialog>
      )}
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
