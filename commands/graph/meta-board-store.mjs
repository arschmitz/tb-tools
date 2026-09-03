import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const META_BOARD_STORE_FILE = "meta-bug-boards.json";
export const META_BOARD_STORE_VERSION = 2;
export const META_BOARD_COLORS = [
  "#2563eb",
  "#dc2626",
  "#059669",
  "#7c3aed",
  "#ea580c",
  "#0891b2",
  "#db2777",
  "#4d7c0f",
  "#9333ea",
  "#0284c7",
  "#ca8a04",
  "#0f766e",
  "#be123c",
  "#4338ca",
  "#65a30d",
  "#c2410c",
  "#0e7490",
  "#a21caf",
];

function normalizeMetaBugId(value) {
  const id = String(value || "").trim();

  if (!/^\d{4,10}$/.test(id)) {
    const error = new Error("Enter a valid Bugzilla meta bug ID.");

    error.statusCode = 400;
    throw error;
  }

  return id;
}

function normalizeReviewGroup(value, { allowEmpty = true } = {}) {
  const group = String(value || "")
    .trim()
    .replace(/^#+/, "")
    .toLowerCase();

  if (!group && allowEmpty) {
    return "";
  }

  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(group)) {
    const error = new Error(
      "Enter a Phabricator review group such as #thunderbird-front-end-reviewers.",
    );

    error.statusCode = 400;
    throw error;
  }

  return group;
}

function getStorePath(homeDirectory = os.homedir()) {
  return path.join(homeDirectory, ".tb-tools", META_BOARD_STORE_FILE);
}

function getGeneratedMetaBoardColor(index) {
  const hue = (index * 137.508) % 360;

  return `hsl(${hue}deg 68% 42%)`;
}

function getNextMetaBoardColor(existingColors) {
  for (const color of META_BOARD_COLORS) {
    if (!existingColors.has(color)) {
      return color;
    }
  }

  let index = META_BOARD_COLORS.length;
  let color = getGeneratedMetaBoardColor(index);

  while (existingColors.has(color)) {
    index++;
    color = getGeneratedMetaBoardColor(index);
  }

  return color;
}

export function normalizeMetaBoardStore(store = {}) {
  const seen = new Set();
  const boards = [];

  for (const source of Array.isArray(store?.boards) ? store.boards : []) {
    const metaBugId = String(source?.metaBugId || source?.id || "").trim();

    if (!/^\d{4,10}$/.test(metaBugId) || seen.has(metaBugId)) {
      continue;
    }

    seen.add(metaBugId);
    boards.push({
      id: metaBugId,
      metaBugId,
      createdAt: String(source.createdAt || ""),
      reviewGroup: (() => {
        try {
          return normalizeReviewGroup(source.reviewGroup);
        } catch {
          return "";
        }
      })(),
    });
  }

  const metaColors = Object.fromEntries(Object.entries(store?.metaColors || {})
    .filter(([id, color]) => (
      /^\d{4,10}$/.test(id) &&
      (META_BOARD_COLORS.includes(color) || /^hsl\([^)]*\)$/i.test(color))
    )));

  return {
    version: META_BOARD_STORE_VERSION,
    boards,
    metaColors,
  };
}

export async function readMetaBoardStore({
  homeDirectory = os.homedir(),
  read = readFile,
} = {}) {
  try {
    return normalizeMetaBoardStore(JSON.parse(await read(getStorePath(homeDirectory), "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) {
      return normalizeMetaBoardStore();
    }

    throw error;
  }
}

export async function writeMetaBoardStore({
  homeDirectory = os.homedir(),
  store,
  makeDirectory = mkdir,
  write = writeFile,
} = {}) {
  const storePath = getStorePath(homeDirectory);

  await makeDirectory(path.dirname(storePath), { recursive: true, mode: 0o700 });
  await write(
    storePath,
    `${JSON.stringify(normalizeMetaBoardStore(store), null, 2)}\n`,
    { mode: 0o600 },
  );

  return normalizeMetaBoardStore(store);
}

export async function addMetaBoard({
  metaBugId,
  homeDirectory = os.homedir(),
  readStore = readMetaBoardStore,
  writeStore = writeMetaBoardStore,
} = {}) {
  const id = normalizeMetaBugId(metaBugId);
  const store = await readStore({ homeDirectory });

  if (store.boards.some((board) => board.metaBugId === id)) {
    return store;
  }

  return writeStore({
    homeDirectory,
    store: {
      ...store,
      boards: [
        ...store.boards,
        {
          id,
          metaBugId: id,
          createdAt: new Date().toISOString(),
          reviewGroup: "",
        },
      ],
    },
  });
}

export async function setMetaBoardReviewGroup({
  boardId,
  reviewGroup,
  homeDirectory = os.homedir(),
  readStore = readMetaBoardStore,
  writeStore = writeMetaBoardStore,
} = {}) {
  const id = normalizeMetaBugId(boardId);
  const group = normalizeReviewGroup(reviewGroup);
  const store = await readStore({ homeDirectory });

  if (!store.boards.some((board) => board.id === id)) {
    const error = new Error("Unknown meta bug board.");

    error.statusCode = 404;
    throw error;
  }

  return writeStore({
    homeDirectory,
    store: {
      ...store,
      boards: store.boards.map((board) => (
        board.id === id ? { ...board, reviewGroup: group } : board
      )),
    },
  });
}

export async function removeMetaBoard({
  boardId,
  homeDirectory = os.homedir(),
  readStore = readMetaBoardStore,
  writeStore = writeMetaBoardStore,
} = {}) {
  const id = normalizeMetaBugId(boardId);
  const store = await readStore({ homeDirectory });

  return writeStore({
    homeDirectory,
    store: {
      ...store,
      boards: store.boards.filter((board) => board.id !== id),
    },
  });
}

export async function assignMetaBoardColors({
  metaBugIds,
  homeDirectory = os.homedir(),
  readStore = readMetaBoardStore,
  writeStore = writeMetaBoardStore,
} = {}) {
  const ids = Array.from(new Set((metaBugIds || [])
    .map((id) => String(id || "").trim())
    .filter((id) => /^\d{4,10}$/.test(id))));
  const store = await readStore({ homeDirectory });
  const metaColors = { ...store.metaColors };
  const existingColors = new Set(Object.values(metaColors));
  let changed = false;

  for (const id of ids) {
    if (metaColors[id]) {
      continue;
    }

    const color = getNextMetaBoardColor(existingColors);

    metaColors[id] = color;
    existingColors.add(color);
    changed = true;
  }

  const nextStore = changed
    ? await writeStore({
      homeDirectory,
      store: { ...store, metaColors },
    })
    : store;

  return Object.fromEntries(ids.map((id) => [id, nextStore.metaColors[id]]));
}
