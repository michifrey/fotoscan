import { correlate, normalisePatch, sampleClamped, subPixel } from './ncc';
import type { GrayImage, Pt } from './types';

/**
 * Ordnet ein Raster von Teilstücken des einen Bildes dem anderen zu.
 *
 * Das ist der gemeinsame Kern des Blatt-Scans, und er beruht auf einer
 * Erfahrung aus dem ersten Anlauf: **Ein kleiner Bildausschnitt findet in
 * jedem grossen Suchfenster irgendeinen überzeugenden Wert.** Solche Treffer
 * sehen einzeln gut aus und passen erst in der Ausgleichsrechnung nicht mehr
 * zusammen, und ein grösseres Fenster macht es schlechter statt besser.
 *
 * Deshalb sucht hier nichts frei. Der Aufrufer sagt über `predict`, wo er das
 * Teilstück erwartet; gesucht wird nur eine Handbreit darum herum. Ob die
 * Vorhersage aus dem vorigen Vorschaubild stammt oder aus der mitgeführten
 * Lage, ist dieser Funktion gleich – sie verlangt bloss, dass es überhaupt
 * eine gibt.
 */

/** Eine Zuordnung: Stelle im Ausgangsbild, Stelle im Zielbild, Übereinstimmung. */
export interface Pair {
  from: Pt;
  to: Pt;
  score: number;
}

export interface GridOptions {
  /** So viele Teilstücke je Richtung. */
  grid?: number;
  /** Halbe Kantenlänge eines Teilstücks, in Bildpunkten. */
  extent?: number;
  /** Wie weit um die Vorhersage herum gesucht wird, in Bildpunkten. */
  reach?: number;
  /** Ab dieser Übereinstimmung zählt ein Teilstück als zugeordnet. */
  minScore?: number;
  /**
   * Drehung und Massstab, mit denen das Teilstück im Zielbild abgetastet wird.
   * Vorgabe: unverändert. Beim Nachverankern steht die Kachel gegenüber der
   * Übersicht schief, und ohne diese Angabe verglichen würde ein gedrehtes
   * Muster mit einem geraden.
   */
  cos?: number;
  sin?: number;
}

/** Kantenlänge des Musters in Proben. Ungerade, damit es eine Mitte hat. */
const SAMPLES = 11;

/** So viel eines Teilstücks darf über den Bildrand hinausragen. */
const OUTSIDE_SHARE = 0.3;

/**
 * Ab diesem Grauwert gilt ein Bildpunkt als ausgebrannt.
 *
 * Ein Glanzfleck ist nicht bloss hell, er ist am Anschlag – dort steht keine
 * Zeichnung mehr, die sich wiederfinden liesse, sondern eine Scheibe mit
 * harter Kante. Teilstücke, die grösstenteils darin liegen, bleiben aussen vor.
 */
const BURNT = 248;
const BURNT_SHARE = 0.35;

export function matchGrid(
  source: GrayImage,
  target: GrayImage,
  predict: (p: Pt) => Pt,
  options: GridOptions = {},
): Pair[] {
  const grid = options.grid ?? 5;
  const extent = options.extent ?? Math.max(4, Math.min(source.width, source.height) / (grid * 2.4));
  const reach = options.reach ?? 6;
  const minScore = options.minScore ?? 0.5;
  const cos = options.cos ?? 1;
  const sin = options.sin ?? 0;

  const patch = new Float32Array(SAMPLES * SAMPLES);
  const samples = new Float32Array(SAMPLES * SAMPLES);
  const pairs: Pair[] = [];

  for (let gy = 0; gy < grid; gy++) {
    for (let gx = 0; gx < grid; gx++) {
      // Die Mitten liegen so weit innen, dass die Teilstücke ins Bild passen.
      // Ohne diese Einrückung ragt jedes Randstück hinaus, wird zur Hälfte aus
      // festgehaltenen Randwerten gebildet – und die passen überallhin.
      const from: Pt = { x: place(source.width, extent, gx, grid), y: place(source.height, extent, gy, grid) };
      if (!takePatch(source, from, extent, patch)) continue;

      const predicted = predict(from);
      let bestScore = -Infinity;
      let bestX = 0;
      let bestY = 0;
      // Die Werte ringsum werden für die Zwischenstelle gebraucht.
      const scores = new Map<number, number>();

      for (let dy = -reach; dy <= reach; dy++) {
        for (let dx = -reach; dx <= reach; dx++) {
          const score = compare(target, predicted.x + dx, predicted.y + dy, extent, cos, sin, samples, patch);
          scores.set(dy * 1000 + dx, score);
          if (score > bestScore) {
            bestScore = score;
            bestX = dx;
            bestY = dy;
          }
        }
      }
      if (bestScore < minScore) continue;

      const shiftX = between(scores, bestY * 1000 + bestX - 1, bestScore, bestY * 1000 + bestX + 1);
      const shiftY = between(scores, (bestY - 1) * 1000 + bestX, bestScore, (bestY + 1) * 1000 + bestX);

      pairs.push({
        from,
        to: { x: predicted.x + bestX + shiftX, y: predicted.y + bestY + shiftY },
        score: bestScore,
      });
    }
  }
  return pairs;
}

