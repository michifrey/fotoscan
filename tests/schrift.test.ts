import { describe, expect, it } from 'vitest';
import { detectPhotoQuads } from '../src/lib/imaging/detect';
import { cropWriting, findWriting } from '../src/lib/imaging/writing';
import { createRgba } from '../src/lib/imaging/types';
import type { Quad, RgbaImage } from '../src/lib/imaging/types';
import { drawHandwriting, drawTextureInQuad, fill, photoTexture, rectQuad } from './synth';

/** Holztisch, darauf die helle Albumseite. */
function seite(width: number, height: number): RgbaImage {
  const img = createRgba(width, height);
  fill(img, 74, 52, 34);
  const papier = createRgba(40, 30);
  fill(papier, 234, 226, 210);
  drawTextureInQuad(img, papier, rectQuad(width * 0.05, height * 0.05, width * 0.88, height * 0.88, 0));
  return img;
}

function foto(scene: RgbaImage, quad: Quad, seed: number): Quad {
  drawTextureInQuad(scene, photoTexture(320, 240, seed), quad);
  return quad;
}

/** Trifft der gefundene Ausschnitt die geschriebene Zeile? */
function deckt(box: { minX: number; minY: number; maxX: number; maxY: number }, x: number, y: number, w: number, h: number): boolean {
  return box.minX <= x + 20 && box.maxX >= x + w - 20 && box.minY <= y + 20 && box.maxY >= y + h - 20;
}

describe('Handschrift', () => {
  it('findet die Zeile unter einem Foto und ordnet sie ihm zu', () => {
    const scene = seite(1400, 1000);
    const quad = foto(scene, rectQuad(300, 150, 700, 520, 0), 3);
    drawHandwriting(scene, 320, 730, 560, 54, 7);

    const quads = detectPhotoQuads(scene);
    expect(quads).toHaveLength(1);
    const found = findWriting(scene, quads);

    expect(found).toHaveLength(1);
    expect(found[0].photo).toBe(0);
    expect(deckt(found[0].box, 320, 730, 560, 54)).toBe(true);
    // Und das Foto selbst bleibt draussen.
    expect(found[0].box.minY).toBeGreaterThan(quad[2].y);
  });

  it('gibt jedem Foto seine eigene Zeile', () => {
    const scene = seite(1400, 1000);
    foto(scene, rectQuad(120, 120, 520, 380, 0), 5);
    foto(scene, rectQuad(760, 120, 520, 380, 0), 8);
    drawHandwriting(scene, 140, 540, 420, 46, 11);
    drawHandwriting(scene, 780, 540, 420, 46, 13);

    const quads = detectPhotoQuads(scene);
    expect(quads).toHaveLength(2);
    const found = findWriting(scene, quads);

    expect(found.map((entry) => entry.photo)).toEqual([0, 1]);
    // Die linke Zeile gehört zum linken Foto, die rechte zum rechten.
    expect(found[0].box.maxX).toBeLessThan(700);
    expect(found[1].box.minX).toBeGreaterThan(700);
  });

  it('gibt eine Zeile zwischen zwei Fotos dem darüber', () => {
    // Der Regelfall auf einer vollen Seite: Die Zeile steht fast in der Mitte
    // zwischen zwei Bildern. Eine Bildunterschrift gehört zum Bild darüber –
    // auch wenn das untere ein paar Bildpunkte näher liegt.
    const scene = seite(1400, 1100);
    foto(scene, rectQuad(300, 120, 640, 380, 0), 3);
    foto(scene, rectQuad(300, 620, 640, 380, 0), 9);
    drawHandwriting(scene, 330, 534, 480, 44, 4);

    const quads = detectPhotoQuads(scene);
    expect(quads).toHaveLength(2);
    const found = findWriting(scene, quads);

    expect(found).toHaveLength(1);
    expect(found[0].photo).toBe(0);
  });

  it('findet nichts, wo nichts geschrieben steht', () => {
    // Der Tisch ringsum, der Rand der Seite und der Schatten darunter liefern
    // ebenfalls dünne, langgezogene Formen. Keine davon ist eine Zeile.
    const scene = seite(1400, 1000);
    foto(scene, rectQuad(300, 200, 700, 520, 0), 4);

    expect(findWriting(scene, detectPhotoQuads(scene))).toHaveLength(0);
  });

  it('lässt eine Zeile aus, die zu keinem Foto gehört', () => {
    // Weit weg vom einzigen Foto: eine Überschrift der Seite, keine
    // Bildunterschrift.
    const scene = seite(1600, 1200);
    foto(scene, rectQuad(150, 150, 500, 380, 0), 6);
    drawHandwriting(scene, 1000, 1000, 420, 46, 9);

    const found = findWriting(scene, detectPhotoQuads(scene));

    expect(found).toHaveLength(0);
  });

  it('hält beim Ausschneiden die Fotos heraus', () => {
    // Eine Zeile zwischen zwei Bildern: Der Rand des Ausschnitts darf nicht in
    // das Foto darunter hineinreichen, sonst steht ein Streifen fremden Motivs
    // in der Bildunterschrift.
    const scene = seite(1400, 1100);
    const oben = rectQuad(300, 120, 640, 380, 0);
    const unten = rectQuad(300, 620, 640, 380, 0);
    foto(scene, oben, 3);
    foto(scene, unten, 9);
    drawHandwriting(scene, 330, 534, 480, 44, 4);

    const quads = detectPhotoQuads(scene);
    const [writing] = findWriting(scene, quads);
    const grosszuegig = cropWriting(scene, writing, 60, quads);

    // 60 Bildpunkte Luft gäbe es nicht – oben und unten steht je ein Foto.
    expect(writing.box.minY - 60).toBeLessThan(oben[2].y);
    expect(grosszuegig.height).toBeLessThan(writing.box.maxY - writing.box.minY + 120);
  });

  it('schneidet den Ausschnitt mit etwas Luft heraus', () => {
    const scene = seite(1400, 1000);
    foto(scene, rectQuad(300, 150, 700, 520, 0), 3);
    drawHandwriting(scene, 320, 730, 560, 54, 7);

    const [writing] = findWriting(scene, detectPhotoQuads(scene));
    const crop = cropWriting(scene, writing, 10);

    expect(crop.width).toBe(Math.min(scene.width - 1, writing.box.maxX + 10) - Math.max(0, writing.box.minX - 10) + 1);
    expect(crop.height).toBeGreaterThan(writing.box.maxY - writing.box.minY);
    // Ein Ausschnitt ohne Tinte wäre nutzlos: Es muss dunkle Punkte geben.
    let dark = 0;
    for (let p = 0; p < crop.data.length; p += 4) if (crop.data[p] < 100) dark++;
    expect(dark).toBeGreaterThan(50);
  });
});
