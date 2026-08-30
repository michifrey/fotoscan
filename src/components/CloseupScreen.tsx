import { useCallback, useEffect, useRef, useState } from 'react';
import { useCamera } from '../lib/camera';
import { preferred, rememberCamera, rememberedCamera } from '../lib/lenses';
import { blobFromImageData } from '../lib/canvas';
import { detectCloseupAsync, locateAsync } from '../lib/pipeline';
import { glareFrom } from '../lib/imaging/closeup';
import { exposureOf, tooDark } from '../lib/imaging/exposure';
import { framingText } from '../lib/framing';
import { useAutoLight } from '../lib/light';
import { polygonArea } from '../lib/imaging/geometry';
import type { Quad, RgbaImage } from '../lib/imaging/types';
import { BackIcon, Button, IconButton } from './ui';
import { QuadEditor } from './QuadEditor';
import { CameraSettings, GearIcon } from './CameraSettings';
import { isStable } from './CaptureScreen';

/** Eine Nahaufnahme, wie sie zur Weiterverarbeitung aufbewahrt wird. */
export interface CloseupShot {
  blob: Blob;
  width: number;
  height: number;
  quad: Quad;
  /**
   * Der gemessene Glanz dieser Aufnahme – klein, in den Koordinaten des
   * entzerrten Abzugs. Fehlt, wenn keine weitere Aufnahme dazu kam.
   */
  glare?: RgbaImage;
}

/** Ein Foto der Seitenaufnahme, das nachfotografiert werden soll. */
export interface CloseupTarget {
  /** Stelle in der Liste der erkannten Fotos – zugleich seine Nummer. */
  index: number;
  /** Kleine Vorschau, damit klar ist, welches Foto gemeint ist. */
  url: string;
  /**
   * Dasselbe Foto, wie es aus der Seitenaufnahme geschnitten wurde. Damit wird
   * es im Nahbild wiedergefunden – verlässlicher, als das grösste erkannte
   * Viereck dafür zu halten.
   */
  reference: RgbaImage;
}

/**
 * Eine gemachte Aufnahme, deren Zuschnitt noch bestätigt werden will – der
 * Fall, in dem die Seitenaufnahme ihr Foto nicht wiedererkannt hat.
 */
interface Pending {
  index: number;
  blob: Blob;
  url: string;
  width: number;
  height: number;
  quad: Quad;
}

/**
 * Die Albumseite als Landkarte: das geradegerückte Bild und die Vierecke der
 * gewählten Fotos darauf, in seinen Koordinaten.
 *
 * Ohne sie ist diese Stufe eine Liste ohne Ort. Der Nutzer weiss zwar, dass er
 * „Foto 3 von 5" aufnehmen soll, aber nicht *welches* auf der Seite vor ihm –
 * und schon gar nicht, welche er schon hat. Mit ihr ist beides ein Blick.
 */
export interface CloseupOverview {
  url: string;
  width: number;
  height: number;
  /** In derselben Reihenfolge wie `targets`. */
  quads: Quad[];
}

interface Props {
  targets: CloseupTarget[];
  overview: CloseupOverview;
  existing: Map<number, CloseupShot>;
  onDone: (shots: Map<number, CloseupShot>) => void;
  onCancel: () => void;
}

/** Auflösung der Nahaufnahme – eine je Foto, da darf sie gross sein. */
const CLOSE_MAX = 3200;
const PREVIEW_MAX = 480;
/** So viel des Bildes muss das Foto füllen, damit die Aufnahme etwas bringt. */
const FILL_MIN = 0.3;
/** So oft muss die Erkennung ruhig stehen, bevor automatisch ausgelöst wird. */
const STABLE_TICKS = 3;

/**
 * So viele weitere Aufnahmen für die Glanzmessung – und wie gross sie sein
 * dürfen.
 *
 * Eine Spiegelung fügt Licht hinzu, sie zieht nie welches ab; über mehrere
 * Aufnahmen aus leicht verschiedenen Winkeln ist der dunkelste Wert je
 * Bildpunkt der ungespiegelte. Dafür genügt schon das Zittern der Hand.
 *
 * Klein bleiben sie, weil ein Glanzfleck grossflächig und weich ist: Gemessen
 * war die Korrektur aus 270 Punkten so gut wie die aus voller Auflösung (1,7
 * gegen 1,0 bei einer rohen Abweichung von 18,8), kostet aber ein Sechzehntel
 * des Speichers. Und Speicher ist genau das, woran diese Stufe am echten Album
 * schon einmal gestorben ist.
 */
