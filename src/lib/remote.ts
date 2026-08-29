import { buildFiles, readFiles } from './backup';
import type { Restored } from './backup';
import { pullFiles, pushFiles } from './github';
import type { PushProgress, Remote } from './github';
import type { Album, Page, Scan } from './storage';

/**
 * Der Token bleibt auf dem Gerät.
 *
 * Er steht bewusst nicht beim Album in der Datenbank: Ein Album wird
 * weitergegeben, exportiert, gesichert – ein Zugangsschlüssel soll dabei nicht
 * mitwandern. Er liegt je Repository für sich, damit ein zweites Album einen
 * eigenen bekommen kann.
 */
const PREFIX = 'fotoscan.token.';

function key(owner: string, repo: string): string {
  return `${PREFIX}${owner}/${repo}`;
}

export function rememberToken(owner: string, repo: string, token: string): void {
  try {
    localStorage.setItem(key(owner, repo), token);
  } catch {
    // Ohne Speicher bleibt der Token für diese Sitzung – mehr geht dann nicht.
  }
}

export function tokenFor(owner: string, repo: string): string {
  try {
    return localStorage.getItem(key(owner, repo)) ?? '';
  } catch {
    return '';
  }
}

export function forgetToken(owner: string, repo: string): void {
  try {
    localStorage.removeItem(key(owner, repo));
  } catch {
    // dann eben nicht
  }
}

export interface Progress {
  /** Was gerade geschieht, in einem Satz. */
  text: string;
  done: number;
  total: number;
}

/** Ein Album in sein Repository sichern. */
export async function backupAlbum(
  album: Album,
  scans: Scan[],
  pages: Page[],
  remote: Remote,
  onProgress?: (progress: Progress) => void,
): Promise<{ uploaded: number; total: number }> {
  onProgress?.({ text: 'Dateien werden vorbereitet …', done: 0, total: 1 });
  const files = await buildFiles(album, scans, pages);

  const report = ({ done, total }: PushProgress) => {
    onProgress?.({ text: `Datei ${done} von ${total}`, done, total });
  };
  const message = `${album.name}: ${scans.length} ${scans.length === 1 ? 'Foto' : 'Fotos'}`;
  const result = await pushFiles(remote, files, message, { onProgress: report });

  return { uploaded: result.uploaded, total: files.length };
}

/** Ein Album aus seinem Repository zurückholen. */
export async function restoreAlbum(remote: Remote, onProgress?: (progress: Progress) => void): Promise<Restored> {
  onProgress?.({ text: 'Sicherung wird gesucht …', done: 0, total: 1 });
  const files = await pullFiles(remote, {
    onProgress: ({ done, total }) => onProgress?.({ text: `Datei ${done} von ${total}`, done, total }),
  });
  return readFiles(files);
}
