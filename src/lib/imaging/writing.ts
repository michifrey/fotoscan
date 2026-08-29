import { estimateBackground, foregroundMask } from './background';
import { downscaleRgba, toGray } from './gray';
import { connectedComponents, dilate, erode } from './mask';
import type { Component, Mask } from './mask';
import { scaleQuad } from './geometry';
import type { Pt, Quad, RgbaImage } from './types';

/**
 * Eine gefundene Beschriftung auf der Albumseite.
 *
 * `photo` verweist auf das Foto, zu dem sie gehört – die Zuordnung geht nach
 * dem Abstand, denn wer eine Zeile unter ein Bild schreibt, meint dieses Bild.
 */
export interface Writing {
  /** Ausschnitt im Bild, in Koordinaten der übergebenen Aufnahme. */
  box: { minX: number; minY: number; maxX: number; maxY: number };
  /** Stelle des zugehörigen Fotos in der übergebenen Liste. */
  photo: number;
}

export interface WritingOptions {
  /** Längste Kante, auf die vor der Suche heruntergerechnet wird. */
  analysisSize?: number;
}

const DEFAULT_SIZE = 900;

/** Ab dieser Strichbreite (Anteil der kurzen Kante) ist es kein Strich mehr. */
const STROKE = 0.006;
/** So weit darf eine Beschriftung höchstens vom Foto entfernt liegen. */
const REACH = 0.6;
/** Kleinste Fläche einer Beschriftung, gemessen am Bild. */
const MIN_AREA = 0.0006;
/** Grösste Fläche – alles darüber ist ein Foto, das niemand erkannt hat. */
const MAX_AREA = 0.12;
/** So viel Tinte muss in ihrem Rechteck stehen, und so viel höchstens. */
const INK_MIN = 0.02;
const INK_MAX = 0.5;
/** Mindestens so viele Striche – ein einzelner Fleck ist keine Schrift. */
const MIN_STROKES = 3;
/**
 * Eine Zeile ist breiter als hoch. Das trennt Schrift von allem, was einzeln
 * und rundlich neben einem Foto liegt – einem Fleck, einer Ecke, einem
 * Klebepunkt –, und solche Kleinigkeiten liegen oft näher am Bild als die
 * Beschriftung selbst.
 */
const MIN_ASPECT = 1.4;
/**
 * So viele einzelne Striche muss ein Block enthalten.
 *
 * Das ist das eigentliche Merkmal von Schrift: Sie zerfällt in viele kleine
 * Teile – Buchstaben, Bögen, Punkte. Ein Kratzer, eine Kante, ein
 * angeschnittener Rand ist ein einziges langes Stück, mag er noch so dünn und
 * noch so langgezogen sein.
 */
const MIN_PARTS = 4;
/**
 * So einheitlich muss die Umgebung eines Blocks sein.
 *
 * Schrift steht auf einer Fläche – Papier, Karton –, und die ist ringsum
 * dieselbe. Der Rand der Seite, die Tischplatte dahinter, der Schatten
 * darunter liefern ebenfalls dünne, langgezogene Formen; um sie herum aber
 * treffen zwei Flächen aufeinander, und das verrät sie.
 *
 * Gemessen wird die Umgebung selbst, nicht der Vergleich mit dem erkannten
 * Untergrund: Welche Fläche im Bild die grösste ist, hängt vom Ausschnitt ab –
 * liegt viel Tisch mit im Bild, gewinnt der Tisch, und das Papier gälte
 * plötzlich als Vordergrund.
 */
const RING_UNIFORM = 0.75;
/** Wie weit zwei Bildpunkte auseinanderliegen dürfen, um als dieselbe Fläche zu gelten. */
const RING_TOLERANCE = 26;
/**
 * Aufschlag für ein Foto, das unter der Zeile steht.
 *
 * Bildunterschriften stehen unter dem Bild. Liegt eine Zeile zwischen zwei
 * Fotos – und das ist der Regelfall auf einer vollen Seite –, gehört sie zu
 * dem darüber, auch wenn das andere ein paar Bildpunkte näher ist.
 */
const BELOW_PENALTY = 1.6;
/** So viel muss sich die Zeile mit dem Foto überschneiden, damit „darüber" zählt. */
const COLUMN_OVERLAP = 0.3;

