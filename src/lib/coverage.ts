import { polygonArea, quadCentroid } from './imaging/geometry';
import type { Pt, Quad } from './imaging/types';

/**
 * Was auf dem Blatt noch fehlt.
 *
 * Ein grobes Raster über die Übersichtsaufnahme. Es beantwortet die einzige
 * Frage, die den Nutzer beim Abfahren interessiert – *wo muss ich noch hin?* –
 * und die einzige, die den Selbstauslöser interessiert: *bringt eine Aufnahme
 * hier überhaupt etwas?*
 *
 * Zwei Entscheidungen stecken darin:
 *
 * - **Gebraucht wird nur, wo Fotos sind.** Die Erkennung hat sie auf der
 *   Übersicht bereits gefunden. Blankes Albumpapier in Nahaufnahme braucht
 *   niemand, und es abzufahren wäre nicht nur vergeudete Zeit – strukturloses
 *   Papier lässt sich auch gar nicht wiederfinden.
 * - **Ein zweiter Durchgang nur, wo es glänzt.** Der Glanz wandert mit der
 *   Kameraposition; ihn herauszurechnen verlangt zwei Aufnahmen derselben
 *   Stelle aus verschiedenen Richtungen. Das überall zu verlangen wäre die
 *   doppelte Mühe für nichts – die meisten Stellen glänzen gar nicht.
 */

/** Kantenlänge des Rasters: so viele Felder auf der langen Seite. */
const CELLS = 20;

/**
 * So weit muss die Kamera zwischen zwei Aufnahmen derselben Stelle gewandert
 * sein, damit die zweite als eigener Blickwinkel zählt – als Anteil der
 * Bildbreite. Zweimal von derselben Stelle aufgenommen zeigt denselben Glanz.
 */
const APART = 0.12;

export interface Cell {
  /** Liegt hier ein Foto? Nur dann muss diese Stelle abgefahren werden. */
  needed: boolean;
  /** Beste bisher erreichte Auflösung, als Vielfaches der Übersicht. */
  detail: number;
  /** Hat eine Kachel hier Glanz gezeigt? */
  glare: boolean;
  /** Aus welchen Kamerapositionen diese Stelle getroffen wurde. */
  seen: Pt[];
}

export interface Coverage {
  cols: number;
  rows: number;
  cells: Cell[];
  /** Größe der Übersicht, auf die sich das Raster bezieht. */
  width: number;
  height: number;
  /** Ab dieser Auflösung gilt eine Stelle als scharf genug. */
  target: number;
}

/** Legt das Raster über die Übersicht und markiert, wo Fotos liegen. */
export function coverageFor(quads: Quad[], width: number, height: number, target: number): Coverage {
  const cols = width >= height ? CELLS : Math.max(4, Math.round((CELLS * width) / height));
  const rows = width >= height ? Math.max(4, Math.round((CELLS * height) / width)) : CELLS;

  const cells: Cell[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const centre = { x: ((col + 0.5) / cols) * width, y: ((row + 0.5) / rows) * height };
      cells.push({
        needed: quads.some((quad) => contains(quad, centre)),
        detail: 0,
        glare: false,
        seen: [],
      });
    }
  }
  return { cols, rows, cells, width, height, target };
}

/**
 * Trägt eine Aufnahme ein: welchen Ausschnitt sie zeigte, wie fein, und ob
 * darauf Glanz lag.
 *
 * `glare` bezieht sich auf die ganze Kachel, nicht auf einzelne Felder. Das ist
 * grob, aber ehrlich: Wo eine Kachel glänzt, ist der Glanz meist ein Fleck von
 * beträchtlicher Grösse, und ihn feiner zu verorten hiesse, sich auf eine
 * Genauigkeit zu verlassen, die die Erkennung nicht hergibt.
 */
export function record(coverage: Coverage, viewport: Quad, detail: number, glare: boolean): Coverage {
  const from = quadCentroid(viewport);
  const cells = coverage.cells.map((cell, index) => {
    const centre = centreOf(coverage, index);
    if (!contains(viewport, centre)) return cell;

    const seen = cell.seen.some((old) => apart(old, from, coverage.width) < APART) ? cell.seen : [...cell.seen, from];
    return {
      ...cell,
      detail: Math.max(cell.detail, detail),
      glare: cell.glare || glare,
      seen,
    };
  });
  return { ...coverage, cells };
}

/**
 * Ist diese Stelle fertig? Scharf genug – und wo es glänzte, aus einer zweiten
 * Richtung gesehen.
 */
export function settled(cell: Cell, target: number): boolean {
  if (!cell.needed) return true;
  if (cell.detail < target) return false;
  return cell.glare ? cell.seen.length >= 2 : cell.seen.length >= 1;
}

export function progress(coverage: Coverage): { done: number; needed: number } {
  let done = 0;
  let needed = 0;
  for (const cell of coverage.cells) {
    if (!cell.needed) continue;
    needed++;
    if (settled(cell, coverage.target)) done++;
  }
  return { done, needed };
}

export function complete(coverage: Coverage): boolean {
  const { done, needed } = progress(coverage);
  return needed > 0 && done === needed;
}

/**
 * Lohnt sich eine Aufnahme an dieser Stelle?
 *
 * Nur, wenn sie etwas beiträgt: Der Ausschnitt muss offene Felder überdecken,
 * und er muss fein genug sein, um sie zu schliessen. Ohne diese Prüfung
 * sammelte die App auf einer bereits abgefahrenen Stelle Kachel um Kachel –
 * und jede kostet Speicher und später Rechenzeit.
 */
export function worthTaking(coverage: Coverage, viewport: Quad, detail: number): boolean {
  if (detail < coverage.target) return false;
  return coverage.cells.some(
    (cell, index) =>
      cell.needed && !settled(cell, coverage.target) && contains(viewport, centreOf(coverage, index)),
  );
}

/** Die Mitte eines Feldes in Koordinaten der Übersicht. */
export function centreOf(coverage: Coverage, index: number): Pt {
  const col = index % coverage.cols;
  const row = (index / coverage.cols) | 0;
  return {
    x: ((col + 0.5) / coverage.cols) * coverage.width,
    y: ((row + 0.5) / coverage.rows) * coverage.height,
  };
}

/**
 * Wohin als Nächstes? Die Mitte der offenen Felder – reicht als Hinweis, und
 * mehr wäre eine Anmassung: Welchen Weg jemand über die Seite nimmt, ist seine
 * Sache.
 */
export function nextGap(coverage: Coverage): Pt | null {
  let sumX = 0;
  let sumY = 0;
  let count = 0;
  coverage.cells.forEach((cell, index) => {
    if (!cell.needed || settled(cell, coverage.target)) return;
    const centre = centreOf(coverage, index);
    sumX += centre.x;
    sumY += centre.y;
    count++;
  });
  return count === 0 ? null : { x: sumX / count, y: sumY / count };
}

/** Abstand zweier Kamerapositionen, als Anteil der Bildbreite. */
function apart(a: Pt, b: Pt, width: number): number {
  return Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1, width);
}

/**
 * Liegt der Punkt im Viereck? Über das Vorzeichen der Kreuzprodukte – für ein
 * konvexes Viereck, und ein Kamerabild ist immer eines.
 */
export function contains(quad: Quad, point: Pt): boolean {
  if (polygonArea(quad) <= 0) return false;
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    const cross = (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
    if (cross === 0) continue;
    const current = cross > 0 ? 1 : -1;
    if (sign === 0) sign = current;
    else if (sign !== current) return false;
  }
  return true;
}
