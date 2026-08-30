import { describe, expect, it } from 'vitest';
import { locate } from '../src/lib/imaging/locate';
import { warpPerspective } from '../src/lib/imaging/warp';
import { createRgba } from '../src/lib/imaging/types';
import type { Quad, RgbaImage } from '../src/lib/imaging/types';
import { drawTextureInQuad, fill, kartonTexture, rectQuad, variedPhoto } from './synth';

/**
 * Das Foto der Seitenaufnahme im Nahbild wiederfinden.
 *
 * Bisher galt: das grösste erkannte Viereck wird es schon sein. Trifft die
 * Kantensuche daneben, wird mitten durchs Motiv geschnitten – und niemand
 * merkt es. Hier wird stattdessen gefragt, was die Seitenaufnahme schon weiss.
 */

/** Die Albumseite in hoher Auflösung – die Wahrheit. */
const SHEET: [number, number] = [1600, 1200];
const PHOTOS: Quad[] = [
  rectQuad(160, 180, 620, 460, 0),
  rectQuad(880, 200, 560, 420, 0),
];

function sheet(): RgbaImage {
  const img = createRgba(...SHEET);
  fill(img, 70, 50, 32);
  drawTextureInQuad(img, kartonTexture(90, 68, [232, 226, 210], 3), rectQuad(40, 40, 1520, 1120, 0));
  drawTextureInQuad(img, variedPhoto(420, 320, 23), PHOTOS[0]);
  drawTextureInQuad(img, variedPhoto(400, 300, 61), PHOTOS[1]);
  return img;
}

/**
 * Der Zuschnitt aus der Seitenaufnahme: dasselbe Foto, aber klein und weich –
 * die ganze Seite teilt sich die Bildpunkte der Kamera.
 */
function fromPage(source: RgbaImage, photo: Quad): RgbaImage {
  return warpPerspective(source, photo, 260, 195);
}

/** Was die Kamera aus der Nähe sieht: der Ausschnitt `view` der Vorlage. */
function closeup(source: RgbaImage, view: Quad, size: [number, number] = [900, 675]): RgbaImage {
  return warpPerspective(source, view, size[0], size[1]);
}

/** Wo das Foto im Nahbild wirklich liegt. */
function truth(photo: Quad, view: Quad, size: [number, number]): Quad {
  // Der Ausschnitt `view` wird auf `size` gezogen; die Ecken des Fotos gehen
  // denselben Weg. Für achsparallele Ausschnitte genügt die lineare Rechnung.
  const left = view[0].x;
  const top = view[0].y;
  const width = view[1].x - view[0].x;
  const height = view[3].y - view[0].y;
  return photo.map((p) => ({
    x: ((p.x - left) / width) * (size[0] - 1),
    y: ((p.y - top) / height) * (size[1] - 1),
  })) as Quad;
}

function cornerError(a: Quad, b: Quad): number {
  return Math.max(...a.map((p, i) => Math.hypot(p.x - b[i].x, p.y - b[i].y)));
}

function darken(img: RgbaImage, factor: number): RgbaImage {
  const out = { data: new Uint8ClampedArray(img.data), width: img.width, height: img.height };
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] *= factor;
    out.data[i + 1] *= factor;
    out.data[i + 2] *= factor;
  }
  return out;
}

function withGlare(img: RgbaImage, cx: number, cy: number, radius: number): RgbaImage {
  const out = { data: new Uint8ClampedArray(img.data), width: img.width, height: img.height };
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d > radius) continue;
      const strength = Math.min(1, (1 - d / radius) * 2.2);
      const i = (y * img.width + x) * 4;
      for (let c = 0; c < 3; c++) out.data[i + c] = out.data[i + c] + (255 - out.data[i + c]) * strength;
    }
  }
  return out;
}

describe('Nahaufnahme über die Seitenaufnahme zuschneiden', () => {
  const vorlage = sheet();
  const bezug = fromPage(vorlage, PHOTOS[0]);

  it('findet das Foto formatfüllend wieder', () => {
    // Der Normalfall: Der Nutzer hält die Kamera so, dass das Foto das Bild
    // fast ausfüllt.
    const view = rectQuad(130, 150, 680, 510, 0);
    const frame = closeup(vorlage, view);
    const found = locate(bezug, frame);

    expect(found).not.toBeNull();
    // eslint-disable-next-line no-console
    console.log('formatfuellend, Eckfehler', cornerError(found!, truth(PHOTOS[0], view, [900, 675])).toFixed(1));
    // Gemessen auf dem 900 px breiten Nahbild – zwanzig Punkte sind gut zwei
    // Prozent seiner Breite.
    expect(cornerError(found!, truth(PHOTOS[0], view, [900, 675]))).toBeLessThan(20);
  });

  it('findet es auch mit Rand, anderem Licht und Glanz', () => {
    // So sieht es in der Praxis aus: mehr Rand als gewollt, dunkler als die
    // Seitenaufnahme, und ein Lichtfleck mitten darauf.
    const view = rectQuad(60, 90, 840, 630, 0);
    const frame = withGlare(darken(closeup(vorlage, view), 0.78), 380, 300, 130);
    const found = locate(bezug, frame);

    expect(found).not.toBeNull();
    // eslint-disable-next-line no-console
    console.log('mit Rand und Glanz, Eckfehler', cornerError(found!, truth(PHOTOS[0], view, [900, 675])).toFixed(1));
    expect(cornerError(found!, truth(PHOTOS[0], view, [900, 675]))).toBeLessThan(30);
  });

  it('gibt nichts zurück, wenn ein anderes Foto vor der Kamera liegt', () => {
    // Die Gegenprobe, und der eigentliche Gewinn: Lieber gar kein Zuschnitt
    // als der falsche. Ein falscher fällt erst im Album auf.
    const view = rectQuad(850, 170, 620, 465, 0);
    const frame = closeup(vorlage, view);
    expect(locate(bezug, frame)).toBeNull();
  });

  it('gibt nichts zurück, wenn gar kein Foto im Bild ist', () => {
    const leer = createRgba(900, 675);
    fill(leer, 232, 226, 210);
    expect(locate(bezug, leer)).toBeNull();
  });
});
