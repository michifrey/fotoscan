import { compose, fitHomographyRobust, linearScale, residual, rotationOf, scaleMatrix } from './fit';
import { boxBlur, downscaleGray, toGray } from './gray';
import { isPlausibleQuad } from './geometry';
import { matchGrid } from './patches';
import { applyHomography } from './warp';
import type { Motion } from './motion';
import type { GrayImage, Pt, Quad, RgbaImage } from './types';

/**
 * Wo die Kamera gerade auf dem Blatt steht.
 *
 * Die Übersichtsaufnahme ist die Karte; die Lage ist die Abbildung vom
 * Vorschaubild in diese Karte. Sie wird **nie neu gesucht**, sondern
 * mitgeführt – und das ist der ganze Unterschied zum ersten, gescheiterten
 * Anlauf. Der hat jede Kachel für sich auf der ganzen Seite gesucht; ein
 * kleiner Bildausschnitt findet aber in jedem grossen Suchfenster irgendeinen
 * überzeugenden Wert, und solche Treffer passen erst in der Ausgleichsrechnung
 * nicht mehr zusammen.
 *
 * Hier hat jede Schätzung eine gute Vorhersage und darum ein kleines Fenster:
 *
 * - **Anfang.** Direkt nach der Übersichtsaufnahme hat sich die Kamera noch
 *   nicht bewegt; das Vorschaubild *ist* die Übersicht, nur in einer anderen
 *   Auflösung. Damit steht die Anfangslage bis auf eine Nachjustierung fest.
 * - **Weiterführen.** Je Vorschaubild kommt nur die Änderung seit dem vorigen
 *   dazu (siehe `motion.ts`), aufmultipliziert.
 * - **Nachverankern.** Eine Kette von Änderungen läuft weg. Steht das Bild
 *   ruhig, wird die Lage gegen die Übersicht nachjustiert – mit einer kleinen
 *   Suche um die mitgeführte Lage herum.
 */

/**
 * Kantenlänge, auf der die Karte für das Nachverankern gerechnet wird –
 * höchstens so viel, und mindestens so viel.
 *
 * Die Karte wird nicht auf eine feste Grösse gerechnet, sondern auf die
 * **Bodenauflösung des Vorschaubildes**. Ein Vorschaubild ist klein (ein paar
 * hundert Bildpunkte auf die ganze Seite), die Übersichtsaufnahme gross; auf
 * einer festen Karte von 900 Punkten stünde deshalb Struktur, die das
 * Vorschaubild gar nicht hergibt, und beim Vergleich träfe ein weiches
 * Teilstück auf ein scharfes. Genau daran scheiterte die Anfangslage: Sie ist
 * der Fall, in dem das Vorschaubild die ganze Seite zeigt und der Unterschied
 * am grössten ist.
 */
const MAP_SIZE = 900;
const MAP_MIN = 240;

/**
 * Die beiden Anläufe des Nachverankerns: erst grob und weit, dann fein und eng.
 *
 * Die mitgeführte Lage ist weggelaufen – das ist ja der Grund, überhaupt
 * nachzuverankern –, und wie weit, weiss niemand vorher. Der erste Anlauf
 * nimmt deshalb grössere Teilstücke und ein weites Fenster: Grössere Stücke
 * tragen mehr Inhalt und lassen sich kaum verwechseln, auch wenn sie die
 * Feinheiten verwischen. Der zweite kennt danach eine Abbildung und darf klein
 * und genau sein.
 */
const PASSES: { extent: number; reach: number }[] = [
  { extent: 1.7, reach: 0 },
  { extent: 1, reach: 6 },
];

/**
 * Wie weit der erste Anlauf sucht, je nachdem, wie lange nicht verankert wurde.
 *
 * Die Kette sammelt je Bild ein paar Bildpunkte Fehler ein. Wer alle zwei
 * Bilder nachverankert, braucht darum kein weites Fenster – und ein weites
 * Fenster ist nicht nur teuer, es findet auch mehr Falsches. Wer lange nicht
 * verankert hat oder gerade erst wieder auftaucht, braucht es dagegen.
 */
