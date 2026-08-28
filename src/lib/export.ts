import { createZip, safeFileName } from './zip';
import type { Album, Scan } from './storage';

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Erst nach dem Klick freigeben, sonst bricht der Download ab.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function scanFileName(album: Album, index: number): string {
  return `${safeFileName(album.name)}_${String(index + 1).padStart(3, '0')}.jpg`;
}

export function canShareFiles(files: File[]): boolean {
  return typeof navigator.canShare === 'function' && navigator.canShare({ files });
}

/**
 * Auf dem Telefon ist Teilen der bequemste Weg (direkt in Google Fotos oder
 * eine Cloud); am Rechner bleibt der Download.
 */
export async function shareOrDownload(blob: Blob, fileName: string, title: string): Promise<'shared' | 'downloaded'> {
  const file = new File([blob], fileName, { type: blob.type });
  if (canShareFiles([file])) {
    try {
      await navigator.share({ files: [file], title });
      return 'shared';
    } catch (error) {
      // Abbruch durch den Nutzer ist kein Fehler – dann passiert einfach nichts.
      if (error instanceof DOMException && error.name === 'AbortError') return 'shared';
    }
  }
  downloadBlob(blob, fileName);
  return 'downloaded';
}

export async function albumZip(album: Album, scans: Scan[]): Promise<Blob> {
  const entries = await Promise.all(
    scans.map(async (scan, index) => ({
      name: scanFileName(album, index),
      data: new Uint8Array(await scan.blob.arrayBuffer()),
      date: new Date(scan.createdAt),
    })),
  );
  return createZip(entries);
}

/** Teilt alle Fotos eines Albums einzeln, sonst als ZIP-Datei. */
export async function exportAlbum(album: Album, scans: Scan[]): Promise<'shared' | 'downloaded'> {
  const files = scans.map((scan, index) => new File([scan.blob], scanFileName(album, index), { type: 'image/jpeg' }));
  if (files.length > 0 && canShareFiles(files)) {
    try {
      await navigator.share({ files, title: album.name });
      return 'shared';
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return 'shared';
    }
  }
  downloadBlob(await albumZip(album, scans), `${safeFileName(album.name)}.zip`);
  return 'downloaded';
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}
