import { describe, expect, it } from 'vitest';
import { estimateMotion } from '../src/lib/imaging/motion';
import { advance, reanchor, startPose, viewport } from '../src/lib/imaging/pose';
import type { Pose } from '../src/lib/imaging/pose';
import { computeHomography, warpPerspective } from '../src/lib/imaging/warp';
import { createRgba } from '../src/lib/imaging/types';
import type { Quad, RgbaImage } from '../src/lib/imaging/types';
import { drawTextureInQuad, fill, kartonTexture, rectQuad, variedPhoto } from './synth';

/** Die Albumseite, wie sie auf dem Tisch liegt – in hoher Auflösung. */
function sheet(seed = 1): RgbaImage {
  const img = createRgba(1200, 900);
  fill(img, 70, 50, 32);
  drawTextureInQuad(img, kartonTexture(90, 68, [230, 220, 202], seed), rectQuad(40, 30, 1120, 840, 0));
  const photos: [number, number, number, number, number][] = [
    [100, 88, 414, 314, 21 + seed],
    [600, 80, 466, 334, 34 + seed],
    [106, 480, 466, 320, 47 + seed],
    [640, 494, 414, 306, 58 + seed],
  ];
  for (const [x, y, w, h, s] of photos) {
    drawTextureInQuad(img, variedPhoto(300, 220, s), rectQuad(x, y, w, h, 0));
  }
  return img;
}

const OVERVIEW: Quad = [
  { x: 26, y: 20 },
  { x: 1172, y: 42 },
  { x: 1162, y: 880 },
  { x: 38, y: 864 },
];
const FRAME: [number, number] = [360, 270];

/** Was die Kamera sieht, wenn sie über dem Ausschnitt `quad` steht. */
function look(source: RgbaImage, quad: Quad, size: [number, number] = FRAME): RgbaImage {
  return warpPerspective(source, quad, size[0], size[1]);
}

function rect(width: number, height: number): Quad {
  return [
    { x: 0, y: 0 },
    { x: width - 1, y: 0 },
    { x: width - 1, y: height - 1 },
    { x: 0, y: height - 1 },
  ];
}

/**
 * Wo das Vorschaubild wirklich auf der Übersicht liegt.
 *
 * Beide zeigen dieselbe Vorlage: Die Bildecke geht über ihren Ausschnitt in
 * die Vorlage und von dort in die Übersicht. Das ist die Wahrheit, an der sich
 * die mitgeführte Lage messen lassen muss.
 */
function truth(quad: Quad, size: [number, number], overviewSize: [number, number]): Quad {
  const toSheet = computeHomography(rect(size[0], size[1]), quad);
  const toOverview = computeHomography(OVERVIEW, rect(overviewSize[0], overviewSize[1]));
  return applyBoth(toSheet, toOverview, rect(size[0], size[1]));
}

function applyBoth(first: number[], second: number[], points: Quad): Quad {
  const step = (h: number[], p: { x: number; y: number }) => {
    const d = h[6] * p.x + h[7] * p.y + h[8];
    return { x: (h[0] * p.x + h[1] * p.y + h[2]) / d, y: (h[3] * p.x + h[4] * p.y + h[5]) / d };
  };
  return points.map((p) => step(second, step(first, p))) as Quad;
}

function cornerError(a: Quad, b: Quad): number {
  return Math.max(...a.map((p, i) => Math.hypot(p.x - b[i].x, p.y - b[i].y)));
}

function darken(img: RgbaImage, factor: number): RgbaImage {
  const out = { data: new Uint8ClampedArray(img.data), width: img.width, height: img.height };
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] *= factor;
    out.data[i + 1] *= factor;
    out.data[i + 2] *= factor;
  }
  return out;
}

function withGlare(img: RgbaImage, cx: number, cy: number, radius: number): RgbaImage {
  const out = { data: new Uint8ClampedArray(img.data), width: img.width, height: img.height };
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d > radius) continue;
      const strength = Math.min(1, (1 - d / radius) * 2);
      const i = (y * img.width + x) * 4;
      for (let c = 0; c < 3; c++) out.data[i + c] = out.data[i + c] + (255 - out.data[i + c]) * strength;
    }
  }
  return out;
}

/**
 * Der Kameraweg: von der Übersicht aus langsam heranfahren und dabei über die
 * Seite wandern. Verschiebung, Massstab und Drehung ändern sich Bild für Bild
 * nur wenig – so, wie eine Hand sich bewegt.
 */
function path(steps: number): Quad[] {
  const quads: Quad[] = [];
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    // Von der ganzen Seite auf gut die Hälfte heranfahren – so, wie eine Hand
    // sich bewegt: bei zehn Bildern je Sekunde ändert sich je Bild wenig.
    const width = 1130 - 480 * t;
    const height = width * 0.75;
    const cx = 600 + Math.sin(t * Math.PI * 1.1) * 180;
    const cy = 450 + Math.cos(t * Math.PI * 0.9) * 110 - 110;
    const turn = Math.sin(t * Math.PI * 1.6) * 5;
    quads.push(rectQuad(cx - width / 2, cy - height / 2, width, height, turn));
  }
  return quads;
}

