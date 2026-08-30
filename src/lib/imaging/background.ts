import { gradientMagnitude } from './mask';
import type { Mask } from './mask';
import type { GrayImage, RgbaImage } from './types';

export interface Background {
  /** Mittlere Farbe der gleichmässigen Fläche. */
  color: [number, number, number];
  /** Erlaubte Abweichung im Farbton. */
  chroma: number;
  /** Erlaubte Abweichung in der Helligkeit, als Anteil. */
  brightness: number;
  /** Anteil der Bildfläche, der zu dieser Fläche gehört. */
  fraction: number;
}

/** Ausgangswerte der Verfeinerung – bewusst grosszügig. */
const START_CHROMA = 22;
const START_BRIGHTNESS = 0.3;
const ROUNDS = 3;

function luma(r: number, g: number, b: number): number {
  return (r * 77 + g * 150 + b * 29) / 256;
}

function within(
  r: number,
  g: number,
  b: number,
  color: [number, number, number],
  reference: number,
  chroma: number,
  brightness: number,
): boolean {
  if (Math.abs(r - g - (color[0] - color[1])) > chroma) return false;
  if (Math.abs(g - b - (color[1] - color[2])) > chroma) return false;
  const l = luma(r, g, b);
  return Math.abs(l - reference) <= reference * brightness;
}

/**
 * Schätzt Farbe und Streuung des Untergrunds – auf einer Albumseite also die
 * des Papiers.
 *
 * Zwei Schritte. Zuerst die häufigste Farbe unter den *flachen* Pixeln:
 * Papier, Tisch und Karton sind gleichmässig, Fotos und Handschrift nicht.
 * Dann wird die erlaubte Abweichung aus der tatsächlichen Streuung dieser
 * Fläche abgeleitet, statt sie fest vorzugeben. Das ist der Punkt, an dem
 * feste Werte scheitern: Sauber ausgeleuchtetes Papier verträgt eine enge
 * Grenze, eine Holztischplatte mit Maserung braucht eine weite – und wer
 * beides mit derselben Zahl bedient, verliert entweder ein helles Foto oder
 * zerlegt den Tisch in Dutzende Schnipsel.
 */
