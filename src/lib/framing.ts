import type { Quad } from './imaging/types';

/**
 * Beurteilt, was der Sucher gerade zeigt. Die automatische Auslösung braucht
 * mehr als „irgendetwas erkannt": Ein Foto, das am Bildrand abgeschnitten ist,
 * wird auch abgeschnitten gespeichert, und ein wanderndes Viereck heisst, dass
 * die Kamera noch nicht ruhig liegt.
 *
 * Vor allem aber soll die App sagen, woran es liegt. Ein Sucher, der bloss
 * nichts tut, lässt einen raten.
 */
export type Framing = 'leer' | 'rand' | 'unruhig' | 'bereit';

/** Wie nah ein Viereck an den Bildrand darf, als Anteil der Bildkante. */
const EDGE = 0.012;

export function framing(quads: Quad[], width: number, height: number, steady: boolean): Framing {
  if (quads.length === 0) return 'leer';
  if (touchesEdge(quads, width, height)) return 'rand';
  return steady ? 'bereit' : 'unruhig';
}

/** Was im Sucher steht. */
export function framingText(state: Framing, count: number): string {
  switch (state) {
    case 'leer':
      return 'Kein Foto erkannt – Seite ganz ins Bild nehmen';
    case 'rand':
      return 'Etwas weiter weg – ein Foto reicht bis an den Bildrand';
    case 'unruhig':
      return `${count} ${count === 1 ? 'Foto' : 'Fotos'} erkannt – Kamera ruhig halten`;
    case 'bereit':
      return `${count} ${count === 1 ? 'Foto' : 'Fotos'} erkannt`;
  }
}

function touchesEdge(quads: Quad[], width: number, height: number): boolean {
  const mx = width * EDGE;
  const my = height * EDGE;
  return quads.some((quad) =>
    quad.some((point) => point.x <= mx || point.y <= my || point.x >= width - mx || point.y >= height - my),
  );
}
