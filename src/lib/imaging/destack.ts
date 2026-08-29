import { boxBlur, downscaleGray, toGray } from './gray';
import { dilate, erode } from './mask';
import type { Mask } from './mask';
import type { GrayImage, RgbaImage } from './types';
import { createRgba } from './types';

export interface Shift {
  dx: number;
  dy: number;
}

/**
 * Ganzzahlige Verschiebung zwischen zwei Bildern, grob-nach-fein über die
 * Summe der absoluten Differenzen. Reicht, weil die Aufnahmen vorher schon
 * perspektivisch auf dieselbe Fläche entzerrt wurden.
 *
 * Das Ergebnis ist der Offset zum Abgreifen: `moving(x + dx, y + dy)` liegt
 * an derselben Stelle des Motivs wie `ref(x, y)`.
 */
export function estimateShift(ref: GrayImage, moving: GrayImage, maxShift = 24): Shift {
  const coarseRef = downscaleGray(ref, 240).image;
  const coarseMov = downscaleGray(moving, 240).image;
  const factor = ref.width / coarseRef.width;

  const coarse = searchShift(coarseRef, coarseMov, Math.ceil(maxShift / factor), 1);
  const start: Shift = { dx: Math.round(coarse.dx * factor), dy: Math.round(coarse.dy * factor) };
  return searchShift(ref, moving, Math.max(2, Math.round(factor)), 2, start);
}

function searchShift(ref: GrayImage, moving: GrayImage, radius: number, step: number, around: Shift = { dx: 0, dy: 0 }): Shift {
  const { width, height } = ref;
  const marginX = Math.floor(width * 0.2);
  const marginY = Math.floor(height * 0.2);
  let best: Shift = { dx: around.dx, dy: around.dy };
  let bestScore = Infinity;

  for (let dy = around.dy - radius; dy <= around.dy + radius; dy++) {
    for (let dx = around.dx - radius; dx <= around.dx + radius; dx++) {
      let sum = 0;
      let count = 0;
      for (let y = marginY; y < height - marginY; y += step) {
        const my = y + dy;
        if (my < 0 || my >= height) continue;
        for (let x = marginX; x < width - marginX; x += step) {
          const mx = x + dx;
          if (mx < 0 || mx >= width) continue;
          sum += Math.abs(ref.data[y * width + x] - moving.data[my * width + mx]);
          count++;
        }
      }
      if (count === 0) continue;
      const score = sum / count;
      if (score < bestScore) {
        bestScore = score;
        best = { dx, dy };
      }
    }
  }
  return best;
}

/**
 * So hell muss ein verrechneter Bildpunkt noch sein, damit an dieser Stelle
 * überhaupt eine Spiegelung in Frage kommt.
 */
const GLARE_BRIGHT = 206;

/** So farblos: Licht hat keine Farbe, ein Abzug fast immer. */
const GLARE_COLOURLESS = 32;

/** So weit müssen die Aufnahmen an dieser Stelle auseinanderliegen. */
const GLARE_SPREAD = 30;

/**
 * Entspiegelung: Aus mehreren Aufnahmen derselben Fläche wird pro Pixel der
 * mittlere Helligkeitswert übernommen. Eine Spiegelung wandert beim Bewegen
 * des Telefons über das Foto und ist deshalb in jeder Aufnahme an einer
 * anderen Stelle – als heller Ausreisser fällt sie beim Median heraus.
 *
 * Der Median trägt nur so weit, wie die Spiegelung in der Minderheit der
 * Aufnahmen liegt. Wer das Telefon zu wenig bewegt, hat den Glanz in dreien
 * von fünf Aufnahmen an derselben Stelle – dann ist der Median selbst die
 * Spiegelung. Für genau diese Stellen wird nachgebessert: Wo der verrechnete
 * Wert hell und farblos ist und die Aufnahmen weit auseinanderliegen, zählt
 * die dunkelste. Sie rauscht etwas mehr, zeigt aber den Abzug statt der Lampe.
 */
