import { describe, expect, it } from 'vitest';
import { detectPhotoQuads } from '../src/lib/imaging/detect';
import { MIN_SCORE, inView, makeSubject, regionOf, trackSubject, visibleFraction } from '../src/lib/imaging/track';
import { createRgba } from '../src/lib/imaging/types';
import type { Quad, RgbaImage } from '../src/lib/imaging/types';
import { drawTextureInQuad, fill, kartonTexture, photoTexture, rectQuad } from './synth';

/**
 * Eine Albumseite auf dem Tisch, wahlweise verschoben, gedreht und
 * unterschiedlich hell – so, wie sie beim Abfahren der vier Punkte
 * nacheinander vor der Kamera liegt.
 */
function aufnahme(
  width: number,
  height: number,
  { dx = 0, dy = 0, drehung = 0, groesse = 1, helligkeit = 1 } = {},
): RgbaImage {
  const img = createRgba(width, height);
  fill(img, 74, 52, 34);

  const w = width * 0.72 * groesse;
  const h = height * 0.76 * groesse;
  const seite = rectQuad(width * 0.14 + dx - (w - width * 0.72) / 2, height * 0.12 + dy - (h - height * 0.76) / 2, w, h, drehung);
  drawTextureInQuad(img, kartonTexture(60, 45, [232, 222, 204], 5), seite);

  // Zwei Fotos auf der Seite – ihre Anordnung ist das eigentliche Muster.
  const inner = (fx: number, fy: number, fw: number, fh: number, seed: number) => {
    const box = rectQuad(
      seite[0].x + (seite[1].x - seite[0].x) * fx + (seite[3].x - seite[0].x) * fy,
      seite[0].y + (seite[1].y - seite[0].y) * fx + (seite[3].y - seite[0].y) * fy,
      w * fw,
      h * fh,
      drehung,
    );
    drawTextureInQuad(img, photoTexture(160, 120, seed), box);
  };
  inner(0.08, 0.08, 0.38, 0.36, 21);
  inner(0.54, 0.5, 0.38, 0.4, 34);

  if (helligkeit !== 1) {
    for (let i = 0; i < img.data.length; i += 4) {
      img.data[i] *= helligkeit;
      img.data[i + 1] *= helligkeit;
      img.data[i + 2] *= helligkeit;
    }
  }
  return img;
}

/** Ein anderer Ausschnitt der Welt: die Kamera schaut auf den blossen Tisch. */
function weggeschwenkt(width: number, height: number): RgbaImage {
  const img = createRgba(width, height);
  fill(img, 74, 52, 34);
  drawTextureInQuad(img, kartonTexture(50, 40, [70, 50, 32], 9), rectQuad(0, 0, width, height, 0));
  drawTextureInQuad(img, photoTexture(80, 60, 77), rectQuad(width * 0.62, height * 0.66, width * 0.3, height * 0.28, 6));
  return img;
}

function subjectOf(img: RgbaImage, quads: Quad[] = []) {
  const subject = makeSubject(img, regionOf(quads, img.width, img.height));
  expect(subject).not.toBeNull();
  return subject!;
}

describe('Motiv verfolgen', () => {
  it('findet die Albumseite wieder, wenn sie im Bild wandert', () => {
    const basis = aufnahme(480, 360);
    const subject = subjectOf(basis, detectPhotoQuads(basis));

    const bewegt = aufnahme(480, 360, { dx: 42, dy: -26 });
    const track = trackSubject(subject, bewegt);

    expect(track).not.toBeNull();
    expect(track!.score).toBeGreaterThan(MIN_SCORE);
    expect(inView(track)).toBe(true);
    // Die Punkte müssen der Seite folgen, nicht am Bildschirm kleben.
    expect(track!.center.x).toBeGreaterThan(0.5 + 42 / 480 - 0.06);
    expect(track!.center.y).toBeLessThan(0.5 - 26 / 360 + 0.06);
  });

  it('lässt sich von Helligkeit und leichter Drehung nicht beirren', () => {
    // Genau das passiert beim Neigen des Telefons: anderer Blickwinkel,
    // anderes Licht – aber dasselbe Album.
    const basis = aufnahme(480, 360);
    const subject = subjectOf(basis, detectPhotoQuads(basis));

    const geneigt = aufnahme(480, 360, { dx: 18, dy: 14, drehung: 4, groesse: 0.94, helligkeit: 0.78 });
    const track = trackSubject(subject, geneigt);

    expect(track).not.toBeNull();
    expect(inView(track)).toBe(true);
  });

  it('merkt, wenn die Kamera vom Album weggeschwenkt ist', () => {
    // Der gemeldete Fehler: Das Telefon zeigt woanders hin, ausgelöst wird
    // trotzdem. Ohne wiedergefundenes Motiv darf keine Aufnahme entstehen.
    const basis = aufnahme(480, 360);
    const subject = subjectOf(basis, detectPhotoQuads(basis));

    const track = trackSubject(subject, weggeschwenkt(480, 360));

    expect(inView(track)).toBe(false);
  });

  it('gilt als verloren, sobald das Motiv halb aus dem Bild läuft', () => {
    const basis = aufnahme(480, 360);
    const subject = subjectOf(basis, detectPhotoQuads(basis));

    const angeschnitten = aufnahme(480, 360, { dx: 300 });
    const track = trackSubject(subject, angeschnitten);

    expect(inView(track)).toBe(false);
  });

  it('findet das Motiv auch in einem viel kleineren Vorschaubild wieder', () => {
    // So läuft es in der App: gemerkt wird aus der Aufnahme in voller
    // Auflösung, wiedergesucht in einem stark verkleinerten Vorschaubild.
    const gross = aufnahme(960, 720);
    const subject = subjectOf(gross, detectPhotoQuads(gross));

    expect(inView(trackSubject(subject, aufnahme(288, 216, { dx: 12, dy: -8 })))).toBe(true);
    expect(inView(trackSubject(subject, weggeschwenkt(288, 216)))).toBe(false);
  });

  it('nimmt ohne Erkennung die Bildmitte als Motiv', () => {
    const region = regionOf([], 480, 360);
    expect(region.cx).toBeCloseTo(0.5);
    expect(region.cy).toBeCloseTo(0.5);

    const basis = aufnahme(480, 360);
    const subject = subjectOf(basis);
    expect(inView(trackSubject(subject, aufnahme(480, 360, { dx: 20 })))).toBe(true);
    expect(inView(trackSubject(subject, weggeschwenkt(480, 360)))).toBe(false);
  });

  it('gibt kein Muster aus, wenn der Ausschnitt keinerlei Struktur hat', () => {
    const leer = createRgba(240, 180);
    fill(leer, 240, 236, 228);
    expect(makeSubject(leer, regionOf([], 240, 180))).toBeNull();
  });

  it('misst, wie viel des Motivs noch im Bild liegt', () => {
    expect(visibleFraction({ cx: 0.5, cy: 0.5, hx: 0.2, hy: 0.2 })).toBeCloseTo(1);
    expect(visibleFraction({ cx: 0.1, cy: 0.5, hx: 0.2, hy: 0.2 })).toBeCloseTo(0.75);
    expect(visibleFraction({ cx: 0.0, cy: 0.5, hx: 0.2, hy: 0.2 })).toBeCloseTo(0.5);
  });
});
