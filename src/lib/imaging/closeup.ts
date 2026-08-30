import { estimateShift } from './destack';
import { boxBlur, downscaleGray, toGray } from './gray';
import { dilate, erode } from './mask';
import { enhance } from './enhance';
import type { EnhanceOptions } from './enhance';
import { outputSize, rotate, warpPerspective } from './warp';
import { createRgba } from './types';
import type { GrayImage, Quad, RgbaImage } from './types';

/**
 * Eine Nahaufnahme eines einzelnen Fotos: das Kamerabild und darin das
 * Viereck des Fotos.
 */
export interface Closeup {
  image: RgbaImage;
  quad: Quad;
  /**
   * Der gemessene Glanz dieser Aufnahme, klein und in den Koordinaten des
   * entzerrten Abzugs – siehe `glareFrom`. Fehlt, wenn es nur eine Aufnahme
   * gab; dann bleibt es beim Vergleich mit der Seitenaufnahme.
   */
  glare?: RgbaImage;
}

/** Längste Kante des fertigen Fotos aus einer Nahaufnahme. */
export const CLOSEUP_MAX = 2600;

export interface GlareOptions {
  /** Um so viel heller als die Vergleichsaufnahme ist eine Spiegelung. */
  step?: number;
  /** So hell muss die Stelle absolut sein, damit sie als Glanz zählt. */
  bright?: number;
  /** Mehr als dieser Anteil ist keine Spiegelung mehr, sondern ein Fehler. */
  limit?: number;
  /** So ähnlich müssen sich die beiden Aufnahmen sein, damit sie zusammengehören. */
  match?: number;
}

const DEFAULTS: Required<GlareOptions> = { step: 20, bright: 160, limit: 0.35, match: 0.4 };

/** Kantenlänge, auf der die Verschiebung der beiden Aufnahmen gesucht wird. */
const SHIFT_SIZE = 400;

/** Kurze Kante, auf der der weiche Übergang gerechnet wird. */
const FEATHER_SIZE = 400;

/** So viel eines Rasterfeldes muss glänzen, damit es als Spiegelung zählt. */
const CELL_SHARE = 0.5;

/**
 * Das fertige Foto aus der Seitenaufnahme und – wenn vorhanden – einer
 * Nahaufnahme.
 *
 * Die Seitenaufnahme zeigt alle Fotos einer Albumseite auf einmal; für ein
 * einzelnes Foto bleiben davon nur wenige hundert Bildpunkte. Die Nahaufnahme
 * bringt die dreifache Kantenlänge, hat aber ihre eigenen Spiegelungen – aus
 * der Nähe fällt das Licht der Lampe oder des Fensters unweigerlich anders auf
 * den Abzug. Beide zusammen ergeben, was keine für sich hat: die Schärfe der
 * Nahaufnahme und die spiegelungsfreien Stellen der Seitenaufnahme.
 */
export function refinePhoto(
  reference: RgbaImage,
  closeup: Closeup | null,
  options: EnhanceOptions,
  rotation: number,
  maxDim = CLOSEUP_MAX,
): RgbaImage {
  if (!closeup) return rotate(enhance(reference, options), rotation);

  const size = outputSize(closeup.quad, maxDim, closeup.image);
  const warped = warpPerspective(closeup.image, closeup.quad, size.width, size.height);
  // Erst der Glanz, den die weiteren Nahaufnahmen verraten haben: Er ist
  // gemessen, nicht geschätzt, und geht deshalb vor dem Vergleich mit der
  // weichen Seitenaufnahme ab.
  const detail = closeup.glare ? withoutGlare(warped, closeup.glare) : warped;
  // Zu klein geraten: Wer nicht näher herangeht als bei der Seitenaufnahme,
  // gewinnt nichts – dann bleibt es bei der Seitenaufnahme.
  if (size.width * size.height <= reference.width * reference.height * 1.2) {
    return rotate(enhance(reference, options), rotation);
  }

  const scaled = resample(reference, size.width, size.height);
  return rotate(enhance(removeGlare(detail, scaled), options), rotation);
}

/**
 * Nimmt der Nahaufnahme ihre Spiegelungen, indem sie mit der Seitenaufnahme
 * verglichen wird.
 *
 * Beide zeigen dieselbe Fläche, aus verschiedenen Winkeln aufgenommen: Was in
 * der einen glänzt, glänzt in der anderen nicht. Ersetzt wird nur dort, wo die
 * Nahaufnahme deutlich heller ist – der Rest bleibt, wie er ist, denn die
 * hochgerechnete Seitenaufnahme ist überall weich. In einer ausgebrannten
 * Stelle steckt ohnehin keine Zeichnung mehr; dort ist die weiche, aber
 * richtige Farbe das bessere Bild.
 */
