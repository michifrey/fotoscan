import type { Pt } from './types';

/**
 * Homographie aus mehr als vier Punktpaaren.
 *
 * `computeHomography` in `warp.ts` löst den bestimmten Fall: genau vier Paare,
 * genau acht Unbekannte, eine einzige Lösung. Beim Wiederfinden einer Kachel
 * fallen aber ein Dutzend Zuordnungen an, jede mit ihrem eigenen kleinen
 * Fehler. Aus vieren davon vier auszuwählen hiesse, alle übrigen wegzuwerfen –
 * und die Wahl entschiede über das Ergebnis. Gesucht ist stattdessen die
 * Abbildung, die zu allen zusammen am besten passt.
 */

/** Ab so vielen Paaren lohnt die Ausgleichsrechnung; darunter ist sie bestimmt. */
const MIN_POINTS = 4;

/**
 * Ausgleichsrechnung über die Normalgleichungen.
 *
 * Die Punkte werden vorher normiert – Schwerpunkt in den Ursprung, mittlerer
 * Abstand auf die Wurzel aus zwei. Ohne das steht in derselben Matrix eine
 * Spalte mit Werten um 1 neben einer mit Werten um 3000², und die Elimination
 * verliert an den kleinen Zahlen ihre Genauigkeit. Der Schritt kostet nichts
 * und ist der Unterschied zwischen brauchbar und unbrauchbar.
 */
export function fitHomography(from: Pt[], to: Pt[]): number[] | null {
  if (from.length !== to.length || from.length < MIN_POINTS) return null;

  const src = normalise(from);
  const dst = normalise(to);
  if (!src || !dst) return null;

  // A^T·A und A^T·b aufsummieren, ohne A je aufzustellen: Jedes Punktpaar
  // liefert zwei Zeilen, die sofort in die 8×8-Matrix einfliessen.
  const ata = Array.from({ length: 8 }, () => new Float64Array(8));
  const atb = new Float64Array(8);
  const row = new Float64Array(8);

  for (let i = 0; i < src.points.length; i++) {
    const { x, y } = src.points[i];
    const { x: u, y: v } = dst.points[i];

    fillRow(row, x, y, 1, 0, -u * x, -u * y, true);
    accumulate(ata, atb, row, u);
    fillRow(row, x, y, 0, 1, -v * x, -v * y, false);
    accumulate(ata, atb, row, v);
  }

  const h = solve(ata, atb);
  if (!h) return null;

  // Zurück in die ursprünglichen Koordinaten: H = T_dst⁻¹ · H' · T_src.
  const normalised = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  return multiply(inverseSimilarity(dst.transform), multiply(normalised, src.transform));
}

/**
 * Dasselbe, aber unempfindlich gegen einzelne falsche Zuordnungen.
 *
 * Beim Wiederfinden greift hin und wieder ein Teilstück daneben – ein
 * wiederkehrendes Muster im Bild, eine Stelle ohne Struktur. Ein einziger
 * solcher Ausreisser zieht die Ausgleichsrechnung sichtbar schief, denn sie
 * mittelt Quadrate. Deshalb wird zweimal gerechnet: erst über alle, dann noch
 * einmal ohne die, die weit danebenliegen.
 */
export function fitHomographyRobust(from: Pt[], to: Pt[]): number[] | null {
  const first = fitHomography(from, to);
  if (!first || from.length <= MIN_POINTS + 1) return first;

  const errors = from.map((point, i) => residual(first, point, to[i]));
  const limit = Math.max(1.5, 2.5 * median(errors));

  const keptFrom: Pt[] = [];
  const keptTo: Pt[] = [];
  for (let i = 0; i < from.length; i++) {
    if (errors[i] > limit) continue;
    keptFrom.push(from[i]);
    keptTo.push(to[i]);
  }
  // Bleiben zu wenige übrig, ist nicht ein Ausreisser das Problem, sondern die
  // ganze Zuordnung. Dann ist das erste Ergebnis so gut wie jedes andere.
  if (keptFrom.length < MIN_POINTS || keptFrom.length < from.length * 0.5) return first;

  return fitHomography(keptFrom, keptTo) ?? first;
}

