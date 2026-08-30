import { boxBlur, downscaleRgba, toGray } from './gray';
import { estimateBackground, foregroundMask, isBackgroundColor } from './background';
import type { Background, Limits } from './background';
import {
  close,
  componentBoundary,
  connectedComponents,
  dilate,
  erode,
  fillFromBorder,
  fillHoles,
  gradientMagnitude,
  thresholdTopFraction,
} from './mask';
import type { Component, Mask } from './mask';
import {
  approximateQuad,
  convexHull,
  dist,
  insetQuad,
  isPlausibleQuad,
  polygonArea,
  quadCentroid,
  scaleQuad,
} from './geometry';
import { applyHomography, computeHomography, outputSize, shrinkQuad } from './warp';
import { warpPerspective } from './warp';
import type { GrayImage, Pt, Quad, RgbaImage } from './types';

export interface DetectOptions {
  /** Längste Kante, auf die vor der Analyse heruntergerechnet wird. */
  analysisSize?: number;
  /** Kleinste akzeptierte Fläche, als Anteil der analysierten Fläche. */
  minAreaFraction?: number;
  /** Wie tief in gefundene Flächen hineingesucht wird (Albumseite -> Fotos). */
  maxDepth?: number;
}

const DEFAULTS: Required<DetectOptions> = {
  analysisSize: 720,
  minAreaFraction: 0.015,
  maxDepth: 2,
};

/** Anteil, um den beim Hineinsuchen vom Rand der Fläche weggeschnitten wird. */
const CHILD_INSET = 0.012;

/**
 * Ab so viel gleichmässiger Fläche gilt ein Bereich als Untergrund, auf dem
 * sich suchen lohnt. Darunter ist es ein Foto – und in ein Foto hineinzusuchen
 * liefert nur seine Bildinhalte, nicht seine Ränder.
 */
const BACKGROUND_MIN = 0.3;

/**
 * So wenig gleichmässige Fläche muss ein Bereich mindestens haben, damit sich
 * das Hineinsuchen lohnt. Bewusst niedrig: Eine dicht belegte Albumseite lässt
 * kaum Papier stehen, und eine Schwelle von der Hälfte gab genau solche Seiten
 * als ein einziges grosses Foto aus. Ob die Unterteilung echt ist, entscheidet
 * deshalb nicht diese Zahl, sondern das Ergebnis – siehe `plausibleChildren`.
 */
const PAGE_MIN = 0.12;

/**
 * Grösste Fläche, die noch als Loch innerhalb eines Fotos durchgeht. Alles
 * Grössere ist die Albumseite selbst, eingefasst vom Tisch.
 */
const HOLE_MAX = 0.15;

/** So viel des Bildes muss die Albumseite mindestens ausmachen. */
const PAGE_AREA_MIN = 0.12;

/**
 * So viel gleichmässige Fläche muss im Inneren einer Seite stehen – ihr
 * Papier. Ohne diese Prüfung käme auf einer formatfüllend aufgenommenen Seite
 * das grösste **Foto** als „Seite" heraus: Es berührt den Bildrand nicht und
 * ist die grösste eingeschlossene Fläche. Ein Foto ist innen aber nirgends
 * gleichmässig, eine Albumseite überall dort, wo Papier zu sehen ist.
 */
const PAGE_SURFACE_MIN = 0.18;

/**
 * Ab dieser Grösse gilt eine zweite eingeschlossene Fläche als Geschwister
 * statt als Beiwerk – gemessen an der grössten.
 */
const SIBLING_SHARE = 0.4;

/** Und so weit wird ihr Viereck nach aussen geweitet, als Anteil der kurzen Kante. */
const PAGE_MARGIN = 0.02;

/**
 * So viel sichtbares Papier braucht es, damit der Papierfilter greifen darf.
 * Auf einer dicht belegten Seite ist der häufigste Farbton der der Fotos
 * selbst; dort würde er sie alle verwerfen.
 */
const PAPER_FILTER_MIN = 0.25;

/** Grenzen für ein angetipptes Foto, als Anteil der Seitenfläche. */
const TAP_AREA_MIN = 0.004;
const TAP_AREA_MAX = 0.9;

/** Kantenlänge der Stichprobe, mit der eine Fläche auf Papierfarbe geprüft wird. */
const PAPER_SAMPLE = 32;

/**
 * Ab diesem Anteil Papierfarbe gilt eine Fläche als Papier, nicht als Foto.
 * Auf echten Albumseiten liegen die Fotos bei unter zwei Zehnteln – der Abstand
 * ist also gross, auch wenn ein Foto viel Helles enthält.
 */
const PAPER_SHARE = 0.5;

