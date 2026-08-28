import { describe, expect, it } from 'vitest';
import { estimateShift, mergeFrames } from '../src/lib/imaging/destack';
import { toGray } from '../src/lib/imaging/gray';
import { autoLevels, enhance, grayWorld } from '../src/lib/imaging/enhance';
import { createRgba } from '../src/lib/imaging/types';
import type { RgbaImage } from '../src/lib/imaging/types';
import { fill, photoTexture } from './synth';

function copy(img: RgbaImage): RgbaImage {
  return { data: new Uint8ClampedArray(img.data), width: img.width, height: img.height };
}

/** Legt einen hellen Spiegelungsfleck über das Bild. */
function addGlare(img: RgbaImage, cx: number, cy: number, radius: number): RgbaImage {
  const out = copy(img);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d > radius) continue;
      const strength = 1 - d / radius;
      const i = (y * img.width + x) * 4;
      for (let c = 0; c < 3; c++) {
        out.data[i + c] = out.data[i + c] + (255 - out.data[i + c]) * strength;
      }
    }
  }
  return out;
}

function shiftImage(img: RgbaImage, dx: number, dy: number): RgbaImage {
  const out = createRgba(img.width, img.height);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const sx = x + dx;
      const sy = y + dy;
      const o = (y * img.width + x) * 4;
      const i = (Math.min(img.height - 1, Math.max(0, sy)) * img.width + Math.min(img.width - 1, Math.max(0, sx))) * 4;
      out.data[o] = img.data[i];
      out.data[o + 1] = img.data[i + 1];
      out.data[o + 2] = img.data[i + 2];
      out.data[o + 3] = 255;
    }
  }
  return out;
}

function meanAbsDiff(a: RgbaImage, b: RgbaImage, inset = 0): number {
  let sum = 0;
  let n = 0;
  for (let y = inset; y < a.height - inset; y++) {
    for (let x = inset; x < a.width - inset; x++) {
      const i = (y * a.width + x) * 4;
      for (let c = 0; c < 3; c++) {
        sum += Math.abs(a.data[i + c] - b.data[i + c]);
        n++;
      }
    }
  }
  return sum / n;
}

describe('estimateShift', () => {
  it('findet eine bekannte Verschiebung wieder', () => {
    const base = photoTexture(320, 240, 5);
    // moved(x, y) = base(x + 7, y - 5)
    const moved = shiftImage(base, 7, -5);

    // Zurückgegeben wird der Griff-Offset: moved(x + dx, y + dy) = base(x, y).
    const shift = estimateShift(toGray(base), toGray(moved), 24);
    expect(shift.dx).toBe(-7);
    expect(shift.dy).toBe(5);
  });

  it('meldet keine Verschiebung bei identischen Aufnahmen', () => {
    const base = photoTexture(240, 200, 8);
    const shift = estimateShift(toGray(base), toGray(base), 24);
    expect(shift).toEqual({ dx: 0, dy: 0 });
  });
});

describe('mergeFrames', () => {
  it('entfernt eine wandernde Spiegelung aus vier Aufnahmen', () => {
    const clean = photoTexture(300, 220, 9);
    const frames = [
      addGlare(clean, 70, 60, 55),
      addGlare(clean, 210, 70, 55),
      addGlare(clean, 80, 170, 55),
      addGlare(clean, 220, 165, 55),
    ];

    const before = Math.min(...frames.map((f) => meanAbsDiff(f, clean)));
    const merged = mergeFrames(frames);
    const after = meanAbsDiff(merged, clean);

    expect(after).toBeLessThan(before / 4);
    expect(after).toBeLessThan(3);
  });

  it('funktioniert auch, wenn die Aufnahmen leicht verwackelt sind', () => {
    const clean = photoTexture(300, 220, 4);
    const frames = [
      addGlare(clean, 80, 70, 50),
      shiftImage(addGlare(clean, 210, 80, 50), 4, 3),
      shiftImage(addGlare(clean, 90, 160, 50), -3, 5),
    ];

    const merged = mergeFrames(frames);
    // Randbereiche ausklammern: dort fehlen durch die Verschiebung Bilddaten.
    expect(meanAbsDiff(merged, clean, 12)).toBeLessThan(8);
  });

  it('nimmt bei zwei Aufnahmen den dunkleren, spiegelungsfreien Wert', () => {
    const clean = photoTexture(200, 150, 6);
    const merged = mergeFrames([addGlare(clean, 60, 50, 40), addGlare(clean, 150, 100, 40)]);
    expect(meanAbsDiff(merged, clean)).toBeLessThan(1.5);
  });

  it('gibt bei einer einzelnen Aufnahme diese unverändert zurück', () => {
    const only = photoTexture(40, 30, 1);
    expect(mergeFrames([only])).toBe(only);
  });
});

describe('enhance', () => {
  it('spreizt flaue Tonwerte auf den vollen Umfang', () => {
    const img = createRgba(64, 64);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = 110 + ((i / 4) % 30);
      img.data[i] = v;
      img.data[i + 1] = v;
      img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    autoLevels(img);
    let min = 255;
    let max = 0;
    for (let i = 0; i < img.data.length; i += 4) {
      min = Math.min(min, img.data[i]);
      max = Math.max(max, img.data[i]);
    }
    expect(min).toBeLessThan(20);
    expect(max).toBeGreaterThan(235);
  });

  it('schwächt einen Gelbstich deutlich ab', () => {
    const img = createRgba(32, 32);
    fill(img, 180, 150, 110);
    grayWorld(img);
    const [r, g, b] = [img.data[0], img.data[1], img.data[2]];
    const spread = Math.max(r, g, b) - Math.min(r, g, b);
    expect(spread).toBeLessThan(40); // vorher: 70
    // Aber nicht vollständig neutralisieren – der Charakter alter Abzüge bleibt.
    expect(spread).toBeGreaterThan(5);
  });

  it('lässt die Farben beim Spreizen der Tonwerte in Balance', () => {
    // Ein flauer, aber farbiger Verlauf darf durch autoLevels nicht entfärbt werden.
    const img = createRgba(64, 64);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = 90 + ((i / 4) % 40);
      img.data[i] = v + 30;
      img.data[i + 1] = v;
      img.data[i + 2] = v - 25;
      img.data[i + 3] = 255;
    }
    autoLevels(img);
    // Der Rotüberschuss gegenüber Blau bleibt erhalten.
    expect(img.data[0] - img.data[2]).toBeGreaterThan(60);
  });

  it('lässt die Bildgrösse unverändert und verändert das Original nicht', () => {
    const img = photoTexture(60, 40, 2);
    const before = new Uint8ClampedArray(img.data);
    const result = enhance(img, { levels: true, whiteBalance: true, sharpen: true });
    expect(result.width).toBe(60);
    expect(result.height).toBe(40);
    expect(Array.from(img.data)).toEqual(Array.from(before));
  });
});
