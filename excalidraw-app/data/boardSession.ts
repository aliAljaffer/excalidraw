import throttle from "lodash.throttle";

import type { OrderedExcalidrawElement } from "@excalidraw/element/types";

import { loadBoard, saveBoard, saveBoardPreview } from "./boards";

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

/**
 * Set by the editor: renders the scene to a PNG for the gallery. Kept as a
 * callback so this module never imports the editor.
 */
let previewRenderer: (() => Promise<Blob | null>) | null = null;
let previewQueued = false;

export const setPreviewRenderer = (
  renderer: (() => Promise<Blob | null>) | null,
) => {
  previewRenderer = renderer;
};

const refreshPreview = async () => {
  if (!session || !previewRenderer || previewQueued || document.hidden) {
    return;
  }
  previewQueued = true;
  const current = session;
  try {
    const preview = await previewRenderer();
    if (preview) {
      await saveBoardPreview(current.id, preview);
    }
  } catch (error) {
    console.error("board preview failed", error);
  } finally {
    previewQueued = false;
  }
};

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
    void refreshPreview();
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