const REACH_BASE = 10;
const REACH_PER_FRAME = 3;
const REACH_MAX = 22;

function reachFor(since: number): number {
  return Math.min(REACH_MAX, REACH_BASE + REACH_PER_FRAME * Math.max(1, since));
}

/** So viele Teilstücke müssen sich zuordnen lassen … */
const NEEDED = 9;

/** … und dieser Anteil aller gefundenen. */
const NEEDED_SHARE = 0.55;

/** So gut müssen sie im Mittel übereinstimmen. */
const QUALITY = 0.55;

/** So weit darf eine Zuordnung danebenliegen, in Kartenpunkten. */
const TOLERANCE = 3;

/** Wie stark die Kachel gegenüber der Übersicht vergrössert sein darf. */
const MAX_DETAIL = 8;

export interface Pose {
  /** Bildet Punkte des Vorschaubildes auf Punkte der Übersicht ab. */
  matrix: number[];
  /** Wie viele Bilder seit der letzten Verankerung dazugekommen sind. */
  since: number;
}

/**
 * Die Anfangslage, direkt nach der Übersichtsaufnahme.
 *
 * Der Ausgangspunkt ist reine Rechnung: Vorschaubild und Übersicht zeigen
 * dasselbe, nur in verschiedenen Auflösungen. Nachjustiert wird trotzdem –
 * zwischen Auslösen und erstem Vorschaubild vergeht ein Augenblick, in dem die
 * Hand nicht stillsteht.
 */
export function startPose(overview: RgbaImage, frame: RgbaImage): Pose | null {
  const guess = scaleMatrix(overview.width / frame.width);
  const matrix = anchor(overview, frame, guess, reachFor(3));
  return matrix ? { matrix, since: 0 } : null;
}

/** Führt die Lage um die Bewegung eines Vorschaubildes weiter. */
export function advance(pose: Pose, motion: Motion): Pose {
  // Die Bewegung bildet das vorige Bild auf das aktuelle ab; gebraucht wird
  // der umgekehrte Weg, denn die Lage geht vom aktuellen Bild in die Karte.
  const back = invert(motion.matrix);
  if (!back) return { ...pose, since: pose.since + 1 };
  return { matrix: compose(pose.matrix, back), since: pose.since + 1 };
}

/**
 * Justiert die mitgeführte Lage gegen die Übersicht nach.
 *
 * Gibt `null` zurück, wenn sich das Bild nicht sicher wiederfinden lässt.
 * Dann bleibt die alte Lage stehen und gilt als weiter weggelaufen – lieber
 * eine ungenaue Lage, die sich als ungenau zu erkennen gibt, als eine falsche,
 * die sich für genau hält.
 */
export function reanchor(overview: RgbaImage, frame: RgbaImage, pose: Pose): Pose | null {
  const matrix = anchor(overview, frame, pose.matrix, reachFor(pose.since));
  return matrix ? { matrix, since: 0 } : null;
}

/** Wo das Vorschaubild gerade auf der Karte liegt. */
export function viewport(pose: Pose, width: number, height: number): Quad {
  const corners: Pt[] = [
    { x: 0, y: 0 },
    { x: width - 1, y: 0 },
    { x: width - 1, y: height - 1 },
    { x: 0, y: height - 1 },
  ];
  return applyHomography(pose.matrix, corners) as Quad;
}

/**
 * Die eigentliche Nachjustierung: Teilstücke des Bildes um ihre vorhergesagte
 * Lage herum in der Übersicht wiederfinden und daraus die Abbildung
 * ausgleichen.
 *
 * Beide Bilder werden auf **dieselbe Bodenauflösung** gebracht. Ohne das
 * verglichen sie Ungleiches: Eine Nahaufnahme löst Korn und Papierfaser auf,
 * die in der Übersicht gar nicht stehen, und dieser Inhalt hat dort kein
 * Gegenstück.
 */
