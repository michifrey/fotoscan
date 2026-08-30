// Erzeugt eine synthetische Albumseite für den End-to-End-Test: drei Fotos
// auf hellem Albumpapier, das Ganze auf einem dunklen Tisch.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng } from './png.mjs';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../e2e/fixtures');
const WIDTH = 1400;
const HEIGHT = 1000;

function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const pixels = new Uint8Array(WIDTH * HEIGHT * 4);
const set = (x, y, r, g, b) => {
  const i = (y * WIDTH + x) * 4;
  pixels[i] = Math.max(0, Math.min(255, r));
  pixels[i + 1] = Math.max(0, Math.min(255, g));
  pixels[i + 2] = Math.max(0, Math.min(255, b));
  pixels[i + 3] = 255;
};

for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) set(x, y, 40, 38, 36);

const rect = (x0, y0, w, h, draw) => {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) continue;
      draw(x, y, x - x0, y - y0);
    }
  }
};

rect(160, 110, 1080, 780, (x, y) => set(x, y, 236, 232, 222));

const photos = [
  [280, 230, 400, 300, 1],
  [760, 250, 400, 300, 2],
  [420, 610, 520, 260, 3],
];
for (const [x0, y0, w, h, seed] of photos) {
  const rnd = lcg(seed * 7919);
  const base = [110 + seed * 25, 95 + seed * 18, 80 + seed * 12];
  rect(x0, y0, w, h, (x, y, lx, ly) => {
    const wave = Math.sin(lx / 11 + seed) * 26 + Math.cos(ly / 8 - seed) * 22;
    const noise = (rnd() - 0.5) * 22;
    set(x, y, base[0] + wave + noise, base[1] + wave * 0.7 + noise, base[2] + wave * 0.4 + noise);
  });
}

// Unter dem ersten Foto steht eine Zeile Handschrift – dünne, dunkle Striche,
// wie sie auf einer echten Albumseite danebenstehen.
function handschrift(x0, y0, width, height, seed) {
  const rnd = lcg(seed);
  const thickness = Math.max(2, Math.round(height * 0.12));
  let x = x0;
  while (x < x0 + width) {
    const w = Math.round(height * (0.4 + rnd() * 0.5));
    const top = y0 + Math.round(rnd() * height * 0.2);
    const bottom = y0 + height - Math.round(rnd() * height * 0.2);
    for (const sx of [x, x + w]) {
      for (let yy = top; yy < bottom; yy++) {
        for (let t = 0; t < thickness; t++) set(sx + t, yy, 42, 40, 44);
      }
    }
    const my = (top + bottom) >> 1;
    for (let xx = x; xx <= x + w; xx++) {
      for (let t = 0; t < thickness; t++) set(xx, my + t, 42, 40, 44);
    }
    x += w + Math.round(height * 0.35);
  }
}
handschrift(285, 560, 380, 34, 5);

mkdirSync(OUT, { recursive: true });
writeFileSync(resolve(OUT, 'albumseite.png'), encodePng(pixels, WIDTH, HEIGHT));
console.log('geschrieben: e2e/fixtures/albumseite.png');

