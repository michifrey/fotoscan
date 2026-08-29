import { matchExposure } from './closeup';
import { compose, linearScale } from './fit';
import { invert } from './pose';
import { applyHomography, computeHomography, outputSize, warpPerspective } from './warp';
import type { Pt, Quad, RgbaImage } from './types';
import { createRgba } from './types';

/**
 * Setzt ein Foto aus den Kacheln des Blatt-Scans zusammen.
 *
 * Die Kacheln sind Nahaufnahmen: Jede zeigt einen Ausschnitt der Albumseite
 * mit einem Vielfachen der Bildpunkte, die die Seitenaufnahme dafür übrig hat.
 * Wo ihre Lage steht – und das ist die Arbeit von `pose.ts` –, ist das
 * Zusammensetzen nur noch Buchhaltung: Jeder Zielbildpunkt bekommt seinen Wert
 * aus der Kachel, die ihn am sichersten trägt.
 *
 * Zwei Entscheidungen tragen das Ergebnis:
 *
 * - **Am sichersten trägt, wer weit von seinem eigenen Rand entfernt ist.** Am
 *   Rand einer Kachel ist die Lage am ungenauesten, dort steht die Optik am
 *   schrägsten, und dort endet das Bild. Der Übergang zwischen zwei Kacheln
 *   verläuft deshalb weich und liegt dort, wo beide am wenigsten zu verlieren
 *   haben.
 * - **Überlappen sich zwei Kacheln, gewinnt die dunklere.** Der Glanz wandert
 *   mit der Kameraposition, die Zeichnung nicht. Genau dafür verlangt die
 *   Führung einen zweiten Durchgang über glänzende Stellen – hier wird er
 *   eingelöst.
 *
 * Wo keine Kachel liegt, bleibt die hochgezogene Seitenaufnahme stehen. Sie ist
 * weich, aber sie ist richtig, und lieber eine weiche Stelle als ein Loch.
 */

/** Ab dieser Deckkraft zählt eine Kachel an einer Stelle als vollwertig. */
const SOLID = 0.55;

/** Breite des weichen Übergangs am Kachelrand, als Anteil der kurzen Kante. */
const FEATHER = 0.06;

/** Ab diesem Unterschied gilt die hellere Kachel als die glänzende. */
const GLARE_STEP = 18;

/** Und nur, wenn sie auch farblos genug ist – Licht hat keine Farbe. */
const GLARE_COLOURLESS = 34;

export interface Tile {
  image: RgbaImage;
  /** Bildet Kachelkoordinaten auf Koordinaten der Übersicht ab. */
  pose: number[];
}

/**
 * Das Foto `quad` der Übersicht, zusammengesetzt aus den Kacheln.
 *
 * Gibt `null` zurück, wenn keine Kachel etwas beizutragen hat – dann bleibt es
 * bei der Seitenaufnahme, und der Aufrufer merkt es daran, dass er nichts
 * bekommt.
 */
export function composePhoto(
  reference: RgbaImage,
  quad: Quad,
  tiles: Tile[],
  maxDim = 2600,
): RgbaImage | null {
  const useful = tiles.filter((tile) => linearScale(tile.pose) > 0);
  if (useful.length === 0) return null;

  // Wie viel feiner die Kacheln sind als die Übersicht. Danach richtet sich,
  // wie gross das Ergebnis überhaupt werden kann.
  const detail = Math.max(...useful.map((tile) => 1 / linearScale(tile.pose)));
  if (!(detail > 1)) return null;

  // Das Ergebnis wird um genau den Faktor grösser, den die Kacheln mitbringen.
  // `outputSize` allein genügt dafür nicht: Es misst die Kanten des Vierecks in
  // der Übersicht und verkleinert nur, wenn es zu gross wird – vergrössern
  // würde es nie. Ohne diesen Schritt käme das Foto in genau der Auflösung
  // heraus, die die Seitenaufnahme hergibt, und das ganze Abfahren wäre
  // umsonst gewesen.
  const base = outputSize(quad, maxDim);
  const longest = Math.max(base.width, base.height);
  const factor = Math.min(detail, maxDim / longest);
  const size = {
    width: Math.max(16, Math.round(base.width * factor)),
    height: Math.max(16, Math.round(base.height * factor)),
  };
  const out = warpPerspective(reference, quad, size.width, size.height);

  // Die Abbildung vom fertigen Foto in die Übersicht – über sie findet jede
  // Kachel ihren Platz.
  const rect = rectOf(size.width, size.height);
  const toOverview = computeHomography(rect, quad);

  const best = new Uint8Array(size.width * size.height);
  const dark = createRgba(size.width, size.height);
  const overlaps = new Uint8Array(size.width * size.height);
  let touched = false;

  for (const tile of useful) {
    const back = invert(tile.pose);
    if (!back) continue;

    // Wo liegt diese Kachel im fertigen Foto? Ihre Ecken, durch die Übersicht
    // hindurch zurückgerechnet.
    const toTile = compose(back, toOverview);
    const forward = invert(toTile);
    if (!forward) continue;
    const footprint = applyHomography(forward, rectOf(tile.image.width, tile.image.height)) as Quad;

    // Und ihr Inhalt, in denselben Rahmen entzerrt. Die vier Eckbilder von
    // `toTile` sind genau das Viereck, mit dem `warpPerspective` schon
    // entzerrt – ein eigener Warp ist dafür nicht nötig.
    const inTile = applyHomography(toTile, rect) as Quad;
    if (!inside(inTile, tile.image.width, tile.image.height)) continue;
    const warped = warpPerspective(tile.image, inTile, size.width, size.height);
    matchExposure(warped, out);

    const feather = Math.max(2, Math.min(size.width, size.height) * FEATHER);
    if (place(out, best, dark, overlaps, warped, footprint, feather)) touched = true;
  }
  if (!touched) return null;

  settle(out, dark, overlaps);
  return out;
}

