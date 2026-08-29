import { estimateShift } from './destack';
import { fitAffineRobust, linearScale, residual, rotationOf, scaleMatrix, compose } from './fit';
import { boxBlur, downscaleGray, toGray } from './gray';
import { matchGrid } from './patches';
import { applyHomography } from './warp';
import type { Pt, RgbaImage } from './types';

/**
 * Wie weit sich das Bild seit dem vorigen Vorschaubild bewegt hat.
 *
 * Der Kern des fortlaufenden Mitführens. Bei zehn Bildern je Sekunde ist die
 * Änderung zwischen zweien eine Winzigkeit – und genau darum ist sie
 * verlässlich zu messen, während das Wiederfinden derselben Stelle auf der
 * ganzen Seite es nicht war.
 *
 * Gesucht wird nicht über vier Freiheitsgrade auf einmal. Stattdessen wird ein
 * Raster von Teilstücken einzeln wiedergefunden – jede dieser Suchen ist klein
 * und eindeutig –, und aus den Verschiebungen wird die gemeinsame Bewegung
 * ausgeglichen. Massstab und Drehung fallen dabei ab, statt gesucht werden zu
 * müssen.
 */

/** Kantenlänge, auf der gerechnet wird. */
const WORK_SIZE = 240;

/** Und die gröbere, auf der die Verschiebung des ganzen Bildes gesucht wird. */
const ROUGH_SIZE = 120;

/** Wie weit sich das Bild zwischen zwei Aufnahmen höchstens bewegt haben darf. */
const MAX_SHIFT = 0.22;

/**
 * Die beiden Anläufe: erst grob und weit, dann fein und eng.
 *
 * Die Vorhersage des ersten Anlaufs ist die Verschiebung des *ganzen* Bildes.
 * Was ein einzelnes Teilstück darüber hinaus tut, kommt von Massstab und
 * Drehung – wer sich heranbewegt, ändert den Massstab um einige Prozent je
 * Bild, und am Bildrand macht das mehrere Bildpunkte aus. Der erste Anlauf
 * nimmt darum grössere Teilstücke und ein weiteres Fenster; danach steht eine
 * Affine, und der zweite darf klein und genau sein.
 */
const PASSES: { extent: number; reach: number }[] = [
  { extent: 1.6, reach: 10 },
  { extent: 1, reach: 4 },
];

/** So viele Teilstücke müssen sich zuordnen lassen. */
const NEEDED = 8;

/** So gut müssen sie im Mittel übereinstimmen. */
const QUALITY = 0.6;

/** So weit darf eine Zuordnung nach der Ausgleichsrechnung danebenliegen. */
const TOLERANCE = 2;

/** Was in einem Augenblick an Massstab und Drehung möglich ist. */
const SCALE_RANGE = { low: 0.75, high: 1.33 };
const MAX_ROTATION = 12;

export interface Motion {
  /** Bildet Punkte des vorigen Bildes auf das aktuelle ab. */
  matrix: number[];
  /** Wie viele Teilstücke zusammengepasst haben. */
  matched: number;
  /** Wie gut sie im Mittel übereinstimmen, -1 … 1. */
  score: number;
}

/**
 * Schätzt die Bewegung zwischen zwei aufeinanderfolgenden Vorschaubildern.
 * Beide müssen dieselbe Grösse haben – es ist dieselbe Kamera.
 *
 * Gibt `null` zurück, wenn sich die Bewegung nicht sicher bestimmen lässt:
 * ruckartig bewegt, unscharf, Telefon weggenommen. Eine falsche Bewegung wäre
 * schlimmer als keine, denn sie multipliziert sich in die mitgeführte Lage.
 */
export function estimateMotion(previous: RgbaImage, current: RgbaImage): Motion | null {
  if (previous.width !== current.width || previous.height !== current.height) return null;

  const before = prepare(previous);
  const after = prepare(current);
  if (before.image.width < 48) return null;

  // Erst die Bewegung des ganzen Bildes – sie ist die Vorhersage, um die herum
  // die Teilstücke dann nachjustieren.
  //
  // Gesucht wird auf einer nochmals halbierten Fassung. Die Suche kostet das
  // Quadrat ihrer Reichweite, und eine Reichweite von einem Fünftel der
  // Bildkante auf voller Arbeitsgrösse ist der teuerste Schritt des ganzen
  // Verfahrens – auf der halben Fassung ein Sechzehntel davon. Genauer als ein
  // paar Bildpunkte muss sie ohnehin nicht sein; dafür sind die Teilstücke da.
  const rough = downscaleGray(before.image, ROUGH_SIZE);
  const roughAfter = downscaleGray(after.image, ROUGH_SIZE);
  const found = estimateShift(
    rough.image,
    roughAfter.image,
    Math.round(Math.max(rough.image.width, rough.image.height) * MAX_SHIFT),
  );
  const shift = { dx: found.dx * rough.scale, dy: found.dy * rough.scale };

  // `estimateShift` gibt den Offset zum Abgreifen: Was im vorigen Bild bei
  // (x, y) steht, steht im aktuellen bei (x + dx, y + dy).
  const base = Math.max(4, Math.min(before.image.width, before.image.height) / 12);
  let predict = (p: Pt): Pt => ({ x: p.x + shift.dx, y: p.y + shift.dy });
  let fitted: number[] | null = null;
  let kept: { from: Pt; to: Pt; score: number }[] = [];

  for (const pass of PASSES) {
    const pairs = matchGrid(before.image, after.image, predict, {
      extent: base * pass.extent,
      reach: pass.reach,
      minScore: 0.45,
    });
    if (pairs.length < NEEDED) return null;

    const affine = fitAffineRobust(
      pairs.map((pair) => pair.from),
      pairs.map((pair) => pair.to),
    );
    if (!affine) return null;
    fitted = affine;

    kept = pairs.filter((pair) => residual(affine, pair.from, pair.to) <= TOLERANCE);
    if (kept.length < NEEDED) return null;
    predict = (p: Pt) => {
      const mapped = applyHomography(affine, [p])[0];
      return mapped;
    };
  }
  if (!fitted) return null;

  const quality = kept.map((pair) => pair.score).sort((a, b) => a - b)[kept.length >> 1] ?? 0;
  if (quality < QUALITY) return null;

  const scale = linearScale(fitted);
  if (scale < SCALE_RANGE.low || scale > SCALE_RANGE.high) return null;
  if (Math.abs(rotationOf(fitted)) > MAX_ROTATION) return null;

  // Zurück auf die Grösse der Vorschaubilder: Beide sind um denselben Faktor
  // verkleinert, also steht die Bewegung in denselben Einheiten – nur die
  // Verschiebung wächst mit.
  const factor = before.scale;
  const matrix = compose(scaleMatrix(factor), compose(fitted, scaleMatrix(1 / factor)));

  return { matrix, matched: kept.length, score: quality };
}

/** Graubild in Arbeitsgrösse, leicht geglättet gegen das Rauschen der Kamera. */
function prepare(img: RgbaImage): { image: ReturnType<typeof toGray>; scale: number } {
  const { image, scale } = downscaleGray(toGray(img), WORK_SIZE);
  return { image: boxBlur(image, 1), scale };
}
