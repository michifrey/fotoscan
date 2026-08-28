import { describe, expect, it } from 'vitest';
import { detectPhotoQuads } from '../src/lib/imaging/detect';
import { createRgba } from '../src/lib/imaging/types';
import { drawTextureInQuad, fill, photoTexture, rectQuad } from './synth';

describe('Optionen', () => {
  it('ignoriert nicht gesetzte Felder statt die Vorgabe zu überschreiben', () => {
    const img = createRgba(1200, 900);
    fill(img, 238, 234, 226);
    drawTextureInQuad(img, photoTexture(320, 240, 1), rectQuad(300, 220, 600, 450));

    expect(detectPhotoQuads(img, { analysisSize: undefined })).toHaveLength(1);
    expect(detectPhotoQuads(img, {})).toHaveLength(1);
  });
});
