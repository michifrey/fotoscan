import { describe, expect, it } from 'vitest';
import { detectPhotoQuads } from '../src/lib/imaging/detect';
import { outputSize, warpPerspective } from '../src/lib/imaging/warp';
import { createRgba } from '../src/lib/imaging/types';
import type { RgbaImage } from '../src/lib/imaging/types';
import { drawTextureInQuad, fill, flatTexture, photoTexture, rectQuad } from './synth';

/** Mittlere Helligkeit des äussersten Rahmens eines Bildes. */
function borderBrightness(img: RgbaImage, thickness: number): number {
  let sum = 0;
  let n = 0;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const onBorder =
        x < thickness || y < thickness || x >= img.width - thickness || y >= img.height - thickness;
      if (!onBorder) continue;
      const i = (y * img.width + x) * 4;
      sum += (img.data[i] + img.data[i + 1] + img.data[i + 2]) / 3;
      n++;
    }
  }
  return sum / n;
}

describe('Zuschnitt', () => {
  it('nimmt keinen hellen Saum der Albumseite mit', () => {
    const scene = createRgba(1400, 1000);
    fill(scene, 236, 232, 222); // helle Albumseite
    const truth = rectQuad(300, 220, 620, 460, 3);
    drawTextureInQuad(scene, photoTexture(320, 240, 5), truth);

    const [quad] = detectPhotoQuads(scene);
    expect(quad).toBeDefined();
    const size = outputSize(quad);
    const warped = warpPerspective(scene, quad, size.width, size.height);

    // Das Foto selbst ist deutlich dunkler als die Seite (236).
    expect(borderBrightness(warped, 2)).toBeLessThan(190);
  });

  it('nimmt bei mehreren Fotos auf einer Seite ebenfalls keinen Saum mit', () => {
    const scene = createRgba(1400, 1000);
    fill(scene, 40, 38, 36);
    drawTextureInQuad(scene, flatTexture(200, 150, 236, 232, 222), rectQuad(160, 110, 1080, 780, 2));
    const truths = [rectQuad(280, 230, 400, 300, 2), rectQuad(760, 250, 400, 300, 2)];
    truths.forEach((q, i) => drawTextureInQuad(scene, photoTexture(320, 240, i + 20), q));

    const found = detectPhotoQuads(scene);
    expect(found).toHaveLength(2);
    for (const quad of found) {
      const size = outputSize(quad);
      expect(borderBrightness(warpPerspective(scene, quad, size.width, size.height), 2)).toBeLessThan(190);
    }
  });
});
