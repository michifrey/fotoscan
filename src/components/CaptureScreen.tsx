import { useCallback, useEffect, useRef, useState } from 'react';
import { useCamera, wait } from '../lib/camera';
import { preferred, rememberCamera, rememberedCamera } from '../lib/lenses';
import { orientationSupported, requestOrientationAccess, useTilt } from '../lib/orientation';
import { imageDataFromBlob } from '../lib/canvas';
import { framing, framingText } from '../lib/framing';
import type { Framing } from '../lib/framing';
import { detect } from '../lib/pipeline';
import { defaultQuad } from '../lib/imaging/detect';
import { inView, makeSubject, regionOf, trackSubject } from '../lib/imaging/track';
import type { Region, Subject } from '../lib/imaging/track';
import type { Quad } from '../lib/imaging/types';
import { BackIcon, Button, IconButton } from './ui';
import { QuadEditor } from './QuadEditor';
import { CAPTURE_RADIUS, GuidedCapture, TARGETS, distanceToTarget } from './GuidedCapture';
import { CameraSettings, GearIcon } from './CameraSettings';

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
/** Auflösung, mit der das Motiv während der Aufnahmereihe verfolgt wird. */
const TRACK_MAX = 288;
/** Takt der Verfolgung. Dichter als die Erkennung, damit die Punkte mitgehen. */
const TRACK_INTERVAL = 100;
/** Wie lange auf den Lagesensor gewartet wird, bevor die Zeitsteuerung übernimmt. */
const SENSOR_TIMEOUT = 2500;
/** So lange wartet die Zeitsteuerung darauf, dass das Album zurückkommt. */
const REGAIN_TIMEOUT = 6000;
/** Ausgangslage des Punktekranzes, solange noch nichts verfolgt wird. */
const CENTERED: Region = { cx: 0.5, cy: 0.5, hx: 0.32, hy: 0.32 };

interface GuidedState {
  frames: ImageData[];
  done: boolean[];
}