export function estimateBackground(img: RgbaImage, gray: GrayImage): Background {
  const magnitude = gradientMagnitude(gray);
  const bins = new Uint32Array(16 * 16 * 16);
  const shifted = new Uint32Array(16 * 16 * 16);

  // Die flachen Bildpunkte werden einmal eingesammelt: Farbe, Helligkeit und
  // Farbabstand liegen danach dicht beieinander im Speicher. Die Verfeinerung
  // läuft mehrfach darüber – sie jedes Mal aus dem ganzen Bild neu
  // herauszusuchen kostete ein Vielfaches.
  const reds = new Uint8Array(magnitude.length);
  const greens = new Uint8Array(magnitude.length);
  const blues = new Uint8Array(magnitude.length);
  const lumas = new Float32Array(magnitude.length);
  let flatCount = 0;

  for (let y = 1; y < img.height - 1; y++) {
    for (let x = 1; x < img.width - 1; x++) {
      const i = y * img.width + x;
      if (magnitude[i] > 48) continue;
      const p = i * 4;
      const r = img.data[p];
      const g = img.data[p + 1];
      const b = img.data[p + 2];
      reds[flatCount] = r;
      greens[flatCount] = g;
      blues[flatCount] = b;
      lumas[flatCount] = luma(r, g, b);
      flatCount++;
      bins[((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)]++;
      shifted[(half(r) << 8) | (half(g) << 4) | half(b)]++;
    }
  }
  if (flatCount === 0) return { color: [0, 0, 0], chroma: 0, brightness: 0, fraction: 0 };

  let color = modalColor(bins, shifted);
  let chroma = START_CHROMA;
  let brightness = START_BRIGHTNESS;

  // Verfeinern: Mittelwert und Streuung der Fläche bestimmen, Grenzen daraus
  // neu setzen, wiederholen. Nach wenigen Runden steht beides fest.
  for (let round = 0; round < ROUNDS; round++) {
    const reference = luma(color[0], color[1], color[2]);
    const spanRG = color[0] - color[1];
    const spanGB = color[1] - color[2];
    const span = reference * brightness;
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let sumC = 0;
    let sumC2 = 0;
    let sumL = 0;
    let sumL2 = 0;
    let count = 0;

    for (let i = 0; i < flatCount; i++) {
      const r = reds[i];
      const g = greens[i];
      const b = blues[i];
      const c1 = r - g - spanRG;
      if (c1 > chroma || c1 < -chroma) continue;
      const c2 = g - b - spanGB;
      if (c2 > chroma || c2 < -chroma) continue;
      const l = lumas[i];
      if (l - reference > span || reference - l > span) continue;
      sumR += r;
      sumG += g;
      sumB += b;
      sumC += Math.abs(c1) + Math.abs(c2);
      sumC2 += c1 * c1 + c2 * c2;
      sumL += l;
      sumL2 += l * l;
      count++;
    }
    if (count < 16) break;

    color = [sumR / count, sumG / count, sumB / count];
    const chromaSd = Math.sqrt(Math.max(0, sumC2 / (2 * count) - (sumC / (2 * count)) ** 2));
    const lumaMean = sumL / count;
    const lumaSd = Math.sqrt(Math.max(0, sumL2 / count - lumaMean * lumaMean));
    chroma = clamp(3.5 * chromaSd, 7, START_CHROMA);
    brightness = clamp((3.5 * lumaSd) / Math.max(1, lumaMean), 0.1, START_BRIGHTNESS);
  }

  return { color, chroma, brightness, fraction: backgroundFraction(img, { color, chroma, brightness }) };
}

/** Fachnummer im versetzten Raster – halbe Fachbreite nach unten geschoben. */
function half(value: number): number {
  return Math.min(15, (value + 8) >> 4);
}

/**
 * Häufigste Farbe unter den flachen Bildpunkten.
 *
 * Gezählt wird in zwei gegeneinander versetzten Rastern, und es gewinnt das
 * vollste Fach aus beiden. Sonst entscheidet nicht die grössere Fläche, sondern
 * die glattere: Eine gleichmässig ausgeleuchtete Tischplatte fällt in ein
 * einziges Fach, während eine schwarze Albumseite mit ihrem Rauschen genau auf
 * einer Fachgrenze liegen und über acht Fächer auseinanderlaufen kann – und
 * dabei den Kürzeren zieht, obwohl sie drei Viertel des Bildes bedeckt. Genau
 * daran scheiterten dunkle Albumseiten.
 */
function modalColor(bins: Uint32Array, shifted: Uint32Array): [number, number, number] {
  let best = 0;
  let bestShifted = 0;
  for (let bin = 1; bin < bins.length; bin++) {
    if (bins[bin] > bins[best]) best = bin;
    if (shifted[bin] > shifted[bestShifted]) bestShifted = bin;
  }

  const offset = shifted[bestShifted] > bins[best] ? -8 : 0;
  const bin = offset ? bestShifted : best;
  return [(((bin >> 8) & 15) << 4) + offset, (((bin >> 4) & 15) << 4) + offset, ((bin & 15) << 4) + offset];
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

export type Limits = Pick<Background, 'color' | 'chroma' | 'brightness'>;

export function backgroundFraction(img: RgbaImage, limits: Limits): number {
  const reference = luma(limits.color[0], limits.color[1], limits.color[2]);
  let count = 0;
  for (let p = 0; p < img.data.length; p += 4) {
    if (within(img.data[p], img.data[p + 1], img.data[p + 2], limits.color, reference, limits.chroma, limits.brightness)) {
      count++;
    }
  }
  return count / (img.width * img.height);
}

/**
 * Maske alles dessen, was *nicht* Untergrund ist – auf einer Albumseite also
 * der Fotos und der Beschriftung.
 */
export function foregroundMask(img: RgbaImage, limits: Limits): Mask {
  const reference = luma(limits.color[0], limits.color[1], limits.color[2]);
  const data = new Uint8Array(img.width * img.height);
  for (let i = 0, p = 0; i < data.length; i++, p += 4) {
    data[i] = within(img.data[p], img.data[p + 1], img.data[p + 2], limits.color, reference, limits.chroma, limits.brightness)
      ? 0
      : 1;
  }
  return { data, width: img.width, height: img.height };
}

/**
 * Hat dieser Bildpunkt die Farbe eines bekannten Untergrunds?
 *
 * Damit lässt sich eine Fläche daraufhin prüfen, ob sie in Wahrheit das
 * Albumpapier ist – eine helle Stelle im Foto etwa, die dieselbe Farbe hat.
 */
export function isBackgroundColor(limits: Limits, r: number, g: number, b: number): boolean {
  const reference = luma(limits.color[0], limits.color[1], limits.color[2]);
  return within(r, g, b, limits.color, reference, limits.chroma, limits.brightness);
}

/** Breite des Randstreifens, als Anteil der kurzen Bildkante. */
const BORDER_BAND = 0.05;

/**
 * Die Streuung wird nicht am äussersten Wert festgemacht, sondern an diesem
 * Anteil: Ein paar Punkte des Streifens gehören schon zum Foto, wenn der Rand
 * ungleichmässig ausfällt, und die dürfen die Grenze nicht aufziehen.
 */
const BORDER_QUANTILE = 0.75;

/** Und ein wenig Luft darüber hinaus, für Schatten am Rand. */
const BORDER_SLACK = 1.1;

/**
 * Farbe und Streuung des **Randstreifens** – in einer Nahaufnahme also des
 * Albumpapiers ringsum.
 *
 * `estimateBackground` sucht die grösste gleichmässige Fläche im Bild. In einer
 * Seitenaufnahme ist das das Papier; in einer Nahaufnahme, in der der Abzug
 * fast alles füllt, ist es der Abzug selbst – oder sein blasser Himmel. Am
 * echten Album schlug die Erkennung deshalb in acht von neun Fällen fehl.
 *
 * Hier wird die Frage umgedreht: *Wo* der Untergrund liegt, ist bekannt, denn
 * genau das verlangt die Führung – ein Streifen Papier muss ringsum sichtbar
 * bleiben. Also wird er dort gemessen, statt ihn zu suchen.
 *
 * Die Grenze bleibt bewusst eng. Weit gefasst verschluckt sie den weissen Rand
 * alter Abzüge – er ist heller als das cremefarbene Papier, aber nicht viel –,
 * und der Zuschnitt schneidet ihn ab. Gemessen: Mit weiter Grenze lag ein Foto
 * durchgehend 114 Punkte daneben, mit enger 19.
 */
export function borderLimits(img: RgbaImage, band = BORDER_BAND): Limits {
  const width = Math.max(1, Math.round(Math.min(img.width, img.height) * band));
  const red = new Uint32Array(256);
  const green = new Uint32Array(256);
  const blue = new Uint32Array(256);
  let count = 0;

  const visit = (p: number) => {
    red[img.data[p]]++;
    green[img.data[p + 1]]++;
    blue[img.data[p + 2]]++;
    count++;
  };
  for (let y = 0; y < img.height; y++) {
    const outer = y < width || y >= img.height - width;
    for (let x = 0; x < img.width; x++) {
      if (!outer && x >= width && x < img.width - width) x = img.width - width - 1;
      else visit((y * img.width + x) * 4);
    }
  }

  const color: [number, number, number] = [
    quantileOf(red, count, 0.5),
    quantileOf(green, count, 0.5),
    quantileOf(blue, count, 0.5),
  ];
  const reference = luma(color[0], color[1], color[2]);

  // Zweiter Durchgang: wie weit streut der Streifen um diese Farbe?
  const chroma = new Uint32Array(256);
  const brightness = new Uint32Array(101);
  const measure = (p: number) => {
    const r = img.data[p];
    const g = img.data[p + 1];
    const b = img.data[p + 2];
    const off = Math.max(
      Math.abs(r - g - (color[0] - color[1])),
      Math.abs(g - b - (color[1] - color[2])),
    );
    chroma[Math.min(255, off)]++;
    const share = Math.abs(luma(r, g, b) - reference) / Math.max(1, reference);
    brightness[Math.min(100, Math.round(share * 100))]++;
  };
  for (let y = 0; y < img.height; y++) {
    const outer = y < width || y >= img.height - width;
    for (let x = 0; x < img.width; x++) {
      if (!outer && x >= width && x < img.width - width) x = img.width - width - 1;
      else measure((y * img.width + x) * 4);
    }
  }

  return {
    color,
    chroma: clamp(quantileOf(chroma, count, BORDER_QUANTILE) * BORDER_SLACK, 6, 30),
    brightness: clamp((quantileOf(brightness, count, BORDER_QUANTILE) / 100) * BORDER_SLACK, 0.06, 0.35),
  };
}

/** Der Wert, unter dem dieser Anteil der gezählten Punkte liegt. */
function quantileOf(bins: Uint32Array, total: number, share: number): number {
  const target = total * share;
  let seen = 0;
  for (let v = 0; v < bins.length; v++) {
    seen += bins[v];
    if (seen >= target) return v;
  }
  return bins.length - 1;
}