/**
 * Nicht gesetzte Felder auf die Vorgabe zurückführen. Ein einfaches Spreizen
 * würde ein ausdrücklich übergebenes `undefined` durchreichen und damit die
 * Vorgabe überschreiben.
 */
function resolve(options: DetectOptions): Required<DetectOptions> {
  return {
    analysisSize: options.analysisSize ?? DEFAULTS.analysisSize,
    minAreaFraction: options.minAreaFraction ?? DEFAULTS.minAreaFraction,
    maxDepth: options.maxDepth ?? DEFAULTS.maxDepth,
  };
}

/**
 * Findet die Vierecke aller Fotos in einer Aufnahme – ein einzelnes Bild auf
 * dem Tisch genauso wie mehrere Fotos auf einer aufgeschlagenen Albumseite.
 * Rückgabe in Koordinaten des Originalbildes.
 */
export function detectPhotoQuads(img: RgbaImage, options: DetectOptions = {}): Quad[] {
  const opts = resolve(options);
  const { image: small, scale } = downscaleRgba(img, opts.analysisSize);
  const found = detectIn(small, 0, opts, []).map((q) => scaleQuad(q, scale));

  // Mindestgrösse, gemessen am ganzen Bild. Innerhalb einer Teilfläche wirkt
  // ein Krümel gross; gemessen an der Aufnahme ist er keiner. Ohne diese
  // Schranke rutschen beim Hineinsuchen einzelne Bildinhalte als eigene
  // „Fotos" durch.
  const smallest = img.width * img.height * opts.minAreaFraction;
  return dedupe(found.filter((q) => polygonArea(q) >= smallest));
}

/**
 * Findet die Albumseite selbst – nicht die Fotos darauf.
 *
 * Das ist die erste der beiden Stufen. Sie herauszulösen ist der ganze Punkt:
 * `detectPhotoQuads` entscheidet heute selbst, ob eine gefundene Unterteilung
 * echt ist, und wenn diese Entscheidung falsch ausfällt, kommt die ganze Seite
 * als ein einziges „Foto" heraus. Getrennt gefragt hat jede Stufe eine
 * Aufgabe, die sie zuverlässig beantworten kann – und dazwischen darf der
 * Nutzer widersprechen.
 *
 * Gibt `null` zurück, wenn keine Seite auszumachen ist: Entweder liegt sie
 * bis an den Bildrand – dann ist das ganze Bild die Seite und es gibt nichts
 * zu entzerren –, oder es ist gar keine da.
 */
export function detectPage(img: RgbaImage, options: DetectOptions = {}): Quad | null {
  const opts = resolve(options);
  const { image: small, scale } = downscaleRgba(img, opts.analysisSize);
  if (small.width < 48 || small.height < 48) return null;

  const gray = toGray(small);
  const background = estimateBackground(small, gray);
  const candidates: Quad[] = [];

  if (background.fraction >= BACKGROUND_MIN) {
    const { raw } = photoMask(small, background);
    // Welche Farbe die grösste gleichmässige Fläche hat, hängt davon ab, wie
    // viel Tisch mit im Bild liegt – und beide Fälle kommen vor. Deshalb wird
    // in beide Richtungen gesucht:
    //
    // - Der **Tisch** ist der Untergrund: Die Seite hebt sich davon ab und
    //   steht mitsamt ihren Fotos als eine Fläche darin.
    // - Die **Seite** ist der Untergrund, weil sie das Bild füllt: Dann ist
    //   sie das Loch im Vordergrund, eingefasst vom Tisch.
    //
    // Ohne den zweiten Fall findet sich auf einer formatfüllend
    // aufgenommenen Seite gar keine – und genau so nimmt man sie auf.
    // Ohne Öffnen: Es entfernt Beschriftung und Fusseln, rundet dabei aber die
    // Ecken – und eine gerundete Ecke schneidet die konvexe Hülle ab. Für eine
    // Fläche von der Grösse einer Albumseite braucht es das nicht.
    const both = [raw, invertMask(raw)];
    for (const mask of both) {
      const quad = largestEnclosed(mask, opts);
      if (quad && hasSurface(small, quad)) candidates.push(quad);
    }
  }
  if (candidates.length === 0) candidates.push(...edgeQuads(gray, opts));

  const best = candidates.slice().sort((a, b) => polygonArea(b) - polygonArea(a))[0];
  if (!best) return null;

  // Eine Seite füllt einen wesentlichen Teil des Bildes. Ein Krümel ist keine.
  if (polygonArea(best) < small.width * small.height * PAGE_AREA_MIN) return null;

  // Lieber ein Streifen Tisch zu viel als eine Ecke der Seite zu wenig: Die
  // Näherung auf vier Ecken schneidet an einer Rundung schon einmal etwas ab,
  // und was hier fehlt, fehlt einem Foto am Seitenrand. Ein wenig Umgebung im
  // entzerrten Bild stört dagegen niemanden.
  //
  // Ins Bild geholt wird sie trotzdem: Jenseits des Randes steht nichts, was
  // sich entzerren liesse – und in der Oberfläche wäre eine Ecke ausserhalb
  // nicht zu greifen. Wer die Seite formatfüllend aufnimmt, bekäme sonst ein
  // Viereck, an dem er nichts mehr richten kann.
  const margin = Math.min(small.width, small.height) * PAGE_MARGIN;
  return clampToImage(scaleQuad(insetQuad(best, -margin), scale), img.width, img.height);
}

