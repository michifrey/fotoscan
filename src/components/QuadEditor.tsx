import { useCallback, useId, useRef, useState } from 'react';
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
  /**
   * Ein Tipp auf freie Fläche. Damit holt der Nutzer ein Foto herein, das die
   * Erkennung übersehen hat – ohne diesen Weg bliebe es verloren, und
   * ausgerechnet die blassen, alten Abzüge sind die, die sie übersieht.
   */
  onAddAt?: (point: Pt) => void;
  /** Nummern in die Ecken schreiben – die gemeinsame Sprache der beiden Stufen. */
  numbered?: boolean;
  /**
   * Jeder Tipp irgendwo im Bild meldet seine Stelle. Damit werden die Ecken
   * *gesetzt* statt gezogen – vier Tipps, und das Viereck steht.
   *
   * Solange das an ist, geht nichts anderes: keine Ecken ziehen, keine Häkchen.
   * Das ist Absicht – ein halb gesetztes Viereck nebenbei zu verschieben
   * stiftet nur Verwirrung.
   */
  onTap?: (point: Pt) => void;
  /** Welche Ecke gerade gesetzt wird; sie wird hervorgehoben. */
  awaiting?: number;
  /**
   * Das Bild darunter, als Adresse.
   *
   * Damit bekommt das Ziehen einer Ecke eine **Lupe**: Der Finger verdeckt
   * genau die Stelle, auf die es ankommt, und die Kante eines Abzugs ist auf
   * einem Telefonbildschirm ein Haar breit. Ohne Bild keine Lupe – dann bleibt
   * alles wie bisher.
   */
  source?: string;
}

/** Vergrösserung der Lupe. */
const LOUPE_ZOOM = 3.5;

/** Ihr Durchmesser, als Anteil der kurzen Bildkante. */
const LOUPE_SIZE = 0.28;

const CORNER_LABELS = ['oben links', 'oben rechts', 'unten rechts', 'unten links'];

/**
 * Legt die erkannten Vierecke über das Bild. Das Häkchen in der Mitte nimmt ein
 * Foto aus der Auswahl heraus; ein Tipp daneben macht es zum aktiven Foto,
 * dessen vier Ecken sich ziehen lassen.
 */
