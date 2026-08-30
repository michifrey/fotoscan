import { compose, fitHomographyRobust, residual, scaleMatrix } from './fit';
import { boxBlur, downscaleGray, toGray } from './gray';
import { isPlausibleQuad, polygonArea } from './geometry';
import { matchGrid } from './patches';
import { applyHomography } from './warp';
import type { Pt, Quad, RgbaImage } from './types';

/**
 * Wo liegt das Foto der Seitenaufnahme im Nahaufnahme-Bild?
 *
 * Die bisherige Antwort war eine Annahme: *das grösste erkannte Viereck wird es
 * schon sein*. Sie trägt, solange die Kantensuche im Nahbild das Richtige
 * findet – und wenn nicht, wird mitten durchs Motiv geschnitten, ohne dass
 * jemand es merkt. Ein Zuschnitt, der auf einer Vermutung beruht, ist genau die
 * Sorte Fehler, die erst im Album auffällt.
 *
 * Hier wird stattdessen gefragt, was die Seitenaufnahme schon weiss: Sie zeigt
 * dieses Foto bereits, nur kleiner. Teilstücke davon werden im Nahbild
 * wiedergefunden, und aus den Zuordnungen fällt die Abbildung heraus. Das ist
 * dieselbe Rechnung, die den Blatt-Scan getragen hat (`patches.ts`, `fit.ts`),
 * nur mit einer anderen Vorhersage.
 *
 * Gibt `null` zurück, wenn sich das Foto nicht sicher wiederfinden lässt – etwa
 * weil ein anderes vor der Kamera liegt. Dann bleibt es beim bisherigen Weg
 * über die Kantensuche; lieber ein Rückfall als ein erfundener Zuschnitt.
 */

/** Kantenlänge, auf der gearbeitet wird. */
const WORK_SIZE = 260;

/**
 * Wie viel des Nahbildes das Foto vermutlich füllt. Der Nutzer wird
 * aufgefordert, formatfüllend aufzunehmen; einen Rand lässt jeder.
 */
const FILLS = [0.95, 0.8, 0.65];

export interface LocateOptions {
  /**
   * Die Füllgrade, die durchprobiert werden. Die Vorgabe sucht formatfüllend –
   * das ist die enge Suche für den Auslöser, deren Zuschnitt hinterher gilt.
   * Die Vorschau darf weiter suchen (kleinere Füllgrade), um zu sagen, **wo**
   * das Foto liegt und dass man näher heran muss.
   */
  fills?: number[];
  /** Kleinster und grösster Anteil, den der Fund am Bild haben darf. */
  minShare?: number;
  maxShare?: number;
}

/**
 * Zwei Anläufe: erst grosse Teilstücke mit weitem Fenster, dann kleine mit
 * engem. Grosse Stücke tragen mehr Inhalt und lassen sich kaum verwechseln,
 * verwischen aber die Feinheiten; der zweite Anlauf kennt danach eine Abbildung
 * und darf genau sein.
 */
const PASSES: { extent: number; reach: number }[] = [
  { extent: 1.7, reach: 18 },
  { extent: 1, reach: 6 },
];

/** So viele Teilstücke müssen sich zuordnen lassen … */
const NEEDED = 8;

/** … und dieser Anteil aller gefundenen. */
const NEEDED_SHARE = 0.5;

/** So gut müssen sie im Mittel übereinstimmen. */
const QUALITY = 0.5;

/** So weit darf eine Zuordnung danebenliegen, in Punkten des Arbeitsbildes. */
const TOLERANCE = 3;

/**
 * Das Viereck des Fotos im Nahbild, in dessen Koordinaten.
 *
 * `reference` ist das Foto, wie es aus der Seitenaufnahme geschnitten wurde –
 * entzerrt, also ein Rechteck. `frame` ist das Kamerabild, in dem es
 * formatfüllend liegen soll.
 */
export function locate(reference: RgbaImage, frame: RgbaImage, options: LocateOptions = {}): Quad | null {
  const fills = options.fills ?? FILLS;
  const minShare = options.minShare ?? 0.1;
  const maxShare = options.maxShare ?? 2.2;
  const small = downscaleGray(toGray(reference), WORK_SIZE);
  const shot = downscaleGray(toGray(frame), WORK_SIZE);
  if (Math.min(small.image.width, small.image.height) < 40) return null;
  if (Math.min(shot.image.width, shot.image.height) < 40) return null;

  const source = boxBlur(small.image, 1);
  const target = boxBlur(shot.image, 1);

  let best: { matrix: number[]; quality: number } | null = null;
  for (const fill of fills) {
    const found = tryFill(source, target, fill);
    if (found && (!best || found.quality > best.quality)) best = found;
  }
  if (!best) return null;

  // Zurück in die Koordinaten des vollen Nahbildes: Die Abbildung gilt zwischen
  // den beiden Arbeitsbildern. `scale` ist dabei das Verhältnis Original zu
  // Arbeitsbild, also mindestens eins.
  const matrix = compose(scaleMatrix(shot.scale), compose(best.matrix, scaleMatrix(1 / small.scale)));
  const corners: Pt[] = [
    { x: 0, y: 0 },
    { x: reference.width - 1, y: 0 },
    { x: reference.width - 1, y: reference.height - 1 },
    { x: 0, y: reference.height - 1 },
  ];
  const quad = applyHomography(matrix, corners) as Quad;

  if (quad.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return null;
  if (!isPlausibleQuad(quad)) return null;
  // Ein Foto, das im Nahbild winzig oder riesig herauskommt, ist nicht dieses.
  const share = polygonArea(quad) / (frame.width * frame.height);
  if (share < minShare || share > maxShare) return null;
  return quad;
}

/**
 * Ein Versuch mit der Annahme, dass das Foto diesen Anteil der kurzen Kante
 * des Nahbildes füllt.
 */
function tryFill(
  source: { data: Uint8Array; width: number; height: number },
  target: { data: Uint8Array; width: number; height: number },
  fill: number,
): { matrix: number[]; quality: number } | null {
  // Die Vorhersage: mittig, um den vermuteten Anteil vergrössert.
  const scale =
    Math.min(target.width / source.width, target.height / source.height) * fill;
  const guess = [
    scale,
    0,
    target.width / 2 - (source.width / 2) * scale,
    0,
    scale,
    target.height / 2 - (source.height / 2) * scale,
    0,
    0,
    1,
  ];

  const base = Math.max(4, Math.min(source.width, source.height) / 12);
  let transform = guess;
  let kept: { from: Pt; to: Pt; score: number }[] = [];

  for (const pass of PASSES) {
    const current = transform;
    const pairs = matchGrid(source, target, (p: Pt) => applyHomography(current, [p])[0], {
      extent: base * pass.extent,
      reach: pass.reach,
      minScore: 0.42,
      cos: scale,
      sin: 0,
    });
    if (pairs.length < NEEDED) return null;

    const fitted = fitHomographyRobust(
      pairs.map((pair) => pair.from),
      pairs.map((pair) => pair.to),
    );
    if (!fitted) return null;
    transform = fitted;

    kept = pairs.filter((pair) => residual(fitted, pair.from, pair.to) <= TOLERANCE);
    // Die eigentliche Probe: Passen die Teilstücke zu *einer* Abbildung, war es
    // dasselbe Foto. Streuen sie, lag ein anderes vor der Kamera.
    if (kept.length < Math.max(NEEDED, pairs.length * NEEDED_SHARE)) return null;
  }

  const quality = kept.map((pair) => pair.score).sort((a, b) => a - b)[kept.length >> 1] ?? 0;
  return quality < QUALITY ? null : { matrix: transform, quality };
}
