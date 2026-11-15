#!/usr/bin/env node
/* eslint-disable no-console -- build script, its output is the report */
/**
 * Builds the icon libraries the editor merges into the library panel.
 *
 *   node scripts/build-icon-libraries.mjs [outDir] [cacheDir]
 *
 * Downloads the vendor icon sets once into the cache directory (default
 * `.icon-cache/`), then writes one `.excalidrawlib` per system plus a
 * `libraries.json` manifest into the output directory (default
 * `public/libraries/`), which the image build serves from `/libraries/`.
 *
 * Element ids are derived from the icon name, so re-seeding after a version
 * bump replaces the previous items instead of duplicating them.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { unzipSync } from "fflate";

const OUT_DIR = process.argv[2] || "public/libraries";
const CACHE_DIR = process.argv[3] || ".icon-cache";

const CONCURRENCY = 8;
const ICON_SIZE = 96;
const ITEM_ID_PREFIX = "iconlib_";

const GITHUB = "https://raw.githubusercontent.com";

const AWS_ZIP =
  "https://d1.awsstatic.com/onedam/marketing-channels/website/public/shared/architecture-icon-release/Icon-package_07312026.5846e92413caa21490223536cc97f1269e44fa92.zip";
const GCP_ZIPS = [
  "https://services.google.com/fh/files/misc/core-products-icons.zip",
  "https://services.google.com/fh/files/misc/category-icons.zip",
  "https://services.google.com/fh/files/misc/google-cloud-legacy-icons.zip",
];

const KUBERNETES_REPO = "kubernetes/community";
const ALIBABA_REPO = "mcsrainbow/alibaba-cloud-icons";
const CNCF_REPO = "cncf/artwork";

const DEVCON_ICONS_API = "https://devicons.io/api/v1/icons.json";
const DEVCON_TAGS = new Set([
  "application-server",
  "automation",
  "ci-cd",
  "cloud-native",
  "containerization",
  "containers",
  "deployment",
  "devops",
  "error-monitoring",
  "git",
  "incident-management",
  "infrastructure",
  "infrastructure-as-code",
  "kubernetes",
  "load-balancer",
  "monitoring",
  "observability",
  "orchestration",
  "proxy",
  "server",
  "serverless",
  "tracing",
  "web-server",
]);

const sha1 = (value) => createHash("sha1").update(value).digest("hex");

const cachePath = (url) => {
  const name = path.basename(new URL(url).pathname) || "index";
  return path.join(CACHE_DIR, `${sha1(url).slice(0, 8)}-${name}`);
};

const fetchCached = async (url) => {
  const file = cachePath(url);
  try {
    return await readFile(file);
  } catch {
    // vendored hosts drop connections under parallel load; a retry is cheaper
    // than failing the whole image build
    for (let attempt = 1; ; attempt++) {
      try {
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(
            `${response.status} ${response.statusText} for ${url}`,
          );
        }
        const body = Buffer.from(await response.arrayBuffer());
        await mkdir(CACHE_DIR, { recursive: true });
        await writeFile(file, body);
        return body;
      } catch (error) {
        if (attempt >= 3) {
          throw error;
        }
      }
    }
  }
};

const mapPool = async (items, fn) => {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return results;
};

const githubPaths = async (repo, branch = "main") => {
  const body = await fetchCached(
    `https://api.github.com/repos/${repo}/git/trees/${branch}?recursive=1`,
  );
  return JSON.parse(body.toString("utf8")).tree.map((node) => node.path);
};

const fetchSvg = async (url) => {
  const body = (await fetchCached(url)).toString("utf8");
  if (!body.includes("<svg")) {
    throw new Error(`not an svg: ${url}`);
  }
  return body;
};

/** strips xml prolog, comments and inter-tag whitespace, which is safe for
 * every svg element (it never touches text content) */
const cleanSvg = (svg) =>
  svg
    .replace(/<\?xml[\s\S]*?\?>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!DOCTYPE[\s\S]*?>/gi, "")
    .replace(/<metadata[\s\S]*?<\/metadata>/gi, "")
    .replace(/>\s+</g, "><")
    .trim();

