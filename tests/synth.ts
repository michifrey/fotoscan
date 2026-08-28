import { computeHomography } from '../src/lib/imaging/warp';
import type { Pt, Quad, RgbaImage } from '../src/lib/imaging/types';
import { createRgba } from '../src/lib/imaging/types';

/** Deterministischer Zufall, damit Tests reproduzierbar bleiben. */
export function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export function fill(img: RgbaImage, r: number, g: number, b: number): void {
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = r;
    img.data[i + 1] = g;
    img.data[i + 2] = b;
    img.data[i + 3] = 255;
  }
}

/** Erzeugt eine strukturierte Fläche, die einem alten Foto ähnelt. */
export function photoTexture(width: number, height: number, seed: number): RgbaImage {
  const img = createRgba(width, height);
  const rnd = lcg(seed);
  const baseR = 120 + rnd() * 80;
  const baseG = 100 + rnd() * 80;
  const baseB = 80 + rnd() * 60;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const wave = Math.sin(x / 12 + seed) * 26 + Math.cos(y / 9 - seed) * 22;
      const noise = (rnd() - 0.5) * 24;
      img.data[i] = baseR + wave + noise;
      img.data[i + 1] = baseG + wave * 0.7 + noise;
      img.data[i + 2] = baseB + wave * 0.4 + noise;
      img.data[i + 3] = 255;
    }
  }
  return img;
}

function inside(quad: Quad, x: number, y: number): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    const cross = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
    if (cross === 0) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (sign !== s) return false;
  }
  return true;
}

/** Zeichnet eine Textur perspektivisch in ein Viereck der Zielfläche. */
export function drawTextureInQuad(dst: RgbaImage, texture: RgbaImage, quad: Quad): void {
  const texQuad: Quad = [
    { x: 0, y: 0 },
    { x: texture.width - 1, y: 0 },
    { x: texture.width - 1, y: texture.height - 1 },
    { x: 0, y: texture.height - 1 },
  ];
  const h = computeHomography(quad, texQuad);
  const minX = Math.max(0, Math.floor(Math.min(...quad.map((p) => p.x))));
  const maxX = Math.min(dst.width - 1, Math.ceil(Math.max(...quad.map((p) => p.x))));
  const minY = Math.max(0, Math.floor(Math.min(...quad.map((p) => p.y))));
  const maxY = Math.min(dst.height - 1, Math.ceil(Math.max(...quad.map((p) => p.y))));

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      if (!inside(quad, x, y)) continue;
      const denom = h[6] * x + h[7] * y + h[8];
      const tx = Math.round((h[0] * x + h[1] * y + h[2]) / denom);
      const ty = Math.round((h[3] * x + h[4] * y + h[5]) / denom);
      if (tx < 0 || ty < 0 || tx >= texture.width || ty >= texture.height) continue;
      const from = (ty * texture.width + tx) * 4;
      const to = (y * dst.width + x) * 4;
      dst.data[to] = texture.data[from];
      dst.data[to + 1] = texture.data[from + 1];
      dst.data[to + 2] = texture.data[from + 2];
      dst.data[to + 3] = 255;
    }
  }
}

export function rectQuad(x: number, y: number, w: number, h: number, rotationDeg = 0): Quad {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const rad = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const corners: Pt[] = [
    { x: -w / 2, y: -h / 2 },
    { x: w / 2, y: -h / 2 },
    { x: w / 2, y: h / 2 },
    { x: -w / 2, y: h / 2 },
  ];
  return corners.map((p) => ({ x: cx + p.x * cos - p.y * sin, y: cy + p.x * sin + p.y * cos })) as Quad;
}

export function centroid(quad: Quad): Pt {
  return {
    x: (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4,
    y: (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4,
  };
}

/** Gleichmässig gefärbte Fläche – z. B. das Albumpapier unter den Fotos. */
export function flatTexture(width: number, height: number, r: number, g: number, b: number): RgbaImage {
  const img = createRgba(width, height);
  fill(img, r, g, b);
  return img;
}

/** Handschriftähnliche Striche – dünn, dunkel, in einer Zeile. */
export function drawHandwriting(
  img: RgbaImage,
  x0: number,
  y0: number,
  width: number,
  height: number,
  seed: number,
): void {
  const rnd = lcg(seed);
  const thickness = Math.max(2, Math.round(height * 0.12));
  let x = x0;
  while (x < x0 + width) {
    const w = Math.round(height * (0.4 + rnd() * 0.5));
    const top = y0 + Math.round(rnd() * height * 0.2);
    const bottom = y0 + height - Math.round(rnd() * height * 0.2);
    // Ein Buchstabe: zwei senkrechte Striche und ein Querstrich.
    for (const sx of [x, x + w]) {
      for (let yy = top; yy < bottom; yy++) {
        for (let t = 0; t < thickness; t++) stroke(img, sx + t, yy);
      }
    }
    const my = (top + bottom) >> 1;
    for (let xx = x; xx <= x + w; xx++) {
      for (let t = 0; t < thickness; t++) stroke(img, xx, my + t);
    }
    x += w + Math.round(height * 0.35);
  }
}

function stroke(img: RgbaImage, x: number, y: number): void {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const i = (y * img.width + x) * 4;
  img.data[i] = 40;
  img.data[i + 1] = 38;
  img.data[i + 2] = 42;
  img.data[i + 3] = 255;
}

/**
 * Ein Foto, das selbst eine grosse helle Fläche enthält – eine Bettdecke, ein
 * bewölkter Himmel. Die Fläche liegt im Inneren, mit Bildinhalt ringsum: Genau
 * so sieht es auf einem echten Abzug aus, und genau daran zerbricht eine reine
 * Farbtrennung, wenn sie die Stelle nicht als Loch im Foto begreift.
 */
export function photoWithPaleArea(
  width: number,
  height: number,
  seed: number,
  pale: [number, number, number],
): RgbaImage {
  const img = photoTexture(width, height, seed);
  const rnd = lcg(seed * 13);
  const x0 = Math.round(width * 0.18);
  const x1 = Math.round(width * 0.62);
  const y0 = Math.round(height * 0.2);
  const y1 = Math.round(height * 0.82);

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4;
      const noise = (rnd() - 0.5) * 8;
      img.data[i] = pale[0] + noise;
      img.data[i + 1] = pale[1] + noise;
      img.data[i + 2] = pale[2] + noise;
    }
  }
  return img;
}

/** Weiche dunkle Formen, wie Möbel oder Geräte im Hintergrund eines Fotos. */
export function addSoftShapes(img: RgbaImage, seed: number, count: number): void {
  const rnd = lcg(seed);
  for (let n = 0; n < count; n++) {
    const cx = img.width * (0.2 + rnd() * 0.6);
    const cy = img.height * (0.2 + rnd() * 0.6);
    const rx = img.width * (0.1 + rnd() * 0.12);
    const ry = img.height * (0.1 + rnd() * 0.12);
    for (let y = Math.round(cy - ry); y <= cy + ry; y++) {
      for (let x = Math.round(cx - rx); x <= cx + rx; x++) {
        if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
        const d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
        if (d > 1) continue;
        // Weicher Rand: kein harter Übergang, wie ihn ein aufgeklebtes
        // Rechteck hätte.
        const strength = (1 - Math.sqrt(d)) * 0.75;
        const i = (y * img.width + x) * 4;
        for (let c = 0; c < 3; c++) img.data[i + c] = img.data[i + c] * (1 - strength) + 45 * strength;
      }
    }
  }
}