export function removeGlare(detail: RgbaImage, reference: RgbaImage, options: GlareOptions = {}): RgbaImage {
  const opts = { ...DEFAULTS, ...options };
  if (detail.width !== reference.width || detail.height !== reference.height) return detail;

  const { width, height } = detail;
  const detailGray = toGray(detail);
  // Die Verschiebung wird auf verkleinerten Bildern gesucht. Auf voller Grösse
  // dauerte die Suche Sekunden, und genauer als ein paar Bildpunkte muss sie
  // nicht sein: Die Ränder der ersetzten Stellen sind ohnehin weich.
  const shift = coarseShift(detailGray, toGray(reference));
  const aligned = align(reference, shift.dx, shift.dy);
  matchExposure(aligned, detail);

  const alignedGray = toGray(aligned);
  const flag = new Uint8Array(width * height);
  // Ein Randstreifen bleibt aussen vor: Dort setzt die verschobene
  // Vergleichsaufnahme nur ihre letzte gültige Zeile fort, und jeder Vergleich
  // damit wäre erfunden.
  const margin =
    Math.max(2, Math.round(Math.min(width, height) * 0.01)) + Math.max(Math.abs(shift.dx), Math.abs(shift.dy));
  let count = 0;
  for (let y = margin; y < height - margin; y++) {
    for (let x = margin; x < width - margin; x++) {
      const i = y * width + x;
      if (detailGray.data[i] < opts.bright) continue;
      if (detailGray.data[i] - alignedGray.data[i] < opts.step) continue;
      flag[i] = 1;
      count++;
    }
  }

  // Zu viel: Dann stimmt die Zuordnung nicht – ein anderes Foto, ein
  // verrutschter Zuschnitt, eine ganz andere Belichtung. Lieber die
  // Nahaufnahme unverändert lassen als sie zu verderben.
  if (count === 0 || count > flag.length * opts.limit) return detail;

  // Dieselbe Frage von der anderen Seite: Zeigen die beiden Aufnahmen
  // überhaupt dasselbe? Gemessen wird der Zusammenhang der Helligkeiten, nicht
  // ihr Abstand – die eine ist weich und anders belichtet, das darf sie sein.
  // Zwei verschiedene Fotos dagegen haben miteinander nichts zu tun, und dann
  // wäre jedes Ersetzen falsch.
  if (correlation(detailGray, alignedGray) < opts.match) return detail;

  const alpha = feather(flag, width, height);
  const out = createRgba(width, height);
  for (let y = 0, p = 0; y < height; y++) {
    for (let x = 0; x < width; x++, p += 4) {
      const a = sample(alpha, x, y, width, height);
      for (let c = 0; c < 3; c++) {
        out.data[p + c] = detail.data[p + c] * (1 - a) + aligned.data[p + c] * a;
      }
      out.data[p + 3] = 255;
    }
  }
  return out;
}

/**
 * Zusammenhang zweier Graubilder, zwischen -1 und 1. Unempfindlich gegen
 * Helligkeit und Kontrast: Es zählt, ob hell und dunkel an denselben Stellen
 * liegen.
 */
function correlation(a: GrayImage, b: GrayImage): number {
  const n = a.data.length;
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < n; i++) {
    sa += a.data[i];
    sb += b.data[i];
  }
  const meanA = sa / n;
  const meanB = sb / n;

  let both = 0;
  let squareA = 0;
  let squareB = 0;
  for (let i = 0; i < n; i++) {
    const u = a.data[i] - meanA;
    const v = b.data[i] - meanB;
    both += u * v;
    squareA += u * u;
    squareB += v * v;
  }
  const spread = Math.sqrt(squareA * squareB);
  return spread === 0 ? 0 : both / spread;
}

/** Verschiebung zwischen zwei gleich grossen Aufnahmen, grob gesucht. */
function coarseShift(ref: GrayImage, moving: GrayImage): { dx: number; dy: number } {
  const small = downscaleGray(ref, SHIFT_SIZE);
  const other = downscaleGray(moving, SHIFT_SIZE);
  const found = estimateShift(small.image, other.image, 20);
  return { dx: Math.round(found.dx * small.scale), dy: Math.round(found.dy * small.scale) };
}

/**
 * Weicher Übergang um die gefundenen Stellen herum. Erst etwas ausdehnen, denn
 * eine Spiegelung hat einen Hof, den die Schwelle nicht mehr erfasst; dann
 * weichzeichnen, damit keine Kante entsteht, wo die weiche Aufnahme anfängt.
 *
 * Gerechnet wird auf einer verkleinerten Fassung. Der Übergang ist ohnehin
 * weich – ihn in voller Grösse zu berechnen kostete mehr Zeit als alles
 * andere zusammen.
 */