const svgSize = (svg) => {
  const viewBox = /viewBox="([^"]+)"/.exec(svg)?.[1];
  if (viewBox) {
    const [, , width, height] = viewBox.split(/[\s,]+/).map(Number);
    if (width > 0 && height > 0) {
      return { width, height };
    }
  }
  const width = Number(/<svg[^>]*\swidth="([\d.]+)/.exec(svg)?.[1]);
  const height = Number(/<svg[^>]*\sheight="([\d.]+)/.exec(svg)?.[1]);
  return width > 0 && height > 0 ? { width, height } : { width: 1, height: 1 };
};

/** gives the svg an intrinsic size so img/canvas render it everywhere */
const withIntrinsicSize = (svg, width, height) => {
  if (/\swidth="[\d.]+/.test(svg.slice(0, 400))) {
    return svg;
  }
  return svg.replace(/<svg/, `<svg width="${width}" height="${height}"`);
};

const titleCase = (slug) =>
  slug
    .split(/[\s_]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");

const squash = (value) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

const dedupeByName = (icons) => {
  const seen = new Set();
  const unique = [];
  for (const icon of icons) {
    const key = squash(icon.name);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(icon);
  }
  return unique;
};

const preferColorSvg = (paths) =>
  paths.filter((file) => path.basename(file).endsWith(".svg"));

const awsIcons = async () => {
  const zip = new Uint8Array(await fetchCached(AWS_ZIP));
  const entries = Object.entries(unzipSync(zip));
  const icons = [];

  for (const [file, data] of entries) {
    if (file.includes("__MACOSX") || !file.endsWith(".svg")) {
      continue;
    }
    const base = path.basename(file, ".svg");
    if (base.includes("Dark") || file.includes("Resource-Icons")) {
      continue;
    }
    let name = base.replace(/_(16|32|48|64)$/, "");
    let prefix = "";
    if (file.includes("Architecture-Service-Icons") && !base.endsWith("_64")) {
      continue;
    }
    if (file.includes("Category-Icons")) {
      if (!base.endsWith("_64")) {
        continue;
      }
      prefix = "category ";
    }
    if (file.includes("Architecture-Group-Icons") && !base.endsWith("_32")) {
      continue;
    }
    name = name.replace(/^Arch(-Category)?_/, "").replace(/^Res_/, "");
    name = name.replace(/^(Amazon|AWS)[-_\s]+/, "").replace(/[-_]/g, " ");
    icons.push({
      name: `AWS ${prefix}${name}`,
      svg: Buffer.from(data).toString("utf8"),
    });
  }

  return icons;
};

const gcpLegacyIcons = async () => {
  const zip = new Uint8Array(await fetchCached(GCP_ZIPS[2]));
  const icons = [];
  for (const [file, data] of Object.entries(unzipSync(zip))) {
    if (file.includes("__MACOSX") || !file.endsWith(".svg")) {
      continue;
    }
    const product = file.split("/")[0];
    icons.push({
      name: `GCP ${titleCase(product)}`,
      svg: Buffer.from(data).toString("utf8"),
    });
  }
  return icons;
};

const gcpCurrentIcons = async () => {
  const icons = [];
  for (const url of GCP_ZIPS.slice(0, 2)) {
    const zip = new Uint8Array(await fetchCached(url));
    for (const [file, data] of Object.entries(unzipSync(zip))) {
      if (file.includes("__MACOSX") || !file.endsWith(".svg")) {
        continue;
      }
      const segments = file.split("/");
      const product = segments[1];
      const isCategory = segments[0].startsWith("Category");
      icons.push({
        name: `GCP ${isCategory ? "category " : ""}${titleCase(product)}`,
        svg: Buffer.from(data).toString("utf8"),
      });
    }
  }
  return icons;
};

const kubernetesIcons = async () => {
  const paths = preferColorSvg(
    (await githubPaths(KUBERNETES_REPO)).filter((file) =>
      /^icons\/svg\/(resources|control_plane_components|infrastructure_components)\/labeled\/[^/]+\.svg$/.test(
        file,
      ),
    ),
  );
  return mapPool(paths, async (file) => {
    const base = path.basename(file, ".svg");
    return {
      name: `K8s ${base.includes("-") ? base : titleCase(base)}`,
      svg: await fetchSvg(`${GITHUB}/${KUBERNETES_REPO}/main/${file}`),
    };
  });
};

const alibabaIcons = async () => {
  const paths = preferColorSvg(
    (await githubPaths(ALIBABA_REPO)).filter((file) =>
      /^2022-orange\/icons\/en\/[^/]+\/[^/]+\.svg$/.test(file),
    ),
  );
  return mapPool(paths, async (file) => {
    const base = path.basename(file, ".svg");
    return {
      name: `Alibaba Cloud ${base}`,
      svg: await fetchSvg(`${GITHUB}/${ALIBABA_REPO}/main/${encodeURI(file)}`),
    };
  });
};

const cncfIcons = async () => {
  const paths = (await githubPaths(CNCF_REPO)).filter((file) =>
    /^projects\/[^/]+\/icon\/color\/[^/]+\.svg$/.test(file),
  );
  return mapPool(paths, async (file) => {
    const project = file.split("/")[1];
    const name = project.replace(/-/g, " ");
    return {
      name: name[0].toUpperCase() + name.slice(1),
      svg: await fetchSvg(`${GITHUB}/${CNCF_REPO}/main/${file}`),
    };
  });
};

const deviconsIcons = async () => {
  const catalog = JSON.parse(
    (await fetchCached(DEVCON_ICONS_API)).toString("utf8"),
  );
  const matches = catalog.icons.filter((icon) =>
    icon.tags.some((tag) => DEVCON_TAGS.has(tag)),
  );
  return mapPool(matches, async (icon) => ({
    name: icon.name,
    svg: await fetchSvg(icon.svg),
  }));
};

const SOURCES = [
  { slug: "aws", title: "AWS", load: awsIcons },
  {
    slug: "gcp",
    title: "Google Cloud",
    load: async () => [
      ...(await gcpLegacyIcons()),
      ...(await gcpCurrentIcons()),
    ],
  },
  { slug: "kubernetes", title: "Kubernetes", load: kubernetesIcons },
  { slug: "alibaba-cloud", title: "Alibaba Cloud", load: alibabaIcons },
  {
    slug: "devops",
    title: "DevOps and platform",
    // the CNCF logos win the name clash: same project, brand colour art
    load: async () =>
      dedupeByName([...(await cncfIcons()), ...(await deviconsIcons())]),
  },
];

const buildItem = (name, rawSvg) => {
  const svg = cleanSvg(rawSvg);
  const { width, height } = svgSize(svg);
  const scaledHeight = Math.max(1, Math.round((ICON_SIZE * height) / width));
  const dataURL = `data:image/svg+xml;base64,${Buffer.from(
    withIntrinsicSize(svg, ICON_SIZE, scaledHeight),
  ).toString("base64")}`;
  const fileId = sha1(dataURL);
  const idHash = sha1(name);
  const seed = parseInt(idHash.slice(0, 8), 16);

  const element = {
    id: sha1(`element:${name}`).slice(0, 20),
    type: "image",
    x: 0,
    y: 0,
    width: ICON_SIZE,
    height: scaledHeight,
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
    seed,
    version: 1,
    versionNonce: seed,
    isDeleted: false,
    boundElements: null,
    updated: 0,
    link: null,
    locked: false,
    fileId,
    status: "saved",
    scale: [1, 1],
    crop: null,
  };

  return {
    item: {
      id: `${ITEM_ID_PREFIX}${idHash.slice(0, 16)}`,
      status: "published",
      elements: [element],
      created: 0,
      name,
    },
    file: [
      fileId,
      { id: fileId, mimeType: "image/svg+xml", dataURL, created: 0 },
    ],
  };
};

const buildLibrary = (title, icons) => {
  const items = [];
  const files = {};
  for (const icon of icons) {
    const { item, file } = buildItem(icon.name, icon.svg);
    items.push(item);
    files[file[0]] = file[1];
  }
  return {
    payload: {
      type: "excalidrawlib",
      version: 2,
      source: "excalidraw.alialjaffer.com",
      libraryItems: items,
      files,
    },
    count: items.length,
  };
};

const main = async () => {
  await mkdir(OUT_DIR, { recursive: true });

  const manifest = { version: "", libraries: [] };
  const versions = [];
  // sources later in the list lose a name clash: the official vendor set beats
  // the generic logo sets
  const seen = new Set();

  for (const source of SOURCES) {
    let icons;
    try {
      icons = await source.load();
    } catch (error) {
      console.warn(`skipping ${source.slug}: ${error.message}`);
      continue;
    }
    // item ids come from the name, so a clash would overwrite an item
    icons = icons.filter((icon) => {
      const key = squash(icon.name);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
    if (!icons.length) {
      console.warn(`skipping ${source.slug}: no icons`);
      continue;
    }

    const { payload, count } = buildLibrary(source.title, icons);
    const file = `${source.slug}.excalidrawlib`;
    const body = JSON.stringify(payload);
    await writeFile(path.join(OUT_DIR, file), body);
    manifest.libraries.push({ name: source.title, file });
    versions.push(`${file}:${sha1(body)}`);
    console.log(
      `${file.padEnd(30)} ${String(count).padStart(5)} icons ${(
        body.length / 1024
      ).toFixed(0)} KiB`,
    );
  }

  if (!manifest.libraries.length) {
    throw new Error("no icon libraries were built");
  }

  manifest.version = sha1(versions.sort().join("\n")).slice(0, 12);
  await writeFile(
    path.join(OUT_DIR, "libraries.json"),
    JSON.stringify(manifest),
  );
  console.log(`version ${manifest.version}`);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