/**
 * Trägt eine entzerrte Kachel ein. Gibt zurück, ob sie überhaupt etwas beitrug.
 */
function place(
  out: RgbaImage,
  best: Uint8Array,
  dark: RgbaImage,
  overlaps: Uint8Array,
  warped: RgbaImage,
  footprint: Quad,
  feather: number,
): boolean {
  const edges = edgesOf(footprint);
  let any = false;

  for (let y = 0, i = 0, p = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++, i++, p += 4) {
      // Der Abstand zur nächsten eigenen Kante, auf 0 … 1 gebracht: In der
      // Mitte der Kachel volle Deckkraft, am Rand keine.
      const room = distance(edges, x, y);
      if (room <= 0) continue;
      const weight = Math.min(1, room / feather);
      const level = Math.round(weight * 255);
      if (level === 0) continue;
      any = true;

      if (level >= SOLID * 255) {
        if (overlaps[i] < 255) overlaps[i]++;
        const luma = grey(warped.data, p);
        if (overlaps[i] === 1 || luma < grey(dark.data, p)) {
          dark.data[p] = warped.data[p];
          dark.data[p + 1] = warped.data[p + 1];
          dark.data[p + 2] = warped.data[p + 2];
          dark.data[p + 3] = 255;
        }
      }

      if (level <= best[i]) continue;
      best[i] = level;
      // Weicher Übergang zur Unterlage – zur Seitenaufnahme am äussersten
      // Rand, zur bereits eingetragenen Kachel dort, wo zwei sich treffen.
      for (let c = 0; c < 3; c++) {
        out.data[p + c] = out.data[p + c] * (1 - weight) + warped.data[p + c] * weight;
      }
    }
  }
  return any;
}

/**
 * Wo sich zwei Kacheln vollwertig überlappen, gewinnt die dunklere – aber nur,
 * wenn der Unterschied nach Glanz aussieht: deutlich heller und farblos.
 * Andernfalls ist es Zeichnung, und die bleibt, wie sie ist.
 */
function settle(out: RgbaImage, dark: RgbaImage, overlaps: Uint8Array): void {
  for (let i = 0, p = 0; i < overlaps.length; i++, p += 4) {
    if (overlaps[i] < 2) continue;
    const here = grey(out.data, p);
    const other = grey(dark.data, p);
    if (here - other < GLARE_STEP) continue;

    const high = Math.max(out.data[p], out.data[p + 1], out.data[p + 2]);
    const low = Math.min(out.data[p], out.data[p + 1], out.data[p + 2]);
    if (high - low > GLARE_COLOURLESS) continue;

    out.data[p] = dark.data[p];
    out.data[p + 1] = dark.data[p + 1];
    out.data[p + 2] = dark.data[p + 2];
  }
}

function grey(data: Uint8ClampedArray, p: number): number {
  return (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
}

function rectOf(width: number, height: number): Quad {
  return [
    { x: 0, y: 0 },
    { x: width - 1, y: 0 },
    { x: width - 1, y: height - 1 },
    { x: 0, y: height - 1 },
  ];
}

/** Liegt das Viereck ganz innerhalb eines Bildes dieser Grösse? */
function inside(quad: Quad, width: number, height: number): boolean {
  return quad.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Math.abs(p.x) < width * 8 && Math.abs(p.y) < height * 8);
}

interface Edge {
  nx: number;
  ny: number;
  c: number;
}

/** Die vier Kanten als Geraden, mit der Normalen nach innen. */
function edgesOf(quad: Quad): Edge[] {
  const cx = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4;
  const cy = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4;
  const edges: Edge[] = [];

  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    if (length < 1e-9) continue;
    let nx = -dy / length;
    let ny = dx / length;
    // Die Normale zeigt nach innen, damit ein Abstand innerhalb positiv ist.
    if (nx * (cx - a.x) + ny * (cy - a.y) < 0) {
      nx = -nx;
      ny = -ny;
    }
    edges.push({ nx, ny, c: -(nx * a.x + ny * a.y) });
  }
  return edges;
}

/** Abstand zur nächsten Kante; negativ ausserhalb. */
function distance(edges: Edge[], x: number, y: number): number {
  let least = Infinity;
  for (const edge of edges) {
    const d = edge.nx * x + edge.ny * y + edge.c;
    if (d <= 0) return 0;
    if (d < least) least = d;
  }
  return least === Infinity ? 0 : least;
}

/** Nur, damit `Pt` als benutzt gilt – die Ecken sind Punkte. */
export type Corner = Pt;
