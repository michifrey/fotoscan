import { describe, expect, it } from 'vitest';
import { mergeFrames } from '../src/lib/imaging/destack';
import { NOTEWORTHY, findGlare, hasGlare } from '../src/lib/imaging/glare';
import { DARK, brightEnough, exposureOf, tooDark } from '../src/lib/imaging/exposure';
import { createRgba } from '../src/lib/imaging/types';
import type { RgbaImage } from '../src/lib/imaging/types';
import { fill, photoTexture } from './synth';

function copy(img: RgbaImage): RgbaImage {
  return { data: new Uint8ClampedArray(img.data), width: img.width, height: img.height };
}

/** Ein Glanzfleck, wie ihn eine Lampe auf einem Abzug hinterlässt: hell und farblos. */
function addGlare(img: RgbaImage, cx: number, cy: number, radius: number): RgbaImage {
  const out = copy(img);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d > radius) continue;
      const strength = Math.min(1, (1 - d / radius) * 2.2);
      const i = (y * img.width + x) * 4;
      for (let c = 0; c < 3; c++) out.data[i + c] = out.data[i + c] + (255 - out.data[i + c]) * strength;
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

/** Wie hell es an einer Stelle im Mittel ist. */
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

describe('stehengebliebener Glanz', () => {
  it('bessert eine Spiegelung nach, die in der Mehrheit der Aufnahmen liegt', () => {
    // Der Fall aus der Praxis: Das Telefon wird zu wenig bewegt, der Glanz
    // sitzt in drei von fünf Aufnahmen an derselben Stelle. Der Median wählt
    // dann die Spiegelung – sie ist die Mehrheit.
    const clean = photoTexture(300, 220, 12);
    const frames = [
      addGlare(clean, 150, 110, 45),
      addGlare(clean, 152, 112, 45),
      addGlare(clean, 148, 108, 45),
      addGlare(clean, 60, 60, 45),
      addGlare(clean, 240, 170, 45),
    ];

    const merged = mergeFrames(frames);

    // In der Mitte darf nicht mehr die Lampe stehen, sondern der Abzug.
    expect(patchLuma(merged, 150, 110, 12)).toBeLessThan(patchLuma(frames[0], 150, 110, 12) - 40);
    expect(Math.abs(patchLuma(merged, 150, 110, 12) - patchLuma(clean, 150, 110, 12))).toBeLessThan(22);
  });

  it('rührt ein Foto ohne Spiegelung nicht an', () => {
    // Die Gegenprobe: Wo alle Aufnahmen dasselbe zeigen, darf das Nachbessern
    // nichts tun – sonst zieht es das Rauschen der dunkelsten Aufnahme über
    // jede Kante des Fotos.
    const clean = photoTexture(300, 220, 15);
    const merged = mergeFrames([copy(clean), copy(clean), copy(clean), copy(clean)]);
    expect(meanAbsDiff(merged, clean)).toBeLessThan(0.6);
  });

  it('bessert am Bildrand nichts nach', () => {
    // Dort zeigen die Aufnahmen unvermeidlich Verschiedenes: Jede ist mit
    // ihrem eigenen Viereck entzerrt und greift ein Stück weit auf das helle
    // Albumpapier hinaus. Das sieht aus wie Glanz, ist aber der Rand.
    const clean = photoTexture(300, 220, 19);
    const frames = [0, 1, 2, 3].map((n) => {
      const out = copy(clean);
      const band = 4 + n;
      for (let y = 0; y < 220; y++) {
        for (let x = 0; x < 300; x++) {
          if (x >= band && y >= band && x < 300 - band && y < 220 - band) continue;
          const i = (y * 300 + x) * 4;
          out.data[i] = 236;
          out.data[i + 1] = 232;
          out.data[i + 2] = 224;
        }
      }
      return out;
    });

    const merged = mergeFrames(frames);
    // Innen muss das Foto unangetastet bleiben.
    expect(meanAbsDiff(merged, clean, 12)).toBeLessThan(0.6);
  });

  it('lässt eine helle Fläche stehen, über die sich die Aufnahmen einig sind', () => {
    // Ein weisses Hemd ist hell und farblos – aber es steht in jeder Aufnahme
    // gleich hell da. Nur die Uneinigkeit verrät die Lampe.
    const clean = photoTexture(240, 180, 17);
    const hemd = copy(clean);
    for (let y = 60; y < 120; y++) {
      for (let x = 80; x < 160; x++) {
        const i = (y * 240 + x) * 4;
        hemd.data[i] = 250;
        hemd.data[i + 1] = 249;
        hemd.data[i + 2] = 247;
      }
    }

    const merged = mergeFrames([copy(hemd), copy(hemd), copy(hemd), copy(hemd)]);
    expect(patchLuma(merged, 120, 90, 15)).toBeGreaterThan(240);
  });
});

