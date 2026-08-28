import { boxBlur, downscaleRgba, toGray } from './gray';
import { estimateBackground, foregroundMask } from './background';
import {
  close,
  componentBoundary,
  connectedComponents,
  dilate,
  erode,
  fillFromBorder,
  fillHoles,
  gradientMagnitude,
  thresholdTopFraction,
} from './mask';
import type { Component, Mask } from './mask';
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
import { applyHomography, computeHomography, outputSize, shrinkQuad } from './warp';
import { warpPerspective } from './warp';
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
 * Ab so viel gleichmässiger Fläche gilt ein Bereich als Untergrund, auf dem
 * sich suchen lohnt. Darunter ist es ein Foto – und in ein Foto hineinzusuchen
 * liefert nur seine Bildinhalte, nicht seine Ränder.
 */
const BACKGROUND_MIN = 0.3;
const PAGE_MIN = 0.5;

/**
 * Grösste Fläche, die noch als Loch innerhalb eines Fotos durchgeht. Alles
 * Grössere ist die Albumseite selbst, eingefasst vom Tisch.
 */
const HOLE_MAX = 0.15;

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
  const { image: small, scale } = downscaleRgba(img, opts.analysisSize);
  return dedupe(detectIn(small, 0, opts).map((q) => scaleQuad(q, scale)));
}

/**
 * Sucht Fotos in einem Bildausschnitt. Zwei Wege, in dieser Reihenfolge:
 *
 * 1. Über den Untergrund. Eine Albumseite ist eine gleichmässige Fläche; was
 *    darauf liegt, hebt sich farblich ab. Das ist das verlässlichere Signal,
 *    denn ein Foto und eine Beschriftung bringen selbst reichlich Kanten mit,
 *    an denen sich eine Kantensuche verheddert.
 * 2. Über Kanten. Greift, wenn es keinen erkennbaren Untergrund gibt – etwa
 *    bei einem Foto, das fast das ganze Bild füllt.
 */
function detectIn(img: RgbaImage, depth: number, opts: Required<DetectOptions>): Quad[] {
  if (img.width < 48 || img.height < 48) return [];
  const gray = toGray(img);

  let regions = backgroundQuads(img, gray, depth, opts);
  if (regions.length === 0) regions = edgeQuads(gray, opts);

  const results: Quad[] = [];
  for (const quad of regions) {
    const children = depth < opts.maxDepth ? childQuads(img, quad, polygonArea(quad), depth, opts) : [];
    if (children.length > 0) results.push(...children);
    else results.push(quad);
  }
  return results;
}

/** Weg 1: alles, was sich farblich vom Untergrund abhebt. */
function backgroundQuads(
  img: RgbaImage,
  gray: GrayImage,
  depth: number,
  opts: Required<DetectOptions>,
): Quad[] {
  const background = estimateBackground(img, gray);
  if (background.fraction < BACKGROUND_MIN) return [];

  // Öffnen entfernt, was dünner ist als ein Foto: Beschriftung, Fusseln,
  // Papierstruktur. Der Radius ist an einer echten Albumseite eingestellt –
  // kleiner, und eine danebenstehende Bildunterschrift bleibt am Foto kleben
  // und zieht den Zuschnitt auf.
  const radius = Math.max(3, Math.round(Math.min(img.width, img.height) * 0.019));
  const raw = fillHoles(foregroundMask(img, background), HOLE_MAX);
  const mask = open(raw, radius);

  // Auf der obersten Ebene ist alles, was den Bildrand berührt, die Umgebung –
  // Tischplatte, Nachbarseiten, die eigene Hand. Die Einrückung bleibt klein:
  // Der Farbübergang ist scharf, es fällt kein verbreiterter Saum an wie bei
  // der Kantensuche.
  return quadsFromMask(mask, opts, 2, depth === 0, true, raw, radius);
}

/** Geschlossener Kantenzug über die stärksten Gradienten. */
function edgeMask(gray: GrayImage): Mask {
  const smoothed = boxBlur(boxBlur(gray, 1), 1);
  const magnitude = gradientMagnitude(smoothed);
  const closeRadius = Math.max(1, Math.round(Math.max(gray.width, gray.height) / 320));
  return close(thresholdTopFraction(magnitude, gray.width, gray.height, 0.1), closeRadius);
}

