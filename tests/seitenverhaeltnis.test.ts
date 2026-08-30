import { describe, expect, it } from 'vitest';
import { snapToPrint, trueAspect } from '../src/lib/imaging/aspect';
import { dist } from '../src/lib/imaging/geometry';
import { outputSize } from '../src/lib/imaging/warp';
import type { Pt, Quad } from '../src/lib/imaging/types';

/**
 * Das wahre Seitenverhältnis eines schräg aufgenommenen Abzugs.
 *
 * Bisher nahm die Entzerrung die längste beobachtete Kante als Breite und die
 * längste als Höhe. Unter Perspektive ist das systematisch falsch: Die nahe
 * Kante ist länger als die ferne, und keine der beiden ist die wahre. Man sieht
 * es dem einzelnen Bild nicht an – aber jedes Gesicht darin ist ein wenig zu
 * breit oder zu schmal, und das bleibt für immer so.
 *
 * Gemessen wird gegen eine **gerechnete Kamera**: bekannte Brennweite,
 * bekanntes Rechteck, echte perspektivische Projektion. Damit steht die
 * Wahrheit fest, statt aus einer zweiten Schätzung zu stammen.
 */

/** Bildgrösse der gerechneten Kamera. */
const WIDTH = 1080;
const HEIGHT = 1440;
const FOCAL = 1400;

/** Drehung um die x- und dann die y-Achse. */
function rotation(ax: number, ay: number): number[][] {
  const [ca, sa, cb, sb] = [Math.cos(ax), Math.sin(ax), Math.cos(ay), Math.sin(ay)];
  const x = [
    [1, 0, 0],
    [0, ca, -sa],
    [0, sa, ca],
  ];
  const y = [
    [cb, 0, sb],
    [0, 1, 0],
    [-sb, 0, cb],
  ];
  return y.map((row) => [0, 1, 2].map((j) => [0, 1, 2].reduce((sum, k) => sum + row[k] * x[k][j], 0)));
}

/**
 * Ein Rechteck dieses Verhältnisses, so geneigt aufgenommen. Ergibt die vier
 * Ecken im Bild, in der Reihenfolge der App: oben links, oben rechts, unten
 * rechts, unten links.
 */
function shot(ratio: number, ax: number, ay: number, distance = 6): Quad {
  const R = rotation(ax, ay);
  const corners = [
    [-ratio / 2, -0.5],
    [ratio / 2, -0.5],
    [ratio / 2, 0.5],
    [-ratio / 2, 0.5],
  ];
  return corners.map(([X, Y]): Pt => {
    const z = R[2][0] * X + R[2][1] * Y + distance;
    return {
      x: (FOCAL * (R[0][0] * X + R[0][1] * Y)) / z + (WIDTH - 1) / 2,
      y: (FOCAL * (R[1][0] * X + R[1][1] * Y)) / z + (HEIGHT - 1) / 2,
    };
  }) as Quad;
}

/** Was die alte Methode sagen würde: die längste beobachtete Kante. */
function byEdges(quad: Quad): number {
  return (
    Math.max(dist(quad[0], quad[1]), dist(quad[3], quad[2])) /
    Math.max(dist(quad[0], quad[3]), dist(quad[1], quad[2]))
  );
}

/** Abweichung in Prozent. */
function off(found: number, truth: number): number {
  return (100 * Math.abs(found - truth)) / truth;
}

const FORMATE: [number, string][] = [
  [1.5, '3:2 – der übliche Abzug'],
  [1.4, '7:5'],
  [4 / 3, '4:3'],
  [1, 'quadratisch'],
];

/** Neigungen, wie sie aus der Hand entstehen. */
const NEIGUNGEN: [number, number][] = [
  [0.25, 0.15],
  [0.45, 0.3],
  [0.55, 0.45],
];