export function CaptureScreen({ albumName, onShot, onBack }: Props) {
  const [deviceId, setDeviceId] = useState<string | null>(() => rememberedCamera());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const camera = useCamera(true, deviceId);
  const [quads, setQuads] = useState<Quad[]>([]);
  const [view, setView] = useState<Framing>('leer');
  const [destack, setDestack] = useState(true);
  const [auto, setAuto] = useState(true);
  const [status, setStatus] = useState<string | null>(null);
  const [aspect, setAspect] = useState(3 / 4);
  const [guided, setGuided] = useState<GuidedState | null>(null);
  const [region, setRegion] = useState<Region>(CENTERED);
  const [lost, setLost] = useState(false);
  const [following, setFollowing] = useState(false);
  const { tilt, receiving, reset: resetTilt } = useTilt(guided !== null);

  const busy = useRef(false);
  const capturing = useRef(false);
  const stableCount = useRef(0);
  const lastCapture = useRef(0);
  const previewSize = useRef({ width: 4, height: 3 });
  const autoRef = useRef(auto);
  autoRef.current = auto && !settingsOpen;
  const chosen = useRef(false);
  const fellBack = useRef(false);

  // Das Motiv der Grundaufnahme. Solange es gesetzt ist, läuft eine
  // Aufnahmereihe und die Vorschau verfolgt es, statt neu zu suchen.
  const subject = useRef<Subject | null>(null);
  const held = useRef(false);
  const quadsRef = useRef<Quad[]>([]);
  quadsRef.current = quads;

  /** Aufnahmereihe beenden: nichts mehr verfolgen. */
  const stopFollowing = useCallback(() => {
    subject.current = null;
    held.current = false;
    setFollowing(false);
    setLost(false);
    setRegion(CENTERED);
  }, []);

  // Ohne Zutun greift der Browser auf manchen Geräten zum Ultraweitwinkel.
  // Sobald die Objektive bekannt sind, wird einmalig auf die Hauptkamera
  // gewechselt – aber nur, wenn nicht ohnehin schon die richtige läuft.
  useEffect(() => {
    if (chosen.current || deviceId !== null || camera.cameras.length === 0) return;
    chosen.current = true;
    const best = preferred(camera.cameras);
    if (best && best.deviceId !== camera.activeId) setDeviceId(best.deviceId);
  }, [camera.cameras, camera.activeId, deviceId]);

  // Ein gemerktes Objektiv kann es auf diesem Gerät nicht mehr geben. Dann
  // einmal ohne Vorgabe öffnen, statt bei der Fehlermeldung stehenzubleiben.
  useEffect(() => {
    if (!camera.error || deviceId === null || fellBack.current) return;
    fellBack.current = true;
    setDeviceId(null);
  }, [camera.error, deviceId]);

  /**
   * Das Motiv der Grundaufnahme merken: die erkannten Fotos, sonst die
   * Bildmitte. Gibt es dort nichts Wiedererkennbares – eine leere weisse
   * Fläche –, bleibt es beim bisherigen Verhalten ohne Verfolgung.
   */
  const follow = useCallback((base: ImageData) => {
    const box = regionOf(quadsRef.current, previewSize.current.width, previewSize.current.height);
    subject.current = makeSubject(base, box);
    held.current = subject.current !== null;
    setFollowing(subject.current !== null);
    setRegion(box);
    setLost(false);
  }, []);

  /** Wartet, bis das Motiv wieder im Bild ist. Ohne Verfolgung sofort wahr. */
  const regained = useCallback(async (): Promise<boolean> => {
    if (!subject.current) return true;
    const until = Date.now() + REGAIN_TIMEOUT;
    while (!held.current && Date.now() < until) {
      setStatus('Album wieder ins Bild nehmen …');
      await wait(120);
    }
    return held.current;
  }, []);

  /** Aufnahmereihe abschliessen: Fotos suchen und zur Prüfung weiterreichen. */
  const finish = useCallback(
    async (frames: ImageData[]) => {
      setGuided(null);
      stopFollowing();
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
    [onShot, stopFollowing],
  );

  /**
   * Rückfall ohne Lagesensor: vier weitere Aufnahmen im Takt. Der Takt allein
   * genügt nicht – wer das Telefon dabei vom Album wegdreht, bekäme sonst vier
   * Aufnahmen vom Tisch. Aufgenommen wird deshalb erst, wenn das Motiv
   * wiedergefunden ist.
   */
  const runTimedSeries = useCallback(
    async (existing: ImageData[]) => {
      setGuided(null);
      const frames = existing.slice();
      for (let i = frames.length; i <= TARGETS.length; i++) {
        setStatus(`Telefon weiterbewegen … ${i} von ${TARGETS.length}`);
        await wait(420);
        if (!(await regained())) {
          setStatus('Album war nicht mehr im Bild.');
          await wait(1200);
          break;
        }
        const next = camera.capture(STACK_MAX);
        if (next) frames.push(next);
      }
      await finish(frames);
    },
    [camera, finish, regained],
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

    // Ab hier läuft eine Reihe: Das Motiv wird gemerkt und von nun an in jedem
    // Vorschaubild wiedergesucht.
    follow(base);

    // Die Erlaubnis für den Lagesensor muss aus der Nutzeraktion heraus
    // angefragt werden, sonst lehnt iOS sie ab.
    const sensor = orientationSupported() && (await requestOrientationAccess());
    if (!sensor) {
      await runTimedSeries([base]);
      return;
    }
    resetTilt();
    setGuided({ frames: [base], done: TARGETS.map(() => false) });
  }, [camera, destack, finish, follow, resetTilt, runTimedSeries]);

  const takeShotRef = useRef(takeShot);
  takeShotRef.current = takeShot;

  // Auslösen, sobald der Ring auf einem noch offenen Punkt liegt – aber nur,
  // solange das Album auch wirklich vor der Kamera liegt. Die Neigung allein
  // sagt darüber nichts: Sie ist genauso erreicht, wenn das Telefon längst
  // woandershin zeigt.
  useEffect(() => {
    if (!guided || !receiving || lost) return;
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
  }, [camera, finish, guided, lost, receiving, region, tilt]);

  const runTimedSeriesRef = useRef(runTimedSeries);
  runTimedSeriesRef.current = runTimedSeries;

  // Meldet sich der Sensor nicht, übernimmt die Zeitsteuerung. Die Frist läuft
  // über eine Referenz: Die Verfolgung zeichnet mehrmals je Sekunde neu, und
  // eine Abhängigkeit von der Funktion selbst würde die Frist jedes Mal von
  // vorn beginnen lassen.
  useEffect(() => {
    if (!guided || receiving) return;
    const handle = window.setTimeout(() => void runTimedSeriesRef.current(guided.frames), SENSOR_TIMEOUT);
    return () => window.clearTimeout(handle);
  }, [guided, receiving]);

  // Laufende Erkennung auf einem verkleinerten Vorschaubild – und während
  // einer Aufnahmereihe stattdessen die Verfolgung des Motivs.
  useEffect(() => {
    let active = true;
    let timer: number | undefined;

    /** Einmal nachsehen, wo das Motiv gerade liegt – und ob überhaupt. */
    const trackOnce = (following: Subject) => {
      const frame = camera.capture(TRACK_MAX);
      if (!frame || !active) return;
      const track = trackSubject(following, frame);
      const ok = inView(track);
      held.current = ok;
      setLost(!ok);
      // Nur bei sichtbarer Bewegung neu setzen: Sonst zeichnet der Sucher
      // zehnmal je Sekunde neu, und die Punkte zittern.
      if (ok && track) setRegion((current) => (nearlySame(current, track.region) ? current : track.region));
    };

    const tick = async () => {
      if (!active) return;
      const video = camera.videoRef.current;
      const ready = video && video.videoWidth > 0 && !busy.current;

      const following = subject.current;
      if (ready && following) {
        busy.current = true;
        try {
          trackOnce(following);
        } finally {
          busy.current = false;
        }
      } else if (ready && !capturing.current) {
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

              const state = framing(found, frame.width, frame.height, stableCount.current >= 3);
              setView(state);
              if (autoRef.current && state === 'bereit' && Date.now() - lastCapture.current > 2500) {
                void takeShotRef.current();
              }
            }
          }
        } finally {
          busy.current = false;
        }
      }
      timer = window.setTimeout(tick, subject.current ? TRACK_INTERVAL : 180);
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
    [onShot, stopFollowing],
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
          {/* Während einer Aufnahmereihe wird nicht mehr erkannt, sondern
              verfolgt. Ein stehengebliebener Zuschnitt wäre dann genau das,
              was er nicht sein soll: eine Linie, die am Bildschirm klebt. */}
          {!following && (
            <QuadEditor
              width={previewSize.current.width}
              height={previewSize.current.height}
              quads={quads}
              selected={quads.map((_, i) => i)}
              editing={null}
            />
          )}
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
          <span className="flex gap-2">
            {camera.torchAvailable && (
              <IconButton
                label={camera.torchOn ? 'Licht aus' : 'Licht an'}
                onClick={() => void camera.toggleTorch()}
                className={`pointer-events-auto ${camera.torchOn ? 'text-amber-300' : ''}`}
              >
                <TorchIcon />
              </IconButton>
            )}
            <IconButton
              label="Kameraeinstellungen"
              onClick={() => setSettingsOpen(true)}
              className="pointer-events-auto"
              data-testid="camera-settings-open"
            >
              <GearIcon />
            </IconButton>
          </span>
        </div>

        {!camera.error && !guided && (
          <p className="pointer-events-none absolute inset-x-0 bottom-3 text-center text-sm" data-testid="sucher">
            <span
              className={`rounded-full px-3 py-1.5 backdrop-blur ${
                !status && view !== 'bereit' ? 'bg-amber-500/85 text-stone-950' : 'bg-black/60'
              }`}
            >
              {status ?? framingText(view, quads.length)}
            </span>
          </p>
        )}

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

        {guided && (
          <GuidedCapture
            tilt={tilt}
            done={guided.done}
            receiving={receiving}
            aspect={aspect}
            region={region}
            lost={lost}
            onCancel={() => {
              setGuided(null);
              stopFollowing();
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
            ? 'Nach dem Auslösen vier Punkte anfahren, das Album dabei im Bild behalten. Die Spiegelung liegt dann in jeder Aufnahme woanders und wird herausgerechnet.'
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

/** Liegen zwei Motivrechtecke so dicht beieinander, dass es nichts zu zeichnen gibt? */
function nearlySame(a: Region, b: Region): boolean {
  return (
    Math.abs(a.cx - b.cx) < 0.004 &&
    Math.abs(a.cy - b.cy) < 0.004 &&
    Math.abs(a.hx - b.hx) < 0.004 &&
    Math.abs(a.hy - b.hy) < 0.004
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
