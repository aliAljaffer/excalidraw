import throttle from "lodash.throttle";

import type { OrderedExcalidrawElement } from "@excalidraw/element/types";

import { loadBoard, saveBoard } from "./boards";

/**
 * A board session is a private document open in the editor: the scene comes
 * from /api/boards, not from a room link, and edits autosave back to it while
 * nobody is collaborating.
 */
type BoardSession = {
  id: string;
  roomKey: string;
  revision: number;
  dirty: boolean;
};

let session: BoardSession | null = null;

export const startBoardSession = (args: {
  id: string;
  roomKey: string;
  revision: number;
}) => {
  session = { ...args, dirty: false };
};

export const getBoardSession = () => session;

export const endBoardSession = () => {
  session = null;
};

export const saveBoardNow = async (
  elements: readonly OrderedExcalidrawElement[],
) => {
  if (!session) {
    return;
  }
  const current = session;
  try {
    const revision = await saveBoard({
      id: current.id,
      roomKey: current.roomKey,
      revision: current.revision,
      elements,
    });
    if (session === current) {
      current.revision = revision;
      current.dirty = false;
    }
  } catch (error: any) {
    if (error?.message !== "revision") {
      throw error;
    }
    // another tab or device wrote first: take its revision, keep our scene
    const fresh = await loadBoard(current.id);
    if (!fresh || session !== current) {
      return;
    }
    current.revision = fresh.revision;
    await saveBoard({
      id: current.id,
      roomKey: current.roomKey,
      revision: fresh.revision,
      elements,
    });
    current.dirty = false;
  }
};

export const queueBoardSave = throttle(
  (elements: readonly OrderedExcalidrawElement[]) => {
    if (!session) {
      return;
    }
    session.dirty = true;
    void saveBoardNow(elements).catch((error) => {
      console.error("board autosave failed", error);
    });
  },
  8000,
);
