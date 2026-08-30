import { snapToPrint, trueAspect } from './aspect';
import { dist } from './geometry';
import type { GrayImage, Pt, Quad, RgbaImage } from './types';
import { createRgba } from './types';

/**
 * Homographie, die src auf dst abbildet. Gelöst als lineares 8x8-System mit
 * Gauss-Elimination und Spaltenpivotisierung.
 */
export function computeHomography(src: Quad, dst: Quad): number[] {
  const a: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    a.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }

  const n = 8;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    }
    if (Math.abs(a[pivot][col]) < 1e-12) throw new Error('Viereck ist entartet');
    [a[col], a[pivot]] = [a[pivot], a[col]];
    [b[col], b[pivot]] = [b[pivot], b[col]];

    const d = a[col][col];
    for (let k = col; k < n; k++) a[col][k] /= d;
    b[col] /= d;

    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const f = a[row][col];
      if (f === 0) continue;
      for (let k = col; k < n; k++) a[row][k] -= f * a[col][k];
      b[row] -= f * b[col];
    }
  }
  return [b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], 1];
}

/**
 * Ausgabegrösse für ein Viereck.
 *
 * Die **Fläche** kommt von der längeren der jeweils gegenüberliegenden Seiten,
 * damit beim Entzerren keine Bildpunkte verloren gehen. Das **Verhältnis** von
 * Breite zu Höhe stammt dagegen aus `trueAspect`, sobald die Grösse der
 * Aufnahme mitgegeben wird: Unter Perspektive ist die nahe Kante länger als die
 * ferne, und keine der beiden ist die wahre. Über Neigungen bis 40° liegt die
 * Kantenmethode im Mittel zehn Prozent daneben, im Einzelfall mehr.
 *
 * Übernommen wird die Rückrechnung allerdings nur, wenn sie den Prüfstand in
 * `plausible` besteht – an echten, ein paar Punkte verrutschten Ecken ist sie
 * nicht von selbst vertrauenswürdig. Sonst, und ohne `frame`, bleibt es bei den
 * Kanten; bei der frontalen Aufnahme sind die ohnehin exakt.
 */
export function outputSize(
  quad: Quad,
  maxDim = 3600,
  frame?: { width: number; height: number },
): { width: number; height: number } {
  const along = Math.max(dist(quad[0], quad[1]), dist(quad[3], quad[2]));
  const across = Math.max(dist(quad[0], quad[3]), dist(quad[1], quad[2]));
  const ratio = plausible(frame ? trueAspect(quad, frame.width, frame.height) : null, along / across);

  // Die Fläche bleibt, wie die Kanten sie vorgeben; nur ihre Aufteilung wird
  // korrigiert. So verliert die Entzerrung keine Auflösung, egal in welche
  // Richtung das Verhältnis wandert.
  const [width, height] = ratio
    ? (() => {
        const area = along * across;
        const h = Math.sqrt(area / ratio);
        return [h * ratio, h];
      })()
    : [along, across];
  let w = Math.max(16, Math.round(width));
  let h = Math.max(16, Math.round(height));
  const longest = Math.max(w, h);
  if (longest > maxDim) {
    const f = maxDim / longest;
    w = Math.round(w * f);
    h = Math.round(h * f);
  }
  return { width: w, height: h };
}

/**
 * Was von der zurückgerechneten Schätzung übrig bleibt, wenn man ihr nicht
 * blind glaubt.
 *
 * Die Rechnung ist auf dem Papier exakt – an einer gerechneten Kamera trifft
 * sie auf ein Hundertstel Prozent. An echten Ecken ist sie das nicht: Die
 * Fluchtpunkte liegen weit ausserhalb des Bildes, und ein paar Punkte Versatz
 * an einer Ecke verschieben sie um ein Vielfaches. Gemessen, bei zwei Punkten
 * Rauschen: nur noch 72 % brauchbar, 1,7 % grob falsch; bei vier Punkten 48 %
 * und 4,4 %. An einer echten Albumseite kam für einen Abzug **2,8:1** heraus –
 * ein Format, das es nicht gibt.
 *
 * Deshalb zwei Bedingungen. Erstens muss die Schätzung nah an einem
 * **Abzugsformat** liegen; damit wird aus einer verrauschten Zahl eine
 * Entscheidung zwischen wenigen bekannten Werten. Zweitens darf sie nicht
 * weiter als ein Viertel von dem abweichen, was die Kanten sagen – sonst ist
 * nicht die Kantenmethode schief, sondern die Rechnung entgleist.
 *
 * Gemessen über echte Formate, die **nicht** in der Liste stehen (9×13 gegen
 * eine Liste ohne 9×13), bei Neigungen bis 40°:
 *
 * | Ecken-Rauschen | besser | schlechter | mittlerer Fehler |
 * | --- | --- | --- | --- |
 * | 1 Punkt | 85 % | 5 % | 10,4 % → 3,1 % |
 * | 3 Punkte | 65 % | 12 % | 10,3 % → 5,7 % |
 * | 6 Punkte | 44 % | 16 % | 10,3 % → 7,6 % |
 */
