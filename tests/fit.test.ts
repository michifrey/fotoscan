import { describe, expect, it } from 'vitest';
import { fitHomography, fitHomographyRobust, residual } from '../src/lib/imaging/fit';
import { applyHomography, computeHomography } from '../src/lib/imaging/warp';
import type { Pt, Quad } from '../src/lib/imaging/types';
import { lcg, rectQuad } from './synth';

/** Ein Gitter von Punkten über eine Fläche – die Zuordnungen einer Kachel. */
function grid(width: number, height: number, steps = 4): Pt[] {
  const points: Pt[] = [];
  for (let j = 0; j < steps; j++) {
    for (let i = 0; i < steps; i++) {
      points.push({ x: (width * (i + 0.5)) / steps, y: (height * (j + 0.5)) / steps });
    }
  }
  return points;
}

function worst(h: number[], from: Pt[], to: Pt[]): number {
  return Math.max(...from.map((p, i) => residual(h, p, to[i])));
}

describe('Ausgleichsrechnung für die Homographie', () => {
  it('findet eine bekannte Abbildung aus vielen Punkten genau wieder', () => {
    const source: Quad = rectQuad(0, 0, 2000, 1500, 0);
    const target: Quad = [
      { x: 320, y: 210 },
      { x: 1180, y: 260 },
      { x: 1210, y: 940 },
      { x: 290, y: 880 },
    ];
    const truth = computeHomography(source, target);

    const from = grid(2000, 1500, 5);
    const to = applyHomography(truth, from);

    const fitted = fitHomography(from, to);
    expect(fitted).not.toBeNull();
    // Auf den Bildpunkt genau: Die Punkte stammen ja aus derselben Abbildung.
    expect(worst(fitted!, from, to)).toBeLessThan(0.01);
  });

  it('mittelt verrauschte Zuordnungen, statt sich von vieren abhängig zu machen', () => {
    const source: Quad = rectQuad(0, 0, 1600, 1200, 0);
    const target: Quad = [
      { x: 100, y: 120 },
      { x: 900, y: 90 },
      { x: 940, y: 720 },
      { x: 140, y: 760 },
    ];
    const truth = computeHomography(source, target);

    const from = grid(1600, 1200, 5);
    const clean = applyHomography(truth, from);
    const rnd = lcg(7);
    const noisy = clean.map((p) => ({ x: p.x + (rnd() - 0.5) * 3, y: p.y + (rnd() - 0.5) * 3 }));

    const fitted = fitHomography(from, noisy)!;
    // Gegen die *wahren* Punkte gemessen muss die Ausgleichsrechnung besser
    // sein als eine Lösung aus vier beliebigen verrauschten Ecken.
    const fromFour = computeHomography(
      [from[0], from[4], from[24], from[20]] as Quad,
      [noisy[0], noisy[4], noisy[24], noisy[20]] as Quad,
    );
    expect(worst(fitted, from, clean)).toBeLessThan(worst(fromFour, from, clean));
    expect(worst(fitted, from, clean)).toBeLessThan(2);
  });

  it('lässt sich von einer einzelnen falschen Zuordnung nicht verziehen', () => {
    // Ein Teilstück greift daneben – ein wiederkehrendes Muster im Bild, eine
    // Stelle ohne Struktur. Genau dafür ist die zweite Runde da.
    const source: Quad = rectQuad(0, 0, 1600, 1200, 0);
    const target: Quad = [
      { x: 200, y: 150 },
      { x: 1000, y: 170 },
      { x: 1020, y: 830 },
      { x: 180, y: 810 },
    ];
    const truth = computeHomography(source, target);
    const from = grid(1600, 1200, 5);
    const to = applyHomography(truth, from);

    const broken = to.slice();
    broken[12] = { x: broken[12].x + 220, y: broken[12].y - 180 };

    const naive = fitHomography(from, broken)!;
    const robust = fitHomographyRobust(from, broken)!;

    expect(worst(robust, from, to)).toBeLessThan(worst(naive, from, to) / 4);
    expect(worst(robust, from, to)).toBeLessThan(1);
  });

  it('gibt nichts zurück, wenn es nichts zu rechnen gibt', () => {
    expect(fitHomography([], [])).toBeNull();
    expect(fitHomography([{ x: 0, y: 0 }], [{ x: 1, y: 1 }])).toBeNull();
    // Ungleich viele Punkte.
    expect(fitHomography(grid(100, 100, 2), grid(100, 100, 2).slice(0, 3))).toBeNull();
    // Alle Punkte auf einer Stelle: keine Ausdehnung, keine Abbildung.
    const same = [0, 1, 2, 3, 4].map(() => ({ x: 5, y: 5 }));
    expect(fitHomography(same, same)).toBeNull();
  });

  it('rechnet auch bei grossen Bildkoordinaten genau', () => {
    // Ohne Normierung stünde hier eine Spalte um 1 neben einer um 3000², und
    // die Elimination verlöre an den kleinen Zahlen ihre Genauigkeit.
    const source: Quad = rectQuad(0, 0, 4000, 3000, 0);
    const target: Quad = [
      { x: 3010, y: 2020 },
      { x: 6980, y: 2130 },
      { x: 7020, y: 5010 },
      { x: 2970, y: 4900 },
    ];
    const truth = computeHomography(source, target);
    const from = grid(4000, 3000, 5);
    const to = applyHomography(truth, from);

    expect(worst(fitHomography(from, to)!, from, to)).toBeLessThan(0.05);
  });
});
