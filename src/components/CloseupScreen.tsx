import { useCallback, useEffect, useRef, useState } from 'react';
import { useCamera } from '../lib/camera';
import { preferred, rememberCamera, rememberedCamera } from '../lib/lenses';
import { blobFromImageData } from '../lib/canvas';
import { detect, locateAsync } from '../lib/pipeline';
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

interface Props {
  targets: CloseupTarget[];
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
 * Die dritte Runde: jedes Foto einzeln aus der Nähe.
 *
 * Auf der Seitenaufnahme teilen sich alle Fotos einer Albumseite die Bildpunkte
 * der Kamera; für das einzelne Foto bleibt ein Bruchteil. Wer näher herangeht,
 * bekommt ein Vielfaches – und die Spiegelung, die sich dabei unweigerlich
 * einstellt, rechnet die Seitenaufnahme wieder heraus.
 */
export function CloseupScreen({ targets, existing, onDone, onCancel }: Props) {
  const [deviceId, setDeviceId] = useState<string | null>(() => rememberedCamera());
  const camera = useCamera(true, deviceId);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [position, setPosition] = useState(0);
  const [shots, setShots] = useState<Map<number, CloseupShot>>(() => new Map(existing));
  const [quads, setQuads] = useState<Quad[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [auto, setAuto] = useState(true);
  const [aspect, setAspect] = useState(3 / 4);

  const busy = useRef(false);
  const capturing = useRef(false);
  const stableCount = useRef(0);
  const previewSize = useRef({ width: 4, height: 3 });
  const chosen = useRef(false);
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

  const advance = useCallback(() => {
    setQuads([]);
    stableCount.current = 0;
    setPosition((current) => current + 1);
  }, []);

  const takeShot = useCallback(async () => {
    if (capturing.current || !target) return;
    capturing.current = true;
    stableCount.current = 0;
    setStatus('Foto wird gesucht …');
    try {
      const frame = camera.capture(CLOSE_MAX);
      if (!frame) return;

      // Zuerst über die Seitenaufnahme: Sie zeigt dieses Foto bereits und weiss
      // damit, wie es aussieht. Das ist der verlässlichere Weg – die
      // Kantensuche im Nahbild trifft auch einmal daneben, und dann wird mitten
      // durchs Motiv geschnitten, ohne dass jemand es merkt.
      let quad = await locateAsync(target.reference, frame);
      if (!quad) {
        // Rückfall auf die Kantensuche. Sie braucht einen schmalen Streifen
        // Papier ringsum – ragt das Foto über den Bildrand, ist dort nichts
        // mehr, woran sie es erkennen könnte. Deshalb sagt die Führung, dass
        // die Ränder sichtbar bleiben sollen.
        const found = await detect(frame);
        quad = found.slice().sort((a, b) => polygonArea(b) - polygonArea(a))[0] ?? null;
      }
      if (!quad || polygonArea(quad) < frame.width * frame.height * FILL_MIN) {
        setHint('Foto ganz ins Bild nehmen – seine Ränder müssen knapp sichtbar bleiben.');
        navigator.vibrate?.([20, 60, 20]);
        return;
      }

      const blob = await blobFromImageData(frame, 0.95);
      navigator.vibrate?.(30);
      setShots((current) => {
        const next = new Map(current);
        next.set(target.index, { blob, width: frame.width, height: frame.height, quad });
        return next;
      });
      setHint(null);
      advance();
    } finally {
      setStatus(null);
      capturing.current = false;
    }
  }, [advance, camera, target]);

  const takeShotRef = useRef(takeShot);
  takeShotRef.current = takeShot;

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
      if (video && video.videoWidth > 0 && !busy.current && !capturing.current) {
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
              // andere Schärfe –, genügt auch ein formatfüllendes Viereck.
              // Sonst löste der Sucher nie aus, und das wäre schlimmer als
              // einmal zu früh.
              const quads = await detect(frame, 420);
              found = quads.slice().sort((a, b) => polygonArea(b) - polygonArea(a))[0] ?? null;
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
                : (hint ??
                  (quads.length > 0
                    ? 'Foto erkannt – ruhig halten'
                    : 'Foto ganz ins Bild – die Ränder müssen knapp sichtbar bleiben')))}
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
            <Button onClick={advance} className="px-3 py-1.5 text-xs">
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
          ein schmaler Streifen Albumpapier muss ringsum sichtbar bleiben, sonst weiss die App nicht,
          wo es aufhört. Spiegelungen sind kein Problem – die Seitenaufnahme liefert die Stellen, die
          hier glänzen.
        </p>
      </div>
    </div>
  );
}

function TorchIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M13 2L5 13h6l-1 9 8-11h-6z" strokeLinejoin="round" />
    </svg>
  );
}