export function QuadEditor({
  width,
  height,
  quads,
  selected,
  editing,
  onToggle,
  onActivate,
  onChange,
  onAddAt,
  numbered,
  onTap,
  awaiting,
  source,
}: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragging = useRef<{ quad: number; corner: number } | null>(null);
  /** Die Stelle, die die Lupe gerade zeigt – oder `null`, wenn keine sichtbar ist. */
  const [lens, setLens] = useState<Pt | null>(null);
  const tapping = useRef(false);

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
      setLens(point);
      onChange(drag.quad, quad.map((p, i) => (i === drag.corner ? point : p)) as Quad);
    },
    [onChange, quads, toImage],
  );

  const endDrag = useCallback((event: React.PointerEvent<SVGSVGElement>) => {
    if (!dragging.current) return;
    dragging.current = null;
    setLens(null);
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
      {/* Der Untergrund fängt Tipps neben den Vierecken auf. Er liegt zuunterst,
          damit ein Tipp auf ein Viereck weiterhin dieses meint. */}
      {onAddAt && !onTap && (
        <rect
          x={0}
          y={0}
          width={width}
          height={height}
          fill="transparent"
          data-testid="freie-flaeche"
          className="cursor-crosshair"
          onPointerDown={(event) => onAddAt(toImage(event.clientX, event.clientY))}
        />
      )}

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
                    setLens(corner);
                    event.currentTarget.ownerSVGElement?.setPointerCapture(event.pointerId);
                  }}
                />
              ))}

            {awaiting !== undefined && quad[awaiting] && (
              <circle
                cx={quad[awaiting].x}
                cy={quad[awaiting].y}
                r={handleRadius * 1.7}
                fill="none"
                stroke="#fbbf24"
                strokeWidth={handleRadius * 0.3}
                className="animate-pulse"
              />
            )}

            {numbered && (
              <text
                x={quad[0].x + (cx - quad[0].x) * 0.22}
                y={quad[0].y + (cy - quad[0].y) * 0.22}
                fill={isSelected ? '#fbbf24' : 'rgba(255,255,255,0.6)'}
                fontSize={badge * 1.5}
                fontWeight="600"
                dominantBaseline="hanging"
                data-testid={`nummer-${index}`}
                className="pointer-events-none select-none"
              >
                {index + 1}
              </text>
            )}

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

      {/* Zuoberst, damit jeder Tipp hier landet – auch über einem Viereck.
          Gesetzt wird beim *Loslassen*, nicht beim Aufsetzen: Dazwischen zeigt
          die Lupe, wo der Punkt landen würde, und er lässt sich noch schieben.
          Der Finger verdeckt sonst genau die Kante, die er treffen soll. */}
      {onTap && (
        <rect
          x={0}
          y={0}
          width={width}
          height={height}
          fill="transparent"
          data-testid="ecken-tippen"
          className="cursor-crosshair"
          onPointerDown={(event) => {
            tapping.current = true;
            setLens(toImage(event.clientX, event.clientY));
            // Auf dem Rechteck selbst festhalten, nicht auf der Zeichenfläche:
            // Sonst gehen die folgenden Ereignisse an diese, und das Loslassen
            // käme hier nie an.
            event.currentTarget.setPointerCapture?.(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (tapping.current) setLens(toImage(event.clientX, event.clientY));
          }}
          onPointerUp={(event) => {
            tapping.current = false;
            onTap(toImage(event.clientX, event.clientY));
            setLens(null);
          }}
          onPointerCancel={() => {
            tapping.current = false;
            setLens(null);
          }}
        />
      )}

      {lens && source && <Loupe point={lens} width={width} height={height} source={source} />}
    </svg>
  );
}

/**
 * Die Lupe: ein runder Ausschnitt, vergrössert, weit weg vom Finger.
 *
 * Sie sitzt oben und wechselt die Seite, sobald der Finger ihr zu nahe kommt –
 * eine Lupe, die man verdeckt, ist keine.
 */
function Loupe({ point, width, height, source }: { point: Pt; width: number; height: number; source: string }) {
  const radius = (Math.min(width, height) * LOUPE_SIZE) / 2;
  const margin = radius * 1.25;
  const cx = point.x < width / 2 ? width - margin : margin;
  const cy = margin;
  const id = useId();

  return (
    <g className="pointer-events-none" data-testid="lupe">
      <defs>
        <clipPath id={id}>
          <circle cx={cx} cy={cy} r={radius} />
        </clipPath>
      </defs>
      <circle cx={cx} cy={cy} r={radius} fill="#0c0a09" />
      {/* Der Zuschnitt sitzt auf der Gruppe, die Vergrösserung auf dem Bild
          darin: Beides am selben Element gedacht, und der Kreis läge im schon
          vergrösserten Raum – also an der falschen Stelle. */}
      <g clipPath={`url(#${id})`}>
        <image
          href={source}
          x={0}
          y={0}
          width={width}
          height={height}
          preserveAspectRatio="none"
          transform={`translate(${cx - point.x * LOUPE_ZOOM} ${cy - point.y * LOUPE_ZOOM}) scale(${LOUPE_ZOOM})`}
        />
      </g>
      {/* Fadenkreuz: Ohne es weiss niemand, welcher Punkt gemeint ist. */}
      <line x1={cx - radius * 0.5} y1={cy} x2={cx + radius * 0.5} y2={cy} stroke="#fbbf24" strokeWidth={radius * 0.035} />
      <line x1={cx} y1={cy - radius * 0.5} x2={cx} y2={cy + radius * 0.5} stroke="#fbbf24" strokeWidth={radius * 0.035} />
      <circle
        cx={cx}
        cy={cy}
        r={radius}
        fill="none"
        stroke="#fbbf24"
        strokeWidth={radius * 0.05}
      />
    </g>
  );
}
