import { useCallback, useEffect, useRef, useState } from 'react';
import { useCamera, wait } from '../lib/camera';
import { orientationSupported, requestOrientationAccess, useTilt } from '../lib/orientation';
import { imageDataFromBlob } from '../lib/canvas';
import { detect } from '../lib/pipeline';
import { defaultQuad } from '../lib/imaging/detect';
import type { Quad } from '../lib/imaging/types';
import { BackIcon, Button, IconButton } from './ui';
import { QuadEditor } from './QuadEditor';
import { CAPTURE_RADIUS, GuidedCapture, TARGETS, distanceToTarget } from './GuidedCapture';

export interface Shot {
  frames: ImageData[];
  quads: Quad[];
}

interface Props {
  albumName: string;
  onShot: (shot: Shot) => void;
  onBack: () => void;
}

/** Auflösung der Aufnahmen – beim Entspiegeln kleiner, sonst wird der Speicher knapp. */
const SINGLE_MAX = 3200;
const STACK_MAX = 2200;
const PREVIEW_MAX = 480;
/** Wie lange auf den Lagesensor gewartet wird, bevor die Zeitsteuerung übernimmt. */
const SENSOR_TIMEOUT = 2500;

interface GuidedState {
  frames: ImageData[];
  done: boolean[];
}