function feather(flag: Uint8Array, width: number, height: number): GrayImage {
  const factor = Math.max(1, Math.round(Math.min(width, height) / FEATHER_SIZE));
  const small = {
    width: Math.max(1, Math.ceil(width / factor)),
    height: Math.max(1, Math.ceil(height / factor)),
  };

  // Beim Verkleinern zählt die Mehrheit, nicht der einzelne Punkt. Das ist der
  // erste von zwei Filtern gegen Streusel: Eine scharfe Aufnahme ist an ihren
  // hellsten Stellen fast überall etwas heller als eine weichgezeichnete, und
  // solche einzelnen Punkte sind keine Spiegelung.
  const counts = new Uint16Array(small.width * small.height);
  for (let y = 0; y < height; y++) {
    const row = ((y / factor) | 0) * small.width;
    for (let x = 0; x < width; x++) {
      if (flag[y * width + x]) counts[row + ((x / factor) | 0)]++;
    }
  }
  const packed = new Uint8Array(small.width * small.height);
  const majority = Math.max(1, Math.round(factor * factor * CELL_SHARE));
  for (let i = 0; i < packed.length; i++) packed[i] = counts[i] >= majority ? 1 : 0;

  // Der zweite Filter: Was übrig bleibt, muss zusammenhängen. Eine Spiegelung
  // ist ein Fleck, kein Sprenkel.
  const radius = Math.max(1, Math.round((Math.min(width, height) * 0.006) / factor));
  const solid = dilate(erode({ data: packed, width: small.width, height: small.height }, radius), radius);

  const grown = dilate(solid, radius);
  const edges = createGray(small.width, small.height);
  for (let i = 0; i < edges.data.length; i++) edges.data[i] = grown.data[i] ? 255 : 0;
  return boxBlur(boxBlur(edges, radius), radius);
}

/** Deckkraft an einer Stelle des grossen Bildes, bilinear aus der kleinen Karte. */
function sample(alpha: GrayImage, x: number, y: number, width: number, height: number): number {
  const fx = (x * (alpha.width - 1)) / Math.max(1, width - 1);
  const fy = (y * (alpha.height - 1)) / Math.max(1, height - 1);
  const x0 = fx | 0;
  const y0 = fy | 0;
  const x1 = Math.min(alpha.width - 1, x0 + 1);
  const y1 = Math.min(alpha.height - 1, y0 + 1);
  const wx = fx - x0;
  const wy = fy - y0;
  const top = alpha.data[y0 * alpha.width + x0] * (1 - wx) + alpha.data[y0 * alpha.width + x1] * wx;
  const bottom = alpha.data[y1 * alpha.width + x0] * (1 - wx) + alpha.data[y1 * alpha.width + x1] * wx;
  return (top * (1 - wy) + bottom * wy) / 255;
}

function createGray(width: number, height: number): GrayImage {
  return { data: new Uint8Array(width * height), width, height };
}

/** Verschobene Kopie; am Rand wird der letzte gültige Bildpunkt fortgesetzt. */
function align(src: RgbaImage, dx: number, dy: number): RgbaImage {
  if (dx === 0 && dy === 0) return { data: new Uint8ClampedArray(src.data), width: src.width, height: src.height };
  const out = createRgba(src.width, src.height);
  for (let y = 0; y < src.height; y++) {
    const sy = clamp(y + dy, 0, src.height - 1);
    for (let x = 0; x < src.width; x++) {
      const sx = clamp(x + dx, 0, src.width - 1);
      const from = (sy * src.width + sx) * 4;
      const to = (y * src.width + x) * 4;
      out.data[to] = src.data[from];
      out.data[to + 1] = src.data[from + 1];
      out.data[to + 2] = src.data[from + 2];
      out.data[to + 3] = 255;
    }
  }
  return out;
}

/**
 * Zieht die Vergleichsaufnahme auf die Belichtung der Nahaufnahme.
 *
 * Aus der Nähe misst die Kamera anders als über der ganzen Seite; ohne diesen
 * Ausgleich wäre die Seitenaufnahme durchgehend dunkler, und die Suche nach
 * hellen Stellen fände das ganze Foto. Verglichen werden Mittelwerte, die
 * gegen Ausreisser unempfindlich sind: der Median je Kanal.
 */
export function matchExposure(image: RgbaImage, target: RgbaImage): void {
  for (let c = 0; c < 3; c++) {
    const from = median(image, c);
    const to = median(target, c);
    if (from < 1) continue;
    const gain = clamp(to / from, 0.6, 1.6);
    if (Math.abs(gain - 1) < 0.01) continue;
    for (let p = c; p < image.data.length; p += 4) image.data[p] = image.data[p] * gain;
  }
}

