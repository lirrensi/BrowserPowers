#!/usr/bin/env node
/** make-icon.mjs — generates extension/public/icon-128.png (no deps).
 * Dark rounded square + violet dot, matching the old inline-SVG artwork.
 * Notifications reject data: URLs in some Chromium builds, so we ship a file. */
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const S = 128;
const px = Buffer.alloc(S * S * 4);
const dot = (x, y) => {
  const dx = x - S / 2, dy = y - S / 2;
  return Math.hypot(dx, dy);
};
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    const inRound = x >= 6 && x < S - 6 && y >= 6 && y < S - 6;
    if (!inRound) { px[i + 3] = 0; continue; } // transparent corners
    if (dot(x, y) <= 34) { px[i] = 0xa7; px[i + 1] = 0x8b; px[i + 2] = 0xfa; px[i + 3] = 255; } // violet
    else { px[i] = 0x1a; px[i + 1] = 0x1a; px[i + 2] = 0x25; px[i + 3] = 255; } // dark
  }
}
const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0; // filter 0
  px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlibCrc(body));
  return Buffer.concat([len, body, crc]);
};
// minimal CRC32
const table = new Int32Array(256);
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c; }
function zlibCrc(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
const png = Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "extension", "public", "icon-128.png");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
