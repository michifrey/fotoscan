import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { blobFromImageData, imageDataFromBlob, toImageData } from '../lib/canvas';
import { enhance } from '../lib/imaging/enhance';
import type { EnhanceOptions } from '../lib/imaging/enhance';
import { applyHomography, computeHomography, outputSize, rotate, warpPerspective } from '../lib/imaging/warp';
import { cropWriting, findWriting } from '../lib/imaging/writing';
import { orderQuad, scaleQuad } from '../lib/imaging/geometry';
import type { Pt, Quad, RgbaImage } from '../lib/imaging/types';
import { hasGlare } from '../lib/imaging/glare';
import { defaultQuad } from '../lib/imaging/detect';
import { detectAtAsync, detectPhotosAsync, mergePhotosAsync, refine } from '../lib/pipeline';
import type { Closeup } from '../lib/imaging/closeup';
import type { PageMarks } from '../lib/storage';
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
  /**
   * Die geprüften Vierecke, in Koordinaten dieses Bildes.
   *
   * Nicht in denen der vollen Aufnahme: Gespeichert wird die verkleinerte
   * Fassung, und ein Polygon, das sich auf ein Bild bezieht, das niemand mehr
   * hat, ist wertlos.
   */
  marks: PageMarks;
}

interface Props {
  shot: Shot;
  onCancel: () => void;
  onAccept: (photos: ExtractedPhoto[], page: PageImage | null) => Promise<void>;
}

/**
 * Die zweite Stufe: erst die Seite geraderücken, dann die Fotos darauf wählen.
 *
 * Die Trennung ist der ganze Punkt. Vorher entschied die Erkennung in einem Zug
 * beides – wo die Seite ist und welche Fotos darauf liegen – und wenn sie sich
 * bei der zweiten Frage irrte, kam die ganze Seite als ein Foto heraus, ohne
 * dass jemand widersprechen konnte.
 *
 * Jetzt fragt die App zweimal, und beide Antworten sind zu ändern:
 *
 * 1. **Seite.** Ihr Viereck steht über der Aufnahme; die vier Ecken lassen sich
 *    ziehen. „Weiter" entzerrt sie.
 * 2. **Fotos.** Auf der geraden Seite wird gesucht und durchnummeriert. Ecken
 *    ziehen, Falsches abwählen – und was übersehen wurde, mit einem Tipp
 *    daraufholen.
 */

const PREVIEW_MAX = 420;

/** Längste Kante, auf die die Seite entzerrt wird. */
const PAGE_MAX = 2200;

/** Kantenlänge eines von Hand gesetzten Vierecks, als Anteil der Seitenbreite. */
const HAND_SIZE = 0.22;

type Step = 'seite' | 'fotos';

