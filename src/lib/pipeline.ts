import type { EnhanceOptions } from './imaging/enhance';
import { detectPhotoQuads } from './imaging/detect';
import { refinePhoto } from './imaging/closeup';
import type { Closeup } from './imaging/closeup';
import { estimateMotion } from './imaging/motion';
import type { Motion } from './imaging/motion';
import { reanchor, startPose } from './imaging/pose';
import type { Pose } from './imaging/pose';
import { mergePhotos } from './imaging/stack';
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

/**
 * Bewegung zwischen zwei Vorschaubildern – im Worker, mit Rückfall auf den
 * Hauptthread. Beim Abfahren einer Seite läuft das mehrmals je Sekunde; auf
 * dem Hauptthread gerechnet ruckelte der Sucher.
 */
export async function trackMotion(previous: RgbaImage, current: RgbaImage): Promise<Motion | null> {
  const before = toTransfer(previous);
  const after = toTransfer(current);
  try {
    const response = await send({ id: nextId++, type: 'motion', previous: before, current: after }, [
      before.data,
      after.data,
    ]);
    return response.type === 'motion' ? response.motion : null;
  } catch {
    return estimateMotion(previous, current);
  }
}

/**
 * Die Lage gegen die Übersicht verankern. Ohne `guess` die Anfangslage, sonst
 * eine Nachjustierung der mitgeführten.
 */
export async function anchorPose(
  overview: RgbaImage,
  frame: RgbaImage,
  guess: Pose | null,
): Promise<Pose | null> {
  const map = toTransfer(overview);
  const shot = toTransfer(frame);
  try {
    const response = await send({ id: nextId++, type: 'anchor', overview: map, frame: shot, guess }, [
      map.data,
      shot.data,
    ]);
    return response.type === 'anchor' ? response.pose : null;
  } catch {
    return guess ? reanchor(overview, frame, guess) : startPose(overview, frame);
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