/**
 * Sucht die handschriftlichen Bildunterschriften auf einer Albumseite.
 *
 * Der Weg ist derselbe wie bei der Fotoerkennung, nur andersherum gelesen: Das
 * Albumpapier ist der Untergrund, alles andere hebt sich davon ab. Zieht man
 * die erkannten Fotos ab, bleibt genau das übrig, was jemand mit der Hand
 * danebengeschrieben hat.
 *
 * Unterschieden wird Schrift von allem anderen über die Strichbreite: Eine
 * Zeile besteht aus dünnen Strichen, die ein Erodieren um wenige Bildpunkte
 * spurlos verschwinden lässt; ein angeschnittenes Foto, ein Schatten oder eine
 * Ecke des Kartons überstehen es. Was übrig bleibt, wird waagerecht
 * zusammengezogen – benachbarte Buchstaben werden so zu einer Zeile, mehrere
 * Zeilen zu einem Block.
 */
export function findWriting(img: RgbaImage, quads: Quad[], options: WritingOptions = {}): Writing[] {
  if (quads.length === 0) return [];
  // `scale` rechnet von der verkleinerten Fassung zurück aufs Original.
  const { image, scale } = downscaleRgba(img, options.analysisSize ?? DEFAULT_SIZE);

  const background = estimateBackground(image, toGray(image));
  if (background.fraction < 0.2) return [];

  const ink = strokes(
    foregroundMask(image, background),
    image,
    quads.map((quad) => scaleQuad(quad, 1 / scale)),
  );
  // Zweimal zählen: die einzelnen Striche und, nach dem Zusammenziehen, die
  // Blöcke, zu denen sie sich fügen.
  const parts = connectedComponents(ink.mask).components;
  const blocks = connectedComponents(dilate(ink.mask, ink.gap)).components;

  const found: (Writing & { distance: number; pieces: number })[] = [];
  const total = image.width * image.height;

  for (const block of blocks) {
    const area = (block.maxX - block.minX + 1) * (block.maxY - block.minY + 1);
    if (area < total * MIN_AREA || area > total * MAX_AREA) continue;
    if (touchesBorder(block, ink.mask)) continue;

    // Wie viel des Rechtecks ist wirklich Tinte? Eine Zeile ist licht; eine
    // volle Fläche wäre ein Foto oder ein Schatten.
    const width = block.maxX - block.minX + 1;
    const height = block.maxY - block.minY + 1;
    if (width < height * MIN_ASPECT) continue;

    const filled = countInk(ink.mask, block);
    const share = filled.count / area;
    if (share < INK_MIN || share > INK_MAX) continue;
    if (filled.strokes < MIN_STROKES) continue;
    const pieces = partsInside(parts, block);
    if (pieces < MIN_PARTS) continue;
    if (uniformAround(image, ink.covered, block) < RING_UNIFORM) continue;

    const nearest = closestPhoto(block, quads, scale);
    if (!nearest) continue;

    found.push({
      distance: nearest.distance,
      pieces,
      box: {
        minX: Math.round(block.minX * scale),
        minY: Math.round(block.minY * scale),
        maxX: Math.round(block.maxX * scale),
        maxY: Math.round(block.maxY * scale),
      },
      photo: nearest.photo,
    });
  }

  return bestPerPhoto(found);
}

/** Tinte: dünne Striche ausserhalb der erkannten Fotos. */
function strokes(
  foreground: Mask,
  image: RgbaImage,
  photos: Quad[],
): { mask: Mask; covered: Mask; gap: number } {
  const short = Math.min(image.width, image.height);
  const thin = Math.max(1, Math.round(short * STROKE));
  // Was ein Erodieren übersteht, ist breiter als ein Strich: ein Foto, ein
  // Schatten, der Rand der Seite. Genau das wird abgezogen.
  const solid = dilate(erode(foreground, thin), thin + 1);

  const data = new Uint8Array(foreground.data.length);
  for (let i = 0; i < data.length; i++) data[i] = foreground.data[i] && !solid.data[i] ? 1 : 0;
  const mask: Mask = { data, width: foreground.width, height: foreground.height };

  // Die Fotos selbst und ein Saum darum herum fallen weg: Ihr Rand liefert
  // dünne Kanten, die sonst als Schrift durchgingen. Wo sie liegen, wird
  // vermerkt – beim Blick auf die Nachbarschaft einer Zeile zählt ein Foto
  // weder als Papier noch dagegen.
  const margin = Math.max(2, Math.round(short * 0.012));
  const covered: Mask = { data: new Uint8Array(mask.data.length), width: mask.width, height: mask.height };
  for (const quad of photos) {
    blank(mask, quad, margin);
    fillBox(covered, quad, margin);
  }

  return { mask, covered, gap: Math.max(2, Math.round(short * 0.018)) };
}