export function mergeFrames(frames: RgbaImage[]): RgbaImage {
  if (frames.length === 0) throw new Error('Keine Aufnahmen zum Zusammenrechnen');
  if (frames.length === 1) return frames[0];

  const ref = frames[0];
  const { width, height } = ref;
  const usable = frames.filter((f) => f.width === width && f.height === height);
  if (usable.length < 2) return ref;

  const refGray = toGray(ref);
  const shifts: Shift[] = [{ dx: 0, dy: 0 }];
  for (let i = 1; i < usable.length; i++) {
    shifts.push(estimateShift(refGray, toGray(usable[i]), 24));
  }

  const out = createRgba(width, height);
  const k = usable.length;
  const lums = new Float32Array(k);
  const order = new Int32Array(k);

  // Für das Nachbessern: die dunkelste Aufnahme je Bildpunkt und die Stellen,
  // an denen sie gebraucht werden könnte.
  const darkest = new Int16Array(width * height).fill(-1);
  const suspect = new Uint8Array(width * height);

  // Ein Randstreifen bleibt vom Nachbessern ausgenommen. Dort zeigen die
  // Aufnahmen unvermeidlich Verschiedenes: Jede ist mit ihrem eigenen Viereck
  // entzerrt, also greift jede am Rand ein Stück weiter ins Umliegende – auf
  // das Albumpapier, das oft heller ist als das Foto. Diese Uneinigkeit sieht
  // einer Spiegelung zum Verwechseln ähnlich, ist aber keine.
  const reach = Math.max(...shifts.map((shift) => Math.max(Math.abs(shift.dx), Math.abs(shift.dy))));
  const margin = Math.max(3, Math.round(Math.min(width, height) * 0.02)) + reach;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let n = 0;
      for (let f = 0; f < k; f++) {
        const sx = x + shifts[f].dx;
        const sy = y + shifts[f].dy;
        if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
        const i = (sy * width + sx) * 4;
        const d = usable[f].data;
        lums[n] = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
        order[n] = f;
        n++;
      }

      const o = (y * width + x) * 4;
      if (n === 0) {
        const i = (y * width + x) * 4;
        out.data[o] = ref.data[i];
        out.data[o + 1] = ref.data[i + 1];
        out.data[o + 2] = ref.data[i + 2];
        out.data[o + 3] = 255;
        continue;
      }

      // Kleines Einfügesortieren nach Helligkeit – n ist typischerweise 3 bis 5.
      for (let a = 1; a < n; a++) {
        const lv = lums[a];
        const ov = order[a];
        let b = a - 1;
        while (b >= 0 && lums[b] > lv) {
          lums[b + 1] = lums[b];
          order[b + 1] = order[b];
          b--;
        }
        lums[b + 1] = lv;
        order[b + 1] = ov;
      }

      if (n === 2) {
        // Bei zwei Aufnahmen ist die dunklere die spiegelungsfreie.
        writePixel(out.data, o, usable[order[0]], x + shifts[order[0]].dx, y + shifts[order[0]].dy, width);
      } else if (n % 2 === 1) {
        const mid = (n - 1) / 2;
        writePixel(out.data, o, usable[order[mid]], x + shifts[order[mid]].dx, y + shifts[order[mid]].dy, width);
      } else {
        const a = n / 2 - 1;
        const b = n / 2;
        const fa = order[a];
        const fb = order[b];
        const ia = ((y + shifts[fa].dy) * width + x + shifts[fa].dx) * 4;
        const ib = ((y + shifts[fb].dy) * width + x + shifts[fb].dx) * 4;
        for (let c = 0; c < 3; c++) {
          out.data[o + c] = (usable[fa].data[ia + c] + usable[fb].data[ib + c]) / 2;
        }
        out.data[o + 3] = 255;
      }

      // Bleibt an dieser Stelle Glanz stehen? Drei Bedingungen zusammen: Der
      // verrechnete Wert ist noch hell, er ist farblos, und die Aufnahmen sind
      // sich uneins. Die dritte ist die wichtigste – wo alle Aufnahmen
      // dasselbe zeigen, ist es das Foto und nicht die Lampe.
      const inside = x >= margin && y >= margin && x < width - margin && y < height - margin;
      if (inside && n >= 3 && lums[n - 1] - lums[0] >= GLARE_SPREAD) {
        const r = out.data[o];
        const g = out.data[o + 1];
        const b = out.data[o + 2];
        const high = r > g ? (r > b ? r : b) : g > b ? g : b;
        const low = r < g ? (r < b ? r : b) : g < b ? g : b;
        if (high >= GLARE_BRIGHT && high - low <= GLARE_COLOURLESS) suspect[y * width + x] = 1;
      }
      if (n > 0) darkest[y * width + x] = order[0];
    }
  }

  return repairGlare(out, usable, shifts, darkest, suspect);
}

