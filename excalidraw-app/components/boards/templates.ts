import {
  newArrowElement,
  newElement,
  newTextElement,
} from "@excalidraw/element";
import { pointFrom } from "@excalidraw/math";

import type { ExcalidrawElement } from "@excalidraw/element/types";
import type { LocalPoint } from "@excalidraw/math";

export const BOARD_TEMPLATES = [
  {
    id: "kanban",
    name: "Kanban",
    description: "Three columns to move work across.",
  },
  {
    id: "system",
    name: "System diagram",
    description: "Three services feeding a database.",
  },
  {
    id: "mindmap",
    name: "Mind map",
    description: "A central idea and four branches.",
  },
] as const;

export type BoardTemplateId = typeof BOARD_TEMPLATES[number]["id"];

const INK = "#1e1e1e";
const LINE = "#868e96";
const ACCENT = "#6965db";

const box = (x: number, y: number, width: number, height: number) =>
  newElement({
    type: "rectangle",
    x,
    y,
    width,
    height,
    strokeColor: LINE,
    backgroundColor: "transparent",
    strokeWidth: 1,
    roughness: 1,
    roundness: { type: 3 },
  });

const label = (x: number, y: number, text: string, fontSize = 20) =>
  newTextElement({ x, y, text, fontSize, strokeColor: INK });

const arrow = (
  x: number,
  y: number,
  width: number,
  height: number,
  dx: number,
  dy: number,
) =>
  newArrowElement({
    type: "arrow",
    x,
    y,
    width,
    height,
    points: [pointFrom<LocalPoint>(0, 0), pointFrom<LocalPoint>(dx, dy)],
    strokeColor: ACCENT,
    strokeWidth: 2,
    endArrowhead: "arrow",
  });

const title = (text: string) => label(0, -64, text, 30);

const kanban = (): ExcalidrawElement[] => {
  const elements: ExcalidrawElement[] = [title("Kanban")];
  ["To do", "Doing", "Done"].forEach((name, index) => {
    const x = index * 340;
    elements.push(box(x, 0, 300, 420));
    elements.push(label(x + 20, 20, name, 24));
  });
  return elements;
};

const system = (): ExcalidrawElement[] => {
  const elements: ExcalidrawElement[] = [title("System diagram")];
  const boxes = [
    { x: 0, y: 0, name: "Client" },
    { x: 300, y: 0, name: "Gateway" },
    { x: 600, y: 0, name: "Service" },
    { x: 300, y: 200, name: "Database" },
  ];
  for (const item of boxes) {
    elements.push(box(item.x, item.y, 200, 100));
    elements.push(label(item.x + 20, item.y + 20, item.name));
  }
  elements.push(arrow(200, 50, 100, 0, 100, 0));
  elements.push(arrow(500, 50, 100, 0, 100, 0));
  elements.push(arrow(400, 100, 0, 100, 0, 100));
  return elements;
};

const mindmap = (): ExcalidrawElement[] => {
  const elements: ExcalidrawElement[] = [title("Mind map")];
  elements.push(box(300, 140, 200, 100));
  elements.push(label(320, 160, "Idea", 24));
  const branches = [
    { x: 0, y: 0, name: "Why" },
    { x: 620, y: 0, name: "How" },
    { x: 0, y: 320, name: "Who" },
    { x: 620, y: 320, name: "When" },
  ];
  for (const item of branches) {
    elements.push(box(item.x, item.y, 180, 70));
    elements.push(label(item.x + 20, item.y + 20, item.name));
  }
  elements.push(arrow(180, 70, 120, 120, 120, 120));
  elements.push(arrow(600, 70, 100, 120, -100, 120));
  elements.push(arrow(180, 320, 120, 80, 120, -80));
  elements.push(arrow(600, 320, 100, 80, -100, -80));
  return elements;
};

export const buildTemplate = (
  id: BoardTemplateId,
): readonly ExcalidrawElement[] => {
  switch (id) {
    case "kanban":
      return kanban();
    case "system":
      return system();
    case "mindmap":
      return mindmap();
  }
};
