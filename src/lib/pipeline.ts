import type { EnhanceOptions } from './imaging/enhance';
import { detectPhotoQuads } from './imaging/detect';
import { extractPhotos } from './imaging/stack';
import type { Quad, RgbaImage } from './imaging/types';
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

export interface ExtractRequest {
  frames: RgbaImage[];
  quads: Quad[];
  options: EnhanceOptions;
  rotation: number;
}

/** Entzerren, entspiegeln, aufhellen – für alle erkannten Fotos einer Aufnahme. */
export async function extract({ frames, quads, options, rotation }: ExtractRequest): Promise<RgbaImage[]> {
  if (quads.length === 0) return [];
  const payload = frames.map(toTransfer);
  try {
    const response = await send({ id: nextId++, type: 'extract', frames: payload, quads, options, rotation }, payload.map((p) => p.data));
    if (response.type === 'extract') return response.images.map(fromTransfer);
    return [];
  } catch {
    return extractLocally({ frames, quads, options, rotation });
  }
}

/** Gleiche Verarbeitung ohne Worker – Rückfallebene und Grundlage der Tests. */
export function extractLocally({ frames, quads, options, rotation }: ExtractRequest): RgbaImage[] {
  return extractPhotos(frames, quads, options, rotation);
}
