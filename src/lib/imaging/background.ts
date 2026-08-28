import { gradientMagnitude } from './mask';
import type { Mask } from './mask';
import type { GrayImage, RgbaImage } from './types';

export interface Background {
  /** Mittlere Farbe der gleichmässigen Fläche. */
  color: [number, number, number];
  /** Erlaubte Abweichung im Farbton. */
  chroma: number;
  /** Erlaubte Abweichung in der Helligkeit, als Anteil. */
  brightness: number;
  /** Anteil der Bildfläche, der zu dieser Fläche gehört. */
  fraction: number;
}

/** Ausgangswerte der Verfeinerung – bewusst grosszügig. */
const START_CHROMA = 22;
const START_BRIGHTNESS = 0.3;
const ROUNDS = 3;

function luma(r: number, g: number, b: number): number {
  return (r * 77 + g * 150 + b * 29) / 256;
}

function within(
  r: number,
  g: number,
  b: number,
  color: [number, number, number],
  reference: number,
  chroma: number,
  brightness: number,
): boolean {
  if (Math.abs(r - g - (color[0] - color[1])) > chroma) return false;
  if (Math.abs(g - b - (color[1] - color[2])) > chroma) return false;
  const l = luma(r, g, b);
  return Math.abs(l - reference) <= reference * brightness;
}

/**
 * Schätzt Farbe und Streuung des Untergrunds – auf einer Albumseite also die
 * des Papiers.
 *
 * Zwei Schritte. Zuerst die häufigste Farbe unter den *flachen* Pixeln:
 * Papier, Tisch und Karton sind gleichmässig, Fotos und Handschrift nicht.
 * Dann wird die erlaubte Abweichung aus der tatsächlichen Streuung dieser
 * Fläche abgeleitet, statt sie fest vorzugeben. Das ist der Punkt, an dem
 * feste Werte scheitern: Sauber ausgeleuchtetes Papier verträgt eine enge
 * Grenze, eine Holztischplatte mit Maserung braucht eine weite – und wer
 * beides mit derselben Zahl bedient, verliert entweder ein helles Foto oder
 * zerlegt den Tisch in Dutzende Schnipsel.
 */
export function estimateBackground(img: RgbaImage, gray: GrayImage): Background {
  const magnitude = gradientMagnitude(gray);
  const flat = new Uint8Array(magnitude.length);
  const bins = new Uint32Array(16 * 16 * 16);
  let flatCount = 0;

  for (let i = 0, p = 0; i < magnitude.length; i++, p += 4) {
    const x = i % img.width;
    const y = (i / img.width) | 0;
    if (x === 0 || y === 0 || x === img.width - 1 || y === img.height - 1) continue;
    if (magnitude[i] > 48) continue;
    flat[i] = 1;
    flatCount++;
    bins[((img.data[p] >> 4) << 8) | ((img.data[p + 1] >> 4) << 4) | (img.data[p + 2] >> 4)]++;
  }
  if (flatCount === 0) return { color: [0, 0, 0], chroma: 0, brightness: 0, fraction: 0 };

  let best = 0;
  for (let b = 1; b < bins.length; b++) if (bins[b] > bins[best]) best = b;
  let color: [number, number, number] = [((best >> 8) & 15) << 4, ((best >> 4) & 15) << 4, (best & 15) << 4];
  let chroma = START_CHROMA;
  let brightness = START_BRIGHTNESS;

  // Verfeinern: Mittelwert und Streuung der Fläche bestimmen, Grenzen daraus
  // neu setzen, wiederholen. Nach wenigen Runden steht beides fest.
  for (let round = 0; round < ROUNDS; round++) {
    const reference = luma(color[0], color[1], color[2]);
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let sumC = 0;
    let sumC2 = 0;
    let sumL = 0;
    let sumL2 = 0;
    let count = 0;

    for (let i = 0, p = 0; i < flat.length; i++, p += 4) {
      if (!flat[i]) continue;
      const r = img.data[p];
      const g = img.data[p + 1];
      const b = img.data[p + 2];
      if (!within(r, g, b, color, reference, chroma, brightness)) continue;
      const c1 = r - g - (color[0] - color[1]);
      const c2 = g - b - (color[1] - color[2]);
      const l = luma(r, g, b);
      sumR += r;
      sumG += g;
      sumB += b;
      sumC += Math.abs(c1) + Math.abs(c2);
      sumC2 += c1 * c1 + c2 * c2;
      sumL += l;
      sumL2 += l * l;
      count++;
    }
    if (count < 16) break;

    color = [sumR / count, sumG / count, sumB / count];
    const chromaSd = Math.sqrt(Math.max(0, sumC2 / (2 * count) - (sumC / (2 * count)) ** 2));
    const lumaMean = sumL / count;
    const lumaSd = Math.sqrt(Math.max(0, sumL2 / count - lumaMean * lumaMean));
    chroma = clamp(3.5 * chromaSd, 7, START_CHROMA);
    brightness = clamp((3.5 * lumaSd) / Math.max(1, lumaMean), 0.1, START_BRIGHTNESS);
  }

  return { color, chroma, brightness, fraction: backgroundFraction(img, { color, chroma, brightness }) };
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

type Limits = Pick<Background, 'color' | 'chroma' | 'brightness'>;

export function backgroundFraction(img: RgbaImage, limits: Limits): number {
  const reference = luma(limits.color[0], limits.color[1], limits.color[2]);
  let count = 0;
  for (let p = 0; p < img.data.length; p += 4) {
    if (within(img.data[p], img.data[p + 1], img.data[p + 2], limits.color, reference, limits.chroma, limits.brightness)) {
      count++;
    }
  }
  return count / (img.width * img.height);
}

/**
 * Maske alles dessen, was *nicht* Untergrund ist – auf einer Albumseite also
 * der Fotos und der Beschriftung.
 */
export function foregroundMask(img: RgbaImage, limits: Limits): Mask {
  const reference = luma(limits.color[0], limits.color[1], limits.color[2]);
  const data = new Uint8Array(img.width * img.height);
  for (let i = 0, p = 0; i < data.length; i++, p += 4) {
    data[i] = within(img.data[p], img.data[p + 1], img.data[p + 2], limits.color, reference, limits.chroma, limits.brightness)
      ? 0
      : 1;
  }
  return { data, width: img.width, height: img.height };
}
