import type { RgbaImage } from './types';
import { createRgba } from './types';

export interface EnhanceOptions {
  /** Tonwertspreizung pro Kanal. */
  levels: boolean;
  /** Grauwelt-Weissabgleich – nimmt alten Fotos den Gelb- oder Rotstich. */
  whiteBalance: boolean;
  /** Leichtes Nachschärfen (Unschärfemaske). */
  sharpen: boolean;
}

export const DEFAULT_ENHANCE: EnhanceOptions = { levels: true, whiteBalance: true, sharpen: true };
export const NO_ENHANCE: EnhanceOptions = { levels: false, whiteBalance: false, sharpen: false };

export function enhance(src: RgbaImage, options: EnhanceOptions): RgbaImage {
  let img = copy(src);
  if (options.whiteBalance) img = grayWorld(img);
  if (options.levels) img = autoLevels(img);
  if (options.sharpen) img = unsharpMask(img, 0.6, 2);
  return img;
}

function copy(src: RgbaImage): RgbaImage {
  return { data: new Uint8ClampedArray(src.data), width: src.width, height: src.height };
}

/**
 * Tonwerte spreizen. Bewusst über die Helligkeit statt pro Kanal: Ein
 * kanalweises Strecken würde nebenbei jeden Farbstich entfernen und alten
 * Abzügen ihren Charakter nehmen. Farbstiche behandelt `grayWorld` – als
 * eigener, abschaltbarer Schritt.
 */
export function autoLevels(img: RgbaImage, clipFraction = 0.005): RgbaImage {
  const pixels = img.width * img.height;
  const clip = Math.floor(pixels * clipFraction);

  const hist = new Uint32Array(256);
  for (let i = 0; i < img.data.length; i += 4) {
    const lum = (img.data[i] * 77 + img.data[i + 1] * 150 + img.data[i + 2] * 29) >> 8;
    hist[lum]++;
  }

  let low = 0;
  let acc = 0;
  while (low < 255 && acc + hist[low] <= clip) {
    acc += hist[low];
    low++;
  }
  let high = 255;
  acc = 0;
  while (high > low && acc + hist[high] <= clip) {
    acc += hist[high];
    high--;
  }
  if (high - low < 8) return img;

  const lut = new Uint8Array(256);
  const span = high - low;
  for (let v = 0; v < 256; v++) {
    lut[v] = Math.max(0, Math.min(255, Math.round(((v - low) * 255) / span)));
  }
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = lut[img.data[i]];
    img.data[i + 1] = lut[img.data[i + 1]];
    img.data[i + 2] = lut[img.data[i + 2]];
  }
  return img;
}

/**
 * Grauwelt-Annahme: im Mittel soll das Bild neutral grau sein. Die Korrektur
 * wirkt nur zu einem Teil, damit Sepia und Schwarzweiss ihren Ton behalten.
 */
export function grayWorld(img: RgbaImage, strength = 0.7): RgbaImage {
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  const n = img.width * img.height;
  for (let i = 0; i < img.data.length; i += 4) {
    sumR += img.data[i];
    sumG += img.data[i + 1];
    sumB += img.data[i + 2];
  }
  const avgR = sumR / n;
  const avgG = sumG / n;
  const avgB = sumB / n;
  const target = (avgR + avgG + avgB) / 3;
  if (target < 1) return img;

  const gain = (avg: number) => {
    const raw = Math.max(0.8, Math.min(1.25, target / Math.max(1, avg)));
    return 1 + strength * (raw - 1);
  };
  const gr = gain(avgR);
  const gg = gain(avgG);
  const gb = gain(avgB);

  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = img.data[i] * gr;
    img.data[i + 1] = img.data[i + 1] * gg;
    img.data[i + 2] = img.data[i + 2] * gb;
  }
  return img;
}

/** Unschärfemaske auf Basis eines separierbaren Box-Blurs. */
export function unsharpMask(img: RgbaImage, amount: number, radius: number): RgbaImage {
  const blurred = blurRgb(img, radius);
  for (let i = 0; i < img.data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const v = img.data[i + c];
      img.data[i + c] = v + amount * (v - blurred.data[i + c]);
    }
  }
  return img;
}

function blurRgb(img: RgbaImage, radius: number): RgbaImage {
  const { width, height } = img;
  const tmp = createRgba(width, height);
  const out = createRgba(width, height);
  const window = radius * 2 + 1;
  const clamp = (v: number, hi: number) => (v < 0 ? 0 : v > hi ? hi : v);

  for (let y = 0; y < height; y++) {
    const row = y * width;
    const sums = [0, 0, 0];
    for (let x = -radius; x <= radius; x++) {
      const i = (row + clamp(x, width - 1)) * 4;
      for (let c = 0; c < 3; c++) sums[c] += img.data[i + c];
    }
    for (let x = 0; x < width; x++) {
      const o = (row + x) * 4;
      for (let c = 0; c < 3; c++) tmp.data[o + c] = sums[c] / window;
      const outIdx = (row + clamp(x - radius, width - 1)) * 4;
      const inIdx = (row + clamp(x + radius + 1, width - 1)) * 4;
      for (let c = 0; c < 3; c++) sums[c] += img.data[inIdx + c] - img.data[outIdx + c];
    }
  }

  for (let x = 0; x < width; x++) {
    const sums = [0, 0, 0];
    for (let y = -radius; y <= radius; y++) {
      const i = (clamp(y, height - 1) * width + x) * 4;
      for (let c = 0; c < 3; c++) sums[c] += tmp.data[i + c];
    }
    for (let y = 0; y < height; y++) {
      const o = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) out.data[o + c] = sums[c] / window;
      out.data[o + 3] = 255;
      const outIdx = (clamp(y - radius, height - 1) * width + x) * 4;
      const inIdx = (clamp(y + radius + 1, height - 1) * width + x) * 4;
      for (let c = 0; c < 3; c++) sums[c] += tmp.data[inIdx + c] - tmp.data[outIdx + c];
    }
  }
  return out;
}
