import type { BoardSummary } from "./boards";

export type BoardSort = "recent" | "name";

export const filterAndSortBoards = (
  boards: readonly BoardSummary[],
  folderId: string | null,
  query: string,
  sort: BoardSort,
) => {
  const needle = query.trim().toLowerCase();
  return boards
    .filter((board) => {
      if (folderId !== null && board.folderId !== folderId) {
        return false;
      }
      return !needle || board.name.toLowerCase().includes(needle);
    })
    .sort((a, b) =>
      sort === "name"
        ? a.name.localeCompare(b.name, undefined, {
            numeric: true,
            sensitivity: "base",
          })
        : b.updatedAt.localeCompare(a.updatedAt),
    );
};
