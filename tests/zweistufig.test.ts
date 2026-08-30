import { describe, expect, it } from 'vitest';
import { detectAt, detectPage, detectPhotoQuads, detectPhotosOnPage } from '../src/lib/imaging/detect';
import { polygonArea, quadCentroid } from '../src/lib/imaging/geometry';
import { applyHomography, computeHomography, outputSize, warpPerspective } from '../src/lib/imaging/warp';
import { createRgba } from '../src/lib/imaging/types';
import type { Pt, Quad, RgbaImage } from '../src/lib/imaging/types';
import { drawTextureInQuad, fill, kartonTexture, rectQuad, variedPhoto } from './synth';

/**
 * Die Erfassung in zwei Stufen: erst die Seite, dann die Fotos darauf.
 *
 * Gemessen wird der eine Unterschied, um den es geht – ob die Fotos auf der
 * *entzerrten* Seite besser gefunden werden als in einem Zug auf der rohen
 * Aufnahme. Ohne diese Zahl lohnt der Umbau nicht.
 */

/** Wo die Fotos auf der Seite liegen, in Koordinaten der Seitenvorlage. */
const PLACES: Quad[] = [
  rectQuad(120, 110, 430, 320, 0),
  rectQuad(620, 130, 400, 300, 0),
  rectQuad(150, 520, 380, 290, 0),
  rectQuad(600, 540, 440, 280, 0),
];

const SHEET: [number, number] = [1200, 950];

/** Die Albumseite für sich: helles Papier mit Abzügen darauf. */
function sheet(places: Quad[] = PLACES): RgbaImage {
  const img = createRgba(...SHEET);
  drawTextureInQuad(img, kartonTexture(90, 68, [234, 228, 214], 3), rectQuad(0, 0, SHEET[0], SHEET[1], 0));
  places.forEach((quad, i) => drawTextureInQuad(img, variedPhoto(330, 250, 11 + i * 13), quad));
  return img;
}

/**
 * Die Aufnahme, wie sie entsteht: die Seite liegt schräg auf einem dunklen
 * Tisch, mit Luft ringsum.
 */
function shot(page: Quad, width = 1400, height = 1050, places: Quad[] = PLACES): RgbaImage {
  const img = createRgba(width, height);
  fill(img, 62, 48, 38);
  drawTextureInQuad(img, sheet(places), page);
  return img;
}

/** Die Seite, wie sie in einer Aufnahme liegt – leicht gedreht und schräg. */
const PAGE: Quad = [
  { x: 150, y: 120 },
  { x: 1268, y: 186 },
  { x: 1232, y: 934 },
  { x: 112, y: 862 },
];

/** Liegt der Punkt im Viereck? Für konvexe Vierecke. */
function contains(quad: Quad, point: Pt): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    const value = (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
    if (value === 0) continue;
    const current = value > 0 ? 1 : -1;
    if (sign === 0) sign = current;
    else if (sign !== current) return false;
  }
  return true;
}

/** Kleinster Mittenabstand eines Fundes zu diesem Viereck. */
function nearest(found: Quad[], truth: Quad): number {
  if (found.length === 0) return Infinity;
  const t = quadCentroid(truth);
  return Math.min(...found.map((q) => Math.hypot(quadCentroid(q).x - t.x, quadCentroid(q).y - t.y)));
}

/**
 * Wie gut eine Menge Funde zu den Fotos passt: Treffer innerhalb einer halben
 * Fotobreite, und der mittlere Abstand dieser Treffer.
 */
function score(found: Quad[], truth: Quad[]): { hits: number; extra: number; error: number } {
  let hits = 0;
  let sum = 0;
  for (const quad of truth) {
    const reach = Math.sqrt(polygonArea(quad)) * 0.5;
    const distance = nearest(found, quad);
    if (distance < reach) {
      hits++;
      sum += distance;
    }
  }
  return { hits, extra: Math.max(0, found.length - hits), error: hits === 0 ? Infinity : sum / hits };
}

