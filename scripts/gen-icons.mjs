/**
 * Generate IdeaForge PWA icons with pngjs (pure JS, no native deps).
 * Design: deep ink background (#0B0E14), gold (#E8B44C) rounded-square emblem,
 * dark "IF" monogram drawn with filled rectangles.
 *
 * Run: node scripts/gen-icons.mjs
 */
import { PNG } from 'pngjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public', 'icons');
mkdirSync(outDir, { recursive: true });

const INK = [0x0b, 0x0e, 0x14];
const GOLD = [0xe8, 0xb4, 0x4c];

function setPixel(png, x, y, c) {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
  const i = (y * png.width + x) * 4;
  png.data[i] = c[0];
  png.data[i + 1] = c[1];
  png.data[i + 2] = c[2];
  png.data[i + 3] = 255;
}

/** Fill a rounded rectangle. */
function roundedRect(png, x0, y0, w, h, r, color) {
  const rr = Math.min(r, w / 2, h / 2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = x0 + x;
      const py = y0 + y;
      const cx = Math.min(Math.max(px, x0 + rr), x0 + w - rr);
      const cy = Math.min(Math.max(py, y0 + rr), y0 + h - rr);
      const dx = px - cx;
      const dy = py - cy;
      if (dx * dx + dy * dy <= rr * rr) setPixel(png, px, py, color);
    }
  }
}

/** Fill an axis-aligned rectangle. */
function fillRect(png, x0, y0, w, h, color) {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) setPixel(png, x0 + x, y0 + y, color);
  }
}

/**
 * Draw the "IF" monogram as block letters inside the emblem.
 * Coordinates are fractions of the emblem box.
 */
function monogram(png, ex, ey, e, color) {
  const bars = [
    // I: top bar, stem, bottom bar
    [0.18, 0.24, 0.42, 0.32],
    [0.27, 0.24, 0.33, 0.76],
    [0.18, 0.68, 0.42, 0.76],
    // F: stem, top bar, middle bar
    [0.58, 0.24, 0.64, 0.76],
    [0.58, 0.24, 0.86, 0.32],
    [0.58, 0.46, 0.79, 0.54],
  ];
  for (const [x0, y0, x1, y1] of bars) {
    fillRect(
      png,
      Math.round(ex + x0 * e),
      Math.round(ey + y0 * e),
      Math.max(1, Math.round((x1 - x0) * e)),
      Math.max(1, Math.round((y1 - y0) * e)),
      color,
    );
  }
}

function render(size, emblemFrac) {
  const png = new PNG({ width: size, height: size });
  // ink background, fully opaque
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = INK[0];
    png.data[i + 1] = INK[1];
    png.data[i + 2] = INK[2];
    png.data[i + 3] = 255;
  }
  const e = Math.round(size * emblemFrac);
  const ox = Math.round((size - e) / 2);
  const oy = Math.round((size - e) / 2);
  roundedRect(png, ox, oy, e, e, Math.round(e * 0.22), GOLD);
  monogram(png, ox, oy, e, INK);
  return png;
}

const jobs = [
  ['icon-512.png', 512, 0.68],
  ['icon-192.png', 192, 0.68],
  ['apple-touch-icon.png', 180, 0.68],
  // maskable: full-bleed background, smaller emblem keeps art inside the safe zone
  ['maskable-512.png', 512, 0.52],
];

for (const [name, size, frac] of jobs) {
  const png = render(size, frac);
  const buf = PNG.sync.write(png);
  writeFileSync(join(outDir, name), buf);
  console.log(`wrote public/icons/${name} (${size}x${size}, ${buf.length} bytes)`);
}
