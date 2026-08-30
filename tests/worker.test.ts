import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRgba } from '../src/lib/imaging/types';
import type { Quad, RgbaImage } from '../src/lib/imaging/types';
import { drawTextureInQuad, fill, kartonTexture, rectQuad, variedPhoto } from './synth';

/**
 * Der Weg zum Worker – und was passiert, wenn er nicht antwortet.
 *
 * Am echten Album blieb „Foto wird gesucht …" stehen und ging nicht mehr weg.
 * Der Grund lag nicht in der Bilderkennung – die antwortete in Messungen in
 * unter einer halben Sekunde –, sondern hier: ein Auftrag ohne Frist. Stirbt
 * der Worker still, kommt weder Antwort noch Fehler, das Versprechen löst sich
 * nie ein, und die Oberfläche wartet bis zum Neuladen.
 *
 * Warum er stirbt, stand daneben: Zur Analyse ging die Aufnahme in voller
 * Grösse hinüber – über dreissig Megabyte je Kopie, und eine Nahaufnahme machte
 * davon vier hintereinander, für Rechnungen, die innen ohnehin auf 720 und 260
 * Punkten arbeiten.
 */

/** Ein Worker, der Aufträge entgegennimmt und nur antwortet, wenn er soll. */
class StummerWorker {
  /** Was jeder Auftrag zurückbekommt – oder `null` für: gar nichts. */
  static antwort: ((request: Record<string, unknown>) => unknown) | null = null;
  static aufträge: { type: string; width?: number }[] = [];
  static beendet = 0;

  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;

  postMessage(request: Record<string, unknown>): void {
    const bild = (request.image ?? request.page ?? request.frame) as { width?: number } | undefined;
    StummerWorker.aufträge.push({ type: String(request.type), width: bild?.width });
    const antwort = StummerWorker.antwort?.(request);
    if (antwort !== undefined && antwort !== null) {
      queueMicrotask(() => this.onmessage?.({ data: antwort }));
    }
  }

  terminate(): void {
    StummerWorker.beendet++;
  }
}

/** Eine Albumseite auf dem Tisch, gross genug, um verkleinert zu werden. */
function aufnahme(): RgbaImage {
  const img = createRgba(2400, 1800);
  fill(img, 62, 48, 38);
  drawTextureInQuad(img, kartonTexture(90, 68, [234, 228, 214], 3), rectQuad(220, 160, 1960, 1480, 0));
  drawTextureInQuad(img, variedPhoto(330, 250, 11), rectQuad(420, 360, 700, 520, 0));
  return img;
}

describe('Aufträge an den Worker', () => {
  beforeEach(() => {
    StummerWorker.antwort = null;
    StummerWorker.aufträge = [];
    StummerWorker.beendet = 0;
    vi.stubGlobal('Worker', StummerWorker);
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('gibt auf, wenn der Worker nicht mehr antwortet', async () => {
    // Die eigentliche Zusage: Die Oberfläche bleibt nicht stehen. Nach der
    // Frist wird auf dem Hauptthread weitergerechnet – langsamer, aber es
    // kommt eine Antwort.
    vi.useFakeTimers();
    const { detectPageAsync } = await import('../src/lib/pipeline');

    const laufend = detectPageAsync(aufnahme());
    await vi.advanceTimersByTimeAsync(13_000);

    await expect(laufend).resolves.not.toBeNull();
    // Und der stumme Worker wird weggeworfen, statt weiter befragt zu werden.
    expect(StummerWorker.beendet).toBe(1);
  });

  it('schickt zur Analyse nur ein verkleinertes Bild hinüber', async () => {
    vi.useFakeTimers();
    const { detectPageAsync } = await import('../src/lib/pipeline');

    const laufend = detectPageAsync(aufnahme());
    await vi.advanceTimersByTimeAsync(13_000);
    await laufend;

    expect(StummerWorker.aufträge).toHaveLength(1);
    expect(StummerWorker.aufträge[0].width).toBeLessThanOrEqual(1200);
    expect(StummerWorker.aufträge[0].width).toBeLessThan(2400);
  });

  it('rechnet die Antwort in die Koordinaten der vollen Aufnahme zurück', async () => {
    // Die Kehrseite des Verkleinerns: Was der Worker findet, liegt in *seinen*
    // Koordinaten. Ohne die Rückrechnung saesse jedes Viereck bei der Hälfte
    // seiner Stelle – und niemand sähe der Verkleinerung an, dass sie schuld
    // ist.
    StummerWorker.antwort = (request) => {
      const bild = request.image as { width: number; height: number };
      const viereck: Quad = [
        { x: 0, y: 0 },
        { x: bild.width - 1, y: 0 },
        { x: bild.width - 1, y: bild.height - 1 },
        { x: 0, y: bild.height - 1 },
      ];
      return { id: request.id, type: 'page', page: viereck };
    };

    const { detectPageAsync } = await import('../src/lib/pipeline');
    const bild = aufnahme();
    const seite = await detectPageAsync(bild);

    expect(seite).not.toBeNull();
    // Der Worker hat sein ganzes Bild zurückgegeben; in der vollen Aufnahme
    // muss daraus wieder die ganze Aufnahme werden.
    expect(seite![2].x).toBeGreaterThan(bild.width * 0.9);
    expect(seite![2].y).toBeGreaterThan(bild.height * 0.9);
  });
});
