import { describe, expect, it } from 'vitest';
import { refinePhoto, removeGlare } from '../src/lib/imaging/closeup';
import { detectPhotoQuads } from '../src/lib/imaging/detect';
import { mergePhotos } from '../src/lib/imaging/stack';
import { polygonArea } from '../src/lib/imaging/geometry';
import { NO_ENHANCE } from '../src/lib/imaging/enhance';
import { downscaleRgba, toGray } from '../src/lib/imaging/gray';
import { gradientMagnitude } from '../src/lib/imaging/mask';
import { createRgba } from '../src/lib/imaging/types';
import type { Quad, RgbaImage } from '../src/lib/imaging/types';
import { warpPerspective } from '../src/lib/imaging/warp';
import { addSoftShapes, drawTextureInQuad, fill, photoTexture, photoWithPaleArea, rectQuad } from './synth';

/** Eine Spiegelung: heller Fleck mit weichem Rand, wie ihn eine Lampe wirft. */
function addGlare(img: RgbaImage, cx: number, cy: number, rx: number, ry: number, strength: number): void {
  for (let y = Math.round(cy - ry); y <= cy + ry; y++) {
    for (let x = Math.round(cx - rx); x <= cx + rx; x++) {
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
      const d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
      if (d > 1) continue;
      const amount = (1 - Math.sqrt(d)) * strength;
      const i = (y * img.width + x) * 4;
      for (let c = 0; c < 3; c++) img.data[i + c] = img.data[i + c] * (1 - amount) + 255 * amount;
    }
  }
}

function copy(img: RgbaImage): RgbaImage {
  return { data: new Uint8ClampedArray(img.data), width: img.width, height: img.height };
}

/** Mittlerer Fehler gegenüber der Vorlage in einem Bildausschnitt. */
function error(img: RgbaImage, truth: RgbaImage, x0: number, y0: number, x1: number, y1: number): number {
  let sum = 0;
  let count = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * img.width + x) * 4;
      for (let c = 0; c < 3; c++) sum += Math.abs(img.data[i + c] - truth.data[i + c]);
      count += 3;
    }
  }
  return sum / count;
}

/** Mittlere Kantenstärke – ein Mass dafür, wie viel Zeichnung im Bild steckt. */
function detailLevel(img: RgbaImage): number {
  const magnitude = gradientMagnitude(toGray(img));
  let sum = 0;
  for (const value of magnitude) sum += value;
  return sum / magnitude.length;
}

/** Der echte Abzug, wie er ohne Spiegelung und in voller Auflösung aussähe. */
function abzug(width: number, height: number, seed: number): RgbaImage {
  return photoTexture(width, height, seed);
}

/**
 * Die Nahaufnahme, wie die Kamera sie liefert: der Abzug im Bild, ringsum
 * Albumpapier, dazu eine eigene Spiegelung.
 */
function nahaufnahme(abzugBild: RgbaImage, quad: Quad, width: number, height: number): RgbaImage {
  const frame = createRgba(width, height);
  fill(frame, 232, 224, 208);
  drawTextureInQuad(frame, abzugBild, quad);
  return frame;
}