function plausible(estimate: number | null, byEdges: number): number | null {
  if (estimate === null) return null;
  const snapped = snapToPrint(estimate);
  if (snapped === null) return null;
  return Math.abs(snapped - byEdges) / byEdges < 0.25 ? snapped : null;
}

/**
 * Perspektivische Entzerrung mit bilinearer Interpolation. Rückwärtsabbildung:
 * für jedes Zielpixel wird die Quellposition berechnet.
 */
export function warpPerspective(src: RgbaImage, quad: Quad, width: number, height: number): RgbaImage {
  const dstQuad: Quad = [
    { x: 0, y: 0 },
    { x: width - 1, y: 0 },
    { x: width - 1, y: height - 1 },
    { x: 0, y: height - 1 },
  ];
  const h = computeHomography(dstQuad, quad);
  const out = createRgba(width, height);
  const sw = src.width;
  const sh = src.height;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const denom = h[6] * x + h[7] * y + h[8];
      const sx = (h[0] * x + h[1] * y + h[2]) / denom;
      const sy = (h[3] * x + h[4] * y + h[5]) / denom;
      const o = (y * width + x) * 4;

      if (sx < 0 || sy < 0 || sx > sw - 1 || sy > sh - 1) {
        out.data[o + 3] = 255;
        continue;
      }

      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const x1 = Math.min(x0 + 1, sw - 1);
      const y1 = Math.min(y0 + 1, sh - 1);
      const fx = sx - x0;
      const fy = sy - y0;
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;

      const i00 = (y0 * sw + x0) * 4;
      const i10 = (y0 * sw + x1) * 4;
      const i01 = (y1 * sw + x0) * 4;
      const i11 = (y1 * sw + x1) * 4;

      for (let c = 0; c < 3; c++) {
        out.data[o + c] =
          src.data[i00 + c] * w00 + src.data[i10 + c] * w10 + src.data[i01 + c] * w01 + src.data[i11 + c] * w11;
      }
      out.data[o + 3] = 255;
    }
  }
  return out;
}

/** Dreht ein Bild in 90-Grad-Schritten. */
export function rotate(src: RgbaImage, quarterTurns: number): RgbaImage {
  const turns = ((quarterTurns % 4) + 4) % 4;
  if (turns === 0) return src;
  const swap = turns % 2 === 1;
  const width = swap ? src.height : src.width;
  const height = swap ? src.width : src.height;
  const out = createRgba(width, height);

  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      let nx: number;
      let ny: number;
      if (turns === 1) {
        nx = src.height - 1 - y;
        ny = x;
      } else if (turns === 2) {
        nx = src.width - 1 - x;
        ny = src.height - 1 - y;
      } else {
        nx = y;
        ny = src.width - 1 - x;
      }
      const from = (y * src.width + x) * 4;
      const to = (ny * width + nx) * 4;
      out.data[to] = src.data[from];
      out.data[to + 1] = src.data[from + 1];
      out.data[to + 2] = src.data[from + 2];
      out.data[to + 3] = src.data[from + 3];
    }
  }
  return out;
}

/** Perspektivische Entzerrung eines Graubildes, bilinear interpoliert. */
export function warpGray(src: GrayImage, quad: Quad, width: number, height: number): GrayImage {
  const dstQuad: Quad = [
    { x: 0, y: 0 },
    { x: width - 1, y: 0 },
    { x: width - 1, y: height - 1 },
    { x: 0, y: height - 1 },
  ];
  const h = computeHomography(dstQuad, quad);
  const data = new Uint8Array(width * height);
  const sw = src.width;
  const sh = src.height;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const denom = h[6] * x + h[7] * y + h[8];
      const sx = (h[0] * x + h[1] * y + h[2]) / denom;
      const sy = (h[3] * x + h[4] * y + h[5]) / denom;
      if (sx < 0 || sy < 0 || sx > sw - 1 || sy > sh - 1) continue;

      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const x1 = Math.min(x0 + 1, sw - 1);
      const y1 = Math.min(y0 + 1, sh - 1);
      const fx = sx - x0;
      const fy = sy - y0;
      data[y * width + x] =
        src.data[y0 * sw + x0] * (1 - fx) * (1 - fy) +
        src.data[y0 * sw + x1] * fx * (1 - fy) +
        src.data[y1 * sw + x0] * (1 - fx) * fy +
        src.data[y1 * sw + x1] * fx * fy;
    }
  }
  return { data, width, height };
}

/** Bildet Punkte mit einer Homographie ab. */
export function applyHomography(h: number[], pts: Pt[]): Pt[] {
  return pts.map((p) => {
    const denom = h[6] * p.x + h[7] * p.y + h[8];
    return { x: (h[0] * p.x + h[1] * p.y + h[2]) / denom, y: (h[3] * p.x + h[4] * p.y + h[5]) / denom };
  });
}

/** Schrumpft ein Viereck zum Schwerpunkt hin. */
export function shrinkQuad(quad: Quad, fraction: number): Quad {
  const cx = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4;
  const cy = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4;
  const f = 1 - fraction;
  return quad.map((p) => ({ x: cx + (p.x - cx) * f, y: cy + (p.y - cy) * f })) as Quad;
}