/** Weg 2: Flächen, die von einem geschlossenen Kantenzug umgeben sind. */
function edgeQuads(gray: GrayImage, opts: Required<DetectOptions>): Quad[] {
  const closeRadius = Math.max(1, Math.round(Math.max(gray.width, gray.height) / 320));
  const solid = fillFromBorder(edgeMask(gray));
  // Weichzeichnen und Sobel verbreitern die Kante; ohne diese Korrektur läge
  // ein heller Saum der Albumseite mit im Zuschnitt.
  return quadsFromMask(solid, opts, closeRadius + 1, false, false, null, 0);
}

function open(mask: Mask, radius: number): Mask {
  return dilate(erode(mask, radius), radius);
}

/** Aus einer Maske die brauchbaren Vierecke gewinnen. */
function quadsFromMask(
  mask: Mask,
  opts: Required<DetectOptions>,
  inset: number,
  dropBorderTouching: boolean,
  mergeOverlapping: boolean,
  /** Ungeöffnete Maske, aus der die Geometrie stammt (siehe unten). */
  raw: Mask | null,
  reach: number,
): Quad[] {
  const { labels, components } = connectedComponents(mask);
  const totalArea = mask.width * mask.height;
  const minArea = totalArea * opts.minAreaFraction;

  const usable = components.filter(
    (comp) =>
      comp.area >= minArea &&
      comp.area <= totalArea * 0.995 &&
      !(dropBorderTouching && touchesBorder(comp, mask)),
  );

  const groups = mergeOverlapping ? groupOverlapping(usable) : usable.map((comp) => [comp]);
  const results: Quad[] = [];

  for (const group of groups) {
    // Das Öffnen entfernt die Beschriftung, rundet dabei aber die Ecken ab.
    // Für die Form zählt deshalb die ungeöffnete Maske – begrenzt auf die
    // Umgebung der gefundenen Fläche. So kehren die Ecken zurück, ohne dass
    // sich der Zuschnitt an einer danebenstehenden Zeile entlanghangelt.
    const boundary =
      raw === null
        ? group.flatMap((comp) => componentBoundary(labels, mask.width, mask.height, comp))
        : boundaryNear(raw, group, reach);
    const quad = approximateQuad(convexHull(boundary));
    if (!quad) continue;

    const area = polygonArea(quad);
    // Eine L- oder U-Form füllt ihr Viereck nicht aus – solche Flächen sind
    // keine Fotos, sondern Schatten, Beschriftung oder angeschnittene Seiten.
    const filled = group.reduce((sum, comp) => sum + comp.area, 0);
    if (filled < area * 0.62) continue;
    if (!isPlausibleQuad(quad)) continue;

    results.push(insetQuad(quad, inset));
  }
  return results;
}

/** Randpunkte der ungeöffneten Maske im Umkreis der gefundenen Flächen. */
function boundaryNear(raw: Mask, group: Component[], reach: number): Pt[] {
  const minX = Math.max(0, Math.min(...group.map((c) => c.minX)) - reach);
  const maxX = Math.min(raw.width - 1, Math.max(...group.map((c) => c.maxX)) + reach);
  const minY = Math.max(0, Math.min(...group.map((c) => c.minY)) - reach);
  const maxY = Math.min(raw.height - 1, Math.max(...group.map((c) => c.maxY)) + reach);

  const points: Pt[] = [];
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      if (!raw.data[y * raw.width + x]) continue;
      const edge =
        x === minX ||
        y === minY ||
        x === maxX ||
        y === maxY ||
        !raw.data[y * raw.width + x - 1] ||
        !raw.data[y * raw.width + x + 1] ||
        !raw.data[(y - 1) * raw.width + x] ||
        !raw.data[(y + 1) * raw.width + x];
      if (edge) points.push({ x, y });
    }
  }
  return points;
}

