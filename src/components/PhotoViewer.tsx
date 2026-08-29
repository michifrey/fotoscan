import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Page, Scan } from '../lib/storage';
import { BackIcon, Button, IconButton } from './ui';

interface Props {
  scans: Scan[];
  index: number;
  urls: Map<string, string>;
  pages: Map<string, Page>;
  pageUrls: Map<string, string>;
  onIndex: (index: number) => void;
  onClose: () => void;
  onSave: (scan: Scan) => Promise<void>;
  onDelete: (scan: Scan) => void;
  onShare: (scan: Scan) => void;
}

/** Ab dieser Wischstrecke wird umgeblättert, gemessen an der Bildbreite. */
const TURN = 0.22;
const MAX_ZOOM = 4;

/**
 * Das Album zum Durchsehen: ein Foto formatfüllend, wischen zum Blättern,
 * ziehen mit zwei Fingern zum Vergrössern.
 *
 * Der Betrachter zeigt immer drei Bilder nebeneinander – das vorige, das
 * aktuelle, das nächste. Nur so folgt das nächste Foto dem Finger schon
 * während der Bewegung, statt erst nach dem Loslassen zu erscheinen.
 */
export function PhotoViewer({
  scans,
  index,
  urls,
  pages,
  pageUrls,
  onIndex,
  onClose,
  onSave,
  onDelete,
  onShare,
}: Props) {
  const scan = scans[index];
  const [drag, setDrag] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [sheet, setSheet] = useState<'caption' | 'page' | null>(null);
  const [chrome, setChrome] = useState(true);

  // Die Handschrift der Seite, als Bild – für dieses Foto und seine Nachbarn.
  const writing = useMemo(() => {
    const map = new Map<string, string>();
    for (const entry of scans) if (entry.writing) map.set(entry.id, URL.createObjectURL(entry.writing));
    return map;
  }, [scans]);
  useEffect(() => () => writing.forEach((url) => URL.revokeObjectURL(url)), [writing]);

  const area = useRef<HTMLDivElement | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const start = useRef<{ x: number; y: number; distance: number; zoom: number; offset: { x: number; y: number } } | null>(
    null,
  );
  const moved = useRef(false);
  const lastTap = useRef(0);

  // Beim Wechsel des Fotos wieder auf Anfang: Vergrösserung und Ausschnitt
  // gehören zum Bild, nicht zum Betrachter.
  useEffect(() => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  }, [index]);

  const go = useCallback(
    (step: number) => {
      const next = index + step;
      if (next < 0 || next >= scans.length) return;
      onIndex(next);
    },
    [index, onIndex, scans.length],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'ArrowRight') go(1);
      else if (event.key === 'ArrowLeft') go(-1);
      else if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, onClose]);

  const width = area.current?.clientWidth ?? 1;

  const down = useCallback(
    (event: React.PointerEvent) => {
      if (sheet) return;
      (event.target as Element).setPointerCapture?.(event.pointerId);
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const points = [...pointers.current.values()];
      start.current = {
        x: event.clientX,
        y: event.clientY,
        distance: points.length === 2 ? Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) : 0,
        zoom,
        offset,
      };
      moved.current = false;
    },
    [offset, sheet, zoom],
  );

  const move = useCallback(
    (event: React.PointerEvent) => {
      if (!pointers.current.has(event.pointerId) || !start.current) return;
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const points = [...pointers.current.values()];

      if (points.length >= 2) {
        const distance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
        if (start.current.distance > 0) {
          const next = Math.min(MAX_ZOOM, Math.max(1, (start.current.zoom * distance) / start.current.distance));
          setZoom(next);
          moved.current = true;
        }
        return;
      }

      const dx = event.clientX - start.current.x;
      const dy = event.clientY - start.current.y;
      if (Math.abs(dx) > 6 || Math.abs(dy) > 6) moved.current = true;

      if (zoom > 1) {
        setOffset({ x: start.current.offset.x + dx, y: start.current.offset.y + dy });
      } else {
        setDrag(dx);
      }
    },
    [zoom],
  );

  const up = useCallback(
    (event: React.PointerEvent) => {
      pointers.current.delete(event.pointerId);
      if (pointers.current.size > 0) return;

      if (!moved.current) {
        // Zweimal tippen vergrössert, einmal blendet die Bedienung aus.
        const now = Date.now();
        if (now - lastTap.current < 300) {
          setZoom((current) => (current > 1 ? 1 : 2.5));
          setOffset({ x: 0, y: 0 });
          lastTap.current = 0;
        } else {
          lastTap.current = now;
          setChrome((visible) => !visible);
        }
      } else if (zoom <= 1) {
        if (drag < -width * TURN) go(1);
        else if (drag > width * TURN) go(-1);
      }

      setDrag(0);
      start.current = null;
      if (zoom <= 1) setOffset({ x: 0, y: 0 });
    },
    [drag, go, width, zoom],
  );

  if (!scan) return null;
  const page = scan.pageId ? pages.get(scan.pageId) : undefined;

  return (
    <div className="fixed inset-0 z-30 flex flex-col bg-black" data-testid="viewer">
      <div
        ref={area}
        className="relative flex-1 touch-none overflow-hidden"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
      >
        {[-1, 0, 1].map((step) => {
          const neighbour = scans[index + step];
          if (!neighbour) return null;
          const active = step === 0;
          return (
            <div
              key={neighbour.id}
              className="absolute inset-0 flex items-center justify-center p-2"
              style={{
                transform: `translateX(calc(${step * 100}% + ${drag}px)) ${
                  active ? `translate(${offset.x}px, ${offset.y}px) scale(${zoom})` : ''
                }`,
                transition: drag === 0 ? 'transform 180ms ease-out' : 'none',
              }}
            >
              <img
                src={urls.get(neighbour.id)}
                alt={neighbour.title || `Foto ${index + step + 1}`}
                draggable={false}
                className="max-h-full max-w-full object-contain select-none"
              />
            </div>
          );
        })}
      </div>

      {chrome && (
        <>
          <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between bg-gradient-to-b from-black/70 to-transparent p-3">
            <IconButton label="Schliessen" onClick={onClose} className="pointer-events-auto">
              <BackIcon />
            </IconButton>
            <span className="rounded-full bg-black/50 px-3 py-1.5 text-xs text-stone-200 backdrop-blur">
              {index + 1} von {scans.length}
            </span>
            <span className="w-10" />
          </div>

          <div className="absolute inset-x-0 bottom-0 space-y-3 bg-gradient-to-t from-black/90 to-transparent px-4 pt-8 pb-6">
            <div className="min-h-10 text-center">
              {writing.has(scan.id) && (
                <img
                  src={writing.get(scan.id)}
                  alt="Handschrift von der Albumseite"
                  data-testid="writing"
                  className="mx-auto mb-2 max-h-16 rounded bg-stone-100/90 px-1 py-0.5 object-contain"
                />
              )}
              {scan.title && <p className="text-sm font-medium text-stone-100">{scan.title}</p>}
              {scan.taken && <p className="text-xs text-stone-400">{scan.taken}</p>}
              {scan.note && <p className="mt-1 line-clamp-2 text-xs text-stone-400">{scan.note}</p>}
              {!scan.title && !scan.taken && !scan.note && !writing.has(scan.id) && (
                <p className="text-xs text-stone-500">Ohne Beschriftung</p>
              )}
            </div>

            <div className="mx-auto flex max-w-lg gap-2">
              <Button onClick={() => setSheet('caption')} className="flex-1 px-2 text-xs" data-testid="caption-open">
                Beschriften
              </Button>
              {page && (
                <Button onClick={() => setSheet('page')} className="flex-1 px-2 text-xs" data-testid="page-open">
                  Albumseite
                </Button>
              )}
              <Button onClick={() => onShare(scan)} className="flex-1 px-2 text-xs">
                Teilen
              </Button>
              <Button variant="danger" onClick={() => onDelete(scan)} className="flex-1 px-2 text-xs">
                Löschen
              </Button>
            </div>
          </div>
        </>
      )}

      {sheet === 'caption' && (
        <CaptionSheet
          scan={scan}
          writing={writing.get(scan.id)}
          onClose={() => setSheet(null)}
          onSave={onSave}
        />
      )}

      {sheet === 'page' && page && (
        <div className="absolute inset-0 z-40 flex flex-col bg-black/95">
          <div className="flex items-center justify-between p-3">
            <IconButton label="Zurück" onClick={() => setSheet(null)}>
              <BackIcon />
            </IconButton>
            <span className="text-xs text-stone-400">
              Albumseite vom {new Date(page.createdAt).toLocaleDateString('de-CH')}
            </span>
            <span className="w-10" />
          </div>
          <div className="flex flex-1 items-center justify-center p-3">
            <img src={pageUrls.get(page.id)} alt="Albumseite" className="max-h-full max-w-full object-contain" />
          </div>
          <p className="px-6 pb-8 text-center text-xs text-stone-500">
            So lag das Foto im Album. Die Übersichtsaufnahme bleibt beim Album, damit die Anordnung und
            das, was danebenstand, nicht verlorengehen.
          </p>
        </div>
      )}
    </div>
  );
}

