import { describe, expect, it } from 'vitest';
import { detectCloseup, detectPhotoQuads } from '../src/lib/imaging/detect';
import { polygonArea } from '../src/lib/imaging/geometry';
import { createRgba } from '../src/lib/imaging/types';
import type { Quad, RgbaImage } from '../src/lib/imaging/types';
import {
  drawTextureInQuad,
  fill,
  flatTexture,
  kartonTexture,
  photoWithPaleArea,
  rectQuad,
  variedPhoto,
} from './synth';

/**
 * Was die Erkennung in einer **Nahaufnahme** braucht.
 *
 * Am echten Album wurde in der dritten Stufe gar kein Foto erkannt. Der Grund
 * stand auf demselben Bildschirm: Die Anweisung lautete „formatfüllend
 * aufnehmen", und wer das wörtlich nimmt, schiebt den Abzug über den Bildrand.
 * Dort verwirft die Erkennung ihn – zu Recht, denn auf einer Seitenaufnahme ist
 * alles am Bildrand die Umgebung.
 *
 * Ein Anlauf, diese Regel für Nahaufnahmen abzuschalten, wurde gebaut und
 * wieder verworfen: Er half im randlosen Fall (0 → 1 Fund, aber nur 21 % der
 * Bildfläche) und **schadete** im häufigen – bei einem schmalen Rand fiel der
 * Fund von 85 % auf 17 %, weil der randberührende Papierstreifen selbst zur
 * Fläche wurde.
 *
 * Bleibt die ehrliche Antwort: Ein schmaler Streifen Papier muss sichtbar
 * bleiben. Dann trägt die Erkennung – und das hält dieser Test fest, damit die
 * Führung und die Erkennung nicht wieder auseinanderlaufen.
 */

/** Ein Nahbild: das Foto im Bild, ringsum ein Streifen Albumpapier. */
function nahbild(margin: number): RgbaImage {
  const img = createRgba(900, 675);
  drawTextureInQuad(img, kartonTexture(60, 45, [232, 226, 210], 3), rectQuad(0, 0, 900, 675, 0));
  const m = Math.round(900 * margin);
  drawTextureInQuad(img, variedPhoto(400, 300, 23), rectQuad(m, m, 900 - 2 * m, 675 - 2 * m, 0));
  return img;
}

/** Und eines, in dem das Foto über den Bildrand hinausragt. */
function überDenRand(): RgbaImage {
  const img = createRgba(900, 675);
  fill(img, 232, 226, 210);
  drawTextureInQuad(img, variedPhoto(400, 300, 23), rectQuad(-40, -30, 980, 735, 0));
  return img;
}

/** Der grösste Fund, als Anteil der Bildfläche. */
function grösster(img: RgbaImage): number {
  const found = detectPhotoQuads(img);
  const best = found.slice().sort((a, b) => polygonArea(b) - polygonArea(a))[0];
  return best ? polygonArea(best) / (img.width * img.height) : 0;
}

describe('Nahaufnahme eines einzelnen Fotos', () => {
  it('findet den Abzug, solange ringsum Papier zu sehen ist', () => {
    // Von einem breiten Rand bis zu einem schmalen: überall wird das Foto
    // gefunden und füllt genug, um den Selbstauslöser zu bedienen.
    for (const margin of [0.12, 0.08, 0.05, 0.03]) {
      expect(grösster(nahbild(margin))).toBeGreaterThan(0.3);
    }
  });

  it('gewinnt an Fläche, je näher man herangeht', () => {
    // Der Sinn der Runde: mehr Bildpunkte für dasselbe Foto.
    expect(grösster(nahbild(0.03))).toBeGreaterThan(grösster(nahbild(0.12)));
  });

  it('findet nichts, wenn das Foto über den Bildrand hinausragt', () => {
    // Die Gegenprobe – und der Grund, warum die Führung sagt, dass die Ränder
    // sichtbar bleiben müssen. Was hier fehlt, fehlt auch im gespeicherten
    // Foto: Über den Bildrand hinaus ist es schlicht nicht aufgenommen.
    expect(grösster(überDenRand())).toBeLessThan(0.3);
  });
});