function anchor(overview: RgbaImage, frame: RgbaImage, guess: number[], reach: number): number[] | null {
  const scale = linearScale(guess);
  if (!(scale > 0) || 1 / scale > MAX_DETAIL) return null;

  // Ein Punkt des Vorschaubildes deckt `scale` Punkte der Übersicht ab; die
  // Karte wird deshalb um genau diesen Faktor kleiner gerechnet. Dann tragen
  // beide Seiten dieselbe Struktur.
  const longest = Math.max(overview.width, overview.height);
  const map = downscaleGray(toGray(overview), Math.min(MAP_SIZE, Math.max(MAP_MIN, Math.round(longest / scale))));
  const mapWork = boxBlur(map.image, 1);

  // Ein Punkt des Bildes wird um `scale` auf die Übersicht vergrössert und dort
  // um `map.scale` verkleinert. Auf gleiche Auflösung kommt das Bild, wenn es
  // selbst um genau diesen Faktor verkleinert wird.
  const wanted = Math.max(1, map.scale / scale);
  const target = Math.max(64, Math.round(Math.max(frame.width, frame.height) / wanted));
  const small = downscaleGray(toGray(frame), Math.min(target, Math.max(frame.width, frame.height)));
  const frameWork = boxBlur(small.image, 1);
  if (frameWork.width < 48) return null;

  // Die Vermutung in die Arbeitskoordinaten übersetzen.
  const local = compose(scaleMatrix(1 / map.scale), compose(guess, scaleMatrix(small.scale)));
  const rotation = (rotationOf(local) * Math.PI) / 180;
  const linear = linearScale(local);

  const base = Math.max(4, Math.min(frameWork.width, frameWork.height) / 12);
  let transform = local;
  let kept: { from: Pt; to: Pt; score: number }[] = [];

  for (const pass of PASSES) {
    const current = transform;
    const pairs = matchGrid(frameWork, mapWork, (p: Pt) => applyHomography(current, [p])[0], {
      extent: base * pass.extent,
      reach: pass.reach || reach,
      minScore: 0.45,
      cos: Math.cos(rotation) * linear,
      sin: Math.sin(rotation) * linear,
    });
    if (pairs.length < NEEDED) return null;

    const fitted = fitHomographyRobust(
      pairs.map((pair) => pair.from),
      pairs.map((pair) => pair.to),
    );
    if (!fitted) return null;
    transform = fitted;

    kept = pairs.filter((pair) => residual(fitted, pair.from, pair.to) <= TOLERANCE);
    // Die eigentliche Probe: Passen die Teilstücke zu *einer* Abbildung, war
    // es dieselbe Stelle. Streuen sie, hat die Vorhersage danebengelegen –
    // dann lieber gar nichts, denn eine falsche Lage merkt niemand.
    if (kept.length < Math.max(NEEDED, pairs.length * NEEDED_SHARE)) return null;
  }

  const quality = kept.map((pair) => pair.score).sort((a, b) => a - b)[kept.length >> 1] ?? 0;
  if (quality < QUALITY) return null;
  const fitted = transform;

  // Und zurück in die Koordinaten von Bild und Übersicht.
  const matrix = compose(scaleMatrix(map.scale), compose(fitted, scaleMatrix(1 / small.scale)));
  const check = viewport({ matrix, since: 0 }, frame.width, frame.height);
  return isPlausibleQuad(check) ? matrix : null;
}

/** Kehrwert einer 3×3-Abbildung. */
export function invert(m: number[]): number[] | null {
  const a = m[4] * m[8] - m[5] * m[7];
  const b = m[5] * m[6] - m[3] * m[8];
  const c = m[3] * m[7] - m[4] * m[6];
  const det = m[0] * a + m[1] * b + m[2] * c;
  if (Math.abs(det) < 1e-12) return null;

  return [
    a / det,
    (m[2] * m[7] - m[1] * m[8]) / det,
    (m[1] * m[5] - m[2] * m[4]) / det,
    b / det,
    (m[0] * m[8] - m[2] * m[6]) / det,
    (m[2] * m[3] - m[0] * m[5]) / det,
    c / det,
    (m[1] * m[6] - m[0] * m[7]) / det,
    (m[0] * m[4] - m[1] * m[3]) / det,
  ];
}

/** Nur damit der Typ von `prepare` in `motion.ts` und hier derselbe bleibt. */
export type Work = GrayImage;
