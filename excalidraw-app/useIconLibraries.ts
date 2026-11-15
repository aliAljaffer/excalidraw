import { useEffect } from "react";

import { isTestEnv } from "@excalidraw/common";

import { loadLibraryFromBlob } from "@excalidraw/excalidraw/data/blob";

import type {
  ExcalidrawImperativeAPI,
  LibraryItems,
} from "@excalidraw/excalidraw/types";

/** written by scripts/build-icon-libraries.mjs and copied into the image */
export const ICON_LIBRARIES_DIR = "public/libraries";

const SEEDED_VERSION_KEY = "excalidraw-icon-libraries";
const ITEM_ID_PREFIX = "iconlib_";

type IconLibrariesManifest = {
  /** changes whenever any bundled library changes */
  version: string;
  libraries: { name: string; file: string }[];
};

const loadIconItems = async (manifest: IconLibrariesManifest) => {
  const libraries = await Promise.all(
    manifest.libraries.map(async ({ file }) => {
      const response = await fetch(`/libraries/${file}`);
      if (!response.ok) {
        throw new Error(`${response.status} loading ${file}`);
      }
      return loadLibraryFromBlob(await response.blob(), "published");
    }),
  );
  return libraries.flat();
};

/**
 * Merges the bundled icon libraries into the library panel, once per
 * manifest version. Re-seeding replaces the previous icon items instead of
 * duplicating them, which needs the deterministic ids the build emits.
 */
export const useIconLibraries = (
  excalidrawAPI: ExcalidrawImperativeAPI | null,
) => {
  useEffect(() => {
    // share and collaboration views are public: no login, no icons to add
    if (
      !excalidrawAPI ||
      isTestEnv() ||
      window.location.pathname.startsWith("/s/")
    ) {
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        const response = await fetch("/libraries/libraries.json");
        if (!response.ok) {
          // no icons in this image, or the request never reached us (the
          // path sits behind the login)
          return;
        }
        const manifest: IconLibrariesManifest = await response.json();
        if (localStorage.getItem(SEEDED_VERSION_KEY) === manifest.version) {
          return;
        }

        const items = await loadIconItems(manifest);
        if (cancelled || !items.length) {
          return;
        }

        await excalidrawAPI.updateLibrary({
          libraryItems: (current: LibraryItems) => [
            ...items,
            ...current.filter((item) => !item.id.startsWith(ITEM_ID_PREFIX)),
          ],
        });
        localStorage.setItem(SEEDED_VERSION_KEY, manifest.version);
      } catch (error: any) {
        console.warn(`Icon libraries unavailable: ${error?.message}`);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [excalidrawAPI]);
};