export function CaptureScreen({ albumName, onShot, onBack }: Props) {
  const camera = useCamera(true);
  const [quads, setQuads] = useState<Quad[]>([]);
  const [destack, setDestack] = useState(true);
  const [auto, setAuto] = useState(true);
  const [status, setStatus] = useState<string | null>(null);
  const [aspect, setAspect] = useState(3 / 4);
  const [guided, setGuided] = useState<GuidedState | null>(null);
  const { tilt, receiving, reset: resetTilt } = useTilt(guided !== null);

  const busy = useRef(false);
  const capturing = useRef(false);
  const stableCount = useRef(0);
  const lastCapture = useRef(0);
  const previewSize = useRef({ width: 4, height: 3 });
  const autoRef = useRef(auto);
  autoRef.current = auto;

  /** Aufnahmereihe abschliessen: Fotos suchen und zur Prüfung weiterreichen. */
  const finish = useCallback(
    async (frames: ImageData[]) => {
      setGuided(null);
      if (frames.length === 0) {
        capturing.current = false;
        return;
      }
      setStatus('Fotos werden gesucht …');
      try {
        const found = await detect(frames[0]);
        onShot({
          frames,
          quads: found.length > 0 ? found : [defaultQuad(frames[0].width, frames[0].height)],
        });
      } finally {
        setStatus(null);
        capturing.current = false;
      }
    },
    [onShot],
  );

  /** Rückfall ohne Lagesensor: vier weitere Aufnahmen im Takt. */
  const runTimedSeries = useCallback(
    async (existing: ImageData[]) => {
      setGuided(null);
      const frames = existing.slice();
      for (let i = frames.length; i <= TARGETS.length; i++) {
        setStatus(`Telefon weiterbewegen … ${i} von ${TARGETS.length}`);
        await wait(420);
        const next = camera.capture(STACK_MAX);
        if (next) frames.push(next);
      }
      await finish(frames);
    },
    [camera, finish],
  );

  const takeShot = useCallback(async () => {
    if (capturing.current) return;
    capturing.current = true;
    lastCapture.current = Date.now();
    stableCount.current = 0;

    const base = camera.capture(destack ? STACK_MAX : SINGLE_MAX);
    if (!base) {
      capturing.current = false;
      return;
    }
    if (!destack) {
      await finish([base]);
      return;
    }

    // Die Erlaubnis für den Lagesensor muss aus der Nutzeraktion heraus
    // angefragt werden, sonst lehnt iOS sie ab.
    const sensor = orientationSupported() && (await requestOrientationAccess());
    if (!sensor) {
      await runTimedSeries([base]);
      return;
    }
    resetTilt();
    setGuided({ frames: [base], done: TARGETS.map(() => false) });
  }, [camera, destack, finish, resetTilt, runTimedSeries]);

  const takeShotRef = useRef(takeShot);
  takeShotRef.current = takeShot;

  // Auslösen, sobald der Ring auf einem noch offenen Punkt liegt.
  useEffect(() => {
    if (!guided || !receiving) return;
    const index = TARGETS.findIndex(
      (target, i) => !guided.done[i] && distanceToTarget(tilt, target.tilt) < CAPTURE_RADIUS,
    );
    if (index < 0) return;

    const frame = camera.capture(STACK_MAX);
    navigator.vibrate?.(30);
    const done = guided.done.slice();
    done[index] = true;
    const frames = frame ? [...guided.frames, frame] : guided.frames;
    if (done.every(Boolean)) void finish(frames);
    else setGuided({ frames, done });
  }, [camera, finish, guided, receiving, tilt]);

  // Meldet sich der Sensor nicht, übernimmt die Zeitsteuerung.
  useEffect(() => {
    if (!guided || receiving) return;
    const handle = window.setTimeout(() => void runTimedSeries(guided.frames), SENSOR_TIMEOUT);
    return () => window.clearTimeout(handle);
  }, [guided, receiving, runTimedSeries]);

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
            const found = await detect(frame, 420);
            if (active) {
              setQuads((previous) => {
                if (isStable(previous, found, Math.max(frame.width, frame.height) * 0.02)) {
                  stableCount.current += 1;
                } else {
                  stableCount.current = 0;
                }
                return found;
              });

              if (
                autoRef.current &&
                found.length > 0 &&
                stableCount.current >= 3 &&
                Date.now() - lastCapture.current > 2500
              ) {
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
  }, [camera]);

  const importFile = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      setStatus('Bild wird geladen …');
      try {
        const image = await imageDataFromBlob(file, SINGLE_MAX);
        const found = await detect(image);
        onShot({ frames: [image], quads: found.length > 0 ? found : [defaultQuad(image.width, image.height)] });
      } catch {
        setStatus('Diese Datei konnte nicht geöffnet werden.');
        await wait(2500);
      } finally {
        setStatus(null);
      }
    },
    [onShot],
  );

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
            <p className="text-xs text-stone-500">
              Du kannst stattdessen ein vorhandenes Bild aus der Galerie öffnen.
            </p>
          </div>
        )}

        <div className="pointer-events-none z-10 absolute inset-x-0 top-0 flex items-start justify-between p-3">
          <IconButton label="Zurück" onClick={onBack} className="pointer-events-auto">
            <BackIcon />
          </IconButton>
          <span className="pointer-events-none max-w-[55%] truncate rounded-full bg-black/50 px-3 py-1.5 text-xs backdrop-blur">
            {albumName}
          </span>
          {camera.torchAvailable ? (
            <IconButton
              label={camera.torchOn ? 'Licht aus' : 'Licht an'}
              onClick={() => void camera.toggleTorch()}
              className={`pointer-events-auto ${camera.torchOn ? 'text-amber-300' : ''}`}
            >
              <TorchIcon />
            </IconButton>
          ) : (
            <span className="size-11" />
          )}
        </div>

        {(status || quads.length > 0) && !camera.error && !guided && (
          <p className="pointer-events-none absolute inset-x-0 bottom-3 text-center text-sm">
            <span className="rounded-full bg-black/60 px-3 py-1.5 backdrop-blur">
              {status ?? `${quads.length} ${quads.length === 1 ? 'Foto' : 'Fotos'} erkannt`}
            </span>
          </p>
        )}

        {guided && (
          <GuidedCapture
            tilt={tilt}
            done={guided.done}
            receiving={receiving}
            aspect={aspect}
            onCancel={() => {
              setGuided(null);
              capturing.current = false;
            }}
            onFinish={() => void finish(guided.frames)}
          />
        )}
      </div>

      <div className="shrink-0 space-y-4 border-t border-white/10 bg-stone-950 px-4 pt-3 pb-6">
        <div className="flex justify-center gap-2 text-xs">
          <Chip active={destack} onClick={() => setDestack(true)}>
            Entspiegeln
          </Chip>
          <Chip active={!destack} onClick={() => setDestack(false)}>
            Einzelbild
          </Chip>
          <Chip active={auto} onClick={() => setAuto(!auto)}>
            Auslöser: {auto ? 'automatisch' : 'manuell'}
          </Chip>
        </div>

        <div className="flex items-center justify-between">
          <label className="inline-flex cursor-pointer flex-col items-center gap-1 text-[11px] text-stone-400">
            <span className="flex size-11 items-center justify-center rounded-full bg-white/10">
              <GalleryIcon />
            </span>
            Galerie
            <input
              type="file"
              accept="image/*"
              className="sr-only"
              data-testid="import-input"
              onChange={(event) => {
                void importFile(event.target.files?.[0]);
                event.target.value = '';
              }}
            />
          </label>

          <button
            type="button"
            aria-label="Auslösen"
            data-testid="shutter"
            onClick={() => void takeShot()}
            disabled={Boolean(status) || guided !== null}
            className="size-18 rounded-full border-4 border-white/80 bg-amber-400 transition active:scale-95 disabled:opacity-40"
          />

          <div className="flex w-11 justify-center text-[11px] text-stone-500">
            {destack ? `${TARGETS.length + 1}×` : '1×'}
          </div>
        </div>

        <p className="text-center text-[11px] leading-relaxed text-stone-500">
          {destack
            ? 'Nach dem Auslösen vier Punkte anfahren. Die Spiegelung liegt dann in jeder Aufnahme woanders und wird herausgerechnet.'
            : 'Eine einzelne Aufnahme, ohne Entspiegelung.'}
        </p>
      </div>
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <Button variant={active ? 'primary' : 'ghost'} onClick={onClick} className="rounded-full px-3 py-1.5 text-xs">
      {children}
    </Button>
  );
}

/** Vergleicht zwei Erkennungen, um ein ruhiges Bild zu erkennen. */
export function isStable(a: Quad[], b: Quad[], tolerance: number): boolean {
  if (a.length === 0 || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    for (let c = 0; c < 4; c++) {
      if (Math.hypot(a[i][c].x - b[i][c].x, a[i][c].y - b[i][c].y) > tolerance) return false;
    }
  }
  return true;
}

function TorchIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M13 2L5 13h6l-1 9 8-11h-6z" strokeLinejoin="round" />
    </svg>
  );
}

function GalleryIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 16l4.5-4.5 4 4L15 12l6 5.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="8.5" cy="9.5" r="1.3" />
    </svg>
  );
}
