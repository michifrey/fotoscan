import { boxBlur, downscaleGray, toGray } from './gray';
import type { Pt, Quad, RgbaImage } from './types';

/**
 * Verfolgt das Motiv – die Albumseite oder das einzelne Foto – über die
 * Aufnahmereihe hinweg.
 *
 * Beim Entspiegeln wandert das Telefon absichtlich. Ohne Bezug zum wirklichen
 * Bild ist aber jede Bewegung gleich viel wert: Wer das Album aus dem Blick
 * verliert, löst trotzdem aus und bekommt vier Aufnahmen vom Tisch. Deshalb
 * wird das Motiv aus der Grundaufnahme als Muster gemerkt und in jedem
 * Vorschaubild wiedergesucht. Das liefert zweierlei: die Stelle, an der die
 * Punkte zu zeichnen sind, und die Antwort auf die Frage, ob überhaupt noch
 * dasselbe Motiv vor der Kamera liegt.
 *
 * Gesucht wird über die normierte Kreuzkorrelation eines kleinen Grauraster-
 * ausschnitts. Die ist unabhängig von Helligkeit und Kontrast – beides ändert
 * sich beim Kippen des Telefons deutlich – und der grobe Raster verzeiht die
 * leichte perspektivische Änderung, die das Neigen mit sich bringt.
 */

/** Kantenlänge des Musters. Grob genug, um Perspektivwechsel zu verzeihen. */
const PATCH = 20;

/** Kantenlänge, auf die das Kamerabild vor der Suche heruntergerechnet wird. */
const SEARCH_SIZE = 192;

/** Ab dieser Übereinstimmung gilt das Motiv als wiedergefunden (-1 … 1). */
export const MIN_SCORE = 0.42;

/** Wie weit das Motiv gewandert sein darf, als Anteil der Bildkante. */
const RANGE = 0.34;

/** Grössenänderungen, die mitgesucht werden – näher heran oder weiter weg. */
const SCALES = [0.78, 0.88, 1, 1.14, 1.3];

/** Anteil des Motivs, der im Bild liegen muss, damit ausgelöst werden darf. */
const MIN_VISIBLE = 0.8;

/** Rechteck im Bild, in Anteilen der Bildkanten: Mitte und halbe Kantenlängen. */
export interface Region {
  cx: number;
  cy: number;
  hx: number;
  hy: number;
}

export interface Subject {
  /** Grauwerte des Musters, mittelwertfrei und auf Länge 1 normiert. */
  patch: Float32Array;
  /** Lage des Musters in der Grundaufnahme. */
  region: Region;
}

export interface Track {
  /** Mitte des Motivs im aktuellen Bild, 0 … 1. */
  center: Pt;
  /** Grösse gegenüber der Grundaufnahme. */
  scale: number;
  /** Übereinstimmung mit dem Muster, -1 … 1. */
  score: number;
  /** Wo das Motiv jetzt liegt – daran hängen die Punkte im Sucher. */
  region: Region;
}

/**
 * Umschliessendes Rechteck der erkannten Fotos. Ohne Erkennung wird die Mitte
 * des Bildes angenommen: Auch dann ist das Muster noch aussagekräftig genug,
 * um ein Wegschwenken der Kamera zu bemerken.
 */
export function regionOf(quads: Quad[], width: number, height: number): Region {
  if (quads.length === 0 || width <= 0 || height <= 0) {
    return { cx: 0.5, cy: 0.5, hx: 0.34, hy: 0.34 };
  }
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const quad of quads) {
    for (const point of quad) {
      if (point.x < minX) minX = point.x;
      if (point.x > maxX) maxX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.y > maxY) maxY = point.y;
    }
  }
  return {
    cx: clamp((minX + maxX) / 2 / width, 0.15, 0.85),
    cy: clamp((minY + maxY) / 2 / height, 0.15, 0.85),
    hx: clamp((maxX - minX) / 2 / width, 0.1, 0.47),
    hy: clamp((maxY - minY) / 2 / height, 0.1, 0.47),
  };
}

/**
 * Merkt sich das Motiv der Grundaufnahme als Muster. Gibt `null` zurück, wenn
 * der Ausschnitt keinerlei Struktur hat – eine leere weisse Fläche lässt sich
 * nicht wiederfinden, und ein Muster ohne Aussage wäre schlimmer als keines.
 */
export function makeSubject(img: RgbaImage, region: Region): Subject | null {
  const gray = prepare(img);
  const raw = new Float32Array(PATCH * PATCH);
  let sum = 0;
  for (let i = 0; i < raw.length; i++) {
    const value = sampleAt(gray, region, i);
    raw[i] = value;
    sum += value;
  }

  const mean = sum / raw.length;
  let norm = 0;
  for (let i = 0; i < raw.length; i++) {
    raw[i] -= mean;
    norm += raw[i] * raw[i];
  }
  norm = Math.sqrt(norm);
  if (norm < 1e-3) return null;
  for (let i = 0; i < raw.length; i++) raw[i] /= norm;

  return { patch: raw, region };
}

