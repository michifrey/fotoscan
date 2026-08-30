import { useCallback, useEffect, useRef, useState } from 'react';
import { useCamera } from '../lib/camera';
import { blobFromImageData } from '../lib/canvas';
import { complete, coverageFor, nextGap, progress, record, settled, worthTaking } from '../lib/coverage';
import type { Coverage } from '../lib/coverage';
import { framingText } from '../lib/framing';
import { exposureOf, tooDark } from '../lib/imaging/exposure';
import { compose, linearScale, scaleMatrix } from '../lib/imaging/fit';
import { hasGlare } from '../lib/imaging/glare';
import { invert, viewport } from '../lib/imaging/pose';
import type { Pose } from '../lib/imaging/pose';
import { useAutoLight } from '../lib/light';
import { anchorPose, trackMotion } from '../lib/pipeline';
import { preferred, rememberCamera, rememberedCamera } from '../lib/lenses';
import type { Quad, RgbaImage } from '../lib/imaging/types';
import { BackIcon, Button, IconButton } from './ui';
import { CameraSettings, GearIcon } from './CameraSettings';
import { CoverageMap } from './CoverageMap';

/** Eine Kachel: die Aufnahme als Bilddatei, dazu ihre Lage auf der Übersicht. */
export interface SweepTile {
  blob: Blob;
  width: number;
  height: number;
  /** Bildet Kachelkoordinaten auf Koordinaten der Übersicht ab. */
  pose: number[];
}

interface Props {
  /** Die Übersichtsaufnahme – der Bezugsrahmen und die Karte. */
  overview: ImageData;
  /** Sie noch einmal als Bild, für die Karte. */
  overviewUrl: string;
  /** Die erkannten Fotos, in Koordinaten der Übersicht. */
  quads: Quad[];
  onDone: (tiles: SweepTile[]) => void;
  onCancel: () => void;
}

/** Auflösung, in der die Kacheln aufgenommen werden. */
const TILE_MAX = 2400;

/** Und die, auf der mitgeführt wird. */
const TRACK_MAX = 320;

/** Takt des Mitführens. */
const TICK = 120;

/**
 * Wie fein eine Kachel sein muss, damit sie zählt: so viele Kachelpunkte auf
 * einen Punkt der Übersicht. Rund zwölf Kacheln je Seite.
 */
const TARGET_DETAIL = 2.4;

/** Nach so vielen Bildern ohne Verankerung wird nachjustiert. */
const ANCHOR_EVERY = 2;

/** So lange nach einer Aufnahme wird nicht wieder ausgelöst. */
const REST = 700;

/**
 * Das Blatt abfahren.
 *
 * Nach der Übersichtsaufnahme führt die App mit, wo die Kamera auf der Seite
 * steht (`pose.ts`), und zeigt auf einer Karte, was noch fehlt. Ausgelöst wird
 * von selbst, sobald der Ausschnitt auf offenen Feldern liegt, fein genug ist
 * und die Lage sicher steht.
 *
 * Der Unterschied zum Kippen: Diese Bewegung bringt Auflösung *und*
 * Entspiegelung auf einmal – näher heran heisst mehr Bildpunkte, und der Glanz
 * wandert mit der Kameraposition. Und sie lässt sich zeigen. Einer Neigung
 * sieht man nicht an, was von ihr noch fehlt.
 */