/**
 * Ersetzt die stehengebliebenen Glanzflecken durch die dunkelste Aufnahme.
 *
 * Zuerst wird geöffnet: Ein Fleck übersteht das, eine Kante nicht. Das ist
 * nötig, weil zwei Aufnahmen auch dort auseinanderliegen, wo sie nur um einen
 * halben Bildpunkt gegeneinander verschoben sind – an jeder scharfen Kante
 * also. Ohne diesen Schritt zöge sich das Rauschen der dunkelsten Aufnahme
 * über sämtliche Konturen des Fotos.
 *
 * Der Übergang ist weich: Eine harte Grenze zwischen zwei Aufnahmen wäre als
 * Naht zu sehen, auch wenn beide dasselbe zeigen.
 */
function repairGlare(
  merged: RgbaImage,
  frames: RgbaImage[],
  shifts: Shift[],
  darkest: Int16Array,
  suspect: Uint8Array,
): RgbaImage {
  const { width, height } = merged;
  const radius = Math.max(1, Math.round(Math.min(width, height) * 0.008));
  const blobs: Mask = dilate(erode({ data: suspect, width, height }, radius), radius);

  let count = 0;
  for (let i = 0; i < blobs.data.length; i++) if (blobs.data[i]) count++;
  // Nichts gefunden, oder so viel, dass die Annahme nicht mehr stimmt: Dann
  // ist das ganze Bild hell, und die dunkelste Aufnahme wäre nur die
  // dunkelste, nicht die richtige.
  if (count === 0 || count > blobs.data.length * 0.4) return merged;

  const edges: GrayImage = { data: new Uint8Array(width * height), width, height };
  const grown = dilate(blobs, radius);
  for (let i = 0; i < edges.data.length; i++) edges.data[i] = grown.data[i] ? 255 : 0;
  const alpha = boxBlur(boxBlur(edges, radius), radius);

  for (let y = 0, i = 0, o = 0; y < height; y++) {
    for (let x = 0; x < width; x++, i++, o += 4) {
      const weight = alpha.data[i] / 255;
      if (weight === 0) continue;
      const frame = darkest[i];
      if (frame < 0) continue;
      const sx = x + shifts[frame].dx;
      const sy = y + shifts[frame].dy;
      if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
      const from = (sy * width + sx) * 4;
      for (let c = 0; c < 3; c++) {
        merged.data[o + c] = merged.data[o + c] * (1 - weight) + frames[frame].data[from + c] * weight;
      }
    }
  }
  return merged;
}

function writePixel(dst: Uint8ClampedArray, o: number, src: RgbaImage, sx: number, sy: number, width: number): void {
  const i = (sy * width + sx) * 4;
  dst[o] = src.data[i];
  dst[o + 1] = src.data[i + 1];
  dst[o + 2] = src.data[i + 2];
  dst[o + 3] = 255;
}
