import type { Tilt } from '../lib/orientation';
import { Button } from './ui';

/** Die vier Haltungen, die abgefahren werden – als Raute um die Ausgangslage. */
export const TARGETS: { tilt: Tilt; label: string }[] = [
  { tilt: { x: 0, y: -1 }, label: 'nach oben' },
  { tilt: { x: 1, y: 0 }, label: 'nach rechts' },
  { tilt: { x: 0, y: 1 }, label: 'nach unten' },
  { tilt: { x: -1, y: 0 }, label: 'nach links' },
];

/** Wie nah der Ring am Punkt sein muss, damit ausgelöst wird. */
export const CAPTURE_RADIUS = 0.32;

export function distanceToTarget(tilt: Tilt, target: Tilt): number {
  return Math.hypot(tilt.x - target.x, tilt.y - target.y);
}

interface Props {
  tilt: Tilt;
  done: boolean[];
  /** Kommen bereits Werte vom Lagesensor? */
  receiving: boolean;
  /** Seitenverhältnis des Kamerabildes, damit die Punkte darauf liegen. */
  aspect: number;
  onCancel: () => void;
  onFinish: () => void;
}

/**
 * Die vier Punkte, die beim Entspiegeln abgefahren werden. Jeder Punkt ist eine
 * andere Blickrichtung auf dasselbe Foto – die Spiegelung liegt dadurch jedes
 * Mal woanders und lässt sich später herausrechnen.
 */
export function GuidedCapture({ tilt, done, receiving, aspect, onCancel, onFinish }: Props) {
  const remaining = done.filter((entry) => !entry).length;
  const next = done.findIndex((entry) => !entry);

  // Bildschirmposition in Prozent: Mitte plus Auslenkung mal Radius.
  const place = (point: Tilt) => ({
    left: `${50 + point.x * 34}%`,
    top: `${50 + point.y * 34}%`,
  });

  return (
    <div className="absolute inset-0 z-20 flex flex-col justify-between bg-stone-950/70 backdrop-blur-[2px]">
      <div className="px-6 pt-6 text-center">
        <p className="text-sm font-medium text-stone-100">
          {receiving ? 'Telefon zu den Punkten neigen' : 'Telefon langsam über das Foto bewegen'}
        </p>
        <p className="mt-1 text-xs text-stone-400">
          {receiving
            ? `Noch ${remaining} von ${done.length}${next >= 0 ? ` – jetzt ${TARGETS[next].label}` : ''}`
            : `Aufnahme ${done.filter(Boolean).length + 1} von ${done.length}`}
        </p>
      </div>

      <div className="relative flex-1" aria-hidden={!receiving}>
        {/* Der Punktekranz sitzt im Kamerabild, nicht im schwarzen Rand daneben. */}
        <div
          className="absolute top-1/2 left-1/2 w-full max-h-full -translate-x-1/2 -translate-y-1/2"
          style={{ aspectRatio: aspect }}
        >
          <div className="absolute top-1/2 left-1/2 aspect-square h-[76%] max-w-[76%] -translate-x-1/2 -translate-y-1/2">
            {TARGETS.map((target, index) => (
              <span
                key={target.label}
                data-testid={`ziel-${index}`}
                data-erledigt={done[index] ? 'ja' : 'nein'}
                style={place(target.tilt)}
                className={`absolute size-14 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 transition ${
                  done[index]
                    ? 'border-amber-400 bg-amber-400/90'
                    : index === next
                      ? 'animate-pulse border-amber-300 bg-amber-300/15'
                      : 'border-white/40 bg-white/5'
                }`}
              >
                {done[index] && (
                  <svg viewBox="0 0 24 24" className="size-full p-3 text-stone-950" fill="none" stroke="currentColor" strokeWidth="3">
                    <path d="M5 12.5l4.5 4.5L19 7" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </span>
            ))}

            {receiving && (
              <span
                data-testid="ring"
                style={place(tilt)}
                className="absolute size-16 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-white shadow-[0_0_0_9999px_rgba(0,0,0,0)]"
              />
            )}
          </div>
        </div>
      </div>

      <div className="flex justify-center gap-3 px-6 pb-8">
        <Button onClick={onCancel}>Abbrechen</Button>
        <Button variant="primary" onClick={onFinish} disabled={!done.some(Boolean)} data-testid="guided-finish">
          Fertig
        </Button>
      </div>
    </div>
  );
}
