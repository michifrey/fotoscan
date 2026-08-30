import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { blobFromImageData, imageDataFromBlob, toImageData } from '../lib/canvas';
import { enhance } from '../lib/imaging/enhance';
import type { EnhanceOptions } from '../lib/imaging/enhance';
import { outputSize, rotate, warpPerspective } from '../lib/imaging/warp';
import { cropWriting, findWriting } from '../lib/imaging/writing';
import { scaleQuad } from '../lib/imaging/geometry';
import type { Quad } from '../lib/imaging/types';
import { hasGlare } from '../lib/imaging/glare';
import { composeFromTiles } from '../lib/imaging/mosaic';
import type { LazyTile } from '../lib/imaging/mosaic';
import { mergePhotosAsync, refine } from '../lib/pipeline';
import type { Closeup } from '../lib/imaging/closeup';
import type { Shot } from './CaptureScreen';
import { CloseupScreen } from './CloseupScreen';
import type { CloseupShot, CloseupTarget } from './CloseupScreen';
import { QuadEditor } from './QuadEditor';
import { BackIcon, Button, IconButton, Spinner, Switch, TopBar } from './ui';

export interface ExtractedPhoto {
  blob: Blob;
  width: number;
  height: number;
  /** Die handschriftliche Bildunterschrift von der Seite, als Ausschnitt. */
  writing?: { blob: Blob; width: number; height: number };
}

/** Die Aufnahme der ganzen Albumseite, verkleinert zum Aufbewahren. */
export interface PageImage {
  blob: Blob;
  width: number;
  height: number;
}

interface Props {
  shot: Shot;
  onCancel: () => void;
  onAccept: (photos: ExtractedPhoto[], page: PageImage | null) => Promise<void>;
}

const PREVIEW_MAX = 420;

