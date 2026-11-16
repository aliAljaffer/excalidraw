import type { BoardSummary } from "./boards";

export type BoardSort = "recent" | "name";

export type BoardView = {
  folderId: string | null;
  favorites: boolean;
  trash: boolean;
};

export const filterAndSortBoards = (
  boards: readonly BoardSummary[],
  view: BoardView,
  query: string,
  sort: BoardSort,
) => {
  const needle = query.trim().toLowerCase();
  return boards
    .filter((board) => {
      if (view.trash !== (board.deletedAt !== null)) {
        return false;
      }
      if (!view.trash && !view.favorites) {
        if (view.folderId !== null && board.folderId !== view.folderId) {
          return false;
        }
      }
      if (!view.trash && view.favorites && !board.favorite) {
        return false;
      }
      return !needle || board.name.toLowerCase().includes(needle);
    })
    .sort((a, b) => {
      if (sort === "name") {
        return a.name.localeCompare(b.name, undefined, {
          numeric: true,
          sensitivity: "base",
        });
      }
      if (view.trash) {
        return (b.deletedAt ?? "").localeCompare(a.deletedAt ?? "");
      }
      return b.updatedAt.localeCompare(a.updatedAt);
    });
};
