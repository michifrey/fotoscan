import type { GrayImage, RgbaImage } from './types';
import { createRgba } from './types';

/** Rec. 601 Luma – schnell und für Kantenerkennung völlig ausreichend. */
export function toGray(img: RgbaImage): GrayImage {
  const { data, width, height } = img;
  const out = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
  }
  return { data: out, width, height };
}

/**
 * Box-Downscale auf eine maximale Kantenlänge. Gibt zusätzlich den Faktor
 * zurück, mit dem sich Koordinaten wieder auf das Original abbilden lassen.
 */
export function downscaleGray(src: GrayImage, maxDim: number): { image: GrayImage; scale: number } {
  const longest = Math.max(src.width, src.height);
  if (longest <= maxDim) return { image: src, scale: 1 };

  const factor = longest / maxDim;
  const width = Math.max(1, Math.round(src.width / factor));
  const height = Math.max(1, Math.round(src.height / factor));
  const out = new Uint8Array(width * height);

  for (let y = 0; y < height; y++) {
    const y0 = Math.floor((y * src.height) / height);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * src.height) / height));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor((x * src.width) / width);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * src.width) / width));
      let sum = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        const row = yy * src.width;
        for (let xx = x0; xx < x1; xx++) {
          sum += src.data[row + xx];
          n++;
        }
      }
      out[y * width + x] = (sum / n) | 0;
    }
  }
  // Skalierung von klein -> gross.
  return { image: { data: out, width, height }, scale: src.width / width };
}

/** Separierbarer Box-Blur; zweimal angewandt ergibt eine gute Gauss-Näherung. */
export function boxBlur(src: GrayImage, radius: number): GrayImage {
  if (radius < 1) return src;
  const { width, height } = src;
  const tmp = new Uint8Array(width * height);
  const out = new Uint8Array(width * height);
  const window = radius * 2 + 1;

  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0;
    for (let x = -radius; x <= radius; x++) sum += src.data[row + clamp(x, 0, width - 1)];
    for (let x = 0; x < width; x++) {
      tmp[row + x] = (sum / window) | 0;
      sum -= src.data[row + clamp(x - radius, 0, width - 1)];
      sum += src.data[row + clamp(x + radius + 1, 0, width - 1)];
    }
  }

  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let y = -radius; y <= radius; y++) sum += tmp[clamp(y, 0, height - 1) * width + x];
    for (let y = 0; y < height; y++) {
      out[y * width + x] = (sum / window) | 0;
      sum -= tmp[clamp(y - radius, 0, height - 1) * width + x];
      sum += tmp[clamp(y + radius + 1, 0, height - 1) * width + x];
    }
  }

  return { data: out, width, height };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Box-Downscale eines Farbbildes auf eine maximale Kantenlänge. */
export function downscaleRgba(src: RgbaImage, maxDim: number): { image: RgbaImage; scale: number } {
  const longest = Math.max(src.width, src.height);
  if (longest <= maxDim) return { image: src, scale: 1 };

  const factor = longest / maxDim;
  const width = Math.max(1, Math.round(src.width / factor));
  const height = Math.max(1, Math.round(src.height / factor));
  const out = createRgba(width, height);

  for (let y = 0; y < height; y++) {
    const y0 = Math.floor((y * src.height) / height);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * src.height) / height));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor((x * src.width) / width);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * src.width) / width));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * src.width + xx) * 4;
          r += src.data[i];
          g += src.data[i + 1];
          b += src.data[i + 2];
          n++;
        }
      }
      const o = (y * width + x) * 4;
      out.data[o] = r / n;
      out.data[o + 1] = g / n;
      out.data[o + 2] = b / n;
      out.data[o + 3] = 255;
    }
  }
  return { image: out, scale: src.width / width };
}