const EXTRA_SHOTS = 2;
const EXTRA_MAX = 1400;
const EXTRA_GAP = 220;

/**
 * Die dritte Runde: jedes Foto einzeln aus der Nähe.
 *
 * Auf der Seitenaufnahme teilen sich alle Fotos einer Albumseite die Bildpunkte
 * der Kamera; für das einzelne Foto bleibt ein Bruchteil. Wer näher herangeht,
 * bekommt ein Vielfaches – und die Spiegelung, die sich dabei unweigerlich
 * einstellt, rechnet die Seitenaufnahme wieder heraus.
 */
export function CloseupScreen({ targets, overview, existing, onDone, onCancel }: Props) {
  const [deviceId, setDeviceId] = useState<string | null>(() => rememberedCamera());
  const camera = useCamera(true, deviceId);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [position, setPosition] = useState(0);
  const [shots, setShots] = useState<Map<number, CloseupShot>>(() => new Map(existing));
  /**
   * Wer übersprungen wird, soll nicht gleich wieder drankommen – aber über die
   * Übersicht wieder erreichbar bleiben.
   */
  const [skipped, setSkipped] = useState<Set<number>>(() => new Set());
  const [quads, setQuads] = useState<Quad[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [auto, setAuto] = useState(true);
  const [aspect, setAspect] = useState(3 / 4);
  /** Eine gemachte Aufnahme, deren Zuschnitt noch bestätigt werden will. */
  const [pending, setPending] = useState<Pending | null>(null);

  const busy = useRef(false);
  const capturing = useRef(false);
  const stableCount = useRef(0);
  const previewSize = useRef({ width: 4, height: 3 });
  const chosen = useRef(false);
  const pendingRef = useRef(false);
  pendingRef.current = pending !== null;
  const fellBack = useRef(false);
  const autoRef = useRef(auto);
  autoRef.current = auto && !settingsOpen;

  // Hier darf das Licht immer zugeschaltet werden: Was es an Glanz auf den
  // Abzug wirft, nimmt die Seitenaufnahme hinterher wieder heraus – genau
  // dafür ist sie da.
  const { light, measure, takeOver } = useAutoLight(camera, true);
  const [dark, setDark] = useState(false);

  const target = targets[position];
  const targetRef = useRef(target);
  targetRef.current = target;

  useEffect(() => {
    if (chosen.current || deviceId !== null || camera.cameras.length === 0) return;
    chosen.current = true;
    const best = preferred(camera.cameras);
    if (best && best.deviceId !== camera.activeId) setDeviceId(best.deviceId);
  }, [camera.cameras, camera.activeId, deviceId]);

  useEffect(() => {
    if (!camera.error || deviceId === null || fellBack.current) return;
    fellBack.current = true;
    setDeviceId(null);
  }, [camera.error, deviceId]);

  /**
   * Weiter zum nächsten **offenen** Foto – nicht stur zum nächsten in der
   * Reihe. Sonst käme ein übersprungenes sofort wieder, und ein schon
   * aufgenommenes stünde noch einmal an.
   */
  const advance = useCallback(
    (justDone?: number, justSkipped?: number) => {
      setQuads([]);
      stableCount.current = 0;
      setPosition((current) => {
        for (let step = 1; step <= targets.length; step++) {
          const next = (current + step) % targets.length;
          const index = targets[next].index;
          if (index === justDone || index === justSkipped) continue;
          if (!shots.has(index) && !skipped.has(index)) return next;
        }
        // Nichts mehr offen: Das Ende ist erreicht, und der Effekt unten
        // schliesst die Runde ab.
        return targets.length;
      });
    },
    [shots, skipped, targets],
  );

  /** Die Aufnahme behalten und zum nächsten Foto. */
  const keep = useCallback(
    (index: number, shot: CloseupShot) => {
      setShots((current) => {
        const next = new Map(current);
        next.set(index, shot);
        return next;
      });
      advance(index);
    },
    [advance],
  );

  /** Dieses Foto auslassen – bis der Nutzer es in der Übersicht wieder wählt. */
  const skip = useCallback(() => {
    if (!target) return;
    const index = target.index;
    setSkipped((current) => new Set(current).add(index));
    advance(undefined, index);
  }, [advance, target]);

  /** In der Übersicht ein Foto auswählen. */
  const jumpTo = useCallback(
    (at: number) => {
      setSkipped((current) => {
        if (!current.has(targets[at].index)) return current;
        const next = new Set(current);
        next.delete(targets[at].index);
        return next;
      });
      setQuads([]);
      stableCount.current = 0;
      setPosition(at);
    },
    [targets],
  );

  /**
   * Die Nachfrage schliessen – mit oder ohne die Aufnahme.
   *
   * Aufgeräumt wird hier und nicht in einem Zustands-Aktualisierer: Der läuft
   * unter `StrictMode` zweimal, und zweimal weiterschalten hiesse, ein Foto zu
   * überspringen.
   */
  const closePending = useCallback(
    (take: boolean) => {
      if (!pending) return;
      URL.revokeObjectURL(pending.url);
      setPending(null);
      if (take) {
        keep(pending.index, {
          blob: pending.blob,
          width: pending.width,
          height: pending.height,
          quad: pending.quad,
        });
      }
    },
    [keep, pending],
  );

  /**
   * Den Glanz der eben gemachten Aufnahme messen – über weitere, kleine
   * Aufnahmen derselben Fläche.
   */
  const measureGlare = useCallback(
    async (reference: RgbaImage, base: { image: RgbaImage; quad: Quad }): Promise<RgbaImage | undefined> => {
      const others: { image: RgbaImage; quad: Quad }[] = [];
      for (let i = 0; i < EXTRA_SHOTS; i++) {
        await new Promise((resolve) => window.setTimeout(resolve, EXTRA_GAP));
        const extra = camera.capture(EXTRA_MAX);
        if (!extra) break;
        const quad = await locateAsync(reference, extra);
        if (quad) others.push({ image: extra, quad });
      }
      return glareFrom(base, others) ?? undefined;
    },
    [camera],
  );

  const takeShot = useCallback(async () => {
    if (capturing.current || !target || pendingRef.current) return;
    capturing.current = true;
    stableCount.current = 0;
    setStatus('Foto wird gesucht …');
    try {
      const frame = camera.capture(CLOSE_MAX);
      // Kein Bild – die Kamera läuft noch nicht. Auch das wird gesagt, statt
      // den Druck auf den Auslöser verpuffen zu lassen.
      if (!frame) {
        setStatus('Kamera ist noch nicht bereit');
        window.setTimeout(() => setStatus(null), 1500);
        return;
      }

      // Zuerst über die Seitenaufnahme: Sie zeigt dieses Foto bereits und weiss
      // damit, wie es aussieht. Trifft sie, steht der Zuschnitt auf wenige
      // Punkte genau und passt zur Vorlage – genau das braucht das spätere
      // Entspiegeln, das beide Aufnahmen übereinanderlegt.
      let quad = await locateAsync(target.reference, frame);
      const sure = quad !== null;
      // Sonst über das Papier ringsum. Das ist die zweitbeste Antwort, aber
      // eine Antwort: Am echten Album fand die frühere Kantensuche in acht von
      // neun Fällen gar nichts, dieser Weg in neun von neun.
      if (!quad) quad = await detectCloseupAsync(frame);
      // Und wenn auch das nichts findet, bleibt der ganze Bildausschnitt. Was
      // hier nicht passieren darf, ist gar nichts zu tun: Wer auslöst, hat
      // eine Aufnahme gemacht, und die gehört ihm. Der frühere Abbruch mit
      // einem Hinweis war eine Sackgasse – am echten Album ging die Stufe
      // damit überhaupt nicht.
      if (!quad) quad = fullQuad(frame.width, frame.height);

      const blob = await blobFromImageData(frame, 0.95);
      navigator.vibrate?.(30);

      if (sure) {
        // Noch zwei kleine Aufnahmen: Sie zeigen dieselbe Fläche aus einem
        // minimal anderen Winkel und verraten damit, was an der ersten Glanz
        // war. Findet die Vorlage sie nicht wieder, bleibt es beim bisherigen
        // Weg – ein Rückschritt ist ausgeschlossen.
        setStatus('Ruhig halten – Spiegelungen werden gemessen');
        const glare = await measureGlare(target.reference, { image: frame, quad });
        setStatus(null);
        keep(target.index, { blob, width: frame.width, height: frame.height, quad, glare });
        return;
      }

      // Unsicher: Der Zuschnitt wird gezeigt, bevor er gilt. Lieber ein Tipp
      // mehr als ein Foto, das mitten durchs Motiv geschnitten im Album landet
      // und dort erst auffällt.
      setStatus(null);
      setPending({
        index: target.index,
        blob,
        url: URL.createObjectURL(blob),
        width: frame.width,
        height: frame.height,
        quad,
      });
    } finally {
      capturing.current = false;
    }
  }, [camera, keep, measureGlare, target]);

  const takeShotRef = useRef(takeShot);
  takeShotRef.current = takeShot;

  // Die Vorschau der Nachfrage freigeben, falls der Bildschirm verlassen wird.
  const pendingUrl = useRef<string | null>(null);
  pendingUrl.current = pending?.url ?? null;
  useEffect(
    () => () => {
      if (pendingUrl.current) URL.revokeObjectURL(pendingUrl.current);
    },
    [],
  );

  // Fertig, sobald alle Fotos durch sind.
  useEffect(() => {
    if (position >= targets.length) onDone(shots);
  }, [onDone, position, shots, targets.length]);

  // Laufende Erkennung auf einem verkleinerten Vorschaubild.
  useEffect(() => {
    let active = true;
    let timer: number | undefined;

    const tick = async () => {
      if (!active) return;
      const video = camera.videoRef.current;
      if (video && video.videoWidth > 0 && !busy.current && !capturing.current && !pendingRef.current) {
        busy.current = true;
        try {
          const frame = camera.capture(PREVIEW_MAX);
          if (frame) {
            previewSize.current = { width: frame.width, height: frame.height };
            setAspect(frame.width / frame.height);
            // Gefragt wird nicht „liegt hier irgendein grosses Viereck?". Auf
            // einer Albumseite ist das grösste die **Seite**, und der
            // Selbstauslöser ging los, während das Telefon noch weit weg war –
            // genau das war am echten Album zu sehen. Gefragt wird, ob
            // *dieses* Foto formatfüllend im Bild liegt, und das weiss die
            // Seitenaufnahme: Sie zeigt es bereits.
            const current = targetRef.current;
            let found = current ? await locateAsync(current.reference, frame) : null;
            if (!found) {
              // Findet die Seitenaufnahme es nicht wieder – anderes Licht,
              // andere Schärfe –, wird über das Papier ringsum gefragt. Die
              // frühere Kantensuche fand am echten Album fast nie etwas, und
              // der Selbstauslöser ging deshalb nie los.
              found = await detectCloseupAsync(frame);
            }
            const largest = found ? [found] : [];
            const fills = found !== null && polygonArea(found) >= frame.width * frame.height * FILL_MIN;

            const exposure = exposureOf(frame);
            measure(exposure);

            if (active) {
              setDark(tooDark(exposure));
              setQuads((previous) => {
                if (fills && isStable(previous, largest, Math.max(frame.width, frame.height) * 0.02)) {
                  stableCount.current += 1;
                } else {
                  stableCount.current = 0;
                }
                return fills ? largest : [];
              });

              if (autoRef.current && fills && !tooDark(exposure) && stableCount.current >= STABLE_TICKS) {
                void takeShotRef.current();
              }
            }
          }
        } finally {
          busy.current = false;
        }
      }
      timer = window.setTimeout(tick, 180);
    };

    tick();
    return () => {
      active = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [camera, measure]);

  if (pending) {
    return (
      <div className="flex min-h-dvh flex-col bg-black text-stone-100">
        <div className="relative flex flex-1 items-center justify-center overflow-hidden">
          <div className="relative w-full" style={{ aspectRatio: pending.width / pending.height }}>
            <img src={pending.url} alt="Nahaufnahme" className="size-full object-cover" />
            <QuadEditor
              width={pending.width}
              height={pending.height}
              quads={[pending.quad]}
              selected={[0]}
              editing={0}
              onChange={(_, quad) => setPending((current) => (current ? { ...current, quad } : current))}
            />
          </div>
          <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center px-4">
            <span className="rounded-full bg-black/60 px-3 py-1.5 text-center text-sm backdrop-blur" data-testid="nah-nachfrage">
              Passt der Zuschnitt? Ecken ziehen, dann übernehmen.
            </span>
          </div>
        </div>

        <div className="shrink-0 space-y-3 border-t border-white/10 bg-stone-950 px-4 pt-3 pb-6">
          <div className="flex items-center justify-between gap-3">
            <Button onClick={() => closePending(false)} data-testid="nah-nochmal">
              Nochmal
            </Button>
            <Button variant="primary" onClick={() => closePending(true)} data-testid="nah-uebernehmen">
              Übernehmen
            </Button>
          </div>
          <p className="text-center text-[11px] leading-relaxed text-stone-500">
            Die Seitenaufnahme hat dieses Foto im Nahbild nicht wiedererkannt – der Zuschnitt
            stammt vom Papier ringsum und will deshalb einmal angesehen werden.
          </p>
        </div>
      </div>
    );
  }

  if (!target) {
    return <div className="min-h-dvh bg-black" />;
  }

  return (
    <div className="flex min-h-dvh flex-col bg-black text-stone-100">
      <div className="relative flex flex-1 items-center justify-center overflow-hidden">
        <div className="relative w-full" style={{ aspectRatio: aspect }}>
          <video
            ref={camera.attach}
            playsInline
            muted
            autoPlay
            className="size-full object-cover"
            onLoadedMetadata={(event) => {
              const video = event.currentTarget;
              if (video.videoWidth) setAspect(video.videoWidth / video.videoHeight);
            }}
          />
          <QuadEditor
            width={previewSize.current.width}
            height={previewSize.current.height}
            quads={quads}
            selected={quads.map((_, i) => i)}
            editing={null}
          />
        </div>

        {camera.error && (
          <div className="absolute inset-0 z-0 flex flex-col items-center justify-center gap-4 bg-stone-950 px-8 text-center">
            <p className="text-sm text-stone-300">{camera.error}</p>
          </div>
        )}

        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between p-3">
          <IconButton label="Abbrechen" onClick={onCancel} className="pointer-events-auto">
            <BackIcon />
          </IconButton>
          <span className="rounded-full bg-black/50 px-3 py-1.5 text-xs backdrop-blur">
            Foto {target.index + 1} · {position + 1} von {targets.length}
          </span>
          <span className="flex gap-2">
            {camera.torchAvailable && (
              <IconButton
                label={camera.torchOn ? 'Licht aus' : 'Licht an'}
                onClick={takeOver}
                className={`pointer-events-auto ${camera.torchOn ? 'text-amber-300' : ''}`}
                data-testid="torch"
              >
                <TorchIcon />
              </IconButton>
            )}
            <IconButton
              label="Kameraeinstellungen"
              onClick={() => setSettingsOpen(true)}
              className="pointer-events-auto"
            >
              <GearIcon />
            </IconButton>
          </span>
        </div>

        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex flex-col items-center gap-2 px-4">
          <span
            className={`rounded-full px-3 py-1.5 text-center text-sm backdrop-blur ${
              !status && dark ? 'bg-amber-500/85 text-stone-950' : 'bg-black/60'
            }`}
            data-testid="nah-status"
          >
            {status ??
              (dark
                ? framingText('dunkel', light)
                : quads.length > 0
                  ? 'Foto erkannt – ruhig halten'
                  : 'Foto ganz ins Bild – die Ränder müssen knapp sichtbar bleiben')}
          </span>
        </div>

        {settingsOpen && (
          <CameraSettings
            cameras={camera.cameras}
            activeId={camera.activeId}
            zoom={camera.zoom}
            zoomValue={camera.zoomValue}
            focusModes={camera.focusModes}
            focusMode={camera.focusMode}
            resolution={camera.resolution}
            onPick={(id) => {
              chosen.current = true;
              fellBack.current = false;
              rememberCamera(id);
              setDeviceId(id);
            }}
            onZoom={(value) => void camera.setZoom(value)}
            onFocus={(mode) => void camera.setFocusMode(mode)}
            onClose={() => setSettingsOpen(false)}
          />
        )}
      </div>

      <div className="shrink-0 space-y-3 border-t border-white/10 bg-stone-950 px-4 pt-3 pb-6">
        <PageMap
          overview={overview}
          targets={targets}
          position={position}
          done={shots}
          skipped={skipped}
          onPick={jumpTo}
        />

        <div className="flex items-center justify-between gap-4">
          <img
            src={target.url}
            alt={`Foto ${target.index + 1}`}
            className="size-16 shrink-0 rounded-md object-cover ring-1 ring-white/20"
          />

          <button
            type="button"
            aria-label="Auslösen"
            data-testid="closeup-shutter"
            onClick={() => void takeShot()}
            disabled={Boolean(status)}
            className="size-18 rounded-full border-4 border-white/80 bg-amber-400 transition active:scale-95 disabled:opacity-40"
          />

          <div className="flex w-16 justify-end">
            <Button onClick={skip} className="px-3 py-1.5 text-xs">
              Überspringen
            </Button>
          </div>
        </div>

        <div className="flex justify-center">
          <Button
            variant={auto ? 'primary' : 'ghost'}
            onClick={() => setAuto(!auto)}
            className="rounded-full px-3 py-1.5 text-xs"
          >
            Auslöser: {auto ? 'automatisch' : 'manuell'}
          </Button>
        </div>

        <p className="text-center text-[11px] leading-relaxed text-stone-500">
          Dieses Foto möglichst gross ins Bild nehmen, aber <em className="not-italic text-stone-300">ganz</em> –
          ein schmaler Streifen Albumpapier ringsum sagt der App, wo es aufhört. Fehlt er, wird der
          Zuschnitt nachgefragt statt geraten. Spiegelungen sind kein Problem – die Seitenaufnahme
          liefert die Stellen, die hier glänzen.
        </p>
      </div>
    </div>
  );
}

/**
 * Die Albumseite als Landkarte: wo das gesuchte Foto liegt, und welche schon
 * im Kasten sind.
 *
 * Das ist die Führung, die dieser Stufe gefehlt hat. „Foto 3 von 5" sagt
 * nichts darüber, welcher Abzug auf der Seite vor einem gemeint ist – und
 * nichts darüber, was noch aussteht. Beides ist hier ein Blick.
 */
function PageMap({
  overview,
  targets,
  position,
  done,
  skipped,
  onPick,
}: {
  overview: CloseupOverview;
  targets: CloseupTarget[];
  position: number;
  done: Map<number, CloseupShot>;
  skipped: Set<number>;
  onPick: (at: number) => void;
}) {
  const { width, height } = overview;
  const stroke = Math.max(width, height) * 0.006;

  return (
    <div className="mx-auto w-full max-w-xs">
      <div className="relative overflow-hidden rounded-md ring-1 ring-white/15" style={{ aspectRatio: width / height }}>
        <img src={overview.url} alt="Albumseite" className="size-full object-cover opacity-60" />
        <svg viewBox={`0 0 ${width} ${height}`} className="absolute inset-0 size-full">
          {overview.quads.map((quad, at) => {
            const index = targets[at]?.index ?? at;
            const taken = done.has(index);
            const here = at === position;
            const passed = skipped.has(index);
            const cx = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4;
            const cy = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4;
            const size = Math.max(width, height) * 0.06;

            return (
              <g
                key={at}
                role="button"
                aria-label={`Foto ${index + 1}${taken ? ', aufgenommen' : passed ? ', übersprungen' : ''}`}
                data-testid={`karte-${index}`}
                className="cursor-pointer"
                onClick={() => onPick(at)}
              >
                <polygon
                  points={quad.map((p) => `${p.x},${p.y}`).join(' ')}
                  fill={taken ? 'rgba(52,211,153,0.35)' : here ? 'rgba(251,191,36,0.3)' : 'rgba(0,0,0,0.45)'}
                  stroke={taken ? '#34d399' : here ? '#fbbf24' : 'rgba(255,255,255,0.5)'}
                  strokeWidth={here ? stroke * 1.8 : stroke}
                  strokeDasharray={passed ? `${stroke * 3}` : undefined}
                />
                {taken ? (
                  <path
                    d={`M ${cx - size * 0.45} ${cy} L ${cx - size * 0.1} ${cy + size * 0.36} L ${cx + size * 0.5} ${cy - size * 0.36}`}
                    fill="none"
                    stroke="#052e16"
                    strokeWidth={size * 0.24}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                ) : (
                  <text
                    x={cx}
                    y={cy}
                    fill={here ? '#1c1917' : 'rgba(255,255,255,0.85)'}
                    fontSize={size}
                    fontWeight="700"
                    textAnchor="middle"
                    dominantBaseline="central"
                    className="select-none"
                  >
                    {index + 1}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
      <p className="pt-1.5 text-center text-[11px] text-stone-500" data-testid="karte-stand">
        {done.size} von {targets.length} aufgenommen · tippen, um zu wechseln
      </p>
    </div>
  );
}

/** Der ganze Bildausschnitt – die Antwort, wenn nichts gefunden wurde. */
function fullQuad(width: number, height: number): Quad {
  return [
    { x: 0, y: 0 },
    { x: width - 1, y: 0 },
    { x: width - 1, y: height - 1 },
    { x: 0, y: height - 1 },
  ];
}

function TorchIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M13 2L5 13h6l-1 9 8-11h-6z" strokeLinejoin="round" />
    </svg>
  );
}
