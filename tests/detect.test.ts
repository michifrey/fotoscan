import { describe, expect, it } from 'vitest';
import { detectPhotoQuads } from '../src/lib/imaging/detect';
import { polygonArea } from '../src/lib/imaging/geometry';
import { createRgba } from '../src/lib/imaging/types';
import type { Quad } from '../src/lib/imaging/types';
import { centroid, drawTextureInQuad, fill, flatTexture, photoTexture, rectQuad } from './synth';

function page(quads: Quad[], width = 1200, height = 900, background = 238): ReturnType<typeof createRgba> {
  const img = createRgba(width, height);
  fill(img, background, background - 4, background - 12);
  quads.forEach((q, i) => {
    drawTextureInQuad(img, photoTexture(320, 240, i + 1), q);
  });
  return img;
}

function nearest(found: Quad[], target: Quad): { quad: Quad; distance: number } | null {
  const t = centroid(target);
  let best: { quad: Quad; distance: number } | null = null;
  for (const q of found) {
    const c = centroid(q);
    const d = Math.hypot(c.x - t.x, c.y - t.y);
    if (!best || d < best.distance) best = { quad: q, distance: d };
  }
  return best;
}

describe('detectPhotoQuads', () => {
  it('findet ein einzelnes, gerade liegendes Foto', () => {
    const truth = rectQuad(300, 220, 600, 450);
    const found = detectPhotoQuads(page([truth]));

    expect(found).toHaveLength(1);
    const match = nearest(found, truth)!;
    expect(match.distance).toBeLessThan(12);
    expect(polygonArea(match.quad) / polygonArea(truth)).toBeGreaterThan(0.9);
    expect(polygonArea(match.quad) / polygonArea(truth)).toBeLessThan(1.1);
  });

  it('findet ein gedrehtes Foto und liefert die Ecken in Reihenfolge', () => {
    const truth = rectQuad(280, 180, 620, 460, 14);
    const found = detectPhotoQuads(page([truth]));

    expect(found).toHaveLength(1);
    const quad = found[0];
    // Reihenfolge TL, TR, BR, BL: erste Ecke links oben, dritte rechts unten.
    expect(quad[0].x).toBeLessThan(quad[2].x);
    expect(quad[0].y).toBeLessThan(quad[2].y);
    expect(nearest(found, truth)!.distance).toBeLessThan(14);
  });

  it('findet ein perspektivisch verzerrtes Foto', () => {
    const truth: Quad = [
      { x: 250, y: 210 },
      { x: 930, y: 160 },
      { x: 980, y: 700 },
      { x: 200, y: 660 },
    ];
    const found = detectPhotoQuads(page([truth]));

    expect(found).toHaveLength(1);
    for (let i = 0; i < 4; i++) {
      expect(Math.hypot(found[0][i].x - truth[i].x, found[0][i].y - truth[i].y)).toBeLessThan(20);
    }
  });

  it('trennt mehrere Fotos auf einer Albumseite', () => {
    const truths = [
      rectQuad(90, 90, 440, 330, 2),
      rectQuad(640, 110, 450, 320, -3),
      rectQuad(120, 500, 430, 320, -1),
      rectQuad(660, 520, 440, 300, 3),
    ];
    const found = detectPhotoQuads(page(truths));

    expect(found).toHaveLength(4);
    for (const truth of truths) {
      const match = nearest(found, truth)!;
      expect(match.distance).toBeLessThan(15);
      const ratio = polygonArea(match.quad) / polygonArea(truth);
      expect(ratio).toBeGreaterThan(0.85);
      expect(ratio).toBeLessThan(1.15);
    }
  });

  it('erkennt Fotos auch auf einer dunklen Albumseite', () => {
    const truths = [rectQuad(120, 140, 460, 340), rectQuad(660, 160, 440, 330)];
    const found = detectPhotoQuads(page(truths, 1200, 900, 28));

    expect(found).toHaveLength(2);
    for (const truth of truths) {
      expect(nearest(found, truth)!.distance).toBeLessThan(15);
    }
  });

  it('liefert die Fotos in Leserichtung', () => {
    const topLeft = rectQuad(90, 90, 420, 320);
    const topRight = rectQuad(660, 100, 420, 310);
    const bottom = rectQuad(300, 520, 500, 300);
    const found = detectPhotoQuads(page([bottom, topRight, topLeft]));

    expect(found).toHaveLength(3);
    const cs = found.map(centroid);
    expect(cs[0].x).toBeLessThan(cs[1].x);
    expect(cs[1].y).toBeLessThan(cs[2].y);
  });

  it('greift durch die Albumseite hindurch auf die einzelnen Fotos', () => {
    // Der wichtigste Fall aus der Praxis: die aufgeschlagene Albumseite liegt
    // auf einem dunklen Tisch und wird als Ganzes abfotografiert. Erkannt
    // werden sollen die Fotos darauf, nicht die Seite.
    const scene = createRgba(1400, 1000);
    fill(scene, 40, 38, 36);
    const pageQuad = rectQuad(160, 110, 1080, 780, 2);
    drawTextureInQuad(scene, flatTexture(200, 150, 236, 232, 222), pageQuad);

    const truths = [rectQuad(280, 230, 400, 300, 2), rectQuad(760, 250, 400, 300, 2), rectQuad(420, 610, 520, 260, 2)];
    truths.forEach((q, i) => drawTextureInQuad(scene, photoTexture(320, 240, i + 20), q));

    const found = detectPhotoQuads(scene);

    expect(found).toHaveLength(3);
    for (const truth of truths) {
      const match = nearest(found, truth)!;
      expect(match.distance).toBeLessThan(18);
      const ratio = polygonArea(match.quad) / polygonArea(truth);
      expect(ratio).toBeGreaterThan(0.85);
      expect(ratio).toBeLessThan(1.15);
    }
  });

  it('nimmt die Albumseite selbst, wenn kein einzelnes Foto darauf liegt', () => {
    const scene = createRgba(1200, 900);
    fill(scene, 35, 34, 32);
    const pageQuad = rectQuad(200, 140, 800, 600, 3);
    drawTextureInQuad(scene, photoTexture(320, 240, 31), pageQuad);

    const found = detectPhotoQuads(scene);
    expect(found).toHaveLength(1);
    expect(nearest(found, pageQuad)!.distance).toBeLessThan(15);
  });

  it('meldet nichts bei einer leeren Albumseite', () => {
    const img = createRgba(800, 600);
    fill(img, 240, 236, 228);
    expect(detectPhotoQuads(img)).toHaveLength(0);
  });
});
