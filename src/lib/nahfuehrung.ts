import { polygonArea, quadCentroid } from './imaging/geometry';
import { applyHomography, computeHomography } from './imaging/warp';
import type { Quad } from './imaging/types';

/**
 * Die Führung der dritten Stufe: Was sieht die Kamera, und was soll der Nutzer
 * als Nächstes tun?
 *
 * Der Anlass steht in einem Satz aus dem Test am echten Album: *«Es findet die
 * Fotos nicht und lässt mich dreimal dasselbe Foto aufnehmen. Eigentlich müsste
 * mir die App sagen, ich soll näher ran, und mich führen.»* Bis hierher suchte
 * der Sucher das Foto nur formatfüllend; wer zu weit weg war, sah **nichts**
 * gezeichnet und las ausgerechnet „Foto ganz ins Bild nehmen" – das Gegenteil
 * einer Führung.
 *
 * Diese Datei ist bewusst eine **reine Funktion** ohne Kamera und ohne React:
 * Die Fake-Kamera der Browsertests kann keine Albumseite zeigen, also muss die
 * Entscheidung selbst modultestbar sein.
 *
 * Was hineinkommt, ist an echten Bildern gemessen:
 * - Die weite `locate`-Suche findet das Zielfoto bis hinunter zu 4 % der
 *   Bildfläche (Eckenfehler ≤ 1,4 % der Bildbreite) und schlug in keinem
 *   Kreuzversuch auf ein falsches Foto an.
 * - Der Seitenanker (die entzerrte Seite als Referenz) trägt, solange die
 *   Seite 85–130 % des Bildes füllt, mit ~1 % Projektionsfehler.
 */

/** Weite Suche für die Vorschau: sagt, *wo* das Foto liegt, auch von weitem. */
export const PREVIEW_LOCATE = { fills: [0.95, 0.8, 0.65, 0.45, 0.3, 0.2], minShare: 0.02, maxShare: 2.2 };

/** Suche der Seite im Sucherbild – sie darf auch übers Bild hinausragen. */
export const PAGE_LOCATE = { fills: [1.15, 1.0, 0.85, 1.4], minShare: 0.5, maxShare: 6 };

/**
 * Vergleich zweier Zuschnitte: Ist es dasselbe Foto? Gemessen: 9 von 9
 * Varianten (schräger, heller, weiter weg) erkannt, 0 Fehlalarme zwischen
 * verschiedenen Fotos derselben Seite.
 */
export const DUPLICATE_LOCATE = { fills: [1.15, 1.0, 0.85, 0.7], minShare: 0.3, maxShare: 3 };

export interface GuidanceInput {
  /** Bildgrösse des Suchers. */
  frame: { width: number; height: number };
  /** Ab diesem Flächenanteil gilt das Foto als formatfüllend. */
  fillMin: number;
  /** Nummer (Index) des verlangten Fotos – für die Texte. */
  targetIndex: number;
  /** Weite Suche nach dem Ziel: sein Viereck im Sucher, oder `null`. */
  target: Quad | null;
  /** Seitenanker: das Viereck der Seitenreferenz im Sucher, oder `null`. */
  page: { quad: Quad; width: number; height: number; photos: Quad[]; targetAt: number } | null;
  /** Rundlauf über die anderen Referenzen: ein Fund, oder `null`. */
  other: { at: number; index: number; quad: Quad; done: boolean } | null;
}

export type Guidance =
  /** Das Ziel liegt formatfüllend im Bild – der Auslöser darf. */
  | { kind: 'bereit'; quad: Quad }
  /** Das Ziel ist gefunden, aber zu klein – näher heran. */
  | { kind: 'naeher'; quad: Quad; share: number }
  /** Nur über die Seite verortet: da liegt es, hin damit. */
  | { kind: 'verankert'; quad: Quad }
  /** Das Ziel liegt ausserhalb des Bildes – in diese Richtung. */
  | { kind: 'daneben'; direction: 'links' | 'rechts' | 'oben' | 'unten' }
  /** Ein anderes, noch offenes Foto liegt vor der Kamera – wechseln. */
  | { kind: 'wechseln'; at: number; index: number; quad: Quad }
  /** Ein schon aufgenommenes Foto liegt vor der Kamera. */
  | { kind: 'schonDa'; index: number }
  /** Nichts erkannt. */
  | { kind: 'suchen' };

export function closeupGuidance(input: GuidanceInput): Guidance {
  const area = input.frame.width * input.frame.height;

  // Ein anderes Foto formatfüllend vor der Kamera schlägt alles: Der Nutzer
  // hat sich entschieden, wohin er zielt – die App folgt ihm, statt auf ihrer
  // Reihenfolge zu bestehen. `locate` hat in den Kreuzversuchen nie auf ein
  // falsches Foto angeschlagen; darum darf der Wechsel sofort geschehen.
  if (input.other && polygonArea(input.other.quad) / area >= input.fillMin * 0.8) {
    if (input.other.done) return { kind: 'schonDa', index: input.other.index };
    return { kind: 'wechseln', at: input.other.at, index: input.other.index, quad: input.other.quad };
  }

  if (input.target) {
    const share = polygonArea(input.target) / area;
    if (share >= input.fillMin) return { kind: 'bereit', quad: input.target };
    return { kind: 'naeher', quad: input.target, share };
  }

  if (input.page) {
    // Die Seite ist verortet; das Ziel wird hineinprojiziert.
    const toFrame = computeHomography(
      [
        { x: 0, y: 0 },
        { x: input.page.width - 1, y: 0 },
        { x: input.page.width - 1, y: input.page.height - 1 },
        { x: 0, y: input.page.height - 1 },
      ],
      input.page.quad,
    );
    const projected = applyHomography(toFrame, input.page.photos[input.page.targetAt]) as Quad;
    const centre = quadCentroid(projected);

    if (centre.x >= 0 && centre.y >= 0 && centre.x < input.frame.width && centre.y < input.frame.height) {
      return { kind: 'verankert', quad: projected };
    }
    // Ausserhalb: Die Richtung mit dem grösseren Überhang gewinnt.
    const dx = centre.x < 0 ? centre.x : centre.x >= input.frame.width ? centre.x - input.frame.width : 0;
    const dy = centre.y < 0 ? centre.y : centre.y >= input.frame.height ? centre.y - input.frame.height : 0;
    if (Math.abs(dx) >= Math.abs(dy)) return { kind: 'daneben', direction: dx < 0 ? 'links' : 'rechts' };
    return { kind: 'daneben', direction: dy < 0 ? 'oben' : 'unten' };
  }

  return { kind: 'suchen' };
}

/** Der Satz zum Zustand – die Führung, um die es geht. */
export function guidanceText(guidance: Guidance, targetIndex: number): string {
  switch (guidance.kind) {
    case 'bereit':
      return 'Foto erkannt – ruhig halten';
    case 'naeher':
      return `Näher heran – Foto ${targetIndex + 1} füllt erst ${Math.round(guidance.share * 100)} %`;
    case 'verankert':
      return `Näher heran an Foto ${targetIndex + 1} – es ist markiert`;
    case 'daneben':
      return `Foto ${targetIndex + 1} liegt weiter ${guidance.direction}`;
    case 'wechseln':
      return `Foto ${guidance.index + 1} liegt vor der Kamera – aufgenommen wird jetzt dieses`;
    case 'schonDa':
      return `Foto ${guidance.index + 1} ist schon aufgenommen – die Karte zeigt die offenen`;
    case 'suchen':
      return 'Foto ganz ins Bild – die Ränder müssen knapp sichtbar bleiben';
  }
}
