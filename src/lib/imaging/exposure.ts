import type { Region } from './track';
import type { RgbaImage } from './types';

/**
 * Wie hell liegt das Motiv vor der Kamera?
 *
 * Gemessen wird der Median, nicht der Mittelwert: Ein Fenster im Bild oder ein
 * Glanzpunkt zieht den Mittelwert nach oben, und die Aufnahme gilt dann als
 * hell, obwohl das Album im Dunkeln liegt. Und gemessen wird nur dort, wo das
 * Motiv liegt – eine helle Tischplatte ringsum sagt nichts über die Seite.
 */
export interface Exposure {
  /** Mittlere Helligkeit des Motivs, 0 … 255. */
  level: number;
  /** Anteil ausgebrannter Bildpunkte. */
  clipped: number;
}

/**
 * Darunter gilt es als zu dunkel. In diesem Bereich bringt die Kamera mehr
 * Rauschen als Zeichnung mit, und was das Rauschen verschluckt hat, holt kein
 * Aufhellen zurück.
 */
export const DARK = 62;

/**
 * Darüber ist es wieder hell genug. Der Abstand zu `DARK` ist Absicht: Ohne
 * ihn schaltet sich ein zugeschaltetes Licht im Grenzbereich im Sekundentakt
 * an und aus – und beleuchtet sich mit jedem Einschalten selbst über die
 * Schwelle.
 */
export const BRIGHT = 92;

/** Jeder wievielte Bildpunkt gemessen wird. Für einen Median reicht das reichlich. */
const STEP = 3;

export function exposureOf(img: RgbaImage, region?: Region): Exposure {
  const box = bounds(img, region);
  const bins = new Uint32Array(256);
  let count = 0;
  let clipped = 0;

  for (let y = box.y0; y <= box.y1; y += STEP) {
    for (let x = box.x0; x <= box.x1; x += STEP) {
      const p = (y * img.width + x) * 4;
      const luma = (img.data[p] * 77 + img.data[p + 1] * 150 + img.data[p + 2] * 29) >> 8;
      bins[luma]++;
      if (luma >= 250) clipped++;
      count++;
    }
  }
  if (count === 0) return { level: 128, clipped: 0 };

  let seen = 0;
  for (let v = 0; v < 256; v++) {
    seen += bins[v];
    if (seen * 2 >= count) return { level: v, clipped: clipped / count };
  }
  return { level: 255, clipped: clipped / count };
}

export function tooDark(exposure: Exposure): boolean {
  return exposure.level < DARK;
}

export function brightEnough(exposure: Exposure): boolean {
  return exposure.level > BRIGHT;
}

/** Der gemessene Ausschnitt in Bildpunkten; ohne Motiv das ganze Bild. */
function bounds(img: RgbaImage, region?: Region) {
  if (!region) return { x0: 0, y0: 0, x1: img.width - 1, y1: img.height - 1 };
  return {
    x0: clamp(Math.round((region.cx - region.hx) * img.width), 0, img.width - 1),
    x1: clamp(Math.round((region.cx + region.hx) * img.width), 0, img.width - 1),
    y0: clamp(Math.round((region.cy - region.hy) * img.height), 0, img.height - 1),
    y1: clamp(Math.round((region.cy + region.hy) * img.height), 0, img.height - 1),
  };
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}
