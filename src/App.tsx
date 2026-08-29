import { useCallback, useEffect, useState } from 'react';
import type { Album, Page, Scan } from './lib/storage';
import {
  addPage,
  addScan,
  createAlbum,
  deleteAlbum,
  deleteScan,
  listAlbums,
  listPages,
  listScans,
  renameAlbum,
  reorderScans,
  updateScan,
} from './lib/storage';
import { HomeScreen } from './components/HomeScreen';
import { AlbumScreen } from './components/AlbumScreen';
import { CaptureScreen } from './components/CaptureScreen';
import type { Shot } from './components/CaptureScreen';
import { ReviewScreen } from './components/ReviewScreen';
import type { ExtractedPhoto, PageImage } from './components/ReviewScreen';
import { Spinner } from './components/ui';

type View = 'home' | 'album' | 'capture' | 'review';

export function App() {
  const [view, setView] = useState<View>('home');
  const [albums, setAlbums] = useState<Album[]>([]);
  const [counts, setCounts] = useState<Map<string, number>>(new Map());
  const [covers, setCovers] = useState<Map<string, Blob>>(new Map());
  const [album, setAlbum] = useState<Album | null>(null);
  const [scans, setScans] = useState<Scan[]>([]);
  const [pages, setPages] = useState<Page[]>([]);
  const [shot, setShot] = useState<Shot | null>(null);
  const [ready, setReady] = useState(false);

  const refreshAlbums = useCallback(async () => {
    const list = await listAlbums();
    setAlbums(list);
    const nextCounts = new Map<string, number>();
    const nextCovers = new Map<string, Blob>();
    await Promise.all(
      list.map(async (entry) => {
        const entryScans = await listScans(entry.id);
        nextCounts.set(entry.id, entryScans.length);
        if (entryScans[0]) nextCovers.set(entry.id, entryScans[0].blob);
      }),
    );
    setCounts(nextCounts);
    setCovers(nextCovers);
  }, []);

  useEffect(() => {
    void refreshAlbums().finally(() => setReady(true));
  }, [refreshAlbums]);

  const openAlbum = useCallback(async (entry: Album) => {
    setAlbum(entry);
    setScans(await listScans(entry.id));
    setPages(await listPages(entry.id));
    setView('album');
  }, []);

  const reloadScans = useCallback(async (entry: Album) => {
    setScans(await listScans(entry.id));
    setPages(await listPages(entry.id));
  }, []);

  const handleCreate = useCallback(
    async (name: string) => {
      const entry = await createAlbum(name || `Album ${albums.length + 1}`);
      await refreshAlbums();
      await openAlbum(entry);
    },
    [albums.length, openAlbum, refreshAlbums],
  );

  const handleAccept = useCallback(
    async (photos: ExtractedPhoto[], page: PageImage | null) => {
      if (!album) return;
      // Erst die Seite, dann die Fotos darauf – so weiss jedes Foto, wo es
      // hergekommen ist.
      const stored = page
        ? await addPage({ albumId: album.id, blob: page.blob, width: page.width, height: page.height })
        : null;
      for (const photo of photos) {
        await addScan({
          albumId: album.id,
          blob: photo.blob,
          width: photo.width,
          height: photo.height,
          pageId: stored?.id,
        });
      }
      await reloadScans(album);
      void refreshAlbums();
      setShot(null);
      setView('capture');
    },
    [album, refreshAlbums, reloadScans],
  );

  if (!ready) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-stone-950">
        <Spinner label="Alben werden geladen …" />
      </div>
    );
  }

  if (view === 'review' && shot && album) {
    return (
      <ReviewScreen
        shot={shot}
        onCancel={() => {
          setShot(null);
          setView('capture');
        }}
        onAccept={handleAccept}
      />
    );
  }

  if (view === 'capture' && album) {
    return (
      <CaptureScreen
        albumName={album.name}
        onShot={(next) => {
          setShot(next);
          setView('review');
        }}
        onBack={() => {
          void reloadScans(album);
          setView('album');
        }}
      />
    );
  }

  if (view === 'album' && album) {
    return (
      <AlbumScreen
        album={album}
        scans={scans}
        pages={pages}
        onBack={() => {
          void refreshAlbums();
          setAlbum(null);
          setView('home');
        }}
        onScan={() => setView('capture')}
        onDeleteScan={async (scan) => {
          await deleteScan(scan.id);
          await reloadScans(album);
          void refreshAlbums();
        }}
        onSaveScan={async (scan) => {
          await updateScan(scan);
          setScans((current) => current.map((entry) => (entry.id === scan.id ? scan : entry)));
        }}
        onReorder={async (next) => {
          // Sofort anzeigen, dann sichern: Beim Ziehen soll nichts nachhinken.
          setScans(next.map((scan, index) => ({ ...scan, order: index })));
          await reorderScans(next);
        }}
        onRename={async (name) => {
          const updated = await renameAlbum(album, name);
          setAlbum(updated);
          void refreshAlbums();
        }}
        onDeleteAlbum={async () => {
          await deleteAlbum(album.id);
          setAlbum(null);
          setView('home');
          void refreshAlbums();
        }}
      />
    );
  }

  return <HomeScreen albums={albums} counts={counts} covers={covers} onOpen={(entry) => void openAlbum(entry)} onCreate={handleCreate} />;
}
