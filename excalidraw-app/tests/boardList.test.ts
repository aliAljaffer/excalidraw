import { describe, expect, it } from "vitest";

import { filterAndSortBoards } from "../data/boardList";

import type { BoardSummary } from "../data/boards";

const board = (
  id: string,
  name: string,
  folderId: string,
  updatedAt: string,
  extra: Partial<BoardSummary> = {},
): BoardSummary => ({
  id,
  name,
  folderId,
  updatedAt,
  hasPreview: false,
  favorite: false,
  deletedAt: null,
  ...extra,
});

const boards = [
  board("a", "Infra 10", "f1", "2026-11-15T10:00:00Z", { favorite: true }),
  board("b", "Infra 2", "f1", "2026-11-14T10:00:00Z"),
  board("c", "Talks", "", "2026-11-15T12:00:00Z"),
  board("d", "Old board", "", "2026-11-01T12:00:00Z", {
    deletedAt: "2026-11-10T12:00:00Z",
  }),
  board("e", "Older board", "f1", "2026-10-01T12:00:00Z", {
    deletedAt: "2026-11-12T12:00:00Z",
  }),
];

const all = { folderId: null, favorites: false, trash: false };

describe("filterAndSortBoards", () => {
  it("sorts active boards by recent first", () => {
    expect(
      filterAndSortBoards(boards, all, "", "recent").map((b) => b.id),
    ).toEqual(["c", "a", "b"]);
  });

  it("sorts names in natural order", () => {
    expect(
      filterAndSortBoards(boards, all, "", "name").map((b) => b.name),
    ).toEqual(["Infra 2", "Infra 10", "Talks"]);
  });

  it("keeps only the selected folder", () => {
    expect(
      filterAndSortBoards(
        boards,
        { folderId: "f1", favorites: false, trash: false },
        "",
        "recent",
      ).map((b) => b.id),
    ).toEqual(["a", "b"]);
    expect(
      filterAndSortBoards(
        boards,
        { folderId: "", favorites: false, trash: false },
        "",
        "recent",
      ).map((b) => b.id),
    ).toEqual(["c"]);
  });

  it("keeps only favorites, ignoring the folder", () => {
    expect(
      filterAndSortBoards(
        boards,
        { folderId: "f1", favorites: true, trash: false },
        "",
        "recent",
      ).map((b) => b.id),
    ).toEqual(["a"]);
  });

  it("shows only trashed boards, most recently deleted first", () => {
    expect(
      filterAndSortBoards(
        boards,
        { folderId: null, favorites: false, trash: true },
        "",
        "recent",
      ).map((b) => b.id),
    ).toEqual(["e", "d"]);
  });

  it("matches the query regardless of case and surrounding space", () => {
    expect(
      filterAndSortBoards(boards, all, "  TALKS ", "recent").map((b) => b.id),
    ).toEqual(["c"]);
  });

  it("returns a new array and leaves the input untouched", () => {
    const result = filterAndSortBoards(boards, all, "", "name");
    expect(result).not.toBe(boards);
    expect(boards.map((b) => b.name)).toEqual([
      "Infra 10",
      "Infra 2",
      "Talks",
      "Old board",
      "Older board",
    ]);
  });
});