/** Löscht alles innerhalb eines Vierecks samt Saum. */
function blank(mask: Mask, quad: Quad, margin: number): void {
  paint(mask, quad, margin, 0);
}

/** Markiert alles innerhalb eines Vierecks samt Saum. */
function fillBox(mask: Mask, quad: Quad, margin: number): void {
  paint(mask, quad, margin, 1);
}

function paint(mask: Mask, quad: Quad, margin: number, value: number): void {
  const minX = Math.max(0, Math.floor(Math.min(...quad.map((p) => p.x)) - margin));
  const maxX = Math.min(mask.width - 1, Math.ceil(Math.max(...quad.map((p) => p.x)) + margin));
  const minY = Math.max(0, Math.floor(Math.min(...quad.map((p) => p.y)) - margin));
  const maxY = Math.min(mask.height - 1, Math.ceil(Math.max(...quad.map((p) => p.y)) + margin));
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) mask.data[y * mask.width + x] = value;
  }
}

function countInk(mask: Mask, block: Component): { count: number; strokes: number } {
  let count = 0;
  let runs = 0;
  for (let y = block.minY; y <= block.maxY; y++) {
    let inside = false;
    for (let x = block.minX; x <= block.maxX; x++) {
      const on = mask.data[y * mask.width + x] === 1;
      if (on) count++;
      if (on && !inside) runs++;
      inside = on;
    }
  }
  return { count, strokes: runs };
}

/**
 * Wie einheitlich ist die Umgebung eines Blocks?
 *
 * Zuerst der Mittelwert des Rings, dann der Anteil der Punkte, die nahe genug
 * daran liegen. Fotos in der Nachbarschaft zählen weder dafür noch dagegen:
 * Die Zeile steht ja gerade deshalb dort, wo sie steht.
 */
function uniformAround(img: RgbaImage, covered: Mask, block: Component): number {
  const band = Math.max(3, Math.round((block.maxY - block.minY + 1) * 0.4));
  const minX = Math.max(0, block.minX - band);
  const maxX = Math.min(img.width - 1, block.maxX + band);
  const minY = Math.max(0, block.minY - band);
  const maxY = Math.min(img.height - 1, block.maxY + band);

  const ring: number[] = [];
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      if (x >= block.minX && x <= block.maxX && y >= block.minY && y <= block.maxY) continue;
      if (covered.data[y * covered.width + x]) continue;
      ring.push((y * img.width + x) * 4);
    }
  }
  if (ring.length < 32) return 0;

  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  for (const p of ring) {
    sumR += img.data[p];
    sumG += img.data[p + 1];
    sumB += img.data[p + 2];
  }
  const mean = [sumR / ring.length, sumG / ring.length, sumB / ring.length];

  let near = 0;
  for (const p of ring) {
    const distance =
      Math.abs(img.data[p] - mean[0]) + Math.abs(img.data[p + 1] - mean[1]) + Math.abs(img.data[p + 2] - mean[2]);
    if (distance <= RING_TOLERANCE * 3) near++;
  }
  return near / ring.length;
}

/** Wie viele einzelne Striche liegen in diesem Block? */
function partsInside(parts: Component[], block: Component): number {
  let count = 0;
  for (const part of parts) {
    const x = (part.minX + part.maxX) / 2;
    const y = (part.minY + part.maxY) / 2;
    if (x >= block.minX && x <= block.maxX && y >= block.minY && y <= block.maxY) count++;
  }
  return count;
}

function touchesBorder(block: Component, mask: Mask): boolean {
  return block.minX === 0 || block.minY === 0 || block.maxX === mask.width - 1 || block.maxY === mask.height - 1;
}

/** Das Foto, zu dem eine Beschriftung am ehesten gehört – oder keines. */
function closestPhoto(block: Component, quads: Quad[], scale: number): { photo: number; distance: number } | null {
  const center: Pt = {
    x: ((block.minX + block.maxX) / 2) * scale,
    y: ((block.minY + block.maxY) / 2) * scale,
  };

  const left = block.minX * scale;
  const right = block.maxX * scale;

  let best = -1;
  let bestScore = Infinity;
  let bestDistance = Infinity;
  for (let i = 0; i < quads.length; i++) {
    const box = bounds(quads[i]);
    const dx = Math.max(box.minX - center.x, 0, center.x - box.maxX);
    const dy = Math.max(box.minY - center.y, 0, center.y - box.maxY);
    const distance = Math.hypot(dx, dy);
    // Der Abstand zählt im Verhältnis zum Foto: Neben einem grossen Bild darf
    // die Zeile weiter weg stehen als neben einem kleinen.
    const size = Math.max(box.maxX - box.minX, box.maxY - box.minY);

    // Steht die Zeile in derselben Spalte wie das Foto, entscheidet mit, ob
    // sie darunter oder darüber liegt.
    const overlap = Math.min(right, box.maxX) - Math.max(left, box.minX);
    const sameColumn = overlap > (right - left) * COLUMN_OVERLAP;
    const score = sameColumn && center.y < box.minY ? distance * BELOW_PENALTY : distance;
    if (score > size * REACH) continue;
    if (score < bestScore) {
      bestScore = score;
      bestDistance = distance;
      best = i;
    }
  }
  return best < 0 ? null : { photo: best, distance: bestDistance };
}

