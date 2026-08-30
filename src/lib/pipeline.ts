import type { EnhanceOptions } from './imaging/enhance';
import { detectAt, detectCloseup, detectPage, detectPhotoQuads, detectPhotosOnPage } from './imaging/detect';
import { downscaleRgba } from './imaging/gray';
import { scaleQuad } from './imaging/geometry';
import { refinePhoto } from './imaging/closeup';
import type { Closeup } from './imaging/closeup';
import { locate } from './imaging/locate';
import type { LocateOptions } from './imaging/locate';
import { mergePhotos } from './imaging/stack';
import type { Pt, Quad, RgbaImage } from './imaging/types';
import type { TransferImage, WorkerRequest, WorkerResponse } from '../worker/pipeline.worker';

type Pending = { resolve: (value: WorkerResponse) => void; reject: (error: Error) => void };

/**
 * So lange wird auf eine Antwort des Workers gewartet, dann gilt er als tot.
 *
 * Ohne diese Frist konnte ein Bildschirm für immer stehenbleiben: Stirbt der
 * Worker still – auf einem Telefon reicht dafür ein zu grosses Bild –, kommt
 * weder eine Antwort noch ein Fehler, das Versprechen löst sich nie ein, und
 * die Oberfläche wartet bis zum Neuladen. Genau so blieb „Foto wird gesucht …"
 * stehen. Lieber langsam auf dem Hauptthread weiterrechnen als gar nicht.
 */
const DEADLINE = 12_000;

/**
 * Grösse, auf die ein Bild vor der Analyse gebracht wird.
 *
 * Die Erkennung rechnet innen ohnehin auf 720 Punkten, das Wiederfinden auf
 * 260. Eine Aufnahme in voller Grösse hinüberzuschicken bringt davon nichts –
 * kostet aber je Kopie über dreissig Megabyte, und `takeShot` machte davon vier
 * hintereinander. Was Bildpunkte *erzeugt* (`merge`, `refine`), geht weiterhin
 * in voller Grösse.
 */
const ANALYSIS_MAX = 1200;

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

