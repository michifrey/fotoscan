const DB_NAME = 'fotoscan';
const DB_VERSION = 2;
const ALBUMS = 'albums';
const SCANS = 'scans';
const PAGES = 'pages';

export interface Album {
  id: string;
  name: string;
  createdAt: number;
  /** Wohin dieses Album gesichert wird. Der Token steht nicht hier – siehe `remote.ts`. */
  remote?: { owner: string; repo: string };
}

export interface Scan {
  id: string;
  albumId: string;
  createdAt: number;
  width: number;
  height: number;
  blob: Blob;
  /** Platz im Album. Kleinere Werte kommen zuerst. */
  order: number;
  /** Albumseite, von der dieses Foto stammt. */
  pageId?: string;
  /** Überschrift, frei vergeben. */
  title?: string;
  /** Wann der Abzug entstanden ist – als Text, denn „Sommer 1978" ist kein Datum. */
  taken?: string;
  /** Längere Notiz: wer darauf ist, was dazugehört. */
  note?: string;
  /**
   * Die Handschrift von der Albumseite, als Bildausschnitt.
   *
   * Abgeschrieben wird sie nicht – alte Handschrift zu lesen ist eine eigene
   * Wissenschaft, und geraten wäre schlimmer als gar nichts. Sie bleibt als
   * Bild beim Foto stehen, dort, wo sie hingehört.
   */
  writing?: Blob;
  writingWidth?: number;
  writingHeight?: number;
}

/**
 * Eine aufgeschlagene Albumseite.
 *
 * Die einzelnen Fotos sind das Ergebnis, aber die Seite ist der Zusammenhang:
 * welche Bilder nebeneinander lagen, was daneben stand. Die Übersichtsaufnahme
 * bewahrt ihn auf, verkleinert und deshalb billig.
 */
export interface Page {
  id: string;
  albumId: string;
  createdAt: number;
  order: number;
  width: number;
  height: number;
  blob: Blob;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(ALBUMS)) {
        db.createObjectStore(ALBUMS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(SCANS)) {
        const store = db.createObjectStore(SCANS, { keyPath: 'id' });
        store.createIndex('albumId', 'albumId');
      }
      if (!db.objectStoreNames.contains(PAGES)) {
        const store = db.createObjectStore(PAGES, { keyPath: 'id' });
        store.createIndex('albumId', 'albumId');
      }
      // Fotos aus der ersten Fassung kennen ihren Platz noch nicht. Sie
      // bekommen ihn aus der Reihenfolge, in der sie entstanden sind.
      if (request.transaction) {
        const scans = request.transaction.objectStore(SCANS);
        scans.getAll().onsuccess = (event) => {
          const all = (event.target as IDBRequest<Scan[]>).result;
          all
            .filter((scan) => typeof scan.order !== 'number')
            .sort((a, b) => a.createdAt - b.createdAt)
            .forEach((scan, index) => scans.put({ ...scan, order: index }));
        };
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

function run<T>(store: string, mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const request = fn(tx.objectStore(store));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }),
  );
}

export function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function listAlbums(): Promise<Album[]> {
  const albums = await run<Album[]>(ALBUMS, 'readonly', (store) => store.getAll());
  return albums.sort((a, b) => b.createdAt - a.createdAt);
}

export async function createAlbum(name: string): Promise<Album> {
  const album: Album = { id: newId(), name: name.trim() || 'Album', createdAt: Date.now() };
  await run(ALBUMS, 'readwrite', (store) => store.put(album));
  return album;
}

export async function renameAlbum(album: Album, name: string): Promise<Album> {
  const updated = { ...album, name: name.trim() || album.name };
  await run(ALBUMS, 'readwrite', (store) => store.put(updated));
  return updated;
}

export async function deleteAlbum(id: string): Promise<void> {
  const scans = await listScans(id);
  await Promise.all(scans.map((scan) => deleteScan(scan.id)));
  const pages = await listPages(id);
  await Promise.all(pages.map((page) => deletePage(page.id)));
  await run(ALBUMS, 'readwrite', (store) => store.delete(id));
}

export async function listScans(albumId: string): Promise<Scan[]> {
  const scans = await run<Scan[]>(SCANS, 'readonly', (store) => store.index('albumId').getAll(albumId));
  return sortScans(scans);
}

/** Nach eigenem Platz, bei Gleichstand nach Entstehung. */
export function sortScans(scans: Scan[]): Scan[] {
  return scans
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.createdAt - b.createdAt);
}

export async function addScan(
  scan: Omit<Scan, 'id' | 'createdAt' | 'order'> & { createdAt?: number; order?: number },
): Promise<Scan> {
  const existing = await listScans(scan.albumId);
  const full: Scan = {
    ...scan,
    id: newId(),
    createdAt: scan.createdAt ?? Date.now(),
    order: scan.order ?? (existing.length > 0 ? (existing[existing.length - 1].order ?? 0) + 1 : 0),
  };
  await run(SCANS, 'readwrite', (store) => store.put(full));
  return full;
}

/**
 * Fotos in eine neue Reihenfolge bringen. Übergeben wird die gewünschte
 * Reihenfolge; gespeichert wird nur, was sich tatsächlich verschoben hat.
 */
export async function reorderScans(scans: Scan[]): Promise<Scan[]> {
  const updated = scans.map((scan, index) => ({ ...scan, order: index }));
  await Promise.all(
    updated.filter((scan, index) => scans[index].order !== scan.order).map((scan) => updateScan(scan)),
  );
  return updated;
}

export async function listPages(albumId: string): Promise<Page[]> {
  const pages = await run<Page[]>(PAGES, 'readonly', (store) => store.index('albumId').getAll(albumId));
  return pages.sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
}

export async function addPage(page: Omit<Page, 'id' | 'createdAt' | 'order'> & { order?: number }): Promise<Page> {
  const existing = await listPages(page.albumId);
  const full: Page = {
    ...page,
    id: newId(),
    createdAt: Date.now(),
    order: page.order ?? existing.length,
  };
  await run(PAGES, 'readwrite', (store) => store.put(full));
  return full;
}

export async function deletePage(id: string): Promise<void> {
  await run(PAGES, 'readwrite', (store) => store.delete(id));
}

/** Merkt sich, wohin dieses Album gesichert wird. */
export async function setRemote(album: Album, remote: Album['remote']): Promise<Album> {
  const updated = { ...album, remote };
  await run(ALBUMS, 'readwrite', (store) => store.put(updated));
  return updated;
}

/**
 * Schreibt ein Foto so, wie es ist – mit seiner Kennung.
 *
 * Beim Wiederherstellen zählt genau das: Nur wenn die Kennungen erhalten
 * bleiben, finden die Fotos ihre Albumseite wieder, und ein zweites
 * Wiederherstellen legt nichts doppelt an.
 */
export async function putScan(scan: Scan): Promise<void> {
  await run(SCANS, 'readwrite', (store) => store.put(scan));
}

export async function putPage(page: Page): Promise<void> {
  await run(PAGES, 'readwrite', (store) => store.put(page));
}

export async function updateScan(scan: Scan): Promise<void> {
  await run(SCANS, 'readwrite', (store) => store.put(scan));
}

export async function deleteScan(id: string): Promise<void> {
  await run(SCANS, 'readwrite', (store) => store.delete(id));
}

export async function countScans(albumId: string): Promise<number> {
  const scans = await listScans(albumId);
  return scans.length;
}

/** Geschätzter Speicherverbrauch, damit der Nutzer den Überblick behält. */
export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  if (!navigator.storage?.estimate) return null;
  const estimate = await navigator.storage.estimate();
  return { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 };
}
