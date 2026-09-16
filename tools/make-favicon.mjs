// Generates web/public/favicon.ico from scratch.
//
// SVG favicons are not supported by every browser, so the icon is also shipped
// as a real multi-size ICO. Both PNG and ICO are encoded by hand here via
// node:zlib, which keeps the build free of image-library dependencies.
//
//   node tools/make-favicon.mjs

import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

// Colours are taken from styles.css so the icon matches the page exactly.
//   surface — the pale green used for a sender's own message bubbles
//   ink     — the deep green used for the brand text, buttons and the live dot
const SURFACE = [0xe8, 0xf1, 0xec];
const INK = [0x1f, 0x6f, 0x5c];
const EDGE = [0xc4, 0xdc, 0xd1]; // the bubble border tone
const CLEAR = [0, 0, 0, 0];

// ---- shape, expressed in the same 64x64 space the SVG uses ----------------

const R = 13; // corner radius of the background tile

function inTile(px, py) {
  const dx = Math.min(px, 64 - px);
  const dy = Math.min(py, 64 - py);
  if (dx >= R || dy >= R) return true;
  const ox = R - dx;
  const oy = R - dy;
  return ox * ox + oy * oy <= R * R;
}

// Roof triangle (32,12)-(56,33)-(8,33) plus body (15,33)-(49,52).
function inHouse(px, py) {
  if (py >= 12 && py <= 33) {
    const t = (py - 12) / 21;
    if (Math.abs(px - 32) <= 24 * t) return true;
  }
  if (py > 33 && py <= 52 && px >= 15 && px <= 49) return true;
  return false;
}

function inDoor(px, py) {
  return py >= 38 && py <= 52 && px >= 27 && px <= 37;
}

function sample(x, y, size) {
  const px = ((x + 0.5) * 64) / size;
  const py = ((y + 0.5) * 64) / size;
  // Outside the rounded tile, and inside the door, the icon shows through.
  if (!inTile(px, py)) return CLEAR;
  if (inDoor(px, py)) return [...SURFACE, 255];
  if (inHouse(px, py)) return [...INK, 255];
  // A hairline edge keeps the pale tile from disappearing into a light
  // browser tab strip.
  const edge = Math.min(px, 64 - px, py, 64 - py);
  if (edge < 3) return [...EDGE, 255];
  return [...SURFACE, 255];
}

// ---- PNG encoding --------------------------------------------------------

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    let c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function makePng(size) {
  // One filter byte (0 = none) per scanline, then RGBA pixels.
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = sample(x, y, size);
      const i = y * stride + 1 + x * 4;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
      raw[i + 3] = a;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour + alpha
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- ICO container (embeds PNG frames, supported since Vista) ------------

function makeIco(frames) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(frames.length, 4);

  let offset = 6 + frames.length * 16;
  const entries = frames.map(({ size, data }) => {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size; // 0 means 256
    e[1] = size >= 256 ? 0 : size;
    e[2] = 0; // palette size
    e[3] = 0; // reserved
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });

  return Buffer.concat([header, ...entries, ...frames.map((f) => f.data)]);
}

const sizes = [16, 32, 48];
const frames = sizes.map((size) => ({ size, data: makePng(size) }));
const ico = makeIco(frames);

writeFileSync("web/public/favicon.ico", ico);
console.log(`favicon.ico  ${ico.length} 字节  帧: ${sizes.join("/")}`);
for (const f of frames) console.log(`  ${f.size}x${f.size}  ${f.data.length} 字节`);
