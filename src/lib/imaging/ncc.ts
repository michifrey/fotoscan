import type { GrayImage } from './types';

/**
 * Normierte Kreuzkorrelation über Punktproben.
 *
 * Das Mass, mit dem in dieser App zwei Bildausschnitte verglichen werden. Es
 * ist unabhängig von Helligkeit und Kontrast: Es zählt, ob hell und dunkel an
 * denselben Stellen liegen, nicht wie hell. Beim Abfahren einer Albumseite ist
 * das entscheidend – jede Kachel ist anders belichtet als die Übersicht, und
 * das Licht der Kamera ändert die Helligkeit von Aufnahme zu Aufnahme.
 */

/**
 * Bringt ein Muster auf Mittelwert null und Länge eins. Danach ist die
 * Korrelation ein einziges Skalarprodukt, geteilt durch die Streuung der
 * Gegenprobe. Gibt `false` zurück, wenn der Ausschnitt keinerlei Struktur hat –
 * eine leere weisse Fläche lässt sich nirgends wiederfinden.
 */
export function normalisePatch(values: Float32Array): boolean {
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += values[i];
  const mean = sum / values.length;

  let norm = 0;
  for (let i = 0; i < values.length; i++) {
    values[i] -= mean;
    norm += values[i] * values[i];
  }
  norm = Math.sqrt(norm);
  if (norm < 1e-3) return false;

  for (let i = 0; i < values.length; i++) values[i] /= norm;
  return true;
}

/**
 * Korrelation zwischen einem normierten Muster und rohen Proben. Ein einziger
 * Durchlauf: Weil das Muster mittelwertfrei ist, fällt der Mittelwert der
 * Proben aus dem Skalarprodukt heraus und muss nicht abgezogen werden.
 */
export function correlate(patch: Float32Array, samples: Float32Array): number {
  let dot = 0;
  let sum = 0;
  let squares = 0;
  for (let i = 0; i < patch.length; i++) {
    const value = samples[i];
    dot += patch[i] * value;
    sum += value;
    squares += value * value;
  }
  const variance = squares - (sum * sum) / patch.length;
  return variance <= 1e-6 ? 0 : dot / Math.sqrt(variance);
}

/** Grauwert an einer beliebigen Stelle, bilinear; ausserhalb `null`. */
export function sampleBilinear(gray: GrayImage, x: number, y: number): number | null {
  if (x < 0 || y < 0 || x > gray.width - 1 || y > gray.height - 1) return null;
  const x0 = x | 0;
  const y0 = y | 0;
  const x1 = Math.min(x0 + 1, gray.width - 1);
  const y1 = Math.min(y0 + 1, gray.height - 1);
  const fx = x - x0;
  const fy = y - y0;
  const top = gray.data[y0 * gray.width + x0] * (1 - fx) + gray.data[y0 * gray.width + x1] * fx;
  const bottom = gray.data[y1 * gray.width + x0] * (1 - fx) + gray.data[y1 * gray.width + x1] * fx;
  return top * (1 - fy) + bottom * fy;
}

/**
 * Grauwert wie `sampleBilinear`, aber am Bildrand festgehalten statt aufgegeben.
 *
 * Ein Teilstück, das über den Rand der Kachel hinausragt, ist deswegen noch
 * lange nicht unbrauchbar – der grösste Teil davon liegt ja im Bild. Es ganz
 * zu verwerfen kostet gerade die Teilstücke am Rand, und das sind die, an
 * denen sich die Perspektive zeigt. Zurückgegeben wird zusätzlich, ob
 * festgehalten wurde, damit der Aufrufer zählen kann, wie viel er erfindet.
 */
export function sampleClamped(gray: GrayImage, x: number, y: number): { value: number; outside: boolean } {
  const cx = x < 0 ? 0 : x > gray.width - 1 ? gray.width - 1 : x;
  const cy = y < 0 ? 0 : y > gray.height - 1 ? gray.height - 1 : y;
  return { value: sampleBilinear(gray, cx, cy) ?? 0, outside: cx !== x || cy !== y };
}

/**
 * Feinere Lage aus drei benachbarten Korrelationswerten.
 *
 * Die Suche läuft in ganzen Bildpunkten, der beste Ort liegt aber selten genau
 * auf einem. Durch drei Punkte einer Parabel gelegt, verrät der Scheitel die
 * Stelle dazwischen. Das kostet nichts und nimmt der späteren
 * Ausgleichsrechnung einen halben Bildpunkt Rauschen ab.
 */
export function subPixel(before: number, middle: number, after: number): number {
  const curve = before - 2 * middle + after;
  if (Math.abs(curve) < 1e-9) return 0;
  const shift = (0.5 * (before - after)) / curve;
  return Math.abs(shift) > 1 ? 0 : shift;
}
