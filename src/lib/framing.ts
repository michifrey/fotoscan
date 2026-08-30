import { tooDark } from './imaging/exposure';
import type { Exposure } from './imaging/exposure';
import type { Quad } from './imaging/types';

/**
 * Beurteilt, was der Sucher gerade zeigt. Die automatische Auslösung braucht
 * mehr als „irgendetwas erkannt": Eine Seite, die am Bildrand abgeschnitten
 * ist, wird auch abgeschnitten gespeichert, und ein wanderndes Viereck heisst,
 * dass die Kamera noch nicht ruhig liegt.
 *
 * Vor allem aber soll die App sagen, woran es liegt. Ein Sucher, der bloss
 * nichts tut, lässt einen raten.
 */
export type Framing = 'dunkel' | 'leer' | 'rand' | 'unruhig' | 'bereit';

/** Wie nah ein Viereck an den Bildrand darf, als Anteil der Bildkante. */
const EDGE = 0.012;

export function framing(
  quads: Quad[],
  width: number,
  height: number,
  steady: boolean,
  exposure: Exposure,
): Framing {
  // Die Helligkeit zuerst: Im Dunkeln findet die Erkennung ohnehin nichts, und
  // „kein Foto erkannt" wäre dann der falsche Rat.
  if (tooDark(exposure)) return 'dunkel';
  if (quads.length === 0) return 'leer';
  if (touchesEdge(quads, width, height)) return 'rand';
  return steady ? 'bereit' : 'unruhig';
}

/**
 * Was im Sucher steht.
 *
 * Gesucht wird die **Seite**, nicht die einzelnen Fotos: Welche Fotos darauf
 * liegen, wird im nächsten Schritt auf der entzerrten Seite entschieden, und
 * dort darf der Nutzer widersprechen. Der Sucher hat nur eine Frage zu
 * beantworten – liegt die Seite ganz und ruhig im Bild?
 */
export function framingText(state: Framing, light: Light): string {
  switch (state) {
    case 'dunkel':
      return darkText(light);
    case 'leer':
      return 'Keine Albumseite erkannt – Seite ganz ins Bild nehmen';
    case 'rand':
      return 'Etwas weiter weg – die Seite reicht bis an den Bildrand';
    case 'unruhig':
      return 'Seite erkannt – Kamera ruhig halten';
    case 'bereit':
      return 'Seite erkannt';
  }
}

/** Was die App gegen die Dunkelheit tun kann. */
export interface Light {
  /** Hat das Gerät überhaupt ein Licht? */
  available: boolean;
  /** Brennt es gerade? */
  on: boolean;
  /** Darf es von selbst zugeschaltet werden? */
  automatic: boolean;
}

/**
 * Das Licht der Kamera ist beim Abfotografieren zweischneidig: Es hilft gegen
 * das Rauschen und wirft zugleich seinen eigenen Glanz auf den Abzug. Beim
 * Entspiegeln macht das nichts – der Glanz wandert mit dem Telefon und wird
 * über die vier Punkte herausgerechnet. Beim Einzelbild bliebe er stehen,
 * deshalb schaltet die App ihn dort nicht von selbst ein, sondern sagt nur,
 * dass es ihn gibt.
 */
function darkText(light: Light): string {
  if (!light.available) return 'Zu dunkel – mehr Licht auf die Seite bringen';
  if (light.on) return 'Zu dunkel – Licht ist an';
  if (light.automatic) return 'Zu dunkel – Licht wird zugeschaltet …';
  return 'Zu dunkel – Licht antippen oder heller stellen';
}

function touchesEdge(quads: Quad[], width: number, height: number): boolean {
  const mx = width * EDGE;
  const my = height * EDGE;
  return quads.some((quad) =>
    quad.some((point) => point.x <= mx || point.y <= my || point.x >= width - mx || point.y >= height - my),
  );
}