/**
 * Und was sie in einer echten Nahaufnahme braucht.
 *
 * Der Test darüber arbeitet mit einem durchgehend gemusterten Abzug – und
 * genau daran ging er am echten Album vorbei. Ein alter Abzug hat einen weissen
 * Papierrand, der dem cremefarbenen Albumpapier ähnelt, und im Motiv grosse
 * blasse Flächen. Für `estimateBackground` ist die grösste gleichmässige Fläche
 * dann nicht mehr das Papier ringsum, sondern etwas im Bild selbst; alles
 * Weitere baut auf einer falschen Annahme auf.
 *
 * Am echten Album gemessen, drei Fotos mal drei Randbreiten: die Kantensuche
 * fand in **einem von neun** Fällen etwas Brauchbares, der Weg über den
 * Randstreifen in **neun von neun**. Die Vorlage hier bildet denselben Fall
 * nach – mit weissem Rand und blasser Fläche –, damit die Zahl nicht nur in
 * einem Sitzungsprotokoll steht.
 */

/** Die Farbe des Albumpapiers. */
const PAPIER: [number, number, number] = [232, 226, 210];

/** Eine Nahaufnahme eines alten Abzugs: weisser Rand, blasse Fläche im Motiv. */
function alterAbzug(margin: number): { img: RgbaImage; truth: Quad } {
  const img = createRgba(900, 675);
  drawTextureInQuad(img, kartonTexture(60, 45, PAPIER, 3), rectQuad(0, 0, 900, 675, 0));

  const m = Math.round(900 * margin);
  // Der Abzug samt seinem weissen Rand – das ist es, was gefunden werden soll.
  const truth = rectQuad(m, m, 900 - 2 * m, 675 - 2 * m, 0);
  drawTextureInQuad(img, flatTexture(60, 45, 249, 247, 242), truth);

  const inner = Math.round((900 - 2 * m) * 0.05);
  drawTextureInQuad(
    img,
    photoWithPaleArea(400, 300, 23, [236, 230, 216]),
    rectQuad(m + inner, m + inner, 900 - 2 * m - 2 * inner, 675 - 2 * m - 2 * inner, 0),
  );
  return { img, truth };
}

/** Wie weit die Ecken auseinanderliegen, in Punkten. */
function abstand(quad: Quad, truth: Quad): number {
  return Math.max(...quad.map((p, i) => Math.hypot(p.x - truth[i].x, p.y - truth[i].y)));
}

describe('Nahaufnahme über den Randstreifen', () => {
  it('findet den Abzug samt seinem weissen Rand', () => {
    for (const margin of [0.03, 0.06, 0.12]) {
      const { img, truth } = alterAbzug(margin);
      const found = detectCloseup(img);
      expect(found).not.toBeNull();
      // Ein Prozent der Bildbreite. Das ist enger, als die Oberfläche braucht –
      // dort lässt sich das Viereck ohnehin ziehen –, hält aber fest, dass der
      // Zuschnitt nicht wandert.
      expect(abstand(found!, truth)).toBeLessThan(9);
    }
  });

  it('schneidet den weissen Rand nicht ab', () => {
    // Der Punkt, an dem eine weit gefasste Grenze scheitert: Weiss ist dem
    // cremefarbenen Papier ähnlich genug, um mit hineinzurutschen. Am echten
    // Album lag ein Foto dadurch durchgehend 114 Punkte daneben.
    const { img, truth } = alterAbzug(0.03);
    expect(polygonArea(detectCloseup(img)!)).toBeGreaterThan(polygonArea(truth) * 0.9);
  });

  it('kommt weiter, wo die Kantensuche danebengreift', () => {
    // Die Gegenprobe zur Behauptung. Die Kantensuche findet hier den inneren
    // Abzug ohne seinen Rand – kein glatter Fehlschlag, aber ein Zuschnitt, der
    // Papier abschneidet, das zum Foto gehört.
    const { img, truth } = alterAbzug(0.03);
    const kanten = detectPhotoQuads(img).slice().sort((a, b) => polygonArea(b) - polygonArea(a))[0];
    expect(abstand(kanten, truth)).toBeGreaterThan(abstand(detectCloseup(img)!, truth) * 5);
  });

  it('gibt auf blankem Papier nichts zurück', () => {
    const blank = createRgba(900, 675);
    drawTextureInQuad(blank, kartonTexture(60, 45, PAPIER, 3), rectQuad(0, 0, 900, 675, 0));
    expect(detectCloseup(blank)).toBeNull();
  });

  it('schweigt, wenn der Abzug über den Bildrand hinausragt', () => {
    // Dann steht der Randstreifen nicht mehr auf Papier, sondern mitten im
    // Motiv, und was herauskommt, ist irgendeine helle Fläche darin – gemessen
    // ein Fünftel des Bildes. Solch ein Zuschnitt wäre schlimmer als keiner:
    // Der Bildschirm nimmt bei `null` den ganzen Ausschnitt, und der ist in
    // diesem Fall die richtige Antwort.
    expect(detectCloseup(überDenRand())).toBeNull();
  });
});
