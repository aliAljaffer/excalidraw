import { MIME_TYPES, toBrandedType } from "@excalidraw/common";
import { reconcileElements } from "@excalidraw/excalidraw";
import { decompressData } from "@excalidraw/excalidraw/data/encode";
import {
  decryptData,
  encryptData,
} from "@excalidraw/excalidraw/data/encryption";
import { restoreElements } from "@excalidraw/excalidraw/data/restore";
import { getSceneVersion } from "@excalidraw/element";

import type { RemoteExcalidrawElement } from "@excalidraw/excalidraw/data/reconcile";
import type {
  ExcalidrawElement,
  FileId,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";
import type {
  AppState,
  BinaryFileData,
  DataURL,
} from "@excalidraw/excalidraw/types";

import { getSyncableElements } from ".";

import type { SyncableExcalidrawElement } from ".";
import type Portal from "../collab/Portal";

/**
 * Room persistence replaces the upstream Firebase adapter. The browser keeps
 * the room key; the server stores one encrypted scene per room, a revision, and
 * the hash of the write token.
 */
const ROOMS_URL: string = import.meta.env.VITE_APP_ROOMS_URL;

type RoomState = { revision: number; sceneVersion: number };

// One entry per room id: the revision we last saw and the scene version we last
// stored. Kept out of the socket so a reconnect does not lose it.
const roomStates = new Map<string, RoomState>();

type StoredRoom = {
  ciphertext: string;
  iv: string;
  revision: number;
  sceneVersion: number;
};

const bytesToBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
};

const base64ToBytes = (value: string) => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

/**
 * Anyone holding the room link can write, nobody else. The server stores only
 * sha256 of this value.
 */
export const roomWriteToken = async (roomKey: string) => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(roomKey),
  );
  return bytesToBase64(new Uint8Array(digest))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};

const roomURL = (roomId: string, fileId?: FileId) =>
  `${ROOMS_URL}${encodeURIComponent(roomId)}${
    fileId ? `/files/${encodeURIComponent(fileId)}` : ""
  }`;

const readRoom = async (roomId: string): Promise<StoredRoom | null> => {
  const response = await fetch(roomURL(roomId), { cache: "no-store" });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`could not read the room: ${response.status}`);
  }
  return (await response.json()) as StoredRoom;
};

const decryptElements = async (
  room: StoredRoom,
  roomKey: string,
): Promise<readonly ExcalidrawElement[]> => {
  const decrypted = await decryptData(
    base64ToBytes(room.iv),
    base64ToBytes(room.ciphertext),
    roomKey,
  );
  return JSON.parse(new TextDecoder("utf-8").decode(new Uint8Array(decrypted)));
};

export const loadRoomScene = async (
  roomId: string,
  roomKey: string,
): Promise<readonly SyncableExcalidrawElement[] | null> => {
  const room = await readRoom(roomId);
  if (!room || !room.ciphertext) {
    roomStates.delete(roomId);
    return null;
  }
  const elements = getSyncableElements(
    restoreElements(await decryptElements(room, roomKey), null, {
      deleteInvisibleElements: true,
    }),
  );
  roomStates.set(roomId, {
    revision: room.revision,
    sceneVersion: room.sceneVersion,
  });
  return elements;
};

const putRoom = async ({
  roomId,
  roomKey,
  elements,
  revision,
}: {
  roomId: string;
  roomKey: string;
  elements: readonly SyncableExcalidrawElement[];
  revision: number;
}): Promise<{ revision: number; status: number }> => {
  const sceneVersion = getSceneVersion(elements);
  const encoded = new TextEncoder().encode(JSON.stringify(elements));
  const { encryptedBuffer, iv } = await encryptData(roomKey, encoded);

  const response = await fetch(roomURL(roomId), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ciphertext: bytesToBase64(new Uint8Array(encryptedBuffer)),
      iv: bytesToBase64(iv),
      sceneVersion,
      revision,
      writeToken: await roomWriteToken(roomKey),
    }),
  });

  if (response.status === 409) {
    return { revision: -1, status: 409 };
  }
  if (!response.ok) {
    throw new Error(`could not save the room: ${response.status}`);
  }
  const body = (await response.json()) as { revision: number };
  roomStates.set(roomId, { revision: body.revision, sceneVersion });
  return { revision: body.revision, status: response.status };
};