/**
 * Fasst Flächen zusammen, die sich überlappen.
 *
 * Ein Foto mit einer hellen, papierfarbenen Stelle – einer Bettdecke, einem
 * blassen Himmel – zerfällt bei der Farbtrennung in mehrere Bruchstücke. Die
 * liegen ineinander; zwei nebeneinanderliegende Fotos tun das nie.
 */
function groupOverlapping(components: Component[]): Component[][] {
  const groups: Component[][] = [];

  for (const comp of components) {
    // Nur kompakte Flächen dürfen verschmelzen. Ein dünner Rand oder Schatten
    // hat ein riesiges umschliessendes Rechteck und würde sonst sämtliche
    // Fotos darin einsammeln.
    const compact = fillRatio(comp) > 0.4;
    const hit = compact
      ? groups.find((group) => group.some((other) => fillRatio(other) > 0.4 && overlapRatio(comp, other) > 0.35))
      : undefined;
    if (hit) hit.push(comp);
    else groups.push([comp]);
  }
  return groups;
}

/** Wie gut eine Fläche ihr umschliessendes Rechteck ausfüllt. */
function fillRatio(comp: Component): number {
  return comp.area / (((comp.maxX - comp.minX + 1) * (comp.maxY - comp.minY + 1)) || 1);
}

/** Überlappung der umschliessenden Rechtecke, bezogen auf das kleinere. */
function overlapRatio(a: Component, b: Component): number {
  const w = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX) + 1;
  const h = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY) + 1;
  if (w <= 0 || h <= 0) return 0;
  const smaller = Math.min(
    (a.maxX - a.minX + 1) * (a.maxY - a.minY + 1),
    (b.maxX - b.minX + 1) * (b.maxY - b.minY + 1),
  );
  return (w * h) / smaller;
}

function touchesBorder(comp: Component, mask: Mask): boolean {
  return comp.minX === 0 || comp.minY === 0 || comp.maxX === mask.width - 1 || comp.maxY === mask.height - 1;
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
  img: RgbaImage,
  quad: Quad,
  parentArea: number,
  depth: number,
  opts: Required<DetectOptions>,
): Quad[] {
  const inner = shrinkQuad(quad, CHILD_INSET);
  const size = outputSize(inner, opts.analysisSize);
  if (size.width < 64 || size.height < 64) return [];

  const warped = warpPerspective(img, inner, size.width, size.height);

  // Nur in Flächen hineinsuchen, die wie eine Albumseite aussehen. Ein Foto
  // besteht aus Bildinhalt, nicht aus gleichmässigem Untergrund – wer darin
  // weitersucht, findet seine Motive statt seiner Ränder.
  if (estimateBackground(warped, toGray(warped)).fraction < PAGE_MIN) return [];

  const found = detectIn(warped, depth + 1, opts);
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

/**
 * Ordnet die Fotos einer weiteren Aufnahme denen der Grundaufnahme zu.
 *
 * Beim Entspiegeln wandert das Telefon zwischen den Aufnahmen, also liegt
 * dasselbe Foto jedes Mal woanders im Bild. Ohne diese Zuordnung würde jede
 * Aufnahme mit dem Viereck der ersten entzerrt – und damit versetzt.
 *
 * Gibt zu jedem Grundviereck das passende Viereck zurück oder `null`, wenn
 * sich keines sicher zuordnen lässt.
 */
export function matchQuads(base: Quad[], candidates: Quad[]): (Quad | null)[] {
  const used = new Set<number>();

  return base.map((reference) => {
    const center = quadCentroid(reference);
    const size = Math.sqrt(polygonArea(reference));
    let best = -1;
    let bestDistance = Infinity;

    candidates.forEach((candidate, index) => {
      if (used.has(index)) return;
      // Ein deutlich anderes Format ist ein anderes Foto, kein verschobenes.
      const candidateSize = Math.sqrt(polygonArea(candidate));
      const ratio = Math.max(candidateSize, size) / Math.min(candidateSize, size);
      if (ratio > 1.35) return;

      const distance = dist(center, quadCentroid(candidate));
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    });

    // Zu weit weg: lieber nichts zuordnen als das falsche Foto verrechnen.
    if (best < 0 || bestDistance > size * 0.45) return null;
    used.add(best);
    return candidates[best];
  });
}