describe('wahres Seitenverhältnis', () => {
  it('holt es aus den vier Ecken zurück, wo die Kanten danebenliegen', () => {
    let schlimmsteKante = 0;
    for (const [ratio, name] of FORMATE) {
      for (const [ax, ay] of NEIGUNGEN) {
        const quad = shot(ratio, ax, ay);
        const found = trueAspect(quad, WIDTH, HEIGHT);
        expect(found, name).not.toBeNull();
        // Ein Zehntelprozent. Die Rechnung ist geschlossen, nicht geschätzt –
        // was hier übrig bleibt, ist Rundung.
        expect(off(found!, ratio), name).toBeLessThan(0.1);
        schlimmsteKante = Math.max(schlimmsteKante, off(byEdges(quad), ratio));
      }
    }
    // Die Gegenprobe: Was die Kantenmethode in denselben Aufnahmen anrichtet.
    // Fiele diese Zusage, wäre der ganze Umbau überflüssig.
    expect(schlimmsteKante).toBeGreaterThan(4);
  });

  it('schweigt bei der frontalen Aufnahme, statt zu raten', () => {
    // Ohne Perspektive gibt es keine Fluchtpunkte; was die Rechnung dort
    // liefert, wären Rundungsfehler. Die Kantenmethode ist hier exakt, der
    // Rückfall kostet also nichts – und genau das prüft der zweite Teil.
    const quad = shot(1.5, 0, 0);
    expect(trueAspect(quad, WIDTH, HEIGHT)).toBeNull();
    expect(off(byEdges(quad), 1.5)).toBeLessThan(0.01);
  });

  it('gibt der Entzerrung das richtige Verhältnis, ohne Fläche zu verlieren', () => {
    const quad = shot(1.5, 0.45, 0.3);
    const alt = outputSize(quad, 3600);
    const neu = outputSize(quad, 3600, { width: WIDTH, height: HEIGHT });

    expect(off(neu.width / neu.height, 1.5)).toBeLessThan(0.2);
    expect(off(alt.width / alt.height, 1.5)).toBeGreaterThan(1);
    // Gleich viele Bildpunkte wie vorher: Das Verhältnis wandert, die Fläche
    // bleibt. Sonst wäre die Korrektur mit Auflösung bezahlt.
    expect(neu.width * neu.height).toBeGreaterThan(alt.width * alt.height * 0.95);
    expect(neu.width * neu.height).toBeLessThan(alt.width * alt.height * 1.05);
  });

  it('lässt sich von einem entarteten Viereck nicht zu einer Zahl verleiten', () => {
    // Drei Ecken auf einer Geraden – das ist kein Rechteck in Perspektive,
    // sondern ein Fehlgriff der Erkennung.
    const entartet: Quad = [
      { x: 100, y: 100 },
      { x: 300, y: 100 },
      { x: 500, y: 100 },
      { x: 100, y: 400 },
    ];
    expect(trueAspect(entartet, WIDTH, HEIGHT)).toBeNull();
  });
});

/**
 * Und der Teil, den erst die echte Albumseite gezeigt hat.
 *
 * Auf dem Papier trifft die Rückrechnung auf ein Hundertstel Prozent. An einem
 * echten Viereck kam für einen Abzug **2,8:1** heraus – ein Format, das es
 * nicht gibt. Der Grund liegt in der Sache: Die Fluchtpunkte liegen weit
 * ausserhalb des Bildes, und ein paar Punkte Versatz an einer Ecke verschieben
 * sie um ein Vielfaches. Gemessen bei zwei Punkten Rauschen: 72 % noch
 * brauchbar, 1,7 % grob falsch.
 *
 * Ein Abzug ist aber kein beliebiges Rechteck. Er liegt in einem der wenigen
 * **Normformate**, und damit wird aus der verrauschten Zahl eine Entscheidung
 * zwischen bekannten Werten – die verträgt Rauschen ungleich besser.
 */
describe('Wächter gegen entgleiste Rückrechnung', () => {
  it('nimmt nur an, was ein Abzugsformat sein kann', () => {
    // Der echte Fehlschlag von der Albumseite.
    expect(snapToPrint(2.815)).toBeNull();
    expect(snapToPrint(0.31)).toBeNull();
    // Und was durchgeht: ein 9×13, das die Liste gar nicht kennt, rastet auf
    // den nächsten bekannten Wert – näher an der Wahrheit als die Kanten.
    expect(snapToPrint(1.444)).toBeCloseTo(1.43, 2);
    expect(snapToPrint(1.51)).toBeCloseTo(1.5, 2);
    // Hochkant zählt genauso.
    expect(snapToPrint(0.665)).toBeCloseTo(1 / 1.5, 3);
  });

  it('lässt die Kanten stehen, wo die Rückrechnung Unsinn liefert', () => {
    // Ein Viereck, das kein abgebildetes Rechteck ist – eine Ecke sitzt grob
    // daneben, wie es der Erkennung an einem verdeckten Rand passiert.
    const schief: Quad = [
      { x: 200, y: 300 },
      { x: 880, y: 250 },
      { x: 900, y: 700 },
      { x: 150, y: 1180 },
    ];
    const frame = { width: WIDTH, height: HEIGHT };
    expect(outputSize(schief, 3600, frame)).toEqual(outputSize(schief, 3600));
  });

  it('macht es im Mittel besser, nicht schlechter – auch bei verrutschten Ecken', () => {
    // Die eigentliche Zusage. Gemessen über Formate, die **nicht** in der Liste
    // stehen: Wer auf ein 9×13 rastet, das die Liste nicht kennt, darf dadurch
    // nicht schlechter dastehen als vorher.
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const frame = { width: WIDTH, height: HEIGHT };
    let alt = 0;
    let neu = 0;
    let n = 0;
    for (const ratio of [1, 1.3, 4 / 3, 1.385, 1.427, 1.444, 1.5]) {
      for (let ax = 0.1; ax <= 0.7; ax += 0.1) {
        for (let ay = 0.1; ay <= 0.7; ay += 0.1) {
          const quad = shot(ratio, ax, ay).map((p) => ({
            x: p.x + (rnd() - 0.5) * 6,
            y: p.y + (rnd() - 0.5) * 6,
          })) as Quad;
          const a = outputSize(quad, 3600);
          const b = outputSize(quad, 3600, frame);
          alt += off(a.width / a.height, ratio);
          neu += off(b.width / b.height, ratio);
          n++;
        }
      }
    }
    // eslint-disable-next-line no-console
    console.log(`Kanten ${(alt / n).toFixed(1)} % → mit Rückrechnung ${(neu / n).toFixed(1)} %`);
    expect(neu / n).toBeLessThan((alt / n) * 0.8);
  });
});