export function SheetScanScreen({ overview, overviewUrl, quads, onDone, onCancel }: Props) {
  const [deviceId, setDeviceId] = useState<string | null>(() => rememberedCamera());
  const camera = useCamera(true, deviceId);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [auto, setAuto] = useState(true);
  const [aspect, setAspect] = useState(3 / 4);
  const [coverage, setCoverage] = useState<Coverage>(() =>
    coverageFor(quads, overview.width, overview.height, TARGET_DETAIL),
  );
  const [pose, setPose] = useState<Pose | null>(null);
  const [tiles, setTiles] = useState<SweepTile[]>([]);
  const [dark, setDark] = useState(false);

  const busy = useRef(false);
  const capturing = useRef(false);
  const previous = useRef<ImageData | null>(null);
  const poseRef = useRef<Pose | null>(null);
  const coverageRef = useRef(coverage);
  const lastTile = useRef(0);
  const autoRef = useRef(auto);
  autoRef.current = auto && !settingsOpen;
  const chosen = useRef(false);
  poseRef.current = pose;
  coverageRef.current = coverage;

  // Beim Abfahren darf das Licht immer zugeschaltet werden: Sein Glanz wandert
  // mit der Kamera und wird beim Zusammensetzen wieder herausgerechnet.
  const { light, measure, takeOver } = useAutoLight(camera, true);

  useEffect(() => {
    if (chosen.current || deviceId !== null || camera.cameras.length === 0) return;
    chosen.current = true;
    const best = preferred(camera.cameras);
    if (best && best.deviceId !== camera.activeId) setDeviceId(best.deviceId);
  }, [camera.cameras, camera.activeId, deviceId]);

  /** Wie fein eine Aufnahme in dieser Lage wäre, bezogen auf die Übersicht. */
  const detailOf = useCallback((current: Pose, frameWidth: number): number => {
    const scale = linearScale(current.matrix);
    return scale > 0 ? TILE_MAX / frameWidth / scale : 0;
  }, []);

  /** Eine Kachel aufnehmen und in die Karte eintragen. */
  const takeTile = useCallback(async () => {
    const current = poseRef.current;
    if (capturing.current || !current) return;
    capturing.current = true;
    lastTile.current = Date.now();

    try {
      const frame = camera.capture(TILE_MAX);
      if (!frame) return;

      // Die Lage ist auf dem Vorschaubild entstanden; die Kachel ist dasselbe
      // Bild in höherer Auflösung, also nur ein Massstab dazwischen.
      const previewWidth = previous.current?.width ?? frame.width;
      const pose = compose(current.matrix, scaleMatrix(previewWidth / frame.width));
      const spot = viewport({ matrix: pose, since: 0 }, frame.width, frame.height);

      const blob = await blobFromImageData(frame, 0.94);
      navigator.vibrate?.(25);
      setTiles((all) => [...all, { blob, width: frame.width, height: frame.height, pose }]);

      const detail = Math.sqrt((frame.width * frame.height) / Math.abs(area(spot)));
      setCoverage((map) => record(map, spot, detail, hasGlare(frame as RgbaImage)));
    } finally {
      capturing.current = false;
    }
  }, [camera]);

  const takeTileRef = useRef(takeTile);
  takeTileRef.current = takeTile;

  // Mitführen: je Vorschaubild die Änderung seit dem vorigen, gelegentlich
  // gegen die Übersicht nachjustiert.
  useEffect(() => {
    let active = true;
    let timer: number | undefined;

    const tick = async () => {
      if (!active) return;
      const video = camera.videoRef.current;
      if (video && video.videoWidth > 0 && !busy.current && !capturing.current) {
        busy.current = true;
        try {
          const frame = camera.capture(TRACK_MAX);
          if (frame) {
            setAspect(frame.width / frame.height);
            const exposure = exposureOf(frame);
            measure(exposure);
            if (active) setDark(tooDark(exposure));
            await step(frame);
          }
        } finally {
          busy.current = false;
        }
      }
      if (active) timer = window.setTimeout(tick, TICK);
    };

    const step = async (frame: ImageData) => {
      const last = previous.current;
      const current = poseRef.current;
      previous.current = frame;

      // Ohne Lage: die Anfangslage suchen. Direkt nach der Übersicht zeigt das
      // Vorschaubild dieselbe Seite, nur in anderer Auflösung.
      if (!current || !last) {
        const found = await anchorPose(overview, frame, null);
        if (active && found) setPose(found);
        return;
      }

      const motion = await trackMotion(last, frame);
      if (!active) return;
      if (!motion) {
        // Lieber keine Lage als eine falsche: Eine erfundene Bewegung
        // multipliziert sich in alle folgenden hinein.
        setPose(null);
        return;
      }

      let next = advanceLocal(current, motion.matrix);
      if (next.since >= ANCHOR_EVERY) {
        const anchored = await anchorPose(overview, frame, next);
        if (!active) return;
        if (anchored) next = anchored;
      }
      setPose(next);

      if (!autoRef.current || Date.now() - lastTile.current < REST) return;
      const detail = detailOf(next, frame.width);
      const spot = viewport(next, frame.width, frame.height);
      if (worthTaking(coverageRef.current, spot, detail) && !tooDark(exposureOf(frame))) {
        void takeTileRef.current();
      }
    };

    tick();
    return () => {
      active = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [camera, detailOf, measure, overview]);

  const { done, needed } = progress(coverage);
  const spot = pose && previous.current ? viewport(pose, previous.current.width, previous.current.height) : null;
  const gap = nextGap(coverage);
  const finished = complete(coverage);

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
        </div>

        {camera.error && (
          <div className="absolute inset-0 z-0 flex items-center justify-center bg-stone-950 px-8 text-center">
            <p className="text-sm text-stone-300">{camera.error}</p>
          </div>
        )}

        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between p-3">
          <IconButton label="Abbrechen" onClick={onCancel} className="pointer-events-auto">
            <BackIcon />
          </IconButton>
          <span className="rounded-full bg-black/50 px-3 py-1.5 text-xs backdrop-blur" data-testid="deckung">
            {needed === 0 ? 'Kein Foto erkannt' : `${done} von ${needed} Feldern`}
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

        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center px-4">
          <span
            className={`rounded-full px-3 py-1.5 text-center text-sm backdrop-blur ${
              dark || !pose ? 'bg-amber-500/85 text-stone-950' : 'bg-black/60'
            }`}
            data-testid="sucher"
          >
            {message({ dark, light, pose, finished, needed })}
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
          <CoverageMap
            url={overviewUrl}
            coverage={coverage}
            settled={(cell) => settled(cell, coverage.target)}
            viewport={spot}
            gap={gap}
          />

          <button
            type="button"
            aria-label="Auslösen"
            data-testid="sweep-shutter"
            onClick={() => void takeTile()}
            disabled={!pose}
            className="size-18 shrink-0 rounded-full border-4 border-white/80 bg-amber-400 transition active:scale-95 disabled:opacity-40"
          />

          <div className="w-16 text-right text-[11px] text-stone-500" data-testid="kacheln">
            {tiles.length} {tiles.length === 1 ? 'Kachel' : 'Kacheln'}
          </div>
        </div>

        <div className="flex justify-center gap-2 text-xs">
          <Button
            variant={auto ? 'primary' : 'ghost'}
            onClick={() => setAuto(!auto)}
            className="rounded-full px-3 py-1.5 text-xs"
          >
            Auslöser: {auto ? 'automatisch' : 'manuell'}
          </Button>
          <Button
            variant="primary"
            onClick={() => onDone(tiles)}
            disabled={tiles.length === 0}
            className="rounded-full px-3 py-1.5 text-xs"
            data-testid="sweep-done"
          >
            Fertig
          </Button>
        </div>

        <p className="text-center text-[11px] leading-relaxed text-stone-500">
          Das Telefon flach über die Seite führen und dabei näher herangehen. Die
          App löst aus, wo noch etwas fehlt.
        </p>
      </div>
    </div>
  );
}

/** Die Lage um eine Bewegung weiterführen – ohne den Umweg über den Worker. */
function advanceLocal(pose: Pose, motion: number[]): Pose {
  const back = invert(motion);
  return back ? { matrix: compose(pose.matrix, back), since: pose.since + 1 } : { ...pose, since: pose.since + 1 };
}


function area(quad: Quad): number {
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

function message({
  dark,
  light,
  pose,
  finished,
  needed,
}: {
  dark: boolean;
  light: Parameters<typeof framingText>[2];
  pose: Pose | null;
  finished: boolean;
  needed: number;
}): string {
  if (needed === 0) return 'Auf dieser Seite wurde kein Foto erkannt';
  if (dark) return framingText('dunkel', 0, light);
  if (!pose) return 'Stelle wird gesucht – Telefon ruhig über die Seite halten';
  if (finished) return 'Alles abgefahren – auf Fertig tippen';
  return 'Weiter über die hellen Stellen der Karte';
}

function TorchIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M13 2L5 13h6l-1 9 8-11h-6z" strokeLinejoin="round" />
    </svg>
  );
}