/** Das Muster aus dem Ausgangsbild; `false`, wenn es nichts hergibt. */
function takePatch(source: GrayImage, centre: Pt, extent: number, patch: Float32Array): boolean {
  let outside = 0;
  let burnt = 0;
  for (let j = 0; j < SAMPLES; j++) {
    for (let i = 0; i < SAMPLES; i++) {
      const ox = ((i / (SAMPLES - 1)) * 2 - 1) * extent;
      const oy = ((j / (SAMPLES - 1)) * 2 - 1) * extent;
      const sample = sampleClamped(source, centre.x + ox, centre.y + oy);
      if (sample.outside) outside++;
      if (sample.value >= BURNT) burnt++;
      patch[j * SAMPLES + i] = sample.value;
    }
  }
  if (outside > patch.length * OUTSIDE_SHARE || burnt > patch.length * BURNT_SHARE) return false;
  // Eine strukturlose Stelle – blankes Albumpapier – lässt sich nirgends
  // wiederfinden, und ein Muster ohne Aussage wäre schlimmer als keines.
  return normalisePatch(patch);
}

/** Verteilt die Mitten so, dass ein Teilstück der Grösse `extent` hineinpasst. */
function place(size: number, extent: number, index: number, grid: number): number {
  const inset = Math.min(extent, size / 2 - 1);
  const span = Math.max(0, size - 2 * inset);
  return grid === 1 ? size / 2 : inset + (span * index) / (grid - 1);
}

/**
 * Übereinstimmung an einer Stelle des Zielbildes.
 *
 * Auch hier wird am Rand festgehalten statt aufgegeben – aber gezählt. Ein
 * Vergleich rundweg abzulehnen, sobald eine einzige Probe hinausragt, klingt
 * vorsichtig, ist aber das Gegenteil: Der beste Wert wandert dann zwangsläufig
 * nach innen, weg von der richtigen Stelle, und das fällt nirgends auf.
 */
function compare(
  target: GrayImage,
  cx: number,
  cy: number,
  extent: number,
  cos: number,
  sin: number,
  samples: Float32Array,
  patch: Float32Array,
): number {
  let outside = 0;
  for (let j = 0; j < SAMPLES; j++) {
    for (let i = 0; i < SAMPLES; i++) {
      const ox = ((i / (SAMPLES - 1)) * 2 - 1) * extent;
      const oy = ((j / (SAMPLES - 1)) * 2 - 1) * extent;
      const sample = sampleClamped(target, cx + ox * cos - oy * sin, cy + ox * sin + oy * cos);
      if (sample.outside && ++outside > patch.length * OUTSIDE_SHARE) return -1;
      samples[j * SAMPLES + i] = sample.value;
    }
  }
  return correlate(patch, samples);
}

function between(scores: Map<number, number>, before: number, middle: number, after: number): number {
  const low = scores.get(before);
  const high = scores.get(after);
  return low !== undefined && high !== undefined ? subPixel(low, middle, high) : 0;
}