function getWorker(): Worker | null {
  if (worker) return worker;
  if (typeof Worker === 'undefined') return null;
  try {
    worker = new Worker(new URL('../worker/pipeline.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const entry = pending.get(event.data.id);
      if (!entry) return;
      pending.delete(event.data.id);
      if (event.data.type === 'error') entry.reject(new Error(event.data.message));
      else entry.resolve(event.data);
    };
    worker.onerror = () => dropWorker(new Error('Bildverarbeitung fehlgeschlagen'));
  } catch {
    worker = null;
  }
  return worker;
}

function send(request: WorkerRequest, transfer: Transferable[]): Promise<WorkerResponse> {
  const instance = getWorker();
  if (!instance) return Promise.reject(new Error('Kein Worker verfügbar'));

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(request.id);
      // Ein Worker, der nicht mehr antwortet, antwortet auch beim nächsten Mal
      // nicht. Er wird weggeworfen; der nächste Auftrag legt einen frischen an.
      dropWorker(new Error('Bildverarbeitung antwortet nicht'));
      reject(new Error('Bildverarbeitung antwortet nicht'));
    }, DEADLINE);

    pending.set(request.id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });

    try {
      instance.postMessage(request, transfer);
    } catch (error) {
      // Auch das muss auflösen: Wirft `postMessage`, bliebe der Eintrag sonst
      // ewig in der Warteschlange stehen.
      clearTimeout(timer);
      pending.delete(request.id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/** Den Worker aufgeben und alles Wartende absagen. */
function dropWorker(reason: Error): void {
  for (const entry of pending.values()) entry.reject(reason);
  pending.clear();
  worker?.terminate();
  worker = null;
}

/** Verkleinerte Fassung für die Analyse, samt Faktor zurück in das Original. */
function forAnalysis(img: RgbaImage): { image: RgbaImage; scale: number } {
  return downscaleRgba(img, ANALYSIS_MAX);
}

function toTransfer(img: RgbaImage): TransferImage {
  const copy = new Uint8ClampedArray(img.data);
  return { data: copy.buffer, width: img.width, height: img.height };
}

function fromTransfer(image: TransferImage): RgbaImage {
  return { data: new Uint8ClampedArray(image.data), width: image.width, height: image.height };
}

/** Fotoerkennung – im Worker, mit Rückfall auf den Hauptthread. */
export async function detect(image: RgbaImage, analysisSize?: number): Promise<Quad[]> {
  const small = forAnalysis(image);
  const payload = toTransfer(small.image);
  try {
    const response = await send({ id: nextId++, type: 'detect', image: payload, analysisSize }, [payload.data]);
    return response.type === 'detect' ? response.quads.map((quad) => scaleQuad(quad, small.scale)) : [];
  } catch {
    return detectPhotoQuads(image, { analysisSize });
  }
}

/**
 * Die Albumseite in einer Aufnahme – im Worker, mit Rückfall auf den
 * Hauptthread. Das läuft in der Vorschau mehrmals je Sekunde.
 */
export async function detectPageAsync(image: RgbaImage, analysisSize?: number): Promise<Quad | null> {
  const small = forAnalysis(image);
  const payload = toTransfer(small.image);
  try {
    const response = await send({ id: nextId++, type: 'page', image: payload, analysisSize }, [payload.data]);
    return response.type === 'page' && response.page ? scaleQuad(response.page, small.scale) : null;
  } catch {
    return detectPage(image, { analysisSize });
  }
}

/** Die Fotos auf einer bereits entzerrten Seite. */
export async function detectPhotosAsync(page: RgbaImage): Promise<Quad[]> {
  const small = forAnalysis(page);
  const payload = toTransfer(small.image);
  try {
    const response = await send({ id: nextId++, type: 'photos', page: payload }, [payload.data]);
    return response.type === 'photos' ? response.quads.map((quad) => scaleQuad(quad, small.scale)) : [];
  } catch {
    return detectPhotosOnPage(page);
  }
}

/** Das Foto an einer angetippten Stelle. */
export async function detectAtAsync(page: RgbaImage, point: Pt): Promise<Quad | null> {
  const small = forAnalysis(page);
  const payload = toTransfer(small.image);
  const spot = { x: point.x / small.scale, y: point.y / small.scale };
  try {
    const response = await send({ id: nextId++, type: 'spot', page: payload, point: spot }, [payload.data]);
    return response.type === 'spot' && response.quad ? scaleQuad(response.quad, small.scale) : null;
  } catch {
    return detectAt(page, point);
  }
}

/** Das Foto der Seitenaufnahme im Nahbild wiederfinden. */
export async function locateAsync(
  reference: RgbaImage,
  frame: RgbaImage,
  options?: LocateOptions,
): Promise<Quad | null> {
  const small = forAnalysis(frame);
  const first = toTransfer(forAnalysis(reference).image);
  const second = toTransfer(small.image);
  try {
    const response = await send({ id: nextId++, type: 'locate', reference: first, frame: second, options }, [
      first.data,
      second.data,
    ]);
    return response.type === 'locate' && response.quad ? scaleQuad(response.quad, small.scale) : null;
  } catch {
    return locate(reference, frame, options);
  }
}

/**
 * Das Foto in einer Nahaufnahme, gemessen am Papier ringsum – der Rückfall,
 * wenn die Seitenaufnahme es nicht wiedererkennt.
 */
export async function detectCloseupAsync(frame: RgbaImage): Promise<Quad | null> {
  const small = forAnalysis(frame);
  const payload = toTransfer(small.image);
  try {
    const response = await send({ id: nextId++, type: 'closeup', frame: payload }, [payload.data]);
    return response.type === 'closeup' && response.quad ? scaleQuad(response.quad, small.scale) : null;
  } catch {
    return detectCloseup(frame);
  }
}

export interface ExtractRequest {
  frames: RgbaImage[];
  quads: Quad[];
}

/** Entzerren und entspiegeln – für alle erkannten Fotos einer Aufnahme. */
export async function mergePhotosAsync({ frames, quads }: ExtractRequest): Promise<RgbaImage[]> {
  if (quads.length === 0) return [];
  const payload = frames.map(toTransfer);
  try {
    const response = await send({ id: nextId++, type: 'merge', frames: payload, quads }, payload.map((p) => p.data));
    if (response.type === 'merge') return response.images.map(fromTransfer);
    return [];
  } catch {
    return mergePhotos(frames, quads);
  }
}

export interface RefineRequest {
  reference: RgbaImage;
  closeup: Closeup | null;
  options: EnhanceOptions;
  rotation: number;
}

/**
 * Das fertige Foto: die Seitenaufnahme, wenn nötig verrechnet mit der
 * Nahaufnahme, dann aufgehellt und gedreht.
 */
export async function refine({ reference, closeup, options, rotation }: RefineRequest): Promise<RgbaImage> {
  const referencePayload = toTransfer(reference);
  const closeupPayload = closeup ? toTransfer(closeup.image) : null;
  const glarePayload = closeup?.glare ? toTransfer(closeup.glare) : null;
  const transfer = [referencePayload.data];
  if (closeupPayload) transfer.push(closeupPayload.data);
  if (glarePayload) transfer.push(glarePayload.data);
  try {
    const response = await send(
      {
        id: nextId++,
        type: 'refine',
        reference: referencePayload,
        closeup: closeupPayload,
        quad: closeup ? closeup.quad : null,
        glare: glarePayload,
        options,
        rotation,
      },
      transfer,
    );
    if (response.type === 'refine') return fromTransfer(response.image);
    throw new Error('Unerwartete Antwort');
  } catch {
    return refinePhoto(reference, closeup, options, rotation);
  }
}
