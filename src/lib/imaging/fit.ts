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

function multiply(a: number[], b: number[]): number[] {
  const out = new Array<number>(9).fill(0);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) sum += a[r * 3 + k] * b[k * 3 + c];
      out[r * 3 + c] = sum;
    }
  }
  // Auf h₈ = 1 bringen, damit sich Ergebnisse vergleichen lassen.
  return out[8] === 0 ? out : out.map((v) => v / out[8]);
}

function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
