import { centreOf } from '../lib/coverage';
import type { Cell, Coverage } from '../lib/coverage';
import type { Pt, Quad } from '../lib/imaging/types';

/**
 * Die Karte des Blattes.
 *
 * Sie beantwortet die einzige Frage, die beim Abfahren zählt: *wo muss ich noch
 * hin?* Die Übersichtsaufnahme liegt darunter, damit die Antwort im Bild steht
 * und nicht in einem Raster ohne Bezug – man erkennt seine eigene Albumseite
 * wieder und weiss sofort, welches Foto gemeint ist.
 *
 * Gezeichnet wird in Koordinaten der Übersicht, nicht des Bildschirms. Das
 * Raster, der laufende Ausschnitt und der Hinweis liegen dadurch alle im selben
 * Bezugsrahmen wie die Lage, die `pose.ts` mitführt – umgerechnet wird nur
 * einmal, vom SVG selbst.
 *
 * Helle Felder sind offen, dunkle erledigt. Das ist herum, wie es sein muss:
 * Der Blick soll an dem hängenbleiben, was noch fehlt, nicht an dem, was
 * schon getan ist.
 */

interface Props {
  /** Die Übersichtsaufnahme als Bild. */
  url: string;
  coverage: Coverage;
  /** Ob ein Feld fertig ist – die Regel steht in `coverage.ts`. */
  settled: (cell: Cell) => boolean;
  /** Was die Kamera gerade sieht, in Koordinaten der Übersicht. */
  viewport: Quad | null;
  /** Wohin als Nächstes, falls noch etwas fehlt. */
  gap: Pt | null;
}

export function CoverageMap({ url, coverage, settled, viewport, gap }: Props) {
  const { cols, rows, width, height } = coverage;
  const cellWidth = width / cols;
  const cellHeight = height / rows;

  return (
    <div
      className="relative h-24 shrink-0 overflow-hidden rounded-lg border border-white/15 bg-stone-900"
      style={{ aspectRatio: width / height }}
      data-testid="karte"
    >
      <img src={url} alt="Übersicht der Seite" className="size-full object-cover opacity-70" />

      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="pointer-events-none absolute inset-0 size-full"
        aria-hidden="true"
      >
        {coverage.cells.map((cell, index) => {
          if (!cell.needed) return null;
          const done = settled(cell);
          const centre = centreOf(coverage, index);
          return (
            <rect
              key={index}
              data-testid={`feld-${index}`}
              data-erledigt={done ? 'ja' : 'nein'}
              x={centre.x - cellWidth / 2}
              y={centre.y - cellHeight / 2}
              width={cellWidth}
              height={cellHeight}
              fill={done ? '#0c0a09' : '#fbbf24'}
              fillOpacity={done ? 0.45 : 0.5}
            />
          );
        })}

        {gap && (
          // Der Hinweis: die Mitte dessen, was noch offen ist. Mehr wäre eine
          // Anmassung – welchen Weg jemand über die Seite nimmt, ist seine Sache.
          <circle
            cx={gap.x}
            cy={gap.y}
            r={Math.min(width, height) * 0.05}
            fill="none"
            stroke="#fde68a"
            strokeWidth={Math.min(width, height) * 0.012}
            className="animate-pulse"
            data-testid="karte-hinweis"
          />
        )}

        {viewport && (
          <polygon
            data-testid="karte-ausschnitt"
            points={viewport.map((p) => `${p.x},${p.y}`).join(' ')}
            fill="rgba(255,255,255,0.12)"
            stroke="#ffffff"
            strokeWidth={Math.min(width, height) * 0.01}
          />
        )}
      </svg>
    </div>
  );
}
