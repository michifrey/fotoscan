import { describe, expect, it } from 'vitest';
import { computeHomography, outputSize, rotate, warpPerspective } from '../src/lib/imaging/warp';
import { detectPhotoQuads } from '../src/lib/imaging/detect';
import { createRgba } from '../src/lib/imaging/types';
import type { Quad } from '../src/lib/imaging/types';
import { drawTextureInQuad, fill, photoTexture, rectQuad } from './synth';

function pixel(img: { data: Uint8ClampedArray; width: number }, x: number, y: number): number[] {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
}

describe('computeHomography', () => {
  it('bildet die Eckpunkte exakt aufeinander ab', () => {
    const src: Quad = [
      { x: 10, y: 20 },
      { x: 300, y: 5 },
      { x: 330, y: 260 },
      { x: 0, y: 240 },
    ];
    const dst: Quad = [
      { x: 0, y: 0 },
      { x: 199, y: 0 },
      { x: 199, y: 149 },
      { x: 0, y: 149 },
    ];
    const h = computeHomography(src, dst);

    for (let i = 0; i < 4; i++) {
      const denom = h[6] * src[i].x + h[7] * src[i].y + h[8];
      const x = (h[0] * src[i].x + h[1] * src[i].y + h[2]) / denom;
      const y = (h[3] * src[i].x + h[4] * src[i].y + h[5]) / denom;
      expect(x).toBeCloseTo(dst[i].x, 6);
      expect(y).toBeCloseTo(dst[i].y, 6);
    }
  });
});

describe('warpPerspective', () => {
  it('entzerrt ein schräg fotografiertes Foto zurück auf die Textur', () => {
    const texture = photoTexture(400, 300, 7);
    const scene = createRgba(1200, 900);
    fill(scene, 240, 238, 232);
    const quad: Quad = [
      { x: 200, y: 150 },
      { x: 980, y: 90 },
      { x: 1030, y: 760 },
      { x: 150, y: 700 },
    ];
    drawTextureInQuad(scene, texture, quad);

    const warped = warpPerspective(scene, quad, 400, 300);

    // Die entzerrte Fläche muss der Ausgangstextur wieder entsprechen.
    let diff = 0;
    let n = 0;
    for (let y = 8; y < 292; y += 4) {
      for (let x = 8; x < 392; x += 4) {
        const a = pixel(warped, x, y);
        const b = pixel(texture, x, y);
        diff += Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
        n += 3;
      }
    }
    expect(diff / n).toBeLessThan(12);
  });

  it('erkennt und entzerrt in einem Durchgang', () => {
    const texture = photoTexture(300, 400, 3);
    const scene = createRgba(1000, 1000);
    fill(scene, 235, 232, 226);
    const quad = rectQuad(250, 200, 480, 620, 9);
    drawTextureInQuad(scene, texture, quad);

    const [found] = detectPhotoQuads(scene);
    expect(found).toBeDefined();
    const size = outputSize(found);
    // Hochformat bleibt Hochformat.
    expect(size.height).toBeGreaterThan(size.width);
    const warped = warpPerspective(scene, found, size.width, size.height);
    expect(warped.width).toBe(size.width);

    // In der Mitte darf kein Seitenhintergrund mehr auftauchen.
    const mid = pixel(warped, size.width >> 1, size.height >> 1);
    expect(Math.min(...mid)).toBeLessThan(220);
  });
});

describe('outputSize', () => {
  it('begrenzt sehr grosse Ausgaben', () => {
    const quad = rectQuad(0, 0, 9000, 6000);
    const size = outputSize(quad, 3600);
    expect(Math.max(size.width, size.height)).toBe(3600);
    expect(size.width / size.height).toBeCloseTo(1.5, 1);
  });
});

describe('rotate', () => {
  it('dreht viermal zurück zum Original', () => {
    const img = photoTexture(40, 30, 11);
    let turned = img;
    for (let i = 0; i < 4; i++) turned = rotate(turned, 1);
    expect(turned.width).toBe(img.width);
    expect(turned.height).toBe(img.height);
    expect(Array.from(turned.data)).toEqual(Array.from(img.data));
  });

  it('tauscht bei einer Vierteldrehung Breite und Höhe', () => {
    const img = photoTexture(40, 30, 12);
    const turned = rotate(img, 1);
    expect(turned.width).toBe(30);
    expect(turned.height).toBe(40);
    expect(pixel(turned, 29, 0)).toEqual(pixel(img, 0, 0));
  });
});
