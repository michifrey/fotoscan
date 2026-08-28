import { describe, expect, it } from 'vitest';
import { detectPhotoQuads } from '../src/lib/imaging/detect';
import { polygonArea } from '../src/lib/imaging/geometry';
import { createRgba } from '../src/lib/imaging/types';
import type { Quad, RgbaImage } from '../src/lib/imaging/types';
import { addSoftShapes, centroid, drawHandwriting, drawTextureInQuad, fill, photoTexture, photoWithPaleArea, rectQuad } from './synth';

/** Holztisch, darauf die Albumseite. */
function tischMitSeite(width: number, height: number): RgbaImage {
  const img = createRgba(width, height);
  fill(img, 74, 52, 34);
  const seite = rectQuad(width * 0.06, height * 0.05, width * 0.86, height * 0.86, 0);
  const papier = createRgba(40, 30);
  fill(papier, 236, 226, 208);
  drawTextureInQuad(img, papier, seite);
  return img;
}

function bbox(q: Quad) {
  return {
    minX: Math.min(...q.map((p) => p.x)),
    maxX: Math.max(...q.map((p) => p.x)),
    minY: Math.min(...q.map((p) => p.y)),
    maxY: Math.max(...q.map((p) => p.y)),
  };
}

describe('echte Albumseiten', () => {
  it('lässt eine Bildunterschrift neben dem Foto aussen vor', () => {
    // Der Fall aus der Praxis: Handschrift, die bis an den Fotorand reicht.
    // Eine reine Kantensuche zieht sie in den Zuschnitt hinein.
    const scene = tischMitSeite(1400, 900);
    const foto = rectQuad(620, 150, 620, 460, 0);
    drawTextureInQuad(scene, photoTexture(320, 240, 7), foto);
    drawHandwriting(scene, 150, 300, 460, 52, 3);
    drawHandwriting(scene, 150, 400, 430, 52, 4);

    const found = detectPhotoQuads(scene);

    expect(found).toHaveLength(1);
    const box = bbox(found[0]);
    // Die Schrift endet bei x = 610; der Zuschnitt darf nicht dorthin greifen.
    expect(box.minX).toBeGreaterThan(590);
    expect(box.maxX).toBeGreaterThan(1200);
    const ratio = polygonArea(found[0]) / polygonArea(foto);
    expect(ratio).toBeGreaterThan(0.85);
    expect(ratio).toBeLessThan(1.15);
  });

  it('zerschneidet kein Foto, das selbst eine papierfarbene Fläche enthält', () => {
    // Eine helle Bettdecke im Foto hat fast die Farbe des Albumpapiers.
    const scene = tischMitSeite(1400, 900);
    const foto = rectQuad(400, 200, 620, 440, 0);
    drawTextureInQuad(scene, photoWithPaleArea(320, 240, 9, [232, 224, 210]), foto);

    const found = detectPhotoQuads(scene);

    expect(found).toHaveLength(1);
    expect(Math.hypot(centroid(found[0]).x - centroid(foto).x, centroid(found[0]).y - centroid(foto).y)).toBeLessThan(25);
    const ratio = polygonArea(found[0]) / polygonArea(foto);
    expect(ratio).toBeGreaterThan(0.85);
  });

  it('sucht nicht innerhalb eines Fotos weiter', () => {
    // Ein detailreiches Foto liefert selbst reichlich Kanten und Formen. Wer
    // darin weitersucht, findet seine Motive statt seiner Ränder – genau das
    // ist in der Praxis passiert.
    const scene = tischMitSeite(1400, 900);
    const foto = rectQuad(300, 180, 800, 520, 0);
    const inhalt = photoWithPaleArea(400, 300, 11, [228, 220, 206]);
    addSoftShapes(inhalt, 5, 3);
    drawTextureInQuad(scene, inhalt, foto);

    const found = detectPhotoQuads(scene);

    expect(found).toHaveLength(1);
    const ratio = polygonArea(found[0]) / polygonArea(foto);
    expect(ratio).toBeGreaterThan(0.8);
  });
});