/** Jede Ecke ins Bild holen. */
function clampToImage(quad: Quad, width: number, height: number): Quad {
  return quad.map((p) => ({
    x: Math.max(0, Math.min(width - 1, p.x)),
    y: Math.max(0, Math.min(height - 1, p.y)),
  })) as Quad;
}

/**
 * Die grösste Fläche, die den Bildrand nicht berührt – als Viereck.
 *
 * Anders als bei den Fotos wird hier **nicht** eingerückt und **nicht** auf die
 * Füllung des Vierecks geprüft: Eine Seite darf innen Löcher haben (das sind
 * ihre Fotos), und ein eingerückter Zuschnitt schnitte am Rand liegende Fotos
 * an.
 *
 * Gibt nichts zurück, wenn daneben eine zweite Fläche vergleichbarer Grösse
 * liegt. Dann sind es Geschwister – mehrere Fotos auf einer Seite, die das
 * Bild füllt – und keine Seite mit ihrem Inhalt. Eine Seite hat ihre Fotos
 * *in* sich, nicht neben sich.
 */
function largestEnclosed(mask: Mask, opts: Required<DetectOptions>): Quad | null {
  const { labels, components } = connectedComponents(mask);
  const least = mask.width * mask.height * Math.min(PAGE_AREA_MIN, opts.minAreaFraction);
  const quads: Quad[] = [];

  for (const comp of components) {
    if (comp.area < least || touchesBorder(comp, mask)) continue;
    const quad = approximateQuad(convexHull(componentBoundary(labels, mask.width, mask.height, comp)));
    if (quad && isPlausibleQuad(quad)) quads.push(quad);
  }
  if (quads.length === 0) return null;

  const best = quads.reduce((a, b) => (polygonArea(b) > polygonArea(a) ? b : a));
  const area = polygonArea(best);
  const sibling = quads.some(
    (quad) => quad !== best && polygonArea(quad) > area * SIBLING_SHARE && !contains(best, quadCentroid(quad)),
  );
  return sibling ? null : best;
}

/**
 * Liegt der Punkt im Viereck? Über das Vorzeichen der Kreuzprodukte – für ein
 * konvexes Viereck, und die hier sind konvex.
 */
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

/**
 * Steht im Inneren dieser Fläche eine gleichmässige Fläche – Papier?
 *
 * Der Unterschied zwischen einer Albumseite und einem einzelnen Abzug. Beide
 * sind grosse eingeschlossene Flächen; nur die Seite ist innen streckenweise
 * einfarbig.
 */
function hasSurface(img: RgbaImage, quad: Quad): boolean {
  const size = outputSize(shrinkQuad(quad, 0.06), 160);
  if (size.width < 32 || size.height < 32) return false;
  const patch = warpPerspective(img, shrinkQuad(quad, 0.06), size.width, size.height);
  return estimateBackground(patch, toGray(patch)).fraction >= PAGE_SURFACE_MIN;
}

function invertMask(mask: Mask): Mask {
  const data = new Uint8Array(mask.data.length);
  for (let i = 0; i < data.length; i++) data[i] = mask.data[i] ? 0 : 1;
  return { data, width: mask.width, height: mask.height };
}

/**
 * Findet die Fotos auf einer **bereits entzerrten** Albumseite.
 *
 * Zwei Unterschiede zum Hineinsuchen in `detectPhotoQuads`, und beide sind
 * Absicht:
 *
 * - **Keine Plausibilitätsprüfung der Unterteilung.** Was gefunden wird, wird
 *   gezeigt; über richtig und falsch entscheidet der Nutzer. Er kann Ecken
 *   ziehen, Falsches herausnehmen und Übersehenes antippen – die Maschine muss
 *   diese Entscheidung nicht mehr allein treffen.
 * - **Eine Ebene, kein Hineinsuchen.** Die Seite ist schon gefunden; noch
 *   tiefer zu suchen liefert nur Bildinhalte.
 *
 * Der Papierfilter bleibt: Eine helle Stelle *im* Motiv – eine Bettdecke, ein
 * blasser Himmel – hat oft genau die Farbe des Papiers. Er greift allerdings
 * nur, wenn überhaupt sichtbar Papier daliegt; auf einer dicht belegten Seite
 * ist der häufigste Farbton der der Fotos selbst, und dann würde er sie alle
 * verwerfen.
 */
