import type { Tilt } from '../lib/orientation';
import type { Region } from '../lib/imaging/track';
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

/**
 * Wie gross der Punktekranz gegenüber dem Motiv gezeichnet wird. Etwas
 * kleiner als das Motiv selbst, damit die Punkte auf der Albumseite liegen
 * und nicht daneben auf dem Tisch.
 */
const RING_OF_SUBJECT = 0.78;

interface Props {
  tilt: Tilt;
  done: boolean[];
  /** Kommen bereits Werte vom Lagesensor? */
  receiving: boolean;
  /** Seitenverhältnis des Kamerabildes, damit die Punkte darauf liegen. */
  aspect: number;
  /** Wo das Motiv gerade im Kamerabild liegt – daran hängt der Punktekranz. */
  region: Region;
  /** Ist das Motiv gerade nicht auffindbar? Dann wird nicht ausgelöst. */
  lost: boolean;
  onCancel: () => void;
  onFinish: () => void;
}

/**
 * Die vier Punkte, die beim Entspiegeln abgefahren werden. Jeder Punkt ist eine
 * andere Blickrichtung auf dasselbe Foto – die Spiegelung liegt dadurch jedes
 * Mal woanders und lässt sich später herausrechnen.
 *
 * Der Punktekranz hängt am Motiv, nicht am Bildschirm: Er wird dorthin
 * gezeichnet, wo die Albumseite gerade wirklich liegt, und wandert mit ihr.
 * Verliert die Kamera das Album aus dem Blick, bleibt der Kranz blass und es
 * wird nichts aufgenommen – sonst entstünden vier Aufnahmen vom Tisch.
 */
export function GuidedCapture({ tilt, done, receiving, aspect, region, lost, onCancel, onFinish }: Props) {
  const remaining = done.filter((entry) => !entry).length;
  const next = done.findIndex((entry) => !entry);

  // Der Kranz ist rund, sein Halbmesser also in beiden Richtungen derselbe –
  // gemessen an der Breite des Kamerabildes.
  const radius = Math.min(0.42, Math.max(0.17, Math.max(region.hx, region.hy / aspect) * RING_OF_SUBJECT));

  // Lage eines Punktes im Kamerabild, in Prozent seiner Kanten. Die Auslenkung
  // ist waagrecht und senkrecht gleich gross, damit die Raute rund bleibt.
  const place = (point: Tilt) => ({
    left: `${(region.cx + point.x * radius) * 100}%`,
    top: `${(region.cy + point.y * radius * aspect) * 100}%`,
  });

  return (
    <div className="absolute inset-0 z-20 bg-stone-950/45">
      <div className="absolute inset-x-0 top-0 px-6 pt-6 text-center">
        <p className="text-sm font-medium text-stone-100">
          {lost
            ? 'Album wieder ins Bild nehmen'
            : receiving
              ? 'Telefon zu den Punkten neigen'
              : 'Telefon langsam über das Foto bewegen'}
        </p>
        <p className="mt-1 text-xs text-stone-400" data-testid="guided-hint">
          {lost
            ? 'Solange das Album nicht im Bild ist, wird nicht ausgelöst.'
            : receiving
              ? `Noch ${remaining} von ${done.length}${next >= 0 ? ` – jetzt ${TARGETS[next].label}` : ''}`
              : `Aufnahme ${done.filter(Boolean).length + 1} von ${done.length}`}
        </p>
      </div>

      {/* Deckt sich mit dem Kamerabild darunter, damit die Punkte wirklich auf
          dem Album liegen und nicht irgendwo daneben. */}
      <div className="absolute inset-0 flex items-center justify-center" aria-hidden={!receiving}>
        <div
          className={`relative w-full transition-opacity ${lost ? 'opacity-35' : 'opacity-100'}`}
          style={{ aspectRatio: aspect }}
          data-testid="motiv"
          data-verloren={lost ? 'ja' : 'nein'}
        >
          {TARGETS.map((target, index) => (
            <span
              key={target.label}
              data-testid={`ziel-${index}`}
              data-erledigt={done[index] ? 'ja' : 'nein'}
              style={place(target.tilt)}
              className={`absolute size-14 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 transition ${
                done[index]
                  ? 'border-amber-400 bg-amber-400/90'
                  : !lost && index === next
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
              className={`absolute size-16 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] ${
                lost ? 'border-white/40' : 'border-white'
              }`}
            />
          )}
        </div>
      </div>

      <div className="absolute inset-x-0 bottom-0 flex justify-center gap-3 px-6 pb-8">
        <Button onClick={onCancel}>Abbrechen</Button>
        {/* Immer benutzbar: Findet die App das Album partout nicht wieder,
            bleibt so wenigstens die Grundaufnahme – statt einer Sackgasse. */}
        <Button variant="primary" onClick={onFinish} data-testid="guided-finish">
          {done.some(Boolean) ? 'Fertig' : 'Nur diese Aufnahme'}
        </Button>
      </div>
    </div>
  );
}
