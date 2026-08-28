import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Album, Scan } from '../lib/storage';
import { exportAlbum, scanFileName, shareOrDownload } from '../lib/export';
import { BackIcon, Button, Empty, IconButton, TopBar } from './ui';

interface Props {
  album: Album;
  scans: Scan[];
  onBack: () => void;
  onScan: () => void;
  onDeleteScan: (scan: Scan) => Promise<void>;
  onRename: (name: string) => Promise<void>;
  onDeleteAlbum: () => Promise<void>;
}

export function AlbumScreen({ album, scans, onBack, onScan, onDeleteScan, onRename, onDeleteAlbum }: Props) {
  const [open, setOpen] = useState<Scan | null>(null);
  const [busy, setBusy] = useState(false);

  const urls = useMemo(() => new Map(scans.map((scan) => [scan.id, URL.createObjectURL(scan.blob)])), [scans]);
  useEffect(() => () => urls.forEach((url) => URL.revokeObjectURL(url)), [urls]);

  const rename = useCallback(() => {
    const name = window.prompt('Name des Albums', album.name);
    if (name !== null) void onRename(name);
  }, [album.name, onRename]);

  const remove = useCallback(() => {
    if (window.confirm(`„${album.name}“ mit ${scans.length} Fotos wirklich löschen?`)) void onDeleteAlbum();
  }, [album.name, onDeleteAlbum, scans.length]);

  const exportAll = useCallback(async () => {
    setBusy(true);
    try {
      await exportAlbum(album, scans);
    } finally {
      setBusy(false);
    }
  }, [album, scans]);

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
          <p className="px-1 pb-3 text-xs text-stone-400">
            {scans.length} {scans.length === 1 ? 'Foto' : 'Fotos'}
          </p>
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
            {scans.map((scan, index) => (
              <li key={scan.id}>
                <button
                  type="button"
                  onClick={() => setOpen(scan)}
                  className="block w-full overflow-hidden rounded-lg bg-white/5"
                  aria-label={`Foto ${index + 1} öffnen`}
                >
                  <img
                    src={urls.get(scan.id)}
                    alt={`Foto ${index + 1}`}
                    loading="lazy"
                    className="aspect-square w-full object-cover"
                  />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="fixed inset-x-0 bottom-0 space-y-3 border-t border-white/10 bg-stone-950/95 px-4 pt-3 pb-6 backdrop-blur">
        <div className="mx-auto flex max-w-2xl gap-3">
          <Button variant="primary" onClick={onScan} className="flex-[2]" data-testid="scan">
            <CameraIcon /> Scannen
          </Button>
          <Button onClick={() => void exportAll()} disabled={scans.length === 0 || busy} className="flex-1">
            Exportieren
          </Button>
        </div>
        <button
          type="button"
          onClick={remove}
          className="mx-auto block text-xs text-stone-500 hover:text-red-300"
        >
          Album löschen
        </button>
      </div>

      {open && (
        <div className="fixed inset-0 z-30 flex flex-col bg-black/95">
          <TopBar
            title={`Foto ${scans.indexOf(open) + 1} von ${scans.length}`}
            left={
              <IconButton label="Schliessen" onClick={() => setOpen(null)}>
                <BackIcon />
              </IconButton>
            }
          />
          <div className="flex flex-1 items-center justify-center p-4">
            <img src={urls.get(open.id)} alt="" className="max-h-full max-w-full object-contain" />
          </div>
          <div className="flex gap-3 px-4 pt-3 pb-6">
            <Button
              className="flex-1"
              onClick={() =>
                void shareOrDownload(open.blob, scanFileName(album, scans.indexOf(open)), album.name)
              }
            >
              Teilen
            </Button>
            <Button
              variant="danger"
              className="flex-1"
              onClick={() => {
                const scan = open;
                setOpen(null);
                void onDeleteScan(scan);
              }}
            >
              Löschen
            </Button>
          </div>
        </div>
      )}
    </div>
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
