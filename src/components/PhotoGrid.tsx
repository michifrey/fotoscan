import { useCallback, useRef, useState } from 'react';
import type { Scan } from '../lib/storage';

interface Props {
  scans: Scan[];
  urls: Map<string, string>;
  /** Im Ordnen-Modus lassen sich die Fotos an eine andere Stelle ziehen. */
  ordering: boolean;
  onOpen: (scan: Scan) => void;
  onMove: (from: number, to: number) => void;
}

/** Ab dieser Strecke gilt es als Ziehen und nicht mehr als Antippen. */
const THRESHOLD = 8;

/**
 * Das Raster der Fotos, im Ordnen-Modus mit Ziehen.
 *
 * Die Stelle, an der ein Foto landet, ergibt sich aus den Kacheln unter dem
 * Finger – gemessen einmal beim Aufsetzen. Während des Ziehens verschiebt sich
 * nichts im Raster, sonst wanderte das Ziel unter dem Finger davon.
 */
export function PhotoGrid({ scans, urls, ordering, onOpen, onMove }: Props) {
  const [dragging, setDragging] = useState<number | null>(null);
  const [target, setTarget] = useState<number | null>(null);
  const [shift, setShift] = useState({ x: 0, y: 0 });

  const list = useRef<HTMLUListElement | null>(null);
  const boxes = useRef<DOMRect[]>([]);
  const start = useRef<{ x: number; y: number; index: number } | null>(null);

  const down = useCallback(
    (event: React.PointerEvent, index: number) => {
      if (!ordering) return;
      (event.target as Element).setPointerCapture?.(event.pointerId);
      start.current = { x: event.clientX, y: event.clientY, index };
      boxes.current = [...(list.current?.children ?? [])].map((child) => child.getBoundingClientRect());
    },
    [ordering],
  );

  const move = useCallback((event: React.PointerEvent) => {
    if (!start.current) return;
    const dx = event.clientX - start.current.x;
    const dy = event.clientY - start.current.y;
    if (dragging === null && Math.hypot(dx, dy) < THRESHOLD) return;

    setDragging(start.current.index);
    setShift({ x: dx, y: dy });
    const over = boxes.current.findIndex(
      (box) =>
        event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom,
    );
    setTarget(over);
  }, [dragging]);

  const up = useCallback(
    (index: number) => {
      // Ohne Ordnen-Modus übernimmt der Klick das Öffnen; hier gibt es nichts
      // zu tun, sonst öffnete sich das Foto zweimal.
      if (!ordering) return;
      const from = start.current?.index ?? index;
      start.current = null;
      if (dragging !== null && target !== null && target >= 0 && target !== from) {
        onMove(from, target);
      }
      setDragging(null);
      setTarget(null);
      setShift({ x: 0, y: 0 });
    },
    [dragging, onMove, ordering, target],
  );

  return (
    <ul
      ref={list}
      className={`grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 ${ordering ? 'touch-none' : ''}`}
    >
      {scans.map((scan, index) => (
        <li key={scan.id} className="relative">
          <button
            type="button"
            onPointerDown={(event) => down(event, index)}
            onPointerMove={move}
            onPointerUp={() => up(index)}
            onPointerCancel={() => {
              start.current = null;
              setDragging(null);
              setTarget(null);
            }}
            onClick={() => {
              if (!ordering) onOpen(scan);
            }}
            className={`block w-full overflow-hidden rounded-lg bg-white/5 transition ${
              target === index && dragging !== null && dragging !== index ? 'ring-2 ring-amber-400' : ''
            }`}
            style={
              dragging === index
                ? { transform: `translate(${shift.x}px, ${shift.y}px) scale(1.05)`, zIndex: 20, position: 'relative', opacity: 0.9 }
                : undefined
            }
            aria-label={scan.title ? `${scan.title} öffnen` : `Foto ${index + 1} öffnen`}
            data-testid={`photo-${index}`}
          >
            <img
              src={urls.get(scan.id)}
              alt={scan.title ?? `Foto ${index + 1}`}
              loading="lazy"
              draggable={false}
              className="aspect-square w-full object-cover"
            />
            {(scan.title || scan.taken) && !ordering && (
              <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/80 to-transparent px-2 pt-4 pb-1 text-left text-[11px] text-stone-200">
                {scan.title || scan.taken}
              </span>
            )}
          </button>
          {ordering && (
            <span className="pointer-events-none absolute top-1 left-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-stone-300">
              {index + 1}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
