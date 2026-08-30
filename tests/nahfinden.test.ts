import { describe, expect, it } from 'vitest';
import { locate } from '../src/lib/imaging/locate';
import { DUPLICATE_LOCATE, PAGE_LOCATE, PREVIEW_LOCATE } from '../src/lib/nahfuehrung';
import { warpPerspective } from '../src/lib/imaging/warp';
import { createRgba } from '../src/lib/imaging/types';
import type { Quad, RgbaImage } from '../src/lib/imaging/types';
import { drawTextureInQuad, fill, kartonTexture, photoTexture, rectQuad, variedPhoto } from './synth';

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

/**
 * Die weite Suche: das Foto auch von weitem wiederfinden.
 *
 * Der Anlass steht in einem Satz vom echten Album: „Es findet die Fotos nicht
 * … eigentlich müsste mir die App sagen, ich soll näher ran, und mich führen."
 * Die enge Suche kann das nicht – sie probiert nur formatfüllende Lagen und
 * verwirft alles unter einem Zehntel der Bildfläche. Wer zu weit weg war,
 * bekam `null`, sah nichts gezeichnet und las das Gegenteil einer Führung.
 *
 * An den echten Albumbildern gemessen: Die weite Suche findet das Ziel bis
 * hinunter zu 4 % der Bildfläche mit höchstens 1,4 % Eckenfehler und schlug in
 * keinem Kreuzversuch auf ein falsches Foto an. Diese Tests halten dasselbe an
 * der synthetischen Vorlage fest, damit es jeden Bau überlebt.
 */
describe('die weite Suche für die Vorschau', () => {
  const source = sheet();
  const reference = fromPage(source, PHOTOS[0]);

  /** Ein Ausschnitt, in dem das Foto nur diesen Anteil der Fläche füllt. */
  function distantView(photo: Quad, areaShare: number): Quad {
    const cx = (photo[0].x + photo[2].x) / 2;
    const cy = (photo[0].y + photo[2].y) / 2;
    const w = ((photo[1].x - photo[0].x) / Math.sqrt(areaShare)) * 1;
    const h = ((photo[3].y - photo[0].y) / Math.sqrt(areaShare)) * 1;
    return rectQuad(cx - w / 2, cy - h / 2, w, h, 0);
  }

  it('findet das Foto, wo die enge Suche längst aufgegeben hat', () => {
    for (const share of [0.16, 0.08, 0.05]) {
      const view = distantView(PHOTOS[0], share);
      const frame = closeup(source, view, [900, 675]);
      const t = truth(PHOTOS[0], view, [900, 675]);

      // Gegenprobe im selben Atemzug: Die enge Suche gibt hier nichts her –
      // fiele das, wäre die weite überflüssig.
      expect(locate(reference, frame), `eng bei ${share}`).toBeNull();

      const wide = locate(reference, frame, PREVIEW_LOCATE);
      expect(wide, `weit bei ${share}`).not.toBeNull();
      expect(cornerError(wide!, t)).toBeLessThan(900 * 0.03);
    }
  });

  it('schlägt auch von weitem nicht auf das falsche Foto an', () => {
    // Die Voraussetzung für den automatischen Wechsel in der Führung: Ein
    // Fund ist eine Entscheidung, und die darf nicht raten.
    const other = fromPage(source, PHOTOS[1]);
    for (const share of [0.5, 0.16, 0.05]) {
      const frame = closeup(source, distantView(PHOTOS[0], share), [900, 675]);
      expect(locate(other, frame, PREVIEW_LOCATE)).toBeNull();
    }
  });

  it('verortet die ganze Seite als Anker, auch wenn sie übers Bild hinausragt', () => {
    // Wenn nicht einmal die weite Fotosuche trifft, bleibt die Seite selbst:
    // Sie ist im Sucher, sobald man von weitem draufhält, und aus ihrer Lage
    // fällt für jedes Foto der Ort im Bild – die Grundlage von „Näher heran
    // an Foto N, es ist markiert".
    const pageRef = warpPerspective(source, rectQuad(0, 0, ...SHEET, 0), 900, 675);
    for (const spread of [1.0, 0.8]) {
      // spread < 1: die Seite ragt übers Bild hinaus (mittlere Distanz).
      const w = SHEET[0] * spread;
      const h = SHEET[1] * spread;
      const view = rectQuad((SHEET[0] - w) / 2, (SHEET[1] - h) / 2, w, h, 0);
      const frame = closeup(source, view, [900, 675]);
      expect(locate(pageRef, frame, PAGE_LOCATE), `Seite bei ${spread}`).not.toBeNull();
    }
  });

  it('erkennt im Zuschnittvergleich dasselbe Foto wieder – und nur dieses', () => {
    // Der Prüfstein gegen Doppelte: „lässt mich dreimal dasselbe Foto
    // aufnehmen" darf nicht mehr gehen. An den echten Bildern: 9 von 9
    // Wiederholungen erkannt, 0 Fehlalarme.
    //
    // Hier mit detailreicher Fototextur: Die weichen Verläufe von
    // `variedPhoto` geben den NCC-Stücken nach dem Abtasten zu wenig Halt –
    // echte Abzüge haben Korn und Zeichnung, und genau darauf steht der
    // Vergleich.
    const rich = createRgba(...SHEET);
    fill(rich, 70, 50, 32);
    drawTextureInQuad(rich, kartonTexture(90, 68, [232, 226, 210], 3), rectQuad(40, 40, 1520, 1120, 0));
    // Foto 1 mit Korn (dort werden die Wiederholungen geprüft), Foto 2 aus
    // einer anderen Texturfamilie: Zwei Seeds desselben Wellenmusters wären
    // praktisch Zwillinge – ein Fall, den am echten Album nur der Nutzer
    // entscheiden kann und der hier nichts beweisen würde.
    drawTextureInQuad(rich, photoTexture(420, 320, 23), PHOTOS[0]);
    drawTextureInQuad(rich, variedPhoto(400, 300, 61), PHOTOS[1]);

    const crop = (photo: Quad, f: number, tilt: number) => {
      const cx = (photo[0].x + photo[2].x) / 2;
      const cy = (photo[0].y + photo[2].y) / 2;
      const w = ((photo[1].x - photo[0].x) / f) * 1;
      const h = ((photo[3].y - photo[0].y) / f) * 1;
      const q = rectQuad(cx - w / 2, cy - h / 2, w, h, 0).map((p, k) => ({
        x: p.x + (k === 1 ? tilt : -tilt / 2),
        y: p.y + (k === 2 ? tilt : -tilt / 2),
      })) as Quad;
      return warpPerspective(rich, q, 420, 315);
    };

    const stored = crop(PHOTOS[0], 1, 0);
    // Dieselbe Aufnahme, etwas anders getroffen: erkannt.
    expect(locate(crop(PHOTOS[0], 0.92, 8), stored, DUPLICATE_LOCATE)).not.toBeNull();
    expect(locate(crop(PHOTOS[0], 1.06, 5), stored, DUPLICATE_LOCATE)).not.toBeNull();
    // Das andere Foto der Seite: kein Alarm.
    expect(locate(crop(PHOTOS[1], 1, 0), stored, DUPLICATE_LOCATE)).toBeNull();
  });
});