export function detectPhotosOnPage(page: RgbaImage, options: DetectOptions = {}): Quad[] {
  const opts = resolve(options);
  const { image: small, scale } = downscaleRgba(page, opts.analysisSize);
  if (small.width < 48 || small.height < 48) return [];

  const gray = toGray(small);
  const background = estimateBackground(small, gray);

  // Tiefe 1: Ein Foto darf bis an den Rand der Seite reichen. Auf der obersten
  // Ebene einer Aufnahme wäre eine randberührende Fläche die Umgebung – hier
  // ist der Rand die Seite selbst.
  const found =
    background.fraction >= BACKGROUND_MIN ? backgroundQuads(small, background, 1, opts) : edgeQuads(gray, opts);

  const filtered =
    background.fraction >= PAPER_FILTER_MIN ? found.filter((q) => !isPaper(small, q, [background])) : found;

  const smallest = small.width * small.height * opts.minAreaFraction;
  return dedupe(filtered.filter((q) => polygonArea(q) >= smallest).map((q) => scaleQuad(q, scale)));
}

/**
 * Das Foto an der angetippten Stelle – für das, was die Erkennung übersehen
 * hat.
 *
 * Genommen wird die Fläche der Vordergrundmaske, die den Punkt enthält: derselbe
 * Weg wie bei `detectPhotosOnPage`, aber ohne die Grössen- und Formfilter, an
 * denen das Foto vorher ausgefallen ist. Ein Tipp auf blankes Papier gibt
 * `null`.
 *
 * **Was das nicht kann:** Einen Abzug, dessen Farbe innerhalb dessen liegt, was
 * noch als Papier durchgeht, findet auch das nicht – für die Maske *ist* er
 * Papier. Ein Anlauf über die Kanten wurde gebaut und wieder verworfen: Auf
 * gekörntem Karton ist die Papierstruktur kräftiger als der Rand eines blassen
 * Abzugs, das Fluten lief über die ganze Seite. Diesen Fall trägt die
 * Oberfläche, indem sie an der angetippten Stelle ein Viereck hinlegt, dessen
 * Ecken sich ziehen lassen – von Hand, aber verlässlich.
 */
export function detectAt(page: RgbaImage, point: Pt, options: DetectOptions = {}): Quad | null {
  const opts = resolve(options);
  const { image: small, scale } = downscaleRgba(page, opts.analysisSize);
  if (small.width < 48 || small.height < 48) return null;

  const spot = { x: point.x / scale, y: point.y / scale };
  const x = Math.round(spot.x);
  const y = Math.round(spot.y);
  if (x < 0 || y < 0 || x >= small.width || y >= small.height) return null;

  const gray = toGray(small);
  const background = estimateBackground(small, gray);
  const { raw } = photoMask(small, background);

  const found = quadAt(raw, x, y);
  if (!found) return null;

  const quad = insetQuad(found, 2);
  if (!isPlausibleQuad(quad)) return null;
  // Die ganze Seite ist kein Foto. Wer auf Papier tippt, dessen Bereich wächst
  // bis an die Ränder – das ist die Antwort „hier ist nichts".
  if (polygonArea(quad) > small.width * small.height * TAP_AREA_MAX) return null;
  if (polygonArea(quad) < small.width * small.height * TAP_AREA_MIN) return null;
  return scaleQuad(quad, scale);
}

/** Die zusammenhängende Fläche der Maske, die diesen Punkt enthält. */
function quadAt(mask: Mask, x: number, y: number): Quad | null {
  if (!mask.data[y * mask.width + x]) return null;
  const { labels, components } = connectedComponents(mask);
  const label = labels[y * mask.width + x];
  if (label <= 0) return null;
  const comp = components.find((c) => c.label === label);
  if (!comp) return null;
  return approximateQuad(convexHull(componentBoundary(labels, mask.width, mask.height, comp)));
}

/**
 * Sucht Fotos in einem Bildausschnitt. Zwei Wege, in dieser Reihenfolge:
 *
 * 1. Über den Untergrund. Eine Albumseite ist eine gleichmässige Fläche; was
 *    darauf liegt, hebt sich farblich ab. Das ist das verlässlichere Signal,
 *    denn ein Foto und eine Beschriftung bringen selbst reichlich Kanten mit,
 *    an denen sich eine Kantensuche verheddert.
 * 2. Über Kanten. Greift, wenn es keinen erkennbaren Untergrund gibt – etwa
 *    bei einem Foto, das fast das ganze Bild füllt.
 */
