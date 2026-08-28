import { boxBlur, downscaleGray, toGray } from './gray';
import {
  close,
  componentBoundary,
  connectedComponents,
  fillFromBorder,
  gradientMagnitude,
  thresholdTopFraction,
} from './mask';
import {
  approximateQuad,
  convexHull,
  dist,
  insetQuad,
  isPlausibleQuad,
  polygonArea,
  quadCentroid,
  scaleQuad,
} from './geometry';
import { applyHomography, computeHomography, outputSize, shrinkQuad, warpGray } from './warp';
import type { GrayImage, Pt, Quad, RgbaImage } from './types';

export interface DetectOptions {
  /** Längste Kante, auf die vor der Analyse heruntergerechnet wird. */
  analysisSize?: number;
  /** Kleinste akzeptierte Fläche, als Anteil der analysierten Fläche. */
  minAreaFraction?: number;
  /** Wie tief in gefundene Flächen hineingesucht wird (Albumseite -> Fotos). */
  maxDepth?: number;
}

const DEFAULTS: Required<DetectOptions> = {
  analysisSize: 720,
  minAreaFraction: 0.015,
  maxDepth: 2,
};

/** Anteil, um den beim Hineinsuchen vom Rand der Fläche weggeschnitten wird. */
const CHILD_INSET = 0.012;

/**
 * Nicht gesetzte Felder auf die Vorgabe zurückführen. Ein einfaches Spreizen
 * würde ein ausdrücklich übergebenes `undefined` durchreichen und damit die
 * Vorgabe überschreiben.
 */
function resolve(options: DetectOptions): Required<DetectOptions> {
  return {
    analysisSize: options.analysisSize ?? DEFAULTS.analysisSize,
    minAreaFraction: options.minAreaFraction ?? DEFAULTS.minAreaFraction,
    maxDepth: options.maxDepth ?? DEFAULTS.maxDepth,
  };
}

/**
 * Findet die Vierecke aller Fotos in einer Aufnahme – ein einzelnes Bild auf
 * dem Tisch genauso wie mehrere Fotos auf einer aufgeschlagenen Albumseite.
 * Rückgabe in Koordinaten des Originalbildes.
 */
export function detectPhotoQuads(img: RgbaImage, options: DetectOptions = {}): Quad[] {
  const opts = resolve(options);
  const gray = toGray(img);
  const { image: small, scale } = downscaleGray(gray, opts.analysisSize);
  return dedupe(detectInGray(small, 0, opts).map((q) => scaleQuad(q, scale)));
}

/**
 * Sucht Fotos in einem Graubild. Die zurückgegebenen Vierecke liegen im
 * Koordinatensystem genau dieses Graubildes.
 */
export function detectInGray(gray: GrayImage, depth: number, opts: Required<DetectOptions>): Quad[] {
  if (gray.width < 48 || gray.height < 48) return [];

  const smoothed = boxBlur(boxBlur(gray, 1), 1);
  const mag = gradientMagnitude(smoothed);
  const edges = thresholdTopFraction(mag, gray.width, gray.height, 0.1);
  const closeRadius = Math.max(1, Math.round(Math.max(gray.width, gray.height) / 320));
  const solid = fillFromBorder(close(edges, closeRadius));
  const { labels, components } = connectedComponents(solid);

  const totalArea = gray.width * gray.height;
  const minArea = totalArea * opts.minAreaFraction;
  const results: Quad[] = [];

  for (const comp of components) {
    if (comp.area < minArea) continue;
    if (comp.area > totalArea * 0.995) continue;

    const boundary = componentBoundary(labels, gray.width, gray.height, comp);
    const quad = approximateQuad(convexHull(boundary));
    if (!quad) continue;

    const area = polygonArea(quad);
    // Eine L- oder U-Form füllt ihr Viereck nicht aus – solche Flächen sind
    // keine Fotos, sondern meist Schatten oder angeschnittene Seiten.
    if (area < comp.area * 0.62) continue;
    if (!isPlausibleQuad(quad)) continue;

    const children = depth < opts.maxDepth ? childQuads(gray, quad, area, depth, opts) : [];
    if (children.length > 0) results.push(...children);
    // Weichzeichnen und Sobel verbreitern die Kante; ohne diese Korrektur läge
    // ein heller Saum der Albumseite mit im Zuschnitt.
    else results.push(insetQuad(quad, closeRadius + 1));
  }

  return results;
}

