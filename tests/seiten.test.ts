import { describe, expect, it } from 'vitest';
import { detectPhotoQuads } from '../src/lib/imaging/detect';
import { polygonArea } from '../src/lib/imaging/geometry';
import { createRgba } from '../src/lib/imaging/types';
import type { Quad, RgbaImage } from '../src/lib/imaging/types';
import { centroid, drawTextureInQuad, fill, kartonTexture, photoTexture, rectQuad } from './synth';

/** Holztisch mit aufgeschlagener, heller Albumseite. */
function seite(width: number, height: number, seitenQuad: Quad): RgbaImage {
  const img = createRgba(width, height);
  fill(img, 74, 52, 34);
  const papier = createRgba(40, 30);
  fill(papier, 234, 226, 210);
  drawTextureInQuad(img, papier, seitenQuad);
  return img;
}

function trefferFuer(found: Quad[], truth: Quad): number {
  const t = centroid(truth);
  return Math.min(...found.map((q) => Math.hypot(centroid(q).x - t.x, centroid(q).y - t.y)));
}

describe('volle Albumseiten', () => {
  it('findet sechs Fotos auf einer dicht belegten Seite', () => {
    // Der Normalfall in einem Familienalbum: die Seite ist voll, zwischen den
    // Fotos bleibt kaum Papier stehen.
    const scene = seite(1400, 1000, rectQuad(80, 60, 1240, 880));
    const fotos: Quad[] = [];
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 3; col++) {
        fotos.push(rectQuad(120 + col * 395, 100 + row * 412, 371, 388));
      }
    }
    fotos.forEach((q, i) => drawTextureInQuad(scene, photoTexture(300, 300, i + 1), q));

    const found = detectPhotoQuads(scene);

    expect(found).toHaveLength(6);
    for (const foto of fotos) expect(trefferFuer(found, foto)).toBeLessThan(30);
  });

  it('trennt zwei Fotos, zwischen denen nur ein Haarstrich Papier steht', () => {
    // Zwei Abzüge dicht nebeneinander geklebt. Dazwischen bleibt eine schmale
    // Papierlinie stehen – vier Bildpunkte bei 1400, auf einer Albumseite also
    // noch kein Millimeter. Weniger geht nicht: Berühren sich zwei Abzüge ohne
    // jedes Papier dazwischen, bleiben sie ein Fund, und die Ecken sind von
    // Hand zu ziehen.
    const scene = seite(1400, 1000, rectQuad(80, 60, 1240, 880));
    const links = rectQuad(300, 250, 380, 480);
    const rechts = rectQuad(684, 250, 380, 480);
    drawTextureInQuad(scene, photoTexture(300, 380, 4), links);
    drawTextureInQuad(scene, photoTexture(300, 380, 9), rechts);

    const found = detectPhotoQuads(scene);

    expect(found).toHaveLength(2);
    expect(trefferFuer(found, links)).toBeLessThan(35);
    expect(trefferFuer(found, rechts)).toBeLessThan(35);
  });

  it('findet helle Fotos auf einer schwarzen Albumseite', () => {
    // Schwarzer Karton ist in alten Alben genauso verbreitet wie helles
    // Papier. Er stellt die Farbtrennung vor eine eigene Aufgabe: Sein
    // Rauschen streut über mehrere Farbfächer, und wer nur das vollste Fach
    // nimmt, hält am Ende die glatte Tischplatte für den Untergrund – und
    // gibt die ganze Seite als ein Foto aus.
    const scene = createRgba(1400, 1000);
    fill(scene, 150, 140, 128);
    drawTextureInQuad(scene, kartonTexture(60, 45, [34, 32, 30], 5), rectQuad(90, 60, 1220, 880));
    const fotos = [rectQuad(200, 200, 420, 320), rectQuad(760, 220, 420, 320)];
    fotos.forEach((q, i) => drawTextureInQuad(scene, photoTexture(360, 280, i + 3), q));

    const found = detectPhotoQuads(scene);

    expect(found).toHaveLength(2);
    for (const foto of fotos) expect(trefferFuer(found, foto)).toBeLessThan(20);
    for (const q of found) expect(polygonArea(q)).toBeGreaterThan(polygonArea(fotos[0]) * 0.9);
  });

  it('findet die Fotos auch auf einer schräg liegenden Seite', () => {
    // Von Hand fotografiert liegt die Seite nie parallel zur Kamera.
    const schraeg: Quad = [
      { x: 150, y: 120 },
      { x: 1270, y: 60 },
      { x: 1330, y: 900 },
      { x: 90, y: 940 },
    ];
    const scene = seite(1400, 1000, schraeg);
    const fotos: Quad[] = [
      [
        { x: 240, y: 220 },
        { x: 640, y: 195 },
        { x: 655, y: 520 },
        { x: 245, y: 540 },
      ],
      [
        { x: 760, y: 190 },
        { x: 1160, y: 165 },
        { x: 1180, y: 490 },
        { x: 770, y: 512 },
      ],
    ];
    fotos.forEach((q, i) => drawTextureInQuad(scene, photoTexture(320, 260, i + 5), q));

    const found = detectPhotoQuads(scene);

    expect(found).toHaveLength(2);
    for (const foto of fotos) expect(trefferFuer(found, foto)).toBeLessThan(35);
  });

  it('nimmt bei einer dicht belegten Seite nicht einfach die ganze Seite', () => {
    const seitenQuad = rectQuad(80, 60, 1240, 880);
    const scene = seite(1400, 1000, seitenQuad);
    for (let i = 0; i < 4; i++) {
      drawTextureInQuad(scene, photoTexture(300, 300, i + 11), rectQuad(130 + (i % 2) * 600, 110 + Math.floor(i / 2) * 430, 560, 400));
    }

    const found = detectPhotoQuads(scene);

    // Kein einziger Fund darf so gross sein wie die Seite selbst.
    const seitenFlaeche = polygonArea(seitenQuad);
    for (const q of found) expect(polygonArea(q)).toBeLessThan(seitenFlaeche * 0.7);
  });
});
