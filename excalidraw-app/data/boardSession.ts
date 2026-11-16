import throttle from "lodash.throttle";

import { getSceneVersion } from "@excalidraw/element";

import type { OrderedExcalidrawElement } from "@excalidraw/element/types";

import { loadBoard, saveBoard, saveBoardPreview } from "./boards";

export type BoardSaveStatus = "saved" | "saving" | "error";

export type BoardSessionSnapshot = {
  id: string;
  name: string;
  status: BoardSaveStatus;
} | null;

/**
 * A board session is a private document open in the editor: the scene comes
 * from /api/boards, not from a room link, and edits autosave back to it while
 * nobody is collaborating.
 */
type BoardSession = {
  id: string;
  name: string;
  roomId: string;
  roomKey: string;
  revision: number;
  savedVersion: number;
  dirty: boolean;
  status: BoardSaveStatus;
  lastElements: readonly OrderedExcalidrawElement[];
};

let session: BoardSession | null = null;
let inFlight: Promise<void> | null = null;
// the editor echoes the loaded scene back through onChange; that is not an edit
let initialVersion: number | null = null;
let suppressed = 0;
let snapshot: BoardSessionSnapshot = null;
const listeners = new Set<() => void>();

const publish = () => {
  const next = session
    ? { id: session.id, name: session.name, status: session.status }
    : null;
  if (
    next?.id === snapshot?.id &&
    next?.name === snapshot?.name &&
    next?.status === snapshot?.status
  ) {
    return;
  }
  snapshot = next;
  for (const listener of listeners) {
    listener();
  }
};

export const subscribeBoardSession = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const getBoardSessionSnapshot = () => snapshot;

const setStatus = (status: BoardSaveStatus) => {
  if (session && session.status !== status) {
    session.status = status;
    publish();
  }
};

/**
 * Set by the editor: renders the scene to a PNG for the gallery. Kept as a
 * callback so this module never imports the editor.
 */
let previewRenderer: (() => Promise<Blob | null>) | null = null;
let previewTask: Promise<void> | null = null;
let previewTimer: number | null = null;
let previewedVersion = -1;

// A thumbnail is derived data. Rendering one per autosave would export the
// whole scene every few seconds, so it waits for the drawing to settle.
const PREVIEW_IDLE_MS = 30000;

export const setPreviewRenderer = (
  renderer: (() => Promise<Blob | null>) | null,
) => {
  previewRenderer = renderer;
};

const cancelPreview = () => {
  if (previewTimer !== null) {
    window.clearTimeout(previewTimer);
    previewTimer = null;
  }
};

const schedulePreview = () => {
  cancelPreview();
  previewTimer = window.setTimeout(() => {
    previewTimer = null;
    if (session && !session.dirty) {
      void refreshPreview();
    }
  }, PREVIEW_IDLE_MS);
};

const refreshPreview = (): Promise<void> => {
  if (!session || !previewRenderer || document.hidden) {
    return Promise.resolve();
  }
  if (previewTask) {
    return previewTask;
  }
  const current = session;
  const version = getSceneVersion(current.lastElements);
  if (version === previewedVersion) {
    return Promise.resolve();
  }
  previewTask = (async () => {
    try {
      const preview = await previewRenderer!();
      if (preview) {
        await saveBoardPreview(current.id, preview);
      }
      previewedVersion = version;
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
  name: string;
  roomId: string;
  roomKey: string;
  revision: number;
  elements: readonly OrderedExcalidrawElement[];
}) => {
  cancelPreview();
  saveThrottled.cancel();
  previewedVersion = -1;
  initialVersion = getSceneVersion(args.elements);
  session = {
    id: args.id,
    name: args.name,
    roomId: args.roomId,
    roomKey: args.roomKey,
    revision: args.revision,
    savedVersion: getSceneVersion(args.elements),
    dirty: false,
    status: "saved",
    lastElements: args.elements,
  };
  inFlight = null;
  publish();
};

export const getBoardSession = () => session;

/** Ignores autosaves until the returned function is called, for scene swaps. */
export const suppressBoardSave = () => {
  suppressed += 1;
  return () => {
    suppressed = Math.max(0, suppressed - 1);
  };
};

export const setBoardName = (name: string) => {
  if (!session || session.name === name) {
    return;
  }
  session.name = name;
  publish();
};

export const endBoardSession = () => {
  cancelPreview();
  saveThrottled.cancel();
  session = null;
  inFlight = null;
  initialVersion = null;
  publish();
};

const write = async (elements: readonly OrderedExcalidrawElement[]) => {
  const current = session;
  if (!current) {
    return;
  }
  setStatus("saving");
  try {
    const revision = await saveBoard({
      id: current.id,
      roomKey: current.roomKey,
      revision: current.revision,
      elements,
    });
    current.revision = revision;
    current.savedVersion = getSceneVersion(elements);
    // a change made while this request was in flight still needs a save
    current.dirty = current.lastElements !== elements;
    if (!current.dirty) {
      setStatus("saved");
    }
  } catch (error: any) {
    if (error?.message !== "revision") {
      setStatus("error");
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
    current.savedVersion = getSceneVersion(elements);
    current.dirty = current.lastElements !== elements;
    if (!current.dirty) {
      setStatus("saved");
    }
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
  if (
    !keepalive &&
    !session.dirty &&
    getSceneVersion(target) === session.savedVersion
  ) {
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
    schedulePreview();
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
  if (!session || suppressed > 0) {
    return;
  }
  if (initialVersion !== null) {
    const expected = initialVersion;
    initialVersion = null;
    if (getSceneVersion(elements) === expected) {
      session.lastElements = elements;
      return;
    }
  }
  if (!session.dirty) {
    // appState changes reuse the scene array, so this skips the version scan
    if (elements === session.lastElements) {
      return;
    }
    if (getSceneVersion(elements) === session.savedVersion) {
      // adopt the editor's array so later appState changes take the fast path
      session.lastElements = elements;
      return;
    }
  }
  // always keep the newest scene, even while the throttle is holding a write
  session.lastElements = elements;
  session.dirty = true;
  setStatus("saving");
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
  cancelPreview();
  if (session.dirty || inFlight) {
    await saveBoardNow(undefined, { keepalive });
  }
  if (!keepalive) {
    // the gallery shows this thumbnail right after, so do not leave it behind
    await refreshPreview();
  }
};
