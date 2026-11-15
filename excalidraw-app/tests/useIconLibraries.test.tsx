import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LibraryItems } from "@excalidraw/excalidraw/types";

import { useIconLibraries } from "../useIconLibraries";

// the hook stays out of the way in the test env, so opt back in
vi.mock("@excalidraw/common", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@excalidraw/common")>()),
  isTestEnv: () => false,
}));

const fileId = "file1";
const library = {
  type: "excalidrawlib",
  version: 2,
  source: "test",
  libraryItems: [
    {
      id: "iconlib_aws1",
      status: "published",
      created: 0,
      name: "AWS EC2",
      elements: [
        {
          id: "element1",
          type: "image",
          x: 0,
          y: 0,
          width: 96,
          height: 96,
          angle: 0,
          strokeColor: "transparent",
          backgroundColor: "transparent",
          fillStyle: "solid",
          strokeWidth: 2,
          strokeStyle: "solid",
          roughness: 1,
          opacity: 100,
          groupIds: [],
          frameId: null,
          index: "a0",
          roundness: null,
          seed: 1,
          version: 1,
          versionNonce: 1,
          isDeleted: false,
          boundElements: null,
          updated: 0,
          link: null,
          locked: false,
          fileId,
          status: "saved",
          scale: [1, 1],
          crop: null,
        },
      ],
    },
  ],
  files: {
    [fileId]: {
      id: fileId,
      mimeType: "image/svg+xml",
      dataURL: "data:image/svg+xml;base64,PHN2Zy8+",
      created: 0,
    },
  },
};

const manifest = {
  version: "manifest-2",
  libraries: [{ name: "AWS", file: "aws.excalidrawlib" }],
};

// a jsdom Blob, not the node one a real Response hands out: the library
// parser reads through FileReader
const stubFetch = (responses: Record<string, unknown>) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const body = responses[url];
      if (!body) {
        return { ok: false, status: 404 };
      }
      const text = JSON.stringify(body);
      return {
        ok: true,
        status: 200,
        json: async () => JSON.parse(text),
        blob: async () => new Blob([text], { type: "application/json" }),
      };
    }),
  );

const makeAPI = () => {
  const api = {
    updateLibrary: vi.fn(async ({ libraryItems }: any) => libraryItems),
  };
  return api;
};

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("useIconLibraries", () => {
  it("merges the bundled icons and replaces the previous icon items", async () => {
    stubFetch({
      "/libraries/libraries.json": manifest,
      "/libraries/aws.excalidrawlib": library,
    });
    const api = makeAPI();

    renderHook(() => useIconLibraries(api as any));

    await waitFor(() => expect(api.updateLibrary).toHaveBeenCalled());

    const current: LibraryItems = [
      { id: "iconlib_stale", status: "published", created: 0, elements: [] },
      { id: "user-item", status: "unpublished", created: 0, elements: [] },
    ];
    const next: LibraryItems =
      await api.updateLibrary.mock.calls[0][0].libraryItems(current);

    expect(next.map((item) => item.id)).toEqual(["iconlib_aws1", "user-item"]);
    expect(next[0].files?.[fileId]).toBeDefined();
    expect(localStorage.getItem("excalidraw-icon-libraries")).toBe(
      manifest.version,
    );
  });

  it("does nothing when the manifest was already seeded", async () => {
    localStorage.setItem("excalidraw-icon-libraries", manifest.version);
    stubFetch({
      "/libraries/libraries.json": manifest,
      "/libraries/aws.excalidrawlib": library,
    });
    const api = makeAPI();

    renderHook(() => useIconLibraries(api as any));

    await waitFor(() => expect(api.updateLibrary).not.toHaveBeenCalled());
  });

  it("gives up quietly when the manifest is not served", async () => {
    stubFetch({});
    const api = makeAPI();

    renderHook(() => useIconLibraries(api as any));

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(api.updateLibrary).not.toHaveBeenCalled();
  });
});