/**
 * Writes the scene, reconciling once if another participant got there first.
 * Returns the elements now in the room so the caller can apply them, or null
 * when nothing had to change.
 */
export const saveRoomScene = async (
  portal: Portal,
  elements: readonly SyncableExcalidrawElement[],
  appState: AppState,
): Promise<readonly RemoteExcalidrawElement[] | null> => {
  const { roomId, roomKey, socket } = portal;
  if (!roomId || !roomKey || !socket) {
    return null;
  }
  if (isRoomSaved(roomId, elements)) {
    return null;
  }

  const state = roomStates.get(roomId);
  let revision = state?.revision ?? 0;
  let toStore = elements;

  let result = await putRoom({ roomId, roomKey, elements: toStore, revision });
  if (result.status === 409) {
    const remote = await loadRoomScene(roomId, roomKey);
    revision = roomStates.get(roomId)?.revision ?? 0;
    toStore = getSyncableElements(
      reconcileElements(
        elements,
        (remote ??
          []) as readonly OrderedExcalidrawElement[] as readonly RemoteExcalidrawElement[],
        appState,
      ),
    );
    result = await putRoom({ roomId, roomKey, elements: toStore, revision });
    if (result.status === 409) {
      throw new Error("the room is being written too fast, try again");
    }
    return toBrandedType<RemoteExcalidrawElement[]>([...toStore]);
  }
  return null;
};

export const isRoomSaved = (
  roomId: string | null,
  elements: readonly ExcalidrawElement[],
) => {
  if (!roomId) {
    return true;
  }
  const state = roomStates.get(roomId);
  return state?.sceneVersion === getSceneVersion(elements);
};

export const saveRoomFiles = async ({
  roomId,
  roomKey,
  files,
}: {
  roomId: string;
  roomKey: string;
  files: { id: FileId; buffer: Uint8Array }[];
}) => {
  const token = await roomWriteToken(roomKey);
  const savedFiles: FileId[] = [];
  const erroredFiles: FileId[] = [];

  await Promise.all(
    files.map(async ({ id, buffer }) => {
      try {
        const response = await fetch(roomURL(roomId, id), {
          method: "PUT",
          headers: { "X-Room-Token": token },
          body: buffer as unknown as BodyInit,
        });
        if (!response.ok) {
          throw new Error(`upload failed: ${response.status}`);
        }
        savedFiles.push(id);
      } catch (error: any) {
        console.error(error);
        erroredFiles.push(id);
      }
    }),
  );

  return { savedFiles, erroredFiles };
};

export const loadRoomFiles = async (
  roomId: string,
  roomKey: string,
  filesIds: readonly FileId[],
) => {
  const loadedFiles: BinaryFileData[] = [];
  const erroredFiles = new Map<FileId, true>();

  await Promise.all(
    [...new Set(filesIds)].map(async (id) => {
      try {
        const response = await fetch(roomURL(roomId, id), {
          cache: "force-cache",
        });
        if (!response.ok) {
          throw new Error(`download failed: ${response.status}`);
        }
        const { data, metadata } = await decompressData<{
          mimeType?: BinaryFileData["mimeType"];
          created?: number;
        }>(new Uint8Array(await response.arrayBuffer()), {
          decryptionKey: roomKey,
        });
        loadedFiles.push({
          mimeType: metadata.mimeType || MIME_TYPES.binary,
          id,
          dataURL: new TextDecoder().decode(data) as DataURL,
          created: metadata.created || Date.now(),
          lastRetrieved: metadata.created || Date.now(),
        });
      } catch (error: any) {
        erroredFiles.set(id, true);
        console.error(error);
      }
    }),
  );

  return { loadedFiles, erroredFiles };
};