export function ReviewScreen({ shot, onCancel, onAccept }: Props) {
  const frame = shot.frames[0];

  const [step, setStep] = useState<Step>('seite');
  const [pageQuad, setPageQuad] = useState<Quad>(() =>
    // Ins Bild geholt: Eine Ecke ausserhalb lässt sich nicht greifen, und die
    // Erkennung weitet ihr Viereck bewusst ein wenig – am Bildrand landet es
    // dann daneben.
    insideImage(shot.page ?? fullQuad(frame.width, frame.height), frame.width, frame.height),
  );
  /** Welche Ecke als nächste angetippt wird, oder `null`: gerade keine. */
  const [awaiting, setAwaiting] = useState<number | null>(null);
  const [quads, setQuads] = useState<Quad[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [editing, setEditing] = useState<number | null>(null);
  const [rotation, setRotation] = useState(0);
  const [options, setOptions] = useState<EnhanceOptions>({ levels: true, whiteBalance: true, sharpen: true });
  const [showDetails, setShowDetails] = useState(false);
  const [saving, setSaving] = useState(false);
  const [searching, setSearching] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [pageUrl, setPageUrl] = useState<string | null>(null);
  const [targets, setTargets] = useState<CloseupTarget[] | null>(null);
  /** Fotos, auf denen auch nach dem Verrechnen noch eine Spiegelung liegt. */
  const [glare, setGlare] = useState<number[]>([]);

  const previewCanvas = useRef<HTMLCanvasElement | null>(null);

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
   * Die entzerrte Seite. Auf ihr wird gesucht, gezeigt und getippt – die
   * Fotovierecke leben in ihren Koordinaten.
   */
  const page = useMemo<RgbaImage | null>(() => {
    if (step !== 'fotos') return null;
    // Bewusst ohne die Aufnahme: Die Rückrechnung des Seitenverhältnisses
    // stützt sich darauf, dass ein Abzug in einem Normformat vorliegt. Eine
    // Albumseite tut das nicht – sie ist so gross, wie der Buchbinder wollte.
    // Und es schadet auch nichts: Diese Entzerrung ist eine Zwischenstufe, die
    // fertigen Fotos entstehen später aus der Aufnahme selbst.
    const size = outputSize(pageQuad, PAGE_MAX);
    return warpPerspective(frame, pageQuad, size.width, size.height);
  }, [frame, pageQuad, step]);

  /** Von der geraden Seite zurück in die Aufnahme – für alles Weitere. */
  const toFrame = useMemo(
    () => (page ? computeHomography(fullQuad(page.width, page.height), pageQuad) : null),
    [page, pageQuad],
  );

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

  // Die gerade Seite als Bild für die Anzeige.
  useEffect(() => {
    if (!page) return;
    let url: string | null = null;
    let dropped = false;
    void blobFromImageData(page, 0.85).then((blob) => {
      if (dropped) return;
      url = URL.createObjectURL(blob);
      setPageUrl(url);
    });
    return () => {
      dropped = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [page]);

  // Die Fotos auf der geraden Seite suchen, sobald sie steht.
  useEffect(() => {
    if (!page) return;
    let cancelled = false;
    setSearching(true);
    void detectPhotosAsync(page)
      .then((all) => {
        if (cancelled) return;
        // Findet die Erkennung nichts, liegt ein Viereck über der halben Seite
        // bereit. Das ist die wahrscheinlichste Lesart – die Seite *ist* das
        // Foto – und vor allem ist es etwas, das sich ziehen lässt. Eine leere
        // Auswahl wäre eine Sackgasse.
        const found = all.length > 0 ? all : [defaultQuad(page.width, page.height)];
        setQuads(found);
        setSelected(found.map((_, i) => i));
        setEditing(found.length > 0 ? 0 : null);
      })
      .finally(() => {
        if (!cancelled) setSearching(false);
      });
    return () => {
      cancelled = true;
    };
  }, [page]);

  /**
   * Bleibt nach dem Verrechnen Glanz übrig?
   *
   * Gerechnet wird auf den verkleinerten Aufnahmen, einmal im Hintergrund. Es
   * geht um das Licht im Raum, nicht um den Zuschnitt auf den Bildpunkt genau,
   * und der Hinweis soll da sein, bevor gespeichert wird: Solange die Seite
   * noch aufgeschlagen daliegt, kostet eine zweite Aufnahme nichts.
   */
  useEffect(() => {
    if (!toFrame || quads.length === 0) return;
    let cancelled = false;
    const inFrame = quads.map((quad) => scaleQuad(applyHomography(toFrame, quad) as Quad, small.scale));
    void mergePhotosAsync({ frames: small.images, quads: inFrame })
      .then((merged) => {
        if (cancelled) return;
        setGlare(merged.flatMap((image, index) => (image && hasGlare(image) ? [index] : [])));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [quads, small, toFrame]);

  const firstSelected = selected.length > 0 ? Math.min(...selected) : null;

  // Vorschau des ersten ausgewählten Fotos, klein und auf dem Hauptthread.
  useEffect(() => {
    const canvas = previewCanvas.current;
    if (!canvas || firstSelected === null || !page) return;
    const quad = quads[firstSelected];
    if (!quad) return;

    const handle = window.setTimeout(() => {
      const size = outputSize(quad, PREVIEW_MAX);
      const warped = warpPerspective(page, quad, size.width, size.height);
      const result = rotate(enhance(warped, options), rotation);
      canvas.width = result.width;
      canvas.height = result.height;
      canvas.getContext('2d')?.putImageData(toImageData(result), 0, 0);
    }, 60);
    return () => window.clearTimeout(handle);
  }, [firstSelected, options, page, quads, rotation]);

  const toggle = useCallback((index: number) => {
    setSelected((current) =>
      current.includes(index) ? current.filter((i) => i !== index) : [...current, index].sort((a, b) => a - b),
    );
  }, []);

  /**
   * Ein Tipp auf freie Fläche: Dort wird nachgesehen, und was gefunden wird,
   * bekommt die nächste Nummer.
   *
   * Findet die Erkennung nichts – ein blasser Abzug hat für sie die Farbe des
   * Papiers –, wird trotzdem ein Viereck hingelegt. Von Hand gezogen ist immer
   * noch besser als gar nicht: Sonst bliebe genau das Foto verloren, dessen
   * wegen der Nutzer überhaupt hingetippt hat.
   */
  const addAt = useCallback(
    async (point: Pt) => {
      if (!page) return;
      const found = (await detectAtAsync(page, point)) ?? handQuad(point, page.width, page.height);
      setQuads((current) => {
        setSelected((chosen) => [...chosen, current.length].sort((a, b) => a - b));
        setEditing(current.length);
        return [...current, found];
      });
    },
    [page],
  );

  /**
   * Eine Ecke der Seite setzen.
   *
   * Seidenpapier, Albumseite und die losen Blätter darunter sind dasselbe
   * Papier, sie berühren einander und liegen in einer Ebene – über Farbe,
   * Kanten oder die Fotos darauf lassen sie sich nicht zuverlässig trennen
   * (alle drei Wege gemessen, keiner trägt). Ein Mensch weiss es aus dem
   * Zusammenhang. Also fragt die App ihn: vier Tipps, und das Viereck steht.
   *
   * Zum Schluss werden die vier Punkte sortiert. Wer nicht in der verlangten
   * Reihenfolge tippt, bekommt trotzdem ein brauchbares Viereck statt einer
   * verdrehten Schleife.
   */
  const setCorner = useCallback(
    (point: Pt) => {
      setPageQuad((current) => {
        const next = current.map((p, i) => (i === awaiting ? point : p)) as Quad;
        return awaiting === CORNERS.length - 1 ? orderQuad(next) : next;
      });
      setAwaiting((current) => (current === null || current >= CORNERS.length - 1 ? null : current + 1));
    },
    [awaiting],
  );

  /** Ein Foto ganz entfernen – nicht bloss abwählen. */
  const remove = useCallback((index: number) => {
    setQuads((current) => current.filter((_, i) => i !== index));
    setSelected((current) =>
      current.filter((i) => i !== index).map((i) => (i > index ? i - 1 : i)),
    );
    setEditing(null);
  }, []);

  /** Die gewählten Fotos, in Koordinaten der Aufnahme. */
  const chosenInFrame = useCallback(
    () => (toFrame ? selected.map((index) => applyHomography(toFrame, quads[index]) as Quad) : []),
    [quads, selected, toFrame],
  );

  const accept = useCallback(
    async (closeups: Map<number, CloseupShot>) => {
      if (selected.length === 0) return;
      setSaving(true);
      try {
        const chosen = chosenInFrame();
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
          if (near) {
            // Die Nahaufnahmen liegen als Bilddatei vor, nicht als Pixel: Sechs
            // Aufnahmen in voller Grösse gleichzeitig im Speicher zu halten
            // sprengt den Rahmen eines Telefons. Ausgepackt wird deshalb erst
            // hier, eine nach der anderen.
            const image = await imageDataFromBlob(near.blob, Math.max(near.width, near.height));
            closeup = { image, quad: near.quad, glare: near.glare };
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
          // Was hier mitgeht, ist keine Zierde: Der Nutzer hat diese Vierecke
          // gesehen, zurechtgezogen und bestätigt. Damit ist es eine geprüfte
          // Wahrheit – die einzige, die dieses Projekt in Mengen bekommen kann.
          marks: {
            page: scaleQuad(pageQuad, small.scale),
            photos: chosen.map((quad) => scaleQuad(quad, small.scale)),
          },
        });
      } finally {
        setProgress(null);
        setSaving(false);
      }
    },
    [chosenInFrame, frame, onAccept, options, rotation, selected, shot.frames, small],
  );

  /** In die dritte Stufe: jedes gewählte Foto einzeln aus der Nähe. */
  const openCloseups = useCallback(async () => {
    if (!page) return;
    const list = await Promise.all(
      selected.map(async (index) => {
        const size = outputSize(quads[index], 200);
        const warped = warpPerspective(page, quads[index], size.width, size.height);
        const full = outputSize(quads[index], 900);
        return {
          index,
          url: URL.createObjectURL(await blobFromImageData(warped, 0.8)),
          reference: warpPerspective(page, quads[index], full.width, full.height),
        };
      }),
    );
    setTargets(list);
  }, [page, quads, selected]);

  const closeCloseups = useCallback(() => {
    setTargets((current) => {
      current?.forEach((entry) => URL.revokeObjectURL(entry.url));
      return null;
    });
  }, []);

  // Nur was auch gespeichert wird, ist einen Hinweis wert.
  const betroffen = glare.filter((index) => selected.includes(index));

  if (targets) {
    return (
      <CloseupScreen
        targets={targets}
        existing={new Map()}
        onDone={(shots) => {
          closeCloseups();
          void accept(shots);
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

  if (step === 'seite') {
    return (
      <div className="flex min-h-dvh flex-col bg-stone-950 text-stone-100">
        <TopBar
          title="Seite prüfen"
          left={
            <IconButton label="Verwerfen" onClick={onCancel}>
              <BackIcon />
            </IconButton>
          }
        />

        <div className="flex-1 overflow-y-auto pb-36">
          <div className="relative mx-auto w-full max-w-2xl" style={{ aspectRatio: frame.width / frame.height }}>
            {sourceUrl && <img src={sourceUrl} alt="Aufnahme" className="size-full object-contain" />}
            <QuadEditor
              width={frame.width}
              height={frame.height}
              quads={[pageQuad]}
              selected={[0]}
              editing={awaiting === null ? 0 : null}
              onChange={(_, quad) => setPageQuad(insideImage(quad, frame.width, frame.height))}
              onTap={awaiting === null ? undefined : (point) => setCorner(point)}
              awaiting={awaiting ?? undefined}
            />
          </div>

          <p className="mx-auto max-w-2xl px-4 pt-4 text-xs leading-relaxed text-stone-400" data-testid="seite-hinweis">
            {awaiting === null
              ? 'Das Viereck umfasst die Albumseite. Stimmt es nicht, die Ecken ziehen – oder unten die vier Ecken der Reihe nach antippen. Lieber etwas zu weit als zu knapp, angeschnitten kommt nichts zurück.'
              : `Ecke ${CORNERS[awaiting]} antippen (${awaiting + 1} von 4).`}
          </p>
        </div>

        <div className="fixed inset-x-0 bottom-0 space-y-2 border-t border-white/10 bg-stone-950/95 px-4 pt-3 pb-6 backdrop-blur">
          <div className="mx-auto flex max-w-2xl gap-3">
            <Button onClick={onCancel} className="flex-1">
              Verwerfen
            </Button>
            <Button
              variant="primary"
              onClick={() => setStep('fotos')}
              disabled={awaiting !== null}
              className="flex-[2]"
              data-testid="seite-weiter"
            >
              Seite geraderücken
            </Button>
          </div>
          <div className="mx-auto max-w-2xl">
            <Button
              onClick={() => setAwaiting(awaiting === null ? 0 : null)}
              className="w-full py-1.5 text-xs"
              data-testid="ecken-setzen"
            >
              {awaiting === null ? 'Ecken der Seite antippen' : 'Abbrechen'}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col bg-stone-950 text-stone-100">
      <TopBar
        title="Fotos wählen"
        left={
          <IconButton label="Zurück zur Seite" onClick={() => setStep('seite')}>
            <BackIcon />
          </IconButton>
        }
      />

      <div className="flex-1 overflow-y-auto pb-40">
        <div
          className="relative mx-auto w-full max-w-2xl"
          style={{ aspectRatio: page ? page.width / page.height : 4 / 3 }}
        >
          {pageUrl && <img src={pageUrl} alt="Albumseite" className="size-full object-contain" />}
          {page && (
            <QuadEditor
              width={page.width}
              height={page.height}
              quads={quads}
              selected={selected}
              editing={editing}
              numbered
              onToggle={toggle}
              onActivate={setEditing}
              onAddAt={(point) => void addAt(point)}
              onChange={(index, quad) => setQuads((current) => current.map((q, i) => (i === index ? quad : q)))}
            />
          )}
        </div>

        <div className="mx-auto max-w-2xl space-y-4 px-4 pt-4">
          <p className="text-xs leading-relaxed text-stone-400" data-testid="fotos-hinweis">
            {searching
              ? 'Fotos werden gesucht …'
              : `${quads.length} ${quads.length === 1 ? 'Foto' : 'Fotos'}. Tippe auf ein übersehenes Foto, um es aufzunehmen – es bekommt die nächste Nummer. Das Häkchen nimmt eines heraus, die Ecken lassen sich ziehen.`}
          </p>

          {betroffen.length > 0 && (
            <div
              className="rounded-xl border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-xs leading-relaxed text-amber-200"
              data-testid="glanz-hinweis"
            >
              {glanzText(betroffen, quads.length, shot.frames.length)}
            </div>
          )}

          {editing !== null && quads[editing] && (
            <div className="flex items-center justify-between gap-3 rounded-xl border border-white/10 px-3 py-2 text-xs">
              <span className="text-stone-400">Foto {editing + 1} ausgewählt</span>
              <Button onClick={() => remove(editing)} variant="danger" className="px-3 py-1.5 text-xs">
                Entfernen
              </Button>
            </div>
          )}

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

      <div className="fixed inset-x-0 bottom-0 space-y-2 border-t border-white/10 bg-stone-950/95 px-4 pt-3 pb-6 backdrop-blur">
        <div className="mx-auto flex max-w-2xl gap-3">
          <Button onClick={() => setStep('seite')} className="flex-1">
            Zurück
          </Button>
          <Button
            variant="primary"
            onClick={() => void openCloseups()}
            disabled={selected.length === 0}
            className="flex-[2]"
            data-testid="details"
          >
            {selected.length === 1 ? 'Foto einzeln scannen' : `${selected.length} Fotos einzeln scannen`}
          </Button>
        </div>
        <div className="mx-auto max-w-2xl">
          <button
            type="button"
            onClick={() => void accept(new Map())}
            disabled={selected.length === 0}
            data-testid="accept"
            className="w-full py-1 text-center text-xs text-stone-500 hover:text-stone-300 disabled:opacity-40"
          >
            Ohne Nahaufnahmen speichern
          </button>
        </div>
      </div>
    </div>
  );
}

/** Die Ecken, in der Reihenfolge, in der sie angetippt werden. */
const CORNERS = ['oben links', 'oben rechts', 'unten rechts', 'unten links'];

/** Jede Ecke ins Bild holen – ausserhalb ist sie nicht zu greifen. */
function insideImage(quad: Quad, width: number, height: number): Quad {
  return quad.map((p) => ({
    x: Math.max(0, Math.min(width - 1, p.x)),
    y: Math.max(0, Math.min(height - 1, p.y)),
  })) as Quad;
}

/** Das ganze Bild als Viereck. */
function fullQuad(width: number, height: number): Quad {
  return [
    { x: 0, y: 0 },
    { x: width - 1, y: 0 },
    { x: width - 1, y: height - 1 },
    { x: 0, y: height - 1 },
  ];
}

/** Ein Viereck von Hand: um den angetippten Punkt, in handlicher Grösse. */
function handQuad(point: Pt, width: number, height: number): Quad {
  const half = (width * HAND_SIZE) / 2;
  const halfY = Math.min(half, height * 0.3);
  const x0 = Math.max(0, Math.min(width - 1 - 2 * half, point.x - half));
  const y0 = Math.max(0, Math.min(height - 1 - 2 * halfY, point.y - halfY));
  return [
    { x: x0, y: y0 },
    { x: x0 + 2 * half, y: y0 },
    { x: x0 + 2 * half, y: y0 + 2 * halfY },
    { x: x0, y: y0 + 2 * halfY },
  ];
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

function RotateIcon({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={`size-5 ${className}`} fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M4 9a8 8 0 1 1 1.5 7" strokeLinecap="round" />
      <path d="M3 4v5h5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
