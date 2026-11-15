// Turns a pet design into pet.json and spritesheet.png.
//
//   node render.ts <pet-folder>
//
// The folder holds design.json. Every animation frame is the design's one
// 16 by 16 grid with a different expression, offset or effect, so a pet is
// drawn once and moves the same way as every other pet.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

type Design = {
  id: string;
  displayName: string;
  description: string;
  palette: Record<string, string>;
  grid: string[];
  eyes: { row: number; left: number; right: number; skin: string };
};

type Eyes = "open" | "closed" | "down" | "happy" | "x";
type Effect = "heart" | "sweat";
type Frame = { dy?: number; eyes?: Eyes; effect?: Effect; grey?: boolean };

const GRID = 16;
const SCALE = 9;
const CELL_W = 192;
const CELL_H = 208;
const COLUMNS = 8;
const LEFT = (CELL_W - GRID * SCALE) / 2;
const TOP = CELL_H - 16 - GRID * SCALE;

// Letters every design can use without defining them.
const FIXED: Record<string, string> = { e: "#1E1A22", w: "#FFFFFF", h: "#FF4D6D", s: "#7FD3FF" };

// Two by two eye patterns. `k` is the skin around the eye.
const EYES: Record<Eyes, [string[], string[]]> = {
  open: [["we", "ee"], ["we", "ee"]],
  closed: [["kk", "ee"], ["kk", "ee"]],
  down: [["kk", "we"], ["kk", "we"]],
  happy: [["ee", "ek"], ["ee", "ke"]],
  x: [["ek", "ke"], ["ke", "ek"]],
};

const EFFECTS: Record<Effect, { row: number; col: number; art: string[] }> = {
  heart: { row: 0, col: 11, art: [".h.h.", "hhhhh", ".hhh.", "..h.."] },
  sweat: { row: 2, col: 13, art: ["s.", "ss"] },
};

// One row per pet state, in the order the app reads them.
const ROWS: { state: string; frames: Frame[] }[] = [
  { state: "resting", frames: [{}, {}, {}, { eyes: "closed" }, {}, {}] },
  { state: "working", frames: [0, -1, 0, -1, 0, -1].map((dy, i) => ({ dy, eyes: "down", effect: i > 1 ? "sweat" : undefined })) },
  { state: "replied", frames: [0, 0, -1, -1, 0, 0].map((dy) => ({ dy, eyes: "happy", effect: "heart" })) },
  {
    state: "failed",
    frames: [0, 0, 1, 1, 1, 1, 0, 0].map((dy, i) => ({ dy, grey: true, eyes: i < 4 ? "x" : "closed" })),
  },
];

function check(design: Design): void {
  const fail = (message: string) => {
    throw new Error(`design.json: ${message}`);
  };
  if (!/^[a-z0-9-]+$/.test(design.id)) fail("id must be lowercase letters, digits and hyphens");
  if (design.grid.length !== GRID) fail(`grid needs ${GRID} rows, has ${design.grid.length}`);
  design.grid.forEach((row, y) => {
    if (row.length !== GRID) fail(`grid row ${y} needs ${GRID} characters, has ${row.length}`);
    for (const letter of row) {
      if (letter !== "." && !design.palette[letter] && !FIXED[letter]) fail(`grid row ${y} uses "${letter}", which the palette doesn't define`);
    }
  });
  const { row, left, right, skin } = design.eyes;
  if (row < 0 || row > GRID - 2 || left < 0 || right > GRID - 2 || left + 1 >= right) fail("eyes must be two 2 by 2 squares inside the grid");
  if (!design.palette[skin]) fail(`eyes.skin "${skin}" isn't in the palette`);
}

function rgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

function grey([r, g, b]: [number, number, number]): [number, number, number] {
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  return [r, g, b].map((v) => Math.round(v + (lum - v) * 0.7)) as [number, number, number];
}

function frameGrid(design: Design, frame: Frame): string[][] {
  const cells = design.grid.map((row) => row.split(""));
  const { row, left, right, skin } = design.eyes;
  const [leftEye, rightEye] = EYES[frame.eyes ?? "open"];
  for (const [col, eye] of [[left, leftEye], [right, rightEye]] as const) {
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < 2; x++) cells[row + y][col + x] = eye[y][x] === "k" ? skin : eye[y][x];
    }
  }
  if (frame.effect) {
    const effect = EFFECTS[frame.effect];
    effect.art.forEach((line, y) =>
      line.split("").forEach((letter, x) => {
        if (letter !== ".") cells[effect.row + y][effect.col + x] = letter;
      }),
    );
  }
  return cells;
}

function render(design: Design): Buffer {
  const width = CELL_W * COLUMNS;
  const height = CELL_H * ROWS.length;
  const pixels = Buffer.alloc(width * height * 4);
  const colours = { ...FIXED, ...design.palette };
  ROWS.forEach(({ frames }, rowIndex) => {
    frames.forEach((frame, colIndex) => {
      const cells = frameGrid(design, frame);
      cells.forEach((line, gy) =>
        line.forEach((letter, gx) => {
          if (letter === ".") return;
          const colour = frame.grey ? grey(rgb(colours[letter])) : rgb(colours[letter]);
          const x0 = colIndex * CELL_W + LEFT + gx * SCALE;
          const y0 = rowIndex * CELL_H + TOP + (gy + (frame.dy ?? 0)) * SCALE;
          for (let y = Math.max(y0, rowIndex * CELL_H); y < Math.min(y0 + SCALE, (rowIndex + 1) * CELL_H); y++) {
            for (let x = x0; x < x0 + SCALE; x++) {
              const at = (y * width + x) * 4;
              pixels[at] = colour[0];
              pixels[at + 1] = colour[1];
              pixels[at + 2] = colour[2];
              pixels[at + 3] = 255;
            }
          }
        }),
      );
    });
  });
  return png(width, height, pixels);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

function png(width: number, height: number, rgba: Buffer): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) rgba.copy(rows, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const folder = process.argv[2];
if (!folder) {
  console.error("usage: node render.ts <pet-folder>");
  process.exit(1);
}
const design: Design = JSON.parse(readFileSync(join(folder, "design.json"), "utf8"));
check(design);
writeFileSync(join(folder, "spritesheet.png"), render(design));
const manifest = { id: design.id, displayName: design.displayName, description: design.description, spritesheetPath: "spritesheet.png" };
writeFileSync(join(folder, "pet.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`${design.displayName}: ${join(folder, "spritesheet.png")}`);