/**
 * Dasselbe für eine Affine: sechs Freiheitsgrade statt acht.
 *
 * Zwischen zwei Vorschaubildern liegt der Bruchteil einer Sekunde. Eine
 * Homographie über diese kurze Strecke zu legen heisst, aus einer winzigen
 * Bewegung auch noch die Perspektive lesen zu wollen – die beiden letzten
 * Freiheitsgrade sind dann kaum bestimmt und tragen vor allem Rauschen. Und
 * dieses Rauschen bliebe nicht folgenlos: Es multipliziert sich Bild für Bild
 * in die mitgeführte Lage hinein. Verschiebung, Drehung, Massstab und Scherung
 * reichen für einen Augenblick Bewegung vollkommen.
 */
export function fitAffine(from: Pt[], to: Pt[]): number[] | null {
  if (from.length !== to.length || from.length < 3) return null;

  const src = normalise(from);
  const dst = normalise(to);
  if (!src || !dst) return null;

  // Die beiden Zeilen der Affine sind voneinander unabhängig: x' hängt nur von
  // (x, y, 1) ab, y' ebenso. Statt eines 6×6-Systems also zweimal dasselbe
  // 3×3-System mit verschiedenen rechten Seiten.
  const ata = [new Float64Array(3), new Float64Array(3), new Float64Array(3)];
  const atx = new Float64Array(3);
  const aty = new Float64Array(3);

  for (let i = 0; i < src.points.length; i++) {
    const row = [src.points[i].x, src.points[i].y, 1];
    for (let a = 0; a < 3; a++) {
      atx[a] += row[a] * dst.points[i].x;
      aty[a] += row[a] * dst.points[i].y;
      for (let b = 0; b < 3; b++) ata[a][b] += row[a] * row[b];
    }
  }

  const first = solveSmall(ata, atx);
  const second = solveSmall(ata, aty);
  if (!first || !second) return null;

  const normalised = [first[0], first[1], first[2], second[0], second[1], second[2], 0, 0, 1];
  return compose(inverseSimilarity(dst.transform), compose(normalised, src.transform));
}

/** Die Affine, unempfindlich gegen einzelne falsche Zuordnungen. */
export function fitAffineRobust(from: Pt[], to: Pt[]): number[] | null {
  const first = fitAffine(from, to);
  if (!first || from.length <= 4) return first;

  const errors = from.map((point, i) => residual(first, point, to[i]));
  const limit = Math.max(1, 2.5 * median(errors));

  const keptFrom: Pt[] = [];
  const keptTo: Pt[] = [];
  for (let i = 0; i < from.length; i++) {
    if (errors[i] > limit) continue;
    keptFrom.push(from[i]);
    keptTo.push(to[i]);
  }
  if (keptFrom.length < 3 || keptFrom.length < from.length * 0.5) return first;

  return fitAffine(keptFrom, keptTo) ?? first;
}

/**
 * Verkettung zweier Abbildungen: erst `b`, dann `a`.
 *
 * Ohne Normierung auf h₈ = 1, anders als beim Lösen der Gleichungssysteme.
 * Die mitgeführte Lage entsteht, indem Bild für Bild eine Bewegung
 * aufmultipliziert wird; würde dabei jedes Mal normiert, hinge das Ergebnis an
 * einer Zahl, die für eine Affine ohnehin eins ist und für eine Homographie
 * beliebig sein darf.
 */
export function compose(a: number[], b: number[]): number[] {
  const out = new Array<number>(9).fill(0);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) sum += a[r * 3 + k] * b[k * 3 + c];
      out[r * 3 + c] = sum;
    }
  }
  return out;
}

/** Abbildung, die alle Koordinaten um `factor` streckt. */
export function scaleMatrix(factor: number): number[] {
  return [factor, 0, 0, 0, factor, 0, 0, 0, 1];
}

/**
 * Der Massstab einer Abbildung: wie stark sie Flächen vergrössert, als Länge.
 * Aus der Determinante des linearen Teils, also unabhängig von der Drehung.
 */
export function linearScale(m: number[]): number {
  return Math.sqrt(Math.abs(m[0] * m[4] - m[1] * m[3]));
}

/** Drehung einer Abbildung in Grad. */
export function rotationOf(m: number[]): number {
  return (Math.atan2(m[3], m[0]) * 180) / Math.PI;
}

