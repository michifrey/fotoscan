import { describe, expect, it } from 'vitest';
import { buildFiles, MANIFEST, readFiles } from '../src/lib/backup';
import type { Manifest } from '../src/lib/backup';
import type { Album, Page, PageMarks, Scan } from '../src/lib/storage';
import type { Quad } from '../src/lib/imaging/types';

/**
 * Die geprüften Vierecke einer Albumseite – und warum sie mitgesichert werden.
 *
 * In der zweiten Stufe sieht der Nutzer die Vorschläge der Erkennung, zieht
 * Ecken zurecht, holt ein übersehenes Foto mit einem Tipp dazu und wählt ab,
 * was keines ist. Was danach dasteht, ist eine **von Hand geprüfte Wahrheit**.
 * Bisher wurde sie nach dem Speichern weggeworfen.
 *
 * Zwei Dinge gewinnt die Sicherung dadurch. Sie wird vollständig: Bisher hielt
 * sie fest, *dass* ein Foto von einer Seite stammt, aber nicht, *wo* es darauf
 * lag – die Anordnung einer Albumseite ist selbst ein Stück Familiengeschichte.
 * Und sie wird zum Datensatz: ein Bild und die Polygone darauf, in denselben
 * Koordinaten. Genau das braucht eine Erkennung, die lernen soll, statt zu
 * raten – und genau daran fehlt es diesem Projekt bisher.
 */

function jpeg(marker: number): Blob {
  return new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, marker, 0xff, 0xd9])], { type: 'image/jpeg' });
}

const album: Album = { id: 'a1', name: 'Ferien 1978', createdAt: 1000 };

/** Ein Rechteck – die Reihenfolge ist die der App. */
function rect(x: number, y: number, w: number, h: number): Quad {
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
}

const marks: PageMarks = {
  page: rect(40, 30, 800, 620),
  photos: [rect(90, 80, 300, 220), rect(450, 300, 320, 240)],
};

const seite: Page = {
  id: 'p1',
  albumId: 'a1',
  createdAt: 1100,
  order: 0,
  width: 900,
  height: 700,
  blob: jpeg(9),
  marks,
};

const fotos: Scan[] = [
  { id: 's1', albumId: 'a1', createdAt: 1200, order: 0, width: 300, height: 220, blob: jpeg(1), pageId: 'p1' },
  { id: 's2', albumId: 'a1', createdAt: 1300, order: 1, width: 320, height: 240, blob: jpeg(2), pageId: 'p1' },
];

/** Die album.json aus den gebauten Dateien lesen. */
function manifestOf(files: { path: string; data: Uint8Array }[]): Manifest {
  const raw = files.find((file) => file.path === MANIFEST)!.data;
  return JSON.parse(new TextDecoder().decode(raw)) as Manifest;
}

describe('geprüfte Vierecke einer Albumseite', () => {
  it('gehen mit in die Sicherung und kommen unverändert zurück', async () => {
    const files = await buildFiles(album, fotos, [seite]);
    const zurück = readFiles(files);

    expect(zurück.pages).toHaveLength(1);
    expect(zurück.pages[0].marks).toEqual(marks);
  });

  it('stehen in der album.json neben ihrer Bilddatei', async () => {
    // Der Sinn der Sache: Wer die Sicherung liest, hat Bild und Polygone
    // beieinander und braucht diese App nicht zu kennen.
    const manifest = manifestOf(await buildFiles(album, fotos, [seite]));
    const eintrag = manifest.pages[0];

    expect(eintrag.file).toMatch(/\.jpg$/);
    expect(eintrag.marks?.photos).toHaveLength(2);
  });

  it('liegen in den Koordinaten der gespeicherten Bilddatei', async () => {
    // Die eine Zusage, an der alles hängt. Gespeichert wird die verkleinerte
    // Fassung der Aufnahme; ein Polygon in den Koordinaten der *vollen*
    // Aufnahme wäre stumm, denn die gibt es nach dem Speichern nicht mehr.
    const manifest = manifestOf(await buildFiles(album, fotos, [seite]));
    const eintrag = manifest.pages[0];

    for (const quad of [eintrag.marks!.page, ...eintrag.marks!.photos]) {
      for (const point of quad) {
        expect(point.x).toBeGreaterThanOrEqual(0);
        expect(point.y).toBeGreaterThanOrEqual(0);
        expect(point.x).toBeLessThanOrEqual(eintrag.width);
        expect(point.y).toBeLessThanOrEqual(eintrag.height);
      }
    }
  });

  it('fehlen dürfen, ohne die Sicherung zu stören', async () => {
    // Alben aus der Zeit davor haben keine. Sie müssen weiter gehen – eine
    // Sicherung, die an alten Daten scheitert, ist keine.
    const ohne: Page = { ...seite, marks: undefined };
    const zurück = readFiles(await buildFiles(album, fotos, [ohne]));

    expect(zurück.pages).toHaveLength(1);
    expect(zurück.pages[0].marks).toBeUndefined();
  });
});