function detectIn(
  img: RgbaImage,
  depth: number,
  opts: Required<DetectOptions>,
  known: Limits[],
  /** Bereits berechnet, wenn der Aufrufer die Fläche schon geprüft hat. */
  ready?: { gray: GrayImage; background: Background },
): Quad[] {
  if (img.width < 48 || img.height < 48) return [];
  const gray = ready ? ready.gray : toGray(img);
  const background = ready ? ready.background : estimateBackground(img, gray);

  const carries = background.fraction >= BACKGROUND_MIN;
  let regions = carries ? backgroundQuads(img, background, depth, opts) : [];
  if (regions.length === 0) regions = edgeQuads(gray, opts);

  // Trägt diese Ebene einen erkennbaren Untergrund, merken wir ihn uns: Weiter
  // innen verrät er, welche Fläche in Wahrheit Papier ist.
  const surfaces = carries ? [...known, background] : known;
  const results: Quad[] = [];
  for (const quad of regions) {
    const children = depth < opts.maxDepth ? childQuads(img, quad, polygonArea(quad), depth, opts, surfaces) : [];
    if (children.length > 0) results.push(...children);
    else results.push(quad);
  }
  return results;
}

/**
 * Die Maske dessen, was auf dem Untergrund liegt.
 *
 * Öffnen entfernt, was dünner ist als ein Foto: Beschriftung, Fusseln,
 * Papierstruktur. Der Radius ist an einer echten Albumseite eingestellt –
 * kleiner, und eine danebenstehende Bildunterschrift bleibt am Foto kleben und
 * zieht den Zuschnitt auf. Die ungeöffnete Maske wird mit zurückgegeben: Aus
 * ihr stammt später die Form, denn das Öffnen rundet die Ecken ab.
 */
function photoMask(img: RgbaImage, background: Background): { raw: Mask; mask: Mask; radius: number } {
  const radius = Math.max(3, Math.round(Math.min(img.width, img.height) * 0.019));
  const raw = fillHoles(foregroundMask(img, background), HOLE_MAX);
  return { raw, mask: open(raw, radius), radius };
}

/** Weg 1: alles, was sich farblich vom Untergrund abhebt. */
function backgroundQuads(
  img: RgbaImage,
  background: Background,
  depth: number,
  opts: Required<DetectOptions>,
): Quad[] {
  const { raw, mask, radius } = photoMask(img, background);

  // Auf der obersten Ebene ist alles, was den Bildrand berührt, die Umgebung –
  // Tischplatte, Nachbarseiten, die eigene Hand. Die Einrückung bleibt klein:
  // Der Farbübergang ist scharf, es fällt kein verbreiterter Saum an wie bei
  // der Kantensuche.
  return quadsFromMask(mask, opts, 2, depth === 0, true, raw, radius);
}

/** Geschlossener Kantenzug über die stärksten Gradienten. */
function edgeMask(gray: GrayImage): Mask {
  const smoothed = boxBlur(boxBlur(gray, 1), 1);
  const magnitude = gradientMagnitude(smoothed);
  const closeRadius = Math.max(1, Math.round(Math.max(gray.width, gray.height) / 320));
  return close(thresholdTopFraction(magnitude, gray.width, gray.height, 0.1), closeRadius);
}

/** Weg 2: Flächen, die von einem geschlossenen Kantenzug umgeben sind. */
function edgeQuads(gray: GrayImage, opts: Required<DetectOptions>): Quad[] {
  const closeRadius = Math.max(1, Math.round(Math.max(gray.width, gray.height) / 320));
  const solid = fillFromBorder(edgeMask(gray));
  // Weichzeichnen und Sobel verbreitern die Kante; ohne diese Korrektur läge
  // ein heller Saum der Albumseite mit im Zuschnitt.
  return quadsFromMask(solid, opts, closeRadius + 1, false, false, null, 0);
}

function open(mask: Mask, radius: number): Mask {
  return dilate(erode(mask, radius), radius);
}

