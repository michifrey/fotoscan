import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { Album, Page, Scan } from '../lib/storage';
import type { Restored } from '../lib/backup';
import { exportAlbum, exportBook, scanFileName, shareOrDownload } from '../lib/export';
import { PhotoGrid } from './PhotoGrid';
import { RemoteSheet } from './RemoteSheet';
import { PhotoViewer } from './PhotoViewer';
import { BackIcon, Button, Empty, IconButton, Switch, TopBar } from './ui';

interface Props {
  album: Album;
  scans: Scan[];
  pages: Page[];
  onBack: () => void;
  onScan: () => void;
  onDeleteScan: (scan: Scan) => Promise<void>;
  onSaveScan: (scan: Scan) => Promise<void>;
  onReorder: (scans: Scan[]) => Promise<void>;
  onRename: (name: string) => Promise<void>;
  onDeleteAlbum: () => Promise<void>;
  onRemote: (remote: { owner: string; repo: string }) => Promise<void>;
  onRestored: (remote: { owner: string; repo: string }, restored: Restored) => Promise<void>;
}

type View = 'fotos' | 'seiten';

export function AlbumScreen({
  album,
  scans,
  pages,
  onBack,
  onScan,
  onDeleteScan,
  onSaveScan,
  onReorder,
  onRename,
  onDeleteAlbum,
  onRemote,
  onRestored,
}: Props) {
  const [view, setView] = useState<View>('fotos');
  const [query, setQuery] = useState('');
  const [ordering, setOrdering] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [withPages, setWithPages] = useState(true);
  const [remoteOpen, setRemoteOpen] = useState(false);

  const urls = useMemo(() => new Map(scans.map((scan) => [scan.id, URL.createObjectURL(scan.blob)])), [scans]);
  useEffect(() => () => urls.forEach((url) => URL.revokeObjectURL(url)), [urls]);

  const pageUrls = useMemo(() => new Map(pages.map((page) => [page.id, URL.createObjectURL(page.blob)])), [pages]);
  useEffect(() => () => pageUrls.forEach((url) => URL.revokeObjectURL(url)), [pageUrls]);

  const pageById = useMemo(() => new Map(pages.map((page) => [page.id, page])), [pages]);

  // Gesucht wird über alles, was von Hand dazugeschrieben wurde.
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return scans;
    return scans.filter((scan) =>
      [scan.title, scan.taken, scan.note].some((value) => value?.toLowerCase().includes(needle)),
    );
  }, [query, scans]);

  const openIndex = open ? shown.findIndex((scan) => scan.id === open) : -1;

  const rename = useCallback(() => {
    const name = window.prompt('Name des Albums', album.name);
    if (name !== null) void onRename(name);
  }, [album.name, onRename]);

  const remove = useCallback(() => {
    if (window.confirm(`„${album.name}“ mit ${scans.length} Fotos wirklich löschen?`)) void onDeleteAlbum();
  }, [album.name, onDeleteAlbum, scans.length]);

  const move = useCallback(
    (from: number, to: number) => {
      const next = scans.slice();
      const [taken] = next.splice(from, 1);
      next.splice(to, 0, taken);
      void onReorder(next);
    },
    [onReorder, scans],
  );

  const run = useCallback(async (task: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await task();
    } finally {
      setBusy(false);
      setExporting(false);
    }
  }, []);

  // Nach Albumseiten gruppiert, in der Reihenfolge des Albums.
  const groups = useMemo(() => {
    const out: { page: Page | null; scans: Scan[] }[] = [];
    for (const scan of shown) {
      const page = scan.pageId ? (pageById.get(scan.pageId) ?? null) : null;
      const last = out[out.length - 1];
      if (last && (last.page?.id ?? null) === (page?.id ?? null)) last.scans.push(scan);
      else out.push({ page, scans: [scan] });
    }
    return out;
  }, [pageById, shown]);

  return (
    <div className="flex min-h-dvh flex-col bg-stone-950 text-stone-100">
      <TopBar
        title={album.name}
        left={
          <IconButton label="Zurück" onClick={onBack}>
            <BackIcon />
          </IconButton>
        }
        right={
          <IconButton label="Album umbenennen" onClick={rename}>
            <PencilIcon />
          </IconButton>
        }
      />

      {scans.length === 0 ? (
        <Empty
          title="Noch keine Fotos"
          hint="Leg das Album flach hin, sorge für gleichmässiges Licht und tippe auf „Scannen“."
          action={
            <Button variant="primary" onClick={onScan} className="mt-2">
              Scannen
            </Button>
          }
        />
      ) : (
        <div className="flex-1 overflow-y-auto px-3 pt-3 pb-44">
          <div className="mb-3 flex gap-2">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Suchen in Titel und Notizen"
              data-testid="search"
              className="min-w-0 flex-1 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm outline-none focus:border-amber-400/60"
            />
            <Button
              variant={ordering ? 'primary' : 'ghost'}
              onClick={() => setOrdering((value) => !value)}
              disabled={query.length > 0 || view === 'seiten'}
              className="shrink-0 px-3 text-xs"
              data-testid="order-toggle"
            >
              {ordering ? 'Fertig' : 'Ordnen'}
            </Button>
          </div>

          <div className="mb-3 flex items-center justify-between">
            <div className="flex gap-2 text-xs">
              <Tab active={view === 'fotos'} onClick={() => setView('fotos')} testId="tab-fotos">
                Fotos
              </Tab>
              <Tab
                active={view === 'seiten'}
                onClick={() => {
                  setOrdering(false);
                  setView('seiten');
                }}
                testId="tab-seiten"
              >
                Seiten
              </Tab>
            </div>
            <p className="text-xs text-stone-400" data-testid="count">
              {shown.length} von {scans.length} {scans.length === 1 ? 'Foto' : 'Fotos'}
            </p>
          </div>

          {ordering && (
            <p className="mb-3 rounded-lg bg-amber-400/10 px-3 py-2 text-xs text-amber-200">
              Foto auf den Platz ziehen, an den es gehört. Die Reihenfolge gilt fürs Album und fürs Buch.
            </p>
          )}

          {view === 'fotos' ? (
            <PhotoGrid
              scans={shown}
              urls={urls}
              ordering={ordering}
              onOpen={(scan) => setOpen(scan.id)}
              onMove={move}
            />
          ) : (
            <ul className="space-y-5">
              {groups.map((group, index) => (
                <li key={group.page?.id ?? `ohne-${index}`}>
                  <div className="mb-2 flex items-center gap-3">
                    {group.page ? (
                      <img
                        src={pageUrls.get(group.page.id)}
                        alt=""
                        className="h-14 w-20 rounded-md object-cover ring-1 ring-white/15"
                      />
                    ) : (
                      <div className="grid h-14 w-20 place-items-center rounded-md bg-white/5 text-[10px] text-stone-500">
                        ohne Seite
                      </div>
                    )}
                    <div>
                      <p className="text-sm">
                        {group.page ? `Albumseite ${seitenNummer(pages, group.page)}` : 'Einzelne Fotos'}
                      </p>
                      <p className="text-xs text-stone-400">
                        {group.scans.length} {group.scans.length === 1 ? 'Foto' : 'Fotos'}
                        {group.page ? ` · ${new Date(group.page.createdAt).toLocaleDateString('de-CH')}` : ''}
                      </p>
                    </div>
                  </div>
                  <PhotoGrid
                    scans={group.scans}
                    urls={urls}
                    ordering={false}
                    onOpen={(scan) => setOpen(scan.id)}
                    onMove={() => undefined}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="fixed inset-x-0 bottom-0 space-y-3 border-t border-white/10 bg-stone-950/95 px-4 pt-3 pb-6 backdrop-blur">
        <div className="mx-auto flex max-w-2xl gap-3">
          <Button variant="primary" onClick={onScan} className="flex-[2]" data-testid="scan">
            <CameraIcon /> Scannen
          </Button>
          <Button
            onClick={() => setExporting(true)}
            disabled={scans.length === 0 || busy}
            className="flex-1"
            data-testid="export-open"
          >
            {busy ? 'Einen Moment …' : 'Weitergeben'}
          </Button>
        </div>
        <button type="button" onClick={remove} className="mx-auto block text-xs text-stone-500 hover:text-red-300">
          Album löschen
        </button>
      </div>

      {exporting && (
        <div className="fixed inset-0 z-40 flex items-end bg-black/70" onClick={() => setExporting(false)}>
          <div
            className="w-full space-y-3 rounded-t-2xl border-t border-white/10 bg-stone-950 px-4 pt-4 pb-6"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className="text-sm font-medium">Weitergeben</h2>
            <div className="rounded-xl border border-white/10 px-4">
              <Switch
                label="Albumseiten mitdrucken"
                hint="Vor den Fotos einer Seite steht ihre Übersichtsaufnahme"
                checked={withPages}
                onChange={setWithPages}
              />
            </div>
            <Button
              variant="primary"
              className="w-full"
              data-testid="export-book"
              onClick={() => void run(() => exportBook(album, scans, pages, withPages))}
            >
              Als Fotobuch (PDF)
            </Button>
            <Button className="w-full" data-testid="export-zip" onClick={() => void run(() => exportAlbum(album, scans))}>
              Als einzelne Bilder (ZIP)
            </Button>
            <Button
              className="w-full"
              data-testid="remote-open"
              onClick={() => {
                setExporting(false);
                setRemoteOpen(true);
              }}
            >
              Auf GitHub sichern{album.remote ? ` (${album.remote.owner}/${album.remote.repo})` : ''}
            </Button>
            <Button className="w-full" onClick={() => setExporting(false)}>
              Abbrechen
            </Button>
          </div>
        </div>
      )}

      {remoteOpen && (
        <RemoteSheet
          album={album}
          scans={scans}
          pages={pages}
          onClose={() => setRemoteOpen(false)}
          onSaved={onRemote}
          onRestored={onRestored}
        />
      )}

      {openIndex >= 0 && (
        <PhotoViewer
          scans={shown}
          index={openIndex}
          urls={urls}
          pages={pageById}
          pageUrls={pageUrls}
          onIndex={(next) => setOpen(shown[next]?.id ?? null)}
          onClose={() => setOpen(null)}
          onSave={onSaveScan}
          onShare={(scan) => void shareOrDownload(scan.blob, scanFileName(album, scans.indexOf(scan)), album.name)}
          onDelete={(scan) => {
            setOpen(null);
            void onDeleteScan(scan);
          }}
        />
      )}
    </div>
  );
}

/** Die Nummer einer Seite, wie sie im Album gezählt wird. */
function seitenNummer(pages: Page[], page: Page): number {
  return pages.findIndex((entry) => entry.id === page.id) + 1;
}

function Tab({
  active,
  onClick,
  testId,
  children,
}: {
  active: boolean;
  onClick: () => void;
  testId: string;
  children: ReactNode;
}) {
  return (
    <Button
      variant={active ? 'primary' : 'ghost'}
      onClick={onClick}
      data-testid={testId}
      className="rounded-full px-3 py-1.5 text-xs"
    >
      {children}
    </Button>
  );
}

function CameraIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" strokeLinejoin="round" />
      <circle cx="12" cy="13.5" r="3.5" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M4 20h4l10-10-4-4L4 16v4z" strokeLinejoin="round" />
    </svg>
  );
}
