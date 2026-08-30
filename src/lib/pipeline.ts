import type { EnhanceOptions } from './imaging/enhance';
import { detectAt, detectPage, detectPhotoQuads, detectPhotosOnPage } from './imaging/detect';
import { refinePhoto } from './imaging/closeup';
import type { Closeup } from './imaging/closeup';
import { locate } from './imaging/locate';
import { mergePhotos } from './imaging/stack';
import type { Pt, Quad, RgbaImage } from './imaging/types';
import type { TransferImage, WorkerRequest, WorkerResponse } from '../worker/pipeline.worker';

type Pending = { resolve: (value: WorkerResponse) => void; reject: (error: Error) => void };

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
    worker.onerror = () => {
      for (const entry of pending.values()) entry.reject(new Error('Bildverarbeitung fehlgeschlagen'));
      pending.clear();
    };
  } catch {
    worker = null;
  }
  return worker;
}

function send(request: WorkerRequest, transfer: Transferable[]): Promise<WorkerResponse> {
  const instance = getWorker();
  if (!instance) return Promise.reject(new Error('Kein Worker verfügbar'));
  return new Promise((resolve, reject) => {
    pending.set(request.id, { resolve, reject });
    instance.postMessage(request, transfer);
  });
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
  const payload = toTransfer(image);
  try {
    const response = await send({ id: nextId++, type: 'detect', image: payload, analysisSize }, [payload.data]);
    return response.type === 'detect' ? response.quads : [];
  } catch {
    return detectPhotoQuads(image, { analysisSize });
  }
}

/**
 * Die Albumseite in einer Aufnahme – im Worker, mit Rückfall auf den
 * Hauptthread. Das läuft in der Vorschau mehrmals je Sekunde.
 */
export async function detectPageAsync(image: RgbaImage, analysisSize?: number): Promise<Quad | null> {
  const payload = toTransfer(image);
  try {
    const response = await send({ id: nextId++, type: 'page', image: payload, analysisSize }, [payload.data]);
    return response.type === 'page' ? response.page : null;
  } catch {
    return detectPage(image, { analysisSize });
  }
}

/** Die Fotos auf einer bereits entzerrten Seite. */
export async function detectPhotosAsync(page: RgbaImage): Promise<Quad[]> {
  const payload = toTransfer(page);
  try {
    const response = await send({ id: nextId++, type: 'photos', page: payload }, [payload.data]);
    return response.type === 'photos' ? response.quads : [];
  } catch {
    return detectPhotosOnPage(page);
  }
}

/** Das Foto an einer angetippten Stelle. */
export async function detectAtAsync(page: RgbaImage, point: Pt): Promise<Quad | null> {
  const payload = toTransfer(page);
  try {
    const response = await send({ id: nextId++, type: 'spot', page: payload, point }, [payload.data]);
    return response.type === 'spot' ? response.quad : null;
  } catch {
    return detectAt(page, point);
  }
}

/** Das Foto der Seitenaufnahme im Nahbild wiederfinden. */
export async function locateAsync(reference: RgbaImage, frame: RgbaImage): Promise<Quad | null> {
  const first = toTransfer(reference);
  const second = toTransfer(frame);
  try {
    const response = await send({ id: nextId++, type: 'locate', reference: first, frame: second }, [
      first.data,
      second.data,
    ]);
    return response.type === 'locate' ? response.quad : null;
  } catch {
    return locate(reference, frame);
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
  const transfer = closeupPayload ? [referencePayload.data, closeupPayload.data] : [referencePayload.data];
  try {
    const response = await send(
      {
        id: nextId++,
        type: 'refine',
        reference: referencePayload,
        closeup: closeupPayload,
        quad: closeup ? closeup.quad : null,
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
