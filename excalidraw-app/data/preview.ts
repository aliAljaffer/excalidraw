import { exportScene } from "@excalidraw/excalidraw/scene/export";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

/**
 * A small PNG of the board for the gallery. Rendered from the same scene the
 * editor shows, then scaled to fit the card so the thumbnail stays cheap to
 * load and never distorts the drawing.
 */
const PREVIEW_WIDTH = 480;
const PREVIEW_HEIGHT = 300;

export const renderBoardPreview = async (
  excalidrawAPI: ExcalidrawImperativeAPI,
): Promise<Blob | null> => {
  const elements = excalidrawAPI
    .getSceneElements()
    .filter((el) => !el.isDeleted);
  if (!elements.length) {
    return null;
  }

  const source = await exportScene({
    type: "png",
    data: {
      elements,
      appState: excalidrawAPI.getAppState(),
      files: excalidrawAPI.getFiles(),
    },
    config: {
      canvasBackgroundColor: "#ffffff",
    },
  });

  const bitmap = await createImageBitmap(source);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = PREVIEW_WIDTH;
    canvas.height = PREVIEW_HEIGHT;
    const context = canvas.getContext("2d");
    if (!context) {
      return null;
    }
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, PREVIEW_WIDTH, PREVIEW_HEIGHT);

    const scale = Math.min(
      PREVIEW_WIDTH / bitmap.width,
      PREVIEW_HEIGHT / bitmap.height,
    );
    const width = bitmap.width * scale;
    const height = bitmap.height * scale;
    context.drawImage(
      bitmap,
      (PREVIEW_WIDTH - width) / 2,
      (PREVIEW_HEIGHT - height) / 2,
      width,
      height,
    );

    return await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
  } finally {
    bitmap.close();
  }
};