/** Aus einer Maske die brauchbaren Vierecke gewinnen. */
function quadsFromMask(
  mask: Mask,
  opts: Required<DetectOptions>,
  inset: number,
  dropBorderTouching: boolean,
  mergeOverlapping: boolean,
  /** Ungeöffnete Maske, aus der die Geometrie stammt (siehe unten). */
  raw: Mask | null,
  reach: number,
): Quad[] {
  const { labels, components } = connectedComponents(mask);
  const totalArea = mask.width * mask.height;
  const minArea = totalArea * opts.minAreaFraction;

  const usable = components.filter(
    (comp) =>
      comp.area >= minArea &&
      comp.area <= totalArea * 0.995 &&
      !(dropBorderTouching && touchesBorder(comp, mask)),
  );

  const groups = mergeOverlapping ? groupOverlapping(usable) : usable.map((comp) => [comp]);
  const results: Quad[] = [];

  for (const group of groups) {
    // Das Öffnen entfernt die Beschriftung, rundet dabei aber die Ecken ab.
    // Für die Form zählt deshalb die ungeöffnete Maske – begrenzt auf die
    // Umgebung der gefundenen Fläche. So kehren die Ecken zurück, ohne dass
    // sich der Zuschnitt an einer danebenstehenden Zeile entlanghangelt.
    const boundary =
      raw === null
        ? group.flatMap((comp) => componentBoundary(labels, mask.width, mask.height, comp))
        : boundaryNear(raw, group, reach);
    const quad = approximateQuad(convexHull(boundary));
    if (!quad) continue;

    const area = polygonArea(quad);
    // Eine L- oder U-Form füllt ihr Viereck nicht aus – solche Flächen sind
    // keine Fotos, sondern Schatten, Beschriftung oder angeschnittene Seiten.
    const filled = group.reduce((sum, comp) => sum + comp.area, 0);
    if (filled < area * 0.62) continue;
    if (!isPlausibleQuad(quad)) continue;

    results.push(insetQuad(quad, inset));
  }
  return results;
}

/** Randpunkte der ungeöffneten Maske im Umkreis der gefundenen Flächen. */
function boundaryNear(raw: Mask, group: Component[], reach: number): Pt[] {
  const minX = Math.max(0, Math.min(...group.map((c) => c.minX)) - reach);
  const maxX = Math.min(raw.width - 1, Math.max(...group.map((c) => c.maxX)) + reach);
  const minY = Math.max(0, Math.min(...group.map((c) => c.minY)) - reach);
  const maxY = Math.min(raw.height - 1, Math.max(...group.map((c) => c.maxY)) + reach);

  const points: Pt[] = [];
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      if (!raw.data[y * raw.width + x]) continue;
      const edge =
        x === minX ||
        y === minY ||
        x === maxX ||
        y === maxY ||
        !raw.data[y * raw.width + x - 1] ||
        !raw.data[y * raw.width + x + 1] ||
        !raw.data[(y - 1) * raw.width + x] ||
        !raw.data[(y + 1) * raw.width + x];
      if (edge) points.push({ x, y });
    }
  }
  return points;
}

/**
 * Fasst Flächen zusammen, die sich überlappen.
 *
 * Ein Foto mit einer hellen, papierfarbenen Stelle – einer Bettdecke, einem
 * blassen Himmel – zerfällt bei der Farbtrennung in mehrere Bruchstücke. Die
 * liegen ineinander; zwei nebeneinanderliegende Fotos tun das nie.
 */
function groupOverlapping(components: Component[]): Component[][] {
  const groups: Component[][] = [];

  for (const comp of components) {
    // Nur kompakte Flächen dürfen verschmelzen. Ein dünner Rand oder Schatten
    // hat ein riesiges umschliessendes Rechteck und würde sonst sämtliche
    // Fotos darin einsammeln.
    const compact = fillRatio(comp) > 0.4;
    const hit = compact
      ? groups.find((group) => group.some((other) => fillRatio(other) > 0.4 && overlapRatio(comp, other) > 0.35))
      : undefined;
    if (hit) hit.push(comp);
    else groups.push([comp]);
  }
  return groups;
}

/** Wie gut eine Fläche ihr umschliessendes Rechteck ausfüllt. */
function fillRatio(comp: Component): number {
  return comp.area / (((comp.maxX - comp.minX + 1) * (comp.maxY - comp.minY + 1)) || 1);
}

/** Überlappung der umschliessenden Rechtecke, bezogen auf das kleinere. */
function overlapRatio(a: Component, b: Component): number {
  const w = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX) + 1;
  const h = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY) + 1;
  if (w <= 0 || h <= 0) return 0;
  const smaller = Math.min(
    (a.maxX - a.minX + 1) * (a.maxY - a.minY + 1),
    (b.maxX - b.minX + 1) * (b.maxY - b.minY + 1),
  );
  return (w * h) / smaller;
}

function touchesBorder(comp: Component, mask: Mask): boolean {
  return comp.minX === 0 || comp.minY === 0 || comp.maxX === mask.width - 1 || comp.maxY === mask.height - 1;
}

