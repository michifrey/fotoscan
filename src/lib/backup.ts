import type { Album, Page, PageMarks, Scan } from './storage';
import type { RemoteFile } from './github';

/**
 * Wie ein Album im Repository aussieht.
 *
 * Die Bilder liegen als gewöhnliche JPEG-Dateien, daneben eine einzige
 * `album.json` mit allem, was nicht im Bild steht: Titel, Datum, Notiz,
 * Reihenfolge, Seitenzugehörigkeit. Damit ist das Repository nicht nur eine
 * Ablage, sondern das vollständige Sicherungsformat – und lesbar, ohne diese
 * App überhaupt zu kennen.
 */
export interface Manifest {
  version: 1;
  album: { name: string; createdAt: number };
  pages: {
    id: string;
    createdAt: number;
    order: number;
    width: number;
    height: number;
    file: string;
    /**
     * Die geprüften Vierecke auf dieser Seite, in Koordinaten der Bilddatei
     * daneben. Damit ist die Sicherung vollständig – bisher ging verloren, *wo*
     * die Fotos auf der Seite lagen – und zugleich ein gelabelter Datensatz:
     * ein Bild und die Polygone darauf, von Hand geprüft.
     */
    marks?: PageMarks;
  }[];
  photos: {
    id: string;
    createdAt: number;
    order: number;
    width: number;
    height: number;
    file: string;
    pageId?: string;
    title?: string;
    taken?: string;
    note?: string;
    writing?: { file: string; width: number; height: number };
  }[];
}

export const MANIFEST = 'album.json';

/** Ein Name, der in jedem Dateisystem und in jedem Browser durchgeht. */
function slug(value: string): string {
  return (
    value
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-zA-Z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'foto'
  );
}

/**
 * Aus einem Album die Dateien machen, die hochgeladen werden.
 *
 * Die Nummer im Dateinamen ist die Reihenfolge im Album: So liegen die Fotos
 * auch in der Dateiliste des Repositories richtig, ohne dass jemand die
 * `album.json` lesen muss.
 */
export async function buildFiles(album: Album, scans: Scan[], pages: Page[]): Promise<RemoteFile[]> {
  const files: RemoteFile[] = [];
  const manifest: Manifest = {
    version: 1,
    album: { name: album.name, createdAt: album.createdAt },
    pages: [],
    photos: [],
  };

  for (const [index, page] of pages.entries()) {
    const file = `seiten/${String(index + 1).padStart(3, '0')}-${page.id}.jpg`;
    files.push({ path: file, data: await bytes(page.blob) });
    manifest.pages.push({
      id: page.id,
      createdAt: page.createdAt,
      order: page.order,
      width: page.width,
      height: page.height,
      file,
      marks: page.marks,
    });
  }

  for (const [index, scan] of scans.entries()) {
    const stem = `${String(index + 1).padStart(4, '0')}-${slug(scan.title ?? scan.id)}`;
    const file = `fotos/${stem}.jpg`;
    files.push({ path: file, data: await bytes(scan.blob) });

    let writing: Manifest['photos'][number]['writing'];
    if (scan.writing && scan.writingWidth && scan.writingHeight) {
      const path = `handschrift/${stem}.jpg`;
      files.push({ path, data: await bytes(scan.writing) });
      writing = { file: path, width: scan.writingWidth, height: scan.writingHeight };
    }

    manifest.photos.push({
      id: scan.id,
      createdAt: scan.createdAt,
      order: scan.order,
      width: scan.width,
      height: scan.height,
      file,
      pageId: scan.pageId,
      title: scan.title,
      taken: scan.taken,
      note: scan.note,
      writing,
    });
  }

  files.push({
    path: MANIFEST,
    data: new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`),
  });
  return files;
}

export interface Restored {
  name: string;
  createdAt: number;
  pages: (Omit<Page, 'albumId'> & { albumId?: string })[];
  photos: (Omit<Scan, 'albumId'> & { albumId?: string })[];
}

/**
 * Aus den geholten Dateien wieder ein Album machen.
 *
 * Fehlt zu einem Eintrag die Bilddatei, wird er übersprungen statt zu einem
 * leeren Platzhalter: Ein halbes Album ist besser als eines mit Löchern, die
 * wie Fehler aussehen.
 */
export function readFiles(files: RemoteFile[]): Restored {
  const byPath = new Map(files.map((file) => [file.path, file.data]));
  const raw = byPath.get(MANIFEST);
  if (!raw) throw new Error('Im Repository liegt keine album.json – das ist keine Sicherung dieser App.');

  const manifest = JSON.parse(new TextDecoder().decode(raw as Uint8Array<ArrayBuffer>)) as Manifest;
  if (manifest.version !== 1) throw new Error(`Unbekannte Fassung der Sicherung: ${manifest.version}`);

  const pages: Restored['pages'] = [];
  for (const page of manifest.pages) {
    const data = byPath.get(page.file);
    if (!data) continue;
    pages.push({
      id: page.id,
      createdAt: page.createdAt,
      order: page.order,
      width: page.width,
      height: page.height,
      blob: jpeg(data),
      marks: page.marks,
    });
  }

  const photos: Restored['photos'] = [];
  for (const photo of manifest.photos) {
    const data = byPath.get(photo.file);
    if (!data) continue;
    const writing = photo.writing ? byPath.get(photo.writing.file) : undefined;
    photos.push({
      id: photo.id,
      createdAt: photo.createdAt,
      order: photo.order,
      width: photo.width,
      height: photo.height,
      blob: jpeg(data),
      pageId: photo.pageId,
      title: photo.title,
      taken: photo.taken,
      note: photo.note,
      writing: writing ? jpeg(writing) : undefined,
      writingWidth: writing ? photo.writing?.width : undefined,
      writingHeight: writing ? photo.writing?.height : undefined,
    });
  }

  return { name: manifest.album.name, createdAt: manifest.album.createdAt, pages, photos };
}

function jpeg(data: Uint8Array): Blob {
  return new Blob([data as unknown as BlobPart], { type: 'image/jpeg' });
}

async function bytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}
