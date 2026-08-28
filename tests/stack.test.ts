import { describe, expect, it } from 'vitest';
import { matchQuads } from '../src/lib/imaging/detect';
import { extractPhotos } from '../src/lib/imaging/stack';
import { mergeFrames } from '../src/lib/imaging/destack';
import { NO_ENHANCE } from '../src/lib/imaging/enhance';
import { outputSize, warpPerspective } from '../src/lib/imaging/warp';
import { createRgba } from '../src/lib/imaging/types';
import type { Quad, RgbaImage } from '../src/lib/imaging/types';
import { drawTextureInQuad, fill, photoTexture, rectQuad } from './synth';

/** Heller Spiegelungsfleck, wie ihn eine Lampe auf dem Abzug erzeugt. */
function withGlare(img: RgbaImage, cx: number, cy: number, radius: number): RgbaImage {
  const out = { data: new Uint8ClampedArray(img.data), width: img.width, height: img.height };
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d > radius) continue;
      const strength = 1 - d / radius;
      const i = (y * img.width + x) * 4;
      for (let c = 0; c < 3; c++) out.data[i + c] = out.data[i + c] + (255 - out.data[i + c]) * strength;
    }
  }
  return out;
}

function scene(texture: RgbaImage, quad: Quad): RgbaImage {
  const img = createRgba(1200, 900);
  fill(img, 234, 230, 220);
  drawTextureInQuad(img, texture, quad);
  return img;
}

function meanAbsDiff(a: RgbaImage, b: RgbaImage, inset: number): number {
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

describe('matchQuads', () => {
  it('ordnet verschobene Fotos der richtigen Vorlage zu', () => {
    const base: Quad[] = [rectQuad(100, 100, 300, 220), rectQuad(600, 120, 300, 220)];
    // Die Reihenfolge der Kandidaten ist bewusst vertauscht.
    const candidates: Quad[] = [rectQuad(620, 150, 300, 220), rectQuad(120, 130, 300, 220)];

    const matched = matchQuads(base, candidates);
    expect(matched[0]).toBe(candidates[1]);
    expect(matched[1]).toBe(candidates[0]);
  });

  it('ordnet nichts zu, wenn das Foto zu weit gewandert ist', () => {
    const base: Quad[] = [rectQuad(100, 100, 300, 220)];
    const candidates: Quad[] = [rectQuad(700, 600, 300, 220)];
    expect(matchQuads(base, candidates)[0]).toBeNull();
  });

  it('ordnet nichts zu, wenn das Format deutlich abweicht', () => {
    const base: Quad[] = [rectQuad(100, 100, 300, 220)];
    const candidates: Quad[] = [rectQuad(110, 105, 600, 440)];
    expect(matchQuads(base, candidates)[0]).toBeNull();
  });

  it('vergibt jedes Foto nur einmal', () => {
    const base: Quad[] = [rectQuad(100, 100, 300, 220), rectQuad(150, 120, 300, 220)];
    const candidates: Quad[] = [rectQuad(120, 110, 300, 220)];
    const matched = matchQuads(base, candidates);
    expect(matched.filter(Boolean)).toHaveLength(1);
  });
});

describe('extractPhotos', () => {
  it('rechnet Spiegelungen heraus, obwohl sich die Kamera zwischen den Aufnahmen bewegt', () => {
    const clean = photoTexture(300, 220, 9);
    // Fünf Haltungen wie beim Abfahren der vier Punkte: das Foto liegt jedes
    // Mal deutlich anders im Bild – verschoben, gedreht, etwas anders gross –
    // und die Spiegelung sitzt woanders auf dem Foto.
    const positions: Quad[] = [
      rectQuad(300, 200, 600, 440, 0),
      rectQuad(366, 152, 576, 452, 4.8),
      rectQuad(240, 230, 630, 422, -5.4),
      rectQuad(330, 266, 588, 410, 3.3),
      rectQuad(258, 170, 618, 464, -3.9),
    ];
    const glares: [number, number][] = [
      [70, 60],
      [220, 62],
      [72, 165],
      [225, 168],
      [150, 110],
    ];
    const frames = positions.map((quad, i) =>
      scene(withGlare(clean, glares[i][0], glares[i][1], 52), quad),
    );

    const size = outputSize(positions[0]);
    const ideal = warpPerspective(scene(clean, positions[0]), positions[0], size.width, size.height);

    const [result] = extractPhotos(frames, [positions[0]], NO_ENHANCE, 0);
    expect(result.width).toBe(size.width);

    // Zum Vergleich: alle Aufnahmen mit dem Viereck der ersten entzerrt. Der
    // Versatz lässt sich nur noch verschieben, nicht drehen – genau daran
    // scheitert das Verrechnen ohne eigene Erkennung je Aufnahme.
    const naive = mergeFrames(
      frames.map((frame) => warpPerspective(frame, positions[0], size.width, size.height)),
    );

    const withMatching = meanAbsDiff(result, ideal, 16);
    const withoutMatching = meanAbsDiff(naive, ideal, 16);

    expect(withMatching).toBeLessThan(5);
    expect(withMatching).toBeLessThan(withoutMatching * 0.6);
  });

  it('bleibt bei kaum bewegter Kamera mindestens gleich gut', () => {
    const clean = photoTexture(300, 220, 12);
    const positions: Quad[] = [
      rectQuad(300, 200, 600, 440, 0),
      rectQuad(308, 194, 597, 441, 0.6),
      rectQuad(294, 205, 603, 438, -0.7),
    ];
    const glares: [number, number][] = [
      [80, 70],
      [215, 75],
      [150, 160],
    ];
    const frames = positions.map((quad, i) => scene(withGlare(clean, glares[i][0], glares[i][1], 50), quad));
    const size = outputSize(positions[0]);
    const ideal = warpPerspective(scene(clean, positions[0]), positions[0], size.width, size.height);

    const [result] = extractPhotos(frames, [positions[0]], NO_ENHANCE, 0);
    expect(meanAbsDiff(result, ideal, 16)).toBeLessThan(5);
  });

  it('verwendet für die erste Aufnahme genau das übergebene Viereck', () => {
    const clean = photoTexture(300, 220, 4);
    const quad = rectQuad(300, 200, 600, 440);
    const [result] = extractPhotos([scene(clean, quad)], [quad], NO_ENHANCE, 0);
    const size = outputSize(quad);
    expect(result.width).toBe(size.width);
    expect(result.height).toBe(size.height);
  });

  it('dreht das Ergebnis wie angefordert', () => {
    const quad = rectQuad(300, 200, 600, 440);
    const [result] = extractPhotos([scene(photoTexture(300, 220, 2), quad)], [quad], NO_ENHANCE, 1);
    const size = outputSize(quad);
    expect(result.width).toBe(size.height);
    expect(result.height).toBe(size.width);
  });
});
