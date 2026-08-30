import { describe, expect, it } from 'vitest';
import { composeFromTiles, composePhoto } from '../src/lib/imaging/mosaic';
import type { LazyTile, Tile } from '../src/lib/imaging/mosaic';
import { compose } from '../src/lib/imaging/fit';
import { computeHomography, outputSize, warpPerspective } from '../src/lib/imaging/warp';
import { createRgba } from '../src/lib/imaging/types';
import type { Quad, RgbaImage } from '../src/lib/imaging/types';
import { drawTextureInQuad, fill, kartonTexture, rectQuad, variedPhoto } from './synth';

/** Die Albumseite auf dem Tisch, in hoher Auflösung – die Wahrheit. */
function sheet(): RgbaImage {
  const img = createRgba(1600, 1200);
  fill(img, 70, 50, 32);
  drawTextureInQuad(img, kartonTexture(90, 68, [230, 220, 202], 3), rectQuad(50, 40, 1500, 1120, 0));
  drawTextureInQuad(img, variedPhoto(560, 420, 21), PHOTO);
  drawTextureInQuad(img, variedPhoto(400, 300, 34), rectQuad(1000, 150, 460, 340, 0));
  return img;
}

/** Das Foto, um das es geht – in Koordinaten der Vorlage. */
const PHOTO: Quad = rectQuad(180, 200, 700, 520, 0);

const OVERVIEW: Quad = [
  { x: 30, y: 24 },
  { x: 1572, y: 46 },
  { x: 1560, y: 1170 },
  { x: 44, y: 1152 },
];
const OVERVIEW_SIZE: [number, number] = [800, 600];

function rect(width: number, height: number): Quad {
  return [
    { x: 0, y: 0 },
    { x: width - 1, y: 0 },
    { x: width - 1, y: height - 1 },
    { x: 0, y: height - 1 },
  ];
}

/** Von der Vorlage in die Übersicht. */
function sheetToOverview(): number[] {
  return computeHomography(OVERVIEW, rect(...OVERVIEW_SIZE));
}

/**
 * Eine Kachel: der Ausschnitt `quad` der Vorlage, aufgenommen in `size`.
 * Ihre Lage – Kachelpunkte auf Übersichtspunkte – ist damit bekannt und muss
 * hier nicht geschätzt werden: Geprüft wird das Zusammensetzen, nicht das
 * Wiederfinden.
 */
function tileOf(source: RgbaImage, quad: Quad, size: [number, number], tweak?: (i: RgbaImage) => RgbaImage): Tile {
  const raw = warpPerspective(source, quad, size[0], size[1]);
  const image = tweak ? tweak(raw) : raw;
  const toSheet = computeHomography(rect(size[0], size[1]), quad);
  return { image, pose: compose(sheetToOverview(), toSheet) };
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

/** Wie viel Zeichnung ein Bild trägt – die Schärfe, als Zahl. */
function detailEnergy(img: RgbaImage): number {
  let sum = 0;
  for (let y = 1; y < img.height - 1; y++) {
    for (let x = 1; x < img.width - 1; x++) {
      const i = (y * img.width + x) * 4;
      const right = ((y * img.width + x + 1) * 4);
      const down = (((y + 1) * img.width + x) * 4);
      sum += Math.abs(img.data[i] - img.data[right]) + Math.abs(img.data[i] - img.data[down]);
    }
  }
  return sum / (img.width * img.height);
}

function withGlare(img: RgbaImage, cx: number, cy: number, radius: number): RgbaImage {
  const out = { data: new Uint8ClampedArray(img.data), width: img.width, height: img.height };
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d > radius) continue;
      const strength = Math.min(1, (1 - d / radius) * 2.4);
      const i = (y * img.width + x) * 4;
      for (let c = 0; c < 3; c++) out.data[i + c] = out.data[i + c] + (255 - out.data[i + c]) * strength;
    }
  }
  return out;
}

function patchLuma(img: RgbaImage, cx: number, cy: number, radius: number): number {
  let sum = 0;
  let n = 0;
  for (let y = cy - radius; y <= cy + radius; y++) {
    for (let x = cx - radius; x <= cx + radius; x++) {
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
      const i = (y * img.width + x) * 4;
      sum += img.data[i] * 0.299 + img.data[i + 1] * 0.587 + img.data[i + 2] * 0.114;
      n++;
    }
  }
  return sum / Math.max(1, n);
}

