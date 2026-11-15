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
  lastElements: readonly OrderedExcalidrawElement[];
};

let session: BoardSession | null = null;
let inFlight: Promise<void> | null = null;

/**
 * Set by the editor: renders the scene to a PNG for the gallery. Kept as a
 * callback so this module never imports the editor.
 */
let previewRenderer: (() => Promise<Blob | null>) | null = null;
let previewTask: Promise<void> | null = null;

export const setPreviewRenderer = (
  renderer: (() => Promise<Blob | null>) | null,
) => {
  previewRenderer = renderer;
};

const refreshPreview = (): Promise<void> => {
  if (!session || !previewRenderer || document.hidden) {
    return Promise.resolve();
  }
  if (previewTask) {
    return previewTask;
  }
  const current = session;
  previewTask = (async () => {
    try {
      const preview = await previewRenderer!();
      if (preview) {
        await saveBoardPreview(current.id, preview);
      }
    } catch (error) {
      console.error("board preview failed", error);
    } finally {
      previewTask = null;
    }
  })();
  return previewTask;
};

export const startBoardSession = (args: {
  id: string;
  roomKey: string;
  revision: number;
  elements: readonly OrderedExcalidrawElement[];
}) => {
  session = {
    id: args.id,
    roomKey: args.roomKey,
    revision: args.revision,
    dirty: false,
    lastElements: args.elements,
  };
  inFlight = null;
};

export const getBoardSession = () => session;

export const endBoardSession = () => {
  session = null;
  inFlight = null;
};

const write = async (elements: readonly OrderedExcalidrawElement[]) => {
  const current = session;
  if (!current) {
    return;
  }
  try {
    const revision = await saveBoard({
      id: current.id,
      roomKey: current.roomKey,
      revision: current.revision,
      elements,
    });
    current.revision = revision;
    current.dirty = false;
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

/**
 * Serialized so two writes never race on the same revision. `keepalive` is for
 * the unload path: the browser finishes the request after the page is gone,
 * which is what makes a quick switch between boards safe.
 */
export const saveBoardNow = async (
  elements?: readonly OrderedExcalidrawElement[],
  { keepalive = false }: { keepalive?: boolean } = {},
) => {
  if (!session) {
    return;
  }
  const target = elements ?? session.lastElements;

  if (inFlight) {
    await inFlight.catch(() => {});
  }
  if (!session) {
    return;
  }

  const run = (async () => {
    if (keepalive) {
      await saveBoard({
        id: session!.id,
        roomKey: session!.roomKey,
        revision: session!.revision,
        elements: target,
        keepalive: true,
      }).catch(() => {});
      return;
    }
    await write(target);
  })();

  inFlight = run;
  try {
    await run;
  } finally {
    if (inFlight === run) {
      inFlight = null;
    }
  }

  if (!keepalive) {
    void refreshPreview();
  }
};

const saveThrottled = throttle(
  () => {
    void saveBoardNow().catch((error) => {
      console.error("board autosave failed", error);
    });
  },
  4000,
  { leading: true, trailing: true },
);

export const queueBoardSave = (
  elements: readonly OrderedExcalidrawElement[],
) => {
  if (!session) {
    return;
  }
  // always keep the newest scene, even while the throttle is holding a write
  session.lastElements = elements;
  session.dirty = true;
  saveThrottled();
};

/**
 * Called before leaving a board, so switching boards never loses the last
 * edits. Falls back to a keepalive write when the page is already unloading.
 */
export const flushBoard = async ({ keepalive = false } = {}) => {
  if (!session) {
    return;
  }
  saveThrottled.cancel();
  await saveBoardNow(undefined, { keepalive });
  if (!keepalive) {
    // the gallery shows this thumbnail right after, so do not leave it behind
    await refreshPreview();
  }
};
