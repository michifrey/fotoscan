import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng } from './png.mjs';

const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../public/icons');

const AMBER = [251, 191, 36];
const DARK = [28, 25, 23];
const PAPER = [250, 249, 246];

/** Zeichenfläche mit vierfacher Auflösung – das Herunterrechnen glättet die Kanten. */
function canvas(size) {
  const scale = 4;
  const width = size * scale;
  const pixels = new Uint8Array(width * width * 4);

  const set = (x, y, color, alpha = 1) => {
    if (x < 0 || y < 0 || x >= width || y >= width) return;
    const i = (y * width + x) * 4;
    for (let c = 0; c < 3; c++) pixels[i + c] = pixels[i + c] * (1 - alpha) + color[c] * alpha;
    pixels[i + 3] = Math.max(pixels[i + 3], Math.round(alpha * 255));
  };

  const api = {
    fill(color) {
      for (let i = 0; i < pixels.length; i += 4) {
        pixels[i] = color[0];
        pixels[i + 1] = color[1];
        pixels[i + 2] = color[2];
        pixels[i + 3] = 255;
      }
      return api;
    },
    roundedRect(x, y, w, h, radius, color) {
      const [px, py, pw, ph, pr] = [x, y, w, h, radius].map((v) => v * scale);
      for (let yy = Math.floor(py); yy < py + ph; yy++) {
        for (let xx = Math.floor(px); xx < px + pw; xx++) {
          const dx = Math.max(px + pr - xx, xx - (px + pw - pr), 0);
          const dy = Math.max(py + pr - yy, yy - (py + ph - pr), 0);
          if (dx * dx + dy * dy <= pr * pr) set(xx, yy, color);
        }
      }
      return api;
    },
    circle(cx, cy, r, color) {
      const [pcx, pcy, pr] = [cx, cy, r].map((v) => v * scale);
      for (let yy = Math.floor(pcy - pr); yy <= pcy + pr; yy++) {
        for (let xx = Math.floor(pcx - pr); xx <= pcx + pr; xx++) {
          if ((xx - pcx) ** 2 + (yy - pcy) ** 2 <= pr * pr) set(xx, yy, color);
        }
      }
      return api;
    },
    triangle(a, b, c, color) {
      const pts = [a, b, c].map(([x, y]) => [x * scale, y * scale]);
      const minX = Math.floor(Math.min(...pts.map((p) => p[0])));
      const maxX = Math.ceil(Math.max(...pts.map((p) => p[0])));
      const minY = Math.floor(Math.min(...pts.map((p) => p[1])));
      const maxY = Math.ceil(Math.max(...pts.map((p) => p[1])));
      const sign = (px, py, [x1, y1], [x2, y2]) => (px - x2) * (y1 - y2) - (x1 - x2) * (py - y2);
      for (let yy = minY; yy <= maxY; yy++) {
        for (let xx = minX; xx <= maxX; xx++) {
          const d1 = sign(xx, yy, pts[0], pts[1]);
          const d2 = sign(xx, yy, pts[1], pts[2]);
          const d3 = sign(xx, yy, pts[2], pts[0]);
          const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
          const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
          if (!(hasNeg && hasPos)) set(xx, yy, color);
        }
      }
      return api;
    },
    toPng() {
      const out = new Uint8Array(size * size * 4);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const acc = [0, 0, 0, 0];
          for (let sy = 0; sy < scale; sy++) {
            for (let sx = 0; sx < scale; sx++) {
              const i = ((y * scale + sy) * width + x * scale + sx) * 4;
              for (let c = 0; c < 4; c++) acc[c] += pixels[i + c];
            }
          }
          const o = (y * size + x) * 4;
          for (let c = 0; c < 4; c++) out[o + c] = Math.round(acc[c] / (scale * scale));
        }
      }
      return encodePng(out, size, size);
    },
  };
  return api;
}

/**
 * Symbol: ein Abzug auf einem dunklen Grund. `padding` schafft den Freiraum,
 * den maskierbare Symbole auf Android brauchen.
 */
function icon(size, padding) {
  const c = canvas(size).fill(DARK);
  const inner = size * (1 - padding * 2);
  const x = size * padding;
  const y = size * padding;

  c.roundedRect(x, y, inner, inner, inner * 0.18, AMBER);

  const px = x + inner * 0.16;
  const py = y + inner * 0.2;
  const pw = inner * 0.68;
  const ph = inner * 0.6;
  c.roundedRect(px, py, pw, ph, inner * 0.05, PAPER);
  c.circle(px + pw * 0.26, py + ph * 0.28, ph * 0.11, AMBER);
  c.triangle(
    [px + pw * 0.08, py + ph * 0.92],
    [px + pw * 0.46, py + ph * 0.4],
    [px + pw * 0.84, py + ph * 0.92],
    DARK,
  );
  c.triangle(
    [px + pw * 0.5, py + ph * 0.92],
    [px + pw * 0.74, py + ph * 0.58],
    [px + pw * 0.98, py + ph * 0.92],
    DARK,
  );
  return c.toPng();
}

mkdirSync(OUT_DIR, { recursive: true });
for (const [name, size, padding] of [
  ['icon-192.png', 192, 0.08],
  ['icon-512.png', 512, 0.08],
  ['icon-maskable-512.png', 512, 0.18],
]) {
  writeFileSync(resolve(OUT_DIR, name), icon(size, padding));
  console.log(`geschrieben: ${name}`);
}