/**
 * Sucht innerhalb einer gefundenen Fläche nach kleineren Fotos. Damit wird aus
 * der erkannten Albumseite die Menge der Bilder darauf.
 *
 * Die Fläche wird dafür entzerrt statt nur ausgeschnitten: So verschwindet der
 * eigene Rand der Albumseite vollständig aus dem Suchbild, und auch Fotos, die
 * nahe am Seitenrand kleben, bleiben von der Umgebung getrennt.
 */
function childQuads(
  img: RgbaImage,
  quad: Quad,
  parentArea: number,
  depth: number,
  opts: Required<DetectOptions>,
  known: Limits[],
): Quad[] {
  const inner = shrinkQuad(quad, CHILD_INSET);
  const size = outputSize(inner, opts.analysisSize);
  if (size.width < 64 || size.height < 64) return [];

  const warped = warpPerspective(img, inner, size.width, size.height);

  // Bereiche ohne jede gleichmässige Fläche sind Bildinhalt, keine Seite.
  const gray = toGray(warped);
  const background = estimateBackground(warped, gray);
  if (background.fraction < PAGE_MIN) return [];

  // Geprüft wird nur gegen die Untergründe der *umgebenden* Ebenen. Der
  // Untergrund dieser Fläche selbst zählt nicht: Ein Foto darf durchaus die
  // Farbe haben, die auf dieser Ebene am häufigsten ist – auf einer dicht
  // belegten Seite ist das der Farbton der Fotos selbst.
  const found = detectIn(warped, depth + 1, opts, [...known, background], { gray, background }).filter(
    (q) => !isPaper(warped, q, known),
  );
  if (found.length === 0) return [];

  const rect: Quad = [
    { x: 0, y: 0 },
    { x: size.width - 1, y: 0 },
    { x: size.width - 1, y: size.height - 1 },
    { x: 0, y: size.height - 1 },
  ];
  const back = computeHomography(rect, inner);
  const mapped = found.map((q) => applyHomography(back, q) as Quad);

  return plausibleChildren(mapped, parentArea);
}

/**
 * Ist diese Fläche in Wahrheit Untergrund?
 *
 * Der schwierigste Fall auf einer Albumseite ist eine helle Stelle *im* Foto –
 * eine Bettdecke, ein bewölkter Himmel –, die zufällig die Farbe des Papiers
 * hat. Sie hebt sich vom übrigen Bildinhalt genauso ab wie ein Foto vom
 * Papier, und der Zuschnitt landet dann mitten im Motiv. Die Farbe verrät sie:
 * Wer die Farbe des Albumpapiers hat, ist Papier und kein Foto.
 *
 * Geprüft wird gegen alle Untergründe der umgebenden Ebenen – Tischplatte,
 * Albumseite, Passepartout –, gemessen im Inneren der Fläche, damit ein heller
 * Rand nicht ins Gewicht fällt.
 */
function isPaper(img: RgbaImage, quad: Quad, known: Limits[]): boolean {
  const patch = warpPerspective(img, shrinkQuad(quad, 0.15), PAPER_SAMPLE, PAPER_SAMPLE);
  return known.some((limits) => {
    let hits = 0;
    for (let p = 0; p < patch.data.length; p += 4) {
      if (isBackgroundColor(limits, patch.data[p], patch.data[p + 1], patch.data[p + 2])) hits++;
    }
    return hits / (PAPER_SAMPLE * PAPER_SAMPLE) > PAPER_SHARE;
  });
}

/**
 * Sind die gefundenen Teilflächen eine echte Unterteilung?
 *
 * Das ist die eigentliche Entscheidung „Albumseite oder Foto?". Sie am Anteil
 * des Papiers festzumachen trägt nicht: Eine volle Seite lässt kaum Papier
 * stehen, ein Foto mit blassem Himmel dagegen reichlich. Am Ergebnis lässt es
 * sich zuverlässiger ablesen – mehrere getrennte, jeweils deutlich kleinere
 * Flächen sind eine Seite; alles andere bleibt ein Foto.
 */
function plausibleChildren(children: Quad[], parentArea: number): Quad[] {
  const kept = children.filter((q) => polygonArea(q) < parentArea * 0.86);
  if (kept.length === 0) return [];

  // Ein einzelnes Kind muss deutlich kleiner sein als sein Elternteil, sonst
  // ist es dieselbe Fläche noch einmal.
  if (kept.length === 1 && polygonArea(kept[0]) > parentArea * 0.7) return [];

  // Zusammen müssen sie einen wesentlichen Teil der Fläche ausmachen.
  const sum = kept.reduce((acc, q) => acc + polygonArea(q), 0);
  if (sum < parentArea * 0.25) return [];

  // Und sie dürfen einander nicht überlappen – Fotos liegen nebeneinander,
  // Bildinhalte ineinander.
  for (let i = 0; i < kept.length; i++) {
    for (let j = i + 1; j < kept.length; j++) {
      if (overlaps(kept[i], kept[j])) return [];
    }
  }
  return kept;
}

