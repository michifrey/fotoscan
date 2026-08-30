import { describe, expect, it } from 'vitest';
import { closeupGuidance, guidanceText } from '../src/lib/nahfuehrung';
import type { GuidanceInput } from '../src/lib/nahfuehrung';
import type { Quad } from '../src/lib/imaging/types';

/**
 * Die Führung der dritten Stufe, Zweig für Zweig.
 *
 * Der Anlass: Am echten Album fand der Sucher die Fotos nicht, sagte nichts
 * Brauchbares – und liess dreimal dasselbe Foto aufnehmen. Diese Tests halten
 * fest, was der Nutzer stattdessen zu sehen bekommt. Sie laufen ohne Kamera,
 * denn die Fake-Kamera der Browsertests kann keine Albumseite zeigen; die
 * Entscheidung selbst muss deshalb eine reine Funktion sein.
 */

const FRAME = { width: 1200, height: 900 };
const FILL_MIN = 0.3;

function rect(x: number, y: number, w: number, h: number): Quad {
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
}

function input(over: Partial<GuidanceInput>): GuidanceInput {
  return { frame: FRAME, fillMin: FILL_MIN, targetIndex: 2, target: null, page: null, other: null, ...over };
}

describe('Führung in der Nahaufnahme', () => {
  it('meldet bereit, wenn das Ziel formatfüllend liegt', () => {
    const quad = rect(100, 80, 1000, 740);
    const g = closeupGuidance(input({ target: quad }));
    expect(g).toEqual({ kind: 'bereit', quad });
  });

  it('sagt näher heran, samt Füllgrad – statt zu schweigen', () => {
    // Der Kern der Sache. Vorher wurde bei einem zu kleinen Fund **nichts**
    // gezeichnet, und der Text sagte „Foto ganz ins Bild nehmen" – das
    // Gegenteil von Führung.
    const quad = rect(400, 300, 400, 300);
    const g = closeupGuidance(input({ target: quad }));
    expect(g.kind).toBe('naeher');
    if (g.kind === 'naeher') {
      expect(g.share).toBeCloseTo((400 * 300) / (1200 * 900), 3);
      expect(guidanceText(g, 2)).toContain('Näher heran');
      expect(guidanceText(g, 2)).toContain('11 %');
    }
  });

  it('verortet das Ziel über die Seite, wenn die Fotosuche leer ausgeht', () => {
    // Die Seite füllt das Bild (weit weg); das Ziel liegt als Viereck darauf.
    const g = closeupGuidance(
      input({
        page: {
          quad: rect(0, 0, 1200, 900),
          width: 900,
          height: 675,
          photos: [rect(60, 60, 280, 200), rect(500, 60, 280, 200)],
          targetAt: 1,
        },
        targetIndex: 1,
      }),
    );
    expect(g.kind).toBe('verankert');
    if (g.kind === 'verankert') {
      // Das projizierte Viereck sitzt dort, wo das Foto auf der Seite liegt –
      // hochgerechnet von 900 auf 1200 Punkte Breite.
      const centre = (g.quad[0].x + g.quad[2].x) / 2;
      expect(centre).toBeCloseTo(((500 + 140) * 1200) / 900, -1);
    }
  });

  it('zeigt die Richtung, wenn das Ziel ausserhalb des Bildes liegt', () => {
    // Die Seite ragt rechts übers Bild hinaus; das Ziel liegt in dem Teil,
    // der nicht zu sehen ist.
    const g = closeupGuidance(
      input({
        page: {
          quad: rect(-1800, 0, 3600, 2700),
          width: 900,
          height: 675,
          photos: [rect(700, 100, 150, 100)],
          targetAt: 0,
        },
        targetIndex: 0,
      }),
    );
    expect(g).toEqual({ kind: 'daneben', direction: 'rechts' });
    expect(guidanceText(g, 0)).toBe('Foto 1 liegt weiter rechts');
  });

  it('wechselt zu einem anderen offenen Foto, das vor der Kamera liegt', () => {
    // Der Nutzer hat sich entschieden, wohin er zielt – die App folgt ihm,
    // statt auf ihrer Reihenfolge zu bestehen. `locate` hat in den
    // Kreuzversuchen an echten Fotos nie falsch angeschlagen; darum sofort.
    const quad = rect(100, 80, 1000, 740);
    const g = closeupGuidance(input({ other: { at: 3, index: 4, quad, done: false } }));
    expect(g).toEqual({ kind: 'wechseln', at: 3, index: 4, quad });
    expect(guidanceText(g, 2)).toContain('Foto 5');
  });

  it('warnt, wenn das Foto vor der Kamera schon aufgenommen ist', () => {
    // Die Antwort auf „dreimal dasselbe Foto": kein Wechsel, kein Auslöser –
    // ein Satz, der sagt, was los ist, und die Karte zeigt die offenen.
    const g = closeupGuidance(
      input({ other: { at: 0, index: 1, quad: rect(100, 80, 1000, 740), done: true } }),
    );
    expect(g).toEqual({ kind: 'schonDa', index: 1 });
    expect(guidanceText(g, 2)).toBe('Foto 2 ist schon aufgenommen – die Karte zeigt die offenen');
  });

  it('lässt einen zu kleinen Fremdfund nicht dazwischenfunken', () => {
    // Ein anderes Foto, klein am Rand, ist keine Entscheidung des Nutzers.
    const target = rect(400, 300, 400, 300);
    const g = closeupGuidance(
      input({ target, other: { at: 1, index: 3, quad: rect(0, 0, 200, 150), done: false } }),
    );
    expect(g.kind).toBe('naeher');
  });

  it('bleibt beim alten Text, wenn gar nichts erkannt ist', () => {
    const g = closeupGuidance(input({}));
    expect(g.kind).toBe('suchen');
    expect(guidanceText(g, 0)).toContain('Ränder');
  });
});