export function ReviewScreen({ shot, onCancel, onAccept }: Props) {
  const [quads, setQuads] = useState<Quad[]>(shot.quads);
  const [selected, setSelected] = useState<number[]>(shot.quads.map((_, i) => i));
  const [editing, setEditing] = useState<number | null>(shot.quads.length > 0 ? 0 : null);
  const [rotation, setRotation] = useState(0);
  const [options, setOptions] = useState<EnhanceOptions>({ levels: true, whiteBalance: true, sharpen: true });
  const [showDetails, setShowDetails] = useState(false);
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [closeups, setCloseups] = useState<Map<number, CloseupShot>>(() => new Map());
  const [targets, setTargets] = useState<CloseupTarget[] | null>(null);
  /** Fotos, auf denen auch nach dem Verrechnen noch eine Spiegelung liegt. */
  const [glare, setGlare] = useState<number[]>([]);

  const frame = shot.frames[0];
  const previewCanvas = useRef<HTMLCanvasElement | null>(null);

  /**
   * Die Kacheln eines Blatt-Scans, noch nicht ausgepackt.
   *
   * Ein Dutzend Aufnahmen in voller Grösse gleichzeitig im Speicher sprengt
   * ein Telefon – dieselbe Disziplin wie bei den Nahaufnahmen. Geladen wird
   * je Foto nur, was es überhaupt berührt, und eine Kachel nach der anderen.
   */
  const sweep = useMemo<LazyTile[]>(
    () =>
      (shot.sweep ?? []).map((tile) => ({
        width: tile.width,
        height: tile.height,
        pose: tile.pose,
        load: () => imageDataFromBlob(tile.blob, Math.max(tile.width, tile.height)),
      })),
    [shot.sweep],
  );

  // Verkleinerte Kopien der Aufnahmen – für die Vorschau, damit das Nachführen
  // beim Ziehen der Ecken flüssig bleibt, und für die Prüfung auf
  // stehengebliebene Spiegelungen.
  const small = useMemo(() => {
    const factor = Math.min(1, 900 / Math.max(frame.width, frame.height));
    const width = Math.max(1, Math.round(frame.width * factor));
    const height = Math.max(1, Math.round(frame.height * factor));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const source = document.createElement('canvas');
    source.width = frame.width;
    source.height = frame.height;

    const images = shot.frames.map((each) => {
      source.getContext('2d')!.putImageData(each, 0, 0);
      ctx.drawImage(source, 0, 0, width, height);
      return ctx.getImageData(0, 0, width, height);
    });
    return { image: images[0], images, scale: factor };
  }, [frame, shot.frames]);

  /**
   * Bleibt nach dem Verrechnen Glanz übrig?
   *
   * Gerechnet wird auf den verkleinerten Aufnahmen und mit dem zuerst
   * erkannten Zuschnitt – einmal, im Hintergrund. Es geht um das Licht im
   * Raum, nicht um den Zuschnitt auf den Bildpunkt genau, und der Hinweis
   * soll da sein, bevor gespeichert wird: Solange die Seite noch aufgeschlagen
   * daliegt, kostet eine zweite Aufnahme nichts.
   */
  useEffect(() => {
    let cancelled = false;
    const quadsForCheck = shot.quads.map((quad) => scaleQuad(quad, small.scale));
    void mergePhotosAsync({ frames: small.images, quads: quadsForCheck })
      .then((merged) => {
        if (cancelled) return;
        setGlare(merged.flatMap((image, index) => (image && hasGlare(image) ? [index] : [])));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [shot.quads, small]);

  useEffect(() => {
    let url: string | null = null;
    void blobFromImageData(small.image, 0.85).then((blob) => {
      url = URL.createObjectURL(blob);
      setSourceUrl(url);
    });
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [small]);

  const firstSelected = selected.length > 0 ? Math.min(...selected) : null;

  // Vorschau des ersten ausgewählten Fotos, klein und auf dem Hauptthread.
  useEffect(() => {
    const canvas = previewCanvas.current;
    if (!canvas || firstSelected === null) return;
    const quad = quads[firstSelected];
    if (!quad) return;

    const handle = window.setTimeout(() => {
      const scaled = scaleQuad(quad, small.scale);
      const size = outputSize(scaled, PREVIEW_MAX);
      const warped = warpPerspective(small.image, scaled, size.width, size.height);
      const result = rotate(enhance(warped, options), rotation);
      canvas.width = result.width;
      canvas.height = result.height;
      canvas.getContext('2d')?.putImageData(toImageData(result), 0, 0);
    }, 60);
    return () => window.clearTimeout(handle);
  }, [firstSelected, quads, options, rotation, small]);

  const toggle = useCallback((index: number) => {
    setSelected((current) =>
      current.includes(index) ? current.filter((i) => i !== index) : [...current, index].sort((a, b) => a - b),
    );
  }, []);

  const accept = useCallback(async () => {
    if (selected.length === 0) return;
    setSaving(true);
    try {
      const chosen = selected.map((index) => quads[index]).filter(Boolean);
      // Erst die Seitenaufnahme: entzerrt und entspiegelt, aber noch ohne
      // Nachbearbeitung – sie ist die Vorlage für die Nahaufnahmen.
      const references = await mergePhotosAsync({ frames: shot.frames, quads: chosen });

      // Die Handschrift wird auf der verkleinerten Fassung gesucht – das
      // genügt, um sie zu finden –, ausgeschnitten aber aus der vollen
      // Aufnahme, sonst wäre sie nicht mehr zu lesen.
      const writings = new Map<number, { blob: Blob; width: number; height: number }>();
      for (const entry of findWriting(small.image, chosen.map((quad) => scaleQuad(quad, small.scale)))) {
        const box = {
          minX: Math.round(entry.box.minX / small.scale),
          minY: Math.round(entry.box.minY / small.scale),
          maxX: Math.round(entry.box.maxX / small.scale),
          maxY: Math.round(entry.box.maxY / small.scale),
        };
        const crop = cropWriting(frame, { box, photo: entry.photo }, Math.round(12 / small.scale), chosen);
        writings.set(entry.photo, {
          blob: await blobFromImageData(crop, 0.9),
          width: crop.width,
          height: crop.height,
        });
      }

      const photos: ExtractedPhoto[] = [];
      for (let i = 0; i < references.length; i++) {
        if (references.length > 1) setProgress(`Foto ${i + 1} von ${references.length}`);
        const near = closeups.get(selected[i]);
        let closeup: Closeup | null = null;
        if (!near && sweep.length > 0) {
          // Aus dem Blatt-Scan: Die Kacheln dieses Fotos werden zu einem
          // scharfen Abzug zusammengesetzt. Von da an ist er eine Nahaufnahme
          // wie jede andere – die Seitenaufnahme rechnet seinen Glanz heraus,
          // und der Rest des Weges bleibt derselbe.
          setProgress(`Foto ${i + 1} von ${references.length} – Kacheln werden zusammengesetzt`);
          const mosaic = await composeFromTiles(frame, chosen[i], sweep);
          if (mosaic) {
            closeup = { image: mosaic, quad: fullQuad(mosaic.width, mosaic.height) };
          }
        }
        if (near) {
          // Die Nahaufnahmen liegen als Bilddatei vor, nicht als Pixel: Sechs
          // Aufnahmen in voller Grösse gleichzeitig im Speicher zu halten
          // sprengt den Rahmen eines Telefons. Ausgepackt wird deshalb erst
          // hier, eine nach der anderen.
          const image = await imageDataFromBlob(near.blob, Math.max(near.width, near.height));
          closeup = { image, quad: near.quad };
        }
        const image = await refine({ reference: references[i], closeup, options, rotation });
        photos.push({
          blob: await blobFromImageData(image, 0.92),
          width: image.width,
          height: image.height,
          writing: writings.get(i),
        });
      }
      // Die Übersichtsaufnahme kommt mit ins Album: Sie hält fest, wie die
      // Fotos auf der Seite lagen und was daneben stand.
      await onAccept(photos, {
        blob: await blobFromImageData(small.image, 0.82),
        width: small.image.width,
        height: small.image.height,
      });
    } finally {
      setProgress(null);
      setSaving(false);
    }
  }, [closeups, frame, onAccept, options, quads, rotation, selected, shot.frames, small, sweep]);

  /** Vorschaubilder der ausgewählten Fotos für die Nahaufnahmen-Runde. */
  const openCloseups = useCallback(async () => {
    const list = await Promise.all(
      selected.map(async (index) => {
        const scaled = scaleQuad(quads[index], small.scale);
        const size = outputSize(scaled, 200);
        const warped = warpPerspective(small.image, scaled, size.width, size.height);
        return { index, url: URL.createObjectURL(await blobFromImageData(warped, 0.8)) };
      }),
    );
    setTargets(list);
  }, [quads, selected, small]);

  const closeCloseups = useCallback(() => {
    setTargets((current) => {
      current?.forEach((entry) => URL.revokeObjectURL(entry.url));
      return null;
    });
  }, []);

  const withCloseup = selected.filter((index) => closeups.has(index)).length;
  // Nur was auch gespeichert wird, ist einen Hinweis wert.
  const betroffen = glare.filter((index) => selected.includes(index));

  if (targets) {
    return (
      <CloseupScreen
        targets={targets}
        existing={closeups}
        onDone={(shots) => {
          setCloseups(shots);
          closeCloseups();
        }}
        onCancel={closeCloseups}
      />
    );
  }

  if (saving) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-stone-950 text-stone-100">
        <Spinner
          label={
            progress ??
            (selected.length > 1 ? `${selected.length} Fotos werden verarbeitet …` : 'Foto wird verarbeitet …')
          }
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col bg-stone-950 text-stone-100">
      <TopBar
        title="Zuschnitt prüfen"
        left={
          <IconButton label="Verwerfen" onClick={onCancel}>
            <BackIcon />
          </IconButton>
        }
      />

      <div className="flex-1 overflow-y-auto pb-40">
        <div className="relative mx-auto w-full max-w-2xl" style={{ aspectRatio: frame.width / frame.height }}>
          {sourceUrl && <img src={sourceUrl} alt="Aufnahme" className="size-full object-contain" />}
          <QuadEditor
            width={frame.width}
            height={frame.height}
            quads={quads}
            selected={selected}
            editing={editing}
            onToggle={toggle}
            onActivate={setEditing}
            onChange={(index, quad) => setQuads((current) => current.map((q, i) => (i === index ? quad : q)))}
          />
        </div>

        <div className="mx-auto max-w-2xl space-y-4 px-4 pt-4">
          {betroffen.length > 0 && (
            <div
              className="rounded-xl border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-xs leading-relaxed text-amber-200"
              data-testid="glanz-hinweis"
            >
              {glanzText(betroffen, quads.length, shot.frames.length)}
            </div>
          )}

          <p className="text-xs text-stone-400">
            {quads.length > 1
              ? 'Das Häkchen nimmt ein Foto aus der Auswahl. Tippe auf ein Foto, um seine Ecken zu zeigen und zu ziehen.'
              : 'Ziehe die Ecken, wenn der Zuschnitt nicht stimmt.'}
          </p>

          <div className="flex items-start gap-4">
            <div className="flex-1">
              <p className="mb-2 text-xs font-medium tracking-wide text-stone-400 uppercase">Vorschau</p>
              <div className="flex min-h-32 items-center justify-center rounded-xl bg-black/40 p-2">
                {firstSelected === null ? (
                  <span className="text-xs text-stone-500">Kein Foto ausgewählt</span>
                ) : (
                  <canvas ref={previewCanvas} className="max-h-48 max-w-full rounded-md" />
                )}
              </div>
            </div>
            <div className="flex flex-col gap-2 pt-6">
              <IconButton label="Nach links drehen" onClick={() => setRotation((r) => (r + 3) % 4)}>
                <RotateIcon />
              </IconButton>
              <IconButton label="Nach rechts drehen" onClick={() => setRotation((r) => (r + 1) % 4)}>
                <RotateIcon className="-scale-x-100" />
              </IconButton>
            </div>
          </div>

          <div className="rounded-xl border border-white/10 px-4 py-3">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium">Nahaufnahmen</p>
                <p className="mt-0.5 text-xs text-stone-400">
                  Jedes Foto einzeln aus der Nähe: mehr als die dreifache Auflösung. Spiegelungen
                  rechnet die Seitenaufnahme heraus.
                </p>
              </div>
              <Button
                onClick={() => void openCloseups()}
                disabled={selected.length === 0}
                data-testid="closeups"
                className="shrink-0 px-3 py-1.5 text-xs"
              >
                {withCloseup > 0 ? 'Ergänzen' : 'Aufnehmen'}
              </Button>
            </div>
            {withCloseup > 0 && (
              <p className="mt-2 text-xs text-amber-300">
                {withCloseup} von {selected.length} Fotos mit Nahaufnahme
              </p>
            )}
            {sweep.length > 0 && (
              <p className="mt-2 text-xs text-amber-300" data-testid="blatt-hinweis">
                Blatt-Scan mit {sweep.length} {sweep.length === 1 ? 'Kachel' : 'Kacheln'} – daraus werden die
                Fotos zusammengesetzt.
              </p>
            )}
          </div>

          <div className="rounded-xl border border-white/10 px-4">
            <Switch
              label="Automatisch verbessern"
              hint="Tonwerte spreizen und leicht nachschärfen"
              checked={options.levels || options.sharpen}
              onChange={(value) => setOptions((o) => ({ ...o, levels: value, sharpen: value }))}
            />
            {showDetails && (
              <>
                <Switch
                  label="Tonwerte spreizen"
                  checked={options.levels}
                  onChange={(value) => setOptions((o) => ({ ...o, levels: value }))}
                />
                <Switch
                  label="Nachschärfen"
                  checked={options.sharpen}
                  onChange={(value) => setOptions((o) => ({ ...o, sharpen: value }))}
                />
              </>
            )}
            <Switch
              label="Farbstich entfernen"
              hint="Nimmt vergilbten Abzügen den Gelbton"
              checked={options.whiteBalance}
              onChange={(value) => setOptions((o) => ({ ...o, whiteBalance: value }))}
            />
            <button
              type="button"
              onClick={() => setShowDetails((v) => !v)}
              className="w-full py-2 text-left text-xs text-stone-500 hover:text-stone-300"
            >
              {showDetails ? 'Weniger anzeigen' : 'Einzelne Schritte anzeigen'}
            </button>
          </div>
        </div>
      </div>

      <div className="fixed inset-x-0 bottom-0 border-t border-white/10 bg-stone-950/95 px-4 pt-3 pb-6 backdrop-blur">
        <div className="mx-auto flex max-w-2xl gap-3">
          <Button onClick={onCancel} className="flex-1">
            Verwerfen
          </Button>
          <Button variant="primary" onClick={() => void accept()} disabled={selected.length === 0} className="flex-[2]" data-testid="accept">
            {selected.length > 1 ? `${selected.length} Fotos speichern` : 'Foto speichern'}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Was tun gegen eine Spiegelung, die stehengeblieben ist? Bei einer
 * Aufnahmereihe hilft nur mehr Bewegung: Der Glanz muss zwischen den
 * Aufnahmen über das Foto wandern, sonst ist er in der Mehrheit und lässt
 * sich nicht herausrechnen. Bei einem Einzelbild gibt es gar nichts zu
 * verrechnen – dafür ist das Entspiegeln da.
 */
function glanzText(betroffen: number[], gesamt: number, frames: number): string {
  const welche =
    gesamt === 1
      ? 'Auf dem Foto'
      : betroffen.length === 1
        ? `Auf Foto ${betroffen[0] + 1}`
        : `Auf den Fotos ${betroffen.map((index) => index + 1).join(', ')}`;
  const rat =
    frames > 1
      ? 'Für ein besseres Ergebnis noch einmal aufnehmen und das Telefon dabei deutlicher neigen.'
      : 'Mit eingeschaltetem Entspiegeln lässt sie sich herausrechnen.';
  return `${welche} bleibt auch nach dem Verrechnen eine helle Stelle – vermutlich eine Spiegelung. ${rat}`;
}

/** Das ganze Bild als Viereck – ein zusammengesetztes Foto ist schon entzerrt. */
function fullQuad(width: number, height: number): Quad {
  return [
    { x: 0, y: 0 },
    { x: width - 1, y: 0 },
    { x: width - 1, y: height - 1 },
    { x: 0, y: height - 1 },
  ];
}

function RotateIcon({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={`size-5 ${className}`} fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M4 9a8 8 0 1 1 1.5 7" strokeLinecap="round" />
      <path d="M3 4v5h5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