/**
 * Sucht innerhalb einer gefundenen Fläche nach kleineren Fotos. Damit wird aus
 * der erkannten Albumseite die Menge der Bilder darauf.
 *
 * Die Fläche wird dafür entzerrt statt nur ausgeschnitten: So verschwindet der
 * eigene Rand der Albumseite vollständig aus dem Suchbild, und auch Fotos, die
 * nahe am Seitenrand kleben, bleiben von der Umgebung getrennt.
 */
function childQuads(
  gray: GrayImage,
  quad: Quad,
  parentArea: number,
  depth: number,
  opts: Required<DetectOptions>,
): Quad[] {
  const inner = shrinkQuad(quad, CHILD_INSET);
  const size = outputSize(inner, opts.analysisSize);
  if (size.width < 64 || size.height < 64) return [];

  const warped = warpGray(gray, inner, size.width, size.height);
  const found = detectInGray(warped, depth + 1, opts);
  if (found.length === 0) return [];

  const rect: Quad = [
    { x: 0, y: 0 },
    { x: size.width - 1, y: 0 },
    { x: size.width - 1, y: size.height - 1 },
    { x: 0, y: size.height - 1 },
  ];
  const back = computeHomography(rect, inner);
  const mapped = found.map((q) => applyHomography(back, q) as Quad);

  // Nur übernehmen, wenn die Kinder echte Unterteilungen sind und nicht bloss
  // dieselbe Fläche noch einmal.
  const kept = mapped.filter((q) => polygonArea(q) < parentArea * 0.86);
  if (kept.length === 0) return [];
  const sum = kept.reduce((acc, q) => acc + polygonArea(q), 0);
  if (sum < parentArea * 0.12) return [];
  return kept;
}

/** Entfernt Mehrfachfunde derselben Fläche (z. B. Rahmen und Foto darin). */
export function dedupe(quads: Quad[]): Quad[] {
  const out: Quad[] = [];
  const sorted = quads.slice().sort((a, b) => polygonArea(b) - polygonArea(a));
  for (const q of sorted) {
    const c = quadCentroid(q);
    const size = Math.sqrt(polygonArea(q));
    const duplicate = out.some((other) => {
      const oc = quadCentroid(other);
      const osize = Math.sqrt(polygonArea(other));
      return dist(c, oc) < Math.min(size, osize) * 0.35 && Math.abs(size - osize) / Math.max(size, osize) < 0.3;
    });
    if (!duplicate) out.push(q);
  }
  return sortReadingOrder(out);
}

/** Fotos in Leserichtung sortieren, damit die Reihenfolge im Album stimmt. */
export function sortReadingOrder(quads: Quad[]): Quad[] {
  if (quads.length < 2) return quads;
  const heights = quads.map((q) => Math.abs(q[3].y - q[0].y));
  const rowTolerance = Math.max(...heights) * 0.5;
  return quads
    .map((q) => ({ q, c: quadCentroid(q) }))
    .sort((a, b) => (Math.abs(a.c.y - b.c.y) > rowTolerance ? a.c.y - b.c.y : a.c.x - b.c.x))
    .map((entry) => entry.q);
}

/** Standardviereck, wenn nichts erkannt wurde: 85 % der Bildfläche. */
export function defaultQuad(width: number, height: number): Quad {
  const mx = width * 0.075;
  const my = height * 0.075;
  const pts: Pt[] = [
    { x: mx, y: my },
    { x: width - mx, y: my },
    { x: width - mx, y: height - my },
    { x: mx, y: height - my },
  ];
  return pts as Quad;
}