/** Grobe Überlappungsprüfung über die umschliessenden Rechtecke. */
function overlaps(a: Quad, b: Quad): boolean {
  const box = (q: Quad) => ({
    minX: Math.min(...q.map((p) => p.x)),
    maxX: Math.max(...q.map((p) => p.x)),
    minY: Math.min(...q.map((p) => p.y)),
    maxY: Math.max(...q.map((p) => p.y)),
  });
  const x = box(a);
  const y = box(b);
  const w = Math.min(x.maxX, y.maxX) - Math.max(x.minX, y.minX);
  const h = Math.min(x.maxY, y.maxY) - Math.max(x.minY, y.minY);
  if (w <= 0 || h <= 0) return false;
  const smaller = Math.min((x.maxX - x.minX) * (x.maxY - x.minY), (y.maxX - y.minX) * (y.maxY - y.minY));
  return (w * h) / Math.max(1, smaller) > 0.25;
}

/** Entfernt Mehrfachfunde derselben Fläche (z. B. Rahmen und Foto darin). */
export function dedupe(quads: Quad[]): Quad[] {
  const out: Quad[] = [];
  const sorted = quads.slice().sort((a, b) => polygonArea(b) - polygonArea(a));
  for (const q of sorted) {
    const c = quadCentroid(q);
    const size = Math.sqrt(polygonArea(q));
    const duplicate = out.some((other) => {
      const oc = quadCentroid(other);
      const osize = Math.sqrt(polygonArea(other));
      return dist(c, oc) < Math.min(size, osize) * 0.35 && Math.abs(size - osize) / Math.max(size, osize) < 0.3;
    });
    if (!duplicate) out.push(q);
  }
  return sortReadingOrder(out);
}

/** Fotos in Leserichtung sortieren, damit die Reihenfolge im Album stimmt. */
export function sortReadingOrder(quads: Quad[]): Quad[] {
  if (quads.length < 2) return quads;
  const heights = quads.map((q) => Math.abs(q[3].y - q[0].y));
  const rowTolerance = Math.max(...heights) * 0.5;
  return quads
    .map((q) => ({ q, c: quadCentroid(q) }))
    .sort((a, b) => (Math.abs(a.c.y - b.c.y) > rowTolerance ? a.c.y - b.c.y : a.c.x - b.c.x))
    .map((entry) => entry.q);
}

/** Standardviereck, wenn nichts erkannt wurde: 85 % der Bildfläche. */
export function defaultQuad(width: number, height: number): Quad {
  const mx = width * 0.075;
  const my = height * 0.075;
  const pts: Pt[] = [
    { x: mx, y: my },
    { x: width - mx, y: my },
    { x: width - mx, y: height - my },
    { x: mx, y: height - my },
  ];
  return pts as Quad;
}

/**
 * Ordnet die Fotos einer weiteren Aufnahme denen der Grundaufnahme zu.
 *
 * Beim Entspiegeln wandert das Telefon zwischen den Aufnahmen, also liegt
 * dasselbe Foto jedes Mal woanders im Bild. Ohne diese Zuordnung würde jede
 * Aufnahme mit dem Viereck der ersten entzerrt – und damit versetzt.
 *
 * Gibt zu jedem Grundviereck das passende Viereck zurück oder `null`, wenn
 * sich keines sicher zuordnen lässt.
 */
export function matchQuads(base: Quad[], candidates: Quad[]): (Quad | null)[] {
  const used = new Set<number>();

  return base.map((reference) => {
    const center = quadCentroid(reference);
    const size = Math.sqrt(polygonArea(reference));
    let best = -1;
    let bestDistance = Infinity;

    candidates.forEach((candidate, index) => {
      if (used.has(index)) return;
      // Ein deutlich anderes Format ist ein anderes Foto, kein verschobenes.
      const candidateSize = Math.sqrt(polygonArea(candidate));
      const ratio = Math.max(candidateSize, size) / Math.min(candidateSize, size);
      if (ratio > 1.35) return;

      const distance = dist(center, quadCentroid(candidate));
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    });

    // Zu weit weg: lieber nichts zuordnen als das falsche Foto verrechnen.
    if (best < 0 || bestDistance > size * 0.45) return null;
    used.add(best);
    return candidates[best];
  });
}
