import { MIME_TYPES } from "@excalidraw/common";
import { decompressData } from "@excalidraw/excalidraw/data/encode";

import type { FileId } from "@excalidraw/element/types";
import type {
  BinaryFileData,
  BinaryFileMetadata,
  DataURL,
} from "@excalidraw/excalidraw/types";

const BACKEND_V2_GET = import.meta.env.VITE_APP_BACKEND_V2_GET_URL;
const BACKEND_V2_POST = import.meta.env.VITE_APP_BACKEND_V2_POST_URL;

/**
 * Share-link images are stored next to the scene in our own backend instead of
 * Firebase Storage, so a self-hosted deployment needs no Google project.
 */
export const saveShareLinkFiles = async (
  sceneId: string,
  files: { id: FileId; buffer: Uint8Array }[],
) => {
  const savedFiles: FileId[] = [];
  const erroredFiles: FileId[] = [];

  await Promise.all(
    files.map(async ({ id, buffer }) => {
      try {
        const response = await fetch(
          `${BACKEND_V2_POST}/${sceneId}/files/${id}`,
          {
            method: "PUT",
            // the DOM typings only accept ArrayBuffer-backed views as BodyInit
            body: buffer as unknown as BodyInit,
          },
        );
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

export const loadShareLinkFiles = async (
  sceneId: string,
  decryptionKey: string,
  filesIds: readonly FileId[],
) => {
  const loadedFiles: BinaryFileData[] = [];
  const erroredFiles = new Map<FileId, true>();

  await Promise.all(
    [...new Set(filesIds)].map(async (id) => {
      try {
        const response = await fetch(`${BACKEND_V2_GET}${sceneId}/files/${id}`);
        if (!response.ok) {
          throw new Error(`download failed: ${response.status}`);
        }
        const arrayBuffer = await response.arrayBuffer();

        const { data, metadata } = await decompressData<BinaryFileMetadata>(
          new Uint8Array(arrayBuffer),
          { decryptionKey },
        );

        const dataURL = new TextDecoder().decode(data) as DataURL;

        loadedFiles.push({
          mimeType: metadata.mimeType || MIME_TYPES.binary,
          id,
          dataURL,
          created: metadata?.created || Date.now(),
          lastRetrieved: metadata?.created || Date.now(),
        });
      } catch (error: any) {
        erroredFiles.set(id, true);
        console.error(error);
      }
    }),
  );

  return { loadedFiles, erroredFiles };
};