function median(img: RgbaImage, channel: number): number {
  const bins = new Uint32Array(256);
  for (let p = channel; p < img.data.length; p += 4) bins[img.data[p]]++;
  const half = (img.width * img.height) / 2;
  let seen = 0;
  for (let v = 0; v < 256; v++) {
    seen += bins[v];
    if (seen >= half) return v;
  }
  return 128;
}

/** Bilineares Umrechnen auf eine andere Grösse. */
function resample(src: RgbaImage, width: number, height: number): RgbaImage {
  const full: Quad = [
    { x: 0, y: 0 },
    { x: src.width - 1, y: 0 },
    { x: src.width - 1, y: src.height - 1 },
    { x: 0, y: src.height - 1 },
  ];
  return warpPerspective(src, full, width, height);
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

/** Kantenlänge, auf der der Glanz gemessen wird. */
const GLARE_SIZE = 300;

/**
 * Wie viel Glanz in einer Nahaufnahme steckt, gemessen an weiteren Aufnahmen
 * derselben Fläche.
 *
 * Der Gedanke stammt von PhotoScan und aus der Physik dahinter: Eine Spiegelung
 * fügt Licht **hinzu**, sie zieht nie welches ab. Über mehrere Aufnahmen
 * desselben Abzugs aus leicht verschiedenen Winkeln ist der dunkelste Wert je
 * Bildpunkt deshalb der ungespiegelte – nicht der mittlere, wie beim Median,
 * denn der trägt nur, solange der Glanz in der Minderheit liegt.
 *
 * Gerechnet wird auf wenigen hundert Punkten Kantenlänge, und das ist keine
 * Sparmassnahme, sondern der Punkt: Ein Glanzfleck ist grossflächig und weich.
 * Gemessen an einem Abzug mit wanderndem Glanzfleck, gegen die glanzfreie
 * Wahrheit (mittlerer Fehler je Farbkanal):
 *
 * | | Fehler |
 * | --- | --- |
 * | rohe Aufnahme | 19,1 |
 * | wie bisher, entspiegelt gegen die Seitenaufnahme | 6,3 |
 * | Minimum über alle Aufnahmen, in voller Grösse | 4,4 |
 * | **diese Korrektur, aus 270 Punkten hochgerechnet** | **4,6** |
 *
 * Die volle Auflösung bringt also so gut wie nichts mehr – kostet aber je
 * Aufnahme dreissig Megabyte, und daran ist die dritte Stufe am echten Album
 * schon einmal gestorben.
 *
 * Jede Aufnahme kommt mit dem Viereck, in dem *dasselbe* Foto darin liegt;
 * daraus fällt die Abbildung auf die erste. Gibt `null` zurück, wenn es nichts
 * zu vergleichen gibt.
 */
export function glareFrom(
  base: Closeup,
  others: Closeup[],
  size = GLARE_SIZE,
): RgbaImage | null {
  if (others.length === 0) return null;

  // Dieselbe Aufteilung wie beim fertigen Foto, nur klein: Sonst stünde die
  // Karte in einem anderen Seitenverhältnis als das Bild, auf das sie später
  // gelegt wird.
  const { width, height } = outputSize(base.quad, size, base.image);
  const flat = warpPerspective(base.image, base.quad, width, height);
  const stack: RgbaImage[] = [flat];
  for (const other of others) {
    stack.push(warpPerspective(other.image, other.quad, width, height));
  }

  // Der Überschuss der ersten Aufnahme gegenüber der dunkelsten – das ist ihr
  // Glanz, und nur er.
  const map = createRgba(width, height);
  for (let i = 0; i < map.data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      let darkest = 255;
      for (const frame of stack) darkest = Math.min(darkest, frame.data[i + c]);
      map.data[i + c] = Math.max(0, flat.data[i + c] - darkest);
    }
    map.data[i + 3] = 255;
  }
  return map;
}

/**
 * Den gemessenen Glanz von einer entzerrten Aufnahme abziehen.
 *
 * Die Karte ist klein und wird hochgerechnet; weil sie weich ist, entsteht dabei
 * keine Kante. Abgezogen wird nur, nie hinzugefügt: Was in der Karte null ist,
 * bleibt Bildpunkt für Bildpunkt, wie es war.
 */
export function withoutGlare(image: RgbaImage, map: RgbaImage): RgbaImage {
  const grown = warpPerspective(
    map,
    [
      { x: 0, y: 0 },
      { x: map.width - 1, y: 0 },
      { x: map.width - 1, y: map.height - 1 },
      { x: 0, y: map.height - 1 },
    ],
    image.width,
    image.height,
  );
  const out = createRgba(image.width, image.height);
  for (let i = 0; i < out.data.length; i += 4) {
    for (let c = 0; c < 3; c++) out.data[i + c] = Math.max(0, image.data[i + c] - grown.data[i + c]);
    out.data[i + 3] = 255;
  }
  return out;
}