function bounds(quad: Quad) {
  return {
    minX: Math.min(...quad.map((p) => p.x)),
    maxX: Math.max(...quad.map((p) => p.x)),
    minY: Math.min(...quad.map((p) => p.y)),
    maxY: Math.max(...quad.map((p) => p.y)),
  };
}

/**
 * Je Foto bleibt eine Beschriftung übrig: die mit den meisten Strichen.
 *
 * Nicht die nächstgelegene – neben einem Foto liegt oft noch anderes, und was
 * am dichtesten dransteht, ist selten die Zeile. Was viele einzelne Striche
 * hat, ist Schrift; bei gleicher Zahl entscheidet der Abstand.
 */
function bestPerPhoto(found: (Writing & { distance: number; pieces: number })[]): Writing[] {
  const byPhoto = new Map<number, Writing & { distance: number; pieces: number }>();
  for (const entry of found) {
    const existing = byPhoto.get(entry.photo);
    const better =
      !existing || entry.pieces > existing.pieces || (entry.pieces === existing.pieces && entry.distance < existing.distance);
    if (better) byPhoto.set(entry.photo, entry);
  }
  return [...byPhoto.values()]
    .sort((a, b) => a.photo - b.photo)
    .map(({ box, photo }) => ({ box, photo }));
}

/**
 * Der Ausschnitt einer Beschriftung als eigenes Bild, mit etwas Luft ringsum.
 *
 * `avoid` hält die Fotos heraus: Eine Zeile steht oft dicht unter dem einen
 * und dicht über dem nächsten Bild, und ein Streifen fremden Motivs im
 * Ausschnitt sieht aus wie ein Fehler.
 */
export function cropWriting(img: RgbaImage, writing: Writing, padding = 8, avoid: Quad[] = []): RgbaImage {
  const box = writing.box;
  const boxes = avoid.map(bounds);
  const room = (side: 'top' | 'bottom' | 'left' | 'right'): number => {
    let limit = padding;
    for (const other of boxes) {
      const overlapsColumn = other.maxX > box.minX && other.minX < box.maxX;
      const overlapsRow = other.maxY > box.minY && other.minY < box.maxY;
      if (side === 'top' && overlapsColumn && other.maxY <= box.minY) {
        limit = Math.min(limit, Math.max(0, box.minY - other.maxY - 1));
      }
      if (side === 'bottom' && overlapsColumn && other.minY >= box.maxY) {
        limit = Math.min(limit, Math.max(0, other.minY - box.maxY - 1));
      }
      if (side === 'left' && overlapsRow && other.maxX <= box.minX) {
        limit = Math.min(limit, Math.max(0, box.minX - other.maxX - 1));
      }
      if (side === 'right' && overlapsRow && other.minX >= box.maxX) {
        limit = Math.min(limit, Math.max(0, other.minX - box.maxX - 1));
      }
    }
    return limit;
  };

  // Gerundet, und zwar hier: Die Vierecke der Fotos haben gebrochene Ecken,
  // und ein gebrochener Bildpunkt ist keiner.
  const minX = Math.max(0, Math.floor(box.minX - room('left')));
  const minY = Math.max(0, Math.floor(box.minY - room('top')));
  const maxX = Math.min(img.width - 1, Math.ceil(box.maxX + room('right')));
  const maxY = Math.min(img.height - 1, Math.ceil(box.maxY + room('bottom')));
  const width = Math.max(1, maxX - minX + 1);
  const height = Math.max(1, maxY - minY + 1);

  const out: RgbaImage = { data: new Uint8ClampedArray(width * height * 4), width, height };
  for (let y = 0; y < height; y++) {
    const from = ((minY + y) * img.width + minX) * 4;
    out.data.set(img.data.subarray(from, from + width * 4), y * width * 4);
  }
  return out;
}
