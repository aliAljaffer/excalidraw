import { MIME_TYPES } from "@excalidraw/common";
import { decompressData } from "@excalidraw/excalidraw/data/encode";
import {
  decryptData,
  encryptData,
} from "@excalidraw/excalidraw/data/encryption";
import { restoreElements } from "@excalidraw/excalidraw/data/restore";

import { getSceneVersion } from "@excalidraw/element";

import type { ExcalidrawElement, FileId } from "@excalidraw/element/types";
import type { BinaryFileData, DataURL } from "@excalidraw/excalidraw/types";

import { getSyncableElements } from ".";

/**
 * Private boards. Every call lands on /api/boards, which only oauth2-proxy can
 * reach, so the proxy session is the whole authorization story: no room key in
 * a URL, no live session, no write token.
 */
const BOARDS_URL: string = import.meta.env.VITE_APP_BOARDS_URL;

export type BoardSummary = {
  id: string;
  name: string;
  folderId: string;
  updatedAt: string;
  hasPreview: boolean;
};

export type FolderSummary = {
  id: string;
  name: string;
};

export type BoardScene = {
  ciphertext: string;
  iv: string;
  revision: number;
  sceneVersion: number;
  roomKey: string;
};

export type BoardGalleryData = {
  folders: FolderSummary[];
  boards: BoardSummary[];
};

export const BOARD_PATH = /^\/b\/([A-Za-z0-9_-]{1,64})$/;

export const boardPreviewURL = (board: { id: string; updatedAt: string }) =>
  `${BOARDS_URL}/${encodeURIComponent(board.id)}/preview?v=${encodeURIComponent(
    board.updatedAt,
  )}`;

export const getBoardIdFromPath = () => {
  const match = window.location.pathname.match(BOARD_PATH);
  return match ? match[1] : null;
};

const boardURL = (path = "", fileId?: FileId) =>
  `${BOARDS_URL}${path ? `/${path}` : ""}${
    fileId ? `/files/${encodeURIComponent(fileId)}` : ""
  }`;

const parse = async <T>(response: Response): Promise<T> => {
  if (!response.ok) {
    throw new Error(
      response.status === 401
        ? "sign in to reach your boards"
        : `the gallery answered ${response.status}`,
    );
  }
  return (await response.json()) as T;
};

const send = (method: string, path: string, body?: unknown) =>
  fetch(boardURL(path), {
    method,
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });

export const fetchGallery = async () =>
  parse<BoardGalleryData>(await send("GET", ""));

export const createBoard = async (input: {
  name?: string;
  folderId?: string;
}) => parse<BoardSummary>(await send("POST", "", input));

export const updateBoard = async (
  id: string,
  input: { name?: string; folderId?: string },
) => parse<BoardSummary>(await send("PATCH", encodeURIComponent(id), input));

export const deleteBoard = async (id: string) => {
  const response = await send("DELETE", encodeURIComponent(id));
  if (!response.ok) {
    throw new Error(`could not delete the board: ${response.status}`);
  }
};

export const createFolder = async (name: string) =>
  parse<FolderSummary>(await send("POST", "folders", { name }));

export const renameFolder = async (id: string, name: string) =>
  parse<FolderSummary>(
    await send("PATCH", `folders/${encodeURIComponent(id)}`, { name }),
  );

export const deleteFolder = async (id: string) => {
  const response = await send("DELETE", `folders/${encodeURIComponent(id)}`);
  if (!response.ok) {
    throw new Error(`could not delete the folder: ${response.status}`);
  }
};

// --- scene ---

const base64ToBytes = (value: string) => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

const bytesToBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
};

export type OpenBoard = {
  id: string;
  name: string;
  roomKey: string;
  revision: number;
  elements: readonly ExcalidrawElement[];
};

export const loadBoard = async (id: string): Promise<OpenBoard | null> => {
  const scene = await parse<BoardScene>(
    await send("GET", `${encodeURIComponent(id)}/scene`),
  );
  const elements = scene.ciphertext
    ? getSyncableElements(
        restoreElements(
          JSON.parse(
            new TextDecoder("utf-8").decode(
              await decryptData(
                base64ToBytes(scene.iv),
                base64ToBytes(scene.ciphertext),
                scene.roomKey,
              ),
            ),
          ),
          null,
          { deleteInvisibleElements: true },
        ),
      )
    : [];

  return {
    id,
    name: "",
    roomKey: scene.roomKey,
    revision: scene.revision,
    elements,
  };
};

export const saveBoard = async ({
  id,
  roomKey,
  revision,
  elements,
}: {
  id: string;
  roomKey: string;
  revision: number;
  elements: readonly ExcalidrawElement[];
}): Promise<number> => {
  const { encryptedBuffer, iv } = await encryptData(
    roomKey,
    new TextEncoder().encode(JSON.stringify(elements)),
  );
  const response = await send("PUT", `${encodeURIComponent(id)}/scene`, {
    ciphertext: bytesToBase64(new Uint8Array(encryptedBuffer)),
    iv: bytesToBase64(iv),
    sceneVersion: getSceneVersion(elements),
    revision,
  });
  if (response.status === 409) {
    throw new Error("revision");
  }
  const body = await parse<{ revision: number }>(response);
  return body.revision;
};

export const saveBoardFiles = async ({
  id,
  files,
}: {
  id: string;
  files: { id: FileId; buffer: Uint8Array }[];
}) => {
  const savedFiles: FileId[] = [];
  const erroredFiles: FileId[] = [];

  await Promise.all(
    files.map(async ({ id: fileId, buffer }) => {
      try {
        const response = await fetch(
          boardURL(`${encodeURIComponent(id)}`, fileId),
          {
            method: "PUT",
            body: buffer as unknown as BodyInit,
          },
        );
        if (!response.ok) {
          throw new Error(`upload failed: ${response.status}`);
        }
        savedFiles.push(fileId);
      } catch (error: any) {
        console.error(error);
        erroredFiles.push(fileId);
      }
    }),
  );

  return { savedFiles, erroredFiles };
};

export const loadBoardFiles = async (
  id: string,
  roomKey: string,
  fileIds: readonly FileId[],
) => {
  const loadedFiles: BinaryFileData[] = [];
  const erroredFiles = new Map<FileId, true>();

  await Promise.all(
    [...new Set(fileIds)].map(async (fileId) => {
      try {
        const response = await fetch(
          boardURL(`${encodeURIComponent(id)}`, fileId),
          { cache: "force-cache" },
        );
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
          id: fileId,
          dataURL: new TextDecoder().decode(data) as DataURL,
          created: metadata.created || Date.now(),
          lastRetrieved: metadata.created || Date.now(),
        });
      } catch (error: any) {
        console.error(error);
        erroredFiles.set(fileId, true);
      }
    }),
  );

  return { loadedFiles, erroredFiles };
};

export const saveBoardPreview = async (id: string, preview: Blob) => {
  const response = await fetch(
    `${BOARDS_URL}/${encodeURIComponent(id)}/preview`,
    { method: "PUT", body: preview },
  );
  if (!response.ok) {
    throw new Error(`preview upload failed: ${response.status}`);
  }
};
