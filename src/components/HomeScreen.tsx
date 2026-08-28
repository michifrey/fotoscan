import { useEffect, useState } from 'react';
import type { Album } from '../lib/storage';
import { storageEstimate } from '../lib/storage';
import { formatBytes } from '../lib/export';
import { Button, Empty } from './ui';

interface Props {
  albums: Album[];
  counts: Map<string, number>;
  covers: Map<string, Blob>;
  onOpen: (album: Album) => void;
  onCreate: (name: string) => Promise<void>;
}

export function HomeScreen({ albums, counts, covers, onOpen, onCreate }: Props) {
  const [name, setName] = useState('');
  const [usage, setUsage] = useState<string | null>(null);
  const [coverUrls, setCoverUrls] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    void storageEstimate().then((estimate) => {
      if (estimate && estimate.usage > 0) setUsage(formatBytes(estimate.usage));
    });
  }, [albums]);

  useEffect(() => {
    const urls = new Map([...covers].map(([id, blob]) => [id, URL.createObjectURL(blob)]));
    setCoverUrls(urls);
    return () => urls.forEach((url) => URL.revokeObjectURL(url));
  }, [covers]);

  const create = async () => {
    await onCreate(name);
    setName('');
  };

  return (
    <div className="flex min-h-dvh flex-col bg-stone-950 text-stone-100">
      <header className="px-5 pt-8 pb-4">
        <h1 className="text-2xl font-semibold tracking-tight">Fotoscan</h1>
        <p className="mt-1 text-sm text-stone-400">
          Alte Fotoalben mit dem Telefon digitalisieren – ohne Konto, ohne Upload.
        </p>
      </header>

      <form
        className="flex gap-2 px-5 pb-5"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Neues Album, z. B. „Ferien 1978“"
          aria-label="Name des neuen Albums"
          data-testid="album-name"
          className="min-w-0 flex-1 rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm placeholder:text-stone-500 focus:border-amber-400/60 focus:outline-none"
        />
        <Button variant="primary" type="submit" data-testid="create-album">
          Anlegen
        </Button>
      </form>

      {albums.length === 0 ? (
        <Empty
          title="Noch keine Alben"
          hint="Leg für jedes Fotoalbum ein eigenes Album an. Die Fotos bleiben auf deinem Gerät, bis du sie exportierst."
        />
      ) : (
        <ul className="flex-1 space-y-2 px-5 pb-8">
          {albums.map((album) => (
            <li key={album.id}>
              <button
                type="button"
                onClick={() => onOpen(album)}
                className="flex w-full items-center gap-3 rounded-xl border border-white/10 bg-white/5 p-3 text-left transition hover:bg-white/10"
              >
                <span className="size-14 shrink-0 overflow-hidden rounded-lg bg-white/10">
                  {coverUrls.get(album.id) && (
                    <img src={coverUrls.get(album.id)} alt="" className="size-full object-cover" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{album.name}</span>
                  <span className="block text-xs text-stone-400">
                    {counts.get(album.id) ?? 0} {(counts.get(album.id) ?? 0) === 1 ? 'Foto' : 'Fotos'} ·{' '}
                    {new Date(album.createdAt).toLocaleDateString('de-CH')}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <footer className="px-5 pb-8 text-xs text-stone-500">
        {usage && <p>Belegter Speicher auf diesem Gerät: {usage}</p>}
        <p className="mt-1">
          Tipp: Über das Browsermenü lässt sich Fotoscan als App auf den Startbildschirm legen und funktioniert dann auch
          ohne Internet.
        </p>
      </footer>
    </div>
  );
}