/** Titel, Datum und Notiz zu einem Foto. */
function CaptionSheet({
  scan,
  writing,
  onClose,
  onSave,
}: {
  scan: Scan;
  writing?: string;
  onClose: () => void;
  onSave: (scan: Scan) => Promise<void>;
}) {
  const [title, setTitle] = useState(scan.title ?? '');
  const [taken, setTaken] = useState(scan.taken ?? '');
  const [note, setNote] = useState(scan.note ?? '');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await onSave({
        ...scan,
        title: title.trim() || undefined,
        taken: taken.trim() || undefined,
        note: note.trim() || undefined,
      });
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="absolute inset-0 z-40 flex items-end bg-black/70" onClick={onClose}>
      <div
        className="w-full space-y-3 rounded-t-2xl border-t border-white/10 bg-stone-950 px-4 pt-4 pb-6"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="text-sm font-medium">Beschriften</h2>
        {writing && (
          <div>
            <img
              src={writing}
              alt="Handschrift von der Albumseite"
              className="max-h-20 w-full rounded-lg bg-stone-100 object-contain py-1"
            />
            <p className="mt-1 text-[11px] text-stone-500">
              So stand es auf der Seite. Abgeschrieben wird von Hand – geraten wäre schlimmer als
              nichts.
            </p>
          </div>
        )}
        <Field label="Titel" value={title} onChange={setTitle} placeholder="Oma im Garten" testId="caption-title" />
        <Field
          label="Wann"
          value={taken}
          onChange={setTaken}
          placeholder="Sommer 1978"
          testId="caption-taken"
        />
        <label className="block">
          <span className="text-xs text-stone-400">Notiz</span>
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={3}
            data-testid="caption-note"
            className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm outline-none focus:border-amber-400/60"
          />
        </label>
        <div className="flex gap-3 pt-1">
          <Button onClick={onClose} className="flex-1">
            Abbrechen
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy} className="flex-1" data-testid="caption-save">
            Sichern
          </Button>
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
        data-testid={testId}
        className="mt-1 w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm outline-none focus:border-amber-400/60"
      />
    </label>
  );
}