/** Ein achsparalleles Rechteck dieser Grösse. */
function rectOf(width: number, height: number): Quad {
  return [
    { x: 0, y: 0 },
    { x: width - 1, y: 0 },
    { x: width - 1, y: height - 1 },
    { x: 0, y: height - 1 },
  ];
}

/**
 * Wo die Fotos auf der entzerrten Seite wirklich liegen.
 *
 * Über die **gefundene** Seite gerechnet, nicht über die wahre: Die Erkennung
 * weitet ihr Viereck bewusst ein wenig, damit sie nichts abschneidet, und ein
 * Streifen Tisch am Rand verschiebt alles darin. Wer das nicht mitrechnet,
 * misst seinen eigenen Sicherheitsabstand statt der Erkennung.
 */
function truthOn(page: Quad, width: number, height: number): Quad[] {
  const toFlat = computeHomography(page, rectOf(width, height));
  return PLACES.map((quad) => applyHomography(toFlat, mapTo(quad, PAGE)) as Quad);
}

describe('Erfassung in zwei Stufen', () => {
  const scene = shot(PAGE);

  it('findet die Albumseite als Ganzes, ohne sie anzuschneiden', () => {
    // Gemessen wird nicht der Abstand der Ecken, sondern das, worauf es
    // ankommt: Die gefundene Seite muss die wirkliche **enthalten**. Was hier
    // fehlt, fehlt später einem Foto am Seitenrand – und niemand bekommt es
    // zurück. Ein Streifen Tisch zu viel stört dagegen keinen.
    const page = detectPage(scene);
    expect(page).not.toBeNull();
    for (const corner of PAGE) expect(contains(page!, corner)).toBe(true);
    expect(polygonArea(page!)).toBeLessThan(polygonArea(PAGE) * 1.15);
  });

  it('findet auf der entzerrten Seite alle Fotos und nichts sonst', () => {
    // Auf der entzerrten Seite füllt das Papier das Bild, die Abzüge stehen
    // achsparallel darauf, und Tisch und Umgebung sind gar nicht mehr im Bild.
    // Auf einer sauberen Vorlage findet die einstufige Erkennung dasselbe –
    // ihre Schwäche liegt nicht hier, sondern darin, dass sie selbst
    // entscheidet, ob die Unterteilung echt ist. Der nächste Test zeigt das.
    const page = detectPage(scene)!;
    const size = outputSize(page, 1400);
    const flat = warpPerspective(scene, page, size.width, size.height);

    const zweistufig = score(detectPhotosOnPage(flat), truthOn(page, size.width, size.height));
    const einstufig = score(detectPhotoQuads(scene), PLACES.map((q) => mapTo(q, PAGE)));

    // eslint-disable-next-line no-console
    console.log('zweistufig', zweistufig, 'einstufig', einstufig);

    expect(zweistufig.hits).toBe(PLACES.length);
    expect(zweistufig.extra).toBe(0);
    expect(zweistufig.hits).toBeGreaterThanOrEqual(einstufig.hits);
    // Der Umweg über die Entzerrung kostet nichts an Genauigkeit: Was das
    // zweite Abtasten verwischt, gewinnt die achsparallele Lage zurück.
    expect(zweistufig.error).toBeLessThan(size.width * 0.005);
  });

  it('lässt sich von einer Seite ohne erkennbare Unterteilung nicht beirren', () => {
    // Der Fall, an dem die einstufige Erkennung scheitert: Ein einzelnes
    // kleines Foto macht keinen Viertel der Seitenfläche aus, und die Prüfung
    // „ist die Unterteilung echt?" verwirft es deshalb – die ganze Seite kommt
    // als ein Foto heraus. Zweistufig gefragt gibt es diese Prüfung nicht
    // mehr: Die Seite ist die Seite, das Foto ist das Foto.
    const einzeln = rectQuad(430, 360, 330, 240, 0);
    const scene = shot(PAGE, 1400, 1050, [einzeln]);

    const page = detectPage(scene);
    expect(page).not.toBeNull();
    const size = outputSize(page!, 1400);
    const flat = warpPerspective(scene, page!, size.width, size.height);

    const found = detectPhotosOnPage(flat);
    expect(found).toHaveLength(1);
    // Und das gefundene Foto ist deutlich kleiner als die Seite.
    expect(polygonArea(found[0])).toBeLessThan(size.width * size.height * 0.3);
  });

  it('lässt keine Ecke aus dem Bild ragen', () => {
    // Das Viereck wird bewusst geweitet, damit nichts angeschnitten wird.
    // Liegt die Seite nah am Bildrand, landet eine Ecke dabei ausserhalb – und
    // in der Oberfläche ist sie dann nicht mehr zu greifen. Genau das ist am
    // echten Album passiert.
    const knapp: Quad = [
      { x: 12, y: 10 },
      { x: 1388, y: 16 },
      { x: 1384, y: 1040 },
      { x: 8, y: 1034 },
    ];
    const scene = shot(knapp);
    const page = detectPage(scene);

    expect(page).not.toBeNull();
    for (const corner of page!) {
      expect(corner.x).toBeGreaterThanOrEqual(0);
      expect(corner.y).toBeGreaterThanOrEqual(0);
      expect(corner.x).toBeLessThanOrEqual(scene.width - 1);
      expect(corner.y).toBeLessThanOrEqual(scene.height - 1);
    }
  });

  it('gibt keine Seite zurück, wenn sie bis an den Bildrand reicht', () => {
    // Dann ist das ganze Bild die Seite, und es gibt nichts zu entzerren –
    // der Aufrufer nimmt das Bild, wie es ist.
    const full = createRgba(900, 700);
    drawTextureInQuad(full, sheet(), rectQuad(0, 0, 900, 700, 0));
    expect(detectPage(full)).toBeNull();
  });

  it('nimmt ein angetipptes Foto auf, egal wo darin getippt wird', () => {
    // Was die Erkennung übersieht, holt der Nutzer mit einem Tipp. Wo genau er
    // hintippt, darf keine Rolle spielen – sonst wird das Antippen zum
    // Geduldsspiel.
    const flat = warpPerspective(sheet(), rectQuad(0, 0, ...SHEET, 0), 1000, 792);
    const truth = PLACES.map((quad) => quad.map((p) => ({ x: (p.x / SHEET[0]) * 1000, y: (p.y / SHEET[1]) * 792 })) as Quad);

    for (const quad of truth) {
      const centre = quadCentroid(quad);
      const spots: Pt[] = [
        centre,
        { x: centre.x - Math.sqrt(polygonArea(quad)) * 0.25, y: centre.y },
        { x: centre.x, y: centre.y + Math.sqrt(polygonArea(quad)) * 0.2 },
      ];
      for (const spot of spots) {
        const found = detectAt(flat, spot);
        expect(found).not.toBeNull();
        expect(Math.hypot(quadCentroid(found!).x - centre.x, quadCentroid(found!).y - centre.y)).toBeLessThan(30);
      }
    }
  });

  it('gibt auf blankem Papier nichts zurück', () => {
    // Die Gegenprobe. Dort ist nichts, und etwas zu erfinden wäre schlimmer,
    // als nichts zu liefern.
    const flat = warpPerspective(sheet(), rectQuad(0, 0, ...SHEET, 0), 1000, 792);
    // Zwischen den vier Abzügen bleibt in der Mitte Papier stehen.
    expect(detectAt(flat, { x: 480, y: 395 })).toBeNull();
    expect(detectAt(flat, { x: 20, y: 20 })).toBeNull();
  });
});

/** Ein Viereck der Seitenvorlage in die Aufnahme umrechnen. */
function mapTo(quad: Quad, page: Quad): Quad {
  return quad.map((p) => {
    const u = p.x / SHEET[0];
    const v = p.y / SHEET[1];
    const top = { x: page[0].x + (page[1].x - page[0].x) * u, y: page[0].y + (page[1].y - page[0].y) * u };
    const bottom = { x: page[3].x + (page[2].x - page[3].x) * u, y: page[3].y + (page[2].y - page[3].y) * u };
    return { x: top.x + (bottom.x - top.x) * v, y: top.y + (bottom.y - top.y) * v };
  }) as Quad;
}
