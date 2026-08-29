import { downscaleRgba } from './gray';
import { dilate, erode } from './mask';
import type { Mask } from './mask';
import type { RgbaImage } from './types';

/**
 * Sucht Spiegelungen in einem fertigen Foto – also in dem, was am Ende
 * herauskommt, nicht in einer einzelnen Aufnahme.
 *
 * Eine Spiegelung ist kein helles Motiv. Sie ist das Licht der Lampe selbst,
 * und Licht hat drei Merkmale, die ein Abzug nicht mitbringt: Sie ist
 * praktisch ausgebrannt, sie ist farblos, und sie bildet einen Fleck. Alle
 * drei zusammen sind nötig – ein weisses Hemd erfüllt die ersten beiden
 * gelegentlich auch, ein heller Sprenkel im Korn das dritte nicht.
 */
export interface GlareOptions {
  /** So hell muss eine Stelle sein, um als Licht durchzugehen. */
  bright?: number;
  /** So farblos muss sie sein: Abstand zwischen stärkstem und schwächstem Kanal. */
  colourless?: number;
  /** Kantenlänge, auf der gesucht wird. */
  size?: number;
}

const DEFAULTS: Required<GlareOptions> = { bright: 246, colourless: 26, size: 320 };

/**
 * Ab diesem Flächenanteil lohnt der Hinweis. Darunter sind es einzelne
 * Bildpunkte an einer Kante, und wer deswegen eine Seite neu aufnimmt, hat
 * nichts gewonnen.
 */
export const NOTEWORTHY = 0.004;

/**
 * Ein durchgehend helles Foto ist keine Spiegelung, sondern ein helles Foto.
 * Liegt schon die Bildmitte nahe am Anschlag, sagt die Suche nichts mehr aus.
 */
const MEDIAN_LIMIT = 210;

export interface Glare {
  /** Anteil der Fläche, auf dem Glanz liegt. */
  share: number;
  /** Die gefundenen Flecken, auf der Suchgrösse. */
  mask: Mask;
}

export function findGlare(img: RgbaImage, options: GlareOptions = {}): Glare {
  const opts = { ...DEFAULTS, ...options };
  const { image } = downscaleRgba(img, opts.size);
  const { width, height } = image;
  const data = new Uint8Array(width * height);

  if (median(image) > MEDIAN_LIMIT) return { share: 0, mask: { data, width, height } };

  for (let i = 0, p = 0; i < data.length; i++, p += 4) {
    const r = image.data[p];
    const g = image.data[p + 1];
    const b = image.data[p + 2];
    const high = r > g ? (r > b ? r : b) : g > b ? g : b;
    const low = r < g ? (r < b ? r : b) : g < b ? g : b;
    data[i] = high >= opts.bright && high - low <= opts.colourless ? 1 : 0;
  }

  // Öffnen: Was übrig bleibt, muss zusammenhängen. Ein Fleck überlebt das,
  // ein Kantensprenkel nicht.
  const radius = Math.max(1, Math.round(Math.min(width, height) * 0.012));
  const blobs = dilate(erode({ data, width, height }, radius), radius);

  let count = 0;
  for (let i = 0; i < blobs.data.length; i++) if (blobs.data[i]) count++;
  return { share: count / blobs.data.length, mask: blobs };
}

/** Bleibt auf diesem Foto sichtbarer Glanz? */
export function hasGlare(img: RgbaImage, options: GlareOptions = {}): boolean {
  return findGlare(img, options).share >= NOTEWORTHY;
}

function median(img: RgbaImage): number {
  const bins = new Uint32Array(256);
  for (let p = 0; p < img.data.length; p += 4) {
    bins[(img.data[p] * 77 + img.data[p + 1] * 150 + img.data[p + 2] * 29) >> 8]++;
  }
  const half = (img.width * img.height) / 2;
  let seen = 0;
  for (let v = 0; v < 256; v++) {
    seen += bins[v];
    if (seen >= half) return v;
  }
  return 128;
}
