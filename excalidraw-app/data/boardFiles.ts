import type { FileId } from "@excalidraw/element/types";
import type { BinaryFileData } from "@excalidraw/excalidraw/types";

import { FILE_UPLOAD_MAX_BYTES } from "../app_constants";

import { getBoardSession } from "./boardSession";
import { loadBoardFiles, saveBoardFiles } from "./boards";
import { encodeFilesForUpload, FileManager } from "./FileManager";
import { FileStatusStore } from "./fileStatusStore";

/**
 * Image files for a board live in its room, next to the scene. The manager is
 * bound to one board so an upload started before a switch still lands on the
 * board it came from.
 */
const createManager = (id: string, roomKey: string) =>
  new FileManager({
    onFileStatusChange: FileStatusStore.updateStatuses.bind(FileStatusStore),
    getFiles: (fileIds) => loadBoardFiles(id, roomKey, fileIds),
    saveFiles: async ({ addedFiles }) => {
      const toMap = (ids: FileId[]) => {
        const map = new Map<FileId, BinaryFileData>();
        for (const fileId of ids) {
          const data = addedFiles.get(fileId);
          if (data) {
            map.set(fileId, data);
          }
        }
        return map;
      };

      try {
        const { savedFiles, erroredFiles } = await saveBoardFiles({
          id,
          files: await encodeFilesForUpload({
            files: addedFiles,
            encryptionKey: roomKey,
            maxBytes: FILE_UPLOAD_MAX_BYTES,
          }),
        });
        return {
          savedFiles: toMap(savedFiles),
          erroredFiles: toMap(erroredFiles),
        };
      } catch (error) {
        console.error(error);
        return { savedFiles: new Map(), erroredFiles: new Map(addedFiles) };
      }
    },
  });

let manager: FileManager | null = null;
let managerBoardId: string | null = null;

export const getBoardFileManager = () => {
  const session = getBoardSession();
  if (!session) {
    return null;
  }
  if (!manager || managerBoardId !== session.id) {
    manager?.reset();
    manager = createManager(session.id, session.roomKey);
    managerBoardId = session.id;
  }
  return manager;
};

export const resetBoardFileManager = () => {
  manager?.reset();
  manager = null;
  managerBoardId = null;
};
