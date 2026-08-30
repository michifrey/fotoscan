import { describe, expect, it } from 'vitest';
import { glareFrom, refinePhoto, withoutGlare } from '../src/lib/imaging/closeup';
import { NO_ENHANCE } from '../src/lib/imaging/enhance';
import { warpPerspective } from '../src/lib/imaging/warp';
import { createRgba } from '../src/lib/imaging/types';
import type { Quad, RgbaImage } from '../src/lib/imaging/types';
import { drawTextureInQuad, kartonTexture, rectQuad, variedPhoto } from './synth';

/**
 * Mehrere Nahaufnahmen statt einer – und warum die Korrektur grob sein darf.
 *
 * Eine Spiegelung fügt Licht **hinzu**, sie zieht nie welches ab. Über mehrere
 * Aufnahmen desselben Abzugs aus leicht verschiedenen Winkeln ist der dunkelste
 * Wert je Bildpunkt deshalb der ungespiegelte. Das ist derselbe Gedanke, auf
 * dem PhotoScan steht.
 *
 * Der zweite Teil ist der wichtigere: Ein Glanzfleck ist grossflächig und
 * weich, die Korrektur muss also **nicht** in voller Auflösung entstehen.
 * Gemessen, gegen die glanzfreie Wahrheit:
 *
 * | | Fehler |
 * | --- | --- |
 * | rohe Aufnahme | 19,1 |
 * | wie bisher, gegen die Seitenaufnahme entspiegelt | 6,3 |
 * | Minimum in voller Grösse | 4,4 |
 * | Korrektur aus 270 Punkten hochgerechnet | 4,6 |
 *
 * Die volle Auflösung bringt nichts mehr, kostet aber je Aufnahme dreissig
 * Megabyte – und daran ist die dritte Stufe am echten Album schon einmal
 * gestorben.
 */

const PAPIER: [number, number, number] = [232, 226, 210];
const ABZUG: Quad = rectQuad(60, 45, 1080, 810, 0);

function copy(img: RgbaImage): RgbaImage {
  return { data: new Uint8ClampedArray(img.data), width: img.width, height: img.height };
}

/** Ein Glanzfleck, wie ihn eine Lampe hinterlässt: hell und farblos. */
function glanz(img: RgbaImage, cx: number, cy: number, radius: number): RgbaImage {
  const out = copy(img);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d > radius) continue;
      const strength = Math.min(1, (1 - d / radius) * 2.2);
      const i = (y * img.width + x) * 4;
      for (let c = 0; c < 3; c++) out.data[i + c] += (255 - out.data[i + c]) * strength;
    }
  }
  return out;
}

/**
 * Eine Nahaufnahme: der Abzug formatfüllend, ringsum Papier – und ein wenig
 * schräg, denn aus der Hand liegen zwei Aufnahmen nie deckungsgleich. Genau
 * darauf kommt es an: Bei *perfekter* Überlagerung wäre die feine Karte exakt
 * und der Vergleich geschönt.
 */
function aufnahme(photo: RgbaImage, spot: [number, number] | null, tilt = 0): { image: RgbaImage; quad: Quad } {
  const img = createRgba(1200, 900);
  drawTextureInQuad(img, kartonTexture(60, 45, PAPIER, 3), rectQuad(0, 0, 1200, 900, 0));
  const quad: Quad = [
    { x: 60 + tilt, y: 45 - tilt },
    { x: 1140 + tilt, y: 45 + tilt },
    { x: 1140 - tilt, y: 855 + tilt },
    { x: 60 - tilt, y: 855 - tilt },
  ];
  drawTextureInQuad(img, photo, quad);
  return { image: spot ? glanz(img, spot[0], spot[1], 230) : img, quad };
}

