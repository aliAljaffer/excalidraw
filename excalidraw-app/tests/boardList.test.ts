import { describe, expect, it } from "vitest";

import { filterAndSortBoards } from "../data/boardList";

import type { BoardSummary } from "../data/boards";

const board = (
  id: string,
  name: string,
  folderId: string,
  updatedAt: string,
): BoardSummary => ({ id, name, folderId, updatedAt, hasPreview: false });

const boards = [
  board("a", "Infra 10", "f1", "2026-11-15T10:00:00Z"),
  board("b", "Infra 2", "f1", "2026-11-14T10:00:00Z"),
  board("c", "Talks", "", "2026-11-15T12:00:00Z"),
];

describe("filterAndSortBoards", () => {
  it("sorts by recent first", () => {
    expect(
      filterAndSortBoards(boards, null, "", "recent").map((b) => b.id),
    ).toEqual(["c", "a", "b"]);
  });

  it("sorts names in natural order", () => {
    expect(filterAndSortBoards(boards, null, "", "name").map((b) => b.name)) //
      .toEqual(["Infra 2", "Infra 10", "Talks"]);
  });

  it("keeps only the selected folder", () => {
    expect(
      filterAndSortBoards(boards, "f1", "", "recent").map((b) => b.id),
    ).toEqual(["a", "b"]);
    expect(
      filterAndSortBoards(boards, "", "", "recent").map((b) => b.id),
    ).toEqual(["c"]);
  });

  it("matches the query regardless of case and surrounding space", () => {
    expect(
      filterAndSortBoards(boards, null, "  TALKS ", "recent").map((b) => b.id),
    ).toEqual(["c"]);
  });

  it("returns a new array and leaves the input untouched", () => {
    const result = filterAndSortBoards(boards, null, "", "name");
    expect(result).not.toBe(boards);
    expect(boards.map((b) => b.name)).toEqual(["Infra 10", "Infra 2", "Talks"]);
  });
});