describe('Spiegelungen erkennen', () => {
  it('meldet einen Glanzfleck auf dem fertigen Foto', () => {
    const foto = addGlare(photoTexture(400, 300, 21), 200, 150, 40);
    const found = findGlare(foto);

    expect(found.share).toBeGreaterThan(NOTEWORTHY);
    expect(hasGlare(foto)).toBe(true);
  });

  it('meldet nichts auf einem Foto ohne Glanz', () => {
    expect(hasGlare(photoTexture(400, 300, 23))).toBe(false);
  });

  it('hält ein durchgehend helles Foto nicht für eine Spiegelung', () => {
    // Eine Schneelandschaft ist hell und farblos, aber nirgends ein Fleck.
    const schnee = createRgba(400, 300);
    fill(schnee, 249, 250, 251);
    expect(hasGlare(schnee)).toBe(false);
  });

  it('hält einen einzelnen hellen Sprenkel nicht für eine Spiegelung', () => {
    const foto = photoTexture(400, 300, 27);
    for (let n = 0; n < 40; n++) {
      const i = ((n * 2137) % (400 * 300)) * 4;
      foto.data[i] = 252;
      foto.data[i + 1] = 252;
      foto.data[i + 2] = 251;
    }
    expect(hasGlare(foto)).toBe(false);
  });
});

describe('Helligkeit messen', () => {
  it('erkennt eine zu dunkle Aufnahme', () => {
    const dunkel = createRgba(200, 150);
    fill(dunkel, 38, 34, 30);
    const exposure = exposureOf(dunkel);

    expect(exposure.level).toBeLessThan(DARK);
    expect(tooDark(exposure)).toBe(true);
    expect(brightEnough(exposure)).toBe(false);
  });

  it('lässt sich von einem hellen Fenster neben dem Motiv nicht täuschen', () => {
    // Der Mittelwert wäre hier hell, der Median nicht – und das Album liegt
    // im Dunkeln.
    const szene = createRgba(200, 150);
    fill(szene, 30, 28, 26);
    for (let y = 0; y < 150; y++) {
      for (let x = 150; x < 200; x++) {
        const i = (y * 200 + x) * 4;
        szene.data[i] = 255;
        szene.data[i + 1] = 255;
        szene.data[i + 2] = 255;
      }
    }
    expect(tooDark(exposureOf(szene))).toBe(true);
  });

  it('misst nur dort, wo das Motiv liegt', () => {
    // Helle Tischplatte, dunkle Albumseite in der Mitte: Gemessen wird die Seite.
    const szene = createRgba(200, 200);
    fill(szene, 230, 228, 224);
    for (let y = 60; y < 140; y++) {
      for (let x = 60; x < 140; x++) {
        const i = (y * 200 + x) * 4;
        szene.data[i] = 34;
        szene.data[i + 1] = 32;
        szene.data[i + 2] = 30;
      }
    }

    expect(tooDark(exposureOf(szene))).toBe(false);
    expect(tooDark(exposureOf(szene, { cx: 0.5, cy: 0.5, hx: 0.18, hy: 0.18 }))).toBe(true);
  });

  it('hält eine gut ausgeleuchtete Seite für hell genug', () => {
    const hell = createRgba(200, 150);
    fill(hell, 190, 184, 172);
    const exposure = exposureOf(hell);
    expect(tooDark(exposure)).toBe(false);
    expect(brightEnough(exposure)).toBe(true);
  });
});