/** Mittlerer Abstand je Farbkanal, ohne einen Randstreifen. */
function abstand(a: RgbaImage, b: RgbaImage, inset = 30): number {
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

describe('Glanz aus mehreren Nahaufnahmen', () => {
  const photo = variedPhoto(600, 450, 31);
  const sauber = aufnahme(photo, null).image;
  const wahrheit = warpPerspective(sauber, ABZUG, 1080, 810);

  /** Drei Aufnahmen, der Glanzfleck jedes Mal woanders. */
  const spots: [number, number][] = [
    [400, 350],
    [800, 420],
    [600, 640],
  ];
  const shots = spots.map((spot, i) => aufnahme(photo, spot, (i - 1) * 7));

  it('nimmt der ersten Aufnahme ihren Glanz', () => {
    const map = glareFrom(shots[0], shots.slice(1));
    expect(map).not.toBeNull();

    const roh = warpPerspective(shots[0].image, shots[0].quad, 1080, 810);
    const besser = withoutGlare(roh, map!);

    // Die Zusage: deutlich näher an der glanzfreien Wahrheit als die rohe
    // Aufnahme. Ohne eine Zahl wäre das Verfahren nicht mehr als eine Absicht.
    expect(abstand(besser, wahrheit)).toBeLessThan(abstand(roh, wahrheit) * 0.35);
  });

  it('rechnet die Korrektur grob und verliert dabei nichts', () => {
    // Der Kern der Sache. Eine Karte über die volle Kantenlänge kostet je
    // Aufnahme dreissig Megabyte; eine über 270 Punkte kostet nichts. Wenn die
    // grobe merklich schlechter wäre, wäre das ein schlechter Handel – ist sie
    // aber nicht, denn ein Glanzfleck hat keine feinen Einzelheiten.
    const roh = warpPerspective(shots[0].image, shots[0].quad, 1080, 810);
    const grob = abstand(withoutGlare(roh, glareFrom(shots[0], shots.slice(1), 270)!), wahrheit);
    const fein = abstand(withoutGlare(roh, glareFrom(shots[0], shots.slice(1), 1080)!), wahrheit);

    // eslint-disable-next-line no-console
    console.log(`grob ${grob.toFixed(1)}  fein ${fein.toFixed(1)}  roh ${abstand(roh, wahrheit).toFixed(1)}`);
    // Die grobe Karte darf nicht mehr als einen Grauwert hinter der feinen
    // zurückbleiben – dafür kostet sie ein Sechzehntel des Speichers.
    expect(grob).toBeLessThan(fein + 1);
  });

  it('lässt eine Aufnahme ohne Glanz in Ruhe', () => {
    // Die Gegenprobe. Wo nichts zu viel ist, darf nichts abgezogen werden –
    // sonst würde jede saubere Aufnahme grundlos dunkler.
    const ohne = { image: sauber, quad: ABZUG };
    const map = glareFrom(ohne, [ohne, ohne]);
    const roh = warpPerspective(sauber, ABZUG, 1080, 810);
    expect(abstand(withoutGlare(roh, map!), roh)).toBeLessThan(0.5);
  });

  it('gibt nichts zurück, wenn es nichts zu vergleichen gibt', () => {
    // Eine einzige Aufnahme trägt keine Aussage über ihren eigenen Glanz. Dann
    // bleibt es beim bisherigen Weg über die Seitenaufnahme.
    expect(glareFrom(shots[0], [])).toBeNull();
  });
});

describe('der ganze Weg bis zum fertigen Foto', () => {
  it('nimmt den gemessenen Glanz heraus, bevor die Seitenaufnahme drankommt', () => {
    // Die Verkabelung: Was `glareFrom` misst, muss auch im fertigen Foto
    // ankommen. Ohne diesen Test könnte die Karte klaglos ins Leere gehen.
    const photo = variedPhoto(600, 450, 31);
    const wahrheit = warpPerspective(aufnahme(photo, null).image, ABZUG, 1080, 810);
    const spots: [number, number][] = [
      [400, 350],
      [800, 420],
      [600, 640],
    ];
    const shots = spots.map((spot, i) => aufnahme(photo, spot, (i - 1) * 7));
    // Die Vorlage aus der Seitenaufnahme: dasselbe Foto, aber klein und weich.
    const reference = warpPerspective(aufnahme(photo, null).image, ABZUG, 360, 270);

    const ohne = refinePhoto(reference, { image: shots[0].image, quad: shots[0].quad }, NO_ENHANCE, 0);
    const mit = refinePhoto(
      reference,
      { image: shots[0].image, quad: shots[0].quad, glare: glareFrom(shots[0], shots.slice(1))! },
      NO_ENHANCE,
      0,
    );

    const messe = (img: RgbaImage) => abstand(img, warpPerspective(wahrheit, rectQuad(0, 0, 1080, 810, 0), img.width, img.height));
    // eslint-disable-next-line no-console
    console.log(`ohne Karte ${messe(ohne).toFixed(1)}  mit Karte ${messe(mit).toFixed(1)}`);
    expect(messe(mit)).toBeLessThan(messe(ohne));
  });
});
