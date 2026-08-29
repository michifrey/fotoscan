import { useCallback, useState } from 'react';
import { backupAlbum, forgetToken, rememberToken, restoreAlbum, tokenFor } from '../lib/remote';
import type { Progress } from '../lib/remote';
import type { Restored } from '../lib/backup';
import type { Album, Page, Scan } from '../lib/storage';
import { Button } from './ui';

interface Props {
  /** Beim Sichern das Album; beim Holen gibt es noch keines. */
  album?: Album;
  scans?: Scan[];
  pages?: Page[];
  onClose: () => void;
  onSaved?: (remote: { owner: string; repo: string }) => Promise<void>;
  onRestored?: (remote: { owner: string; repo: string }, restored: Restored) => Promise<void>;
}

/**
 * Sichern in ein eigenes, privates GitHub-Repository – und zurückholen.
 *
 * Alles, was es dazu braucht, steht auf diesem Blatt: Wem das Repository
 * gehört, wie es heisst, und ein Token. Der Token bleibt auf dem Gerät und
 * wandert nicht ins Album.
 */
export function RemoteSheet({ album, scans = [], pages = [], onClose, onSaved, onRestored }: Props) {
  const [owner, setOwner] = useState(album?.remote?.owner ?? '');
  const [repo, setRepo] = useState(album?.remote?.repo ?? '');
  const [token, setToken] = useState(() =>
    album?.remote ? tokenFor(album.remote.owner, album.remote.repo) : '',
  );
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const ready = owner.trim().length > 0 && repo.trim().length > 0 && token.trim().length > 0;

  const run = useCallback(
    async (task: (remote: { owner: string; repo: string; token: string }) => Promise<string>) => {
      const remote = { owner: owner.trim(), repo: repo.trim(), token: token.trim() };
      setError(null);
      setDone(null);
      setProgress({ text: 'Verbindung wird geprüft …', done: 0, total: 1 });
      try {
        const message = await task(remote);
        rememberToken(remote.owner, remote.repo, remote.token);
        setDone(message);
      } catch (problem) {
        setError(problem instanceof Error ? problem.message : String(problem));
      } finally {
        setProgress(null);
      }
    },
    [owner, repo, token],
  );

  const backup = () =>
    void run(async (remote) => {
      if (!album) return '';
      const result = await backupAlbum(album, scans, pages, remote, setProgress);
      await onSaved?.({ owner: remote.owner, repo: remote.repo });
      return result.uploaded === 0
        ? 'Alles war schon gesichert – nichts zu tun.'
        : `Gesichert: ${result.uploaded} von ${result.total} Dateien neu hochgeladen.`;
    });

  const restore = () =>
    void run(async (remote) => {
      const restored = await restoreAlbum(remote, setProgress);
      await onRestored?.({ owner: remote.owner, repo: remote.repo }, restored);
      return `„${restored.name}“ mit ${restored.photos.length} Fotos zurückgeholt.`;
    });

  return (
    <div className="fixed inset-0 z-40 flex items-end bg-black/70" onClick={onClose}>
      <div
        className="max-h-[92dvh] w-full space-y-3 overflow-y-auto rounded-t-2xl border-t border-white/10 bg-stone-950 px-4 pt-4 pb-6"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="text-sm font-medium">{album ? 'Auf GitHub sichern' : 'Album aus GitHub holen'}</h2>
        <p className="text-xs text-stone-400">
          Ein privates Repository je Album. Neben den Fotos liegt eine <code>album.json</code> mit
          Titeln, Daten, Notizen und der Reihenfolge – damit ist die Sicherung vollständig und auch
          ohne diese App lesbar.
        </p>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Konto" value={owner} onChange={setOwner} placeholder="michifrey" testId="remote-owner" />
          <Field label="Repository" value={repo} onChange={setRepo} placeholder="ferien-1978" testId="remote-repo" />
        </div>
        <label className="block">
          <span className="text-xs text-stone-400">Token</span>
          <input
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="github_pat_…"
            data-testid="remote-token"
            className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm outline-none focus:border-amber-400/60"
          />
        </label>
        <p className="text-[11px] leading-relaxed text-stone-500">
          Ein fein abgestufter Token, nur für dieses Repository, mit dem Recht „Contents: Lesen und
          Schreiben“. Er bleibt auf diesem Gerät. Geht das Telefon verloren, widerrufe ihn auf GitHub –
          dann ist er wertlos.
        </p>

        {progress && (
          <div className="rounded-lg bg-white/5 px-3 py-2" data-testid="remote-progress">
            <p className="text-xs text-stone-300">{progress.text}</p>
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full bg-amber-400 transition-all"
                style={{ width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%` }}
              />
            </div>
          </div>
        )}
        {error && (
          <p className="rounded-lg bg-red-500/15 px-3 py-2 text-xs text-red-200" data-testid="remote-error">
            {error}
          </p>
        )}
        {done && (
          <p className="rounded-lg bg-amber-400/10 px-3 py-2 text-xs text-amber-200" data-testid="remote-done">
            {done}
          </p>
        )}

        {album ? (
          <>
            <Button
              variant="primary"
              className="w-full"
              disabled={!ready || progress !== null}
              onClick={backup}
              data-testid="remote-backup"
            >
              Sichern
            </Button>
            <Button
              className="w-full"
              disabled={!ready || progress !== null}
              onClick={restore}
              data-testid="remote-restore"
            >
              Von GitHub wiederherstellen
            </Button>
          </>
        ) : (
          <Button
            variant="primary"
            className="w-full"
            disabled={!ready || progress !== null}
            onClick={restore}
            data-testid="remote-restore"
          >
            Holen
          </Button>
        )}

        <div className="flex gap-3 pt-1">
          <Button className="flex-1" onClick={onClose}>
            Schliessen
          </Button>
          {album?.remote && (
            <Button
              className="flex-1"
              onClick={() => {
                forgetToken(album.remote!.owner, album.remote!.repo);
                setToken('');
              }}
            >
              Token vergessen
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  testId,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  testId: string;
}) {
  return (
    <label className="block">
      <span className="text-xs text-stone-400">{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        data-testid={testId}
        className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm outline-none focus:border-amber-400/60"
      />
    </label>
  );
}
