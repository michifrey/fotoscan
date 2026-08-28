const DB_NAME = 'fotoscan';
const DB_VERSION = 1;
const ALBUMS = 'albums';
const SCANS = 'scans';

export interface Album {
  id: string;
  name: string;
  createdAt: number;
}

export interface Scan {
  id: string;
  albumId: string;
  createdAt: number;
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
  await run(ALBUMS, 'readwrite', (store) => store.delete(id));
}

export async function listScans(albumId: string): Promise<Scan[]> {
  const scans = await run<Scan[]>(SCANS, 'readonly', (store) => store.index('albumId').getAll(albumId));
  return scans.sort((a, b) => a.createdAt - b.createdAt);
}

export async function addScan(scan: Omit<Scan, 'id' | 'createdAt'> & { createdAt?: number }): Promise<Scan> {
  const full: Scan = { ...scan, id: newId(), createdAt: scan.createdAt ?? Date.now() };
  await run(SCANS, 'readwrite', (store) => store.put(full));
  return full;
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