describe('Nahaufnahme', () => {
  it('ersetzt die Spiegelung der Nahaufnahme durch die Seitenaufnahme', () => {
    const truth = abzug(600, 450, 4);

    // Die Nahaufnahme: scharf, aber mit Glanz auf der linken Seite.
    const detail = copy(truth);
    addGlare(detail, 170, 220, 90, 70, 0.85);

    // Die Seitenaufnahme desselben Fotos: weich, weil hochgerechnet, und mit
    // Glanz an einer ganz anderen Stelle. Etwas dunkler belichtet ist sie auch.
    const wide = copy(truth);
    addGlare(wide, 470, 130, 80, 60, 0.85);
    for (let i = 0; i < wide.data.length; i += 4) {
      for (let c = 0; c < 3; c++) wide.data[i + c] = wide.data[i + c] * 0.88;
    }
    const reference = upscale(downscaleRgba(wide, 200).image, 600, 450);

    const merged = removeGlare(detail, reference);

    // Wo die Nahaufnahme glänzte, ist der Fehler deutlich kleiner geworden.
    const vorher = error(detail, truth, 100, 165, 240, 275);
    const nachher = error(merged, truth, 100, 165, 240, 275);
    expect(nachher).toBeLessThan(vorher * 0.5);

    // Und die Spiegelung der Seitenaufnahme wandert nicht mit hinein.
    expect(error(merged, truth, 400, 80, 540, 180)).toBeLessThan(6);

    // Die Zeichnung bleibt: fast so viel wie in der Nahaufnahme, weit mehr als
    // in der hochgerechneten Seitenaufnahme.
    expect(detailLevel(merged)).toBeGreaterThan(detailLevel(reference) * 2);
    expect(detailLevel(merged)).toBeGreaterThan(detailLevel(detail) * 0.9);

    // Und ausserhalb der Spiegelung bleibt die Nahaufnahme unangetastet. Ohne
    // diese Prüfung schleicht sich die Weichheit der Seitenaufnahme über
    // hunderte kleiner Stellen ins ganze Bild: Eine scharfe Aufnahme ist an
    // ihren hellsten Punkten fast überall etwas heller als eine weiche.
    expect(error(merged, detail, 300, 280, 580, 430)).toBeLessThan(0.5);
  });

  it('lässt die Nahaufnahme unangetastet, wenn die Vergleichsaufnahme nicht passt', () => {
    // Der Fall aus der Praxis: Beim Nachfotografieren wird das falsche Foto
    // erwischt. Dann darf nichts übernommen werden – sonst stünden Teile eines
    // fremden Bildes im Abzug.
    const detail = abzug(400, 300, 7);
    const fremd = photoWithPaleArea(400, 300, 21, [232, 224, 208]);
    addSoftShapes(fremd, 3, 4);

    // Unverändert heisst hier: dasselbe Bild, nicht bloss ein gleiches.
    expect(removeGlare(detail, fremd) === detail).toBe(true);
  });

  it('macht aus Seiten- und Nahaufnahme ein Foto mit mehr Zeichnung', () => {
    const truth = abzug(600, 450, 9);

    // Was von diesem Foto auf der Seitenaufnahme übrig bleibt: ein kleiner
    // Ausschnitt von 200 Bildpunkten Kantenlänge, mit Spiegelung.
    const wide = copy(truth);
    addGlare(wide, 430, 300, 90, 70, 0.8);
    const reference = downscaleRgba(wide, 200).image;

    // Die Nahaufnahme: das Foto füllt fast das ganze Bild, eigene Spiegelung.
    const near = copy(truth);
    addGlare(near, 160, 140, 90, 70, 0.8);
    const quad = rectQuad(60, 45, 600, 450, 0);
    const frame = nahaufnahme(near, quad, 720, 540);

    const result = refinePhoto(reference, { image: frame, quad }, NO_ENHANCE, 0);

    expect(result.width).toBeGreaterThan(reference.width * 2);
    expect(detailLevel(result)).toBeGreaterThan(detailLevel(upscale(reference, result.width, result.height)) * 1.5);
  });

  it('führt Seitenaufnahme und Nahaufnahme zum selben Foto zusammen', () => {
    // Der ganze Weg, wie ihn die App geht: Auf der Seitenaufnahme liegen zwei
    // Fotos, jedes davon nur ein paar hundert Bildpunkte breit. Die
    // Nahaufnahme zeigt eines davon allein und um ein Vielfaches grösser.
    const links = abzug(900, 700, 12);
    const rechts = abzug(900, 700, 15);

    const seite = createRgba(1400, 1000);
    fill(seite, 74, 52, 34);
    const papier = createRgba(40, 30);
    fill(papier, 234, 226, 210);
    drawTextureInQuad(seite, papier, rectQuad(80, 60, 1240, 880));
    const linksQuad = rectQuad(160, 200, 500, 390);
    drawTextureInQuad(seite, links, linksQuad);
    drawTextureInQuad(seite, rechts, rectQuad(740, 200, 500, 390));
    // Auf der Seitenaufnahme glänzt das linke Foto oben links.
    addGlare(seite, 260, 300, 90, 70, 0.8);

    const gefunden = detectPhotoQuads(seite);
    expect(gefunden).toHaveLength(2);
    const references = mergePhotos([seite], gefunden);

    // Das linke Foto ist das erste in Leserichtung.
    const reference = references[0];
    expect(reference.width).toBeLessThan(560);

    // Die Nahaufnahme desselben Fotos: fast formatfüllend, eigene Spiegelung
    // an ganz anderer Stelle.
    const nah = createRgba(1100, 860);
    fill(nah, 234, 226, 210);
    const nahQuad = rectQuad(70, 60, 960, 745);
    drawTextureInQuad(nah, links, nahQuad);
    addGlare(nah, 700, 600, 130, 100, 0.8);

    const erkannt = detectPhotoQuads(nah);
    expect(erkannt.length).toBeGreaterThan(0);
    const quad = erkannt.slice().sort((a, b) => polygonArea(b) - polygonArea(a))[0];

    const result = refinePhoto(reference, { image: nah, quad }, NO_ENHANCE, 0);

    // Deutlich mehr Bildpunkte als aus der Seitenaufnahme allein …
    expect(result.width).toBeGreaterThan(reference.width * 1.7);
    // … und die Spiegelung der Nahaufnahme ist verschwunden: In ihrem Bereich
    // ist das Ergebnis dunkler als die blanke Nahaufnahme.
    const roh = warpPerspective(nah, quad, result.width, result.height);
    expect(brightness(result, 0.55, 0.6, 0.9, 0.95)).toBeLessThan(brightness(roh, 0.55, 0.6, 0.9, 0.95) - 10);
  });

  it('bleibt bei der Seitenaufnahme, wenn die Nahaufnahme nichts hinzufügt', () => {
    const reference = abzug(400, 300, 5);
    const quad = rectQuad(20, 15, 380, 285, 0);
    const frame = nahaufnahme(abzug(380, 285, 5), quad, 420, 320);

    const result = refinePhoto(reference, { image: frame, quad }, NO_ENHANCE, 0);

    expect(result.width).toBe(reference.width);
    expect(result.height).toBe(reference.height);
  });
});

