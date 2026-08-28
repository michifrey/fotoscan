import { useCallback, useRef } from 'react';
import { dist } from '../lib/imaging/geometry';
import type { Pt, Quad } from '../lib/imaging/types';

interface Props {
  width: number;
  height: number;
  quads: Quad[];
  selected: number[];
  editing: number | null;
  /** Foto in die Auswahl aufnehmen oder herausnehmen. */
  onToggle?: (index: number) => void;
  /** Foto zum Bearbeiten der Ecken aktiv setzen. */
  onActivate?: (index: number) => void;
  onChange?: (index: number, quad: Quad) => void;
}

const CORNER_LABELS = ['oben links', 'oben rechts', 'unten rechts', 'unten links'];

/**
 * Legt die erkannten Vierecke über das Bild. Das Häkchen in der Mitte nimmt ein
 * Foto aus der Auswahl heraus; ein Tipp daneben macht es zum aktiven Foto,
 * dessen vier Ecken sich ziehen lassen.
 */
export function QuadEditor({ width, height, quads, selected, editing, onToggle, onActivate, onChange }: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragging = useRef<{ quad: number; corner: number } | null>(null);

  const toImage = useCallback(
    (clientX: number, clientY: number): Pt => {
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return { x: 0, y: 0 };
      return {
        x: Math.max(0, Math.min(width, ((clientX - rect.left) / rect.width) * width)),
        y: Math.max(0, Math.min(height, ((clientY - rect.top) / rect.height) * height)),
      };
    },
    [width, height],
  );

  const handleMove = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      const drag = dragging.current;
      if (!drag || !onChange) return;
      const quad = quads[drag.quad];
      if (!quad) return;
      const point = toImage(event.clientX, event.clientY);
      onChange(drag.quad, quad.map((p, i) => (i === drag.corner ? point : p)) as Quad);
    },
    [onChange, quads, toImage],
  );

  const endDrag = useCallback((event: React.PointerEvent<SVGSVGElement>) => {
    if (!dragging.current) return;
    dragging.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }, []);

  // Griffgrösse in Bildkoordinaten, damit sie auf dem Bildschirm gleich gross wirkt.
  const handleRadius = Math.max(width, height) * 0.022;

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${width} ${height}`}
      className="absolute inset-0 size-full touch-none"
      onPointerMove={handleMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {quads.map((quad, index) => {
        const isSelected = selected.includes(index);
        const isEditing = editing === index;
        const cx = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4;
        const cy = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4;
        const badge = Math.min(
          handleRadius * 1.6,
          Math.min(dist(quad[0], quad[1]), dist(quad[1], quad[2])) * 0.22,
        );

        return (
          <g key={index}>
            <polygon
              points={quad.map((p) => `${p.x},${p.y}`).join(' ')}
              fill={isSelected ? 'rgba(251,191,36,0.14)' : 'rgba(0,0,0,0.5)'}
              stroke={isSelected ? '#fbbf24' : 'rgba(255,255,255,0.45)'}
              strokeWidth={Math.max(width, height) * (isEditing ? 0.006 : 0.004)}
              strokeDasharray={isSelected ? undefined : `${Math.max(width, height) * 0.015}`}
              onPointerDown={() => onActivate?.(index)}
              className={onActivate ? 'cursor-pointer' : undefined}
            />

            {isEditing &&
              onChange &&
              quad.map((corner, cornerIndex) => (
                <circle
                  key={cornerIndex}
                  cx={corner.x}
                  cy={corner.y}
                  r={handleRadius}
                  fill="#fbbf24"
                  stroke="#1c1917"
                  strokeWidth={handleRadius * 0.22}
                  role="button"
                  aria-label={`Ecke ${CORNER_LABELS[cornerIndex]}`}
                  className="cursor-grab"
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    dragging.current = { quad: index, corner: cornerIndex };
                    event.currentTarget.ownerSVGElement?.setPointerCapture(event.pointerId);
                  }}
                />
              ))}

            {onToggle && (
              <g
                role="checkbox"
                aria-checked={isSelected}
                aria-label={`Foto ${index + 1} ${isSelected ? 'abwählen' : 'auswählen'}`}
                data-testid={`toggle-${index}`}
                className="cursor-pointer"
                onPointerDown={(event) => {
                  event.stopPropagation();
                  onToggle(index);
                }}
              >
                <circle
                  cx={cx}
                  cy={cy}
                  r={badge}
                  fill={isSelected ? '#fbbf24' : 'rgba(12,10,9,0.8)'}
                  stroke={isSelected ? '#1c1917' : 'rgba(255,255,255,0.7)'}
                  strokeWidth={badge * 0.12}
                />
                <path
                  d={
                    isSelected
                      ? `M ${cx - badge * 0.42} ${cy} L ${cx - badge * 0.1} ${cy + badge * 0.34} L ${cx + badge * 0.45} ${cy - badge * 0.34}`
                      : `M ${cx - badge * 0.35} ${cy - badge * 0.35} L ${cx + badge * 0.35} ${cy + badge * 0.35} M ${cx + badge * 0.35} ${cy - badge * 0.35} L ${cx - badge * 0.35} ${cy + badge * 0.35}`
                  }
                  fill="none"
                  stroke={isSelected ? '#1c1917' : 'rgba(255,255,255,0.8)'}
                  strokeWidth={badge * 0.2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </g>
            )}
          </g>
        );
      })}
    </svg>
  );
}
