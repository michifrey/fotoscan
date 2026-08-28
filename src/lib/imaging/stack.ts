import { detectPhotoQuads, matchQuads } from './detect';
import { mergeFrames } from './destack';
import { enhance } from './enhance';
import type { EnhanceOptions } from './enhance';
import { outputSize, rotate, warpPerspective } from './warp';
import type { Quad, RgbaImage } from './types';

/**
 * Aus einer Aufnahmereihe die fertigen Fotos gewinnen.
 *
 * `baseQuads` gilt für die erste Aufnahme – dort hat der Nutzer den Zuschnitt
 * gesehen und gegebenenfalls die Ecken korrigiert. Für jede weitere Aufnahme
 * wird neu erkannt und zugeordnet, denn beim Entspiegeln bewegt sich das
 * Telefon absichtlich: Dasselbe Foto liegt dann woanders im Bild und in einer
 * anderen Perspektive. Erst dadurch landen alle Aufnahmen deckungsgleich auf
 * derselben Zielfläche und lassen sich überhaupt sinnvoll verrechnen.
 */
export function extractPhotos(
  frames: RgbaImage[],
  baseQuads: Quad[],
  options: EnhanceOptions,
  rotation: number,
): RgbaImage[] {
  const perFrame: (Quad | null)[][] = frames.map((frame, index) =>
    index === 0 ? baseQuads.slice() : matchQuads(baseQuads, detectPhotoQuads(frame)),
  );

  return baseQuads.map((baseQuad, photo) => {
    const size = outputSize(baseQuad);
    const warped: RgbaImage[] = [];

    for (let frame = 0; frame < frames.length; frame++) {
      const quad = perFrame[frame][photo];
      // Aufnahmen, in denen dieses Foto nicht sicher wiedergefunden wurde,
      // bleiben aussen vor – ein versetztes Bild verdürbe den Median.
      if (!quad) continue;
      warped.push(warpPerspective(frames[frame], quad, size.width, size.height));
    }

    const merged = warped.length > 1 ? mergeFrames(warped) : warped[0];
    return rotate(enhance(merged, options), rotation);
  });
}