describe('Fotos aus Kacheln zusammensetzen', () => {
  const vorlage = sheet();
  const overview = warpPerspective(vorlage, OVERVIEW, ...OVERVIEW_SIZE);
  const photoInOverview = applyTo(sheetToOverview(), PHOTO);

  /** Vier Kacheln, die das Foto überlappend abdecken. */
  const quarters: Quad[] = [
    rectQuad(150, 170, 430, 320, 0),
    rectQuad(490, 170, 430, 320, 0),
    rectQuad(150, 430, 430, 320, 0),
    rectQuad(490, 430, 430, 320, 0),
  ];

  it('bringt mehr Zeichnung als der Zuschnitt aus der Seitenaufnahme', () => {
    // Das ist die Zahl, an der es hängt. Die Kacheln zeigen dieselbe Fläche
    // mit einem Vielfachen der Bildpunkte; kommt davon nichts an, lohnt das
    // ganze Abfahren nicht.
    const tiles = quarters.map((quad) => tileOf(vorlage, quad, [640, 480]));
    const composed = composePhoto(overview, photoInOverview, tiles);
    expect(composed).not.toBeNull();

    const truth = warpPerspective(vorlage, PHOTO, composed!.width, composed!.height);
    const baseline = warpPerspective(overview, photoInOverview, composed!.width, composed!.height);

    const composedError = meanAbsDiff(composed!, truth, 12);
    const baselineError = meanAbsDiff(baseline, truth, 12);

    expect(composedError).toBeLessThan(baselineError * 0.75);
    expect(detailEnergy(composed!)).toBeGreaterThan(detailEnergy(baseline) * 1.3);
  });

  it('nutzt die Auflösung der Kacheln auch in der Grösse', () => {
    // Aus der Seitenaufnahme allein bekäme dieses Foto nur ein paar hundert
    // Bildpunkte. Wer näher herangeht, soll sie auch behalten dürfen.
    const tiles = quarters.map((quad) => tileOf(vorlage, quad, [640, 480]));
    const composed = composePhoto(overview, photoInOverview, tiles)!;
    const fromOverview = outputSize(photoInOverview);

    expect(composed.width).toBeGreaterThan(fromOverview.width * 1.8);
  });

  it('nimmt an überlappenden Stellen die dunklere Kachel', () => {
    // Der Glanz wandert mit der Kameraposition, die Zeichnung nicht. Genau
    // dafür verlangt die Führung über glänzenden Stellen einen zweiten
    // Durchgang – hier wird er eingelöst.
    const glared = tileOf(vorlage, quarters[0], [640, 480], (i) => withGlare(i, 420, 300, 150));
    const clean = tileOf(vorlage, quarters[0], [640, 480]);

    const withBoth = composePhoto(overview, photoInOverview, [glared, clean])!;
    const onlyGlared = composePhoto(overview, photoInOverview, [glared])!;

    const truth = warpPerspective(vorlage, PHOTO, withBoth.width, withBoth.height);
    // Die Stelle, an der der Glanz sitzt – umgerechnet auf das fertige Foto.
    const spot = { x: Math.round(withBoth.width * 0.42), y: Math.round(withBoth.height * 0.44) };

    expect(patchLuma(onlyGlared, spot.x, spot.y, 20)).toBeGreaterThan(patchLuma(truth, spot.x, spot.y, 20) + 30);
    expect(Math.abs(patchLuma(withBoth, spot.x, spot.y, 20) - patchLuma(truth, spot.x, spot.y, 20))).toBeLessThan(24);
  });

  it('lässt eine helle Fläche stehen, über die sich die Kacheln einig sind', () => {
    // Die Gegenprobe zur vorigen: Zwei Kacheln, die dasselbe zeigen, dürfen
    // einander nicht abdunkeln – sonst frisst das Verfahren die Zeichnung.
    const tiles = [tileOf(vorlage, quarters[0], [640, 480]), tileOf(vorlage, quarters[0], [640, 480])];
    const twice = composePhoto(overview, photoInOverview, tiles)!;
    const once = composePhoto(overview, photoInOverview, [tiles[0]])!;

    expect(meanAbsDiff(twice, once, 12)).toBeLessThan(1.5);
  });

  it('füllt aus der Seitenaufnahme, wo keine Kachel liegt', () => {
    // Nur die linke Hälfte abgefahren: Rechts muss die Übersicht stehen
    // bleiben – weich, aber richtig. Ein Loch wäre schlimmer.
    const tiles = [tileOf(vorlage, quarters[0], [640, 480]), tileOf(vorlage, quarters[2], [640, 480])];
    const composed = composePhoto(overview, photoInOverview, tiles)!;
    const truth = warpPerspective(vorlage, PHOTO, composed.width, composed.height);

    // Rechts aussen darf nichts schwarz sein.
    expect(patchLuma(composed, Math.round(composed.width * 0.92), Math.round(composed.height / 2), 20)).toBeGreaterThan(40);
    expect(meanAbsDiff(composed, truth, 12)).toBeLessThan(30);
  });

  it('packt nur die Kacheln aus, die dieses Foto berühren', async () => {
    // Ein Dutzend Aufnahmen in voller Grösse gleichzeitig im Speicher sprengt
    // ein Telefon. Wer weit weg liegt, wird gar nicht erst geladen – und das
    // Ergebnis muss dasselbe sein.
    const nah = quarters.map((quad) => tileOf(vorlage, quad, [640, 480]));
    // Eine Kachel vom anderen Foto der Seite, die hier nichts zu suchen hat.
    const fern = tileOf(vorlage, rectQuad(1020, 170, 400, 300, 0), [640, 480]);

    const loaded: number[] = [];
    const lazy: LazyTile[] = [...nah, fern].map((tile, index) => ({
      width: tile.image.width,
      height: tile.image.height,
      pose: tile.pose,
      load: async () => {
        loaded.push(index);
        return tile.image;
      },
    }));

    const composed = await composeFromTiles(overview, photoInOverview, lazy);
    expect(composed).not.toBeNull();
    expect(loaded).toEqual([0, 1, 2, 3]);
    expect(meanAbsDiff(composed!, composePhoto(overview, photoInOverview, nah)!, 0)).toBeLessThan(0.01);
  });

  it('gibt nichts zurück, wenn keine Kachel etwas beiträgt', () => {
    expect(composePhoto(overview, photoInOverview, [])).toBeNull();
  });
});

/** Ein Viereck durch eine Abbildung schicken. */
function applyTo(h: number[], quad: Quad): Quad {
  return quad.map((p) => {
    const d = h[6] * p.x + h[7] * p.y + h[8];
    return { x: (h[0] * p.x + h[1] * p.y + h[2]) / d, y: (h[3] * p.x + h[4] * p.y + h[5]) / d };
  }) as Quad;
}
