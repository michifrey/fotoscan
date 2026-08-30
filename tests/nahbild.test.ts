import { describe, expect, it } from 'vitest';
import { detectPhotoQuads } from '../src/lib/imaging/detect';
import { polygonArea } from '../src/lib/imaging/geometry';
import { createRgba } from '../src/lib/imaging/types';
import type { RgbaImage } from '../src/lib/imaging/types';
import { drawTextureInQuad, fill, kartonTexture, rectQuad, variedPhoto } from './synth';

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