/** Die Bilder des Weges, mit wechselndem Licht und wanderndem Glanz. */
function frames(source: RgbaImage, quads: Quad[]): RgbaImage[] {
  return quads.map((quad, i) => {
    const raw = look(source, quad);
    const t = i / Math.max(1, quads.length - 1);
    const glared = withGlare(raw, 60 + t * 240, 220 - t * 160, 55);
    return darken(glared, 1 - 0.22 * Math.sin(t * Math.PI));
  });
}

interface Run {
  errors: number[];
  anchors: number;
  lost: number;
}

/** Fährt den Weg ab und misst Bild für Bild den Fehler gegen die Wahrheit. */
function follow(
  overview: RgbaImage,
  overviewSize: [number, number],
  quads: Quad[],
  images: RgbaImage[],
  { anchorEvery }: { anchorEvery: number },
): Run {
  const first = startPose(overview, images[0]);
  expect(first).not.toBeNull();

  let pose: Pose = first!;
  const errors = [cornerError(viewport(pose, ...FRAME), truth(quads[0], FRAME, overviewSize))];
  let anchors = 0;
  let lost = 0;

  for (let i = 1; i < images.length; i++) {
    const motion = estimateMotion(images[i - 1], images[i]);
    if (!motion) {
      lost++;
      continue;
    }
    pose = advance(pose, motion);

    if (anchorEvery > 0 && pose.since >= anchorEvery) {
      const anchored = reanchor(overview, images[i], pose);
      if (anchored) {
        pose = anchored;
        anchors++;
      }
    }
    errors.push(cornerError(viewport(pose, ...FRAME), truth(quads[i], FRAME, overviewSize)));
  }
  return { errors, anchors, lost };
}

describe('Lage fortlaufend mitführen', () => {
  const vorlage = sheet();
  const overviewSize: [number, number] = [600, 450];
  const overview = look(vorlage, OVERVIEW, overviewSize);
  const quads = path(18);
  const images = frames(vorlage, quads);

  // Die beiden Läufe kosten Zeit; sie werden einmal gerechnet und geteilt.
  const anchored = follow(overview, overviewSize, quads, images, { anchorEvery: 2 });
  const drifting = follow(overview, overviewSize, quads, images, { anchorEvery: 0 });

  it('kennt die Anfangslage, weil das erste Bild die Übersicht ist', () => {
    const pose = startPose(overview, images[0]);
    expect(pose).not.toBeNull();
    expect(cornerError(viewport(pose!, ...FRAME), truth(quads[0], FRAME, overviewSize))).toBeLessThan(12);
  });

  it('misst die Bewegung zwischen zwei aufeinanderfolgenden Bildern', () => {
    const motion = estimateMotion(images[5], images[6]);
    expect(motion).not.toBeNull();
    expect(motion!.matched).toBeGreaterThanOrEqual(8);
  });

  it('bleibt über den ganzen Weg auf der richtigen Stelle', () => {
    // Kein Bild geht verloren, und die Lage bleibt über achtzehn Bilder hinweg
    // dort, wo die Kamera wirklich steht. Gemessen in Punkten der 600 px
    // breiten Übersicht – zwanzig davon sind gut drei Prozent der Seitenbreite.
    expect(anchored.lost).toBe(0);
    expect(anchored.anchors).toBeGreaterThan(2);
    expect(Math.max(...anchored.errors)).toBeLessThan(20);
  });

  it('läuft ohne Nachverankern messbar weg', () => {
    // Die Gegenprobe. Ohne sie wäre nicht gezeigt, dass das Nachverankern
    // überhaupt etwas tut: Eine Kette von Schätzungen sammelt Fehler ein, und
    // jeder bleibt für den Rest des Weges darin.
    expect(drifting.anchors).toBe(0);
    expect(Math.max(...drifting.errors)).toBeGreaterThan(40);
    expect(Math.max(...drifting.errors)).toBeGreaterThan(Math.max(...anchored.errors) * 3);
  });

  it('bemerkt einen Abriss, statt stillschweigend falsch weiterzulaufen', () => {
    // Das Telefon wird kurz weggenommen: Das nächste Bild zeigt etwas ganz
    // anderes. Eine Bewegung dorthin gibt es nicht, und eine erfundene wäre
    // schlimmer als keine – sie multipliziert sich in die Lage hinein.
    const woanders = look(sheet(200), quads[10]);
    expect(estimateMotion(images[9], woanders)).toBeNull();
  });

  it('fängt eine weggelaufene Lage wieder ein', () => {
    // Je länger nicht verankert wurde, desto weiter sucht der erste Anlauf –
    // sonst enthielte das Fenster die richtige Stelle gar nicht mehr.
    const start = startPose(overview, images[0])!;
    const wrong: Pose = { matrix: [...start.matrix], since: 9 };
    wrong.matrix[2] += 30;
    wrong.matrix[5] -= 22;

    const before = cornerError(viewport(wrong, ...FRAME), truth(quads[0], FRAME, overviewSize));
    const fixed = reanchor(overview, images[0], wrong);

    expect(fixed).not.toBeNull();
    expect(fixed!.since).toBe(0);
    expect(cornerError(viewport(fixed!, ...FRAME), truth(quads[0], FRAME, overviewSize))).toBeLessThan(before / 3);
  });
});