/** Abstand zwischen abgebildetem und gemessenem Punkt. */
export function residual(h: number[], from: Pt, to: Pt): number {
  const denom = h[6] * from.x + h[7] * from.y + h[8];
  if (Math.abs(denom) < 1e-12) return Infinity;
  return Math.hypot((h[0] * from.x + h[1] * from.y + h[2]) / denom - to.x, (h[3] * from.x + h[4] * from.y + h[5]) / denom - to.y);
}

function fillRow(row: Float64Array, x: number, y: number, one: number, two: number, g: number, hh: number, first: boolean): void {
  row[0] = first ? x : 0;
  row[1] = first ? y : 0;
  row[2] = one;
  row[3] = first ? 0 : x;
  row[4] = first ? 0 : y;
  row[5] = two;
  row[6] = g;
  row[7] = hh;
}

function accumulate(ata: Float64Array[], atb: Float64Array, row: Float64Array, value: number): void {
  for (let i = 0; i < 8; i++) {
    if (row[i] === 0) continue;
    atb[i] += row[i] * value;
    for (let j = 0; j < 8; j++) ata[i][j] += row[i] * row[j];
  }
}

/** Gauss-Elimination mit Spaltenpivotisierung, wie in `warp.ts`. */
function solve(a: Float64Array[], b: Float64Array): Float64Array | null {
  const n = 8;
  const m = a.map((r) => Float64Array.from(r));
  const rhs = Float64Array.from(b);

  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    if (Math.abs(m[pivot][col]) < 1e-12) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    const t = rhs[col];
    rhs[col] = rhs[pivot];
    rhs[pivot] = t;

    const d = m[col][col];
    for (let k = col; k < n; k++) m[col][k] /= d;
    rhs[col] /= d;

    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r][col];
      if (f === 0) continue;
      for (let k = col; k < n; k++) m[r][k] -= f * m[col][k];
      rhs[r] -= f * rhs[col];
    }
  }
  return rhs;
}

interface Normalised {
  points: Pt[];
  /** Die angewandte Ähnlichkeit, als 3×3-Matrix in Zeilenform. */
  transform: number[];
}

function normalise(points: Pt[]): Normalised | null {
  let cx = 0;
  let cy = 0;
  for (const p of points) {
    cx += p.x;
    cy += p.y;
  }
  cx /= points.length;
  cy /= points.length;

  let spread = 0;
  for (const p of points) spread += Math.hypot(p.x - cx, p.y - cy);
  spread /= points.length;
  if (!(spread > 1e-9)) return null;

  const s = Math.SQRT2 / spread;
  return {
    points: points.map((p) => ({ x: (p.x - cx) * s, y: (p.y - cy) * s })),
    transform: [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1],
  };
}

/** Kehrwert einer Ähnlichkeit der Form [s,0,tx, 0,s,ty, 0,0,1]. */
function inverseSimilarity(t: number[]): number[] {
  const s = t[0];
  return [1 / s, 0, -t[2] / s, 0, 1 / s, -t[5] / s, 0, 0, 1];
}

/** Verkettung, danach auf h₈ = 1 gebracht, damit sich Ergebnisse vergleichen lassen. */
function multiply(a: number[], b: number[]): number[] {
  const out = compose(a, b);
  return out[8] === 0 ? out : out.map((v) => v / out[8]);
}

/** Gauss-Elimination für das kleine 3×3-System der Affine. */
function solveSmall(a: Float64Array[], b: Float64Array): Float64Array | null {
  const m = a.map((r) => Float64Array.from(r));
  const rhs = Float64Array.from(b);

  for (let col = 0; col < 3; col++) {
    let pivot = col;
    for (let r = col + 1; r < 3; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    if (Math.abs(m[pivot][col]) < 1e-12) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    const t = rhs[col];
    rhs[col] = rhs[pivot];
    rhs[pivot] = t;

    const d = m[col][col];
    for (let k = col; k < 3; k++) m[col][k] /= d;
    rhs[col] /= d;

    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = m[r][col];
      if (f === 0) continue;
      for (let k = col; k < 3; k++) m[r][k] -= f * m[col][k];
      rhs[r] -= f * rhs[col];
    }
  }
  return rhs;
}

function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