/**
 * Sucht das Muster im aktuellen Kamerabild. Erst grob über das ganze
 * Suchfenster, dann fein um die beste Stelle herum.
 */
export function trackSubject(subject: Subject, img: RgbaImage): Track | null {
  const gray = prepare(img);
  const start = subject.region;

  let bestX = start.cx;
  let bestY = start.cy;
  let bestScale = 1;
  let bestScore = -Infinity;

  const consider = (cx: number, cy: number, scale: number) => {
    if (cx < 0.04 || cx > 0.96 || cy < 0.04 || cy > 0.96) return;
    const score = match(subject.patch, gray, { cx, cy, hx: start.hx * scale, hy: start.hy * scale });
    if (score > bestScore) {
      bestScore = score;
      bestX = cx;
      bestY = cy;
      bestScale = scale;
    }
  };

  for (const scale of SCALES) {
    for (let dy = -RANGE; dy <= RANGE + 1e-9; dy += 0.05) {
      for (let dx = -RANGE; dx <= RANGE + 1e-9; dx += 0.05) {
        consider(start.cx + dx, start.cy + dy, scale);
      }
    }
  }
  if (bestScore === -Infinity) return null;

  // Feinsuche: die grobe Rasterweite von fünf Hundertsteln ist auf dem
  // Bildschirm gut sichtbar, die Punkte würden sonst springen.
  const index = SCALES.indexOf(bestScale);
  const coarseX = bestX;
  const coarseY = bestY;
  for (const scale of [SCALES[index - 1] ?? bestScale, bestScale, SCALES[index + 1] ?? bestScale]) {
    for (let dy = -0.04; dy <= 0.04 + 1e-9; dy += 0.0133) {
      for (let dx = -0.04; dx <= 0.04 + 1e-9; dx += 0.0133) {
        consider(coarseX + dx, coarseY + dy, scale);
      }
    }
  }

  return {
    center: { x: bestX, y: bestY },
    scale: bestScale,
    score: bestScore,
    region: { cx: bestX, cy: bestY, hx: start.hx * bestScale, hy: start.hy * bestScale },
  };
}

/**
 * Liegt das Motiv noch sicher vor der Kamera? Nur dann darf ausgelöst werden.
 * Beides muss stimmen: Es muss wiedergefunden worden sein, und es muss noch
 * weitgehend im Bild liegen – ein zur Hälfte angeschnittenes Album ergibt
 * keine brauchbare Aufnahme.
 */
export function inView(track: Track | null): boolean {
  return track !== null && track.score >= MIN_SCORE && visibleFraction(track.region) >= MIN_VISIBLE;
}

/** Anteil des Rechtecks, der innerhalb des Bildes liegt. */
export function visibleFraction(region: Region): number {
  const width = Math.max(0, Math.min(1, region.cx + region.hx) - Math.max(0, region.cx - region.hx));
  const height = Math.max(0, Math.min(1, region.cy + region.hy) - Math.max(0, region.cy - region.hy));
  const total = 2 * region.hx * 2 * region.hy;
  return total <= 0 ? 0 : (width * height) / total;
}

/** Kamerabild auf eine handliche Grösse bringen und glätten. */
function prepare(img: RgbaImage): { data: Uint8Array; width: number; height: number } {
  const { image } = downscaleGray(toGray(img), SEARCH_SIZE);
  return boxBlur(image, 1);
}

/** Grauwert an Rasterpunkt `i` des Ausschnitts, am Bildrand festgehalten. */
function sampleAt(gray: { data: Uint8Array; width: number; height: number }, region: Region, i: number): number {
  const u = (i % PATCH) / (PATCH - 1);
  const v = ((i / PATCH) | 0) / (PATCH - 1);
  const x = (region.cx + (u * 2 - 1) * region.hx) * gray.width;
  const y = (region.cy + (v * 2 - 1) * region.hy) * gray.height;
  const px = clamp(Math.round(x), 0, gray.width - 1);
  const py = clamp(Math.round(y), 0, gray.height - 1);
  return gray.data[py * gray.width + px];
}

/**
 * Normierte Kreuzkorrelation zwischen Muster und Ausschnitt. Das Muster ist
 * bereits mittelwertfrei und auf Länge 1 gebracht; dadurch genügt ein
 * einziger Durchlauf über den Ausschnitt.
 */
function match(
  patch: Float32Array,
  gray: { data: Uint8Array; width: number; height: number },
  region: Region,
): number {
  let dot = 0;
  let sum = 0;
  let squares = 0;
  for (let i = 0; i < patch.length; i++) {
    const value = sampleAt(gray, region, i);
    dot += patch[i] * value;
    sum += value;
    squares += value * value;
  }
  const variance = squares - (sum * sum) / patch.length;
  return variance <= 1e-6 ? 0 : dot / Math.sqrt(variance);
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}