/** Mittlere Helligkeit in einem Ausschnitt, angegeben in Anteilen der Fläche. */
function brightness(img: RgbaImage, x0: number, y0: number, x1: number, y1: number): number {
  let sum = 0;
  let count = 0;
  for (let y = Math.round(img.height * y0); y < img.height * y1; y++) {
    for (let x = Math.round(img.width * x0); x < img.width * x1; x++) {
      const i = (y * img.width + x) * 4;
      sum += (img.data[i] + img.data[i + 1] + img.data[i + 2]) / 3;
      count++;
    }
  }
  return sum / Math.max(1, count);
}

/** Hilfsfunktion der Tests: bilineares Hochrechnen über die Entzerrung. */
function upscale(src: RgbaImage, width: number, height: number): RgbaImage {
  const out = createRgba(width, height);
  const sx = (src.width - 1) / (width - 1);
  const sy = (src.height - 1) / (height - 1);
  for (let y = 0; y < height; y++) {
    const fy = y * sy;
    const y0 = Math.floor(fy);
    const y1 = Math.min(src.height - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = x * sx;
      const x0 = Math.floor(fx);
      const x1 = Math.min(src.width - 1, x0 + 1);
      const wx = fx - x0;
      const o = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) {
        const a = src.data[(y0 * src.width + x0) * 4 + c] * (1 - wx) + src.data[(y0 * src.width + x1) * 4 + c] * wx;
        const b = src.data[(y1 * src.width + x0) * 4 + c] * (1 - wx) + src.data[(y1 * src.width + x1) * 4 + c] * wx;
        out.data[o + c] = a * (1 - wy) + b * wy;
      }
      out.data[o + 3] = 255;
    }
  }
  return out;
}
